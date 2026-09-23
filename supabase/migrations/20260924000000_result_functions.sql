-- TASK-012: grading, results, and the teacher's actions on a session (DEC-004: business rules live
-- in SQL, one transaction per action; the teacher side never needs the answer key to reach the
-- browser, so everything here stays behind the staff Edge Function).
--
-- Applied live on 2026-09-24 via `npx supabase db query --linked --file` (same path as the exams and
-- session SQL). Idempotent: every object is `create or replace`.
--
-- Business rules implemented here: BR-02 (one retake, granted by the teacher), BR-06 (points),
-- BR-07 (essays decide when a result becomes final), BR-08 (visibility), BR-11 (add time / reopen,
-- both audited), BR-15 (class merging only affects the display name in results), BR-18 (a teacher may
-- correct a grade by hand; the correction wins and is audited).
--
-- Live schema this file relies on (inspected on the v2 project):
--   answer_grades   (session_id, question_id, points_awarded, max_points, is_auto, graded_by,
--                    feedback, graded_at) — unique (session_id, question_id);
--                    checks: 0 <= points_awarded <= max_points, max_points > 0, feedback <= 2000
--   exam_results    (session_id unique, total_points, max_points, percentage result 0..100,
--                    status result_status, pass_status, correct_count, wrong_count,
--                    time_used_seconds, review_snapshot jsonb)
--                    checks: (status = 'pending_review') = (pass_status = 'not_final')
--   session_events  (session_id, event_type text 1..60, severity event_severity, meta, occurred_at)
--   retake_permissions (exam_id, student_name_normalized, student_class_normalized, granted_by,
--                    granted_at, used_at) — read by exam_join (the student side, TASK-010)
--   class_aliases   (alias_normalized unique, display_name)

-- ============ the one place that writes exam_results (BR-06, BR-07) ============
-- Recomputes the result from the stored grades plus the session snapshot. Called after a submit and
-- after every manual grade, so the two paths can never disagree.
create or replace function public._session_result_write(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  e public.exams%rowtype;
  v_item jsonb;
  g public.answer_grades%rowtype;
  v_qid uuid;
  v_type text;
  v_w numeric;
  v_pts numeric;
  v_total numeric := 0;
  v_max numeric := 0;
  v_correct int := 0;
  v_wrong int := 0;
  v_pending boolean := false;
  v_review jsonb := '[]'::jsonb;
  v_pos int := 0;
  v_pct numeric;
  v_status public.result_status;
  v_pass public.pass_status;
  v_secs int;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then return; end if;
  select * into e from public.exams where id = s.exam_id;

  for v_item in select * from jsonb_array_elements(s.questions_snapshot) loop
    v_pos := v_pos + 1;
    v_qid := (v_item->>'question_id')::uuid;
    v_type := v_item->>'type';
    v_w := coalesce((v_item->>'weight')::numeric, 1);
    v_max := v_max + v_w;

    select * into g from public.answer_grades a where a.session_id = p_id and a.question_id = v_qid;
    v_pts := coalesce(g.points_awarded, 0);
    v_total := v_total + v_pts;

    if v_type = 'essay' then
      -- BR-07: an essay waits for the teacher, even when the student left it blank.
      if g.session_id is null then v_pending := true; end if;
    elsif g.session_id is null then
      v_wrong := v_wrong + 1; -- cannot happen after a submit; stay honest if it ever does
    elsif v_pts > 0 then
      v_correct := v_correct + 1;
    else
      v_wrong := v_wrong + 1;
    end if;

    v_review := v_review || jsonb_build_object(
      'position', v_pos, 'question_id', v_qid, 'type', v_type, 'weight', v_w,
      'body', v_item->'body', 'options', coalesce(v_item->'options', '[]'::jsonb),
      'chosen', coalesce((select a.answer->>'text' from public.session_answers a
                           where a.session_id = p_id and a.question_id = v_qid), ''),
      'correct_text', coalesce(s.answer_key -> v_qid::text ->> 'correct_text', ''),
      'accepted_text', coalesce(s.answer_key -> v_qid::text -> 'accepted_text', '[]'::jsonb),
      'is_correct', case when v_type = 'essay' or g.session_id is null then null else v_pts > 0 end,
      'manual', coalesce(not g.is_auto, false),
      'points', v_pts,
      'max_points', v_w,
      'feedback', g.feedback);
  end loop;

  v_pct := case when v_max > 0 then round(v_total / v_max * 100, 2) else 0 end;
  v_status := case when v_pending then 'pending_review' else 'graded' end;
  v_pass := case when v_pending then 'not_final'
                 when v_pct >= e.passing_grade then 'passed' else 'failed' end;
  v_secs := greatest(0, floor(extract(epoch from (coalesce(s.submitted_at, now()) - s.started_at)))::int);

  insert into public.exam_results (session_id, total_points, max_points, percentage, status, pass_status,
      correct_count, wrong_count, time_used_seconds, review_snapshot)
  values (p_id, v_total, v_max, v_pct, v_status, v_pass, v_correct, v_wrong, v_secs, v_review)
  on conflict (session_id) do update
    set total_points = excluded.total_points, max_points = excluded.max_points, percentage = excluded.percentage,
        status = excluded.status, pass_status = excluded.pass_status, correct_count = excluded.correct_count,
        wrong_count = excluded.wrong_count, time_used_seconds = excluded.time_used_seconds,
        review_snapshot = excluded.review_snapshot, updated_at = now();
end $$;

-- ============ automatic grading (re-created from TASK-010, with one change) ============
-- The objective questions are graded here. A question the teacher graded by hand (is_auto = false) is
-- left alone (BR-18), so a later submit — after a reopen (BR-11) or a time-up — cannot undo a
-- correction. The result itself is written by _session_result_write.
create or replace function public._session_grade(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_item jsonb;
  v_key jsonb;
  v_qid uuid;
  v_type text;
  v_w numeric;
  v_text text;
  v_ok boolean;
  g public.answer_grades%rowtype;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then return; end if;

  for v_item in select * from jsonb_array_elements(s.questions_snapshot) loop
    v_qid := (v_item->>'question_id')::uuid;
    v_type := v_item->>'type';
    v_w := coalesce((v_item->>'weight')::numeric, 1);
    v_key := s.answer_key -> v_qid::text;

    if v_type <> 'essay' then
      select * into g from public.answer_grades a where a.session_id = p_id and a.question_id = v_qid;
      if g.session_id is not null and not g.is_auto then
        continue; -- BR-18: a manual correction stays until the teacher changes it again
      end if;

      select coalesce(a.answer->>'text', '') into v_text
        from public.session_answers a where a.session_id = p_id and a.question_id = v_qid;

      if coalesce(v_text, '') = '' then
        v_ok := false;
      elsif v_type = 'short_answer' then
        v_ok := coalesce(v_key->'accepted', '[]'::jsonb) ? public.normalize_text(v_text);
      else
        v_ok := coalesce(v_key->>'correct', '') <> '' and public.normalize_text(v_text) = v_key->>'correct';
      end if;

      insert into public.answer_grades (session_id, question_id, points_awarded, max_points, is_auto)
      values (p_id, v_qid, case when v_ok then v_w else 0 end, v_w, true)
      on conflict (session_id, question_id) do update
        set points_awarded = excluded.points_awarded, max_points = excluded.max_points,
            is_auto = true, graded_at = now();
    end if;
  end loop;

  update public.exam_sessions
     set status = p_status::public.session_status, submitted_at = coalesce(submitted_at, now()),
         last_heartbeat_at = now()
   where id = p_id;

  perform public._session_result_write(p_id);

  insert into public.session_events (session_id, event_type, severity, meta)
  select p_id, 'submit', 'info',
         jsonb_build_object('status', p_status, 'percentage', r.percentage,
                            'pending_review', r.status = 'pending_review')
    from public.exam_results r where r.session_id = p_id;
end $$;

-- ============ grade one answer by hand (BR-07, BR-18) ============
create or replace function public.save_answer_grade(
  p_session_id uuid, p_question_id uuid, p_points numeric, p_feedback text, p_actor uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_max numeric;
  v_type text;
  v_matches int;
  v_feedback text := nullif(btrim(coalesce(p_feedback, '')), '');
  v_pending int;
  v_waiting int;
  r public.exam_results%rowtype;
begin
  if p_points is null then
    raise exception 'A grade needs a number of points.' using hint = 'validation'; end if;
  if p_points < 0 then
    raise exception 'The points cannot be below zero.' using hint = 'validation'; end if;
  if v_feedback is not null and char_length(v_feedback) > 2000 then
    raise exception 'That comment is too long (2000 characters at most).' using hint = 'validation'; end if;

  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  if s.status in ('in_progress', 'reopened') then
    raise exception 'That test is still being taken, so it cannot be graded yet.' using hint = 'validation'; end if;

  select count(*), max(coalesce((i->>'weight')::numeric, 1)), max(i->>'type')
    into v_matches, v_max, v_type
    from jsonb_array_elements(s.questions_snapshot) i
   where i->>'question_id' = p_question_id::text;
  if v_matches = 0 then
    raise exception 'That question is not part of this test.' using hint = 'validation'; end if;
  if p_points > v_max then
    raise exception 'The most points this question can give is %.', v_max using hint = 'validation'; end if;

  insert into public.answer_grades (session_id, question_id, points_awarded, max_points, is_auto,
      graded_by, feedback, graded_at)
  values (p_session_id, p_question_id, p_points, v_max, false, p_actor, v_feedback, now())
  on conflict (session_id, question_id) do update
    set points_awarded = excluded.points_awarded, max_points = excluded.max_points, is_auto = false,
        graded_by = excluded.graded_by, feedback = excluded.feedback, graded_at = now();

  perform public._session_result_write(p_session_id);

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_session_id, 'graded', 'info',
          jsonb_build_object('question_id', p_question_id, 'type', v_type,
                             'points', p_points, 'max_points', v_max));

  perform public.write_audit(p_actor, 'grade', 'exam_session', p_session_id::text,
    jsonb_build_object('question_id', p_question_id, 'type', v_type, 'points', p_points, 'max_points', v_max));

  select * into r from public.exam_results where session_id = p_session_id;
  select count(*) into v_waiting from jsonb_array_elements(coalesce(r.review_snapshot, '[]'::jsonb)) x
   where x->>'type' = 'essay'
     and not exists (select 1 from public.answer_grades g
                      where g.session_id = p_session_id and g.question_id = (x->>'question_id')::uuid);
  v_pending := case when r.status = 'pending_review' then 1 else 0 end;

  return jsonb_build_object('saved', true, 'question_id', p_question_id, 'points', p_points,
    'max_points', v_max, 'feedback', v_feedback,
    'final', v_pending = 0, 'waiting_essays', v_waiting,
    'percentage', r.percentage, 'total_points', r.total_points, 'result_max_points', r.max_points,
    'pass_status', r.pass_status);
end $$;

-- ============ the essay questions of an exam and how much is still waiting (frame 13) ============
create or replace function public.list_grading_questions(p_exam_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not exists (select 1 from public.exams where id = p_exam_id) then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'question_id', t.question_id, 'position', t.position, 'body', t.body, 'weight', t.weight,
      'guide', (select q.essay_guidance from public.questions q where q.id = t.question_id),
      'taken', t.taken, 'graded', t.graded, 'waiting', t.taken - t.graded) order by t.position), '[]'::jsonb)
    into v_out
    from (
      select (i->>'question_id')::uuid as question_id, min((i->>'position')::int) as position,
             (array_agg(i->'body'))[1] as body, max(coalesce((i->>'weight')::numeric, 1)) as weight,
             count(*) as taken,
             count(*) filter (where g.session_id is not null) as graded
        from public.exam_sessions s
        cross join lateral jsonb_array_elements(s.questions_snapshot) i
        left join public.answer_grades g
               on g.session_id = s.id and g.question_id = (i->>'question_id')::uuid
       where s.exam_id = p_exam_id
         and i->>'type' = 'essay'
         and s.status in ('submitted', 'auto_submitted', 'timed_out')
       group by (i->>'question_id')::uuid
    ) t;

  return v_out;
end $$;

-- ============ one essay question against every student who took it (frame 13, right pane) ============
create or replace function public.get_grading_queue(p_exam_id uuid, p_question_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_question jsonb;
  v_max numeric;
begin
  if not exists (select 1 from public.exams where id = p_exam_id) then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', t.session_id, 'student_name', t.student_name, 'student_class', t.student_class,
      'attempt_no', t.attempt_no, 'status', t.status, 'submitted_at', t.submitted_at,
      'answer', coalesce(t.answer, ''), 'is_blank', coalesce(t.answer, '') = '',
      'graded', t.points is not null, 'points', t.points, 'feedback', t.feedback,
      'graded_at', t.graded_at, 'max_points', t.max_points, 'manual', t.is_auto is false)
      order by t.student_class, t.student_name, t.attempt_no), '[]'::jsonb)
    into v_rows
    from (
      select s.id as session_id, s.student_name, s.student_class, s.attempt_no, s.status, s.submitted_at,
             (select a.answer->>'text' from public.session_answers a
               where a.session_id = s.id and a.question_id = p_question_id) as answer,
             g.points_awarded as points, g.feedback, g.graded_at, g.is_auto,
             coalesce((i->>'weight')::numeric, 1) as max_points
        from public.exam_sessions s
        cross join lateral jsonb_array_elements(s.questions_snapshot) i
        left join public.answer_grades g
               on g.session_id = s.id and g.question_id = p_question_id
       where s.exam_id = p_exam_id
         and (i->>'question_id')::uuid = p_question_id
         and s.status in ('submitted', 'auto_submitted', 'timed_out')
    ) t;

  v_max := coalesce(
    (select w.weight from public.exam_questions w
      where w.exam_id = p_exam_id and w.question_id = p_question_id),
    (select max((r->>'max_points')::numeric) from jsonb_array_elements(v_rows) r),
    (select q.default_weight from public.questions q where q.id = p_question_id),
    1);

  select jsonb_build_object(
      'question_id', p_question_id, 'max_points', v_max,
      'body', coalesce((select r->'body' from jsonb_array_elements(v_rows) r limit 1),
                       to_jsonb((select q.body from public.questions q where q.id = p_question_id))),
      'guide', (select q.essay_guidance from public.questions q where q.id = p_question_id),
      'taken', jsonb_array_length(v_rows),
      'graded', (select count(*) from jsonb_array_elements(v_rows) r where (r->>'graded')::boolean),
      'waiting', (select count(*) from jsonb_array_elements(v_rows) r where not (r->>'graded')::boolean))
    into v_question;

  return jsonb_build_object('question', v_question, 'students', v_rows);
end $$;

-- ============ the number on the Grading menu badge ============
create or replace function public.count_pending_grading()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.exam_sessions s
    cross join lateral jsonb_array_elements(s.questions_snapshot) i
   where i->>'type' = 'essay'
     and s.status in ('submitted', 'auto_submitted', 'timed_out')
     and not exists (select 1 from public.answer_grades g
                      where g.session_id = s.id and g.question_id = (i->>'question_id')::uuid)
$$;

-- ============ every exam that has sessions, for the Grading / Results hubs ============
create or replace function public.list_exam_activity(p_include_templates boolean default false)
returns jsonb language sql stable security definer set search_path = public as $$
  with agg as (
    select s.exam_id,
           count(*) as sessions,
           count(*) filter (where s.status in ('submitted', 'auto_submitted', 'timed_out')) as finished,
           count(*) filter (where s.status in ('in_progress', 'reopened')) as in_progress,
           max(s.submitted_at) as last_submitted_at,
           round(avg(r.percentage), 1) as average,
           coalesce(sum(case when r.status = 'pending_review' then (
             select count(*) from jsonb_array_elements(r.review_snapshot) x
              where x->>'type' = 'essay'
                and not exists (select 1 from public.answer_grades g
                                 where g.session_id = s.id and g.question_id = (x->>'question_id')::uuid)
           ) else 0 end), 0)::int as pending_essays
      from public.exam_sessions s
      left join public.exam_results r on r.session_id = s.id
     group by s.exam_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'exam_id', e.id, 'title', e.title, 'access_code', e.access_code, 'status', e.status,
      'is_template', e.is_template, 'passing_grade', e.passing_grade,
      'essay_questions', (select count(*) from public.exam_questions w
                            join public.questions q on q.id = w.question_id
                           where w.exam_id = e.id and q.type = 'essay'),
      'sessions', a.sessions, 'finished', a.finished, 'in_progress', a.in_progress,
      'pending_essays', a.pending_essays, 'average', a.average, 'last_submitted_at', a.last_submitted_at)
    order by a.pending_essays desc, a.last_submitted_at desc nulls last), '[]'::jsonb)
    from public.exams e
    join agg a on a.exam_id = e.id
   where p_include_templates or not e.is_template
$$;

-- ============ the results table of one exam (frame 14) ============
create or replace function public.list_exam_results(p_exam_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e public.exams%rowtype;
  v_rows jsonb;
  v_summary jsonb;
begin
  select * into e from public.exams where id = p_exam_id;
  if not found then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', t.id, 'student_name', t.student_name, 'student_class', t.student_class,
      'class_display', coalesce(ca.display_name, t.student_class),
      'attempt_no', t.attempt_no, 'status', t.status,
      'started_at', t.started_at, 'submitted_at', t.submitted_at, 'ends_at', t.ends_at,
      'remaining_seconds', case when t.status in ('in_progress', 'reopened')
        then greatest(0, floor(extract(epoch from (t.ends_at - now())))::int) end,
      'tab_switch_count', t.tab_switch_count,
      'has_result', r.percentage is not null,
      'percentage', r.percentage, 'total_points', r.total_points, 'max_points', r.max_points,
      'pass_status', r.pass_status, 'result_status', r.status,
      'correct_count', r.correct_count, 'wrong_count', r.wrong_count,
      'time_used_seconds', r.time_used_seconds, 'pending_essays', t.pending_essays,
      'retake_granted', rp.id is not null, 'retake_used', rp.used_at is not null)
      order by coalesce(ca.display_name, t.student_class), t.student_name, t.attempt_no), '[]'::jsonb)
    into v_rows
    from (
      select s.id, s.student_name, s.student_class, s.student_class_normalized,
             s.student_name_normalized, s.attempt_no, s.status, s.started_at, s.submitted_at,
             s.ends_at, s.tab_switch_count,
             case when rr.status = 'pending_review' then (
               select count(*) from jsonb_array_elements(rr.review_snapshot) x
                where x->>'type' = 'essay'
                  and not exists (select 1 from public.answer_grades g
                                   where g.session_id = s.id and g.question_id = (x->>'question_id')::uuid)
             ) else 0 end as pending_essays
        from public.exam_sessions s
        left join public.exam_results rr on rr.session_id = s.id
       where s.exam_id = p_exam_id
    ) t
    left join public.class_aliases ca on ca.alias_normalized = t.student_class_normalized
    left join lateral (
      select rp.id, rp.used_at from public.retake_permissions rp
       where rp.exam_id = p_exam_id
         and rp.student_name_normalized = t.student_name_normalized
         and rp.student_class_normalized = t.student_class_normalized
       order by rp.granted_at desc limit 1
    ) rp on true
    left join public.exam_results r on r.session_id = t.id;

  select jsonb_build_object(
      'with_result', count(*) filter (where (r->>'has_result')::boolean),
      'in_progress', count(*) filter (where r->>'status' in ('in_progress', 'reopened')),
      'average', round(avg((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean), 1),
      'highest', max((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean),
      'lowest', min((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean),
      'passed', count(*) filter (where r->>'pass_status' = 'passed'),
      'failed', count(*) filter (where r->>'pass_status' = 'failed'),
      'not_final', count(*) filter (where r->>'pass_status' = 'not_final'),
      'pending_essays', coalesce(sum((r->>'pending_essays')::int), 0))
    into v_summary
    from jsonb_array_elements(v_rows) r;

  return jsonb_build_object(
    'exam', jsonb_build_object('id', e.id, 'title', e.title, 'status', e.status,
      'access_code', e.access_code, 'duration_minutes', e.duration_minutes,
      'passing_grade', e.passing_grade, 'result_visibility', e.result_visibility,
      'essay_pending_display', e.essay_pending_display, 'starts_at', e.starts_at, 'ends_at', e.ends_at),
    'summary', v_summary, 'rows', v_rows);
end $$;

-- ============ one session, everything the teacher needs (Details, and the BR-11 actions) ============
create or replace function public.get_session_report(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  e public.exams%rowtype;
  r public.exam_results%rowtype;
  rp public.retake_permissions%rowtype;
  v_review jsonb;
  v_grades jsonb;
  v_events jsonb;
  v_counts jsonb;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  select * into e from public.exams where id = s.exam_id;
  select * into r from public.exam_results where session_id = p_session_id;
  select * into rp from public.retake_permissions p
   where p.exam_id = s.exam_id
     and p.student_name_normalized = s.student_name_normalized
     and p.student_class_normalized = s.student_class_normalized
   order by p.granted_at desc limit 1;

  -- The guide is added here (and only here): this report is a staff payload, never a student one.
  select coalesce(jsonb_agg(x.item || jsonb_build_object(
      'graded', g.session_id is not null,
      'manual', coalesce(not g.is_auto, false),
      'points', coalesce(g.points_awarded, (x.item->>'points')::numeric, 0),
      'feedback', g.feedback,
      'guide', case when x.item->>'type' = 'essay'
        then (select q.essay_guidance from public.questions q where q.id = (x.item->>'question_id')::uuid)
        else null end,
      'graded_at', g.graded_at) order by (x.item->>'position')::int), '[]'::jsonb)
    into v_review
    from jsonb_array_elements(coalesce(r.review_snapshot, '[]'::jsonb)) as x(item)
    left join public.answer_grades g
           on g.session_id = p_session_id and g.question_id = (x.item->>'question_id')::uuid;

  select coalesce(jsonb_agg(jsonb_build_object('points_awarded', g.points_awarded,
      'max_points', g.max_points, 'is_auto', g.is_auto, 'feedback', g.feedback,
      'graded_at', g.graded_at, 'question_id', g.question_id, 'graded_by', g.graded_by)
      order by g.graded_at), '[]'::jsonb)
    into v_grades
    from public.answer_grades g where g.session_id = p_session_id;

  select coalesce(jsonb_agg(e2.event), '[]'::jsonb) into v_events
    from (
      select jsonb_build_object('event_type', ev.event_type, 'severity', ev.severity,
             'meta', ev.meta, 'occurred_at', ev.occurred_at) as event
        from public.session_events ev where ev.session_id = p_session_id
       order by ev.occurred_at desc, ev.id desc limit 200
    ) e2;

  select coalesce(jsonb_object_agg(t.event_type, t.n), '{}'::jsonb) into v_counts
    from (select event_type, count(*) as n from public.session_events
           where session_id = p_session_id group by event_type) t;

  return jsonb_build_object(
    'server_time', now(),
    'session', jsonb_build_object('id', s.id, 'exam_id', s.exam_id, 'student_name', s.student_name,
      'student_class', s.student_class,
      'class_display', coalesce((select ca.display_name from public.class_aliases ca
                                  where ca.alias_normalized = s.student_class_normalized), s.student_class),
      'attempt_no', s.attempt_no, 'status', s.status, 'started_at', s.started_at,
      'submitted_at', s.submitted_at, 'ends_at', s.ends_at, 'extra_seconds', s.extra_seconds,
      'tab_switch_count', s.tab_switch_count, 'last_heartbeat_at', s.last_heartbeat_at,
      'remaining_seconds', case when s.status in ('in_progress', 'reopened')
        then greatest(0, floor(extract(epoch from (s.ends_at - now())))::int) end),
    'exam', jsonb_build_object('id', e.id, 'title', e.title, 'passing_grade', e.passing_grade,
      'result_visibility', e.result_visibility, 'essay_pending_display', e.essay_pending_display),
    'result', case when r.id is null then null else jsonb_build_object(
      'percentage', r.percentage, 'total_points', r.total_points, 'max_points', r.max_points,
      'status', r.status, 'pass_status', r.pass_status, 'correct_count', r.correct_count,
      'wrong_count', r.wrong_count, 'time_used_seconds', r.time_used_seconds,
      'updated_at', r.updated_at) end,
    'review', v_review, 'grades', v_grades, 'events', v_events, 'event_counts', v_counts,
    'retake', case when rp.id is null then null
                   else jsonb_build_object('granted', true, 'used', rp.used_at is not null,
                                           'granted_at', rp.granted_at) end,
    'actions', jsonb_build_object(
      'can_add_time', s.status in ('in_progress', 'reopened'),
      'can_reopen', s.status in ('submitted', 'auto_submitted', 'timed_out'),
      'can_grade', s.status not in ('in_progress', 'reopened'),
      'can_grant_retake', s.status in ('submitted', 'auto_submitted', 'timed_out')
                          and not exists (select 1 from public.retake_permissions p
                                           where p.exam_id = s.exam_id
                                             and p.student_name_normalized = s.student_name_normalized
                                             and p.student_class_normalized = s.student_class_normalized
                                             and p.used_at is null),
      'can_revoke_retake', exists (select 1 from public.retake_permissions p
                                    where p.exam_id = s.exam_id
                                      and p.student_name_normalized = s.student_name_normalized
                                      and p.student_class_normalized = s.student_class_normalized
                                      and p.used_at is null)));
end $$;

-- ============ BR-11: give a running session more time, or reopen a finished one ============
create or replace function public.add_session_time(p_session_id uuid, p_seconds int, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions%rowtype;
begin
  if p_seconds is null or p_seconds < 60 or p_seconds > 7200 then
    raise exception 'Time can be added in steps between 1 minute and 2 hours.'
      using hint = 'validation';
  end if;
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  if s.status not in ('in_progress', 'reopened') then
    raise exception 'This test is already collected. Reopen it instead of adding time.'
      using hint = 'validation';
  end if;

  update public.exam_sessions
     set extra_seconds = extra_seconds + p_seconds,
         ends_at = ends_at + make_interval(secs => p_seconds),
         last_heartbeat_at = now()
   where id = p_session_id
   returning * into s;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_session_id, 'time_added', 'info',
          jsonb_build_object('seconds', p_seconds, 'extra_seconds', s.extra_seconds, 'ends_at', s.ends_at));

  perform public.write_audit(p_actor, 'add_time', 'exam_session', p_session_id::text,
    jsonb_build_object('seconds', p_seconds, 'ends_at', s.ends_at));

  return jsonb_build_object('added_seconds', p_seconds, 'extra_seconds', s.extra_seconds,
    'ends_at', s.ends_at, 'status', s.status,
    'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int));
end $$;

create or replace function public.reopen_session(p_session_id uuid, p_seconds int, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_previous public.session_status;
begin
  if p_seconds is null or p_seconds < 60 or p_seconds > 7200 then
    raise exception 'A reopened test gets between 1 minute and 2 hours.'
      using hint = 'validation';
  end if;
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  if s.status in ('in_progress', 'reopened') then
    raise exception 'This test is still open, so only its time can be added.' using hint = 'validation'; end if;

  v_previous := s.status;
  update public.exam_sessions
     set status = 'reopened', extra_seconds = extra_seconds + p_seconds,
         ends_at = now() + make_interval(secs => p_seconds), last_heartbeat_at = now()
   where id = p_session_id
   returning * into s;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_session_id, 'reopen', 'info',
          jsonb_build_object('seconds', p_seconds, 'ends_at', s.ends_at, 'previous_status', v_previous));

  perform public.write_audit(p_actor, 'reopen', 'exam_session', p_session_id::text,
    jsonb_build_object('seconds', p_seconds, 'ends_at', s.ends_at));

  return jsonb_build_object('status', s.status, 'reopened_for_seconds', p_seconds,
    'ends_at', s.ends_at, 'extra_seconds', s.extra_seconds,
    'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int));
end $$;

-- The student's phone only accepts an answer while the session is open, so a reopened session keeps
-- working with no change on the student side (save_session_answers allows in_progress and reopened).

-- ============ BR-02: the teacher's permission for one more attempt ============
create or replace function public.grant_retake(p_session_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_id uuid;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  if s.status in ('in_progress', 'reopened') then
    raise exception 'Finish this attempt before granting another one.' using hint = 'validation'; end if;

  select p.id into v_id from public.retake_permissions p
   where p.exam_id = s.exam_id
     and p.student_name_normalized = s.student_name_normalized
     and p.student_class_normalized = s.student_class_normalized
     and p.used_at is null;
  if v_id is not null then
    return jsonb_build_object('granted', true, 'already', true, 'permission_id', v_id);
  end if;

  insert into public.retake_permissions (exam_id, student_name_normalized, student_class_normalized, granted_by)
  values (s.exam_id, s.student_name_normalized, s.student_class_normalized, p_actor)
  returning id into v_id;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_session_id, 'retake_granted', 'info',
          jsonb_build_object('exam_id', s.exam_id, 'permission_id', v_id));

  perform public.write_audit(p_actor, 'retake_grant', 'exam_session', p_session_id::text,
    jsonb_build_object('exam_id', s.exam_id, 'student_name', s.student_name, 'student_class', s.student_class));

  return jsonb_build_object('granted', true, 'already', false, 'permission_id', v_id,
    'student_name', s.student_name, 'student_class', s.student_class);
end $$;

create or replace function public.revoke_retake(p_session_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_id uuid;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;

  select p.id into v_id from public.retake_permissions p
   where p.exam_id = s.exam_id
     and p.student_name_normalized = s.student_name_normalized
     and p.student_class_normalized = s.student_class_normalized
   order by p.granted_at desc limit 1;

  if v_id is null then
    return jsonb_build_object('revoked', false, 'reason', 'no_permission');
  end if;
  if exists (select 1 from public.retake_permissions p where p.id = v_id and p.used_at is not null) then
    raise exception 'That retake was already used, so it cannot be taken back.' using hint = 'validation'; end if;

  delete from public.retake_permissions where id = v_id;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_session_id, 'retake_revoked', 'info', jsonb_build_object('permission_id', v_id));

  perform public.write_audit(p_actor, 'retake_revoke', 'exam_session', p_session_id::text,
    jsonb_build_object('permission_id', v_id));

  return jsonb_build_object('revoked', true);
end $$;
