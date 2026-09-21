# English Daily Test v2, backend

Supabase Edge Functions (Deno/TypeScript) for the v2 platform. Database schema lives in the Supabase project as migrations `v2_01` to `v2_08`. Business rules that must be atomic
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
    auth.ts       requireStaff (token via Supabase Auth, role from the profiles table)
    audit.ts      writeAudit
    rpc.ts        callRpc: database functions; messages raised with hint "validation" become friendly 400 errors
    db.ts         service-role client (Edge Functions only)
  auth-me/        GET: who is signed in
  question-bank/  POST { action, ... }: list, get, save, remove, archive, restore, check_duplicates, topics,
                  class_labels, passages, passage_get, passage_save, passage_remove
tests/
  shared.test.ts        unit tests for the shared code
  question_bank.test.ts input parsing and the question-bank endpoint (with a fake database)
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

## Deploying

With the Supabase CLI, `supabase functions deploy <name> --no-verify-jwt` works as is (imports use `../_shared/`).
When deploying by uploading files (dashboard or API), upload each function with its needed `_shared` files and change `../_shared/` to `./_shared/` in the imports.
Functions verify the caller themselves (`requireStaff`), which is why JWT verification at the gateway is turned off.

## Secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically. Optional: `ALLOWED_ORIGIN` (the app's address) to restrict which websites may call the functions.
