# 04 CURRENT STATE

## Snapshot

| Item | Value |
|---|---|
| Last updated | 2026-09-24 (Codex — TASK-014 CI follow-up) |
| Last AI agent | Codex (fifteenth session: pulled `ai-development`, watched the new dashboard suite in CI, fixed its setup error at the root, and verified both workflows green). |
| Development phase | Phase 5 **FULLY LIVE-VERIFIED**; Phase 6 dashboard/UX polish complete and CI-verified. |
| Current focus | **TASK-014 complete and closed in CI.** TASK-012 is down to the owner-dependent **PDF class summary**. Next code work: TASK-015 (jobs/audit/notifications) or TASK-020 (duplicate banner). |
| Branch model | `main` = stable. `ai-development` = shared AI development. |
| Current branch / commit | **`ai-development`**; verified product change `2ea6ac0` (dashboard-test setup fix on top of `dab2a48`, TASK-014 dashboard/mobile-menu work). This handoff adds a docs-only commit on top. Backend run #36 and Frontend run #28 are green at `2ea6ac0`. |
| Repository baseline | Prefer `ai-development` for all work. `origin/main` still has Codex import variant (DEC-021). |

## What was inspected to write `.ai/`

- All files of the repository copy (65 tracked files before `.ai/`), including code, tests, docs, workflow.
- The **live Supabase project**: migrations list, Edge Function list and versions, tables and RLS state, policies count, functions count, storage buckets, row counts, extensions.
- Test runs (2026-09-24, fifteenth session, from this clone): backend `deno test --allow-env backend/tests/` = **106 passed**, 0 failed; all frontend unit tests = **31 passed**, 0 failed; `git diff --check` = clean. GitHub Actions at `2ea6ac0`: Backend tests run #36 green; Frontend tests run #28 green, including all ten mocked browser suites (`dashboard_e2e.py` passed). This Windows agent still has no Python/Playwright runtime.
- No TODO/FIXME comments exist in the code (scan returned nothing).

## Live system facts (verified 2026-09-21)

| Item | Value |
|---|---|
| Tables | 22, all RLS on, 0 policies (public and storage schemas) |
| Migrations applied | `v2_01` .. `v2_12` (12) |
| Edge Functions (as of 2026-09-24, eleventh session) | `auth-me` v1, `question-bank` v3, `media` v1, `exams` v3, `session` v1, **`results` v4** (grading/reports + the monitor + exam-wide add time); all ACTIVE, `verify_jwt=false` |
| Public SQL functions | **60** (verified live on 2026-09-24; the eleventh session added `add_exam_time` and dropped the duplicate `list_live_sessions`) |
| Storage | bucket `question-media`, private, 10 MB limit |
| Data (2026-09-24) | 40 questions (0 archived), 5 passages, 13 topics, 0 media files, **0 exams, 0 sessions, 0 answers, 0 grades, 0 results, 0 session events, 0 retake permissions, 0 rate-limit rows**, 1 profile (admin), 4 audit rows — every verification row was deleted again |
| Auth users | 1 admin (email known to the owner; not repeated here). No teacher account |

## Live system facts (re-verified 2026-09-22, fifth session, via the CLI + admin sign-in)

- Anon REST read of `questions` → HTTP 401, `permission denied` (Postgres 42501) — the zero-policy lockdown holds on the live data (re-checked).
- Tokenless calls to `question-bank` **and** `exams` → HTTP 401, body exactly `"Please sign in."` — the in-code auth wall works in production for both functions.
- Anon `storage/v1/bucket` list → `"Bucket not found"` — the private `question-media` bucket leaks nothing (unchanged).
- CORS preflight from `http://localhost:8000` → `Access-Control-Allow-Origin: *` — the `ALLOWED_ORIGIN` secret is not set (expected until hosting exists; TASK-017).
- `auth/v1/settings` → **email sign-ups are still ENABLED** (checked in the third session; the owner has not flipped it yet — ISSUE-007).
- Admin sign-in via the API works (HTTP 200, `expires_in` 3600); `profiles` has exactly one row (admin, `is_active`).
- Live schema facts discovered while applying the exam SQL: `exams.status`/`availability_mode`/`late_start_policy`/`selection_mode`/`result_visibility`/`essay_pending_display` are Postgres **enums**; `exam_questions.position` has `CHECK (position > 0)` + deferred `UNIQUE (exam_id, position)`; `exams.access_code` has `CHECK (^[A-Z0-9]{4,12}$)`; `auto_filter` is NOT NULL default `'{}'`. Full list in `docs/sql-exams.md`.

## Live system facts (re-verified 2026-09-24, eighth session)

- The `results` function is deployed (v1) and serves the whole grading loop; the exam SQL is applied live and re-runnable (idempotent).
- Full grading loop verified through the deployed function with the admin account (**38/38 checks**): two students joined and submitted, both essays graded → both results became final (`passed` / `failed`), a grade corrected by hand, a re-submit after a `reopen` did **not** undo the correction (DEC-023), `add_time`, `grant_retake`/`revoke_retake`, plus the refusal paths (grading a running session, points over the weight, a foreign session id, a tokenless call). Contract and cleanup block: `docs/sql-results.md`.
- Doc drift found and corrected: the deployed `exams` function is at **version 3** (the `.ai/` files still said v1) and the live public SQL function count is **59**, both read straight from the project.
- Row counts after cleanup: 0 exams, 0 exam_sessions, 0 session_answers, 0 answer_grades, 0 exam_results, 0 session_events, 0 retake_permissions, 0 rate_limits, 40 questions, 4 audit rows.

## Live system facts (re-verified 2026-09-24, fourteenth session)

- `supabase/migrations/20260928000000_dashboard_activity_fields.sql` was applied live via Supabase MCP. `list_exam_activity` now returns `passed` and `failed` in addition to every existing field; no table, policy, or Edge Function action was added.
- Read-only verification: the function returned `[]` with the live project's 0 exams/sessions; `pg_proc.proacl` still grants execute only to `postgres` and `service_role` (PUBLIC/anon/authenticated refused); the security advisor showed only its expected INFO and the pre-existing ISSUE-005 WARN.
- No Edge Function redeploy was needed: `backend/functions/results/handler.ts` passes the SQL function's JSON through unchanged.

## Live system facts (re-verified 2026-09-23, seventh session)

- The `session` function is deployed and answers: a tokenless call is refused with HTTP 400 (`token is required`), a forged token with **HTTP 401** — the signed-token wall works in production (DEC-022).
- Full student flow verified through the deployed function with the admin account creating/opening the exam (27/27 checks; see the changelog and `docs/sql-sessions.md`).
- Live schema fact discovered while applying the session SQL: `exam_sessions.student_name_normalized`/`student_class_normalized` are GENERATED columns (`normalize_text`), as are `accepted_answers.answer_normalized` and `question_class_labels.label_normalized` — inserting them is an error (Postgres 428C9).
- Row counts after cleanup: 0 exams, 0 exam_sessions, 0 session_answers, 0 exam_results, 0 session_events, 0 rate_limits, 40 questions, 4 audit rows.

## Drift between repository and live system (important)

| Area | Repository | Live | Consequence |
|---|---|---|---|
| `exams` | full handler + parser + 24 Deno tests; screens list + editor | **v3 live**; SQL applied; flow live-verified | Exam screens work against the real backend |
| `results` | handler + parser + 20 Deno tests; grading/results screens + the monitor and the exports | **v4 live** (grading, reports, the monitor `overview` and exam-wide add time); grading loop live-verified (38/38) | No drift |
| `session` | handler + parser + token + 21 Deno tests | **v1 live**; student flow live-verified | No drift |
| `question-bank` | has actions `import_check`, `import` | **v3 live**; `import_check` answered live | Import works against real backend; left: owner format review + real Excel file (ISSUE-013 caveat) |
| Monitor UI (F-13) | `examMonitor.js` / `sessionTimeline.js` + routes, `monitor_e2e.py` (30 checks) | reads the `results` function's `overview`/`report` actions (v4 live) | No drift — live-verified in a real browser (TASK-022, 20/20) |
| Dashboard (F-03) | `dashboard.js` reads the existing `exams` and `results` APIs; `dashboard_e2e.py` added | live SQL activity fields applied; Edge Function unchanged | No drift |
| SQL migrations | first migration in git: `supabase/migrations/20260922000000_exams_functions.sql` (applied live) | `v2_01`..`v2_12` + the exams functions | ISSUE-001 partially closed; `supabase db pull` can bring the older ones in |
| Frontend | `APP_BUILD` = "Phase 4, grading and results" | not deployed | The owner runs it locally with `frontend/dev-server.py` |

## Recently completed work (newest first)

1. **TASK-014 dashboard and UX polish (2026-09-24, CI green)**: mockup-5 dashboard (big code, live preview, essays/page exits, recent pass-rate meters, 30-second refresh) built on existing payloads (DEC-026); phone menu compacted into a sticky one-row scroll; `list_exam_activity` extended with `passed`/`failed` and applied live; `dashboard_e2e.py` and the CI workflow verified green in Actions.

2. **TASK-012 core — grading, results, teacher actions on an attempt (2026-09-24)**: SQL functions in `supabase/migrations/20260924000000_result_functions.sql` (applied live; `docs/sql-results.md`); `_session_result_write` as the single writer of `exam_results` and `_session_grade` re-created to skip hand-graded questions (DEC-023); the `results` Edge Function deployed (11 staff-only actions); the Grading screen (mockup 13), the per-exam results screen (mockup 14), the attempt report with per-question grading and add time / reopen / retake; `supabase/tests/result_functions_test.sql` (rolled back), 18 Deno tests, `results_e2e.py` (59 checks); CI now runs eight suites; live-verified with the admin account (38/38) and cleaned up afterwards. **ISSUE-017 closed.**
2. **TASK-010 student exam engine (2026-09-23)**: SQL functions in `supabase/migrations/20260923000000_session_functions.sql` (applied live; `docs/sql-sessions.md`); `session` Edge Function deployed (signed session token, per-address join limit, per-session autosave limit, media signing); the student page `frontend/index.html` (join → take the test → result) with offline-tolerant autosave, a server-backed timer, the answer sheet, page-leave warnings and the auto-submit limit; `supabase/tests/session_functions_test.sql` (rolled back), 21 Deno tests, `student_e2e.py` (52 checks); live-verified with the admin account (27/27) and cleaned up afterwards.
2. **TASK-009 teacher-side exams (2026-09-22)**: `exams` Edge Function (list/get/save/remove/set_status/regenerate_code/check_code/duplicate) with 24 Deno tests; exams list screen (filters, open/close, duplicate, delete) and exam editor (manual/auto selection, schedule, live code uniqueness check, shuffle, 1/3/5 tab limits, result visibility, summary, leave guard, templates); routes + live Exams menu; mock-server handlers; `exams_e2e.py` (25 checks); SQL reference `docs/sql-exams.md` **not yet run live**.
2. **TASK-006 steps 1–2, import browser work is done**: the import screen `#/questions/import` (file or paste → defaults → review table with statuses → all-or-nothing import), wired into the router and the question bank; zip/xlsx readers now tested against a real .xlsx fixture (ISSUE-013 closed); template files under `frontend/assets/templates/`; new Playwright suite `question_import_e2e.py` (43 checks). Verified only against the mock server — see the XLSX and live caveats below.
2. Import parsers for CSV, XLSX, and pasted text with 21 Deno unit tests.
3. Import backend: SQL `find_similar_batch`, `import_questions` (live, tested); Edge code + tests (repo only, not deployed).
4. Images and audio: bucket, SQL, `media` function (deployed), file picker, previews, tests. Not yet verified with real Storage.
5. Question editor, reading texts, question bank screens (live-verified basics by the owner).
6. Sign in, app shell, shared backend library, `auth-me`.
7. Database schema, dev Supabase project, migration of the 40 v1 questions (fingerprint-verified against v1).
8. Design document Draft 4, audit of v1, two rounds of approved mockups.

## Work in progress

- **TASK-012**, on branch `ai-development**: only the **PDF class summary** remains, and it needs the owner's decision on the one-page content. CSV/Excel and both statistics tabs are built and tested.
- **TASK-006**, on branch `ai-development`: deployed and working; remaining is the owner's review of the proposed import formats and one real Excel/Google-Sheets file.
- **TASK-015** is the next ordinary code task: scheduled `expire_sessions()` / `purge_rate_limits()`, an audit-log viewer, and dashboard/email notifications.

## Pending work (see `05_TASK_QUEUE.md`)

**TASK-015** (scheduled expiry/purge jobs, audit-log viewer, notifications) is the next code task; **TASK-020** (duplicate-overview banner) is a smaller alternative. Owner-dependent items: the PDF class-summary content (TASK-012), import-format review (TASK-006), disable public sign-up (ISSUE-007), and one real media upload (TASK-007).

## Blocked work

No code task is blocked. Release remains blocked on the two owner-only items: public sign-up must be disabled in Supabase Auth (ISSUE-007), and one real image/audio upload must be checked against live Storage (TASK-007). The migration-tracking discrepancy in ISSUE-001 also needs a real DB connection/password, not agent-alone work.

## What the owner has verified live

- Signing in with the admin account works (the owner last saw the old `Welcome`/connection-check placeholder; the new mockup-5 dashboard is automated-test evidence, not an owner walkthrough).
- The question bank shows the 40 migrated questions; add/edit editor opens and works after clearing a stale browser cache (old JS modules were cached; fixed by `dev-server.py`).
- Everything else about the editor beyond opening and basic add/edit is verified only by automated tests.
- (The student flow and the grading loop were verified against the live backend by the agent, not by the owner in a browser: the deployed functions and their SQL were exercised over HTTP, while the *screens* were verified against the mock server only. One owner run of `frontend/index.html` and of the grading screens against the real project is still worth doing.)

## Known regressions

None from this session. The earlier `media_e2e.py` fixture-size quirk in ISSUE-014 was fixed on 2026-09-22; the test now compares against the generated file's real size.

## Current risks

1. The live migration-tracking table is missing rows for three already-live migrations (ISSUE-001 follow-up; needs a real DB connection).
2. Media upload untested against real Storage (ISSUE-002 / TASK-007).
3. Public email sign-up is still enabled (ISSUE-007).
4. v1 keeps serving real students with its known weaknesses (`docs/audit-v1.md`); owner decided not to patch it (DEC-015).

## Current priorities

1. **TASK-015**: scheduled jobs, audit-log viewer, and notifications.
2. **TASK-020**: the question-bank duplicate-overview banner.
3. Ask the owner what the PDF class summary should contain (the last TASK-012 piece) and whether the proposed import formats are accepted.
4. Owner-only release steps: disable public sign-up and run one real media upload.

## How SQL business rules were tested (technique)

Because the live database is the only database, SQL tests are `DO` blocks executed with the Supabase `execute_sql` tool that create data, assert results (including that invalid input is refused with the expected message and `validation` hint), and end with `RAISE EXCEPTION 'X_TESTS_PASSED'` so the whole transaction rolls back. A returned error message that starts with the pass marker means success and nothing persists. After such a run the row counts in "Live system facts" must be unchanged.
