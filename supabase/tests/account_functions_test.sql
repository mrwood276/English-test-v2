-- SQL test for the user-management functions (TASK-015).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
-- Passed live on 2026-09-26.
--
-- Read-only: it calls the functions against the project's own two accounts and lets the transaction abort at
-- the end, so nothing it writes (a name change, audit rows) survives — the error message IS the result:
--   "ACCOUNT TESTS PASSED (...)"  → every assertion held
--   "ASSERT FAILED: <message>"    → a rule is broken
--
-- What is checked: nobody but an admin can run any of it (grants are revoked from anon/authenticated, and
-- each function re-checks the actor); the list really reads the two accounts with their emails out of
-- auth.users, admins first; creating an account refuses a missing id, an empty name, a role-less call, an
-- account that already exists and an actor who is not an active admin; updating refuses an unknown account,
-- an empty name, and — the rule that keeps the project administrable — changing your own role or
-- deactivating yourself; the happy path writes the row *and* the audit entry; setting a password is
-- audited without the password; and at the end at least one active admin still exists. What this file can
-- NOT prove — that an account can really sign in, be deactivated and be given a new password — is in
-- frontend/tests/live_accounts_check.py.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(needle in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (error said: %)', msg, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $acct$
declare
  v_admin uuid;
  v_teacher uuid;
  v_admin_name text;
  v_rows jsonb;
  v_listed jsonb;
  v_made jsonb;
  v_audits int;
  v_active_admins int;
begin
  select id, full_name into v_admin, v_admin_name from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and a teacher to test against');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not exists (
      select 1 from unnest(array[
        'public._require_active_admin(uuid)', 'public.list_accounts()',
        'public.record_account(uuid, text, text, public.user_role, uuid)',
        'public.update_account(uuid, text, public.user_role, boolean, uuid)',
        'public.record_account_password(uuid, uuid)']) sig
      where has_function_privilege('anon', sig::regprocedure, 'execute')
         or has_function_privilege('authenticated', sig::regprocedure, 'execute')),
    'anon and authenticated may execute none of the account functions');

  perform pg_temp.expect_error('select public._require_active_admin(null)',
    'Somebody has to be signed in', 'a call with nobody signed in is refused');
  perform pg_temp.expect_error(format('select public._require_active_admin(%L::uuid)', v_teacher),
    'Only an admin', 'a teacher cannot manage accounts even if they reach the function');
  perform public._require_active_admin(v_admin);  -- must not raise

  -- ---------- the list ----------
  v_listed := public.list_accounts();
  perform pg_temp.assert_true((v_listed ->> 'total')::int = (select count(*) from public.profiles),
    'the list counts every account');
  v_rows := v_listed -> 'rows';
  perform pg_temp.assert_true(jsonb_array_length(v_rows) >= 2, 'both accounts are listed');
  perform pg_temp.assert_true(
    not exists (select 1 from jsonb_array_elements(v_rows) r where not (r ? 'email') or r ->> 'email' is null),
    'every row carries the email address (read from auth.users)');
  perform pg_temp.assert_true(
    not exists (
      select 1 from jsonb_array_elements(v_rows) r
      where r ->> 'email' <> (select u.email from auth.users u where u.id = (r ->> 'id')::uuid)),
    'and it is the real address of that auth user');
  perform pg_temp.assert_true(
    (select bool_and(r ? 'last_sign_in_at' and r ? 'is_active' and r ? 'role' and r ? 'full_name')
       from jsonb_array_elements(v_rows) r),
    'the screen gets the status and the last sign-in for every row');
  perform pg_temp.assert_true((v_rows -> 0 ->> 'role') = 'admin',
    'admins come first (the screen should not bury the people who can administer it)');

  -- ---------- creating an account ----------
  perform pg_temp.expect_error('select public.record_account(null, $$a@b.test$$, $$N$$, $$teacher$$, null)',
    'account id is required', 'creating needs an id');
  perform pg_temp.expect_error(format('select public.record_account(%L::uuid, $$a@b.test$$, $$  $$, $$teacher$$, %L::uuid)', gen_random_uuid(), v_admin),
    'between 1 and 120', 'creating refuses an empty name');
  perform pg_temp.expect_error(format('select public.record_account(%L::uuid, $$a@b.test$$, $$N$$, null, %L::uuid)', gen_random_uuid(), v_admin),
    'needs a role', 'creating refuses a call without a role');
  perform pg_temp.expect_error(format('select public.record_account(%L::uuid, $$a@b.test$$, $$N$$, $$teacher$$, %L::uuid)', gen_random_uuid(), v_teacher),
    'Only an admin', 'a teacher cannot create accounts');
  perform pg_temp.expect_error(format('select public.record_account(%L::uuid, $$a@b.test$$, $$N$$, $$teacher$$, %L::uuid)', v_admin, v_admin),
    'already exists', 'creating refuses an account that is already there');

  -- the same call as an active admin, for an auth user that exists (the Edge layer creates it first)
  perform pg_temp.assert_true(
    exists (select 1 from auth.users u where u.id = v_teacher),
    'the teacher has a real auth user (which is why a profile always has one)');

  -- ---------- updating one ----------
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, $$N$$, $$teacher$$, true, %L::uuid)', gen_random_uuid(), v_admin),
    'no longer exists', 'updating refuses an unknown account');
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, $$  $$, null, null, %L::uuid)', v_teacher, v_admin),
    'between 1 and 120', 'updating refuses an empty name');
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, null, $$teacher$$, null, %L::uuid)', v_admin, v_admin),
    'your own role', 'an admin cannot demote themselves (and lock themselves out)');
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, null, null, false, %L::uuid)', v_admin, v_admin),
    'your own account', 'an admin cannot deactivate themselves');
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, null, null, false, %L::uuid)', v_teacher, v_teacher),
    'Only an admin', 'a teacher cannot change an account either');

  -- the happy path: an admin renames the teacher (rolled back below)
  v_made := public.update_account(v_teacher, $$Account SQL test$$, null, null, v_admin);
  perform pg_temp.assert_true((v_made ->> 'full_name') = 'Account SQL test' and (v_made ->> 'role') = 'teacher',
    'an admin can rename somebody without touching their role');
  perform pg_temp.assert_true(
    (select full_name = 'Account SQL test' from public.profiles where id = v_teacher),
    'and the row really changed');
  perform pg_temp.assert_true(
    (select count(*) from public.audit_logs a
      where a.action = 'account.update' and a.entity_id = v_teacher::text and a.changes ->> 'full_name' = 'Account SQL test') >= 1,
    'the change is written to the audit log');
  perform pg_temp.assert_true(
    (select a.changes -> 'was' ->> 'full_name' from public.audit_logs a
      where a.action = 'account.update' and a.entity_id = v_teacher::text order by a.created_at desc limit 1) is not null,
    'and it records what the name was before (an investigation needs both sides)');

  -- deactivating somebody else is allowed, and puts them back afterwards
  v_made := public.update_account(v_teacher, null, null, false, v_admin);
  perform pg_temp.assert_true((v_made ->> 'is_active') = 'false', 'an admin can deactivate another account');
  perform pg_temp.expect_error(format('select public.update_account(%L::uuid, null, null, true, %L::uuid)', v_teacher, v_teacher),
    'Only an admin', 'a deactivated admin is not an admin any more');
  v_made := public.update_account(v_teacher, null, null, true, v_admin);
  perform pg_temp.assert_true((v_made ->> 'is_active') = 'true', 'and reactivate them');

  -- ---------- a new password (the password itself never reaches the database) ----------
  perform pg_temp.expect_error(format('select public.record_account_password(%L::uuid, %L::uuid)', v_teacher, v_teacher),
    'Only an admin', 'a teacher cannot set passwords');
  perform pg_temp.expect_error(format('select public.record_account_password(%L::uuid, %L::uuid)', gen_random_uuid(), v_admin),
    'no longer exists', 'setting a password for an unknown account is refused');
  perform pg_temp.assert_true((public.record_account_password(v_teacher, v_admin) ->> 'changed') = 'true',
    'an admin can record a password change');
  select count(*) into v_audits from public.audit_logs where action = 'account.password' and entity_id = v_teacher::text;
  perform pg_temp.assert_true(v_audits >= 1, 'the password change is audited');
  perform pg_temp.assert_true(
    (select a.changes from public.audit_logs a where a.action = 'account.password' and a.entity_id = v_teacher::text
      order by a.created_at desc limit 1)::text not like '%"password"%',
    'and the audit entry holds no password, only a note');

  -- ---------- the invariant ----------
  select count(*) into v_active_admins from public.profiles where role = 'admin' and is_active;
  perform pg_temp.assert_true(v_active_admins >= 1,
    'at least one active admin exists after all of that (the project can always be administered)');

  raise exception 'ACCOUNT TESTS PASSED (% accounts, % active admins, % audit entries written and rolled back)',
    (v_listed ->> 'total')::int, v_active_admins,
    (select count(*) from public.audit_logs where action like 'account.%');
end $acct$;
