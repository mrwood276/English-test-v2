-- TASK-XXX (2026-10-04): teacher data isolation — the exams slice (DEC-041).
--
-- Same rule the question bank slice (TASK-048) enforced on questions and passages:
-- a teacher sees and changes only their own exams; an active admin sees the whole school;
-- students are untouched (they join by access code and never touch the exams domain).
--
-- What changes:
--   * `list_exams` and `get_exam` gain a required `p_actor` and scope rows to
--     `public._is_staff_admin(p_actor) or created_by = p_actor`'s; a null or foreign actor
--     returns null / the "no longer exists" sentence, so nothing leaks existence.
--   * The write functions already carry `p_actor`; each gains the same ownership condition
--     (save_exam on update, set_exam_status, remove_exam, regenerate_exam_code,
--     duplicate_exam, bulk_exam_questions — the latter also refuses question ids the actor
--     does not own, which the question-bank slice already scopes).
--   * The old read signatures are dropped: leaving them would leave unscoped functions behind.
--
-- APPLIED LIVE: <date> after TASK-048 (`20261003000000`), as ONE Management API request
-- with its ledger row, and `supabase/tests/exam_isolation_test.sql` passed live against it;
-- the `exams` Edge Function was redeployed immediately after (p_actor now flows to list/get).

-- ============ list exams, scoped to the caller ============
drop function if exists public.list_exams(jsonb);
create or replace function public.list_exams(p jsonb default '{}', p_actor uuid default null)
returns table (id uuid, title text, status text, duration_minutes int, passing_grade int,
               availability_mode text, starts_at timestamptz, ends_at timestamptz,
               late_start_policy text, access_code text, selection_mode text, is_template boolean,
               question_count int, total_points numeric, created_at timestamptz, session_count int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(trim(coalesce(p->>'q','')), '');
  v_status text := nullif(p->>'status','');
  v_sort text := coalesce(nullif(p->>'sort',''), 'newest');
  v_page int := coalesce((p->>'page')::int, 1);
  v_size int := coalesce((p->>'page_size')::int, 100);
  v_only_tpl boolean := coalesce((p->>'template_only')::boolean, false);
begin
  return query
  with base as (
    select e.*,
           (select count(*)::int from public.exam_questions eq where eq.exam_id = e.id) as question_count,
           (select coalesce(sum(eq.weight),0)::numeric from public.exam_questions eq where eq.exam_id = e.id) as total_points,
           (select count(*)::int from public.exam_sessions es where es.exam_id = e.id) as session_count
    from public.exams e
    where (public._is_staff_admin(p_actor) or e.created_by = p_actor)
      and (v_only_tpl = false or e.is_template)
      and (v_status is null or e.status = v_status::public.exam_status)
      and (v_q is null or e.title ilike '%' || v_q || '%' or coalesce(e.description,'') ilike '%' || v_q || '%')
  )
  select b.id, b.title, b.status::text as status, b.duration_minutes, b.passing_grade,
         b.availability_mode::text as availability_mode, b.starts_at, b.ends_at, b.late_start_policy::text as late_start_policy,
         b.access_code, b.selection_mode::text as selection_mode, b.is_template,
         b.question_count, b.total_points, b.created_at, b.session_count
  from base b
  order by
    case v_sort when 'oldest' then b.created_at end asc nulls last,
    case v_sort when 'newest' then b.created_at end desc nulls last,
    case v_sort when 'status' then b.status end asc nulls last,
    case v_sort when 'title' then b.title end asc nulls last
  limit least(v_size,100) offset (greatest(v_page,1)-1)*least(v_size,100);
end $$;

-- ============ get one exam, scoped to the caller ============
drop function if exists public.get_exam(uuid);
create or replace function public.get_exam(p_id uuid, p_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v exam_questions%rowtype; e public.exams%rowtype; v_qs jsonb := '[]'::jsonb;
begin
  select * into e from public.exams where id = p_id;
  if not found then return null; end if;
  if not (public._is_staff_admin(p_actor) or e.created_by = p_actor) then
    return null; -- a foreign id answers exactly what a missing one answers
  end if;
  for v in select * from public.exam_questions where exam_id = p_id order by position loop
    v_qs := v_qs || jsonb_build_object('question_id', v.question_id, 'position', v.position, 'weight', v.weight);
  end loop;
  return to_jsonb(e) || jsonb_build_object('questions', v_qs,
    'session_count', (select count(*)::int from public.exam_sessions s where s.exam_id = p_id));
end $$;

-- ============ writes: refuse foreign ids with the friendly sentence ============
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
  -- a new exam is always created by the caller; editing one requires ownership
  select status into v_existing_status from public.exams where id = v_id;
  if found and not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = v_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
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

  if found then
    if v_existing_status = 'open' and coalesce(p->>'status', v_existing_status) = 'open'
       and (coalesce((p->>'duration_minutes')::int, 0) <> (select duration_minutes from public.exams where id = v_id)) then
      raise exception 'Stop the exam before changing its duration.' using hint = 'validation';
    end if;
  end if;

  if exists (
    select 1 from public.exams x
    where x.access_code = v_code and x.id is distinct from v_id
      and (x.status = 'open' or public._exam_is_open(x))
  ) then
    raise exception 'The test code % is already used by an open exam.', v_code using hint = 'validation';
  end if;

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

create or replace function public.set_exam_status(p_id uuid, p_status text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_mode text; v_ends timestamptz; v_code text; v_template boolean;
begin
  if p_status not in ('draft','open','closed') then
    raise exception 'Status must be draft, open, or closed.' using hint = 'validation'; end if;
  select status, availability_mode, ends_at, access_code, is_template into v_status, v_mode, v_ends, v_code, v_template
    from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  if not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = p_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  if p_status = 'open' then
    if v_template then
      raise exception 'A template cannot be opened. Duplicate it and open the copy.' using hint = 'validation'; end if;
    if v_mode = 'manual' then
      if not exists (select 1 from public.exam_questions where exam_id = p_id) then
        raise exception 'Add questions before opening the exam.' using hint = 'validation';
      end if;
    end if;
    if v_mode = 'scheduled' and v_ends is null then
      raise exception 'A scheduled exam needs a closing time.' using hint = 'validation'; end if;
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

create or replace function public.remove_exam(p_id uuid, p_actor uuid, p_force boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v_sessions int;
begin
  if not exists (select 1 from public.exams where id = p_id) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  if not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = p_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  select count(*) into v_sessions from public.exam_sessions where exam_id = p_id;

  if v_sessions > 0 and not coalesce(p_force, false) then
    update public.exams set status = 'closed', updated_at = now() where id = p_id;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
    values (p_actor, 'exam.close', 'exam', p_id,
            jsonb_build_object('reason', 'delete requested while sessions exist', 'attempts', v_sessions));
    return 'closed';
  end if;

  delete from public.exam_questions where exam_id = p_id;
  delete from public.exam_sessions where exam_id = p_id;
  delete from public.exams where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.delete', 'exam', p_id,
          case when v_sessions > 0
               then jsonb_build_object('attempts', v_sessions, 'permanent', true)
               else '{}'::jsonb end);
  return 'deleted';
end $$;

create or replace function public.regenerate_exam_code(p_id uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_new text; v_tries int := 0;
begin
  if not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = p_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', ((random()*31)::int % 31) + 1, 1), '')
      into v_new from generate_series(1, 6);
    exit when public.exam_code_available(v_new, p_id) or v_tries > 50;
    v_tries := v_tries + 1;
  end loop;
  update public.exams set access_code = v_new, updated_at = now() where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.code', 'exam', p_id, jsonb_build_object('new_code', v_new));
  return v_new;
end $$;

create or replace function public.duplicate_exam(p_id uuid, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.exams%rowtype; v_id uuid;
begin
  select * into v from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  if not (public._is_staff_admin(p_actor) or v.created_by = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  insert into public.exams (title, description, status, duration_minutes, passing_grade, availability_mode,
      starts_at, ends_at, late_start_policy, access_code, selection_mode, auto_filter, pool_size,
      draw_per_student, randomize_questions, randomize_options, result_visibility,
      essay_pending_display, tab_switch_warn_limit, tab_switch_flag_limit, tab_switch_autosubmit_limit,
      is_template, created_by)
  values (v.title || ' (copy)', v.description, 'draft', v.duration_minutes, v.passing_grade, v.availability_mode,
      null, null, v.late_start_policy,
      (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', ((random()*31)::int % 31) + 1, 1), '') from generate_series(1, 6)),
      v.selection_mode, v.auto_filter,
      v.pool_size, v.draw_per_student, v.randomize_questions, v.randomize_options, v.result_visibility,
      v.essay_pending_display, v.tab_switch_warn_limit, v.tab_switch_flag_limit, v.tab_switch_autosubmit_limit,
      false, p_actor)
  returning id into v_id;
  insert into public.exam_questions (exam_id, question_id, position, weight)
  select v_id, question_id, position, weight from public.exam_questions where exam_id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.duplicate', 'exam', v_id, jsonb_build_object('source', p_id));
  return v_id;
end $$;

-- ============ bulk questions: exam owner and question owner only ============
create or replace function public.bulk_exam_questions(p_exam_id uuid, p_mode text, p_ids uuid[], p_actor uuid)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_mode text := lower(btrim(coalesce(p_mode, '')));
  v_ids uuid[] := coalesce(p_ids, '{}'::uuid[]);
  v_selected int;
  v_title text;
  v_status text;
  v_selection text;
  v_sessions int;
  v_found int := 0;
  v_on int := 0;
  v_archived int := 0;
  v_exam_count int := 0;
  v_next int := 0;
  v_updated int := 0;
begin
  v_selected := coalesce(array_length(v_ids, 1), 0);

  if v_mode not in ('add', 'remove') then
    raise exception 'Choose whether to add or remove questions.' using hint = 'validation';
  end if;
  if v_selected = 0 then
    raise exception 'Select at least one question.' using hint = 'validation'; end if;
  if v_selected > 500 then
    raise exception 'Change at most 500 questions at once.' using hint = 'validation'; end if;

  select e.title, e.status::text, e.selection_mode::text
    into v_title, v_status, v_selection
    from public.exams e
   where e.id = p_exam_id;
  if not found then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  if not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = p_exam_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  if v_selection <> 'manual' then
    raise exception 'This exam draws its questions by a filter, so it has no fixed question list.' using hint = 'validation';
  end if;
  if v_status = 'open' then
    raise exception 'Close the exam before changing its questions.' using hint = 'validation';
  end if;
  select count(*) into v_sessions from public.exam_sessions s where s.exam_id = p_exam_id;
  if v_sessions > 0 then
    raise exception 'This exam already has attempts, so its questions stay as they were. Duplicate the exam to change them.' using hint = 'validation';
  end if;

  -- only questions the caller owns (or all, if the caller is an active admin) count as found
  select count(*) into v_found from public.questions q
   where q.id = any(v_ids)
     and (public._is_staff_admin(p_actor) or q.created_by = p_actor);
  if v_found = 0 then
    raise exception 'Those questions no longer exist. Refresh the list and try again.' using hint = 'validation';
  end if;
  select count(*) into v_on from public.exam_questions eq
   where eq.exam_id = p_exam_id and eq.question_id = any(v_ids);

  if v_mode = 'add' then
    select count(*) into v_archived from public.questions q
     where q.id = any(v_ids) and q.is_archived
       and (public._is_staff_admin(p_actor) or q.created_by = p_actor);
    if v_archived > 0 then
      raise exception 'Some of those questions are archived. Restore them first, or leave them out.' using hint = 'validation';
    end if;

    select count(*) into v_exam_count from public.exam_questions eq where eq.exam_id = p_exam_id;
    if v_exam_count + (v_found - v_on) > 200 then
      raise exception 'An exam can hold at most 200 questions.' using hint = 'validation';
    end if;

    select coalesce(max(eq.position), 0) into v_next from public.exam_questions eq where eq.exam_id = p_exam_id;

    with wanted as (
      select ord.id, ord.rn
        from unnest(v_ids) with ordinality as ord(id, rn)
       where not exists (
          select 1 from public.exam_questions eq
           where eq.exam_id = p_exam_id and eq.question_id = ord.id
       )
          and exists (select 1 from public.questions q where q.id = ord.id
                      and (public._is_staff_admin(p_actor) or q.created_by = p_actor))
    ), numbered as (
      select w.id, row_number() over (order by w.rn) as rn from wanted w
    ), added as (
      insert into public.exam_questions (exam_id, question_id, position, weight)
      select p_exam_id, n.id, v_next + n.rn, q.default_weight
        from numbered n
        join public.questions q on q.id = n.id
      returning 1 as one
    )
    select count(*) into v_updated from added;
  else
    with gone as (
      delete from public.exam_questions eq
       where eq.exam_id = p_exam_id and eq.question_id = any(v_ids)
      returning 1 as one
    )
    select count(*) into v_updated from gone;

    update public.exam_questions eq
       set position = numbered.rn
      from (
        select eq2.question_id, row_number() over (order by eq2.position) as rn
          from public.exam_questions eq2
         where eq2.exam_id = p_exam_id
      ) numbered
     where eq.exam_id = p_exam_id and eq.question_id = numbered.question_id
       and eq.position <> numbered.rn;
  end if;

  perform public.write_audit(p_actor, 'exam.questions', 'exam', p_exam_id::text,
    jsonb_build_object(
      'mode', v_mode,
      'title', v_title,
      'count', v_updated,
      'selected', v_selected,
      'matched', case when v_mode = 'add' then v_found else v_on end,
      'unchanged', case when v_mode = 'add' then v_on else (v_found - v_on) end,
      'missing', v_selected - v_found
    ));

  return jsonb_build_object(
    'matched', case when v_mode = 'add' then v_found else v_on end,
    'updated', v_updated,
    'unchanged', case when v_mode = 'add' then v_on else (v_found - v_on) end,
    'missing', v_selected - v_found
  );
end $$;

-- The boundary: only the service role executes these; anon and authenticated do not.
revoke execute on function public.list_exams(jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.get_exam(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.save_exam(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.set_exam_status(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.remove_exam(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.regenerate_exam_code(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.duplicate_exam(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.list_exams(jsonb, uuid) to service_role;
grant execute on function public.get_exam(uuid, uuid) to service_role;
grant execute on function public.save_exam(uuid, jsonb, uuid) to service_role;
grant execute on function public.set_exam_status(uuid, text, uuid) to service_role;
grant execute on function public.remove_exam(uuid, uuid, boolean) to service_role;
grant execute on function public.regenerate_exam_code(uuid, uuid) to service_role;
grant execute on function public.duplicate_exam(uuid, uuid) to service_role;
grant execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) to service_role;
