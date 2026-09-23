# Supabase project

Project: **English_Test_v2** (region ap-southeast-1, Singapore), reference `lbhnadqmokloyfarrzfv`.

- The database schema is stored in the project as migrations `v2_01` to `v2_11`.
- Edge Functions live in `../backend/functions` (`auth-me`, `question-bank`, `media`, `exams`, `session`). All five are deployed live.

To keep the SQL of the migrations in this repository, run this once on your computer with the Supabase CLI:

```
supabase login
supabase link --project-ref lbhnadqmokloyfarrzfv
supabase db pull
```

That writes the migration files into `supabase/migrations/`. Commit them. The migrations stored here so far are
`20260922000000_exams_functions.sql` (exam functions, applied live on 2026-09-22; annotated source in
`docs/sql-exams.md`) and `20260923000000_session_functions.sql` (the student exam engine — join, answers,
heartbeat, events, submit + grading, result — applied live on 2026-09-23; annotated source in
`docs/sql-sessions.md`). The older `v2_01`..`v2_12` are still only in the live project (ISSUE-001).

Deploying a function from this repository (backend/functions is the source of truth;
supabase/functions/ is a generated deploy artifact):

```
python backend/sync_functions.py
npx supabase functions deploy session --no-verify-jwt --use-api
```

`--use-api` bundles server-side, so Docker is not needed. `--no-verify-jwt` is required: the
functions check who is calling themselves in code (`requireStaff`).

Functions check who is calling themselves (`requireStaff`), which is why gateway JWT verification is off.
The `session` function is the exception: `join` is open to anonymous students (rate limited per address), so it
checks the caller itself with the signed session token (`session/token.ts`) instead of requiring staff login.
Never put the service role key, passwords, or any `.env` file in this repository.
