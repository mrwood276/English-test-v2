# Production reconciliation — 2026-09-28

## Git and live state

- `main`: stable at `9c293fc`; it is materially behind the live system.
- `ai-development`: active development/reconciliation line at `53baaa1`.
- Live Supabase project: `lbhnadqmokloyfarrzfv`, PostgreSQL 17.6.1, ACTIVE_HEALTHY.
- Live Edge Functions: 10 ACTIVE functions: auth-me v2, question-bank v9, media v4, exams v6, session v2, results v5, audit v2, backups v1, accounts v1, notifications v1.
- Live migration ledger: 26 applied rows.
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

The notification migration added here is explicitly reconstructed from live definitions because the original historical SQL was not retrievable through the available management API. It should not be described as byte-for-byte historical recovery.

## Security drift

`public.notification_reads` currently has RLS disabled. Read-only privilege checks show `anon` and `authenticated` have no table privileges, but the table is outside the project's otherwise consistent RLS-on baseline. No RLS change was made because the intended policy boundary must be decided first.

## Next decisions

1. Reconcile live migration names/ledger against Git without fabricating history.
2. Decide whether the live server-backed notifications architecture supersedes DEC-032's dashboard-only design.
3. Decide the intended RLS/grant boundary for `notification_reads`, then apply and test it in a dedicated migration.
