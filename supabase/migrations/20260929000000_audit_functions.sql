-- TASK-015 (audit-log viewer): the read side of `audit_logs`. Every staff action has written an
-- audit row inside its SQL function since v2_08 (BR-13); this adds the one read function the
-- admin viewer needs. No table changes.
--
-- The viewer is admin-only at the Edge (design.md 1.2: teachers cannot manage the system's audit
-- log); the function itself stays service-role-only like everything else (DEC-002, ISSUE-020).
--
-- Applied live: NOT YET — this file landed in git first. Run it with a live connection:
--   npx supabase db query --linked --file supabase/migrations/20260929000000_audit_functions.sql
-- then deploy the new `audit` Edge Function (see 08_HANDOFF.md). Until then the screen shows
-- nothing real because the function does not exist live yet.

create or replace function public.list_audit_logs(
  p_limit int default 50,
  p_offset int default 0,
  p_action text default null,
  p_entity_type text default null,
  p_days int default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int := coalesce(p_limit, 50);
  v_offset int := coalesce(p_offset, 0);
begin
  -- The same validation the Edge layer already does; a person-fixable problem still arrives as a friendly 400.
  if v_limit < 1 or v_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;
  if v_offset < 0 then
    raise exception 'Offset cannot be negative.' using hint = 'validation';
  end if;
  if p_action is not null and (length(p_action) < 1 or length(p_action) > 80) then
    raise exception 'Action filter must be between 1 and 80 characters.' using hint = 'validation';
  end if;
  if p_entity_type is not null and (length(p_entity_type) < 1 or length(p_entity_type) > 60) then
    raise exception 'Entity type filter must be between 1 and 60 characters.' using hint = 'validation';
  end if;
  if p_days is not null and (p_days < 1 or p_days > 3650) then
    raise exception 'Days must be between 1 and 3650.' using hint = 'validation';
  end if;

  return jsonb_build_object(
    'total', (
      select count(*)
      from public.audit_logs l
      where (p_action is null or l.action = p_action)
        and (p_entity_type is null or l.entity_type = p_entity_type)
        and (p_days is null or l.created_at >= now() - make_interval(days => p_days))
    ),
    'rows', coalesce((
      select jsonb_agg(page.row_json order by page.created_at desc, page.id desc)
      from (
        select jsonb_build_object(
                 'id', l.id,
                 'created_at', l.created_at,
                 'actor_id', l.actor_id,
                 'actor_name', p.full_name,
                 'action', l.action,
                 'entity_type', l.entity_type,
                 'entity_id', l.entity_id,
                 'changes', l.changes
               ) as row_json,
               l.created_at, l.id
        from public.audit_logs l
        left join public.profiles p on p.id = l.actor_id
        where (p_action is null or l.action = p_action)
          and (p_entity_type is null or l.entity_type = p_entity_type)
          and (p_days is null or l.created_at >= now() - make_interval(days => p_days))
        order by l.created_at desc, l.id desc
        limit v_limit offset v_offset
      ) page
    ), '[]'::jsonb)
  );
end $$;

revoke execute on function public.list_audit_logs(int, int, text, text, int) from public, anon, authenticated;
