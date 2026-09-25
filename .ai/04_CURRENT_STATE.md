# 04 CURRENT STATE

## Snapshot

| Item | Value |
|---|---|
| Last updated | 2026-09-25 (Buffy — **TASK-007 done: the real image and audio upload against live Storage verified end to end**; no open release blocker) |
| Last AI agent | Buffy (eighteenth session: ran the first real media upload against the live bucket with the staff test account and turned it into a committed live check, `frontend/tests/live_media_check.py`, **32/32**; confirmed the `@supabase/storage-js` protocol reproduction was correct, so no product code changed; found the owner's own live test exam + session and ISSUE-023 in the audit log). |
| Development phase | Phase 5 **FULLY LIVE-VERIFIED**; Phase 6 dashboard/UX polish complete and CI-verified; Phase 7 first slice (audit viewer) **FULLY LIVE-VERIFIED**; **F-07 media is now LIVE-VERIFIED too**. |
| Current focus | Nothing is blocked. Remaining work is optional/owner-driven: **TASK-020** (duplicate banner), the **TASK-015 remainder** (scheduled purge jobs need pg_cron; backups; notifications need DEC-017), the **PDF class summary** (owner decision), and the owner's call on **ISSUE-023**. |
| Branch model | `main` = stable. `ai-development` = shared AI development. |
| Current branch / commit | **`ai-development`** at `d479ed1` (`d99ca92` the live media check, `d479ed1` the docs), on top of `2fcce90`, pushed and CI-green. Local: media 29 and teacher 36 re-run green; the live check is 32/32. |
| Repository baseline | Prefer `ai-development` for all work. `origin/main` still has Codex import variant (DEC-021). |

## What was inspected to write `.ai/`

- All files of the repository copy (65 tracked files before `.ai/`), including code, tests, docs, workflow.
- The **live Supabase project**: migrations list, Edge Function list and versions, tables and RLS state, policies count, functions count, storage buckets, row counts, extensions.
- Test runs (2026-09-29, sixteenth session, from this clone): backend `deno test --allow-env backend/tests/` = **114 passed** (106 + 8 new audit tests), 0 failed; all frontend unit tests = **31 passed**, 0 failed; all **eleven** mocked browser suites green locally (`audit_e2e.py` 25/25 new; teacher, monitor, dashboard, results, question_bank, question_editor, media, question_import, exams, student all pass after the menu went from six to seven items); `deno check backend/functions/audit/index.ts` clean; `git diff --check` clean. **This Windows agent now DOES have Python 3.12 + Playwright + Chromium working** (the "no runtime" note from earlier sessions is stale — verified by actually running the suites).
- No TODO/FIXME comments exist in the code (scan returned nothing).

## Live system facts (verified 2026-09-21)

| Item | Value |
|---|---|
| Tables | 22, all RLS on, 0 policies (public and storage schemas) |
| Migrations applied | `v2_01` .. `v2_12` (12) |
| Edge Functions (as of 2026-09-25, seventeenth session) | `auth-me` v1, `question-bank` v3, `media` v1, `exams` v3, `session` v1, **`results` v4** (grading/reports + the monitor + exam-wide add time), **`audit` v1** (admin-only audit-log viewer); all ACTIVE, `verify_jwt=false` |
| Public SQL functions | **61** (verified live on 2026-09-25; the audit viewer's `list_audit_logs` was the one added since the previous count of 60) |
| Storage | bucket `question-media`, private, 10 MB limit |
| Data (2026-09-25, eighteenth session) | 40 questions (0 archived), 5 passages, 13 topics, **0 media files, 0 `question_media` rows, 0 objects in the `question-media` bucket** (real upload verified and deleted again), **1 exam + 1 submitted session that belong to the OWNER's own test at 07:14 UTC ("test", code `4KHU2A`, closed) — real data, do not delete**, 0 rate-limit rows, 2 profiles, **24 audit rows** (9 of them from the 2026-09-25 media check, deliberately kept) |
| Auth users | 1 admin (email known to the owner; not repeated here) plus the `testguru211l@gmail.com` staff test account (2 `profiles` rows). **Auth config verified live 2026-09-25**: email provider ON, `disable_signup: true` (see ISSUE-007 — the provider had been switched off entirely, which blocked every staff sign-in; fixed the same day) |

## Live system facts (re-verified 2026-09-22, fifth session, via the CLI + admin sign-in)

- Anon REST read of `questions` → HTTP 401, `permission denied` (Postgres 42501) — the zero-policy lockdown holds on the live data (re-checked).
- Tokenless calls to `question-bank` **and** `exams` → HTTP 401, body exactly `"Please sign in."` — the in-code auth wall works in production for both functions.
- Anon `storage/v1/bucket` list → `"Bucket not found"` — the private `question-media` bucket leaks nothing (unchanged).
- CORS preflight from `http://localhost:8000` → `Access-Control-Allow-Origin: *` — the `ALLOWED_ORIGIN` secret is not set (expected until hosting exists; TASK-017).
- `auth/v1/settings` → **email sign-ups were ENABLED** (checked in the third session; ISSUE-007). Superseded 2026-09-25: sign-ups are refused with `signup_disabled` and the provider stays on so staff can sign in.
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
| **Audit viewer (F-14)** | migration `20260929000000_audit_functions.sql` + `audit` Edge Function + `#/audit` screen, all tested | **APPLIED + DEPLOYED** (live; verified end to end 2026-09-25) | No drift — the screen reads the four real audit rows |
| SQL migrations | first migration in git: `supabase/migrations/20260922000000_exams_functions.sql` (applied live) | `v2_01`..`v2_12` + the exams functions | ISSUE-001 partially closed; `supabase db pull` can bring the older ones in |
| Frontend | `APP_BUILD` = "Phase 4, grading and results" | not deployed | The owner runs it locally with `frontend/dev-server.py` |

## Live system facts (verified live 2026-09-25, seventeenth session — the audit viewer)

- **The audit slice was already live when this session started**, although the sixteenth session's docs said the opposite: the SQL is recorded in `supabase_migrations.schema_migrations` as `20260925001719` / `v2_16_audit_functions`, and the `audit` Edge Function was deployed (v1, ACTIVE) at 2026-09-25 02:39 UTC.
- Verified live: `list_audit_logs` exists, is `security definer` + `stable`, and its ACL is `postgres` + `service_role` only (PUBLIC/anon/authenticated revoked). Live public SQL functions: **61**.
- `supabase/tests/audit_functions_test.sql` run against the live project → `AUDIT VIEWER TESTS PASSED (all rows rolled back)`. Row counts afterwards unchanged: **4 audit rows, 0 `audit_test` rows leaked, 40 questions, 0 exams/sessions**.
- Live smoke with the admin account on the deployed function: `list` → `{total: 4, rows: 4}` with actor names resolved from `profiles`; `limit 1 / offset 2` → 1 row, `question.create` by `Admin`; `days=2 + entity_type=question` → 0 (the real rows are from 2026-09-21); `days=0` → HTTP 400 "Days must be between 1 and 3650."; tokenless → HTTP 401 "Please sign in.".
- **Live Auth misconfiguration found and fixed the same day (ISSUE-007)**: the owner's "disable sign-ups" had switched the **Email provider off entirely** (`external_email_enabled: false`), so every staff sign-in answered `422 email_provider_disabled` — nobody could log into the teacher app. Fixed via the Management API (`external_email_enabled: true`, `disable_signup: true` kept); re-verified: sign-in 200, a new sign-up refused with `signup_disabled`, `auth/v1/settings` → `external.email: true`, `disable_signup: true`.
- **How to run SQL live from this clone**: CLI 2.117.0 has **no `supabase db query` subcommand** — use the Management API query endpoint (`POST /v1/projects/<ref>/database/query` with `{"query": "…"}`, one request = one session so a file's `pg_temp.*` works) or the dashboard SQL editor.

## Recently completed work (newest first)

1. **Leave-guard defect fixed (2026-09-25, git `7a5b09e`)** — the reason the Frontend job failed twice (`f4eb5e7`, `2f5de2c`, both at `exams_e2e.py` line 141: "FAIL existing exam title loaded" then a 30 s timeout on `.chosen-item`). `guard.js` warned the browser on `if (guard)`, and every editor registers a guard on sight, so an *untouched* editor asked "Leave site?" on reload/close, and the router held the URL on the current screen while it asked (it rewrites the hash back with `history.replaceState`). A reload landing in that window loads the **previous** screen: the test's clean draft editor came back, and that draft was saved "by filter" with no `.chosen-item` to wait for. Fix: `setLeaveGuard(fn, hasUnsavedWork?)` + `hasUnsavedChanges()`, the beforeunload warning and the router's ask/URL hold-back gated on real unsaved work, the three guarded screens passing their existing synchronous dirt predicate. `exams_e2e.py` also loads the target screen *before* reloading and now checks an untouched editor reloads with no leave warning (28 checks). Verified by restoring the old semantics: the suite then dies at that reload (`Page.reload` timeout after 21 checks).
2. **TASK-015 slice — the audit-log viewer LIVE-VERIFIED (2026-09-25)** — the migration and the `audit` Edge Function had been applied/deployed live by the previous session's follow-up, with no docs update. This session verified it live (rolled-back SQL test + admin smoke, above), corrected every "not yet applied / deploy pending" note, and confirmed the bundled `audit_e2e.py` + `audit.test.ts` still pass. **Nothing remains on the viewer slice.**
3. **TASK-015 slice — admin audit-log viewer (2026-09-29, in git, TESTED)**: SQL `list_audit_logs` (migration `20260929000000_audit_functions.sql`, service-role-only, validation with friendly hints; contract `docs/sql-audit.md`), rolled-back live test `supabase/tests/audit_functions_test.sql` (run live on 2026-09-25 — passed), Edge Function `backend/functions/audit/` (action `list`, the only staff endpoint restricted to `["admin"]` — design.md 1.2), `audit.test.ts` (8), admin-only menu item "Audit log" + screen `#/audit` (When/Who/Action/Entity/Details, action + entity + time-window filters, pager, "System" for actor-less rows), `api/audit.js`, mock-server audit handler + `audit_e2e.py` (25 checks), CI step added, menu-count assertions updated 6→7 (teacher/monitor suites). **The "live apply pending" note here was stale the moment it was written** — that session's own follow-up applied and deployed it; see items 1–2 above.

2. **TASK-014 dashboard and UX polish (2026-09-24, CI green)**: mockup-5 dashboard (big code, live preview, essays/page exits, recent pass-rate meters, 30-second refresh) built on existing payloads (DEC-026); phone menu compacted into a sticky one-row scroll; `list_exam_activity` extended with `passed`/`failed` and applied live; `dashboard_e2e.py` and the CI workflow verified green in Actions.

2. **TASK-012 core — grading, results, teacher actions on an attempt (2026-09-24)**: SQL functions in `supabase/migrations/20260924000000_result_functions.sql` (applied live; `docs/sql-results.md`); `_session_result_write` as the single writer of `exam_results` and `_session_grade` re-created to skip hand-graded questions (DEC-023); the `results` Edge Function deployed (11 staff-only actions); the Grading screen (mockup 13), the per-exam results screen (mockup 14), the attempt report with per-question grading and add time / reopen / retake; `supabase/tests/result_functions_test.sql` (rolled back), 18 Deno tests, `results_e2e.py` (59 checks); CI now runs eight suites; live-verified with the admin account (38/38) and cleaned up afterwards. **ISSUE-017 closed.**
2. **TASK-010 student exam engine (2026-09-23)**: SQL functions in `supabase/migrations/20260923000000_session_functions.sql` (applied live; `docs/sql-sessions.md`); `session` Edge Function deployed (signed session token, per-address join limit, per-session autosave limit, media signing); the student page `frontend/index.html` (join → take the test → result) with offline-tolerant autosave, a server-backed timer, the answer sheet, page-leave warnings and the auto-submit limit; `supabase/tests/session_functions_test.sql` (rolled back), 21 Deno tests, `student_e2e.py` (52 checks); live-verified with the admin account (27/27) and cleaned up afterwards.
2. **TASK-009 teacher-side exams (2026-09-22)**: `exams` Edge Function (list/get/save/remove/set_status/regenerate_code/check_code/duplicate) with 24 Deno tests; exams list screen (filters, open/close, duplicate, delete) and exam editor (manual/auto selection, schedule, live code uniqueness check, shuffle, 1/3/5 tab limits, result visibility, summary, leave guard, templates); routes + live Exams menu; mock-server handlers; `exams_e2e.py` (25 checks); SQL reference `docs/sql-exams.md` **not yet run live**.
2. **TASK-006 steps 1–2, import browser work is done**: the import screen `#/questions/import` (file or paste → defaults → review table with statuses → all-or-nothing import), wired into the router and the question bank; zip/xlsx readers now tested against a real .xlsx fixture (ISSUE-013 closed); template files under `frontend/assets/templates/`; new Playwright suite `question_import_e2e.py` (43 checks). Verified only against the mock server — see the XLSX and live caveats below.
2. Import parsers for CSV, XLSX, and pasted text with 21 Deno unit tests.
3. Import backend: SQL `find_similar_batch`, `import_questions` (live, tested); Edge code + tests (repo only, not deployed).
4. Images and audio: bucket, SQL, `media` function (deployed), file picker, previews, tests — **live-verified 2026-09-25** (real upload, playback, refusal cleanup; `live_media_check.py` 32/32).
5. Question editor, reading texts, question bank screens (live-verified basics by the owner).
6. Sign in, app shell, shared backend library, `auth-me`.
7. Database schema, dev Supabase project, migration of the 40 v1 questions (fingerprint-verified against v1).
8. Design document Draft 4, audit of v1, two rounds of approved mockups.

## Work in progress

- **TASK-012**, on branch `ai-development**: only the **PDF class summary** remains, and it needs the owner's decision on the one-page content. CSV/Excel and both statistics tabs are built and tested.
- **TASK-006**, on branch `ai-development`: deployed and working; remaining is the owner's review of the proposed import formats and one real Excel/Google-Sheets file.
- **TASK-015**: the **audit-log viewer slice is LIVE-VERIFIED (2026-09-25)** — SQL applied, function deployed, live test + admin smoke passed. What remains in the task: backups, notifications (owner must choose a provider, DEC-017), scheduled purge jobs (need pg_cron live), user management.
- **TASK-009's exam delete rule**: **ISSUE-023** (OPEN, owner decision) — the owner hit Delete five times on an exam that had an attempt and the app closed it each time, by design. Either keep the behavior and make the message/button clearer, or add an admin-only hard delete.

## Pending work (see `05_TASK_QUEUE.md`)

**TASK-015 remainder** (scheduled expiry/purge jobs — needs pg_cron live; backups; notifications — needs the owner's provider decision) is the next code task; **TASK-020** (duplicate-overview banner) is a smaller alternative. Owner-dependent items: the PDF class-summary content (TASK-012), import-format review (TASK-006), the exam-delete behavior (**ISSUE-023**), and the merge of `ai-development` into `main`.

## Blocked work

**Nothing.** No code task is blocked and **no release blocker is open**: the last one, TASK-007 (one real image/audio upload against live Storage), was completed and live-verified on 2026-09-25 (`frontend/tests/live_media_check.py` 32/32). ISSUE-007 is fixed and **verified live** (sign-ups refused with `signup_disabled`, staff sign-in works). The only items needing a human are the migration-tracking discrepancy in ISSUE-001 (needs a real DB connection/password) and the `ai-development` → `main` merge itself (DEC-020/DEC-021).

## What the owner has verified live

- Signing in with the admin account works (the owner last saw the old `Welcome`/connection-check placeholder; the new mockup-5 dashboard is automated-test evidence, not an owner walkthrough).
- The question bank shows the 40 migrated questions; add/edit editor opens and works after clearing a stale browser cache (old JS modules were cached; fixed by `dev-server.py`).
- Everything else about the editor beyond opening and basic add/edit is verified only by automated tests.
- (The student flow and the grading loop were verified against the live backend by the agent, not by the owner in a browser: the deployed functions and their SQL were exercised over HTTP, while the *screens* were verified against the mock server only. One owner run of `frontend/index.html` and of the grading screens against the real project is still worth doing.)

## Known regressions

None from this session. The earlier `media_e2e.py` fixture-size quirk in ISSUE-014 was fixed on 2026-09-22; the test now compares against the generated file's real size.

## Current risks

1. The live migration-tracking table is missing rows for three already-live migrations (ISSUE-001 follow-up; needs a real DB connection).
2. ~~Media upload untested against real Storage~~ — **closed 2026-09-25** (ISSUE-002, TASK-007).
3. Staff sign-in depends on the email provider staying enabled (`disable_signup` is what keeps the public out, ISSUE-007) — it was switched off by mistake on 2026-09-24/25 and blocked every login. Check `auth/v1/settings` after any dashboard change.
4. v1 keeps serving real students with its known weaknesses (`docs/audit-v1.md`); owner decided not to patch it (DEC-015).

## Current priorities

1. **TASK-015 remainder**: scheduled jobs (needs pg_cron live), backups, notifications (needs the owner's email-provider decision, DEC-017).
2. **TASK-020**: the question-bank duplicate-overview banner.
3. Ask the owner what the PDF class summary should contain (the last TASK-012 piece), whether the proposed import formats are accepted, and what to do about **ISSUE-023** (exam delete with attempts).
4. Owner-only step: decide when to merge `ai-development` into `main` (DEC-020/DEC-021) — no technical blocker remains.

## How SQL business rules were tested (technique)

Because the live database is the only database, SQL tests are `DO` blocks executed with the Supabase `execute_sql` tool that create data, assert results (including that invalid input is refused with the expected message and `validation` hint), and end with `RAISE EXCEPTION 'X_TESTS_PASSED'` so the whole transaction rolls back. A returned error message that starts with the pass marker means success and nothing persists. After such a run the row counts in "Live system facts" must be unchanged.
