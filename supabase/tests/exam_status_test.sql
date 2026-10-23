-- SQL test for public.set_exam_status's open-code refusal (TASK-031, INS-04 / ISSUE-049) and the
-- helper public.exam_code_used_by.
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
--
-- It creates its own exams and lets the transaction abort at the end, so nothing it writes survives â€”
-- the ERROR MESSAGE is the result:
--   "EXAM STATUS TESTS PASSED (â€¦)"  â†’ every assertion held
--   "ASSERT FAILED: <message>"      â†’ a rule is broken
--
-- RUN LIVE 2026-10-03 (TASK-031): `20261002000002_open_exam_code_conflict.sql` applied with its
-- `schema_migrations` row; this file ended with `EXAM STATUS TESTS PASSED (...)`; the `exams` Edge
-- Function was redeployed. Fixture note (2026-10-03): the twin exams now use
-- `availability_mode='scheduled'` with a window — the questions rule on open only fires for
-- manual-availability exams, and an auto-draw exam with manual availability and no materialized
-- exam_questions could not be opened; the live run proved it, so the fixture matches the live rule.
--
-- The red proof for the fix: on the pre-fix `set_exam_status` the second open below does not raise a
-- validation-hinted error at all â€” it hits `exams_open_code_unique` (23505, no hint) and the Edge
-- function turns that into a hidden 500; the assertion that demands the friendly sentence fails.
--
-- What is checked: the boundary (only the service role may execute the functions); two drafts may be
-- saved with the same code (the state the bug grows from); opening the first succeeds; opening the
-- second is refused with a validation-hinted sentence that names the code, and that exam stays a
-- draft; closing the first frees the code so the second then opens; an already-open exam may be told
-- "open" again; a closed exam does not hold its code; `exam_code_used_by` reports 'open' / 'draft' /
-- null, honours p_exclude and ignores case and spaces; and `save_exam` still refuses a code an open
-- exam holds.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

-- Like the other tests' expect_error, but it also demands the `hint = 'validation'` that makes the
-- message reach the teacher as a 400 instead of the hidden 500 this task exists to remove. `needle2`,
-- when given, must also appear in the message.
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
      raise exception 'ASSERT FAILED: % (the hint was %, not validation â€” the teacher would see a 500)', msg, coalesce(v_hint, '<none>');
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $exam_status$
declare
  v_actor uuid;
  v_twin_a uuid;
  v_twin_b uuid;
  v_reuse uuid;
begin
  select id into v_actor from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_actor is not null, 'the project has an active admin to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.set_exam_status(uuid, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.set_exam_status(uuid, text, uuid)', 'execute'),
    'anon and authenticated cannot execute set_exam_status'
  );
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.exam_code_used_by(text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.exam_code_used_by(text, uuid)', 'execute'),
    'anon and authenticated cannot execute exam_code_used_by'
  );
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.set_exam_status(uuid, text, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.exam_code_used_by(text, uuid)', 'execute'),
    'service_role can execute both functions'
  );

  -- ---------- two drafts may share a code (the state the bug grows from) ----------
  v_twin_a := public.save_exam(null, jsonb_build_object(
    'title', 'Twin code A', 'duration_minutes', 30, 'access_code', 'TWIN31',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-031 test'), 'pool_size', 1, 'availability_mode', 'scheduled', 'starts_at', now() + interval '1 hour', 'ends_at', now() + interval '2 hours'), v_actor);
  v_twin_b := public.save_exam(null, jsonb_build_object(
    'title', 'Twin code B', 'duration_minutes', 30, 'access_code', 'TWIN31',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-031 test'), 'pool_size', 1, 'availability_mode', 'scheduled', 'starts_at', now() + interval '1 hour', 'ends_at', now() + interval '2 hours'), v_actor);
  perform pg_temp.assert_true(v_twin_a is distinct from v_twin_b, 'the two drafts are separate exams');
  perform pg_temp.assert_true(
    (select count(*) from public.exams where id in (v_twin_a, v_twin_b) and access_code = 'TWIN31' and status = 'draft') = 2,
    'both drafts are saved with the same code (what the partial unique index allows)'
  );

  -- the helper tells the teacher before anything is opened
  perform pg_temp.assert_true(public.exam_code_used_by('TWIN31') = 'draft',
    'a code only a draft holds is reported as used by a draft');
  perform pg_temp.assert_true(public.exam_code_used_by('TWIN31', v_twin_b) = 'draft',
    'excluding one holder still reports the other draft');
  perform pg_temp.assert_true(public.exam_code_used_by('FREE31') is null,
    'a code no exam holds is free');
  perform pg_temp.assert_true(public.exam_code_used_by(' twin31 ') = 'draft',
    'case and spaces do not matter');

  -- ---------- the refusal (the red assertion on the pre-fix function) ----------
  perform public.set_exam_status(v_twin_a, 'open', v_actor);
  perform pg_temp.assert_true((select status from public.exams where id = v_twin_a) = 'open',
    'the first twin opens');
  perform pg_temp.assert_true(public.exam_code_used_by('TWIN31') = 'open',
    'the helper now reports the code as held by an open exam');

  perform pg_temp.expect_error(
    format('select public.set_exam_status(%L::uuid, %L, %L::uuid)', v_twin_b, 'open', v_actor),
    'already used by an open exam', 'opening the second twin is refused in words', 'TWIN31');
  perform pg_temp.assert_true((select status from public.exams where id = v_twin_b) = 'draft',
    'the refused exam stays a draft');

  -- ---------- closing the first frees the code ----------
  perform public.set_exam_status(v_twin_a, 'closed', v_actor);
  perform pg_temp.assert_true(public.exam_code_used_by('TWIN31') = 'draft',
    'after closing, only the draft still holds the code');
  perform public.set_exam_status(v_twin_b, 'open', v_actor);
  perform pg_temp.assert_true((select status from public.exams where id = v_twin_b) = 'open',
    'the second twin opens once the first is closed');
  perform public.set_exam_status(v_twin_b, 'open', v_actor);   -- saying "open" again must not self-conflict

  -- ---------- a closed exam does not hold its code ----------
  v_reuse := public.save_exam(null, jsonb_build_object(
    'title', 'Reuse check', 'duration_minutes', 30, 'access_code', 'REUSE31',
    'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'TASK-031 test'), 'pool_size', 1, 'availability_mode', 'scheduled', 'starts_at', now() + interval '1 hour', 'ends_at', now() + interval '2 hours'), v_actor);
  perform public.set_exam_status(v_reuse, 'open', v_actor);
  perform public.set_exam_status(v_reuse, 'closed', v_actor);
  perform pg_temp.assert_true(public.exam_code_used_by('REUSE31') is null,
    'a closed exam does not hold its code');

  -- ---------- save_exam still refuses a code an open exam holds ----------
  perform pg_temp.expect_error(
    format('select public.save_exam(null, %L::jsonb, %L::uuid)',
      jsonb_build_object('title', 'Late draft', 'duration_minutes', 30, 'access_code', 'TWIN31',
        'selection_mode', 'auto', 'auto_filter', jsonb_build_object('topic', 'x'), 'pool_size', 1)::text, v_actor),
    'already used by an open exam', 'saving another exam with an open code is still refused');

  raise exception 'EXAM STATUS TESTS PASSED (two drafts may share a code; the second open is refused with hint=validation, names the code and stays a draft; closing frees it; exam_code_used_by says open/draft/free and honours p_exclude; save_exam still refuses an open code) â€” everything rolled back';
end $exam_status$;

