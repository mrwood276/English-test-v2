# Supabase project

Project: **English_Test_v2** (region ap-southeast-1, Singapore), reference `lbhnadqmokloyfarrzfv`.

- The database schema is stored in the project as migrations `v2_01` to `v2_15`, and (as of 2026-09-24) also in `supabase/migrations/` in this repository — see below.
- Edge Functions live in `../backend/functions` (`auth-me`, `question-bank`, `media`, `exams`, `session`, `results`). All six are deployed live.

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
`anon`/`authenticated` could call 35 staff-only functions directly) and `20260927000000_exam_wide_add_time.sql`
(exam-wide add time, drops the duplicate `list_live_sessions` that ISSUE-020 found live and never committed —
applied live on 2026-09-24; annotated source in `docs/sql-monitor.md`). `v2_01_foundation` through
`v2_12_import_questions` (schema, question bank, exams/sessions/results tables, lockdown, text rules, media
storage, import) were pulled from `supabase_migrations.schema_migrations` and committed verbatim on 2026-09-24
— see ISSUE-001. **Known drift, the other direction**: `20260922000000`/`20260923000000`/`20260924000000`
(the exams/session/results function files) were applied via direct DB access rather than `supabase db push`, so
`supabase_migrations.schema_migrations` has no matching rows for them — `supabase migration list` will call
them "not applied remotely" even though their content is live. Low risk (all three are `create or replace
function`, nothing `create table`), but if you get a real DB connection, reconciling that table is worth doing.

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
