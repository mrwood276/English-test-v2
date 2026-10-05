-- TASK-041 (2026-10-04, corrected 2026-10-05): an authoritative pre-flight check before Open
-- (INS-19 / ISSUE-049 shared query).
--
-- One read-only function returning counts and warnings, so the exam editor and the exams list can
-- show the same numbers the dashboard and the results will produce. It adds no write path and no
-- new rule: it only surfaces rules that already exist (set_exam_status, exam_code_used_by).
--
-- Corrections to the first draft of this file (it was never applied live, so it is replaced in place):
--   * DEC-041 isolation. The first draft took only the exam id and was security definer, so any
--     teacher could read any other teacher's readiness. It now takes p_actor and refuses a missing,
--     foreign or null-actor exam with the same "no longer exists" sentence every other exam
--     function uses. The guard is null-safe on BOTH sides (`p_actor is null`, and
--     `created_by is not distinct from p_actor`), so an exam row with a null created_by fails
--     closed for a teacher instead of failing open.
--   * `format('The test code % is ...')` was an invalid specifier and raised at runtime exactly when
--     a code was taken; it is `%s` now.
--   * The counters had no initial value, so for an `auto` exam they stayed null and `ready` came out
--     null. They start at 0; point/question checks apply to manual exams only (an auto exam draws
--     its questions at join time, so there is nothing to count before then).
--   * The code-conflict question is asked of `exam_code_used_by` (TASK-031), not re-implemented.
--   * security invoker with `set search_path = ''`, like the rest of the exam functions.
--
-- APPLY ORDER: this migration, then redeploy `exams` (its `readiness` action now sends p_actor).
-- STATUS: see `.ai/04_CURRENT_STATE.md` — the live ledger is the authority on whether it is applied.

drop function if exists public.exam_readiness(uuid);

create or replace function public.exam_readiness(p_id uuid, p_actor uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_exam public.exams%rowtype;
  v_manual boolean;
  v_archived int := 0;
  v_missing int := 0;
  v_essays int := 0;
  v_total_points numeric := 0;
  v_code_used_by text;
  v_code_taken boolean := false;
  v_q jsonb;
  v_warnings text[] := '{}';
begin
  select * into v_exam from public.exams where id = p_id;
  if not found
     or p_actor is null
     or not (coalesce(public._is_staff_admin(p_actor), false) or v_exam.created_by is not distinct from p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;

  v_manual := (v_exam.selection_mode = 'manual');

  -- the questions on a manual exam (an auto exam draws them when a student joins)
  if v_manual then
    select count(*) filter (where q.is_archived),
           count(*) filter (where q.id is null),
           count(*) filter (where q.type = 'essay'),
           coalesce(sum(eq.weight), 0)
      into v_archived, v_missing, v_essays, v_total_points
      from public.exam_questions eq
      left join public.questions q on q.id = eq.question_id
     where eq.exam_id = p_id;

    if v_archived > 0 then
      v_warnings := v_warnings || format('%s question(s) on this exam are archived.', v_archived);
    end if;
    if v_missing > 0 then
      v_warnings := v_warnings || format('%s question(s) no longer exist (deleted).', v_missing);
    end if;
    if v_essays > 0 then
      v_warnings := v_warnings || format('%s essay question(s) will need manual grading.', v_essays);
    end if;
    if v_total_points <> 100 then
      v_warnings := v_warnings || format('Total points are %s (expected 100).', v_total_points);
    end if;
  end if;

  -- the test code: refused at Open only when another OPEN exam holds it (TASK-031's rule)
  v_code_used_by := public.exam_code_used_by(v_exam.access_code, p_id);
  v_code_taken := (v_code_used_by = 'open');
  if v_code_taken then
    v_warnings := v_warnings || format('The test code %s is already used by an open exam. Close that exam or give this one a different code.', v_exam.access_code);
  elsif v_code_used_by = 'draft' then
    v_warnings := v_warnings || format('Another draft also uses the test code %s; only one of them can be opened at a time.', v_exam.access_code);
  end if;

  -- the exam's current question list, in order
  select coalesce(jsonb_agg(
    jsonb_build_object('question_id', eq.question_id, 'position', eq.position, 'weight', eq.weight) order by eq.position
  ), '[]'::jsonb) into v_q
    from public.exam_questions eq where eq.exam_id = p_id;

  return jsonb_build_object(
    'ready', (v_archived = 0 and v_missing = 0 and not v_code_taken and (not v_manual or v_total_points = 100)),
    'warnings', to_jsonb(v_warnings),
    'questions', v_q,
    'essay_count', v_essays,
    'total_points', v_total_points,
    'code_taken', v_code_taken
  );
end $$;

-- boundary: only the service role executes it (every data path goes through an Edge Function)
revoke execute on function public.exam_readiness(uuid, uuid) from public, anon, authenticated;
grant execute on function public.exam_readiness(uuid, uuid) to service_role;
