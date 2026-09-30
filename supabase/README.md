# Supabase project

Project: **English_Test_v2** (region ap-southeast-1, Singapore), reference `lbhnadqmokloyfarrzfv`.

- The database schema is stored in the project as migrations `v2_01` to `v2_15`, and (as of 2026-09-24) also in `supabase/migrations/` in this repository — see below.
- Edge Functions live in `../backend/functions` (`auth-me`, `question-bank`, `media`, `exams`, `session`, `results`, `audit`, `backups`, `accounts`). All nine are deployed live (§ "Deploying a function" below).
- **Scheduled jobs** (TASK-015) run inside the database: `pg_cron` closes abandoned sessions every five
  minutes and, nightly, drops spent rate-limit windows, asks the `media` function (over `pg_net`) to
  delete uploads nobody attached, and takes a **backup** of the whole database (02:41 Jakarta) — the two
  jobs that need Storage are HTTP calls, not plain SQL, because bytes can only move through the Storage
  API. The calls carry a housekeeping key that lives in Vault and as the function secret
  `HOUSEKEEPING_KEY`, never in this repository; rotation is two SQL/secret updates and no code change.
  Contracts, evidence and the reasons: `docs/sql-jobs.md` (the purges) and `docs/sql-backups.md` (the
  backup slice); configuration tests: `supabase/tests/scheduled_jobs_test.sql` and
  `supabase/tests/backup_functions_test.sql`.

To keep the SQL of the migrations in this repository, run this once on your computer with the Supabase CLI:

```
supabase login
supabase link --project-ref lbhnadqmokloyfarrzfv
supabase db pull
```

That writes the migration files into `supabase/migrations/`. Commit them. `v2_01_foundation` through
`v2_12_import_questions` (schema, question bank, exams/sessions/results tables, lockdown, text rules, media
storage, import) were pulled from `supabase_migrations.schema_migrations` and committed verbatim on 2026-09-24,
using the CLI's own `<version>_<name>.sql` naming and exact original timestamps — see ISSUE-001. Also here:
`20260922000000_exams_functions.sql` (exam functions, applied live on 2026-09-22; annotated source in
`docs/sql-exams.md`), `20260923000000_session_functions.sql` (the student exam engine — join, answers,
heartbeat, events, submit + grading, result — applied live on 2026-09-23; annotated source in
`docs/sql-sessions.md`), `20260924000000_result_functions.sql` (teacher grading, per-exam results, the
attempt report, add time / reopen, retake permissions — applied live on 2026-09-24; annotated source in
`docs/sql-results.md`), `20260925000000_monitor_overview_fields.sql` (live monitor progress fields, applied
2026-09-23), `20260926000000_security_lockdown_function_execute.sql` (ISSUE-020: closes a gap where
`anon`/`authenticated` could call 35 staff-only functions directly), `20260930000000_exam_delete_with_attempts.sql`
(the exam delete rule, DEC-027: `list_exams.session_count` + the admin-only forced delete, applied live
2026-09-25), `20260926002454_scheduled_housekeeping_jobs.sql` (TASK-015: `pg_cron` + `pg_net` and the
three housekeeping jobs, applied live 2026-09-26 with its own `schema_migrations` row — see
`docs/sql-jobs.md`), `20260926010636_backup_functions.sql` (TASK-015: the private `backups` bucket, the 22-table allowlist, `build_backup_payload` / `record_backup` (with the retention sweep) / `list_backups` / `get_backup` / `delete_backup`, and the fourth job `nightly-backup` — applied live 2026-09-26 with its own `schema_migrations` row; see `docs/sql-backups.md`), `20260926021234_account_functions.sql` (TASK-015 user management, DEC-031: the active-admin gate, `list_accounts`, `record_account`, `update_account` with the two guards — nobody changes their own role or deactivates themselves, the last active admin stays — and `record_account_password`; the login half is the `accounts` Edge Function's Auth Admin API calls, because only the service role may create a user; applied live 2026-09-26 with its own `schema_migrations` row; see `docs/sql-accounts.md`) and `20260927000000_exam_wide_add_time.sql`
(exam-wide add time, drops the duplicate `list_live_sessions` that ISSUE-020 found live and never committed —
applied live on 2026-09-24; annotated source in `docs/sql-monitor.md`), and `20260928000001_bulk_question_update.sql`
(F-17 bulk question changes, DEC-035: `public.bulk_update_questions` — many questions in one transaction and
one audit entry, `service_role` only, additive — **applied live 2026-09-28 with its own `schema_migrations`
row**; its rolled-back test `supabase/tests/bulk_update_test.sql` passed live the same day
(`BULK UPDATE TESTS PASSED (…)`, after fixing two faults in the test itself), `question-bank` was redeployed
with the `bulk_update` action, and `frontend/tests/live_bulk_check.py` then passed **65/65** against the
deployed function — see `docs/sql-bulk-update.md`), and `20260928000002_bulk_exam_questions.sql`
(F-18 adding or removing many questions on a whole exam, DEC-036: `public.bulk_exam_questions(p_exam_id, p_mode,
p_ids, p_actor)` — `add` | `remove`, one transaction, one `exam.questions` audit entry per act and never an
`exam.update`, an exam's list always 1..n with no gaps, `service_role` only, additive — **applied live
2026-09-28 with its own `schema_migrations` row, applied a second time for the renumber-on-remove fix the
live check caught (ISSUE-034)**; its rolled-back test `supabase/tests/bulk_exam_questions_test.sql` passed
live the same day (`BULK EXAM QUESTION TESTS PASSED (…)`, after its first run found a real fault in the
function), `exams` was redeployed with the `bulk_questions` action, and `frontend/tests/live_exam_bulk_check.py`
then passed **55/55** against the deployed function — see `docs/sql-exam-questions.md`).
`v2_01_foundation` through
`v2_12_import_questions` (schema, question bank, exams/sessions/results tables, lockdown, text rules, media
storage, import) were pulled from `supabase_migrations.schema_migrations` and committed verbatim on 2026-09-24
— see ISSUE-001. Three more were committed verbatim out of the live ledger on 2026-09-30 so that **every live
row has a file**: `20260923050326_v2_13_revoke_public_function_execute.sql`,
`20260923050351_v2_14_fix_exam_is_open_search_path.sql` and
`20260923050413_v2_13_lockdown_exam_session_results_functions.sql` — the three rows the
`20260926000000_security_lockdown_function_execute.sql` narrative already described. Also here:
`20261001000000_notification_functions.sql` (the bell's four read functions and `notification_reads`) and
`20261002000000_notification_reads_rls.sql` (the RLS line TASK-026 applied live on 2026-09-30).

**The ledger question is settled (measured 2026-09-30, ISSUE-036 closed):** the live
`supabase_migrations.schema_migrations` holds **27 rows**, every one of them explained by a file in this
directory, and all **81 live public functions** match the newest file that defines them once comments and
whitespace are ignored. Nine files were applied by direct `database/query` calls and have no ledger row — each
is listed with its reason in **`docs/migration-ledger-reconciliation.md`** — so `supabase migration list` will
keep calling them "not applied remotely" even though their content is live (they are `create or replace` or
idempotent revokes, and in version order the last file wins, which is the state live is in). Re-run the whole
reconciliation read-only with `python frontend/tests/live_ledger_check.py` (needs `SUPABASE_ACCESS_TOKEN`).

Deploying a function from this repository (backend/functions is the source of truth;
supabase/functions/ is a generated deploy artifact):

```
python backend/sync_functions.py
npx supabase functions deploy results --no-verify-jwt --use-api
```

`--use-api` bundles server-side, so Docker is not needed. `--no-verify-jwt` is required: the
functions check who is calling themselves in code (`requireStaff`).

Functions check who is calling themselves (`requireStaff`), which is why gateway JWT verification is off.
The `session` function is the exception: `join` is open to anonymous students (rate limited per address), so it
checks the caller itself with the signed session token (`session/token.ts`) instead of requiring staff login.
Never put the service role key, passwords, or any `.env` file in this repository.
