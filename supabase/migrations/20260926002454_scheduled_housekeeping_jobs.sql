-- TASK-015 housekeeping: the database now cleans up after itself, without anybody logging in.
--
-- Three jobs, one concern each, so a slow or failing job can never hold up the others:
--   expire-sessions     every 5 minutes — sessions nobody submitted become auto_submitted / timed_out (BR-21)
--   purge-rate-limits   nightly — spent join and exam-code attempt windows are dropped
--   purge-orphan-media  nightly — uploads nobody attached are deleted
--
-- The media job is the one job that cannot be pure SQL: `purge_orphan_media()` deletes the bookkeeping
-- rows, but the bytes can only be removed through the Storage API — that is what the media function's
-- `purge_unused` action already does for an admin. A database-only delete would drop the rows and leave
-- the files in the bucket with nothing pointing at them any more. So this job calls the deployed function
-- over pg_net, presenting the housekeeping key that this migration puts in Vault. That key is generated
-- here and never passes through the repository; the same value must be set as the media function's
-- HOUSEKEEPING_KEY secret (the function only accepts it for `purge_unused`). See docs/sql-jobs.md.
--
-- Schedules are UTC (the project's timezone): 19:19 and 19:29 UTC are 02:19 and 02:29 in Jakarta, so the
-- nightly work happens while the school is asleep.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- The key the nightly media job presents. Created once; re-running this migration never replaces it.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'housekeeping_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'housekeeping_key',
      'Scheduled housekeeping calls (TASK-015). Matches the media function''s HOUSEKEEPING_KEY secret.'
    );
  end if;
end $$;

select cron.schedule('expire-sessions', '*/5 * * * *', 'select public.expire_sessions()')
where not exists (select 1 from cron.job where jobname = 'expire-sessions');

select cron.schedule('purge-rate-limits', '19 19 * * *', 'select public.purge_rate_limits()')
where not exists (select 1 from cron.job where jobname = 'purge-rate-limits');

select cron.schedule(
  'purge-orphan-media',
  '29 19 * * *',
  $job$
  select net.http_post(
    url := 'https://lbhnadqmokloyfarrzfv.supabase.co/functions/v1/media',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-housekeeping-key', (select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key')
    ),
    body := '{"action": "purge_unused"}'::jsonb
  );
  $job$
)
where not exists (select 1 from cron.job where jobname = 'purge-orphan-media');
