-- ISSUE-023: deleting an exam that already has attempts.
--
-- Until now `remove_exam` silently closed such an exam and answered 'closed', while the screen's
-- confirmation had just promised it "will be removed" - so a teacher could click Delete, see the exam
-- come back (now closed), and click again (the owner did exactly that five times on 2026-09-25).
--
-- The rule stays (BR-10 / DEC-012: attempts and results are never lost), but it is now explicit:
--   * `list_exams` also reports `session_count`, so the screen can say what will happen *before* the click;
--   * `remove_exam` only really deletes an exam that has attempts when the caller passes p_force = true,
--     which the `exams` Edge Function does only for the admin role, after an extra confirmation;
--   * a teacher's request keeps the old close-instead-of-delete behaviour.
--
-- Idempotent: `list_exams` and `remove_exam` are re-created; the old two-argument `remove_exam` is dropped
-- because the parameter list changes (Postgres identifies functions by name *and* argument types, so
-- leaving it would create a second, force-less overload that could still be called).

-- ============ list: also say how many attempts an exam has ============
drop function if exists public.list_exams(jsonb);
create or replace function public.list_exams(p jsonb default '{}')
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
    where (v_only_tpl = false or e.is_template)
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

-- ============ remove ============
drop function if exists public.remove_exam(uuid, uuid);
create or replace function public.remove_exam(p_id uuid, p_actor uuid, p_force boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v_sessions int;
begin
  if not exists (select 1 from public.exams where id = p_id) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  select count(*) into v_sessions from public.exam_sessions where exam_id = p_id;

  -- Attempts exist and the permanent delete was not explicitly asked for: close it and say so.
  if v_sessions > 0 and not coalesce(p_force, false) then
    update public.exams set status = 'closed', updated_at = now() where id = p_id;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
    values (p_actor, 'exam.close', 'exam', p_id,
            jsonb_build_object('reason', 'delete requested while sessions exist', 'attempts', v_sessions));
    return 'closed';
  end if;

  delete from public.exam_questions where exam_id = p_id;
  -- exam_sessions is `on delete restrict` from exams, so the attempts go first; their answers, grades,
  -- results and events cascade from the session rows (v2_04).
  delete from public.exam_sessions where exam_id = p_id;
  delete from public.exams where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.delete', 'exam', p_id,
          case when v_sessions > 0
               then jsonb_build_object('attempts', v_sessions, 'permanent', true)
               else '{}'::jsonb end);
  return 'deleted';
end $$;

revoke execute on function public.list_exams(jsonb) from public, anon, authenticated;
revoke execute on function public.remove_exam(uuid, uuid, boolean) from public, anon, authenticated;
