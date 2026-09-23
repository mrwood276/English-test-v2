-- SECURITY FIX — public-schema functions were callable by anon/authenticated.
--
-- Context: v2_05/v2_08 (foundation + question-bank) already REVOKEd the default
-- PUBLIC execute grant Postgres puts on every new function. The exams (TASK-009),
-- session (TASK-010) and results/grading (TASK-012) function families — plus an
-- undocumented add_exam_time/list_live_sessions pair found live but never
-- committed — were created later by a role that does not carry that same
-- ALTER DEFAULT PRIVILEGES override, so they kept the Postgres default: EXECUTE
-- granted to PUBLIC. That meant `anon`/`authenticated` — i.e. the public
-- publishable key baked into the frontend — could call all 35 of these functions
-- directly via PostgREST (/rest/v1/rpc/<name>), completely bypassing
-- requireStaff(), the signed session-token check, rate limiting and audit
-- logging that only exist in the Edge Functions. No table, RLS, or application
-- logic changes here — service_role (used by every Edge Function) is untouched,
-- since it never depended on these grants (DEC-002: zero grants, all access
-- through Edge Functions).
--
-- This was found and fixed independently, minutes apart, by two AI review
-- sessions working the same audit concurrently on 2026-09-23 — both applied the
-- same revoke directly to the live project before either had committed anything
-- to git:
--   20260923050326  v2_13_revoke_public_function_execute            (session A)
--   20260923050351  v2_14_fix_exam_is_open_search_path               (session A)
--   20260923050413  v2_13_lockdown_exam_session_results_functions    (session B)
-- All three are already applied live; this file is the single git-tracked
-- record of that fix (continuing ISSUE-001's DB/git drift until a full
-- `supabase db pull` reconciles the whole migration history). Every statement
-- below is idempotent — safe to re-run even though it's already live.

revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- Also closes a WARN advisor: mutable search_path on a SECURITY-relevant helper.
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
