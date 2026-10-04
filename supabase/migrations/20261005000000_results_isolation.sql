-- TASK (2026-10-05): teacher data isolation — the results/monitor slice (DEC-041).
--
-- The third slice of the same strict model the question bank (TASK-048) and the exams slice
-- (`20261004000000`) enforce: a teacher sees and changes only the results, reports and monitor
-- data of their own exams; an active admin sees the whole school; the bell's essay and
-- suspicious-event cards follow the same rule; students are untouched (they never call the
-- results function — they join by access code and their own session functions stay unscoped,
-- including the internal writers `_session_result_write` / `_session_grade`).
--
-- What changes:
--   * Every READ gains a required `p_actor` and is scoped to
--     `public._is_staff_admin(p_actor) or exams.created_by = p_actor`: `list_exam_activity`
--     (the Grading/Results hubs and the dashboard's recent-exams card), `count_pending_grading`
--     (the Grading menu badge), `list_exam_results` (the results table and the live monitor
--     board), `get_session_report` (the Details screen), `list_grading_questions` and
--     `get_grading_queue` (the essay grading screen). The old unscoped signatures are dropped,
--     so an out-of-repo caller cannot quietly keep the unscoped door.
--   * Every WRITE already carried `p_actor`; each now refuses a foreign id with exactly the
--     sentence a missing id gets (`save_answer_grade`, `add_session_time`, `reopen_session`,
--     `grant_retake`, `revoke_retake`, `add_exam_time`) — nothing leaks existence.
--   * The bell is scoped too: `_essay_notifications(p_actor)` and
--     `_suspicious_notifications(p_days, p_actor)` only count cards on the actor's own exams
--     (an admin's bell keeps the whole school); `list_notifications` passes its actor through.
--
-- Null-actor discipline (the hole the exams slice's live SQL test caught on 2026-10-04): every
-- ownership check here uses the `not exists (select … where … and (admin or owned))` idiom or a
-- WHERE filter, where a NULL condition matches no row — so a null actor fails closed by
-- construction. Never write a bare `IF NOT (admin OR owned)`: it is NULL for a null actor and
-- fails open.
--
-- APPLIED LIVE: 2026-10-05 after the exams slice (`20261004000000`), as ONE Management API request
-- with its ledger row; the `results` Edge Function was redeployed immediately after (p_actor now
-- flows to the six read actions). The migration was applied twice the same day: the second apply IS
-- a fix — the live SQL test caught `list_exam_results`' ownership guard shadowing the function's own
-- `e` row variable (alias `e` inside the guard is ambiguous next to the plpgsql variable), so the
-- guard's alias became `e0` and the ledger row's `statements` was updated to the fixed text (the
-- F-18/ISSUE-034 precedent). The second run ended `RESULTS ISOLATION TESTS PASSED (…)`.

-- ============ reads, scoped to the caller ============
drop function if exists public.list_exam_activity(boolean);
create or replace function public.list_exam_activity(p_include_templates boolean default false, p_actor uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with agg as (
    select s.exam_id,
           count(*) as sessions,
           count(*) filter (where s.status in ('submitted', 'auto_submitted', 'timed_out')) as finished,
           count(*) filter (where s.status in ('in_progress', 'reopened')) as in_progress,
           count(*) filter (where r.pass_status = 'passed') as passed,
           count(*) filter (where r.pass_status = 'failed') as failed,
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
      'passed', a.passed, 'failed', a.failed,
      'pending_essays', a.pending_essays, 'average', a.average, 'last_submitted_at', a.last_submitted_at)
    order by a.pending_essays desc, a.last_submitted_at desc nulls last), '[]'::jsonb)
    from public.exams e
    join agg a on a.exam_id = e.id
   where (p_include_templates or not e.is_template)
     and (public._is_staff_admin(p_actor) or e.created_by = p_actor)
$$;

drop function if exists public.count_pending_grading();
create or replace function public.count_pending_grading(p_actor uuid default null)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.exam_sessions s
    join public.exams e on e.id = s.exam_id
    cross join lateral jsonb_array_elements(s.questions_snapshot) i
   where (public._is_staff_admin(p_actor) or e.created_by = p_actor)
     and i->>'type' = 'essay'
     and s.status in ('submitted', 'auto_submitted', 'timed_out')
     and not exists (select 1 from public.answer_grades g
                      where g.session_id = s.id and g.question_id = (i->>'question_id')::uuid)
$$;

drop function if exists public.list_exam_results(uuid);
create or replace function public.list_exam_results(p_exam_id uuid, p_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e public.exams%rowtype;
  v_rows jsonb;
  v_summary jsonb;
begin
  -- a foreign id is exactly as invisible as a missing one (the `not exists` idiom fails closed
  -- for a null actor too); the alias is e0 — this function declares a row variable named e
  if not exists (
    select 1 from public.exams e0
     where e0.id = p_exam_id
       and (public._is_staff_admin(p_actor) or e0.created_by = p_actor)) then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select * into e from public.exams where id = p_exam_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', t.id, 'student_name', t.student_name, 'student_class', t.student_class,
      'class_display', coalesce(ca.display_name, t.student_class),
      'attempt_no', t.attempt_no, 'status', t.status,
      'started_at', t.started_at, 'submitted_at', t.submitted_at, 'ends_at', t.ends_at,
      'remaining_seconds', case when t.status in ('in_progress', 'reopened')
        then greatest(0, floor(extract(epoch from (t.ends_at - now())))::int) end,
      'tab_switch_count', t.tab_switch_count,
      -- the exam's own limits, so the board reads a student exactly as this exam defines it
      'tab_switch_warn_limit', e.tab_switch_warn_limit,
      'tab_switch_flag_limit', e.tab_switch_flag_limit,
      'tab_switch_autosubmit_limit', e.tab_switch_autosubmit_limit,
      'last_heartbeat_at', t.last_heartbeat_at,
      'answered_count', t.answered_count,
      'question_count', t.question_count,
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
             s.ends_at, s.tab_switch_count, s.last_heartbeat_at,
             (select count(*)::int from public.session_answers a
               where a.session_id = s.id
                 and a.answer is not null
                 and coalesce(a.answer->>'text', '') <> '') as answered_count,
             coalesce(jsonb_array_length(s.questions_snapshot), 0) as question_count,
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

drop function if exists public.get_session_report(uuid);
create or replace function public.get_session_report(p_session_id uuid, p_actor uuid default null)
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
  if not exists (
    select 1 from public.exam_sessions s0
      join public.exams e0 on e0.id = s0.exam_id
     where s0.id = p_session_id
       and (public._is_staff_admin(p_actor) or e0.created_by = p_actor)) then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;

  select * into s from public.exam_sessions where id = p_session_id;
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

drop function if exists public.list_grading_questions(uuid);
create or replace function public.list_grading_questions(p_exam_id uuid, p_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id
       and (public._is_staff_admin(p_actor) or e.created_by = p_actor)) then
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

drop function if exists public.get_grading_queue(uuid, uuid);
create or replace function public.get_grading_queue(p_exam_id uuid, p_question_id uuid, p_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_question jsonb;
  v_max numeric;
begin
  if not exists (
    select 1 from public.exams e
     where e.id = p_exam_id
       and (public._is_staff_admin(p_actor) or e.created_by = p_actor)) then
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

-- ============ writes: refuse a foreign id with the missing-row sentence ============
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
  -- a foreign session is exactly as invisible as a missing one (null actor included)
  if not exists (
    select 1 from public.exam_sessions s2
      join public.exams e2 on e2.id = s2.exam_id
     where s2.id = p_session_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
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
  if not exists (
    select 1 from public.exam_sessions s2
      join public.exams e2 on e2.id = s2.exam_id
     where s2.id = p_session_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
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
  if not exists (
    select 1 from public.exam_sessions s2
      join public.exams e2 on e2.id = s2.exam_id
     where s2.id = p_session_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
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

create or replace function public.grant_retake(p_session_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_id uuid;
begin
  select * into s from public.exam_sessions where id = p_session_id;
  if not found then
    raise exception 'That test session was not found.' using hint = 'validation'; end if;
  if not exists (
    select 1 from public.exam_sessions s2
      join public.exams e2 on e2.id = s2.exam_id
     where s2.id = p_session_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
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
  if not exists (
    select 1 from public.exam_sessions s2
      join public.exams e2 on e2.id = s2.exam_id
     where s2.id = p_session_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
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

create or replace function public.add_exam_time(p_exam_id uuid, p_seconds int, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.exams%rowtype;
  v_sessions uuid[];
  v_n int;
begin
  if p_seconds is null or p_seconds < 60 or p_seconds > 7200 then
    raise exception 'Time can be added in steps between 1 minute and 2 hours.'
      using hint = 'validation';
  end if;

  select * into e from public.exams where id = p_exam_id;
  if not found then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;
  if not exists (
    select 1 from public.exams e2
     where e2.id = p_exam_id
       and (public._is_staff_admin(p_actor) or e2.created_by = p_actor)) then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(array_agg(id), '{}') into v_sessions
    from public.exam_sessions
   where exam_id = p_exam_id and status in ('in_progress', 'reopened');

  v_n := coalesce(array_length(v_sessions, 1), 0);
  if v_n = 0 then
    raise exception 'Nobody is taking this test right now, so there is no one to give time to.'
      using hint = 'validation';
  end if;

  update public.exam_sessions
     set extra_seconds = extra_seconds + p_seconds,
         ends_at = ends_at + make_interval(secs => p_seconds),
         last_heartbeat_at = now()
   where id = any(v_sessions);

  insert into public.session_events (session_id, event_type, severity, meta)
  select id, 'time_added', 'info',
         jsonb_build_object('seconds', p_seconds, 'scope', 'exam', 'exam_id', p_exam_id)
    from public.exam_sessions where id = any(v_sessions);

  perform public.write_audit(p_actor, 'add_time', 'exam', p_exam_id::text,
    jsonb_build_object('seconds', p_seconds, 'sessions', v_n));

  return jsonb_build_object(
    'updated', v_n,
    'added_seconds', p_seconds,
    'remaining_seconds', (select max(greatest(0, floor(extract(epoch from (s.ends_at - now())))::int))
                            from public.exam_sessions s where s.id = any(v_sessions)));
end $$;

-- ============ the bell: essay and suspicious cards follow the exam's owner ============
drop function if exists public._essay_notifications();
create or replace function public._essay_notifications(p_actor uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with waiting as (
    select r.session_id, s.exam_id, s.student_name, s.student_class, r.updated_at,
           (select count(*) from jsonb_array_elements(r.review_snapshot) x
             where x->>'type' = 'essay'
               and not exists (select 1 from public.answer_grades g
                                where g.session_id = r.session_id
                                  and g.question_id = (x->>'question_id')::uuid))::int as waiting
      from public.exam_results r
      join public.exam_sessions s on s.id = r.session_id
     where r.status = 'pending_review'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'exam_id', t.exam_id, 'title', e.title, 'access_code', e.access_code,
           'waiting', t.waiting, 'student_name', t.student_name, 'student_class', t.student_class,
           'session_id', t.session_id, 'updated_at', t.updated_at) order by t.updated_at desc), '[]'::jsonb)
    from waiting t
    join public.exams e on e.id = t.exam_id
   where public._is_staff_admin(p_actor) or e.created_by = p_actor
$$;

-- An exam is worth a look when a finished attempt raised a suspicious or violation event (the
-- session engine writes those severities on its own, from the exam's tab-switch limits) or when a
-- session crossed the flag limit on its counter. One card per exam, with the number to investigate.
drop function if exists public._suspicious_notifications(integer);
create or replace function public._suspicious_notifications(p_days int, p_actor uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'exam_id', e.id, 'title', e.title, 'access_code', e.access_code,
           'events', t.events, 'sessions', t.sessions, 'last_at', t.last_at) order by t.last_at desc), '[]'::jsonb)
    from (
      select s.exam_id,
             count(*)::int as events,
             count(distinct s.id)::int as sessions,
             max(v.occurred_at) as last_at
        from public.session_events v
        join public.exam_sessions s on s.id = v.session_id
       where v.severity in ('suspicious', 'violation')
         and v.occurred_at >= now() - make_interval(days => p_days)
       group by s.exam_id
    ) t
    join public.exams e on e.id = t.exam_id
   where public._is_staff_admin(p_actor) or e.created_by = p_actor
$$;

create or replace function public.list_notifications(p_actor uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_limit int := coalesce(p_limit, 50);
  v_read timestamptz;
  v_essays jsonb;
  v_suspicious jsonb;
  v_backup jsonb;
  v_accounts jsonb;
begin
  if v_limit < 1 or v_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;
  v_me := public._actor_profile(p_actor);

  select last_read_at into v_read from public.notification_reads where person_id = v_me.id;
  v_read := coalesce(v_read, to_timestamp(0)); -- never opened: everything counts as unread

  v_essays := public._essay_notifications(p_actor);
  v_suspicious := public._suspicious_notifications(14, p_actor);
  -- The backup and the new-account news point at admin screens (design.md 1.2), so only an admin's
  -- bell carries them; a teacher's bell is the two teacher things: essays and suspicious events.
  if v_me.role = 'admin' then
    select jsonb_build_object(
             'kind', b.kind, 'created_at', b.created_at, 'size_bytes', b.size_bytes,
             'created_by_name', p.full_name)
      into v_backup
      from public.backups b left join public.profiles p on p.id = b.created_by
      order by b.created_at desc, b.id desc limit 1;

    -- A created account is news once: within the last 14 days, audited (BR-13), never the password.
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', a.changes->>'email', 'full_name', a.changes->>'full_name', 'role', a.changes->>'role',
             'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
      into v_accounts
      from public.audit_logs a
      where a.action = 'account.create'
        and a.created_at >= now() - interval '14 days';
  end if;

  return jsonb_build_object(
    'kinds', jsonb_build_object(
      'essays', v_essays,
      'suspicious', v_suspicious,
      'backup', v_backup,
      'accounts', v_accounts),
    'essays', coalesce((select sum((x->>'waiting')::int) from jsonb_array_elements(v_essays) x), 0),
    'suspicious', (select count(*) from jsonb_array_elements(v_suspicious)),
    'account', (select count(*) from jsonb_array_elements(v_accounts)),
    'backup', case when v_backup is null then 0 else 1 end,
    'total', (select count(*) from jsonb_array_elements(v_essays))
           + (select count(*) from jsonb_array_elements(v_suspicious))
           + case when v_backup is null then 0 else 1 end
           + (select count(*) from jsonb_array_elements(v_accounts)),
    -- The JSON timestamps are text, so they are cast back before comparing (the live run caught this).
    'unread', (select count(*) from jsonb_array_elements(v_essays) x
                where (x->>'updated_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_suspicious) x
                where (x->>'last_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_accounts) x
                where (x->>'created_at')::timestamptz > v_read)
            + case when v_backup is not null and (v_backup->>'created_at')::timestamptz > v_read then 1 else 0 end,
    'read_at', case when exists (select 1 from public.notification_reads where person_id = v_me.id)
                    then v_read end
  );
end $$;

-- The boundary: only the service role executes these; anon and authenticated do not.
revoke execute on function public.list_exam_activity(boolean, uuid) from public, anon, authenticated;
revoke execute on function public.count_pending_grading(uuid) from public, anon, authenticated;
revoke execute on function public.list_exam_results(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_session_report(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.list_grading_questions(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_grading_queue(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._essay_notifications(uuid) from public, anon, authenticated;
revoke execute on function public._suspicious_notifications(integer, uuid) from public, anon, authenticated;
grant execute on function public.list_exam_activity(boolean, uuid) to service_role;
grant execute on function public.count_pending_grading(uuid) to service_role;
grant execute on function public.list_exam_results(uuid, uuid) to service_role;
grant execute on function public.get_session_report(uuid, uuid) to service_role;
grant execute on function public.list_grading_questions(uuid, uuid) to service_role;
grant execute on function public.get_grading_queue(uuid, uuid, uuid) to service_role;
grant execute on function public._essay_notifications(uuid) to service_role;
grant execute on function public._suspicious_notifications(integer, uuid) to service_role;
