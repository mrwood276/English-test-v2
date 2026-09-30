-- The live `schema_migrations` row `20260923050326` / `v2_13_revoke_public_function_execute`, committed
-- **verbatim** on 2026-09-30 out of `supabase_migrations.schema_migrations.statements`, so that every
-- row the live project holds has a file in this repository (ISSUE-036; the DEC-028 precedent from
-- ISSUE-024 — the live text is copied, not rewritten).
--
-- APPLIED LIVE 2026-09-23 by a session that never committed it. **NOT re-applied here** — the live
-- row and the SQL it ran already exist. Every statement is idempotent anyway.
--
-- It is one of the three rows written minutes apart that night by two independent review sessions;
-- `20260926000000_security_lockdown_function_execute.sql` is the single narrative record that names all
-- three, and this file is the ledger's own text. Reconciliation: `docs/migration-ledger-reconciliation.md`.

-- Enforce the zero-client-privilege design: anon/authenticated must never be able to
-- call database functions directly via PostgREST RPC. All access is meant to go
-- through Edge Functions using the service_role key, which is unaffected by this
-- revoke (service_role bypasses these grants).

revoke execute on all functions in schema public from public, anon, authenticated;

-- Prevent this regressing the next time a function is created in this schema.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
