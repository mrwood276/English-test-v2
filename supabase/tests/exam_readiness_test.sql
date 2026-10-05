-- SQL test for the exam pre-flight check (TASK-041) and its teacher isolation (DEC-041).
-- Run against the v2 project as ONE request (one request = one session), rolled back:
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--
-- Creates its own exams and questions (marked TASK-RDY) and ends with a deliberate exception, so
-- nothing it writes survives — the ERROR MESSAGE is the result:
--   "EXAM READINESS TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"         → a rule is broken
--
-- What it proves: the warnings and the `ready` flag follow the rules that already exist (archived or
-- deleted questions, points not 100, a test code held by an open exam); an auto exam is ready
-- without points (it draws its questions at join time); a taken code no longer crashes the
-- function (the first draft had an invalid format() specifier); and ownership holds — a foreign
-- exam, a missing exam and a null actor are the same sentence, an admin sees everything, and an
-- exam row with no owner fails closed for a teacher.

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

do $rdy$
declare
  v_admin uuid;
  v_t1 uuid;
  v_t2 uuid;
  v_exam uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_auto uuid := gen_random_uuid();
  v_orphan uuid := gen_random_uuid();
  v_q1 uuid;
  v_q2 uuid;
  v_r jsonb;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_t1 from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  select id into v_t2 from public.profiles where role = 'teacher' and is_active and id <> v_t1 order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_t1 is not null and v_t2 is not null,
    'the project has an active admin and two active teachers to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.exam_readiness(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.exam_readiness(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.exam_readiness(uuid, uuid)', 'execute'),
    'only service_role can execute exam_readiness');
  perform pg_temp.assert_true(to_regprocedure('public.exam_readiness(uuid)') is null,
    'the one-argument exam_readiness(uuid) is gone — nothing is left that skips the owner check');

  -- ---------- fixtures: two questions (one essay), a manual exam owned by teacher 1 ----------
  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('multiple_choice', 'easy', 'TASK-RDY mc', 60, md5(random()::text)) returning id into v_q1;
  insert into public.question_options (question_id, position, body, is_correct)
  values (v_q1, 1, 'A', true), (v_q1, 2, 'B', false);
  insert into public.questions (type, difficulty, body, default_weight, content_hash)
  values ('essay', 'easy', 'TASK-RDY essay', 40, md5(random()::text)) returning id into v_q2;

  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode, access_code, selection_mode, created_by)
  values (v_exam, 'TASK-RDY manual exam', 'draft', 45, 70, 'manual', 'RDYTST', 'manual', v_t1);
  insert into public.exam_questions (exam_id, question_id, position, weight) values (v_exam, v_q1, 1, 60);

  -- ---------- points that do not add up ----------
  v_r := public.exam_readiness(v_exam, v_t1);
  perform pg_temp.assert_true((v_r ->> 'ready')::boolean = false, 'points of 60 are not ready');
  perform pg_temp.assert_true(v_r ->> 'total_points' = '60', 'the total is reported');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements_text(v_r -> 'warnings') w where w like 'Total points are 60 (expected 100)%'),
    'the warning names the total');
  perform pg_temp.assert_true(jsonb_typeof(v_r -> 'warnings') = 'array', 'warnings is a JSON array');

  -- ---------- points add up to 100, one essay: ready, with the essay noted ----------
  insert into public.exam_questions (exam_id, question_id, position, weight) values (v_exam, v_q2, 2, 40);
  v_r := public.exam_readiness(v_exam, v_t1);
  perform pg_temp.assert_true((v_r ->> 'ready')::boolean = true, 'two questions worth 100 points are ready');
  perform pg_temp.assert_true((v_r ->> 'essay_count')::int = 1, 'the essay is counted');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements_text(v_r -> 'warnings') w where w like '1 essay question(s) will need manual grading%'),
    'the essay is noted without blocking');
  perform pg_temp.assert_true(jsonb_array_length(v_r -> 'questions') = 2, 'the question list comes back');
  perform pg_temp.assert_true((v_r -> 'questions' -> 0 ->> 'position')::int = 1, 'the list is in order');

  -- ---------- an archived question blocks readiness ----------
  update public.questions set is_archived = true where id = v_q1;
  v_r := public.exam_readiness(v_exam, v_t1);
  perform pg_temp.assert_true((v_r ->> 'ready')::boolean = false, 'an archived question is not ready');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements_text(v_r -> 'warnings') w where w like '1 question(s) on this exam are archived.%'),
    'the archived question is named');
  update public.questions set is_archived = false where id = v_q1;

  -- ---------- a code held by an OPEN exam: reported, and it must not crash (the old %-format bug) ----------
  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode, access_code, selection_mode, created_by)
  values (v_other, 'TASK-RDY other exam', 'open', 45, 70, 'manual', 'RDYTST', 'manual', v_t2);
  v_r := public.exam_readiness(v_exam, v_t1);
  perform pg_temp.assert_true((v_r ->> 'code_taken')::boolean = true, 'a code held by an open exam is taken');
  perform pg_temp.assert_true((v_r ->> 'ready')::boolean = false, 'a taken code is not ready');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements_text(v_r -> 'warnings') w where w like 'The test code RDYTST is already used by an open exam.%'),
    'the warning names the code (not the literal "%")');
  update public.exams set status = 'closed' where id = v_other;
  v_r := public.exam_readiness(v_exam, v_t1);
  perform pg_temp.assert_true((v_r ->> 'code_taken')::boolean = false and (v_r ->> 'ready')::boolean = true,
    'closing the other exam frees the code');

  -- ---------- an auto exam draws its questions at join time: ready without points ----------
  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode, access_code, selection_mode, pool_size, auto_filter, created_by)
  values (v_auto, 'TASK-RDY auto exam', 'draft', 45, 70, 'manual', 'RDYAUT', 'auto', 5, '{}'::jsonb, v_t1);
  v_r := public.exam_readiness(v_auto, v_t1);
  perform pg_temp.assert_true((v_r ->> 'ready')::boolean = true, 'an auto exam with a free code is ready (no null from uninitialised counters)');
  perform pg_temp.assert_true((v_r ->> 'total_points') = '0' and (v_r ->> 'essay_count') = '0', 'the counters are 0, not null');

  -- ---------- ownership ----------
  perform pg_temp.expect_error(format('select public.exam_readiness(%L::uuid, %L::uuid)', v_exam, v_t2),
    'That exam no longer exists.', 'another teacher cannot read this exam''s readiness');
  perform pg_temp.expect_error(format('select public.exam_readiness(%L::uuid, %L::uuid)', gen_random_uuid(), v_t1),
    'That exam no longer exists.', 'a missing exam reads the same as a foreign one');
  perform pg_temp.expect_error(format('select public.exam_readiness(%L::uuid, null)', v_exam),
    'That exam no longer exists.', 'a null actor fails closed');
  perform pg_temp.assert_true(public.exam_readiness(v_exam, v_admin) ? 'ready', 'an active admin can read any exam');

  -- an exam row with no owner: a teacher must not slip through a null comparison
  insert into public.exams (id, title, status, duration_minutes, passing_grade, availability_mode, access_code, selection_mode, pool_size, auto_filter, created_by)
  values (v_orphan, 'TASK-RDY orphan exam', 'draft', 45, 70, 'manual', 'RDYORP', 'auto', 5, '{}'::jsonb, null);
  perform pg_temp.expect_error(format('select public.exam_readiness(%L::uuid, %L::uuid)', v_orphan, v_t1),
    'That exam no longer exists.', 'an exam with no owner is closed to a teacher (null-safe guard)');
  perform pg_temp.assert_true(public.exam_readiness(v_orphan, v_admin) ? 'ready', 'an active admin can read an exam with no owner');

  raise exception 'EXAM READINESS TESTS PASSED (points, essays, archived questions, taken code without a format crash, auto exam, owner / foreign / missing / null actor / ownerless exam; all rolled back)';
end
$rdy$;
