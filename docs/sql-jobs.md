# SQL for the scheduled housekeeping jobs (TASK-015)

Phase 7 asks for the things nobody can be bothered to do by hand (design.md 1.4/2.5): sessions a student
walked away from must be closed, spent rate-limit windows dropped, and uploads nobody ever attached
deleted. The three functions have existed since the student engine, the media and the rate-limiter were
built (`expire_sessions`, `purge_rate_limits`, `purge_orphan_media`) — nothing called them. This adds the
clock, inside the database, so it runs whether or not anybody is signed in. Issues: **ISSUE-012** and
**ISSUE-018**, both closed.

The statements live in **`supabase/migrations/20260926002454_scheduled_housekeeping_jobs.sql`** and are
**applied live (2026-09-26)** — recorded in `supabase_migrations.schema_migrations` as `20260926002454` /
`scheduled_housekeeping_jobs`. Do not re-apply it blindly: it is idempotent, but the key it generates
must stay the key the function was told about.

Running SQL against this project: CLI 2.117.0 has **no `supabase db query` subcommand** — use the
Management API query endpoint (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with
`{"query": "…"}`; one request is one session, which is what lets a file's `pg_temp.*` helper work) or the
dashboard SQL editor. **Applying a migration that way leaves no tracking row**, so the session that did
it also inserted one (`insert into supabase_migrations.schema_migrations (version, name, statements)
values (…)`) — otherwise `supabase migration list` would call it "not applied remotely" while its content
is live, which is exactly the drift ISSUE-001 is about.

## The three jobs

| Job | Schedule (UTC) | Command | What it does |
|---|---|---|---|
| `expire-sessions` | `*/5 * * * *` — every five minutes | `select public.expire_sessions()` | BR-21: a session past `ends_at` + the two-minute tolerance is closed by `_session_grade` as `auto_submitted` when it has answers, and stamped `timed_out` when it has none. The monitor stops showing a student who left for good. |
| `purge-rate-limits` | `19 19 * * *` — 02:19 Jakarta | `select public.purge_rate_limits()` | Drops `rate_limits` windows older than a day (join attempts, exam-code guesses, autosave counters). Without it the table grows forever. |
| `purge-orphan-media` | `29 19 * * *` — 02:29 Jakarta | `select net.http_post(…media function…)` | Deletes uploads nobody attached — the same thing the admin's **Purge unused** button does. |

The nightly jobs never share a minute, so neither waits for the other, and both are far from the next
morning's school hours. The scheduler is `pg_cron` (1.6.4); the HTTP hop is `pg_net` (0.20.4); both were
already in the project's `shared_preload_libraries` and are now enabled by the migration
(`create extension if not exists …`).

## Why the media job is not plain SQL

`purge_orphan_media()` deletes the `media_files` rows and returns their paths, but **the bytes live in
Storage and can only be removed through the Storage API** — that is what the `media` function's
`purge_unused` action does for an admin (it calls the same SQL function, then `bucket.remove(paths)`).
A database-only nightly job would delete the bookkeeping rows and leave the files in the bucket with
nothing pointing at them any more: a silent leak instead of a visible one. So this job calls the deployed
function:

```sql
select net.http_post(
  url := 'https://lbhnadqmokloyfarrzfv.supabase.co/functions/v1/media',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-housekeeping-key', (select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key')
  ),
  body := '{"action": "purge_unused"}'::jsonb
);
```

`pg_cron` needs nothing more: it queues the request and the response lands in `net._http_response`.

## The housekeeping key

A machine has no `profiles` row, so the scheduled call must not pretend to be a person. Instead:

- **Generated inside the migration** — `vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'housekeeping_key', …)`,
  64 hex characters. It is created once and never replaced by a re-run.
- **Never in the repository**: no file contains it (the live check walks the whole working tree and
  asserts exactly that).
- **Mirrored as a function secret** — the same value is set as the `media` function's `HOUSEKEEPING_KEY`
  through the Management API (`POST /v1/projects/<ref>/secrets`). This is the one step a migration cannot
  do for itself, so it is recorded here.
- **Checked in code** — `backend/functions/_shared/auth.ts#isScheduledJob`: both sides are SHA-256 hashed
  and compared byte by byte (no length leak, no short-circuit), and with no secret configured the answer
  is always `false`. The key opens **exactly one action** (`purge_unused`); the handler returns before
  `requireStaff`, so the key never becomes a staff identity, and every other action still answers 401 to
  it. A wrong key, no key, or a tokenless call are all refused.
- **Rotation** — `select vault.update_secret((select id from vault.secrets where name = 'housekeeping_key'), <new 32-byte hex>)`,
  then update the function secret to the same value (dashboard → Functions → Secrets, or the Management
  API). No code change and no redeploy: the function reads the secret at request time, the job reads the
  vault at run time.
- **Reachability** — `anon` and `authenticated` have no USAGE on the `cron` or `vault` schemas (asserted in
  the SQL test), and PostgREST exposes no table at all in this project (its root lists **0 paths**), so
  nothing here is reachable from a browser. Note for a future audit: `pg_cron` and `pg_net` ship PUBLIC
  grants (`cron.job` is world-readable, `net.http_post` is world-executable) — the schema boundary is what
  protects them, and revoking an extension's own grants is not worth fighting the platform over.

## How it was verified (2026-09-26)

**Configuration, live** — `supabase/tests/scheduled_jobs_test.sql` (read-only; it ends by aborting its own
transaction, so the error message is the result):

```
SCHEDULED JOBS TESTS PASSED (3 jobs active, key 64 chars, nothing written)
```

It asserts the two extensions exist where the jobs expect them, the three jobs are active, run in
`postgres`/`postgres`, carry the documented schedules and commands, the nightly pair never shares a
minute, the media job really goes through `net.http_post` to the deployed function with the Vault key and
`purge_unused`, the key is 64 chars and unreadable by `anon`/`authenticated`, and that the jobs' role may
execute all three functions.

**End to end, live** — `frontend/tests/live_housekeeping_check.py` (**40/40**,
`ALL LIVE HOUSEKEEPING CHECKS PASSED`), which is the half that proves the jobs *fire*:

1. mints a one-time login link for the admin account (no password), checks the staff gate says `admin`,
   and reads the job list straight out of `cron.job`;
2. checks the deployed function's door: the key purges (200), a wrong key is refused, the key opens no
   other action, a tokenless call is still 401, an admin can still purge by hand, **a teacher is still
   refused (403)**;
3. greps the repository for the key (absent);
4. builds real fixtures: a 1×1 PNG uploaded through `create_upload` + a direct Storage PUT + `register`
   (so the object and its row really exist, confirmed), its row backdated two days, a stale `rate_limits`
   row, and a throwaway exam whose one student joins and then vanishes with `ends_at` ten minutes in the
   past;
5. points all three jobs at the next minute (`cron.alter_job`) and waits for the scheduler itself:
   `cron.job_run_details` records `expire-sessions`, `purge-rate-limits` and `purge-orphan-media` as
   **succeeded**, and `net._http_response` holds an **HTTP 200** from the media function with `removed`
   in the body;
6. checks the effects: the attempt is `timed_out` and stamped, the stale rate-limit row is gone, the
   upload's row is gone **and the file is gone from Storage** (proved by listing the bucket through the
   Storage API), and the app is told there are no links for that id **without an error**;
7. puts the schedules back to the documented ones and deletes everything it created, then compares the
   exam / session / media counts with the ones it started from.

Live facts worth remembering: job ids **1, 2, 3**; the first `expire-sessions` run happened within five
minutes of the migration; the owner's own exam (`4KHU2A`, one submitted attempt) was live the whole time
and was left untouched — the check counts rows before and after rather than assuming an empty project.

## What is deliberately not here

**Backups** (manual + scheduled) and **notifications** (dashboard + email) are the rest of TASK-015 and are
not built: the email half needs the owner's provider decision (DEC-017), and a scheduled backup needs a
decision about what to copy and where (the free plan has no point-in-time recovery). The dashboard's
"needs your attention" rows already cover the *dashboard* half of notifications. The database now has a
working clock, so a nightly backup job would be a small addition to this file's pattern.
