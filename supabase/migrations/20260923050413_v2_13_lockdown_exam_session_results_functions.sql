-- The live `schema_migrations` row `20260923050413` / `v2_13_lockdown_exam_session_results_functions`,
-- committed **verbatim** on 2026-09-30 out of `supabase_migrations.schema_migrations.statements`
-- (ISSUE-036; the DEC-028 precedent). This is the second of the two concurrent lockdowns that night,
-- by the other review session — the live ledger kept both, because both really ran.
--
-- APPLIED LIVE 2026-09-23. **NOT re-applied here** — the revoke already holds live, and it is
-- idempotent. The narrative record naming all three rows of that night is
-- `20260926000000_security_lockdown_function_execute.sql`.
-- Reconciliation: `docs/migration-ledger-reconciliation.md`.

-- SECURITY FIX (found during ai-development -> main review, 2026-09-23/24).
-- The exams (TASK-009), session (TASK-010) and results/grading (TASK-012, plus the
-- undocumented add_exam_time/list_live_sessions pair found live but never committed)
-- function families were created without the REVOKE that every question-bank function
-- already has (v2_05/v2_08). Postgres grants EXECUTE to PUBLIC by default, and these
-- functions were apparently created by a role that does not carry the same
-- ALTER DEFAULT PRIVILEGES override the `postgres` role has for this schema, so `anon`
-- and `authenticated` could call every one of them directly via PostgREST
-- (/rest/v1/rpc/<name>), completely bypassing requireStaff() and the signed
-- session-token check that live only in the Edge Functions. This closes that gap; no
-- table, RLS, or application logic changes. service_role (used by every Edge Function)
-- is untouched, since it never depended on these grants.

revoke execute on all functions in schema public from public, anon, authenticated;

-- Make sure functions created later by whichever role runs this also default to no PUBLIC
-- execute grant, matching the `postgres`-role default already in effect for this schema.
alter default privileges for role current_user in schema public revoke execute on functions from public;
