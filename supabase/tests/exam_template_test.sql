-- SQL test for TASK-032 (INS-05 / ISSUE-050): a live exam can never be a template.
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
--
-- It creates its own exams and lets the transaction abort at the end, so nothing it writes survives —
-- the ERROR MESSAGE is the result:
--   "EXAM TEMPLATE TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"        → a rule is broken
--
-- NOT YET RUN LIVE (written 2026-10-02, TASK-032): no Management credential was available in the
-- session that wrote it. The next live run applies `20261002000003_template_only_when_safe.sql` (after
-- `20261002000002`, which this file's set_exam_status assertions also cover) with its
-- `schema_migrations` row, then runs this file; the result belongs in its header and in `.ai/`.
--
-- The red proof for the fix: on the pre-fix `save_exam` the open exam accepts `is_template = true`
-- (no validation-hinted refusal), and on the pre-fix `set_exam_status` a template opens — the
-- assertions that demand the friendly sentences fail.
--
-- What is checked: the boundary (only the service role may execute the functions); a draft with no
-- attempts can be a template and a second save keeps the flag; `set_exam_status` refuses to open a
-- template with a sentence that points at Duplicate, and the copy it produces is openable and not a
-- template; `save_exam` refuses a template on an exam that is open (Close it first), on one that has
-- attempts (Duplicate it), and refuses `is_template` outside a draft save; `get_exam` reports
-- `session_count` (0 and 1); and after the migration no exam is both open and a template — the state
-- the repair statement clears and both gates now prevent.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

-- Like the other tests' expect_error, but it also demands the `hint = 'validation'` that makes the
-- message reach the teacher as a 400 instead of a hidden 500. `needle2`, when given, must also appear.
create or replace function pg_temp.expect_error(sql text, needle text, msg text, needle2 text default null)
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
    if needle2 is not null and position(needle2 in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (the message does not name %: %)', msg, needle2, sqlerrm;
    end if;
    if v_hint is distinct from 'validation' then
      raise exception 'ASSERT FAILED: % (the hint was %, not validation — the teacher would see a 500)', msg, coalesce(v_hint, '<none>');
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $exam_template$
declare
  v_actor uuid;
  v_tpl uuid;
  v_copy uuid;
  v_used uuid;
  v_open uuid;
begin
  select id into v_actor from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_actor is not null, 'the project has an active admin to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.save_exam(uuid, jsonb, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.set_exam_status(uuid, text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.get_exam(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.duplicate_exam(uuid, uuid)', 'execute'),
    'anon and authenticated cannot execute the exam functions'
  );
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.save_exam(uuid, jsonb, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.set_exam_status(uuid, text, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_exam(uuid)', 'execute'),
    'service_role can execute the exam functions'
  );

  -- ---------- a draft nobody has joined can be a template ----------
  v_tpl := public.save_exam(null, jsonb_build_object(
    'title', 'Template draft', 'duration_minutes', 30, 'access_code', 'TPLT32',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-032 test'), 'pool_size', 1,
    'is_template', true), v_actor);
  perform pg_temp.assert_true(
    (select is_template and status = 'draft' from public.exams where id = v_tpl),
    'a draft with no attempts is saved as a template');

  -- saving it again as a template is the ordinary "edit a template" path, not a refusal
  perform public.save_exam(v_tpl, jsonb_build_object(
    'title', 'Template draft', 'duration_minutes', 30, 'access_code', 'TPLT32',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-032 test'), 'pool_size', 1,
    'is_template', true), v_actor);
  perform pg_temp.assert_true((select is_template from public.exams where id = v_tpl),
    'editing a template keeps it a template');

  -- ---------- a template cannot be opened ----------
  perform pg_temp.expect_error(
    format('select public.set_exam_status(%L::uuid, %L, %L::uuid)', v_tpl, 'open', v_actor),
    'A template cannot be opened', 'opening a template is refused', 'Duplicate it and open the copy');
  perform pg_temp.assert_true((select status from public.exams where id = v_tpl) = 'draft',
    'the refused template stays a draft');

  -- the way forward the message names: duplicate, then open the copy
  v_copy := public.duplicate_exam(v_tpl, v_actor);
  perform pg_temp.assert_true(
    (select not is_template and status = 'draft' from public.exams where id = v_copy),
    'the duplicate is a draft and not a template');
  perform public.set_exam_status(v_copy, 'open', v_actor);
  perform pg_temp.assert_true((select status from public.exams where id = v_copy) = 'open',
    'the copy can be opened');

  -- ---------- get_exam reports the attempt count the editor needs ----------
  perform pg_temp.assert_true((public.get_exam(v_copy) ->> 'session_count')::int = 0,
    'get_exam reports zero attempts for an unused exam');

  -- ---------- an exam students have joined cannot become a template ----------
  -- It stays a draft: the open-exam rule would otherwise answer first, and both messages must be proven.
  v_used := public.save_exam(null, jsonb_build_object(
    'title', 'Used draft', 'duration_minutes', 30, 'access_code', 'USED32',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-032 test'), 'pool_size', 1), v_actor);
  insert into public.exam_sessions (exam_id, student_name, student_class, ends_at, questions_snapshot, answer_key)
  values (v_used, 'TASK-032 Student', 'XI A', now() + interval '1 hour', '[]'::jsonb, '[]'::jsonb);
  perform pg_temp.assert_true((public.get_exam(v_used) ->> 'session_count')::int = 1,
    'get_exam counts a session that exists');
  perform pg_temp.expect_error(
    format('select public.save_exam(%L::uuid, %L::jsonb, %L::uuid)', v_used,
      jsonb_build_object('title', 'Used draft', 'duration_minutes', 30, 'access_code', 'USED32',
        'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'x'), 'pool_size', 1,
        'status', 'draft', 'is_template', true)::text, v_actor),
    'already has attempts', 'saving a used exam as a template is refused', 'Duplicate it and save the copy');

  -- ---------- an open exam cannot become a template ----------
  v_open := public.save_exam(null, jsonb_build_object(
    'title', 'Live exam', 'duration_minutes', 30, 'access_code', 'LIVE32',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-032 test'), 'pool_size', 1), v_actor);
  perform public.set_exam_status(v_open, 'open', v_actor);
  perform pg_temp.expect_error(
    format('select public.save_exam(%L::uuid, %L::jsonb, %L::uuid)', v_open,
      jsonb_build_object('title', 'Live exam', 'duration_minutes', 30, 'access_code', 'LIVE32',
        'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'x'), 'pool_size', 1,
        'status', 'draft', 'is_template', true)::text, v_actor),
    'An open exam cannot become a template', 'saving a live exam as a template is refused', 'Close it first');

  -- ---------- is_template outside a draft save is refused ----------
  perform pg_temp.expect_error(
    format('select public.save_exam(null, %L::jsonb, %L::uuid)',
      jsonb_build_object('title', 'Born open', 'duration_minutes', 30, 'access_code', 'OPEN32',
        'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'x'), 'pool_size', 1,
        'status', 'open', 'is_template', true)::text, v_actor),
    'A template must be saved as a draft', 'an open save cannot carry is_template');

  -- ---------- the invariant, as the repair leaves it ----------
  perform pg_temp.assert_true(
    not exists (select 1 from public.exams x
                where x.is_template and (x.status = 'open' or public._exam_is_open(x))),
    'no exam is both open and a template after the migration');

  raise exception 'EXAM TEMPLATE TESTS PASSED (a draft may be a template and keeps it; a template cannot be opened but its copy can; get_exam reports session_count; a live or used exam is refused is_template with hint=validation and the way forward; an open save cannot carry it; no open exam is a template) — everything rolled back';
end $exam_template$;
