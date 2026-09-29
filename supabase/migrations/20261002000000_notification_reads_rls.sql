-- DEC-037 (2026-09-29): `notification_reads` joins the RLS-on baseline every other table is on.
--
-- The table is created by `20261001000000_notification_functions.sql`, which forgot the
-- `alter table … enable row level security` line the rest of the schema carries (`v2_01`–`v2_04`
-- each end their table definitions with it, DEC-002). The live project was found in exactly that
-- state: `public.notification_reads` exists with RLS **disabled**, although `anon` and
-- `authenticated` hold no privilege on it either way
-- (`docs/production-reconciliation-2026-09-28.md`, "Security drift", read-only, 2026-09-28).
--
-- RLS on with no policies is the project's boundary, not a policy someone has to invent: the
-- browser never reaches a table (00_AI_RULES / DEC-002), the API roles hold no grant, and the only
-- caller — the service role, through the two functions the `notifications` Edge Function invokes —
-- bypasses RLS by definition. Enabling it costs the feature nothing and means a grant added by
-- mistake later still cannot expose anybody's read state.
--
-- APPLIED LIVE: NOT YET (2026-09-29 — this session had no Supabase credential).
-- To apply: one `POST /v1/projects/<ref>/database/query` request with this file as `query`, then
-- insert the `schema_migrations` row (`20261002000000` / `notification_reads_rls`) — applying
-- through the Management API writes no tracking row by itself (`docs/sql-jobs.md`). Then re-run
-- `supabase/tests/notification_functions_test.sql` (it now asserts the RLS flag) and the Supabase
-- security advisor. Steps: `docs/sql-notifications.md`, TASK-026, ISSUE-036.

alter table public.notification_reads enable row level security;

-- Defense in depth, the same line the global lockdown takes for every other table.
revoke all on table public.notification_reads from public, anon, authenticated;
