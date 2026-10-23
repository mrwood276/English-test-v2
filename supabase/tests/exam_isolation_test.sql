-- SQL test for teacher data isolation in exams (DEC-041, the exams slice — mirrors TASK-048).
-- Run against the v2 project as ONE request (one request = one session), rolled back:
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--
--It creates its own exams and questions (marked TASK-EXI) and lets the transaction abort at
-- the end, so nothing it writes survives — the ERROR MESSAGE is the result:
--   "EXAM ISOLATION TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"          → a rule is broken
--
-- The matrix (DEC-041, the strict model): a teacher sees and changes only their own exams;
-- a foreign id is exactly as invisible as a missing one; an active admin sees the whole school;
-- a null actor fails closed.

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

do $exi_isolation$
declare
  v_admin uuid;
  v_teacher uuid;
  v_ta uuid;    -- teacher's question (needed to make a manual exam)
  v_aa uuid;    -- admin's question
  v_et uuid;    -- teacher's exam
  v_ea uuid;    -- admin's exam
  v_res jsonb;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and an active teacher to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.list_exams(jsonb, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_exams(jsonb, uuid)', 'execute'),
    'anon and authenticated cannot execute list_exams');
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.get_exam(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_exam(uuid, uuid)', 'execute'),
    'anon and authenticated cannot execute get_exam');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.list_exams(jsonb, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_exam(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public._is_staff_admin(uuid)', 'execute'),
    'service_role can execute the isolated functions');
  perform pg_temp.assert_true(
    public._is_staff_admin(v_admin) and not public._is_staff_admin(v_teacher) and not public._is_staff_admin(null),
    '_is_staff_admin is true for the admin, false for a teacher and for null');

  -- ---------- the two owners' questions, one each (to build manual exams) ----------
  v_ta := public.save_question(null, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-EXI test',
    'body', 'TASK-EXI isolation question', 'class_labels', jsonb_build_array('TASK-EXI A'),
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_teacher);
  v_aa := public.save_question(null, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-EXI test',
    'body', 'TASK-EXI isolation question', 'class_labels', jsonb_build_array('TASK-EXI B'),
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_admin);

  -- ---------- the two owners' exams ----------
  v_et := public.save_exam(null, jsonb_build_object(
    'title', 'TASK-EXI teacher exam', 'duration_minutes', 30, 'passing_grade', 75,
    'availability_mode', 'manual', 'access_code', 'TASKEXI1',
    'selection_mode', 'manual',
    'questions', jsonb_build_array(jsonb_build_object('question_id', v_ta, 'weight', 1))),
    v_teacher);
  v_ea := public.save_exam(null, jsonb_build_object(
    'title', 'TASK-EXI admin exam', 'duration_minutes', 30, 'passing_grade', 75,
    'availability_mode', 'manual', 'access_code', 'TASKEXI2',
    'selection_mode', 'manual',
    'questions', jsonb_build_array(jsonb_build_object('question_id', v_aa, 'weight', 1))),
    v_admin);

  -- ---------- the list is scoped ----------
  perform pg_temp.assert_true(
    (select count(*) from public.list_exams(jsonb_build_object('q', 'TASK-EXI'), v_teacher)) = 1,
    'a teacher lists only their own exam');
  perform pg_temp.assert_true(
    (select count(*) from public.list_exams(jsonb_build_object('q', 'TASK-EXI'), v_admin)) = 2,
    'the admin lists the whole school (both exams)');
  perform pg_temp.assert_true(
    not exists (select 1 from public.list_exams(jsonb_build_object('q', 'TASK-EXI'), v_teacher) x
                 where x.id = v_ea),
    'the admin exam is not in the teacher list');

  -- ---------- reading one foreign id is reading a missing one ----------
  perform pg_temp.assert_true(public.get_exam(v_et, v_teacher) is not null, 'a teacher reads their own exam');
  perform pg_temp.assert_true(public.get_exam(v_ea, v_teacher) is null,
    'a teacher reading the admin exam gets exactly what a missing id gets: null');
  perform pg_temp.assert_true(public.get_exam(v_ea, v_admin) is not null, 'the admin reads the teacher exam too');
  perform pg_temp.assert_true(public.get_exam(v_et, v_admin) is not null, 'the admin reads their own exam');
  perform pg_temp.assert_true(public.get_exam(v_et, null) is null, 'a null actor fails closed');

  -- ---------- a null actor fails closed on writes too (the 2026-10-04 fix) ----------
  perform pg_temp.expect_error(format(
    'select public.save_exam(%L::uuid, ''{"title":"ghost","duration_minutes":30,"access_code":"TASKEXI4","availability_mode":"manual","selection_mode":"manual","questions":[]}''::jsonb, null::uuid)',
    v_ea),
    'That exam no longer exists.', 'a null actor cannot edit an exam');
  perform pg_temp.expect_error(
    'select public.save_exam(null::uuid, ''{"title":"ghost","duration_minutes":30,"access_code":"TASKEXI5","availability_mode":"manual","selection_mode":"manual","questions":[]}''::jsonb, null::uuid)',
    'That exam no longer exists.', 'a null actor cannot create an exam');
  perform pg_temp.expect_error(format('select public.set_exam_status(%L::uuid, ''open'', null::uuid)', v_et),
    'That exam no longer exists.', 'a null actor cannot open an exam');
  perform pg_temp.expect_error(format('select public.remove_exam(%L::uuid, null::uuid, false)', v_et),
    'That exam no longer exists.', 'a null actor cannot delete an exam');

  -- ---------- writing a foreign id is the missing-row sentence ----------
  perform pg_temp.expect_error(format(
    'select public.save_exam(%L::uuid, ''{"title":"hijack","duration_minutes":30,"access_code":"TASKEXI3","availability_mode":"manual","selection_mode":"manual","questions":[]}''::jsonb, %L::uuid)',
    v_ea, v_teacher),
    'That exam no longer exists.', 'a teacher cannot edit the admin exam');
  perform pg_temp.expect_error(format('select public.set_exam_status(%L::uuid, ''open'', %L::uuid)', v_ea, v_teacher),
    'That exam no longer exists.', 'a teacher cannot open the admin exam');
  perform pg_temp.expect_error(format('select public.remove_exam(%L::uuid, %L::uuid, false)', v_ea, v_teacher),
    'That exam no longer exists.', 'a teacher cannot delete the admin exam');
  perform pg_temp.expect_error(format('select public.regenerate_exam_code(%L::uuid, %L::uuid)', v_ea, v_teacher),
    'That exam no longer exists.', 'a teacher cannot recode the admin exam');
  perform pg_temp.expect_error(format('select public.duplicate_exam(%L::uuid, %L::uuid)', v_ea, v_teacher),
    'That exam no longer exists.', 'a teacher cannot duplicate the admin exam');
  perform pg_temp.expect_error(format('select public.bulk_exam_questions(%L::uuid, ''add'', array[%L::uuid]::uuid[], %L::uuid)',
    v_ea, v_ta, v_teacher),
    'That exam no longer exists.', 'a teacher cannot bulk-question the admin exam');

  -- ---------- bulk_questions counts only the actor own questions ----------
  perform pg_temp.expect_error(format(
    'select public.bulk_exam_questions(%L::uuid, ''add'', array[%L::uuid]::uuid[], %L::uuid)',
    v_et, v_aa, v_teacher),
    'Those questions no longer exist.', 'a bulk add of only foreign questions is refused for a teacher');

  -- ---------- the admin bypass is the whole school ----------
  perform public.save_exam(v_et, jsonb_build_object(
    'title', 'TASK-EXI isolation exam (edited by the admin)', 'duration_minutes', 30, 'passing_grade', 75,
    'availability_mode', 'manual', 'access_code', 'TASKEXI1',
    'selection_mode', 'manual',
    'questions', jsonb_build_array(jsonb_build_object('question_id', v_ta, 'weight', 1))),
    v_admin);
  perform pg_temp.assert_true(
    (public.get_exam(v_et, v_admin) ->> 'title') = 'TASK-EXI isolation exam (edited by the admin)',
    'the admin edits the teacher exam');

  raise exception 'EXAM ISOLATION TESTS PASSED (a teacher sees and changes only their own exams; a foreign id is the missing-row sentence; the admin sees the whole school; all rolled back)';
end
$exi_isolation$;
