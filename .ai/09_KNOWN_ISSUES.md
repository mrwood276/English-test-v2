# Known Issues

## Open — from the 2026-10-04 engineering audit (backend/security; unchanged by the UI phase)
- **C-1 (Critical)** Student identity is name+class+access-code
  (`supabase/migrations/20260923000000_session_functions.sql:174-194`): anyone with the
  board code can impersonate a student, pre-consume their attempt, or pre-fill answers.
  Fix needs a design decision (server-issued join token). The join form's new
  `aria-invalid` feedback does NOT mitigate this.
- **C-2 (Critical)** Isolation tests were never run against a live database
  (`supabase/tests/question_bank_isolation_test.sql:11-14` admits it), while
  `20261003000000_question_bank_isolation.sql:29-33` claims the test "passed live".
- **C-3 (Critical)** A fail-open guard was documented as shipped once
  (`supabase/migrations/20261004000000_exam_isolation.sql:19-24`).
- **C-4 (Critical)** No CI exists (`.github/` absent) although `README.md:32` claims it.
- **H-1** CORS defaults to `*` (`backend/functions/_shared/http.ts:9,25`).
- **H-2** Session-token secret falls back to the service-role key
  (`backend/functions/session/token.ts:50-53`).
- **H-4** Migration ledger drift (`docs/verification-checklist.md:24-26`).
- **H-5** README overstates status (`README.md:5`) and claims CI (`README.md:32`).
- **H-6** Exam submit reason is client-trusted (should be server-derived).
- **H-7** Four isolation migrations are unverified against a live DB.
- **M-1..M-10, L-1..L-7** — full details in the audit report (delivered in conversation
  2026-10-04; not stored in this repo). One known M-item: no build step, so no asset
  fingerprinting/cache-busting (`frontend/index.html` references plain asset paths).

## UI/UX issues — resolved this session (kept as a record)
- Error toasts on exams/dashboard/monitor/grading/results screens were visually identical
  to info toasts: screens passed `kind="bad"` while CSS only defined `.toast.error`.
  Fixed in CSS (`.toast.bad` now red); the JS class name is intentionally unchanged
  because e2e suites select on it.
- Keyboard focus stayed on the nav link after route change; fixed with `main.focus()`.
  No skip link existed; added.
- Bell error state was a dead end; now has "Try again".
- First paint of question bank / exams / grading showed an empty table with only a
  "Loading…" status line; skeleton rows added.
- Error states on exams / grading / monitor had no retry affordance; added.
- Exam progress bar was visual-only; now `role="progressbar"` with live values.
- Join form did not mark the invalid field; now `aria-invalid`.
- `confirmDialog` dropped keyboard focus to `<body>` on close; now returns it.

## Known, accepted (low priority)
- Monitor boards show "Loading…" without skeletons (deliberate: 30 s auto-refresh).
- One crash log from a failed intermediate approach lives in
  `frontend/tests/.last-crash/exams_e2e-20261004-153228.log` (gitignored); it documents
  the toast-class test contract described in `08_HANDOFF.md`.

## Incidents recorded (ISSUE-039 harness did its job; none were code defects)
- `results_e2e` crashed with `ERR_CONNECTION_REFUSED` because the static test
  server on :8123 had been stopped between runs; restarting it fixed it.
- `live_ledger_check` crashed with "JWT could not be decoded": the session's
  `SUPABASE_ACCESS_TOKEN` is invalid (the Management API answers 401). Live
  checks remain unrun until a valid token (and staff email/password) is supplied.
- `monitor_e2e` check "empty hub explains itself" failed once, then passed in
  three consecutive runs with identical code — treated as environmental flakiness.
