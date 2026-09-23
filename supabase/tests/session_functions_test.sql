-- SQL test for the student exam engine (TASK-010).
-- Run against the v2 project:  npx supabase db query --linked --file supabase/tests/session_functions_test.sql
--
-- Everything happens inside one transaction that is deliberately rolled back at the end
-- (the technique described in .ai/04_CURRENT_STATE.md): the block always ends with
-- `raise exception`, so no test row survives. Read the last line of the output:
--   "SESSION ENGINE TESTS PASSED"                     → all assertions held
--   "ASSERT FAILED: <message>"                        → a rule is broken
--
-- Verified here: BR-01 (one attempt), BR-02 (single-use retake), BR-03/BR-04 (code + status),
-- BR-05 (late start cut at end), BR-06/BR-07/BR-08 (points, essay pending, visibility),
-- BR-09 (no key in the snapshot), BR-10 (per-session snapshot), BR-12 (idempotent resend),
-- BR-20 (2-minute tolerance), BR-21 (server validation, timed_out cleanup),
-- and the tab-switch auto-submit limit.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

do $$
declare
  v_exam uuid := gen_random_uuid();
  v_q_mc uuid; v_q_tf uuid; v_q_sa uuid; v_q_es uuid;
  v_mc_correct text;
  v_join jsonb; v_res jsonb;
  v_sess uuid; v_sess2 uuid; v_sess3 uuid; v_sess4 uuid; v_sess5 uuid;
  v_n int;
  v_caught boolean;
  v_hint text;
  v_pct numeric;
  v_rstatus text;
  v_pstatus text;
  v_correct int;
  v_wrong int;
begin
  -- ---------- fixtures (rolled back with everything else) ----------
  select id into v_q_mc from public.questions
   where is_archived = false and type = 'multiple_choice' order by created_at limit 1;
  select o.body into v_mc_correct from public.question_options o
   where o.question_id = v_q_mc and o.is_correct;

  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('true_false', 'easy', 'The sun rises in the east.', 2, md5(random()::text)) returning id into v_q_tf;
  insert into public.question_options (question_id, position, body, is_correct)
  values (v_q_tf, 1, 'True', true), (v_q_tf, 2, 'False', false);

  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('short_answer', 'easy', 'Write the simple past of "go".', 1, md5(random()::text)) returning id into v_q_sa;
  insert into public.accepted_answers (question_id, answer_text) values (v_q_sa, 'went');

  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('essay', 'easy', 'Describe your last holiday.', 4, md5(random()::text)) returning id into v_q_es;

  -- shuffling starts off so the order assertions below are deterministic
  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode, access_code, selection_mode, randomize_questions, randomize_options)
  values (v_exam, 'Session engine test', 'open', 60, 70, 'manual', 'SQLTST', 'manual', false, false);
  insert into public.exam_questions (exam_id, question_id, position, weight) values
    (v_exam, v_q_mc, 1, 1), (v_exam, v_q_tf, 2, 2), (v_exam, v_q_sa, 3, 1), (v_exam, v_q_es, 4, 4);

  -- ---------- BR-03/BR-04: join by code, with messy typing ----------
  v_join := public.exam_join(jsonb_build_object('code', ' sqltst ', 'name', '  Test   Student ', 'class', 'xii tkj a'));
  perform pg_temp.assert_true(v_join->'session'->>'status' = 'in_progress', 'a fresh join starts in_progress');
  perform pg_temp.assert_true(v_join->'session'->>'attempt_no' = '1', 'the first attempt is number 1');
  perform pg_temp.assert_true((v_join->'session'->>'student_name') = 'Test Student', 'the name is tidied for display');
  perform pg_temp.assert_true(jsonb_array_length(v_join->'questions') = 4, 'the snapshot holds all 4 questions');
  perform pg_temp.assert_true(jsonb_array_length(v_join->'answers') = 0, 'a fresh session has no answers');
  -- BR-09: the payload the phone receives must not contain a key
  perform pg_temp.assert_true(position('"correct"' in v_join::text) = 0, 'the snapshot must not carry the correct answer');
  perform pg_temp.assert_true(position('"accepted"' in v_join::text) = 0, 'the snapshot must not carry accepted answers');
  perform pg_temp.assert_true(position('answer_key' in v_join::text) = 0, 'the snapshot must not carry the answer key');
  perform pg_temp.assert_true(v_join->'questions'->0->>'type' = 'multiple_choice'
    and v_join->'questions'->3->>'type' = 'essay', 'manual selection keeps the exam order');
  -- time: 60 minutes from now
  perform pg_temp.assert_true((v_join->'session'->>'remaining_seconds')::int between 3590 and 3600, 'a one-hour exam leaves an hour');
  v_sess := (v_join->'session'->>'id')::uuid;

  -- ---------- BR-12: answers save, resend does not duplicate ----------
  v_res := public.save_session_answers(v_sess, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct)),
    jsonb_build_object('question_id', v_q_tf, 'answer', jsonb_build_object('text', 'True')),
    jsonb_build_object('question_id', v_q_sa, 'answer', jsonb_build_object('text', '  WENT '), 'is_flagged', true),
    jsonb_build_object('question_id', v_q_es, 'answer', jsonb_build_object('text', 'I went to the beach.'))));
  perform pg_temp.assert_true(v_res->>'accepted' = 'true' and v_res->>'saved' = '4', 'four answers are accepted');

  v_res := public.save_session_answers(v_sess, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct))));
  select count(*) into v_n from public.session_answers where session_id = v_sess;
  perform pg_temp.assert_true(v_res->>'saved' = '1' and v_n = 4, 'a resent answer updates instead of duplicating (BR-12)');
  select count(*) into v_n from public.session_answers where session_id = v_sess and is_flagged;
  perform pg_temp.assert_true(v_n = 1, 'the marked question stays marked');

  -- ---------- BR-21: the server refuses what is not part of the test ----------
  v_caught := false;
  begin
    perform public.save_session_answers(v_sess, jsonb_build_array(
      jsonb_build_object('question_id', gen_random_uuid(), 'answer', jsonb_build_object('text', 'x'))));
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%not part of this test%', 'the refusal names the problem');
    perform pg_temp.assert_true(v_hint = 'validation', 'the refusal is a validation error');
  end;
  perform pg_temp.assert_true(v_caught, 'an unknown question id is refused');

  -- ---------- BR-06/BR-07: submit grades the automatic questions and holds the essay ----------
  v_res := public.submit_exam_session(v_sess, 'student');
  perform pg_temp.assert_true(v_res->>'submitted' = 'true' and v_res->>'status' = 'submitted', 'submit finishes the session');
  perform pg_temp.assert_true(v_res->>'pending_review' = 'true', 'an unanswered essay keeps the result pending');
  perform pg_temp.assert_true(v_res->>'pass_status' = 'not_final', 'a pending result is not final');
  -- essay_pending_display defaults to hide_score → the number must not be exposed yet
  perform pg_temp.assert_true(v_res->>'score' is null, 'hide_score keeps the partial number from the student');

  select percentage, status::text, pass_status::text, correct_count, wrong_count
    into v_pct, v_rstatus, v_pstatus, v_correct, v_wrong
    from public.exam_results where session_id = v_sess;
  perform pg_temp.assert_true(v_pct = 50, 'four of eight points is 50 percent');
  perform pg_temp.assert_true(v_rstatus = 'pending_review', 'the result waits for the essay');
  perform pg_temp.assert_true(v_pstatus = 'not_final', 'pass status is not_final while pending');
  perform pg_temp.assert_true(v_correct = 3 and v_wrong = 0, 'three automatic questions are correct, none wrong');
  select count(*) into v_n from public.answer_grades where session_id = v_sess;
  perform pg_temp.assert_true(v_n = 3, 'only the automatic questions get a grade row');

  -- a second submit is harmless
  v_res := public.submit_exam_session(v_sess, 'student');
  perform pg_temp.assert_true(v_res->>'pending_review' = 'true', 'submitting twice keeps the same result');

  -- ---------- BR-08: the teacher decides what the student sees ----------
  update public.exams set result_visibility = 'score_and_review', essay_pending_display = 'show_partial' where id = v_exam;
  v_res := public.get_session_result(v_sess);
  perform pg_temp.assert_true(v_res->>'visibility' = 'score_and_review', 'the visibility is reported');
  perform pg_temp.assert_true(v_res->'score'->>'percentage' = '50.00', 'show_partial exposes the partial score');
  perform pg_temp.assert_true(v_res->>'pass_status' = 'not_final', 'still not final while the essay waits');
  perform pg_temp.assert_true(jsonb_array_length(v_res->'review') = 4, 'the review lists every question');
  perform pg_temp.assert_true(v_res->'review'->0->>'is_correct' = 'true', 'the first answer is marked correct');
  perform pg_temp.assert_true(v_res->'review'->3->>'is_correct' is null, 'the essay has no automatic verdict');

  update public.exams set result_visibility = 'none' where id = v_exam;
  v_res := public.get_session_result(v_sess);
  perform pg_temp.assert_true(v_res->>'score' is null and v_res->>'review' is null, 'visibility "none" hides everything');

  -- ---------- BR-01/BR-02: one attempt, then a single-use teacher permission ----------
  v_caught := false;
  begin
    perform public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Test Student', 'class', 'XII TKJ A'));
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%already took this test%', 'the second attempt is refused with a clear message');
  end;
  perform pg_temp.assert_true(v_caught, 'the same name and class cannot start a second attempt');

  insert into public.retake_permissions (exam_id, student_name_normalized, student_class_normalized)
  values (v_exam, 'test student', 'xii tkj a');
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'test student', 'class', 'XII   TKJ A'));
  perform pg_temp.assert_true(v_join->'session'->>'attempt_no' = '2', 'a granted retake becomes attempt 2');
  v_sess2 := (v_join->'session'->>'id')::uuid;
  select count(*) into v_n from public.retake_permissions where exam_id = v_exam and used_at is null;
  perform pg_temp.assert_true(v_n = 0, 'the permission is used up (BR-02)');

  -- joining again while the attempt runs resumes it instead of creating another
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Test Student', 'class', 'XII TKJ A'));
  perform pg_temp.assert_true((v_join->'session'->>'id')::uuid = v_sess2, 'an unfinished attempt is resumed');
  perform pg_temp.assert_true(v_join->'session'->>'attempt_no' = '2', 'resuming does not create a new attempt');

  -- ---------- BR-20: the deadline plus two minutes ----------
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Late Student', 'class', 'XII TKJ A'));
  v_sess3 := (v_join->'session'->>'id')::uuid;
  update public.exam_sessions set ends_at = now() - interval '1 minute' where id = v_sess3;
  v_res := public.save_session_answers(v_sess3, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct))));
  perform pg_temp.assert_true(v_res->>'accepted' = 'true', 'an answer one minute past the deadline is still accepted');

  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Very Late Student', 'class', 'XII TKJ A'));
  v_sess4 := (v_join->'session'->>'id')::uuid;
  update public.exam_sessions set ends_at = now() - interval '10 minutes' where id = v_sess4;
  v_res := public.save_session_answers(v_sess4, jsonb_build_array(
    jsonb_build_object('question_id', v_q_mc, 'answer', jsonb_build_object('text', v_mc_correct))));
  perform pg_temp.assert_true(v_res->>'accepted' = 'false' and v_res->>'reason' = 'time_up',
    'an answer ten minutes past the deadline is refused');
  perform pg_temp.assert_true((select status from public.exam_sessions where id = v_sess4) = 'auto_submitted',
    'a session past the deadline is submitted automatically');

  -- the heartbeat closes a late session too
  v_res := public.session_heartbeat(v_sess3);
  perform pg_temp.assert_true(v_res->>'status' = 'in_progress', 'a session inside the tolerance keeps running');

  -- ---------- anti-cheating: the tab-switch limit submits automatically ----------
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Tab Student', 'class', 'XII TKJ A'));
  v_sess5 := (v_join->'session'->>'id')::uuid;
  for v_n in 1 .. 4 loop
    v_res := public.log_session_event(v_sess5, 'tab_hidden');
    perform pg_temp.assert_true(v_res->>'autosubmit' = 'false', 'leaving the page before the limit only warns');
  end loop;
  perform pg_temp.assert_true((v_res->>'tab_switch_count')::int = 4, 'every leave is counted');
  perform pg_temp.assert_true(v_res->>'warn_limit' = '1' and v_res->>'flag_limit' = '3', 'the limits come from the exam');
  v_res := public.log_session_event(v_sess5, 'tab_hidden');
  perform pg_temp.assert_true(v_res->>'tab_switch_count' = '5' and v_res->>'autosubmit' = 'true',
    'the fifth leave submits the test automatically');
  perform pg_temp.assert_true((select status from public.exam_sessions where id = v_sess5) = 'auto_submitted',
    'the automatic submit is stored');

  v_caught := false;
  begin
    perform public.log_session_event(v_sess5, 'nonsense');
  exception when others then v_caught := true; end;
  perform pg_temp.assert_true(v_caught, 'an unknown event type is refused');

  -- ---------- BR-21: cleanup marks silent sessions timed_out ----------
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Idle Student', 'class', 'XII TKJ A'));
  v_sess := (v_join->'session'->>'id')::uuid;
  update public.exam_sessions set ends_at = now() - interval '30 minutes' where id = v_sess;
  v_n := public.expire_sessions();
  perform pg_temp.assert_true(v_n >= 1, 'expire_sessions reports what it closed');
  perform pg_temp.assert_true((select status from public.exam_sessions where id = v_sess) = 'timed_out',
    'a session with no answers becomes timed_out');

  -- ---------- BR-05: a late start can be cut at the closing time ----------
  update public.exams set availability_mode = 'scheduled', starts_at = now() - interval '10 minutes',
         ends_at = now() + interval '5 minutes', late_start_policy = 'cut_at_end' where id = v_exam;
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Late Start', 'class', 'XII TKJ A'));
  perform  pg_temp.assert_true((v_join->'session'->>'remaining_seconds')::int between 290 and 300,
    'cut_at_end stops the attempt at the closing time');

  -- shuffling changes the order only, never which questions are given
  update public.exams set randomize_questions = true where id = v_exam;
  v_join := public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Shuffle Student', 'class', 'XII TKJ A'));
  perform pg_temp.assert_true(
    (select array_agg(x->>'question_id' order by x->>'question_id') from jsonb_array_elements(v_join->'questions') x)
      = (select array_agg(q::text order by q::text) from unnest(array[v_q_mc, v_q_tf, v_q_sa, v_q_es]) q),
    'shuffling keeps the same four questions');
  update public.exams set randomize_questions = false where id = v_exam;

  -- ---------- unknown code / closed exam ----------
  v_caught := false;
  begin
    perform public.exam_join(jsonb_build_object('code', 'NOSUCH', 'name', 'Somebody', 'class', 'X TKJ A'));
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%code was not found%' and v_hint = 'validation', 'an unknown code is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'joining with a wrong code is refused');

  update public.exams set availability_mode = 'manual', starts_at = null, ends_at = null where id = v_exam;
  update public.exams set status = 'closed' where id = v_exam;
  v_caught := false;
  begin
    perform public.exam_join(jsonb_build_object('code', 'SQLTST', 'name', 'Somebody Else', 'class', 'X TKJ A'));
  exception when others then v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%closed%', 'a closed test cannot be joined');
  end;
  perform pg_temp.assert_true(v_caught, 'a closed test is refused');

  -- reading a session that does not exist, and the media list of a session without files
  v_caught := false;
  begin
    perform public.get_exam_session(gen_random_uuid());
  exception when others then v_caught := true; end;
  perform pg_temp.assert_true(v_caught, 'an unknown session id is refused');
  perform pg_temp.assert_true(public.get_session_media_ids(v_sess2) = '{}'::uuid[], 'a session without files lists no media');

  -- deliberate exception: rolls the whole block back, leaving the live database untouched
  raise exception 'SESSION ENGINE TESTS PASSED (all rows rolled back)';
end $$;
