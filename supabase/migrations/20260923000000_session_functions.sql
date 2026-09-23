-- TASK-010: student exam engine — session functions (DEC-004: business rules live in SQL,
-- one transaction per action; DEC-022: the browser proves who it is with a signed session token,
-- the answer key never leaves the server).
--
-- Applied live on 2026-09-23 via `supabase db query --linked --file` (same path as the exams SQL).
-- Idempotent: every object is `create or replace`.
--
-- Live schema this file relies on (discovered by inspecting the v2 project):
--   exam_sessions   (id, exam_id, student_name, student_name_normalized, student_class,
--                    student_class_normalized, attempt_no, status session_status, started_at, ends_at,
--                    extra_seconds, submitted_at, last_heartbeat_at, questions_snapshot jsonb,
--                    answer_key jsonb, tab_switch_count)
--     unique (exam_id, student_name_normalized, student_class_normalized, attempt_no)
--     student_name_normalized / student_class_normalized are GENERATED columns
--     (normalize_text(...)) — never insert them, the database fills them in.
--   (same for accepted_answers.answer_normalized and question_class_labels.label_normalized)
--   session_answers (session_id, question_id, answer jsonb, is_flagged, answered_at, client_saved_at)
--     unique (session_id, question_id) — makes resending from the phone safe (BR-12)
--   answer_grades   (session_id, question_id, points_awarded, max_points, is_auto, graded_by, feedback, graded_at)
--     unique (session_id, question_id)
--   exam_results    (session_id unique, total_points, max_points, percentage, status result_status,
--                    pass_status, correct_count, wrong_count, time_used_seconds, review_snapshot)
--   session_events  (id, session_id, event_type, severity event_severity, meta, occurred_at)
--   retake_permissions (exam_id, student_name_normalized, student_class_normalized, granted_by, granted_at, used_at)
--
-- Business rules implemented here: BR-01 (one attempt), BR-02 (one retake), BR-03/BR-04/BR-05
-- (code + schedule + late-start policy), BR-06 (points), BR-07/BR-08 (essay pending + visibility),
-- BR-09 (keys stay server-side), BR-10 (per-session snapshot), BR-12 (idempotent answers),
-- BR-20 (2-minute tolerance after ends_at), BR-21 (server-side validation).

-- ============ small helpers ============

-- One question as the student's phone receives it. Never contains the correct answer.
create or replace function public._session_question_block(
  p_qid uuid, p_weight numeric, p_position int, p_shuffle_options boolean
) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'position', p_position,
    'question_id', q.id,
    'weight', p_weight,
    'type', q.type,
    'body', q.body,
    'passage', case when p.id is null then null else jsonb_build_object(
      'title', p.title,
      'body', p.body,
      'media', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type,
                 'size_bytes', m.size_bytes, 'name', m.original_name, 'duration_seconds', m.duration_seconds)
               order by pm.position)
        from public.question_media pm join public.media_files m on m.id = pm.media_id
        where pm.passage_id = p.id), '[]'::jsonb)) end,
    'media', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type,
               'size_bytes', m.size_bytes, 'name', m.original_name, 'duration_seconds', m.duration_seconds)
             order by qm.position)
      from public.question_media qm join public.media_files m on m.id = qm.media_id
      where qm.question_id = q.id), '[]'::jsonb),
    -- Option text only. The correct one is kept in answer_key (BR-09).
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('position', o.position, 'body', o.body)
             order by case when p_shuffle_options and q.type = 'multiple_choice' then random() end, o.position)
      from public.question_options o where o.question_id = q.id), '[]'::jsonb)
  )
  from public.questions q
  left join public.passages p on p.id = q.passage_id
  where q.id = p_qid
$$;

-- The answer key entry for one question. Stays on the server until the session is graded.
create or replace function public._session_key_entry(p_qid uuid, p_weight numeric)
returns jsonb language sql security definer set search_path = public as $$
  select case q.type
    when 'multiple_choice' then jsonb_build_object('type', q.type, 'weight', p_weight,
      'correct', public.normalize_text(o.body), 'correct_text', o.body)
    when 'true_false' then jsonb_build_object('type', q.type, 'weight', p_weight,
      'correct', public.normalize_text(o.body), 'correct_text', o.body)
    when 'short_answer' then jsonb_build_object('type', q.type, 'weight', p_weight,
      'accepted', coalesce((select jsonb_agg(public.normalize_text(a.answer_text)) from public.accepted_answers a where a.question_id = q.id), '[]'::jsonb),
      'accepted_text', coalesce((select jsonb_agg(a.answer_text) from public.accepted_answers a where a.question_id = q.id), '[]'::jsonb))
    else jsonb_build_object('type', q.type, 'weight', p_weight)
  end
  from public.questions q
  left join public.question_options o on o.question_id = q.id and o.is_correct
  where q.id = p_qid
$$;

-- ============ read a session (also used by exam_join to answer "resume") ============
create or replace function public.get_exam_session(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.exam_sessions%rowtype; e public.exams%rowtype;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation';
  end if;
  select * into e from public.exams where id = s.exam_id;
  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', s.id, 'status', s.status, 'attempt_no', s.attempt_no,
      'student_name', s.student_name, 'student_class', s.student_class,
      'started_at', s.started_at, 'ends_at', s.ends_at, 'submitted_at', s.submitted_at,
      'tab_switch_count', s.tab_switch_count,
      'server_time', now(),
      'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int),
      'grace_seconds', 120, -- must match the 2-minute tolerance used below (BR-20)
      'exam', jsonb_build_object(
        'id', e.id, 'title', e.title, 'duration_minutes', e.duration_minutes,
        'passing_grade', e.passing_grade, 'result_visibility', e.result_visibility,
        'essay_pending_display', e.essay_pending_display,
        'tab_switch_warn_limit', e.tab_switch_warn_limit,
        'tab_switch_flag_limit', e.tab_switch_flag_limit,
        'tab_switch_autosubmit_limit', e.tab_switch_autosubmit_limit)
    ),
    'questions', s.questions_snapshot,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object('question_id', a.question_id, 'answer', a.answer,
               'is_flagged', a.is_flagged, 'client_saved_at', a.client_saved_at) order by a.answered_at)
      from public.session_answers a where a.session_id = s.id), '[]'::jsonb)
  );
end $$;

-- ============ join with a code (BR-01, BR-02, BR-03, BR-04, BR-05, BR-10) ============
create or replace function public.exam_join(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_name text := btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g'));
  v_class text := btrim(regexp_replace(coalesce(p->>'class', ''), '\s+', ' ', 'g'));
  v_name_n text;
  v_class_n text;
  v_code text := upper(regexp_replace(coalesce(p->>'code', ''), '\s', '', 'g'));
  e public.exams%rowtype;
  v_prev record;
  v_permission uuid;
  v_attempt int;
  v_ends timestamptz;
  v_ids uuid[];
  v_weights numeric[];
  v_snapshot jsonb;
  v_key jsonb;
  v_session_id uuid;
begin
  -- ---- validation (BR-21) ----
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Enter your full name (2 to 80 characters).' using hint = 'validation'; end if;
  if char_length(v_class) < 1 or char_length(v_class) > 60 then
    raise exception 'Enter your class (up to 60 characters).' using hint = 'validation'; end if;
  if v_name ~ '[<>]' or v_class ~ '[<>]' then
    raise exception 'Name and class cannot contain < or >.' using hint = 'validation'; end if;
  if v_code = '' then
    raise exception 'Enter the test code your teacher wrote on the board.' using hint = 'validation'; end if;

  -- ---- find and check the exam (BR-03, BR-04) ----
  select * into e from public.exams where access_code = v_code;
  if not found then
    raise exception 'That test code was not found. Check the code on the board.' using hint = 'validation'; end if;
  if e.is_template then
    raise exception 'That code belongs to a template, not a running test.' using hint = 'validation'; end if;
  if e.status = 'draft' then
    raise exception 'This test has not been opened yet.' using hint = 'validation'; end if;
  if e.status = 'closed' then
    raise exception 'This test is closed.' using hint = 'validation'; end if;
  if e.availability_mode = 'scheduled' then
    if e.starts_at is not null and v_now < e.starts_at then
      raise exception 'This test has not started yet.' using hint = 'validation'; end if;
    if e.ends_at is not null and v_now > e.ends_at then
      raise exception 'This test is closed.' using hint = 'validation'; end if;
  end if;

  v_name_n := public.normalize_text(v_name);
  v_class_n := public.normalize_text(v_class);

  -- ---- BR-01: one attempt. An unfinished attempt is resumed instead of refused. ----
  select id, status, attempt_no into v_prev
    from public.exam_sessions
   where exam_id = e.id and student_name_normalized = v_name_n and student_class_normalized = v_class_n
   order by attempt_no desc limit 1;

  if found and v_prev.status in ('in_progress', 'reopened') then
    return public.get_exam_session(v_prev.id);
  end if;

  if found then
    -- ---- BR-02: one unused permission allows exactly one more attempt ----
    select id into v_permission from public.retake_permissions
     where exam_id = e.id and student_name_normalized = v_name_n
       and student_class_normalized = v_class_n and used_at is null
     order by granted_at limit 1;
    if not found then
      raise exception 'You already took this test. Ask your teacher for another try.' using hint = 'validation';
    end if;
    update public.retake_permissions set used_at = now() where id = v_permission;
  end if;

  v_attempt := coalesce(v_prev.attempt_no, 0) + 1;

  -- ---- pick the questions (manual order, or the exam's filter) ----
  if e.selection_mode = 'manual' then
    select array_agg(eq.question_id order by eq.position), array_agg(eq.weight order by eq.position)
      into v_ids, v_weights
      from public.exam_questions eq where eq.exam_id = e.id;
  else
    select array_agg(t.question_id order by t.ord), array_agg(t.weight order by t.ord)
      into v_ids, v_weights
      from (
        select q.id as question_id, q.default_weight as weight,
               row_number() over (order by case when e.draw_per_student then random() end, q.created_at, q.id) as ord
        from public.questions q
        left join public.topics tp on tp.id = q.topic_id
        where q.is_archived = false
          and (not (e.auto_filter ? 'topic') or public.normalize_text(tp.name) = public.normalize_text(e.auto_filter->>'topic'))
          and (not (e.auto_filter ? 'difficulty') or q.difficulty::text = e.auto_filter->>'difficulty')
          and (not (e.auto_filter ? 'class_label') or exists (
                select 1 from public.question_class_labels l
                 where l.question_id = q.id and l.label_normalized = public.normalize_text(e.auto_filter->>'class_label')))
        order by case when e.draw_per_student then random() end, q.created_at, q.id
        limit coalesce(e.pool_size, 1)
      ) t;
  end if;

  if v_ids is null or array_length(v_ids, 1) = 0 then
    raise exception 'This test has no questions available right now. Please tell your teacher.' using hint = 'validation';
  end if;

  -- ---- BR-10: the session keeps its own copy of the questions (no keys) ----
  v_snapshot := (
    select coalesce(jsonb_agg(public._session_question_block(x.qid, x.w, x.pos, e.randomize_options) order by x.pos), '[]'::jsonb)
    from (
      select u.qid, u.w, row_number() over (order by case when e.randomize_questions then random() end, u.ord)::int as pos
      from unnest(v_ids, v_weights) with ordinality as u(qid, w, ord)
    ) x
  );
  v_key := (
    select coalesce(jsonb_object_agg(u.qid::text, public._session_key_entry(u.qid, u.w)), '{}'::jsonb)
    from unnest(v_ids, v_weights) as u(qid, w)
  );

  -- ---- time: full duration, or cut at the closing time (BR-05) ----
  v_ends := v_now + make_interval(mins => e.duration_minutes);
  if e.availability_mode = 'scheduled' and e.ends_at is not null and e.late_start_policy = 'cut_at_end' then
    v_ends := least(v_ends, e.ends_at);
  end if;

  begin
    -- the normalized name/class columns are generated by the database from these two values
    insert into public.exam_sessions (exam_id, student_name, student_class, attempt_no, status,
        started_at, ends_at, last_heartbeat_at, questions_snapshot, answer_key)
    values (e.id, v_name, v_class, v_attempt, 'in_progress', v_now, v_ends, v_now, v_snapshot, v_key)
    returning id into v_session_id;
  exception when unique_violation then
    -- Two taps of "Start test" at the same time: the second one resumes the first session.
    select id into v_session_id from public.exam_sessions
     where exam_id = e.id and student_name_normalized = v_name_n and student_class_normalized = v_class_n
     order by attempt_no desc limit 1;
    return public.get_exam_session(v_session_id);
  end;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (v_session_id, 'join', 'info',
          jsonb_build_object('attempt', v_attempt, 'questions', jsonb_array_length(v_snapshot)));

  return public.get_exam_session(v_session_id);
end $$;

-- ============ autosave (BR-12: resend must not create duplicates) ============
create or replace function public.save_session_answers(p_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  v_item jsonb;
  v_qid uuid;
  v_type text;
  v_text text;
  v_answer jsonb;
  v_flagged boolean;
  v_client timestamptz;
  v_i int;
  v_n int := 0;
  v_count int := coalesce(jsonb_array_length(case when jsonb_typeof(p_answers) = 'array' then p_answers else '[]'::jsonb end), 0);
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  if s.status in ('submitted', 'auto_submitted', 'timed_out') then
    return jsonb_build_object('accepted', false, 'saved', 0, 'reason', 'already_submitted',
      'status', s.status, 'server_time', now(), 'ends_at', s.ends_at);
  end if;
  if v_count > 200 then
    raise exception 'Too many answers were sent at once.' using hint = 'validation'; end if;

  -- BR-20: after the deadline (plus tolerance) nothing is accepted; grade what we have.
  if now() > s.ends_at + interval '2 minutes' then
    perform public._session_grade(s.id, 'auto_submitted');
    return jsonb_build_object('accepted', false, 'saved', 0, 'reason', 'time_up',
      'status', 'auto_submitted', 'server_time', now(), 'ends_at', s.ends_at);
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_item := p_answers -> v_i;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'An answer entry is not valid.' using hint = 'validation'; end if;
    begin
      v_qid := (v_item->>'question_id')::uuid;
    exception when others then
      raise exception 'An answer entry has an invalid question id.' using hint = 'validation';
    end;

    select x.value->>'type' into v_type
      from jsonb_array_elements(s.questions_snapshot) x
     where x.value->>'question_id' = v_qid::text;
    if v_type is null then
      raise exception 'That question is not part of this test.' using hint = 'validation'; end if;

    v_answer := case when jsonb_typeof(v_item->'answer') = 'object' then v_item->'answer' else '{}'::jsonb end;
    v_text := coalesce(v_answer->>'text', '');
    if char_length(v_text) > (case when v_type = 'essay' then 20000 else 1000 end) then
      raise exception 'That answer is too long.' using hint = 'validation'; end if;

    v_flagged := coalesce((v_item->>'is_flagged')::boolean, false);
    v_client := null;
    if coalesce(v_item->>'client_saved_at', '') <> '' then
      v_client := (v_item->>'client_saved_at')::timestamptz;
    end if;

    insert into public.session_answers (session_id, question_id, answer, is_flagged, answered_at, client_saved_at)
    values (p_id, v_qid, v_answer, v_flagged, now(), v_client)
    on conflict (session_id, question_id) do update
      set answer = excluded.answer, is_flagged = excluded.is_flagged, answered_at = now(),
          client_saved_at = coalesce(excluded.client_saved_at, public.session_answers.client_saved_at);
    v_n := v_n + 1;
  end loop;

  update public.exam_sessions set last_heartbeat_at = now() where id = p_id;

  return jsonb_build_object('accepted', true, 'saved', v_n, 'status', s.status,
    'server_time', now(), 'ends_at', s.ends_at,
    'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int));
end $$;

-- ============ heartbeat: keeps "time left" honest and closes expired sessions ============
create or replace function public.session_heartbeat(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions%rowtype;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  if s.status in ('in_progress', 'reopened') and now() > s.ends_at + interval '2 minutes' then
    perform public._session_grade(s.id, 'auto_submitted');
    select * into s from public.exam_sessions where id = p_id;
  elsif s.status in ('in_progress', 'reopened') then
    update public.exam_sessions set last_heartbeat_at = now() where id = p_id;
  end if;
  return jsonb_build_object('status', s.status, 'server_time', now(), 'ends_at', s.ends_at,
    'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int),
    'tab_switch_count', s.tab_switch_count);
end $$;

-- ============ session events + the automatic submit limit (anti-cheating, section 4) ============
create or replace function public.log_session_event(p_id uuid, p_event_type text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  e public.exams%rowtype;
  v_sev public.event_severity := 'info';
  v_leave boolean := p_event_type in ('tab_hidden', 'blur');
  v_autosubmit boolean := false;
begin
  if p_event_type not in ('join', 'tab_hidden', 'blur', 'focus', 'online', 'offline', 'reload', 'submit', 'reopen') then
    raise exception 'That event type is not known.' using hint = 'validation'; end if;
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  select * into e from public.exams where id = s.exam_id;

  if s.status in ('in_progress', 'reopened') and v_leave then
    s.tab_switch_count := s.tab_switch_count + 1;
    v_sev := case
      when s.tab_switch_count >= e.tab_switch_flag_limit then 'suspicious'
      when s.tab_switch_count >= e.tab_switch_warn_limit then 'warning'
      else 'info' end;
    update public.exam_sessions set tab_switch_count = s.tab_switch_count, last_heartbeat_at = now()
     where id = p_id;
  end if;
  if s.status in ('in_progress', 'reopened') and p_event_type = 'offline' then
    v_sev := 'info';
  end if;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_id, p_event_type, v_sev, coalesce(p_meta, '{}'::jsonb));

  if s.status in ('in_progress', 'reopened') and v_leave and s.tab_switch_count >= e.tab_switch_autosubmit_limit then
    perform public._session_grade(s.id, 'auto_submitted');
    v_autosubmit := true;
  end if;

  return jsonb_build_object('status', case when v_autosubmit then 'auto_submitted' else s.status end,
    'tab_switch_count', s.tab_switch_count, 'autosubmit', v_autosubmit,
    'warn_limit', e.tab_switch_warn_limit, 'flag_limit', e.tab_switch_flag_limit,
    'autosubmit_limit', e.tab_switch_autosubmit_limit);
end $$;

-- ============ grading (BR-06, BR-07) — one place, used by submit, time-up, and the tab limit ============
create or replace function public._session_grade(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  e public.exams%rowtype;
  v_item jsonb;
  v_key jsonb;
  v_qid uuid;
  v_type text;
  v_w numeric;
  v_text text;
  v_ok boolean;
  v_pos int := 0;
  v_pts numeric := 0;
  v_max numeric := 0;
  v_correct int := 0;
  v_wrong int := 0;
  v_pending boolean := false;
  v_review jsonb := '[]'::jsonb;
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
    v_key := s.answer_key -> v_qid::text;
    v_max := v_max + v_w;

    select coalesce(a.answer->>'text', '') into v_text
      from public.session_answers a where a.session_id = p_id and a.question_id = v_qid;

    if v_type = 'essay' then
      -- BR-07: essays wait for the teacher; nothing is auto-graded here.
      v_pending := true;
      v_ok := null;
    else
      if coalesce(v_text, '') = '' then
        v_ok := false;
      elsif v_type = 'short_answer' then
        v_ok := coalesce(v_key->'accepted', '[]'::jsonb) ? public.normalize_text(v_text);
      else
        v_ok := coalesce(v_key->>'correct', '') <> '' and public.normalize_text(v_text) = v_key->>'correct';
      end if;

      if v_ok then v_pts := v_pts + v_w; v_correct := v_correct + 1; else v_wrong := v_wrong + 1; end if;

      insert into public.answer_grades (session_id, question_id, points_awarded, max_points, is_auto)
      values (p_id, v_qid, case when v_ok then v_w else 0 end, v_w, true)
      on conflict (session_id, question_id) do update
        set points_awarded = excluded.points_awarded, max_points = excluded.max_points,
            is_auto = true, graded_at = now();
    end if;

    v_review := v_review || jsonb_build_object(
      'position', v_pos, 'question_id', v_qid, 'type', v_type, 'weight', v_w,
      'body', v_item->'body', 'options', coalesce(v_item->'options', '[]'::jsonb),
      'chosen', coalesce(v_text, ''),
      'correct_text', coalesce(v_key->>'correct_text', ''),
      'accepted_text', coalesce(v_key->'accepted_text', '[]'::jsonb),
      'is_correct', v_ok,
      'points', coalesce((select g.points_awarded from public.answer_grades g
                           where g.session_id = p_id and g.question_id = v_qid), 0),
      'max_points', v_w);
  end loop;

  v_pct := case when v_max > 0 then round(v_pts / v_max * 100, 2) else 0 end;
  v_status := case when v_pending then 'pending_review' else 'graded' end;
  v_pass := case when v_pending then 'not_final'
                 when v_pct >= e.passing_grade then 'passed' else 'failed' end;
  v_secs := greatest(0, floor(extract(epoch from (now() - s.started_at)))::int);

  update public.exam_sessions
     set status = p_status::public.session_status, submitted_at = coalesce(submitted_at, now()),
         last_heartbeat_at = now()
   where id = p_id;

  insert into public.exam_results (session_id, total_points, max_points, percentage, status, pass_status,
      correct_count, wrong_count, time_used_seconds, review_snapshot)
  values (p_id, v_pts, v_max, v_pct, v_status, v_pass, v_correct, v_wrong, v_secs, v_review)
  on conflict (session_id) do update
    set total_points = excluded.total_points, max_points = excluded.max_points, percentage = excluded.percentage,
        status = excluded.status, pass_status = excluded.pass_status, correct_count = excluded.correct_count,
        wrong_count = excluded.wrong_count, time_used_seconds = excluded.time_used_seconds,
        review_snapshot = excluded.review_snapshot, updated_at = now();

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_id, 'submit', 'info', jsonb_build_object('status', p_status, 'percentage', v_pct, 'pending_review', v_pending));
end $$;

-- ============ what the student may see (BR-08) ============
create or replace function public._session_public_result(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype; e public.exams%rowtype; r public.exam_results%rowtype;
  v_pending boolean;
  v_hide boolean;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  select * into e from public.exams where id = s.exam_id;
  select * into r from public.exam_results where session_id = p_id;
  if r.id is null then
    return jsonb_build_object('submitted', true, 'status', s.status, 'visibility', 'none',
      'pending_review', false, 'pass_status', 'not_final');
  end if;

  v_pending := r.status = 'pending_review';
  -- BR-08: a teacher may prefer "waiting for your teacher" over a partial number.
  v_hide := v_pending and e.essay_pending_display = 'hide_score';

  return jsonb_build_object(
    'submitted', true, 'status', s.status, 'submitted_at', s.submitted_at,
    'visibility', e.result_visibility,
    'pending_review', v_pending,
    'pending_essays', case when v_pending then (
      select count(*) from jsonb_array_elements(r.review_snapshot) x where x->>'type' = 'essay') else 0 end,
    'pass_status', case when v_pending then 'not_final' else r.pass_status end,
    'passing_grade', e.passing_grade,
    'score', case when e.result_visibility = 'none' or v_hide then null else jsonb_build_object(
      'percentage', r.percentage, 'total_points', r.total_points, 'max_points', r.max_points,
      'correct_count', r.correct_count, 'wrong_count', r.wrong_count,
      'pass_status', r.pass_status, 'time_used_seconds', r.time_used_seconds) end,
    'review', case when e.result_visibility = 'score_and_review' and not v_hide then r.review_snapshot else null end
  );
end $$;

-- ============ submit (BR-11: a teacher may also submit/open a session later) ============
create or replace function public.submit_exam_session(p_id uuid, p_reason text default 'student')
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions%rowtype; v_status text;
begin
  if p_reason not in ('student', 'time_up', 'tab_switch_limit', 'teacher') then
    raise exception 'That submit reason is not known.' using hint = 'validation'; end if;
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  if s.status in ('submitted', 'auto_submitted', 'timed_out') then
    return public._session_public_result(p_id); -- idempotent: a second submit just shows the result
  end if;
  v_status := case when p_reason = 'student' then 'submitted' else 'auto_submitted' end;
  perform public._session_grade(p_id, v_status);
  return public._session_public_result(p_id);
end $$;

create or replace function public.get_session_result(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.exam_sessions%rowtype;
begin
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  if s.status in ('in_progress', 'reopened') then
    return jsonb_build_object('submitted', false, 'status', s.status, 'server_time', now(),
      'ends_at', s.ends_at,
      'remaining_seconds', greatest(0, floor(extract(epoch from (s.ends_at - now())))::int));
  end if;
  return public._session_public_result(p_id);
end $$;

-- ============ media the session is allowed to show (bucket stays private) ============
create or replace function public.get_session_media_ids(p_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct t.mid), '{}'::uuid[]) from (
    select (m->>'id')::uuid as mid
      from public.exam_sessions s,
           lateral jsonb_array_elements(s.questions_snapshot) q,
           lateral jsonb_array_elements(coalesce(q->'media', '[]'::jsonb)) m
     where s.id = p_id
    union
    select (pm->>'id')::uuid
      from public.exam_sessions s,
           lateral jsonb_array_elements(s.questions_snapshot) q,
           lateral jsonb_array_elements(coalesce(q->'passage'->'media', '[]'::jsonb)) pm
     where s.id = p_id
  ) t
$$;

-- ============ cleanup (BR-21: sessions nobody submitted become timed_out) ============
create or replace function public.expire_sessions(p_tolerance interval default '2 minutes')
returns int language plpgsql security definer set search_path = public as $$
declare s record; n int := 0;
begin
  for s in select id from public.exam_sessions
            where status in ('in_progress', 'reopened') and ends_at + p_tolerance < now() loop
    if exists (select 1 from public.session_answers a where a.session_id = s.id) then
      perform public._session_grade(s.id, 'auto_submitted');
    else
      update public.exam_sessions set status = 'timed_out', submitted_at = now() where id = s.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
