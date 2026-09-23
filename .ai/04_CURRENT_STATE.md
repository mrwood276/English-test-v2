# 04 CURRENT STATE

## Snapshot

| Item | Value |
|---|---|
| Last updated | 2026-09-23 (seventh session — the student exam engine, TASK-010) |
| Last AI agent | Buffy (Freebuff desktop agent; deployed the `session` function and applied its SQL live with the owner's access token — session-only, not stored in the repo) |
| Development phase | Phase 2 (core), following `docs/design.md` section 5 (Phases 0 and 1 are done) |
| Current focus | **Both sides of an exam now work against the real backend.** Teacher side: `question-bank` v3 (import), `exams` (whole flow live-verified). Student side (new, 2026-09-23): join by code, take the test, autosave (offline-tolerant), leave warnings, submit, automatic grading, result — SQL in `supabase/migrations/20260923000000_session_functions.sql`, function `session` deployed, contract in `docs/sql-sessions.md`. Next milestone: TASK-012 (essay grading, results, add time / reopen, live monitor). |
| Branch model | `main` = stable branch. `ai-development` = shared branch where Claude and Codex/GPT do normal work, one agent at a time. See `00_AI_RULES.md` section 12 and DEC-020. `ai-development` is **not yet stable enough to merge into `main`** — TASK-006 step 3 (deploy) is still open and the import screen is invisible until it happens. |
| Current branch / commit | Work is on **`ai-development`**, which holds `6f5c223` (parsers) → this session's commit (import screen + xlsx tests + templates; see `git log` and `08_HANDOFF.md`). `main` itself is unchanged and still points at `46803f0`. |
| Repository baseline | GitHub is the source. `origin/ai-development` = `6f5c223` + this session's commit. **`origin/main` is NOT at `46803f0` anymore**: Codex/GPT-5 pushed its own parallel TASK-006 implementation straight to `main` on 2026-09-21 (`d21f82d`, `1606aed`, `9c293fc`) — see ISSUE-015 and DEC-021 for the owner's resolution (the `ai-development` implementation is the one that continues; `main`'s variant is superseded at the next deliberate merge) |

## What was inspected to write `.ai/`

- All files of the repository copy (65 tracked files before `.ai/`), including code, tests, docs, workflow.
- The **live Supabase project**: migrations list, Edge Function list and versions, tables and RLS state, policies count, functions count, storage buckets, row counts, extensions.
- Test runs (2026-09-22, from this clone): backend `deno test` = 41 passed, 0 failed; import parser unit tests = 21 passed (was 16; 5 new zip/xlsx tests); Playwright suites (mocked network) all green: `teacher_e2e`, `question_bank_e2e`, `question_editor_e2e`, `media_e2e` (see the media note below), and the new `question_import_e2e` = 43 checks.
- No TODO/FIXME comments exist in the code (scan returned nothing).

## Live system facts (verified 2026-09-21)

| Item | Value |
|---|---|
| Tables | 22, all RLS on, 0 policies (public and storage schemas) |
| Public SQL functions | 25 |
| Migrations applied | `v2_01` .. `v2_12` (12) |
| Edge Functions (as of 2026-09-23) | `auth-me` v1, `question-bank` **v3**, `media` v1, `exams` v1, **`session` v1**; all ACTIVE, `verify_jwt=false` |
| Storage | bucket `question-media`, private, 10 MB limit |
| Data (2026-09-23) | 40 questions (0 archived), 5 passages, 13 topics, 0 media files, **0 exams, 0 sessions, 0 results, 0 session events, 0 rate-limit rows**, 1 profile (admin), 4 audit rows — the student-engine verification data was deleted again |
| Auth users | 1 admin (email known to the owner; not repeated here). No teacher account |

## Live system facts (re-verified 2026-09-22, fifth session, via the CLI + admin sign-in)

- Anon REST read of `questions` → HTTP 401, `permission denied` (Postgres 42501) — the zero-policy lockdown holds on the live data (re-checked).
- Tokenless calls to `question-bank` **and** `exams` → HTTP 401, body exactly `"Please sign in."` — the in-code auth wall works in production for both functions.
- Anon `storage/v1/bucket` list → `"Bucket not found"` — the private `question-media` bucket leaks nothing (unchanged).
- CORS preflight from `http://localhost:8000` → `Access-Control-Allow-Origin: *` — the `ALLOWED_ORIGIN` secret is not set (expected until hosting exists; TASK-017).
- `auth/v1/settings` → **email sign-ups are still ENABLED** (checked in the third session; the owner has not flipped it yet — ISSUE-007).
- Admin sign-in via the API works (HTTP 200, `expires_in` 3600); `profiles` has exactly one row (admin, `is_active`).
- Live schema facts discovered while applying the exam SQL: `exams.status`/`availability_mode`/`late_start_policy`/`selection_mode`/`result_visibility`/`essay_pending_display` are Postgres **enums**; `exam_questions.position` has `CHECK (position > 0)` + deferred `UNIQUE (exam_id, position)`; `exams.access_code` has `CHECK (^[A-Z0-9]{4,12}$)`; `auto_filter` is NOT NULL default `'{}'`. Full list in `docs/sql-exams.md`.

## Live system facts (re-verified 2026-09-23, seventh session)

- The `session` function is deployed and answers: a tokenless call is refused with HTTP 400 (`token is required`), a forged token with **HTTP 401** — the signed-token wall works in production (DEC-022).
- Full student flow verified through the deployed function with the admin account creating/opening the exam (27/27 checks; see the changelog and `docs/sql-sessions.md`).
- Live schema fact discovered while applying the session SQL: `exam_sessions.student_name_normalized`/`student_class_normalized` are GENERATED columns (`normalize_text`), as are `accepted_answers.answer_normalized` and `question_class_labels.label_normalized` — inserting them is an error (Postgres 428C9).
- Row counts after cleanup: 0 exams, 0 exam_sessions, 0 session_answers, 0 exam_results, 0 session_events, 0 rate_limits, 40 questions, 4 audit rows.

## Drift between repository and live system (important)

| Area | Repository | Live | Consequence |
|---|---|---|---|
| `question-bank` | has actions `import_check`, `import` (`handler.ts`, `parse.ts`, tests) | version 2 **without** those actions | Deploying it (TASK-006 step 3) is now the **only** thing between the finished import screen and a working feature: the screen calls the actions and fails with "Nothing was saved" until they are live. Safe: it only adds actions |
| `exams` | full handler + parser + 24 Deno tests; screens list + editor | **v1 live** (deployed 2026-09-22); SQL functions applied live; whole flow live-verified with the admin account (save/get/list/update/open/code-rules/duplicate/remove + refusals + 401 wall) | The exam screens work against the real backend |
| `session` | handler + parser + token + 21 Deno tests | **v1 live** (deployed 2026-09-23) with its SQL applied; full student flow live-verified | No drift: the deployed function was built from this repository |
| `question-bank` | has actions `import_check`, `import` | **v3 live** (deployed 2026-09-22); `import_check` answered live, `list` regression-checked | The import screen works against the real backend; left: owner format review + a real Excel file check |
| SQL migrations | first migration in git: `supabase/migrations/20260922000000_exams_functions.sql` (applied live) | `v2_01`..`v2_12` + the exams functions | ISSUE-001 partially closed; `supabase db pull` can bring the older ones in |
| Frontend | `APP_BUILD` = "Phase 2, question import" | not deployed | The owner runs it locally with `frontend/dev-server.py` |

## Recently completed work (newest first)

1. **TASK-010 student exam engine (2026-09-23)**: SQL functions in `supabase/migrations/20260923000000_session_functions.sql` (applied live; `docs/sql-sessions.md`); `session` Edge Function deployed (signed session token, per-address join limit, per-session autosave limit, media signing); the student page `frontend/index.html` (join → take the test → result) with offline-tolerant autosave, a server-backed timer, the answer sheet, page-leave warnings and the auto-submit limit; `supabase/tests/session_functions_test.sql` (rolled back), 21 Deno tests, `student_e2e.py` (52 checks); live-verified with the admin account (27/27) and cleaned up afterwards.
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

- **TASK-010 Student exam engine**, on branch `ai-development`: core complete and live-verified (see the summary table and `docs/sql-sessions.md`). Not built yet, in TASK-012: the teacher's essay grading screen, add time / reopen a session (BR-11), the remedial permission UI, the live monitor, results and statistics. `expire_sessions()` exists but nothing schedules it (TASK-015).
- **TASK-009 Exams**, on branch `ai-development`: teacher side built, applied live and verified (see `docs/sql-exams.md`).
- **TASK-006 Import questions**, on branch `ai-development`: browser work complete (parsers, screen, tests, templates). Remaining: step 3 — deploy `question-bank` with the import actions (needs Supabase access, else BLOCKED) and step 4 — show the owner the proposed file formats before calling the feature done for teachers.

## Pending work (see `05_TASK_QUEUE.md`)

**TASK-012** (essay grading, results, statistics, add time / reopen, live monitor) is the next piece; then verify media upload live (TASK-007) and store the older migrations in git (TASK-008) as owner steps.

## Blocked work

Nothing is blocked at the moment of writing: this session had a Supabase access token and used it for the `session` SQL and deployment. TASK-007 (media upload) still needs a browser run against real Supabase, and TASK-008 (`supabase db pull`) needs the owner's token — both are owner/agent-with-token steps, not code work.

## What the owner has verified live

- Signing in with the admin account works (`Welcome`, connection check).
- The question bank shows the 40 migrated questions; add/edit editor opens and works after clearing a stale browser cache (old JS modules were cached; fixed by `dev-server.py`).
- Everything else about the editor beyond opening and basic add/edit is verified only by automated tests.
- (The student flow was verified against the live backend by the agent, not by the owner in a browser: the deployed `session` function and SQL were exercised over HTTP, while the student *screens* were verified against the mock server only. One owner run of `frontend/index.html` against the real project is still worth doing.)

## Known regressions

None from this session. One pre-existing environment quirk was found and left alone: `media_e2e.py` expects the generated `small.png` fixture to be exactly 467 bytes, but the installed Pillow writes 468 bytes, so that single check fails locally after running `make_fixtures.py`. It is unrelated to the import work (media code untouched). See `09_KNOWN_ISSUES.md` ISSUE-014 for the exact description.

## Current risks

1. Migrations only in the live project (ISSUE-001).
2. Media upload untested against real Storage (ISSUE-002).
3. GitHub sync is manual; two copies of the code can diverge (ISSUE-004).
4. v1 keeps serving real students with its known weaknesses (`docs/audit-v1.md`); owner decided not to patch it (DEC-015). (ISSUE-006 — frontend not in CI — was closed on 2026-09-22 by TASK-018; the new workflow's first real run still needs to be watched.)

## Current priorities

1. **TASK-012**: essay grading (a pending result cannot become final without it), results/statistics, and add time / reopen a session (BR-11).
2. Owner reviews the proposed import file formats (see TASK-006 in `05_TASK_QUEUE.md`); the screen ships an example and templates that match them.
3. Check the first CI run of `.github/workflows/frontend-tests.yml` (TASK-018) after this push.
4. TASK-007 and TASK-008 (verification and reproducibility) as soon as the owner can run them.
5. TASK-009 (exams), which unblocks the student-facing phases.

## How SQL business rules were tested (technique)

Because the live database is the only database, SQL tests are `DO` blocks executed with the Supabase `execute_sql` tool that create data, assert results (including that invalid input is refused with the expected message and `validation` hint), and end with `RAISE EXCEPTION 'X_TESTS_PASSED'` so the whole transaction rolls back. A returned error message that starts with the pass marker means success and nothing persists. After such a run the row counts in "Live system facts" must be unchanged.
