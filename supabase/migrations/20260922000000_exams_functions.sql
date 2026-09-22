-- TASK-009: exam business-rule functions (DEC-004).
-- Applied live on 2026-09-22 via `supabase db query --linked --file` (TASK-009 live step).
-- Idempotent: every object is `create or replace`; `list_exams` is dropped first because its
-- return type changed when the live enum columns were discovered.
-- Generated from the annotated source in docs/sql-exams.md — keep the two in sync.

-- ============ helpers ============
create or replace function public._exam_is_open(e public.exams)
returns boolean language sql stable as $$
  select e.status = 'open'
     or (e.availability_mode = 'scheduled'
         and now() between coalesce(e.starts_at, to_timestamp(0)) and coalesce(e.ends_at, to_timestamp('infinity','YYYY-MM-DD HH24:MI:SS')))
$$;

-- ============ list ============
drop function if exists public.list_exams(jsonb);
create or replace function public.list_exams(p jsonb default '{}')
returns table (id uuid, title text, status text, duration_minutes int, passing_grade int,
               availability_mode text, starts_at timestamptz, ends_at timestamptz,
               late_start_policy text, access_code text, selection_mode text, is_template boolean,
               question_count int, total_points numeric, created_at timestamptz)
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
           (select coalesce(sum(eq.weight),0)::numeric from public.exam_questions eq where eq.exam_id = e.id) as total_points
    from public.exams e
    where (v_only_tpl = false or e.is_template)
      and (v_status is null or e.status = v_status::public.exam_status)
      and (v_q is null or e.title ilike '%' || v_q || '%' or coalesce(e.description,'') ilike '%' || v_q || '%')
  )
  select b.id, b.title, b.status::text as status, b.duration_minutes, b.passing_grade,
         b.availability_mode::text as availability_mode, b.starts_at, b.ends_at, b.late_start_policy::text as late_start_policy,
         b.access_code, b.selection_mode::text as selection_mode, b.is_template,
         b.question_count, b.total_points, b.created_at
  from base b
  order by
    case v_sort when 'oldest' then b.created_at end asc nulls last,
    case v_sort when 'newest' then b.created_at end desc nulls last,
    case v_sort when 'status' then b.status end asc nulls last,
    case v_sort when 'title' then b.title end asc nulls last
  limit least(v_size,100) offset (greatest(v_page,1)-1)*least(v_size,100);
end $$;

-- ============ get (full exam incl. questions) ============
create or replace function public.get_exam(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v exam_questions%rowtype; e public.exams%rowtype; v_qs jsonb := '[]'::jsonb;
begin
  select * into e from public.exams where id = p_id;
  if not found then return null; end if;
  for v in select * from public.exam_questions where exam_id = p_id order by position loop
    v_qs := v_qs || jsonb_build_object('question_id', v.question_id, 'position', v.position, 'weight', v.weight);
  end loop;
  return to_jsonb(e) || jsonb_build_object('questions', v_qs);
end $$;

-- ============ save (insert or update) ============
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

-- ============ remove (drafts and templates only) ============
create or replace function public.remove_exam(p_id uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text; v_sessions int;
begin
  select status into v_status from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  select count(*) into v_sessions from public.exam_sessions where exam_id = p_id;
  if v_sessions > 0 then
    update public.exams set status = 'closed', updated_at = now() where id = p_id;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
    values (p_actor, 'exam.close', 'exam', p_id, jsonb_build_object('reason', 'delete requested while sessions exist'));
    return 'closed';
  end if;
  delete from public.exam_questions where exam_id = p_id;
  delete from public.exams where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.delete', 'exam', p_id, '{}');
  return 'deleted';
end $$;

-- ============ status transitions (BR-03, BR-04) ============
create or replace function public.set_exam_status(p_id uuid, p_status text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_mode text; v_ends timestamptz; v_qs int;
begin
  if p_status not in ('draft','open','closed') then
    raise exception 'Status must be draft, open, or closed.' using hint = 'validation'; end if;
  select status, availability_mode, ends_at into v_status, v_mode, v_ends from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  if p_status = 'open' then
    if v_mode = 'manual' then
      if not exists (select 1 from public.exam_questions where exam_id = p_id) then
        raise exception 'Add questions before opening the exam.' using hint = 'validation';
      end if;
    end if;
    if v_mode = 'scheduled' and v_ends is null then
      raise exception 'A scheduled exam needs a closing time.' using hint = 'validation'; end if;
  end if;
  update public.exams set status = p_status::public.exam_status, updated_at = now() where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.status', 'exam', p_id, jsonb_build_object('from', v_status, 'to', p_status));
end $$;

-- ============ codes (BR-17) ============
create or replace function public.exam_code_available(p_code text, p_exclude uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.exams x
    where upper(regexp_replace(p_code, '\s', '', 'g')) = x.access_code
      and x.id is distinct from p_exclude
      and (x.status = 'open' or public._exam_is_open(x))
  );
$$;

create or replace function public.regenerate_exam_code(p_id uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_new text; v_tries int := 0;
begin
  loop
    -- six characters from the confusion-safe alphabet (same as _shared/codes.ts)
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

-- ============ duplicate as draft (templates) ============
create or replace function public.duplicate_exam(p_id uuid, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.exams%rowtype; v_id uuid;
begin
  select * into v from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  insert into public.exams (title, description, status, duration_minutes, passing_grade, availability_mode,
      starts_at, ends_at, late_start_policy, access_code, selection_mode, auto_filter, pool_size,
      draw_per_student, randomize_questions, randomize_options, result_visibility,
      essay_pending_display, tab_switch_warn_limit, tab_switch_flag_limit, tab_switch_autosubmit_limit,
      is_template, created_by)
  values (v.title || ' (copy)', v.description, 'draft', v.duration_minutes, v.passing_grade, v.availability_mode,
      null, null, v.late_start_policy,
      -- a fresh confusion-safe code (live CHECK requires ^[A-Z0-9]{4,12}$); save_exam may replace it later
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
