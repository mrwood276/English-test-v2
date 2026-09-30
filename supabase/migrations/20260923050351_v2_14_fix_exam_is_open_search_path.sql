-- The live `schema_migrations` row `20260923050351` / `v2_14_fix_exam_is_open_search_path`, committed
-- **verbatim** on 2026-09-30 out of `supabase_migrations.schema_migrations.statements` (ISSUE-036;
-- the DEC-028 precedent). It closed a `mutable search_path` advisor warning on a SECURITY-relevant
-- helper by pinning `public, pg_temp`.
--
-- APPLIED LIVE 2026-09-23. **NOT re-applied here** — the live function is this version (`create or
-- replace`, so a re-run would be a no-op anyway). The same definition also appears inside
-- `20260926000000_security_lockdown_function_execute.sql`, the narrative record of that night.
-- Reconciliation: `docs/migration-ledger-reconciliation.md`.

create or replace function public._exam_is_open(e exams)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $function$
  select e.status = 'open'
     or (e.availability_mode = 'scheduled'
         and now() between coalesce(e.starts_at, to_timestamp(0)) and coalesce(e.ends_at, to_timestamp('infinity','YYYY-MM-DD HH24:MI:SS')))
$function$;
