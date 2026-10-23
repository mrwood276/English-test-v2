-- TASK-032 / INS-05 / ISSUE-050 (2026-10-02): a live exam cannot be turned into a template.
--
-- `save_exam` accepted `is_template` for any status, while `exam_join` refuses a template outright
-- ("That code belongs to a template, not a running test"). One tick + Save on an open exam therefore
-- turned a running test into one nobody could join — and the list still said "Open".
--
-- This replaces three functions and repairs the rows the bug could have made:
--   * `save_exam` refuses `is_template = true` unless the save is a draft, the exam is not currently
--     open, and no student has joined it (raised with `hint = 'validation'` so the Edge function
--     answers 400 with the sentence and the exam stays as it was);
--   * `set_exam_status` refuses to open a template — the same unjoinable state through the list's
--     Open button. It keeps TASK-031's open-code check, so this migration must be applied after
--     `20261002000002`;
--   * `get_exam` also reports `session_count`, which the editor needs to disable the checkbox and say
--     why. `list_exams` has reported it since ISSUE-023.
--   * the one repair statement clears `is_template` from any exam that is open right now: such an
--     exam was never joinable, and clearing the flag is what makes it joinable again.
-- No table, column or index changes.
--
-- APPLIED LIVE: 2026-10-03 as one Management API request with its ledger row (version
-- `20261002000003`, name `template_only_when_safe`), and `supabase/tests/exam_template_test.sql` passed
-- live against it. The exams Edge Function needed no redeploy for this one (the editor reads a field
-- the payload already carries), but TASK-031's redeploy had to happen first — it did, on 2026-10-03.

-- ============ who may be a template (the save gate) ============
create or replace function public.save_exam(p_id uuid, p jsonb, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_code text := upper(regexp_replace(coalesce(p->>'access_code',''), '\s', '', 'g'));
  v_status text := coalesce(p->>'status', 'draft');
  v_existing_status text;
  v_mode text := coalesce(p->>'availability_mode', 'manual');
  v_starts timestamptz := (p->>'starts_at')::timestamptz;
  v_ends   timestamptz := (p->>'ends_at')::timestamptz;
  v_sel text := coalesce(p->>'selection_mode', 'manual');
  v_warn int := coalesce((p->>'tab_switch_warn_limit')::int, 1);
  v_flag int := coalesce((p->>'tab_switch_flag_limit')::int, 3);
  v_sub  int := coalesce((p->>'tab_switch_autosubmit_limit')::int, 5);
  v_qs int := coalesce(jsonb_array_length(coalesce(p->'questions','[]'::jsonb)), 0);
begin
  -- ---- validation (hint 'validation' -> friendly 400) ----
  if coalesce(trim(p->>'title'), '') = '' then
    raise exception 'Title is required.' using hint = 'validation'; end if;
  if char_length(p->>'title') > 120 then
    raise exception 'Title must be at most 120 characters.' using hint = 'validation'; end if;
  if (coalesce((p->>'duration_minutes')::int, 0) < 1) or ((p->>'duration_minutes')::int > 300) then
    raise exception 'Duration must be between 1 and 300 minutes.' using hint = 'validation'; end if;
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'Test code must be 4 to 12 letters and digits, without spaces.' using hint = 'validation'; end if;
  if v_warn > v_flag or v_flag > v_sub then
    raise exception 'The tab-switch limits must grow: warn, then flag, then auto-submit.' using hint = 'validation'; end if;
  if v_mode = 'scheduled' and (v_starts is null or v_ends is null) then
    raise exception 'A scheduled exam needs an opening and a closing time.' using hint = 'validation'; end if;
  if v_mode = 'scheduled' and v_ends <= v_starts then
    raise exception 'Closing time must be after the opening time.' using hint = 'validation'; end if;
  if v_sel = 'manual' and v_qs = 0 and v_id is null then
    raise exception 'Add at least one question before saving the exam.' using hint = 'validation'; end if;
  if v_sel = 'auto' and coalesce((p->>'pool_size')::int, 0) < 1 then
    raise exception 'Choose how many questions to draw.' using hint = 'validation'; end if;
  if v_sel = 'auto' and coalesce((p->>'auto_filter')::jsonb is null, true) then
    raise exception 'Selection filter needs at least a class, topic, or difficulty to pick from.' using hint = 'validation'; end if;

  select status into v_existing_status from public.exams where id = v_id;
  if found then
    -- A running exam may not have its rules silently changed (design: open exams are frozen).
    if v_existing_status = 'open' and coalesce(p->>'status', v_existing_status) = 'open'
       and (coalesce((p->>'duration_minutes')::int, 0) <> (select duration_minutes from public.exams where id = v_id)) then
      raise exception 'Stop the exam before changing its duration.' using hint = 'validation';
    end if;
  end if;

  -- ---- code uniqueness among open exams (BR-03, BR-17) ----
  if exists (
    select 1 from public.exams x
    where x.access_code = v_code and x.id is distinct from v_id
      and (x.status = 'open' or public._exam_is_open(x))
  ) then
    raise exception 'The test code % is already used by an open exam.', v_code using hint = 'validation';
  end if;

  -- ---- a template must be safe to reuse: a draft, not running, never used (TASK-032 / INS-05) ----
  -- `exam_join` refuses a template, so these three states are the ones where a tick would lock
  -- students out of a test the teacher believes is running. All say what to do instead.
  if coalesce((p->>'is_template')::boolean, false) then
    if v_status <> 'draft' then
      raise exception 'A template must be saved as a draft.' using hint = 'validation'; end if;
    if v_existing_status = 'open' then
      raise exception 'An open exam cannot become a template. Close it first.' using hint = 'validation'; end if;
    if exists (select 1 from public.exam_sessions s where s.exam_id = v_id) then
      raise exception 'This exam already has attempts, so it cannot become a template. Duplicate it and save the copy as a template.'
        using hint = 'validation'; end if;
  end if;

  insert into public.exams (id, title, description, status, duration_minutes, passing_grade,
      availability_mode, starts_at, ends_at, late_start_policy, access_code, selection_mode,
      auto_filter, pool_size, draw_per_student, randomize_questions, randomize_options,
      result_visibility, essay_pending_display, tab_switch_warn_limit, tab_switch_flag_limit,
      tab_switch_autosubmit_limit, is_template, created_by)
  values (v_id, p->>'title', nullif(p->>'description',''), v_status::public.exam_status,
      (p->>'duration_minutes')::int, coalesce((p->>'passing_grade')::int, 0),
      v_mode::public.availability_mode, v_starts, v_ends, coalesce(p->>'late_start_policy','full_duration')::public.late_start_policy, v_code, v_sel::public.selection_mode,
      coalesce((p->>'auto_filter')::jsonb, '{}'::jsonb), (p->>'pool_size')::int, coalesce((p->>'draw_per_student')::boolean, false),
      coalesce((p->>'randomize_questions')::boolean, false), coalesce((p->>'randomize_options')::boolean, false),
      coalesce(p->>'result_visibility','none')::public.result_visibility, coalesce(p->>'essay_pending_display','hide_score')::public.essay_pending_display,
      v_warn, v_flag, v_sub, coalesce((p->>'is_template')::boolean, false), p_actor)
  on conflict (id) do update set
      title = excluded.title, description = excluded.description, status = excluded.status,
      duration_minutes = excluded.duration_minutes, passing_grade = excluded.passing_grade,
      availability_mode = excluded.availability_mode, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
      late_start_policy = excluded.late_start_policy, access_code = excluded.access_code,
      selection_mode = excluded.selection_mode, auto_filter = excluded.auto_filter,
      pool_size = excluded.pool_size, draw_per_student = excluded.draw_per_student,
      randomize_questions = excluded.randomize_questions, randomize_options = excluded.randomize_options,
      result_visibility = excluded.result_visibility, essay_pending_display = excluded.essay_pending_display,
      tab_switch_warn_limit = excluded.tab_switch_warn_limit,
      tab_switch_flag_limit = excluded.tab_switch_flag_limit,
      tab_switch_autosubmit_limit = excluded.tab_switch_autosubmit_limit,
      is_template = excluded.is_template, updated_at = now();

  -- ---- questions (manual selection): rewrite the list in the given order ----
  -- Live constraints: position > 0 and unique (exam_id, position) deferred.
  if v_sel = 'manual' then
    delete from public.exam_questions where exam_id = v_id;
    with ordered as (
      select jq->>'question_id' as qid,
             coalesce((jq->>'weight')::numeric, 1) as w,
             row_number() over () as pos
      from jsonb_array_elements(coalesce(p->'questions','[]'::jsonb)) jq
    )
    insert into public.exam_questions (exam_id, question_id, position, weight)
    select v_id, o.qid::uuid, o.pos, o.w from ordered o;
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, case when p_id is null then 'exam.create' else 'exam.update' end, 'exam', v_id,
          jsonb_build_object('title', p->>'title', 'status', v_status, 'access_code', v_code));

  return v_id;
end $$;

-- ============ the same invariant at Open ============
-- Carries TASK-031's open-code refusal (20261002000002) unchanged: this is a create-or-replace of the
-- function that migration defines, and applying them out of order would lose it.
create or replace function public.set_exam_status(p_id uuid, p_status text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_mode text; v_ends timestamptz; v_code text; v_template boolean;
begin
  if p_status not in ('draft','open','closed') then
    raise exception 'Status must be draft, open, or closed.' using hint = 'validation'; end if;
  select status, availability_mode, ends_at, access_code, is_template into v_status, v_mode, v_ends, v_code, v_template
    from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  if p_status = 'open' then
    -- TASK-032: an open template is a live exam nobody can join (`exam_join` refuses templates), so
    -- the list's Open button refuses it here and points at the way forward.
    if v_template then
      raise exception 'A template cannot be opened. Duplicate it and open the copy.' using hint = 'validation'; end if;
    if v_mode = 'manual' then
      if not exists (select 1 from public.exam_questions where exam_id = p_id) then
        raise exception 'Add questions before opening the exam.' using hint = 'validation';
      end if;
    end if;
    if v_mode = 'scheduled' and v_ends is null then
      raise exception 'A scheduled exam needs a closing time.' using hint = 'validation'; end if;
    -- TASK-031: the rule save_exam applies, said at the moment that used to be a 500. `_exam_is_open`
    -- covers a scheduled exam inside its window even while its status column is not yet 'open'.
    if exists (
      select 1 from public.exams x
      where x.access_code = v_code and x.id <> p_id
        and (x.status = 'open' or public._exam_is_open(x))
    ) then
      raise exception 'The test code % is already used by an open exam. Close that exam or give this one a different code.', v_code
        using hint = 'validation';
    end if;
  end if;
  update public.exams set status = p_status::public.exam_status, updated_at = now() where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.status', 'exam', p_id, jsonb_build_object('from', v_status, 'to', p_status));
end $$;

-- ============ the repair ============
-- An open exam marked as a template could never be joined (exam_join refuses templates), so the flag
-- is the bug, not the intent: clear it and the exam already open on a classroom board works again.
update public.exams set is_template = false, updated_at = now()
 where status = 'open' and is_template;

-- ============ the editor needs the attempt count ============
-- Same payload as before plus `session_count`; the editor disables the template checkbox when it is
-- greater than zero and says to duplicate the exam instead. `list_exams` has reported this since
-- ISSUE-023; this brings `get_exam` in line with it.
create or replace function public.get_exam(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v exam_questions%rowtype; e public.exams%rowtype; v_qs jsonb := '[]'::jsonb;
begin
  select * into e from public.exams where id = p_id;
  if not found then return null; end if;
  for v in select * from public.exam_questions where exam_id = p_id order by position loop
    v_qs := v_qs || jsonb_build_object('question_id', v.question_id, 'position', v.position, 'weight', v.weight);
  end loop;
  return to_jsonb(e) || jsonb_build_object('questions', v_qs,
    'session_count', (select count(*)::int from public.exam_sessions s where s.exam_id = p_id));
end $$;
