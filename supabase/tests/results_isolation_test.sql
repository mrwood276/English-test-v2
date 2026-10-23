-- SQL test for teacher data isolation in results and the monitor (DEC-041, the results slice —
-- mirrors the exams and question-bank slice tests).
-- Run against the v2 project as ONE request (one request = one session), rolled back:
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--
-- It creates its own exams and attempts (marked TASK-RSI) and lets the transaction abort at the
-- end, so nothing it writes survives — the ERROR MESSAGE is the result:
--   "RESULTS ISOLATION TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"            → a rule is broken
--
-- The matrix (DEC-041, the strict model): a teacher sees and changes only the results, reports,
-- monitor data and bell cards of their own exams; a foreign id is exactly as invisible as a missing
-- one (the same sentence, the same hint); an active admin sees the whole school; a null actor fails
-- closed — including the badge, the hubs and the bell.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

create or replace function pg_temp.expect_error(sql text, needle text, msg text)
returns void language plpgsql as $$
declare v_hint text;
begin
  begin
    execute sql;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if position(needle in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (error said: %)', msg, sqlerrm;
    end if;
    if v_hint is distinct from 'validation' then
      raise exception 'ASSERT FAILED: % (the hint was %, not validation — the teacher would see a 500)', msg, coalesce(v_hint, '<none>');
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $rsi_isolation$
declare
  v_admin uuid;
  v_teacher uuid;
  v_q_mc uuid; v_q_sa uuid; v_q_es uuid;
  v_mc_correct text;
  v_et uuid;   -- teacher's exam
  v_ea uuid;   -- admin's exam
  v_st uuid;   -- a teacher-exam session (submitted, essay waiting)
  v_sa uuid;   -- an admin-exam session (submitted, essay waiting)
  v_out jsonb;
  v_res jsonb;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and an active teacher to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.list_exam_results(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_exam_results(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.get_session_report(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_session_report(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.list_exam_activity(boolean, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_exam_activity(boolean, uuid)', 'execute')
    and not has_function_privilege('anon', 'public._essay_notifications(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._essay_notifications(uuid)', 'execute'),
    'anon and authenticated cannot execute the isolated result functions');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.list_exam_results(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_session_report(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.count_pending_grading(uuid)', 'execute')
    and has_function_privilege('service_role', 'public._suspicious_notifications(integer, uuid)', 'execute')
    and has_function_privilege('service_role', 'public._is_staff_admin(uuid)', 'execute'),
    'service_role can execute the isolated functions');
  perform pg_temp.assert_true(
    public._is_staff_admin(v_admin) and not public._is_staff_admin(v_teacher) and not public._is_staff_admin(null),
    '_is_staff_admin is true for the admin, false for a teacher and for null');

  -- ---------- fixtures: three shared questions, two owner exams, one attempt each ----------
  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('multiple_choice', 'medium', 'TASK-RSI isolation question', 2, md5(random()::text))
  returning id into v_q_mc;
  insert into public.question_options (question_id, position, body, is_correct)
  values (v_q_mc, 1, 'Yes', true), (v_q_mc, 2, 'No', false);
  select o.body into v_mc_correct from public.question_options o where o.question_id = v_q_mc and o.is_correct limit 1;

  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('short_answer', 'easy', 'Write the simple past of go. (TASK-RSI)', 1, md5(random()::text))
  returning id into v_q_sa;
  insert into public.accepted_answers (question_id, answer_text) values (v_q_sa, 'went');

  insert into public.questions (type, difficulty, body, default_weight, content_hash, essay_guidance)
  values ('essay', 'easy', 'Explain why the orientation matters. (TASK-RSI)', 3, md5(random()::text), 'Say who, where, when.')
  returning id into v_q_es;

  v_et := gen_random_uuid();
  v_ea := gen_random_uuid();

  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode,
      access_code, selection_mode, randomize_questions, randomize_options, result_visibility, created_by)
  values (v_et, 'TASK-RSI teacher exam', 'open', 60, 70, 'manual', 'RSITEA', 'manual', false, false,
          'score_and_review', v_teacher);
  insert into public.exam_questions (exam_id, question_id, position, weight) values
    (v_et, v_q_mc, 1, 2), (v_et, v_q_sa, 2, 1), (v_et, v_q_es, 3, 3);

  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode,
      access_code, selection_mode, randomize_questions, randomize_options, result_visibility, created_by)
  values (v_ea, 'TASK-RSI admin exam', 'open', 60, 70, 'manual', 'RSIADM', 'manual', false, false,
          'score_and_review', v_admin);
  insert into public.exam_questions (exam_id, question_id, position, weight) values
    (v_ea, v_q_mc, 1, 2), (v_ea, v_q_sa, 2, 1), (v_ea, v_q_es, 3, 3);

  -- one submitted attempt per exam, each with an ungraded essay (a pending result)
  v_res := public.exam_join(jsonb_build_object('code', 'RSITEA', 'name', 'Results A', 'class', 'XII RSI T'));
  v_st := (v_res->'session'->>'id')::uuid;
  perform public.save_session_answers(v_st, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct)),
    jsonb_build_object('question_id', v_q_sa, 'answer', jsonb_build_object('text', 'went')),
    jsonb_build_object('question_id', v_q_es, 'answer', jsonb_build_object('text', 'It tells who and where.'))));
  perform public.submit_exam_session(v_st, 'student');

  v_res := public.exam_join(jsonb_build_object('code', 'RSIADM', 'name', 'Results B', 'class', 'XII RSI A'));
  v_sa := (v_res->'session'->>'id')::uuid;
  perform public.save_session_answers(v_sa, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct)),
    jsonb_build_object('question_id', v_q_sa, 'answer', jsonb_build_object('text', 'went')),
    jsonb_build_object('question_id', v_q_es, 'answer', jsonb_build_object('text', 'Because it orients.'))));
  perform public.submit_exam_session(v_sa, 'student');

  -- one suspicious event per exam (the bell's "exams worth a look" card)
  insert into public.session_events (session_id, event_type, severity, meta)
  values (v_st, 'tab_hidden', 'suspicious', '{"n":1}'), (v_sa, 'tab_hidden', 'suspicious', '{"n":1}');

  -- ---------- the hubs and the badge are scoped ----------
  v_out := public.list_exam_activity(false, v_teacher);
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(v_out) x where x->>'exam_id' = v_et::text) = 1
    and not exists (select 1 from jsonb_array_elements(v_out) x where x->>'exam_id' = v_ea::text),
    'a teacher''s hub lists only their own exam');
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public.list_exam_activity(false, v_admin))) = 2,
    'the admin''s hub lists the whole school (both exams)');
  perform pg_temp.assert_true(public.list_exam_activity(false, null) = '[]'::jsonb,
    'a null actor''s hub is empty (fails closed)');

  perform pg_temp.assert_true(public.count_pending_grading(v_teacher) = 1,
    'the badge counts only the teacher''s own waiting essays');
  perform pg_temp.assert_true(public.count_pending_grading(v_admin) = 2,
    'the admin''s badge counts the whole school');
  perform pg_temp.assert_true(public.count_pending_grading(null) = 0,
    'a null actor''s badge counts nothing (fails closed)');

  -- ---------- reading a foreign exam/session is reading a missing one ----------
  perform pg_temp.expect_error(format('select public.list_exam_results(%L::uuid, %L::uuid)', v_ea, v_teacher),
    'That exam was not found.', 'a teacher cannot read the admin exam''s results');
  perform pg_temp.expect_error(format('select public.list_exam_results(%L::uuid, null::uuid)', v_et),
    'That exam was not found.', 'a null actor cannot read an exam''s results');
  perform pg_temp.assert_true(public.list_exam_results(v_et, v_teacher) is not null,
    'a teacher reads their own exam''s results');
  perform pg_temp.assert_true(public.list_exam_results(v_et, v_admin) is not null,
    'the admin reads the teacher exam''s results too');

  perform pg_temp.expect_error(format('select public.get_session_report(%L::uuid, %L::uuid)', v_sa, v_teacher),
    'That test session was not found.', 'a teacher cannot read the admin exam''s session report');
  perform pg_temp.expect_error(format('select public.get_session_report(%L::uuid, null::uuid)', v_st),
    'That test session was not found.', 'a null actor cannot read a session report');
  perform pg_temp.assert_true(public.get_session_report(v_st, v_teacher) is not null,
    'a teacher reads their own session report');

  perform pg_temp.expect_error(format('select public.list_grading_questions(%L::uuid, %L::uuid)', v_ea, v_teacher),
    'That exam was not found.', 'a teacher cannot list the admin exam''s grading questions');
  perform pg_temp.expect_error(format('select public.get_grading_queue(%L::uuid, %L::uuid, %L::uuid)', v_ea, v_q_es, v_teacher),
    'That exam was not found.', 'a teacher cannot read the admin exam''s grading queue');
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public.list_grading_questions(v_et, v_teacher))) = 1,
    'a teacher grades their own exam''s essay questions');

  -- ---------- writing a foreign id is the missing-row sentence ----------
  perform pg_temp.expect_error(format(
    'select public.save_answer_grade(%L::uuid, %L::uuid, 1, null, %L::uuid)', v_sa, v_q_mc, v_teacher),
    'That test session was not found.', 'a teacher cannot grade the admin exam''s session');
  perform pg_temp.expect_error(format(
    'select public.add_session_time(%L::uuid, 300, %L::uuid)', v_sa, v_teacher),
    'That test session was not found.', 'a teacher cannot add time to the admin exam''s session');
  perform pg_temp.expect_error(format(
    'select public.reopen_session(%L::uuid, 300, %L::uuid)', v_sa, v_teacher),
    'That test session was not found.', 'a teacher cannot reopen the admin exam''s session');
  perform pg_temp.expect_error(format(
    'select public.grant_retake(%L::uuid, %L::uuid)', v_sa, v_teacher),
    'That test session was not found.', 'a teacher cannot grant a retake on the admin exam''s session');
  perform pg_temp.expect_error(format(
    'select public.revoke_retake(%L::uuid, %L::uuid)', v_sa, v_teacher),
    'That test session was not found.', 'a teacher cannot revoke a retake on the admin exam''s session');
  perform pg_temp.expect_error(format(
    'select public.add_exam_time(%L::uuid, 300, %L::uuid)', v_ea, v_teacher),
    'That exam was not found.', 'a teacher cannot give the admin exam''s class more time');
  perform pg_temp.expect_error(format(
    'select public.save_answer_grade(%L::uuid, %L::uuid, 1, null, null::uuid)', v_st, v_q_mc),
    'That test session was not found.', 'a null actor cannot grade anything');

  -- ---------- the admin bypass is the whole school ----------
  v_res := public.save_answer_grade(v_st, v_q_mc, 2, 'Checked by the admin', v_admin);
  perform pg_temp.assert_true((v_res->>'saved') = 'true', 'the admin grades the teacher exam''s session');
  perform pg_temp.assert_true(public.get_session_report(v_st, v_admin) is not null,
    'the admin reads the teacher exam''s report');

  -- ---------- the bell follows the exam's owner ----------
  v_out := public._essay_notifications(v_teacher);
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(v_out) x where x->>'exam_id' = v_et::text) = 1
    and not exists (select 1 from jsonb_array_elements(v_out) x where x->>'exam_id' = v_ea::text),
    'a teacher''s bell counts only their own exam''s essays');
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public._essay_notifications(v_admin))) = 2,
    'the admin''s bell counts the whole school');
  perform pg_temp.assert_true(public._essay_notifications(null) = '[]'::jsonb,
    'a null actor''s bell counts nothing (fails closed)');

  v_out := public._suspicious_notifications(14, v_teacher);
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(v_out) x where x->>'exam_id' = v_et::text) = 1
    and not exists (select 1 from jsonb_array_elements(v_out) x where x->>'exam_id' = v_ea::text),
    'a teacher''s bell shows only their own suspicious exams');
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public._suspicious_notifications(14, v_admin))) = 2,
    'the admin''s bell shows the whole school');
  perform pg_temp.assert_true(public._suspicious_notifications(14, null) = '[]'::jsonb,
    'a null actor''s bell shows nothing (fails closed)');

  raise exception 'RESULTS ISOLATION TESTS PASSED (a teacher sees and changes only their own exams'' results, reports, monitor data and bell cards; a foreign id is the missing-row sentence; the admin sees the whole school; all rolled back)';
end
$rsi_isolation$;
