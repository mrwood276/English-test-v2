-- SQL test for the scheduled jobs (TASK-015): the three housekeeping purges and the nightly backup.
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
-- Passed live on 2026-09-26.
--
-- Read-only: it asserts how the four jobs are configured, it does not run them and writes nothing — the
-- whole file is one transaction that is deliberately aborted at the end, so the error message IS the
-- result (the same trick as the other tests):
--   "SCHEDULED JOBS TESTS PASSED (...)"  → every assertion held
--   "ASSERT FAILED: <message>"           → a rule is broken
--
-- What is checked: the two extensions exist where the jobs expect them; the four jobs exist, are active,
-- run in this database and as the role that owns the functions; the schedules are the documented ones and
-- never collide with each other; expire_sessions and purge_rate_limits are called directly, while the
-- media job and the nightly backup go through pg_net to the deployed functions with the Vault key; the
-- key is long enough to be a secret and unreadable by anon/authenticated; and the job's role may not just
-- read the key but execute all three functions. What this file can NOT prove — that the jobs actually fire
-- and do their work — is in frontend/tests/live_housekeeping_check.py (the purges) and
-- frontend/tests/live_backup_check.py (the nightly copy).
--
-- Note on reachability (verified live 2026-09-26, not asserted here because it is a platform default):
-- pg_cron and pg_net ship PUBLIC grants (cron.job is world-readable, net.http_post is world-executable),
-- so the *protection* is the schema boundary: anon and authenticated have no USAGE on `cron` and none on
-- `vault`, and PostgREST exposes no table at all (the app's only door is the Edge Functions). Revoking
-- the extension's own grants would fight a platform-managed extension; the boundary is what to keep.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

do $$
declare
  v_jobs int;
  v_sched text;
  v_cmd text;
  v_key text;
  v_summary text;
begin
  -- ---------- the two extensions ----------
  perform pg_temp.assert_true(
    exists (select 1 from pg_extension where extname = 'pg_cron'),
    'pg_cron is installed (the scheduler itself)');
  perform pg_temp.assert_true(
    exists (select 1 from pg_extension where extname = 'pg_net' and extnamespace = 'extensions'::regnamespace),
    'pg_net is installed in the extensions schema (the media job calls the function over HTTP)');
  perform pg_temp.assert_true(
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'net' and p.proname = 'http_post'),
    'net.http_post exists, so the media job command can resolve');

  -- ---------- the four jobs ----------
  select count(*) into v_jobs
    from cron.job
   where jobname in ('expire-sessions', 'purge-rate-limits', 'purge-orphan-media', 'nightly-backup')
     and active;
  perform pg_temp.assert_true(v_jobs = 4, 'the four jobs exist and are enabled');

  select count(*) into v_jobs
    from cron.job
   where jobname in ('expire-sessions', 'purge-rate-limits', 'purge-orphan-media', 'nightly-backup')
     and database = current_database()
     and username = 'postgres';
  perform pg_temp.assert_true(v_jobs = 4, 'all four run in this database as postgres (the functions'' owner)');

  select schedule, command into v_sched, v_cmd from cron.job where jobname = 'expire-sessions';
  perform pg_temp.assert_true(v_sched = '*/5 * * * *', 'sessions are expired every five minutes');
  perform pg_temp.assert_true(v_cmd = 'select public.expire_sessions()', 'the session job calls the function directly');

  select schedule, command into v_sched, v_cmd from cron.job where jobname = 'purge-rate-limits';
  perform pg_temp.assert_true(v_sched = '19 19 * * *', 'spent rate-limit windows are dropped nightly (19:19 UTC = 02:19 Jakarta)');
  perform pg_temp.assert_true(v_cmd = 'select public.purge_rate_limits()', 'the rate-limit job calls the function directly');

  perform pg_temp.assert_true(
    (select count(distinct schedule) = 3 from cron.job where jobname in ('purge-rate-limits', 'purge-orphan-media', 'nightly-backup')),
    'the three nightly jobs never share a minute, so none waits for another');

  -- ---------- the media job: the one that needs the Storage API ----------
  select schedule, command into v_sched, v_cmd from cron.job where jobname = 'purge-orphan-media';
  perform pg_temp.assert_true(v_sched = '29 19 * * *', 'unused uploads are swept nightly (19:29 UTC = 02:29 Jakarta)');
  perform pg_temp.assert_true(v_cmd like '%net.http_post%', 'the media job goes through pg_net');
  perform pg_temp.assert_true(
    v_cmd like '%lbhnadqmokloyfarrzfv.supabase.co/functions/v1/media%',
    'the media job calls the deployed media function');
  perform pg_temp.assert_true(
    v_cmd like '%x-housekeeping-key%' and v_cmd like '%vault.decrypted_secrets%',
    'it presents the housekeeping key from Vault (never a key from the repository)');
  perform pg_temp.assert_true(
    v_cmd like '%purge_unused%',
    'it asks for purge_unused — the action that deletes the bytes through the Storage API');

  -- ---------- the nightly backup: the other job that needs Storage ----------
  select schedule, command into v_sched, v_cmd from cron.job where jobname = 'nightly-backup';
  perform pg_temp.assert_true(v_sched = '41 19 * * *', 'the copy of the whole database is taken nightly (19:41 UTC = 02:41 Jakarta)');
  perform pg_temp.assert_true(
    v_cmd like '%net.http_post%' and v_cmd like '%lbhnadqmokloyfarrzfv.supabase.co/functions/v1/backups%',
    'the backup job goes through pg_net to the deployed backups function');
  perform pg_temp.assert_true(
    v_cmd like '%x-housekeeping-key%' and v_cmd like '%vault.decrypted_secrets%',
    'it presents the housekeeping key from Vault (the same key as the media sweep, never a key from the repository)');
  perform pg_temp.assert_true(
    v_cmd like '%"action": "create"%' and v_cmd like '%"automatic"%',
    'it may ask for an automatic copy and nothing else');

  -- ---------- the key ----------
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'housekeeping_key';
  perform pg_temp.assert_true(v_key is not null, 'the housekeeping key exists in Vault');
  perform pg_temp.assert_true(length(v_key) >= 32, 'the key is long enough to be a secret (not a guessable word)');
  perform pg_temp.assert_true(
    not has_schema_privilege('anon', 'vault', 'usage') and not has_schema_privilege('authenticated', 'vault', 'usage'),
    'anon and authenticated cannot even look inside the vault');
  perform pg_temp.assert_true(
    not has_schema_privilege('anon', 'cron', 'usage') and not has_schema_privilege('authenticated', 'cron', 'usage'),
    'anon and authenticated cannot reach the cron schema, so the job list is theirs to neither read nor change');

  -- ---------- the role the jobs run as ----------
  perform pg_temp.assert_true(
    has_function_privilege('postgres', 'public.expire_sessions(interval)', 'execute')
      and has_function_privilege('postgres', 'public.purge_rate_limits(interval)', 'execute')
      and has_function_privilege('postgres', 'public.purge_orphan_media(interval)', 'execute'),
    'the jobs'' role may execute all three functions');
  perform pg_temp.assert_true(
    (select prosecdef from pg_proc where oid = 'public.expire_sessions(interval)'::regprocedure),
    'expire_sessions is security definer, so the scheduled run may close sessions');

  raise exception 'SCHEDULED JOBS TESTS PASSED (% jobs active, key % chars, nothing written)',
    v_jobs, length(v_key);
end $$;
