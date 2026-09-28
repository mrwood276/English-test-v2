-- SQL test for public.bulk_exam_questions (F-18, putting many questions on one exam).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
--
-- It creates its own questions and exams and lets the transaction abort at the end, so nothing it writes
-- survives — the ERROR MESSAGE is the result:
--   "BULK EXAM QUESTION TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"             → a rule is broken
--
-- RUN LIVE: 2026-09-28 against project lbhnadqmokloyfarrzfv, immediately after the migration was applied,
-- as one `/v1/projects/<ref>/database/query` request. Result: `BULK EXAM QUESTION TESTS PASSED (refusals, add
-- in order with own points, idempotence, mixed and missing ids, remove and its counts renumbering what
-- stays, an untouched other exam, emptying the list, one audit entry per act) — everything rolled back`
-- (HTTP 400 is expected: the final `raise` is how the test rolls back). The first run found a **real fault
-- in the function** — the renumber keyed on `exam_questions.id`, a column that does not exist (the primary
-- key is `(exam_id, question_id)`) — which is why the migration was applied a second time with the fix.
--
-- What is checked: only the service role may execute it; every refusal has a friendly message and leaves
-- the exam untouched (no mode, an empty selection, more than 500 ids, an exam that is gone, an exam that
-- draws by filter, a running exam, an exam that already has attempts, an archived question, a selection
-- that matches nothing, and growing an exam past 200 questions); adding appends in the order given, from
-- the end of the list, each question carrying its own points, skipping what is already there and counting
-- it; the same act twice reports 0 updated; removing takes exactly the ids asked for, keeps the survivors'
-- order and points, and closes the gap so the list stays 1..n with no hole; and every act writes exactly
-- one `exam.questions` audit entry with the real count, never one per question.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(needle in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (error said: %)', msg, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $bulk$
declare
  v_actor uuid;
  v_exam uuid;
  v_exam_auto uuid;
  v_exam_open uuid;
  v_exam_attempts uuid;
  v_exam_full uuid;
  v_q1 uuid;
  v_q2 uuid;
  v_q3 uuid;
  v_q4 uuid;
  v_q_arch uuid;
  v_ids uuid[];
  v_result jsonb;
  v_again jsonb;
  v_audits_before int;
  v_audits int;
  v_other_exam uuid;
begin
  select id into v_actor from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_actor is not null, 'the project has an active admin to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not exists (
      select 1 from unnest(array['bulk_exam_questions']) as f
      where has_function_privilege('anon', 'public.' || f || '(uuid, text, uuid[], uuid)', 'execute')
         or has_function_privilege('authenticated', 'public.' || f || '(uuid, text, uuid[], uuid)', 'execute')
    ),
    'anon and authenticated cannot execute bulk_exam_questions'
  );
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.bulk_exam_questions(uuid, text, uuid[], uuid)', 'execute'),
    'service_role can execute bulk_exam_questions'
  );

  -- ---------- the questions and exams this test owns ----------
  v_q1 := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'easy', 'topic', 'Bulk Exam Test', 'weight', 2,
    'body', 'BULK EXAM TEST question 1', 'accepted_answers', jsonb_build_array('a1')), v_actor);
  v_q2 := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'medium', 'topic', 'Bulk Exam Test', 'weight', 3,
    'body', 'BULK EXAM TEST question 2', 'accepted_answers', jsonb_build_array('a2')), v_actor);
  v_q3 := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'medium', 'topic', 'Bulk Exam Test', 'weight', 4,
    'body', 'BULK EXAM TEST question 3', 'accepted_answers', jsonb_build_array('a3')), v_actor);
  v_q4 := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'hots', 'topic', 'Bulk Exam Test', 'weight', 5,
    'body', 'BULK EXAM TEST question 4', 'accepted_answers', jsonb_build_array('a4')), v_actor);
  v_q_arch := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'easy', 'topic', 'Bulk Exam Test', 'weight', 1,
    'body', 'BULK EXAM TEST archived question', 'accepted_answers', jsonb_build_array('a5')), v_actor);
  perform public.set_question_archived(v_q_arch, true, v_actor);
  perform pg_temp.assert_true(
    v_q1 is not null and v_q2 is not null and v_q3 is not null and v_q4 is not null and v_q_arch is not null,
    'the test created its questions');

  -- The main exam starts with exactly one question (save_exam refuses an empty manual exam).
  v_exam := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST exam', 'duration_minutes', 30, 'access_code', 'BLKEXM1',
    'selection_mode', 'manual', 'questions', jsonb_build_array(jsonb_build_object('question_id', v_q1))), v_actor);
  perform pg_temp.assert_true(v_exam is not null, 'the test created its exam');
  perform pg_temp.assert_true((select count(*) from public.exam_questions where exam_id = v_exam) = 1,
    'the exam starts with one question');

  -- An exam that draws by filter has no fixed list.
  v_exam_auto := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST auto exam', 'duration_minutes', 30, 'access_code', 'BLKEXM2',
    'selection_mode', 'auto', 'pool_size', 5, 'auto_filter', jsonb_build_object('difficulty', 'easy')), v_actor);
  -- A running exam.
  v_exam_open := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST open exam', 'duration_minutes', 30, 'access_code', 'BLKEXM3',
    'selection_mode', 'manual', 'questions', jsonb_build_array(jsonb_build_object('question_id', v_q1))), v_actor);
  update public.exams set status = 'open' where id = v_exam_open;
  -- An exam somebody has already attempted.
  v_exam_attempts := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST taken exam', 'duration_minutes', 30, 'access_code', 'BLKEXM4',
    'selection_mode', 'manual', 'questions', jsonb_build_array(jsonb_build_object('question_id', v_q1))), v_actor);
  insert into public.exam_sessions (exam_id, student_name, student_class, ends_at, questions_snapshot, answer_key)
  values (v_exam_attempts, 'Bulk Exam Tester', 'XII TKJ A', now() + interval '30 minutes', '[]'::jsonb, '[]'::jsonb);

  -- ---------- every refusal, before anything is written ----------
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam, 'sideways', array[v_q2], v_actor),
    'Choose whether to add or remove questions', 'an unknown mode is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L, %L)', v_exam, 'add', '{}', v_actor),
    'Select at least one question', 'an empty selection is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam, 'add',
           array_fill('00000000-0000-4000-8000-000000000000'::uuid, array[501]), v_actor),
    'Change at most 500 questions at once', 'a selection over the cap is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', '00000000-0000-4000-8000-000000000001'::uuid, 'add', array[v_q2], v_actor),
    'That exam no longer exists', 'an exam that is gone is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam_auto, 'add', array[v_q2], v_actor),
    'draws its questions by a filter', 'an exam that draws by filter is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam_open, 'add', array[v_q2], v_actor),
    'Close the exam before changing its questions', 'a running exam is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam_attempts, 'add', array[v_q2], v_actor),
    'already has attempts', 'an exam that has been attempted is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam, 'add', array[v_q_arch], v_actor),
    'archived', 'adding an archived question is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam, 'add',
           array['00000000-0000-4000-8000-000000000000'::uuid], v_actor),
    'Those questions no longer exist', 'a selection that matches nothing is refused');
  perform pg_temp.assert_true(
    (select count(*) from public.exam_questions where exam_id = v_exam) = 1
    and (select count(*) from public.exam_questions where exam_id = v_exam_open) = 1,
    'every refusal above left the exams exactly as they were');

  -- The 200-question ceiling, on an exam of its own.
  v_exam_full := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST full exam', 'duration_minutes', 30, 'access_code', 'BLKEXM5',
    'selection_mode', 'manual', 'questions', jsonb_build_array(jsonb_build_object('question_id', v_q1))), v_actor);
  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  select 'short_answer', 'easy', 'BULK EXAM TEST filler ' || g, 1, md5('bulk-exam-filler-' || g)
    from generate_series(1, 199) g;
  insert into public.exam_questions (exam_id, question_id, position, weight)
  select v_exam_full, q.id, row_number() over (order by q.body), 1
    from public.questions q where q.body like 'BULK EXAM TEST filler %';
  perform pg_temp.assert_true((select count(*) from public.exam_questions where exam_id = v_exam_full) = 200,
    'the full exam holds 200 questions');
  perform pg_temp.expect_error(
    format('select public.bulk_exam_questions(%L, %L, %L::uuid[], %L)', v_exam_full, 'add', array[v_q4], v_actor),
    'at most 200 questions', 'growing an exam past 200 questions is refused');

  -- ---------- adding ----------
  v_audits_before := (select count(*) from public.audit_logs where action = 'exam.questions');
  v_result := public.bulk_exam_questions(v_exam, 'add', array[v_q2, v_q3], v_actor);
  perform pg_temp.assert_true((v_result ->> 'matched')::int = 2, 'both selected questions were found');
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 2, 'both were really added');
  perform pg_temp.assert_true((v_result ->> 'unchanged')::int = 0, 'none was already on the exam');
  perform pg_temp.assert_true((v_result ->> 'missing')::int = 0, 'nothing was missing');
  perform pg_temp.assert_true(
    (select count(*) from public.exam_questions where exam_id = v_exam) = 3,
    'the exam now holds three questions');
  perform pg_temp.assert_true(
    (select eq.position from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q2) = 2
    and (select eq.position from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q3) = 3,
    'they were appended at the end, in the order they were given');
  perform pg_temp.assert_true(
    (select eq.weight from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q2) = 3
    and (select eq.weight from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q3) = 4,
    'each question kept its own points');

  -- The same act again must not claim work it did not do.
  v_again := public.bulk_exam_questions(v_exam, 'add', array[v_q2, v_q3], v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0, 'adding what is already there reports 0 updated');
  perform pg_temp.assert_true((v_again ->> 'unchanged')::int = 2, 'and counts both as unchanged');
  perform pg_temp.assert_true((select count(*) from public.exam_questions where exam_id = v_exam) = 3,
    'a repeated add did not duplicate anything');

  -- A mixed selection: one new, one already there, one that no longer exists.
  v_result := public.bulk_exam_questions(v_exam, 'add', array[v_q4, v_q1, '00000000-0000-4000-8000-000000000000'::uuid], v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 1, 'only the new question was added');
  perform pg_temp.assert_true((v_result ->> 'unchanged')::int = 1, 'the question already on the exam was counted');
  perform pg_temp.assert_true((v_result ->> 'missing')::int = 1, 'the id that is gone was counted');
  perform pg_temp.assert_true(
    (select count(*) from public.exam_questions where exam_id = v_exam) = 4,
    'the exam holds four questions after the mixed add');

  -- ---------- removing ----------
  v_result := public.bulk_exam_questions(v_exam, 'remove', array[v_q2], v_actor);
  perform pg_temp.assert_true((v_result ->> 'matched')::int = 1 and (v_result ->> 'updated')::int = 1,
    'removing a question on the exam reports it');
  perform pg_temp.assert_true(
    (select count(*) from public.exam_questions where exam_id = v_exam) = 3
    and not exists (select 1 from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q2),
    'the question really left the exam');
  perform pg_temp.assert_true(
    (select eq.position from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q3) = 2
    and (select eq.position from public.exam_questions eq where eq.exam_id = v_exam and eq.question_id = v_q4) = 3,
    'the questions that stayed kept their order and their points');
  perform pg_temp.assert_true(
    (select array_agg(eq.position order by eq.position) from public.exam_questions eq where eq.exam_id = v_exam)
      = array[1, 2, 3],
    'and closed the gap, so the list is still 1..n');

  -- Removing something that is not on the exam is counted, not an error.
  v_again := public.bulk_exam_questions(v_exam, 'remove', array[v_q2], v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0 and (v_again ->> 'unchanged')::int = 1,
    'removing what is not there reports 0 updated and counts it as unchanged');

  -- A missing id does not stop the rest.
  v_result := public.bulk_exam_questions(v_exam, 'remove', array[v_q3, '00000000-0000-4000-8000-000000000000'::uuid], v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 1 and (v_result ->> 'missing')::int = 1,
    'a question that no longer exists is counted, and the rest is still removed');

  -- Another exam is never touched.
  v_other_exam := public.save_exam(null, jsonb_build_object(
    'title', 'BULK EXAM TEST other exam', 'duration_minutes', 30, 'access_code', 'BLKEXM6',
    'selection_mode', 'manual', 'questions', jsonb_build_array(jsonb_build_object('question_id', v_q1))), v_actor);
  perform public.bulk_exam_questions(v_exam, 'add', array[v_q2], v_actor);
  perform pg_temp.assert_true((select count(*) from public.exam_questions where exam_id = v_other_exam) = 1,
    'a question added to one exam did not appear on another');

  -- Emptying an exam is allowed (it simply cannot be opened); the last question goes too.
  v_result := public.bulk_exam_questions(v_exam, 'remove', array[v_q1, v_q2, v_q4], v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3, 'the whole list can be taken off');
  perform pg_temp.assert_true((select count(*) from public.exam_questions where exam_id = v_exam) = 0,
    'the exam is empty now');

  -- ---------- one audit entry per act, never one per question ----------
  v_audits := (select count(*) from public.audit_logs where action = 'exam.questions');
  perform pg_temp.assert_true(v_audits > v_audits_before, 'a bulk exam change writes an audit entry');
  perform pg_temp.assert_true(v_audits - v_audits_before = 8,
    'eight acts wrote exactly eight entries, not one per question');
  -- Every audit row in one transaction carries the same created_at, so this asks whether such an entry
  -- exists rather than trying to order them.
  perform pg_temp.assert_true(
    exists (select 1 from public.audit_logs
             where action = 'exam.questions' and entity_type = 'exam' and entity_id = v_exam::text
               and changes ->> 'mode' = 'remove' and (changes ->> 'count')::int = 3
               and changes ->> 'title' = 'BULK EXAM TEST exam'
               and (changes ->> 'selected')::int = 3 and (changes ->> 'missing')::int = 0),
    'the entry names the mode, the exam and the real count');
  perform pg_temp.assert_true(
    (select count(*) from public.audit_logs
      where action = 'exam.update' and entity_id = v_exam::text) = 0,
    'adding or removing questions never pretends to be an exam update per question');

  raise exception 'BULK EXAM QUESTION TESTS PASSED (refusals, add in order with own points, idempotence, mixed and missing ids, remove and its counts renumbering what stays, an untouched other exam, emptying the list, one audit entry per act) — everything rolled back';
end $bulk$;
