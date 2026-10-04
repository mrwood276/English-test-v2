-- TASK-041 (2026-10-04): pre-flight readiness check before Open (INS-19 / ISSUE-049 shared query).
-- One read-only function returning counts/warnings so the editor and list can show the same
-- numbers the dashboard/results will produce. No new write path; only the rules that already
-- exist are surfaced.

create or replace function public.exam_readiness(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_exam public.exams%rowtype;
  v_archived int;
  v_missing int;
  v_essays int;
  v_total_points numeric;
  v_code_taken boolean;
  v_q jsonb;
  v_warnings text[];
begin
  select * into v_exam from public.exams where id = p_id;
  if not found then
    return jsonb_build_object('ready', false, 'warnings', array['That exam no longer exists.']);
  end if;

  v_warnings := '{}';

  -- questions on the exam
  if v_exam.selection_mode = 'manual' then
    select count(*) into v_archived
      from public.exam_questions eq
      join public.questions q on q.id = eq.question_id
     where eq.exam_id = p_id and q.is_archived;
    if v_archived > 0 then
      v_warnings := v_warnings || format('%s question(s) on this exam are archived.', v_archived);
    end if;

    select count(*) into v_missing
      from public.exam_questions eq
      left join public.questions q on q.id = eq.question_id
     where eq.exam_id = p_id and q.id is null;
    if v_missing > 0 then
      v_warnings := v_warnings || format('%s question(s) no longer exist (deleted).', v_missing);
    end if;

    select count(*) into v_essays
      from public.exam_questions eq
      join public.questions q on q.id = eq.question_id
     where eq.exam_id = p_id and q.type = 'essay';
    if v_essays > 0 then
      v_warnings := v_warnings || format('%s essay question(s) will require manual grading.', v_essays);
    end if;

    select coalesce(sum(eq.weight), 0) into v_total_points
      from public.exam_questions eq where eq.exam_id = p_id;
    if v_total_points <> 100 then
      v_warnings := v_warnings || format('Total points are %s (expected 100).', v_total_points);
    end if;
  end if;

  -- code taken by another open exam
  select exists (
    select 1 from public.exams x
    where x.access_code = v_exam.access_code
      and x.id <> p_id
      and (x.status = 'open' or public._exam_is_open(x))
  ) into v_code_taken;
  if v_code_taken then
    v_warnings := v_warnings || format('The test code % is already used by an open exam.', v_exam.access_code);
  end if;

  -- current question list for the editor
  select coalesce(jsonb_agg(
    jsonb_build_object('question_id', eq.question_id, 'position', eq.position, 'weight', eq.weight) order by eq.position
  ), '[]'::jsonb) into v_q
    from public.exam_questions eq where eq.exam_id = p_id;

  return jsonb_build_object(
    'ready', (v_archived = 0 and v_missing = 0 and not v_code_taken and (v_exam.selection_mode <> 'manual' or v_total_points = 100)),
    'warnings', v_warnings,
    'questions', v_q,
    'essay_count', v_essays,
    'total_points', v_total_points,
    'code_taken', v_code_taken
  );
end $$;

-- boundary
revoke execute on function public.exam_readiness(uuid) from public, anon, authenticated;
grant execute on function public.exam_readiness(uuid) to service_role;