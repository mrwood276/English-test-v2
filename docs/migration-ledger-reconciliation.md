# Migration ledger reconciliation — measured 2026-09-30 (ISSUE-036)

**What this answers:** the live project's migration ledger and the files in `supabase/migrations/` did
not look like each other, so "can this database be reproduced from this repository?" had no answer.
It now does, because the two sides were read and compared rather than assumed:

- **27 live ledger rows**, **33 migration files** (after this session's three additions), and
- **every row is explained by a file**, **every live public function is explained by a file**, and
- **a fresh database can be built from this repository** by running the files in version order
  (recipe in `docs/production-deployment.md`).

Re-runnable, read-only: `python frontend/tests/live_ledger_check.py` with `SUPABASE_ACCESS_TOKEN`
set — three checks, `ALL LIVE LEDGER CHECKS PASSED`.

## Method (so the next session does not have to reconstruct it)

1. Read the ledger through the Management API:
   `select version, name, statements[1] from supabase_migrations.schema_migrations order by version`.
   `statements` holds the text each apply ran — that is the live record, not a rewriting of it.
2. Compare each row with the files, **ignoring comments and layout** (the "logic skeleton": comments
   stripped, whitespace collapsed, lowercased). Files whose only difference is a header comment are
   the same SQL; that distinction is what makes this reconciliation assert something meaningful.
3. Read every live `public` function's `pg_get_functiondef` and compare it with the **newest file (by
   version) that defines that function**. Older files are history: `list_exam_results` is defined by
   four files and only the last one is expected to match live.
4. Check the reverse direction too: which files have **no** ledger row, and why each is still not drift.

Nothing was applied, renamed or deleted in the live project to make the two sides agree. The live
ledger keeps the names history gave it; what changed is that the repository now holds a file for
every row and says out loud where each file stands.

## The ledger rows

| Live row | File in this repository | Note |
|---|---|---|
| `20260920095357` … `20260921064042` (`v2_01` … `v2_12`) | same-named files | Identical text. Pulled from the live ledger verbatim on 2026-09-24 (TASK-008). |
| `20260923050326` `v2_13_revoke_public_function_execute` | `20260923050326_v2_13_revoke_public_function_execute.sql` | **Added 2026-09-30**, verbatim out of `statements` (the DEC-028 precedent). Applied live 2026-09-23 by a session that never committed it; one of the three rows `20260926000000_security_lockdown_function_execute.sql` records in narrative form. |
| `20260923050351` `v2_14_fix_exam_is_open_search_path` | `20260923050351_v2_14_fix_exam_is_open_search_path.sql` | **Added 2026-09-30**, verbatim. Same `_exam_is_open` definition the lockdown file also carries. |
| `20260923050413` `v2_13_lockdown_exam_session_results_functions` | `20260923050413_v2_13_lockdown_exam_session_results_functions.sql` | **Added 2026-09-30**, verbatim. The other concurrent lockdown of that night; the live ledger kept both because both really ran. |
| `20260923112142` `v2_15_monitor_overview_fields` | `20260925000000_monitor_overview_fields.sql` | **Same SQL, different version name.** The file carries a 4-line header the row does not; its body is identical to the row's (measured). |
| `20260924063427` `dashboard_activity_fields` | `20260928000000_dashboard_activity_fields.sql` | Same SQL, different version name (header only). |
| `20260925001719` `v2_16_audit_functions` | `20260929000000_audit_functions.sql` | Same SQL, different version name (header + two re-indented lines). |
| `20260925060607` `v2_17_duplicate_overview` | `20260925060607_v2_17_duplicate_overview.sql` | The file is the live text plus the explanatory header the DEC-028 commit added. |
| `20260925060638` `v2_17_duplicate_overview_fix_search_path` | `20260925060638_v2_17_duplicate_overview_fix_search_path.sql` | Same, for the search-path follow-up. |
| `20260926002454`, `20260926010636`, `20260926021234` | same-named files | Identical text; applied and tracked in the same session that wrote them (the pattern `docs/sql-jobs.md` documents). |
| `20260928000001` `bulk_question_update` | `20260928000001_bulk_question_update.sql` | Same SQL; the file's header records the apply, the row's did not. |
| `20260928000002` `bulk_exam_questions` | `20260928000002_bulk_exam_questions.sql` | The row holds the **first** apply; the file and the live function carry the **renumber fix** from the second apply (ISSUE-034). The live object is the file's version. |
| `20261001000000` `notification_functions` | `20261001000000_notification_functions.sql` | Identical text — the reconstruction was checked against live on 2026-09-30, including `_actor_profile`, and matches. |
| `20261002000000` `notification_reads_rls` | `20261002000000_notification_reads_rls.sql` | Applied live 2026-09-30 with its own row (TASK-026). |

## Files with no ledger row (9)

These were applied by direct `database/query` calls — the historical habit that created ISSUE-001 and
this issue — so the ledger never recorded them. None of them is drift in the other direction: **every
function they define is superseded by a later file whose definition matches live**, or is itself the
current definition.

| File | Why it is not drift |
|---|---|
| `20260922000000_exams_functions.sql` | Applied 2026-09-22. Its `list_exams`/`remove_exam` are the older pair; `20260930000000_exam_delete_with_attempts.sql` holds the live definition. The other seven functions are unchanged since. |
| `20260923000000_session_functions.sql` | Applied 2026-09-23. Its `_session_grade` is superseded by `20260924000000_result_functions.sql`; the other twelve match live. |
| `20260924000000_result_functions.sql` | Applied 2026-09-24. `list_exam_activity` is superseded by `20260928000000_dashboard_activity_fields.sql`, `list_exam_results` by `20260927000000_exam_wide_add_time.sql`; the other ten match live. |
| `20260925000000_monitor_overview_fields.sql` | Tracked live as `20260923112142` (above). Its `list_exam_results` is superseded by `20260927000000_exam_wide_add_time.sql`. |
| `20260926000000_security_lockdown_function_execute.sql` | The narrative record of the three `2026092305…` rows, which now each have their own verbatim file. Idempotent revokes. |
| `20260927000000_exam_wide_add_time.sql` | Applied 2026-09-24; holds the live `add_exam_time` and `list_exam_results`. |
| `20260928000000_dashboard_activity_fields.sql` | Tracked live as `20260924063427` (above); holds the live `list_exam_activity`. |
| `20260929000000_audit_functions.sql` | Tracked live as `20260925001719` (above); holds the live `list_audit_logs`. |
| `20260930000000_exam_delete_with_attempts.sql` | Applied 2026-09-25; holds the live `list_exams`/`remove_exam` (DEC-027). |

## What was verified, and with what

Measured on 2026-09-30 against `lbhnadqmokloyfarrzfv`, read-only (`frontend/tests/live_ledger_check.py`):

- 27 rows / 33 files; every row pointed at a file (same-named, or the same SQL under another name).
- **81 live public functions**, every one defined by a file, and the newest file that defines it
  matching the live body once comments and whitespace are ignored. Functions with more than one
  defining file are printed with the count of older ones, so the version chains are visible.
- The nine files with no ledger row printed and matched against the known set — a new unexplained file
  fails the check.
- Advisors, for the record: **0 ERROR-level findings**; the security advisor's INFO items are the 23
  `rls_enabled_no_policy` notes the project's RLS-on-zero-policy design produces by construction, and
  its one WARN is the pre-existing ISSUE-005 (leaked-password protection); the performance advisor's
  15 are INFO index suggestions.

## What this does not do

- It does not rewrite the live ledger to match the file names, and it does not claim the live rows were
  applied *from* these files. The rows are history; the files are now their record.
- It does not insert ledger rows for the nine hand-applied files. Their SQL is live and explained, but
  no apply ever recorded a row, and inventing one would be exactly the fabrication ISSUE-036 warned
  against. `supabase db push` would try to run them; every one is `create or replace` or an idempotent
  revoke, and in version order the last file wins — which is the state live is in.
- It does not cover tables, indexes, grants or policies object by object; the function-level and
  RLS-level checks are what the issue asked for, and `docs/production-deployment.md` says how a fresh
  database is built.
