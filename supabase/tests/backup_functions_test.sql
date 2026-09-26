-- SQL test for the database half of the backup slice (TASK-015).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
-- Passed live on 2026-09-26.
--
-- Read-only: it reads the catalogue, calls the two reading functions and writes nothing — the whole file
-- is one transaction that is deliberately aborted at the end, so the error message IS the result (the
-- same trick as the other tests):
--   "BACKUP TESTS PASSED (...)"  → every assertion held
--   "ASSERT FAILED: <message>"   → a rule is broken
--
-- What is checked: the private bucket exists with the documented limit; the seven functions exist with the
-- security they need; the table allowlist is complete (every real table, no duplicates, no strangers) and
-- grows only on purpose; the payload the function hands the Edge layer is well formed and says which
-- migrations built this database; the admin's two reading helpers work and refuse bad input; a table
-- outside the allowlist cannot be read through `_backup_table_rows`; and the boundary holds — anon and
-- authenticated may not execute a single one of these functions, `public.backups` has RLS on with no
-- policies, and the bucket is private. What this file can NOT prove — that a copy really contains the
-- data and the bytes, that retention prunes, and that the nightly job fires — is in
-- frontend/tests/live_backup_check.py.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

do $$
declare
  v_bucket storage.buckets;
  v_funcs int;
  v_allowed text[] := public.backup_tables();
  v_payload jsonb;
  v_listed jsonb;
  v_summary text;
  v_names text;
begin
  -- ---------- the bucket the archives live in ----------
  select * into v_bucket from storage.buckets where id = 'backups';
  perform pg_temp.assert_true(v_bucket.id is not null, 'the backups bucket exists');
  perform pg_temp.assert_true(v_bucket.public is false, 'the bucket is private (a copy is never a public URL)');
  perform pg_temp.assert_true(v_bucket.name = 'backups' and v_bucket.file_size_limit = 52428800,
    'the bucket is named backups and capped at the platform maximum a single upload may have (50 MB)');

  -- ---------- the seven functions ----------
  select count(*) into v_funcs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('backup_tables', '_backup_table_rows', 'build_backup_payload',
                       'record_backup', 'list_backups', 'get_backup', 'delete_backup');
  perform pg_temp.assert_true(v_funcs = 7, 'all seven backup functions exist in public');
  perform pg_temp.assert_true(
    (select prosecdef from pg_proc where oid = 'public.build_backup_payload()'::regprocedure)
      and (select prosecdef from pg_proc where oid = 'public.record_backup(public.backup_kind, text, bigint, uuid, jsonb)'::regprocedure)
      and (select prosecdef from pg_proc where oid = 'public.delete_backup(uuid, uuid)'::regprocedure),
    'reading the whole database, recording a copy and deleting one are security definer (the Edge layer reaches them as service role, the functions keep their own search_path)');
  perform pg_temp.assert_true(
    (select provolatile = 'i' from pg_proc where oid = 'public.backup_tables()'::regprocedure),
    'the table list is immutable, so it cannot drift with the session');

  -- ---------- the allowlist is the contract ----------
  perform pg_temp.assert_true(cardinality(v_allowed) = 22, 'the allowlist names 22 tables');
  perform pg_temp.assert_true(
    cardinality(v_allowed) = cardinality(array(select distinct t from unnest(v_allowed) t)),
    'no table is listed twice');
  perform pg_temp.assert_true(
    (select count(*) from unnest(v_allowed) t
      where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind = 'r' and c.relname = t)) = 0,
    'every listed name is a real table in public (a rename would be caught here, not at 02:41)');
  perform pg_temp.assert_true(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> all (v_allowed)) = 0,
    'and no table of public is missing: a new table must be added to the allowlist on purpose');

  -- ---------- what the database hands the Edge layer ----------
  v_payload := public.build_backup_payload();
  perform pg_temp.assert_true(v_payload ->> 'format' = 'english-test-v2.backup', 'the payload names its format');
  perform pg_temp.assert_true((v_payload ->> 'format_version')::int = 1, 'the format has a version to grow from');
  perform pg_temp.assert_true(jsonb_typeof(v_payload -> 'tables') = 'object'
    and (select count(*) from jsonb_object_keys(v_payload -> 'tables')) = cardinality(v_allowed),
    'the payload holds one entry per table in the allowlist');
  perform pg_temp.assert_true(jsonb_typeof(v_payload -> 'media') = 'array',
    'the payload carries a media manifest for the bytes the Edge layer must copy');
  perform pg_temp.assert_true(jsonb_array_length(v_payload -> 'migrations') > 0,
    'it records which migrations built this database (so a later reader knows what it is looking at)');
  perform pg_temp.assert_true(jsonb_typeof(public._backup_table_rows('audit_logs')) = 'array',
    'a listed table reads as an array of rows');

  -- a table outside the allowlist cannot be read through the dynamic reader
  begin
    perform public._backup_table_rows('schema_migrations');
    perform pg_temp.assert_true(false, 'a table outside the allowlist is refused');
  exception when others then
    perform pg_temp.assert_true(position('no table named' in sqlerrm) > 0,
      'a table outside the allowlist is refused with a clear message');
  end;

  -- ---------- the admin's two reading helpers ----------
  v_listed := public.list_backups(5, 0);
  perform pg_temp.assert_true((v_listed ->> 'total')::int = (select count(*) from public.backups),
    'the list counts every stored copy');
  perform pg_temp.assert_true(jsonb_typeof(v_listed -> 'rows') = 'array', 'and returns them as rows');
  perform pg_temp.assert_true(
    not exists (select 1 from jsonb_array_elements(v_listed -> 'rows') r where not (r ? 'storage_path')),
    'each row says which file it is, so a download can find it');
  begin
    perform public.list_backups(0, 0);
    perform pg_temp.assert_true(false, 'a page size outside 1..200 is refused');
  exception when others then
    perform pg_temp.assert_true(position('Limit must be between' in sqlerrm) > 0,
      'a page size outside 1..200 is refused');
  end;
  begin
    perform public.get_backup('00000000-0000-4000-8000-000000000000');
    perform pg_temp.assert_true(false, 'asking for a copy that is not there is refused');
  exception when others then
    perform pg_temp.assert_true(position('no longer exists' in sqlerrm) > 0,
      'asking for a copy that is not there is refused, not answered with nothing');
  end;

  -- ---------- the table and the boundary around it ----------
  perform pg_temp.assert_true(
    (select relrowsecurity from pg_class where oid = 'public.backups'::regclass),
    'the backups table has row level security enabled');
  perform pg_temp.assert_true(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'backups') = 0,
    'and no policy: nothing may read it through the API (only the functions and the service role may)');
  perform pg_temp.assert_true(
    (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'backup_kind') = 2
      and exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                   where t.typname = 'backup_kind' and e.enumlabel = 'manual')
      and exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                   where t.typname = 'backup_kind' and e.enumlabel = 'automatic'),
    'a copy is either manual or automatic and there is no third kind');
  perform pg_temp.assert_true(
    (select count(*) from pg_constraint where conrelid = 'public.backups'::regclass and contype = 'f' and confdeltype = 'n') = 1,
    'deleting the admin who made a copy leaves the copy (the row keeps its history, not its author)');

  select string_agg(p.proname, ', ' order by p.proname) into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('backup_tables', '_backup_table_rows', 'build_backup_payload',
                       'record_backup', 'list_backups', 'get_backup', 'delete_backup');
  perform pg_temp.assert_true(
    not exists (
      select 1 from unnest(array[
        'public.backup_tables()', 'public._backup_table_rows(text)', 'public.build_backup_payload()',
        'public.record_backup(public.backup_kind, text, bigint, uuid, jsonb)', 'public.list_backups(int, int)',
        'public.get_backup(uuid)', 'public.delete_backup(uuid, uuid)']) sig
      where has_function_privilege('anon', sig::regprocedure, 'execute')
         or has_function_privilege('authenticated', sig::regprocedure, 'execute')),
    'anon and authenticated may execute none of them: reading a whole database is the Edge layer''s job, after it has checked who is asking');
  perform pg_temp.assert_true(
    not has_table_privilege('anon', 'public.backups', 'select')
      and not has_table_privilege('authenticated', 'public.backups', 'insert'),
    'nor may they touch the backups table directly');

  select count(*)::text into v_summary from public.backups;
  raise exception 'BACKUP TESTS PASSED (7 functions, % tables, % stored copies, nothing written)',
    cardinality(v_allowed), v_summary;
end $$;
