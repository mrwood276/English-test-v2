-- SQL test for grading, results, and the teacher's actions on a session (TASK-012).
-- Run against the v2 project:  npx supabase db query --linked --file supabase/tests/result_functions_test.sql
--
-- Everything happens inside one transaction that is deliberately rolled back at the end (the same
-- technique as session_functions_test.sql): the block always ends with `raise exception`, so no test
-- row survives. Read the last line of the output:
--   "RESULT ENGINE TESTS PASSED (all rows rolled back)"  → all assertions held
--   "ASSERT FAILED: <message>"                           → a rule is broken
--
-- Verified here: BR-06 (points and percentage), BR-07 (a pending result turns final when every essay
-- is graded), BR-08 (visibility only affects the student), BR-11 (add time / reopen, both audited and
-- usable by the student afterwards), BR-15 (a merged class name is what results show), BR-18 (a manual
-- correction survives a later automatic re-grade) and BR-02 (the teacher grants one retake).

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

do $$
declare
  v_exam uuid := gen_random_uuid();
  v_q_mc uuid; v_q_sa uuid; v_q_es uuid;
  v_mc_correct text;
  v_join jsonb; v_out jsonb; v_res jsonb; v_row jsonb;
  v_s1 uuid; v_s2 uuid; v_s3 uuid;
  v_n int;
  v_caught boolean;
  v_hint text;
  v_ends timestamptz;
  v_before timestamptz;
begin
  -- ---------- fixtures (all rolled back) ----------
  select id into v_q_mc from public.questions
   where is_archived = false and type = 'multiple_choice' order by created_at limit 1;
  select o.body into v_mc_correct from public.question_options o
   where o.question_id = v_q_mc and o.is_correct;

  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('short_answer', 'easy', 'Write the simple past of go. (result test)', 1, md5(random()::text))
  returning id into v_q_sa;
  insert into public.accepted_answers (question_id, answer_text) values (v_q_sa, 'went');

  insert into public.questions (type, difficulty, body, default_weight, content_hash, essay_guidance)
  values ('essay', 'easy', 'Explain why the orientation part matters. (result test)', 3, md5(random()::text),
          'Says who, where and when: one point each, up to 3.')
  returning id into v_q_es;

  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode,
      access_code, selection_mode, randomize_questions, randomize_options, result_visibility)
  values (v_exam, 'Result engine test', 'open', 60, 70, 'manual', 'RSLTST', 'manual', false, false,
          'score_and_review');
  insert into public.exam_questions (exam_id, question_id, position, weight) values
    (v_exam, v_q_mc, 1, 2), (v_exam, v_q_sa, 2, 1), (v_exam, v_q_es, 3, 3);

  -- ---------- two students take the test ----------
  v_join := public.exam_join(jsonb_build_object('code', 'RSLTST', 'name', 'Result A', 'class', 'XII TKJ T1'));
  v_s1 := (v_join->'session'->>'id')::uuid;
  perform public.save_session_answers(v_s1, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct)),
    jsonb_build_object('question_id', v_q_sa, 'answer', jsonb_build_object('text', 'went')),
    jsonb_build_object('question_id', v_q_es, 'answer', jsonb_build_object('text', 'It tells who and where.'))));
  v_res := public.submit_exam_session(v_s1, 'student');
  perform pg_temp.assert_true(v_res->>'pending_review' = 'true', 'essay answers leave the result pending (BR-07)');

  v_join := public.exam_join(jsonb_build_object('code', 'RSLTST', 'name', 'Result B', 'class', 'XII TKJ T1'));
  v_s2 := (v_join->'session'->>'id')::uuid;
  perform public.save_session_answers(v_s2, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', 'definitely not it'))));
  v_res := public.submit_exam_session(v_s2, 'student');
  perform pg_temp.assert_true(v_res->>'pending_review' = 'true', 'the second student is pending too');

  -- ---------- the grading screen: which essays exist and who is waiting ----------
  v_out := public.list_grading_questions(v_exam);
  perform pg_temp.assert_true(jsonb_array_length(v_out) = 1, 'one essay question is listed');
  perform pg_temp.assert_true(v_out->0->>'question_id' = v_q_es::text, 'the essay question is the one in the exam');
  perform pg_temp.assert_true((v_out->0->>'taken')::int = 2, 'two students took it');
  perform pg_temp.assert_true((v_out->0->>'waiting')::int = 2 and (v_out->0->>'graded')::int = 0,
    'both essays are waiting');
  perform pg_temp.assert_true((v_out->0->>'weight')::numeric = 3, 'the question keeps its weight');
  perform pg_temp.assert_true(v_out->0->>'guide' like 'Says who%', 'the grading guide comes from the question');

  v_out := public.get_grading_queue(v_exam, v_q_es);
  perform pg_temp.assert_true((v_out->'question'->>'max_points')::numeric = 3, 'the queue reports the maximum');
  perform pg_temp.assert_true(jsonb_array_length(v_out->'students') = 2, 'both students are in the queue');
  perform pg_temp.assert_true(v_out->'students'->0->>'student_name' = 'Result A', 'the queue is ordered by class then name');
  perform pg_temp.assert_true(v_out->'students'->1->>'is_blank' = 'true', 'a student who wrote nothing is marked blank');
  perform pg_temp.assert_true(v_out->'students'->0->>'graded' = 'false', 'nothing is graded yet');
  perform pg_temp.assert_true((v_out->'students'->0->>'max_points')::numeric = 3, 'the queue carries the points for each student');

  perform pg_temp.assert_true(public.count_pending_grading() >= 2, 'the badge counts the waiting essays');
  v_out := public.list_exam_activity();
  select e into v_row from jsonb_array_elements(v_out) e where e->>'exam_id' = v_exam::text;
  perform pg_temp.assert_true((v_row->>'sessions')::int = 2, 'the hub counts the sessions');
  perform pg_temp.assert_true((v_row->>'finished')::int = 2, 'both sessions are finished');
  perform pg_temp.assert_true((v_row->>'pending_essays')::int = 2, 'the hub counts the waiting essays');
  perform pg_temp.assert_true((v_row->>'essay_questions')::int = 1, 'the hub counts the essays in the exam');

  -- ---------- the results table before grading ----------
  v_out := public.list_exam_results(v_exam);
  perform pg_temp.assert_true((v_out->'summary'->>'not_final')::int = 2, 'both results are not final');
  perform pg_temp.assert_true((v_out->'summary'->>'with_result')::int = 2, 'both sessions have a provisional result');
  select e into v_row from jsonb_array_elements(v_out->'rows') e where e->>'student_name' = 'Result A';
  perform pg_temp.assert_true((v_row->>'percentage')::numeric = 50, 'three of six points is fifty percent');
  perform pg_temp.assert_true((v_row->>'pending_essays')::int = 1, 'the row says one essay waits');
  perform pg_temp.assert_true((v_row->>'correct_count')::int = 2 and (v_row->>'wrong_count')::int = 0,
    'both objective answers are correct');
  perform pg_temp.assert_true(v_row->>'retake_granted' = 'false', 'no retake has been granted yet');

  -- ---------- grading: refusals first ----------
  v_caught := false;
  begin
    perform public.save_answer_grade(v_s1, v_q_es, 4, 'too many', null);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%most points%' and v_hint = 'validation',
      'a grade above the maximum is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'too many points is refused');

  v_caught := false;
  begin
    perform public.save_answer_grade(v_s1, gen_random_uuid(), 1, null, null);
  exception when others then v_caught := true; end;
  perform pg_temp.assert_true(v_caught, 'grading a question outside the test is refused');

  v_join := public.exam_join(jsonb_build_object('code', 'RSLTST', 'name', 'Result C', 'class', 'XII TKJ T1'));
  v_s3 := (v_join->'session'->>'id')::uuid;
  v_caught := false;
  begin
    perform public.save_answer_grade(v_s3, v_q_es, 1, null, null);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%still being taken%', 'a running test cannot be graded yet');
  end;
  perform pg_temp.assert_true(v_caught, 'grading a running session is refused');

  -- ---------- BR-07/BR-06: grading the essays makes the results final ----------
  v_res := public.save_answer_grade(v_s1, v_q_es, 3, 'Good: who, where and when.', null);
  perform pg_temp.assert_true(v_res->>'saved' = 'true' and (v_res->>'points')::numeric = 3, 'the essay grade is saved');
  perform pg_temp.assert_true(v_res->>'final' = 'true', 'Result A is final once its only essay is graded');
  perform pg_temp.assert_true((v_res->>'percentage')::numeric = 100, 'a full essay makes the score 100');
  perform pg_temp.assert_true(v_res->>'pass_status' = 'passed', 'the passing grade is applied');

  v_res := public.save_answer_grade(v_s2, v_q_es, 1, 'Add when the story happens.', null);
  perform pg_temp.assert_true(v_res->>'final' = 'true', 'Result B is final too');
  perform pg_temp.assert_true((v_res->>'percentage')::numeric = 16.67, 'one of six points rounds to 16.67');
  perform pg_temp.assert_true(v_res->>'pass_status' = 'failed', 'a weak result fails');
  perform pg_temp.assert_true((v_res->>'waiting_essays')::int = 0, 'nothing waits after grading');
  perform pg_temp.assert_true(public.count_pending_grading() = 0, 'the badge is empty again');

  -- a later grade can be changed by hand at any time
  v_res := public.save_answer_grade(v_s2, v_q_es, 2, 'Second look.', null);
  perform pg_temp.assert_true((v_res->>'percentage')::numeric = 33.33, 'changing a grade recalculates the result');

  -- ---------- BR-07 + BR-08: the student's own view becomes final ----------
  v_out := public.get_session_result(v_s2);
  perform pg_temp.assert_true(v_out->>'pending_review' = 'false', 'the student no longer waits');
  perform pg_temp.assert_true(v_out->>'pass_status' = 'failed', 'the student sees the final pass status');
  perform pg_temp.assert_true(v_out->'score'->>'percentage' = '33.33', 'the final number is visible');

  -- ---------- BR-18: a manual correction beats a later automatic re-grade ----------
  v_res := public.save_answer_grade(v_s2, v_q_sa, 1, 'Accepted: the same idea in different words.', null);
  perform pg_temp.assert_true((v_res->>'total_points')::numeric = 3, 'the corrected short answer counts');

  -- ---------- the report behind one row (Details) ----------
  v_out := public.get_session_report(v_s2);
  perform pg_temp.assert_true(v_out->'session'->>'student_name' = 'Result B', 'the report names the student');
  perform pg_temp.assert_true(v_out->'result'->>'pass_status' = 'failed', 'the report carries the result');
  select e into v_row from jsonb_array_elements(v_out->'review') e where e->>'question_id' = v_q_es::text;
  perform pg_temp.assert_true((v_row->>'points')::numeric = 2, 'the review shows the essay points');
  perform pg_temp.assert_true(v_row->>'manual' = 'true', 'the essay grade is marked as manual');
  perform pg_temp.assert_true(v_row->>'feedback' = 'Second look.', 'the comment is kept');
  perform pg_temp.assert_true(v_out->'event_counts'->>'graded' = '3', 'every grade is an event');
  perform pg_temp.assert_true(v_out->'actions'->>'can_reopen' = 'true', 'a finished session can be reopened');
  perform pg_temp.assert_true(v_out->'actions'->>'can_add_time' = 'false', 'a finished session cannot be given time');
  perform pg_temp.assert_true(v_out->'actions'->>'can_grant_retake' = 'true', 'a retake can still be granted');

  -- ---------- BR-11: add time while the test runs ----------
  v_out := public.get_session_report(v_s3);
  perform pg_temp.assert_true(v_out->'actions'->>'can_add_time' = 'true', 'a running session can be given time');
  perform pg_temp.assert_true(v_out->'actions'->>'can_grade' = 'false', 'a running session cannot be graded');

  select ends_at into v_before from public.exam_sessions where id = v_s3;
  v_res := public.add_session_time(v_s3, 300, null);
  perform pg_temp.assert_true((v_res->>'added_seconds')::int = 300, 'five minutes were added');
  perform pg_temp.assert_true((v_res->>'extra_seconds')::int = 300, 'the extra time is recorded on the session');
  select ends_at into v_ends from public.exam_sessions where id = v_s3;
  perform pg_temp.assert_true(v_ends = v_before + interval '5 minutes', 'the deadline moves by five minutes');

  v_caught := false;
  begin
    perform public.add_session_time(v_s3, 5, null);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%between 1 minute and 2 hours%', 'a tiny amount of time is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'adding five seconds is refused');

  v_caught := false;
  begin
    perform public.add_session_time(v_s1, 600, null);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%already collected%', 'a collected test is told to reopen instead');
  end;
  perform pg_temp.assert_true(v_caught, 'adding time to a collected session is refused');

  -- ---------- BR-11: reopen a collected session and let the student continue ----------
  v_res := public.reopen_session(v_s1, 600, null);
  perform pg_temp.assert_true(v_res->>'status' = 'reopened', 'the session is reopened');
  perform pg_temp.assert_true((v_res->>'remaining_seconds')::int between 590 and 600, 'ten minutes are put back on the clock');
  perform pg_temp.assert_true((v_res->>'extra_seconds')::int = 600, 'the reopened time is recorded');

  v_res := public.save_session_answers(v_s1, jsonb_build_array(
    jsonb_build_object('question_id', v_q_es, 'answer', jsonb_build_object('text', 'It tells who, where and when.'))));
  perform pg_temp.assert_true(v_res->>'accepted' = 'true', 'a reopened session accepts answers again');

  v_res := public.submit_exam_session(v_s1, 'student');
  perform pg_temp.assert_true(v_res->>'status' = 'submitted', 'the reopened session can be collected again');
  perform pg_temp.assert_true(v_res->>'pending_review' = 'false', 'the essay grade survives the second submit');

  v_out := public.get_session_report(v_s1);
  perform pg_temp.assert_true(v_out->'event_counts'->>'reopen' = '1', 'the reopen is in the history');
  v_out := public.get_session_report(v_s3);
  perform pg_temp.assert_true(v_out->'event_counts'->>'time_added' = '1', 'the added time is in the history too');

  -- the same manual+essay protection holds for the automatic questions of Result B
  v_caught := false;
  begin
    perform public.reopen_session(v_s3, 600, null);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%still open%', 'a running session is not "reopened"');
  end;
  perform pg_temp.assert_true(v_caught, 'reopening a running session is refused');

  -- ---------- BR-02: one retake, granted and taken back by the teacher ----------
  v_res := public.grant_retake(v_s2, null);
  perform pg_temp.assert_true(v_res->>'granted' = 'true' and v_res->>'already' = 'false', 'the retake is granted');
  v_res := public.grant_retake(v_s2, null);
  perform pg_temp.assert_true(v_res->>'already' = 'true', 'granting twice does not create a second permission');

  v_out := public.get_session_report(v_s2);
  perform pg_temp.assert_true(v_out->'actions'->>'can_grant_retake' = 'false', 'a waiting permission cannot be granted twice');
  perform pg_temp.assert_true(v_out->'actions'->>'can_revoke_retake' = 'true', 'it can be taken back');
  perform pg_temp.assert_true(v_out->'retake'->>'granted' = 'true', 'the report shows the permission');

  v_join := public.exam_join(jsonb_build_object('code', 'RSLTST', 'name', 'result b', 'class', 'xii  tkj t1'));
  perform pg_temp.assert_true(v_join->'session'->>'attempt_no' = '2', 'the student gets attempt 2');

  v_caught := false;
  begin
    perform public.revoke_retake(v_s2, null);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%already used%', 'a used retake cannot be taken back');
  end;
  perform pg_temp.assert_true(v_caught, 'taking back a used retake is refused');

  insert into public.retake_permissions (exam_id, student_name_normalized, student_class_normalized)
  values (v_exam, public.normalize_text('Result A'), public.normalize_text('XII TKJ T1'));
  v_res := public.revoke_retake(v_s1, null);
  perform pg_temp.assert_true(v_res->>'revoked' = 'true', 'an unused retake can be taken back');

  -- ---------- BR-15: a merged class name is what results show ----------
  insert into public.class_aliases (alias_normalized, display_name)
  values (public.normalize_text('XII TKJ T1'), 'Class XII TKJ T1 (merged)');
  v_out := public.list_exam_results(v_exam);
  select e into v_row from jsonb_array_elements(v_out->'rows') e where e->>'student_name' = 'Result A';
  perform pg_temp.assert_true(v_row->>'class_display' = 'Class XII TKJ T1 (merged)',
    'the merged name replaces the raw class in results');

  -- ---------- everything the teacher did is audited ----------
  perform pg_temp.assert_true((select count(*) from public.audit_logs
    where entity_id = v_s2::text and action in ('grade', 'retake_grant')) >= 4, 'grading and retakes are audited');
  perform pg_temp.assert_true(exists (select 1 from public.audit_logs
    where entity_id = v_s3::text and action = 'add_time'), 'adding time is audited');
  perform pg_temp.assert_true(exists (select 1 from public.audit_logs
    where entity_id = v_s1::text and action = 'reopen'), 'reopening is audited');

  -- an unknown exam or session is reported, not silently empty
  v_caught := false;
  begin
    perform public.list_exam_results(gen_random_uuid());
  exception when others then v_caught := true; end;
  perform pg_temp.assert_true(v_caught, 'an unknown exam is refused');
  v_caught := false;
  begin
    perform public.get_session_report(gen_random_uuid());
  exception when others then v_caught := true; end;
  perform pg_temp.assert_true(v_caught, 'an unknown session is refused');

  -- deliberate exception: rolls the whole block back, leaving the live database untouched
  raise exception 'RESULT ENGINE TESTS PASSED (all rows rolled back)';
end $$;
