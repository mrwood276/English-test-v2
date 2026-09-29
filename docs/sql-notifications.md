# SQL behind the notification bell (TASK-015 / DEC-017, adopted under DEC-037)

The bell is the project's one notification system. There is **no notifications table**: a notice is a
question asked of data that already exists, computed at read time, so the bell can never disagree
with the screens it links to. The only state kept is per person — when they last opened the bell.

| Object | Kind | What it does |
|---|---|---|
| `public.notification_reads` | table | One row per person: `last_read_at`, `updated_at`. Created the first time they open the bell; removed with the profile (`on delete cascade`). |
| `public._actor_profile(p_actor uuid)` | function | The staff gate: returns the caller's `profiles` row or refuses (nobody signed in / no profile / deactivated). Every function below starts here. |
| `public._essay_notifications()` | function | `exam_results` rows with status `pending_review`, with the count of essay questions in their own `review_snapshot` that have no grade yet. |
| `public._suspicious_notifications(p_days int)` | function | One card per exam with `suspicious` / `violation` rows in `session_events` inside the window, with the event and session counts. |
| `public.list_notifications(p_actor uuid, p_limit int default 50)` | function | The bell's payload: the four kinds (essays, suspicious, newest backup, newly created accounts — the last two only for an admin), the counters, `total`, `unread` and `read_at`. |
| `public.mark_notifications_read(p_actor uuid)` | function | Writes the one `notification_reads` row and answers the same shape as `list`. |

`total` is the sum of its parts and `unread` counts what arrived after `read_at`; with no row at all
the bell treats `to_timestamp(0)` as the read mark, so a new account's first look is all news.

## Privileges

- Every function: `revoke all … from public, anon, authenticated` and `grant execute … to service_role`
  (ISSUE-020's rule). Only the `notifications` Edge Function calls them, with `p_actor` taken from the
  verified staff session — never from the browser.
- `public.notification_reads`: RLS on with **no policies** (DEC-002), plus `revoke all on table … from
  public, anon, authenticated`. The service role bypasses RLS, which is the only caller there is.

## Files

- `supabase/migrations/20261001000000_notification_functions.sql` — the functions and the table.
  Its header records a live apply on 2026-09-26 (twenty-third session). **The file in Git is a
  reconstruction** of what production runs (the original historical SQL was not retrievable), so
  re-read it against live before re-applying it — ISSUE-036. The working copy carries the
  `_actor_profile` definition the reconstruction dropped; without it the two main functions fail at
  call time, because PL/pgSQL resolves function calls at runtime (ISSUE-037).
- `supabase/migrations/20261002000000_notification_reads_rls.sql` — puts the table on the RLS-on
  baseline. **Not applied live yet** (TASK-026).
- `supabase/tests/notification_functions_test.sql` — the rolled-back SQL test: the boundary (no API
  role may execute any of it, RLS is on), the refusals (nobody signed in, unknown actor, deactivated
  account, a limit out of bounds), the shape of the list, the role scoping (a teacher's bell carries
  nothing admin-only), and that the cards are honest. It passed live on 2026-09-26; the RLS
  assertion was added on 2026-09-29 and has not been run live.
- `backend/functions/notifications/{handler.ts,index.ts}` — the `list` / `mark_read` actions.
- `frontend/assets/js/teacher/api/notifications.js`, `frontend/assets/js/teacher/screens/shell.js` —
  the bell in the brand row and its panel.

## Applying and verifying

CLI 2.117.0 has no `supabase db query` subcommand — use the Management API query endpoint
(`POST /v1/projects/<ref>/database/query` with `{"query": "…"}`) or the dashboard SQL editor. Applying
that way writes **no** `schema_migrations` row; insert it (`<version>` / `<name>`) or a later
`supabase db push` will re-run the file. The pattern is written out in `docs/sql-jobs.md`.

1. Apply `20261002000000_notification_reads_rls.sql` and insert its ledger row.
2. Run `supabase/tests/notification_functions_test.sql`; it must answer
   `NOTIFICATION TESTS PASSED (…, everything rolled back)`. The error IS the result — the test ends by
   raising, which rolls the transaction back.
3. Re-run the Supabase security advisor; it must still report nothing.
4. `python frontend/tests/live_notifications_check.py` is the live check through the deployed
   function and a real staff session (it needs a Supabase credential; it is not part of CI).
