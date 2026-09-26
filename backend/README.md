# English Daily Test v2, backend

Supabase Edge Functions (Deno/TypeScript) for the v2 platform. The applied migrations are stored in `../supabase/migrations/` (the older `v2_01`..`v2_12` still live only in the Supabase project — ISSUE-001). Business rules that must be atomic
(saving a question with its answers and labels, deleting or archiving, audit entries) are database functions,
tested directly in SQL; the Edge Functions validate input, clean text, and call them.

## Layout

```
functions/
  _shared/        code shared by every function
    errors.ts     ApiError and friendly error helpers
    http.ts       CORS, JSON output, error handling (handle), safe JSON body reading
    validate.ts   input checks with friendly messages
    text.ts       normalizeText, contentHash, sanitizeInlineHtml (same rules as the database)
    codes.ts      exam access code generation
    ratelimit.ts  attempt limiting through public.rate_limit_hit
    auth.ts       requireStaff (token via Supabase Auth, role from the profiles table), and
                  isScheduledJob (the nightly housekeeping key; it opens the media purge and nothing else)
    audit.ts      writeAudit
    rpc.ts        callRpc: database functions; messages raised with hint "validation" become friendly 400 errors
    db.ts         service-role client (Edge Functions only)
  auth-me/        GET: who is signed in
  question-bank/  POST { action, ... }: list, get, save, remove, archive, restore, check_duplicates, topics,
                  class_labels, passages, passage_get, passage_save, passage_remove, import_check, import
  media/          POST { action, ... }: create_upload, register, signed_urls, purge_unused
  exams/          POST { action, ... }: save, list, get, remove, set_status, check_code, regenerate_code, duplicate
  session/        POST { action, ... } for students: join, get, save, heartbeat, event, submit, result, media
                  (join is open but rate limited; every other action needs the signed session token from token.ts)
  results/        POST { action, ... } for teachers: activity, pending, overview (the results table, and the
                  live monitor's read), report, grading_questions, queue, grade, add_time,
                  add_exam_time (more time for every running attempt), reopen, grant_retake, revoke_retake
                  (staff only)
tests/
  shared.test.ts        unit tests for the shared code
  question_bank.test.ts input parsing and the question-bank endpoint (with a fake database)
  media.test.ts         media endpoint input rules
  exams.test.ts         exams endpoint input rules
  session.test.ts       student session endpoint input rules and the session token
  results.test.ts       grading/results endpoint input rules (minutes to seconds, score bounds, limits)
```

## Rules for new functions

1. Wrap the handler in `handle(...)`; throw `ApiError` helpers for expected problems.
2. Staff endpoints start with `requireStaff(req, db, [roles])`. Student endpoints validate every input with `validate.ts` and are rate limited.
3. Text written by teachers goes through `sanitizeInlineHtml` before it is saved.
4. Every change made by staff calls `writeAudit`.
5. Never send answer keys to students; never put secrets or answer keys in audit `changes`.

## Running the tests

```
deno test --allow-env tests/
```

## The scheduled housekeeping door

`media` is the one function a machine may call: the nightly `pg_cron` job (TASK-015) sends
`x-housekeeping-key` with `{"action": "purge_unused"}` and the handler returns before `requireStaff`, so
the key never becomes a staff identity and opens **no other action** (every other request still needs a
signed-in person, and a teacher is still refused the purge). Both keys are SHA-256 hashed and compared
byte by byte; with no `HOUSEKEEPING_KEY` configured the door stays shut. See `docs/sql-jobs.md`.

## Deploying

`backend/functions/` is the source of truth; `../supabase/functions/` is a generated, gitignored deploy copy.
Run `python sync_functions.py` first, then `npx supabase functions deploy <name> --no-verify-jwt --use-api`
(`--use-api` bundles server-side, so Docker is not needed).

With the Supabase CLI, imports use `../_shared/` as written.
When deploying by uploading files (dashboard or API), upload each function with its needed `_shared` files and change `../_shared/` to `./_shared/` in the imports.
Functions verify the caller themselves (`requireStaff`), which is why JWT verification at the gateway is turned off.

## Secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically. Optional: `ALLOWED_ORIGIN` (the app's address) to restrict which websites may call the functions; `SESSION_TOKEN_SECRET` (falls back to the service role key) for the signed student session token. Required for the scheduled media purge: **`HOUSEKEEPING_KEY`**, which must equal the `housekeeping_key` secret in Supabase Vault — never commit it (rotation: `docs/sql-jobs.md`).
