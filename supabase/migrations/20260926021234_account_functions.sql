-- TASK-015 (user management): design.md's User Management module — "Buat dan nonaktifkan akun guru/admin"
-- (create and deactivate teacher/admin accounts; design.md 1.2 makes it an admin job). The owner's decision
-- (DEC-031): the admin types the teacher's email and a temporary password and hands it over, and an account
-- is **deactivated, never deleted** — a profile is the target of the audit trail and of the rows it created
-- (`created_by`), and its id is the auth user's id, so "recreating" one is not the same account.
--
-- Creating the Auth half is the Auth Admin API, which only the Edge layer can call (`accounts` function).
-- This file keeps the *bookkeeping* honest: the `profiles` row, the audit entries, and the two rules that
-- must never break —
--   * nobody may change their own role or deactivate themselves (an admin's last mistake would otherwise
--     lock them out), and
--   * the last active admin cannot be demoted or deactivated (that would leave nobody able to administer
--     the project at all).
-- The guards live here, not in JavaScript, so they hold for every caller (DEC-004).
--
-- APPLIED LIVE (2026-09-26); the live migration-tracking row is `20260926021234` / `account_functions`.
-- To run SQL here: CLI 2.117.0 has no `supabase db query` subcommand — use the Management API query
-- endpoint (POST /v1/projects/<ref>/database/query with {"query": "..."}) or the dashboard SQL editor.

-- ---------- only an active admin may manage accounts ----------
-- The Edge layer already refuses everybody else; this is the same rule at the layer that owns the data.
create or replace function public._require_active_admin(p_actor uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null then
    raise exception 'Somebody has to be signed in to manage accounts.' using hint = 'validation';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'admin' and p.is_active) then
    raise exception 'Only an admin can manage accounts.' using hint = 'validation';
  end if;
end $$;

-- ---------- the list the admin screen shows ----------
-- The email and the last sign-in live in `auth.users`; a public function may read them because it runs as
-- the table's owner and the Edge function has already checked who is asking. Admins come first, then names.
create or replace function public.list_accounts() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.profiles),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'email', u.email,
               'full_name', p.full_name,
               'role', p.role,
               'is_active', p.is_active,
               'created_at', p.created_at,
               'last_sign_in_at', u.last_sign_in_at
             ) order by (p.role = 'admin') desc, lower(p.full_name))
      from public.profiles p
      join auth.users u on u.id = p.id
    ), '[]'::jsonb)
  )
$$;

-- ---------- one account's bookkeeping row ----------
create or replace function public.record_account(
  p_id uuid,
  p_email text,
  p_full_name text,
  p_role public.user_role,
  p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_full_name, ''));
  v_row jsonb;
begin
  if p_id is null then
    raise exception 'An account id is required.' using hint = 'validation';
  end if;
  if p_role is null then
    raise exception 'An account needs a role (teacher or admin).' using hint = 'validation';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'A name must be between 1 and 120 characters.' using hint = 'validation';
  end if;
  perform public._require_active_admin(p_actor);

  if exists (select 1 from public.profiles p where p.id = p_id) then
    raise exception 'That account already exists.' using hint = 'validation';
  end if;

  insert into public.profiles (id, full_name, role) values (p_id, v_name, p_role);

  perform public.write_audit(
    p_actor, 'account.create', 'account', p_id::text,
    jsonb_build_object('email', p_email, 'full_name', v_name, 'role', p_role)
  );

  select jsonb_build_object(
           'id', p.id, 'email', p_email, 'full_name', p.full_name, 'role', p.role,
           'is_active', p.is_active, 'created_at', p.created_at
         )
    into v_row
  from public.profiles p where p.id = p_id;
  return v_row;
end $$;

-- ---------- name, role, active — with the two guards ----------
create or replace function public.update_account(
  p_id uuid,
  p_full_name text,
  p_role public.user_role,
  p_is_active boolean,
  p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.profiles;
  v_name text;
  v_role public.user_role;
  v_active boolean;
  v_admins int;
begin
  if p_id is null then
    raise exception 'An account id is required.' using hint = 'validation';
  end if;
  perform public._require_active_admin(p_actor);

  select * into v_before from public.profiles p where p.id = p_id;
  if v_before.id is null then
    raise exception 'That account no longer exists.' using hint = 'validation';
  end if;

  v_name := case when p_full_name is null then v_before.full_name else btrim(p_full_name) end;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'A name must be between 1 and 120 characters.' using hint = 'validation';
  end if;
  v_role := coalesce(p_role, v_before.role);
  v_active := coalesce(p_is_active, v_before.is_active);

  -- Guard 1: an admin cannot demote or deactivate the account they are using. Getting this wrong is a
  -- one-keypress way to lose the administration of the project.
  if p_id = p_actor and (v_role <> v_before.role or not v_active) then
    raise exception 'You cannot change your own role or deactivate your own account.' using hint = 'validation';
  end if;

  -- Guard 2: whatever happens, one active admin remains.
  if v_before.role = 'admin' and v_before.is_active and (v_role <> 'admin' or not v_active) then
    select count(*) into v_admins from public.profiles p where p.role = 'admin' and p.is_active;
    if v_admins <= 1 then
      raise exception 'This is the only active admin: somebody has to be able to administer the project.' using hint = 'validation';
    end if;
  end if;

  update public.profiles p
     set full_name = v_name, role = v_role, is_active = v_active
   where p.id = p_id;

  perform public.write_audit(
    p_actor, 'account.update', 'account', p_id::text,
    jsonb_build_object(
      'full_name', v_name, 'role', v_role, 'is_active', v_active,
      'was', jsonb_build_object('full_name', v_before.full_name, 'role', v_before.role, 'is_active', v_before.is_active)
    )
  );

  return jsonb_build_object('id', p_id, 'full_name', v_name, 'role', v_role, 'is_active', v_active);
end $$;

-- ---------- a password was set for somebody (never the password itself) ----------
create or replace function public.record_account_password(p_id uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null then
    raise exception 'An account id is required.' using hint = 'validation';
  end if;
  perform public._require_active_admin(p_actor);
  if not exists (select 1 from public.profiles p where p.id = p_id) then
    raise exception 'That account no longer exists.' using hint = 'validation';
  end if;

  perform public.write_audit(
    p_actor, 'account.password', 'account', p_id::text,
    jsonb_build_object('note', 'a new password was set by an admin')
  );
  return jsonb_build_object('id', p_id, 'changed', true);
end $$;

revoke execute on function public._require_active_admin(uuid) from public, anon, authenticated;
revoke execute on function public.list_accounts() from public, anon, authenticated;
revoke execute on function public.record_account(uuid, text, text, public.user_role, uuid) from public, anon, authenticated;
revoke execute on function public.update_account(uuid, text, public.user_role, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.record_account_password(uuid, uuid) from public, anon, authenticated;
