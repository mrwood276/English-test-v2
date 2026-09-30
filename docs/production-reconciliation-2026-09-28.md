# Production reconciliation — 2026-09-28

## Git and live state

- `main`: this section was written while `main` sat at `9c293fc`. **It has since been replaced: `main` is now the orphan snapshot `8b7aeba`** — one commit, **no parents**, 216 files, a tree byte-identical to `audit-reconcile`'s merge `4e4b3b8`, i.e. the twenty-fourth session's state. It shares no history with anything and cannot be merged, only replaced; it is materially behind the live system, as both versions were.
- `ai-development`: active development/reconciliation line — at `53baaa1` when this was written, and at **`e1a7f7b`** (this recovery commit) since. On 2026-09-29 the branch tangle was resolved onto it; see the salvage note at the end.
- Live Supabase project: `lbhnadqmokloyfarrzfv`, PostgreSQL 17.6.1, ACTIVE_HEALTHY.
- Live Edge Functions: 10 ACTIVE functions: auth-me v2, question-bank v9, media v4, exams v6, session v2, results v5, audit v2, backups v1, accounts v1, notifications v1.
- Live migration ledger: 26 applied rows when this was written; **27 since 2026-09-30** (`notification_reads_rls`), and all of them reconciled against the files — see below.
- This reconciliation made no production writes.

## Edge Function source inventory

| Function | Repository source on ai-development | Live version | Live SHA-256 |
|---|---|---:|---|
| auth-me | backend/functions/auth-me | 2 | d0aefdd213b7b8f4b1a6a8b4d327c626457df31879683284655366713657434f |
| question-bank | backend/functions/question-bank | 9 | f2e53d4df27b06b30065e78f85865908642e336903573d86d3097fd5e9641bc5 |
| media | backend/functions/media | 4 | 6fff0c1a95ee4f15e1100cd234cd0e5de2b550bd05fee10576706e4c3416dd00 |
| exams | backend/functions/exams | 6 | 1a0881e0733b82629c5fb46cbd162e2820027e229b1dea8fd7b0025e75787e32 |
| session | backend/functions/session | 2 | 8592d4c32b63ee02f84cb8d9eef2a7291319b4aa3004e0e0f6ab4f3568e8dcc6 |
| results | backend/functions/results | 5 | d059c19ddcf60423af468ec3738336c222708ea4b95b2c89531a12cc793462c2 |
| audit | backend/functions/audit | 2 | 0a70c4f461d392dd7a23b7be05e314d9e4b777c4be3fe027ecfc25bfc422da8f |
| backups | backend/functions/backups | 1 | b03bcc90da54762d96bd6dae1629b2b230b492c557ae83ea787c9b9c8b842970 |
| accounts | backend/functions/accounts | 1 | 18684b421ba95b7637b6045fe41b54aea245541c5cdd5589c2d37f4a45267e9c |
| notifications | backend/functions/notifications | 1 | bd552d82cfd44d0601464ebd91c684ebbe5fe1278e972a2ae1db06e33b76e67c |

The live hash is recorded for every function. Exact bundle-to-Git parity is not claimed unless independently reproduced.

## Migration reconciliation

Git `ai-development` contains the original core `v2_01`–`v2_12` migration files plus later development migrations. The live ledger contains additional/differently named rows, including lockdown/search-path fixes, audit, housekeeping, backups, accounts, and notifications.

The notification migration added here is explicitly reconstructed from live definitions because the original historical SQL was not retrievable through the available management API. It should not be described as byte-for-byte historical recovery — **re-checked against live on 2026-09-30 and it matches, `_actor_profile` included.**

**Resolved 2026-09-30 (TASK-026's credentialed session).** The ledger was read row by row (version, name and the
`statements` each apply ran) and compared with `supabase/migrations/`: 27 rows, every one explained by a file
(same-named, captured verbatim, or the same SQL under another version name), and every live public function
matching the newest file that defines it. Nine files have no ledger row — applied by direct `database/query`
long ago — and each is listed with its reason. Full mapping, method and the re-runnable check:
**`docs/migration-ledger-reconciliation.md`** and `frontend/tests/live_ledger_check.py`.

## Security drift

`public.notification_reads` currently has RLS disabled. Read-only privilege checks show `anon` and `authenticated` have no table privileges, but the table is outside the project's otherwise consistent RLS-on baseline. No RLS change was made because the intended policy boundary must be decided first.

**Fixed 2026-09-30:** the boundary needed no new decision — the project's baseline is RLS on with **no
policies** and no grant to `anon`/`authenticated` (DEC-002), and the service role bypasses RLS.
`supabase/migrations/20261002000000_notification_reads_rls.sql` was applied live as one Management API request
with its `schema_migrations` row (`20261002000000` / `notification_reads_rls`); the table now reads
`relrowsecurity = true`, 0 policies, grants only to `postgres` and `service_role`, the rolled-back
`supabase/tests/notification_functions_test.sql` passed live (`NOTIFICATION TESTS PASSED (…)`), the security
advisor reports **no ERROR-level finding** (23 INFO `rls_enabled_no_policy` notes, one WARN = ISSUE-005), and
`frontend/tests/live_notifications_check.py` passed **35/35** (`ALL LIVE NOTIFICATION CHECKS PASSED`).

## Next decisions — all three resolved

1. **Ledger reconciled** (2026-09-30): see `docs/migration-ledger-reconciliation.md`.
2. **Decided 2026-09-29** (DEC-037): the server-backed bell is the one system; DEC-032's dashboard notices were retired.
3. **Applied 2026-09-30**: `20261002000000_notification_reads_rls.sql` is live, tested and on the advisors' clean side (see "Security drift" above).

## Salvage note — 2026-09-29 (branch reconciliation)

This file, and the six docs-only commits that carried it, lived only on the branch **`backup-ai-development`**, whose tip `ef6b545` is a merge that deletes ~230 files (a 4-file tree). That line was never merged and never will be; **everything fact-bearing in it is folded in above and here**, so the ref can be deleted. The facts recovered from it, all read-only on 2026-09-28:

- Live Supabase runs **10 ACTIVE Edge Functions**, `notifications` v1 among them — so the server-backed notification design was the **deployed** one, and DEC-032's dashboard-only design was never deployed at all. That settled decision 2: the bell was adopted as the one system, and DEC-032's notices were retired (**DEC-037**, 2026-09-29).
- The live **migration ledger holds 26 applied rows** whose names do not match the files in `supabase/migrations/`, because some SQL was applied by direct `database/query` request. Decision 1 is therefore **open and real** — a fresh environment cannot be reproduced from this repository (ISSUE-036, HIGH for deployment).
- The notification migration in Git is an **explicitly reconstructed representation** of the live definition, not the original text. It was also **incomplete**: it calls `public._actor_profile(p_actor)` twice and defines it nowhere, so it would have failed on the bell's first call (ISSUE-037, fixed in the working copy that the tree here committed). Whether live has that helper is unanswered from Git — it may come from a ledger row Git does not hold.
- Live `public.notification_reads` had **RLS disabled** (decision 3). The boundary is not a new policy question: the project's baseline is RLS on with **no policies** and no grant to `anon`/`authenticated` (DEC-002), and the service role bypasses RLS. `supabase/migrations/20261002000000_notification_reads_rls.sql` now applies that baseline; it is **NOT applied live** — TASK-026.

Also measured in that session, and the reason it could be done at all: `origin/ai-development` `e1a7f7b` is the one tip whose history contains every other line (`feat-bulk` is its parent; `prod-prep`, `audit-reconcile` and the local checkout were ancestors with zero commits of their own), `origin/main`'s snapshot had **no unique file**, and the old `main` and the monitor branch held no capability the mainline lacks.
