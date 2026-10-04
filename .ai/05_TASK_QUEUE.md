# Task Queue

## Done (2026-10-04, UI/UX phase)
- Router focus management, skip link, bell retry + `aria-controls`, join `aria-invalid`,
  exam progressbar a11y, toast duration/class fixes, confirmDialog focus return,
  skeleton rows (question bank, exams, grading), error-state retry buttons
  (exams, grading, monitor), leftover console noise removed. All verified — see
  `04_CURRENT_STATE.md` for the test evidence.

## Open — P0/P1 from the 2026-10-04 engineering audit (backend/security; NOT started)
- TASK-001 (C-4): CI skeleton in `.github/` — README claims CI that does not exist.
- TASK-002 (C-2/H-7): run the four isolation suites in `supabase/tests/` against a live
  database; migration headers claim "passed live" but `question_bank_isolation_test.sql:11-14`
  admits "NOT YET RUN LIVE".
- TASK-003 (H-3): finish recreating `.ai/` (only 00/04/05/08/09 exist so far).
- TASK-004 (H-4): reconcile the migration ledger drift noted in
  `docs/verification-checklist.md:24-26`.
- TASK-005 (C-1): student identity hardening — identity is currently name+class+code
  (`supabase/migrations/20260923000000_session_functions.sql:174-194`), which allows
  impersonation, attempt pre-consumption, and answer pre-filling. Requires a design
  decision (server-issued join token or similar) before coding.
- TASK-006 (H-1): stop defaulting CORS to `*` (`backend/functions/_shared/http.ts:9,25`).
- TASK-007 (H-2): session token secret must not fall back to the service-role key
  (`backend/functions/session/token.ts:50-53`).
- TASK-008 (H-5): correct overstated README status (`README.md:5`, false CI claim at
  `README.md:32`).
- TASK-009 (H-6): submit reason is client-trusted — derive it server-side.
- TASK-010..012: medium/low audit items (M-1..M-10, L-1..L-7) — details in the audit
  report delivered 2026-10-04 (report is not stored in the repo).

## Open — UI/UX (low priority, found during the UI phase)
- `examResults.js` question-statistics error state: add a "Try again" button
  (same pattern as grading/monitor).
- `confirmDialog` message paragraph could get `aria-describedby` (minor).
- Consider skeleton rows on the monitor boards — rejected for now because of the 30 s
  auto-refresh flicker; revisit only if the refresh interval changes.
