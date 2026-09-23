# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**`BLOCKED` — not ready for `main`.**

TASK-013 is LIVE-VERIFIED (schema/privileges; SQL applied 2026-09-23). Open before release: one real browser run of `#/monitor` against a live exam; owner checklist items (ISSUE-007, TASK-007); careful merge vs Codex import on `main` (DEC-021).

## Branch Context (read this first)

| | |
|---|---|
| Stable Branch | `main` — **`origin/main` = `9c293fc`**. Not the normal workspace. |
| Current Development Branch | **`ai-development`** — includes TASK-013 live monitor. |
| Merged into `main`? | **No.** |

## Concurrent-agent collision (read this first — both reviewer sessions below ran at the same time)
On 2026-09-23, **two AI reviewer sessions were active on `ai-development` at once**: this Cursor/Composer session (release-gate intake, TASK-013) and a separate claude.ai chat session doing its own security review. Both wrote directly to the live database before either had committed anything to git, and both found **the same CRITICAL bug independently, ~22 seconds apart**:
- `20260923050326` / `20260923050351` (the chat session, via Supabase MCP): revoke the default PUBLIC execute grant on all `public`-schema functions; fix a mutable `search_path` on `_exam_is_open`.
- `20260923050413` (this Cursor/Composer session, per the SQL comment "found during ai-development -> main review, 2026-09-23/24"): the same revoke, independently discovered.
Both are idempotent, so nothing broke, but this violates the "one agent at a time, sequential" rule this file itself states. **The collision was harmless only by luck (both changes happened to be the same idempotent REVOKE) — if it happens again, stop and let the owner coordinate before either agent writes to the live project or pushes git.** The three ad-hoc DB versions above are consolidated into one git-tracked file: `supabase/migrations/20260926000000_security_lockdown_function_execute.sql`. See ISSUE-020 for the full writeup. The owner confirmed after this that no other agent remains active.

## Last Agent
Cursor / Composer — TASK-013 live monitor (screens + e2e + SQL in git) — **and**, concurrently, Claude (claude.ai chat, acting as AI Development Reviewer) — security review that closed ISSUE-020 (see collision note above).

## Date
2026-09-23

## Last Completed Task
- **TASK-013 core (TESTED, Cursor/Composer):** live monitor hub, per-exam student table (mockup 12), session timeline with add time; `monitor_e2e.py` 23/23; CI ninth suite; migration `20260925000000_monitor_overview_fields.sql` committed but **not applied live**.
- **Security review — ISSUE-020 closed (claude.ai chat session, concurrent with the above)**: the exams/session/results function families (TASK-009/010/012) were missing the `REVOKE EXECUTE FROM PUBLIC` that `v2_05`/`v2_08` already apply to the foundation/question-bank functions — Postgres grants EXECUTE to PUBLIC by default on every new function, so 35 functions including `save_exam`, `remove_exam`, `grant_retake`, `add_exam_time`, and `save_answer_grade` were callable directly by `anon`/`authenticated` via `/rest/v1/rpc/<name>`, bypassing `requireStaff()`, the session-token check, rate limiting and audit logging entirely. **Fixed live** (see collision note above) and re-verified clean with the security advisor. Also fixed a WARN: mutable `search_path` on `_exam_is_open`. The rest of the full review checklist (functionality/regression/code-quality/UI) beyond what the release-gate intake below already covered was not reached this session.
- **TASK-013 monitor SQL applied live (claude.ai chat session, same day, after the push above)**: `supabase/migrations/20260925000000_monitor_overview_fields.sql` was applied to the live project via Supabase MCP after confirming with the owner that no other agent was active. Verified: all columns `list_exam_results()` reads exist on `exam_sessions`, `has_function_privilege()` confirms `anon`/`authenticated` are refused and `service_role` can execute, security advisor re-checked clean, live exam count stayed 0. F-13/TASK-013 marked LIVE-VERIFIED. Not done: a real browser run of `#/monitor` against a live open exam with real students.

## Remaining Work
1. ~~Apply `supabase/migrations/20260925000000_monitor_overview_fields.sql` on the live project~~ — **done 2026-09-23** (Claude reviewer session, via Supabase MCP; schema/privilege-verified, security advisor clean). Still pending: one real browser run of `#/monitor` against a live open exam.
2. Optional: one live browser run of `#/monitor` during a real exam.
3. TASK-012 remainder (statistics tabs / exports) or release gate when owner asks.
4. Owner: ISSUE-007, TASK-007, TASK-008.

## Recommended Next Task
Apply the monitor overview SQL live (needs token), **or** TASK-012 remainder (Questions/Classes + exports).

## Suggested Work For Next AI
1. `git checkout ai-development && git pull`.
2. Confirm: backend 104, `python frontend/tests/monitor_e2e.py` green (dev-server 8123).
3. With `SUPABASE_ACCESS_TOKEN`: apply `20260925000000_monitor_overview_fields.sql`, then mark F-13 progress fields LIVE-VERIFIED.
4. Do not merge to `main` while RELEASE STATUS is BLOCKED unless the owner overrides.
5. Before starting any live-DB or git-push work, confirm with the owner that no other agent session is active — see the collision note above.

## Prior completed work (keep for context)
- **TASK-012 (core) built and live-verified (eighth session)**: a teacher can now grade written answers, read the results of an exam, and act on a single attempt. SQL in `supabase/migrations/20260924000000_result_functions.sql` (**applied live**; contract, rules and live facts in `docs/sql-results.md`), Edge Function `backend/functions/results/` (**deployed v1**, 18 Deno tests), the Grading/Results menu items with a waiting-essays badge, the essay grading screen (mockup 13), the per-exam results screen (mockup 14), and the attempt report with per-question grading plus **add time / reopen (BR-11)** and **allow a retake (BR-02)**. Rolled-back SQL test `supabase/tests/result_functions_test.sql` (`RESULT ENGINE TESTS PASSED`), `frontend/tests/results_e2e.py` (59 browser checks), a one-off live script `frontend/tests/live_results_check.py` with its `cleanup_live_results.sql`. **ISSUE-017 closed** — a result with an essay can now become final. Live verification: **38/38 checks** against the real project through the deployed function; every test row deleted afterwards (0 exams, 0 sessions, 0 rate-limit rows, 40 questions). Regression: backend **104**, unit 21, all **eight** browser suites green.
- **TASK-010 Student exam engine built and live-verified (seventh session)**: the student side of an exam now works end to end. SQL in `supabase/migrations/20260923000000_session_functions.sql` (**applied live**; contract + schema facts in `docs/sql-sessions.md`), Edge Function `backend/functions/session/` (**deployed v1**, signed session token per DEC-022, 21 Deno tests), the student page `frontend/index.html` (`assets/js/student/*`, `assets/css/student.css`), a full mock-server `/functions/v1/session` handler, `frontend/tests/student_e2e.py` (52 checks) and `supabase/tests/session_functions_test.sql` (rolled-back assertions). Live verification with the admin account: 27/27 checks (join → answers → resend → refusal paths → submit → grading `75` / `2 correct, 1 wrong` / review → refusals), then every test row deleted (0 exams, 0 sessions, 40 questions). Regression: backend **86**, unit 21, all **seven** browser suites green. CI now also runs `exams_e2e` (was missing) and `student_e2e`.
- **CI red fixed at its root (sixth session)**: GitHub Actions run #4 failed the Question-editor step. Reproduced locally 1-in-2 in the full chain and root-caused to a **product bug**, not a test problem: every `SessionExpiredError` re-dispatched `staff:session-expired`, so a background request after the 401 (the editor's debounced duplicate-check timer, detached) replaced the sign-in notice ("Your session has expired…") with "Please sign in." Fix: announce once per signed-out period (`sessionExpiredAnnounced` flag in `core/api.js`, reset by `staff:signed-in` dispatched in `app.js#showApp`). ISSUE-016 rewritten (two LOW misdiagnoses → MEDIUM, FIXED-AT-ROOT). Verified: 3 consecutive full browser chains 15/15 (crashed on cycle 2 before), unit 21/21, `deno check` clean.
- **TASK-009 live step + TASK-006 step 3 done (fifth session)**: the exam SQL was applied to the v2 project (first migration in git: `supabase/migrations/20260922000000_exams_functions.sql`), the `exams` function deployed (v1), and `question-bank` v3 deployed (import actions live — ISSUE-003 closed). The whole exam flow was live-verified with the admin account: save draft (weights) → get → list → update → open → code-uniqueness refusal among open exams → check_code → regenerate_code → duplicate → remove, plus refusals (empty manual exam at save, end-before-start schedule) and the tokenless 401 wall. Three real schema facts were discovered and fixed while applying the SQL (enum casts, `auto_filter` NOT NULL, `position > 0`, access_code CHECK in duplicate_exam, `list_exams` return-type drop) — all recorded in `docs/sql-exams.md`. A parser default (`draw_per_student` false when absent) was fixed and redeployed. All test exams + audit rows were deleted afterwards: live state 0 exams, 40 questions.
- Fourth session: **TASK-009 teacher-side exams built**: `exams` Edge Function (8 actions) + 24 Deno tests (backend 41 → 65); exams list + editor screens per mockup 11 (manual/auto selection, schedule, live code check, tab limits 1/3/5, templates, duplicate, leave guard); routes `#/exams*`; Exams menu item live; mock-server exams handlers; `exams_e2e.py` (25 checks).
- **`docs/verification-checklist.md` written** — step-by-step owner instructions for the Supabase-side work (sign-up off, deploy v3, media upload check, migrations export).
- Second session: **TASK-018 done / ISSUE-006 closed** (`.github/workflows/frontend-tests.yml`), **ISSUE-014 fixed**, editor flake fixed (ISSUE-016).
- First session the same day: **TASK-006 steps 1–2 complete** (import screen, zip/xlsx tests, mock handlers, browser suite, templates) — commit `4493577`.

## Owner Credentials Warning
- Fifth session: the owner supplied a Supabase **access token** (`sbp_...`, used via the `SUPABASE_ACCESS_TOKEN` env var for the CLI only) and the **admin email + password** (for one password-grant sign-in to run the live exam flow). Neither was written to any file, script, or command in the repository; the token files under `/tmp` were deleted after use. The owner should revoke the token (Dashboard → Access Tokens) when convenient — and ideally rotate the admin password too, since it transited chat.
- Fourth session: the owner sent the **v2** publishable key (`sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E` for `lbhnadqmokloyfarrzfv`, matching `config.js`) — public by design, used for read-only probes only.
- Earlier: a URL + key for `dtrgbjqfnkjiengpvbym` identified the **v1 project (`Exam_Data_Base`)** — do not touch v1 (DEC-001/DEC-015).
- Remaining owner-side steps (checklist in `docs/verification-checklist.md`): disable public sign-up (ISSUE-007, still enabled), live media upload check (TASK-007), `supabase db pull` for the old migrations (TASK-008 remainder), and one browser run of the student page against the real project.
- Seventh session: the same access token was used again (CLI only, `SUPABASE_ACCESS_TOKEN`) plus one admin password-grant sign-in for the live student-flow check. Nothing was written into the repo, scripts, or logs beyond the fact that it happened.
- Eighth session: the same token and the same admin account were used a third time (CLI only + one password-grant sign-in; the token never appears in a file, script or command line in the repository — it is passed through the shell environment). **The token should be revoked (Dashboard → Access Tokens) and the admin password rotated** — both have now travelled through chat three times. One live check *is* committed, deliberately: `frontend/tests/live_results_check.py` contains the admin **email** and asks for the password from the environment (`SUPABASE_TEST_PASSWORD`); it is documentation of how the live check runs, not a stored secret.

## What Was Changed (eighth session, 2026-09-24 — grading, results, BR-11)
1. **SQL (new migration, applied live)**: `supabase/migrations/20260924000000_result_functions.sql` — `_session_result_write` (the single writer of `exam_results`), `_session_grade` re-created so a hand-graded question is never re-graded (`continue` when `is_auto = false`, BR-18), `save_answer_grade`, `list_grading_questions`, `get_grading_queue`, `count_pending_grading`, `list_exam_activity`, `list_exam_results`, `get_session_report`, `add_session_time`, `reopen_session`, `grant_retake`, `revoke_retake`. No table changed — functions only. Covers BR-02, BR-06, BR-07, BR-08, BR-11, BR-15, BR-18.
2. **Edge Function `results`** (`backend/functions/results/{index,handler,parse}.ts`) deployed with `--no-verify-jwt --use-api`; staff only (`requireStaff`), actions `activity, pending, overview, report, grading_questions, queue, grade, add_time, reopen, grant_retake, revoke_retake`. Minutes are converted to seconds in `parse.ts`, so the SQL guard and the browser can never disagree.
3. **Teacher frontend**: new `assets/js/teacher/api/results.js`, `components/{resultBits.js,reviewItem.js}`, `screens/{grading.js,gradingQuestion.js,examResults.js,sessionReport.js}`, `assets/css/results.css`; routes `#/grading`, `#/grading/:examId`, `#/results`, `#/results/:examId`, `#/results/:examId/session/:sessionId`; the **Grading** and **Results** menu items are live (no more "Soon") and Grading carries a waiting-essays badge that refreshes on navigation, on `staff:results-changed` (dispatched by any screen that grades), and after a reopen/grant. `teacher/index.html` loads `results.css`.
4. **Tests/infra**: `supabase/tests/result_functions_test.sql`, `backend/tests/results.test.ts` (18), `frontend/tests/results_e2e.py` (59), `frontend/tests/mock_server.py` gained a complete `/functions/v1/results` handler (manual grades, retakes, class aliases, re-grade after a reopen) and `teacher_e2e.py`'s nav assertion was updated (all five menu items now lead somewhere). `.github/workflows/frontend-tests.yml` runs the new suite (eight in total).
5. **Docs**: new `docs/sql-results.md`; `.ai/` updated (state, queue, features, changelog, issues, DEC-023, this file); `README.md`, `backend/README.md`, `supabase/README.md`, `frontend/README.md` updated.

## What Was Changed (seventh session, 2026-09-23 — student exam engine)
1. **SQL (new migration, applied live)**: `supabase/migrations/20260923000000_session_functions.sql` — `exam_join`, `get_exam_session`, `save_session_answers`, `session_heartbeat`, `log_session_event`, `submit_exam_session`, `get_session_result`, `get_session_media_ids`, `expire_sessions` (+ `_session_grade`, `_session_public_result`, `_session_question_block`, `_session_key_entry`). Covers BR-01/02/03/04/05/06/07/08/09/10/12/20/21 and the tab-switch auto-submit limit. **Live fact found while applying**: `exam_sessions.student_name_normalized`/`student_class_normalized` are GENERATED columns — `exam_join` must not insert them (Postgres 428C9 if you do).
2. **Edge Function `session`** (`backend/functions/{session/index.ts,handler.ts,parse.ts,token.ts}`) deployed with `--no-verify-jwt --use-api`. `join` is open but rate limited per address (60/min); every other action requires the signed token. `media` signs links only for files inside that session's own snapshot. Actions: `join, get, save, heartbeat, event, submit, result, media`.
3. **Student page** `frontend/index.html` + `frontend/assets/js/student/{app.js,api.js,store.js,screens/{join,exam,result}.js,components/question.js}` + `frontend/assets/css/student.css`. Join (name/class/code, mockups 1 and 9), exam (counter, progress, server-backed timer, answer bubbles, Mark, answer sheet from mockup 3, autosave + offline banner from mockup 8, page-leave warning from mockup 7, submit confirmation), result (nothing / score / score and review; "Not final" + the waiting note from mockup 4). A reload — even with no connection — resumes the same attempt from `localStorage`.
4. **`shared/icons.js`** gained `clock, flag, grid, cloud, play, offline` (additive).
5. **Tests/infra**: `frontend/tests/mock_server.py` gained a complete session handler (join/save/heartbeat/event/submit/grading/result/media, ISO timestamps like Postgres); new `frontend/tests/student_e2e.py`; `.github/workflows/frontend-tests.yml` now runs `exams_e2e.py` (missing since TASK-009) and `student_e2e.py`.
6. **Docs**: new `docs/sql-sessions.md` (contract, live facts, verification record); `.ai/` updated (state, queue, features, changelog, issues, DEC-022); `supabase/README.md` and `frontend/README.md` mention the new function/page.

## What Was Changed (sixth session, 2026-09-22 — CI flake root cause)
1. `frontend/assets/js/core/api.js` — session-expired announcements gated to once per signed-out period (module flag + `staff:signed-in` reset listener, registered `{ once: true }` at first announce).
2. `frontend/assets/js/teacher/app.js` — `showApp()` dispatches `staff:signed-in` (single choke-point after every sign-in/boot path; also resets the flag if a stale event listener pair ever re-fires).
3. `.ai/09_KNOWN_ISSUES.md` ISSUE-016 rewritten with the true root cause and verification record.
4. No test files changed — the suites were right; the app was wrong.

## What Was Changed (fifth session, 2026-09-22 — live deploy + verification)
1. **Exam SQL applied live** → `supabase/migrations/20260922000000_exams_functions.sql` (new, first migration in git). Real schema facts were discovered and fixed in the SQL while applying: enum columns need explicit casts, `save_exam` generates the id (`coalesce(p_id, gen_random_uuid())`), `auto_filter` NOT NULL, `exam_questions.position` starts at 1 (`position > 0` CHECK), `duplicate_exam` mints a confusion-safe code (access_code CHECK rejected the md5 snippet), `list_exams` casts enums to text and needs `drop function` before a return-type change (file is idempotent).
2. **Deployed live**: `exams` (v1) and `question-bank` (v3 — import actions live, ISSUE-003 closed). Deploy path: `python backend/sync_functions.py` (new; mirrors `backend/functions` → `supabase/functions/`, now gitignored) then `npx supabase functions deploy <name> --no-verify-jwt --use-api` (server-side bundling, no Docker).
3. **Live exam flow verified with the admin account** (password grant → bearer token → POST `/functions/v1/exams`): save draft (2 questions, weights 2+1) → get (positions 1..n) → list (counts/points) → update via save-with-id → open → second exam with the open code refused ("already used by an open exam") → `check_code` false/true around close → `regenerate_code` → `duplicate` (draft, both questions, new code) → `remove`; refusals live: empty manual exam, end-before-start schedule; tokenless 401 "Please sign in."
4. **Parser fix + redeploy**: `draw_per_student` now defaults to false when absent (was a 400); 24 Deno tests still green. `import_check` verified live (answers `{"results":[]}` for a non-matching row — no more "Unknown action"), `list` regression-checked (total: 40).
5. **Cleanup**: all verification exams + their audit rows deleted — live state back to 0 exams, 40 questions, 0 `exam.*` audit rows.
6. `.ai/` + `docs/sql-exams.md` (rewritten as the verification record + schema facts) + `supabase/README.md` deploy instructions updated.

## What Was Changed (third session, 2026-09-22)
1. **Read-only live probes** of the v2 project using the publishable key (no login): `auth/v1/settings` (email sign-ups still enabled), tokenless REST read of `questions` (401 `permission denied`, Postgres 42501 — zero-policy lockdown holds), tokenless `question-bank` call (401 `"Please sign in."` — matches `_shared/errors.ts`), `storage/v1/bucket` anon list ("Bucket not found" — nothing leaks), CORS preflight from `http://localhost:8000` (`Access-Control-Allow-Origin: *`, `ALLOWED_ORIGIN` secret not set — expected pre-hosting).
2. **`docs/verification-checklist.md`** — owner-facing steps 1–5 (disable sign-up, deploy v3 with verify commands, media upload check, migrations export, optional hardening).
3. `.ai/` updated: ISSUE-002/003 annotated with live facts, ISSUE-007 rewritten (OPEN, still enabled), TASK-006 queue note, changelog, this file.

## What Was Changed (second session)
1. **Import screen** — new `frontend/assets/js/teacher/screens/questionImport.js`, route `#/questions/import` in `router.js`, "Import" button next to "Add question" in `screens/questionBank.js`. Flow: choose a `.xlsx`/`.csv` file or paste text → optional defaults (class labels, topic, difficulty, points) → review table (Ready / Fix / Duplicate in bank / Duplicate in file / Similar, per-row problems) → all-or-nothing `import` of the checked rows → back to `#/questions` with a toast. In-file duplicates are detected with `dupKey`; `import_check` runs once per review; a refused batch (HTTP 400 `Row N: ...`) keeps the review open and saves nothing; an unsaved review triggers the leave guard.
2. **API** — `api/questionBank.js` gained `importCheck(items)` (returns the results list) and `import(items)`.
3. **ISSUE-013 closed** — 5 new Deno unit tests for `zip.js`/`xlsx.js` in `frontend/tests/unit/import.test.ts`, run against `frontend/tests/unit/fixtures/import-sample.xlsx`, a real OOXML package built by the committed `frontend/tests/unit/make_xlsx_fixture.py`. Unit tests now need `deno test --allow-env --allow-read --no-check frontend/tests/unit/` (the `--allow-read` is for the fixture; `npm:linkedom` provides the DOM in Deno — dev-only, DEC-007 untouched).
4. **Mock server + browser tests** — `mock_server.py` implements `import_check` (EXACT/similar) and `import` (refuses bodies containing `FORCE_SERVER_ERROR` with `Row N:`); new `frontend/tests/question_import_e2e.py` (43 checks: paste flow, statuses, defaults, select-all semantics, payload shape, a real `.xlsx` upload through the file picker, refused batch, leave guard, example button).
5. **Templates** — `frontend/assets/templates/import-template.xlsx` and `import-template.csv` (generated by `make_import_template.py`, outputs committed, downloadable from the screen); `frontend/assets/templates/README.md`.
6. **Small** — `shared/icons.js`: two fixed icons (`sheet`, `pencil`); `questions.css`: import styles (new `.head-actions`, `.import-*` classes using existing tokens); `APP_BUILD` = "Phase 2, question import"; root and frontend `README.md` updated; `.ai/` updated (state, queue, features, changelog, issues, this file).

## Files Changed (repository, eighth session)
- New: `supabase/migrations/20260924000000_result_functions.sql`, `supabase/tests/result_functions_test.sql`, `docs/sql-results.md`, `backend/functions/results/{index,handler,parse}.ts`, `backend/tests/results.test.ts`, `frontend/assets/js/teacher/api/results.js`, `frontend/assets/js/teacher/components/{resultBits.js,reviewItem.js}`, `frontend/assets/js/teacher/screens/{grading.js,gradingQuestion.js,examResults.js,sessionReport.js}`, `frontend/assets/css/results.css`, `frontend/tests/results_e2e.py`, `frontend/tests/live_results_check.py`, `frontend/tests/cleanup_live_results.sql`.
- Edited: `frontend/assets/js/teacher/router.js` (five new routes), `frontend/assets/js/teacher/screens/shell.js` (live Grading/Results + badge), `frontend/teacher/index.html` (results.css), `frontend/assets/css/teacher.css` (badge), `frontend/tests/mock_server.py`, `frontend/tests/teacher_e2e.py`, `.github/workflows/frontend-tests.yml`, the four READMEs, `.ai/` docs.

## Files Changed (repository, seventh session)
- New: `supabase/migrations/20260923000000_session_functions.sql`, `supabase/tests/session_functions_test.sql`, `docs/sql-sessions.md`, `backend/functions/session/{index,handler,parse,token}.ts`, `backend/tests/session.test.ts`, `frontend/index.html`, `frontend/assets/css/student.css`, `frontend/assets/js/student/{app,api,store}.js`, `frontend/assets/js/student/screens/{join,exam,result}.js`, `frontend/assets/js/student/components/question.js`, `frontend/tests/student_e2e.py`.
- Edited: `frontend/tests/mock_server.py`, `frontend/assets/js/shared/icons.js`, `.github/workflows/frontend-tests.yml`, `supabase/README.md`, `frontend/README.md`, `.ai/` docs.

## Files Changed (repository, sixth session)
- Edited: `frontend/assets/js/core/api.js`, `frontend/assets/js/teacher/app.js`, `.ai/09_KNOWN_ISSUES.md`, `.ai/07_CHANGELOG.md`, this file.

## Files Changed (repository, fifth session)
- New: `supabase/migrations/20260922000000_exams_functions.sql` (applied live), `backend/sync_functions.py`.
- Edited: `docs/sql-exams.md` (rewritten: verification record + schema facts), `supabase/README.md` (deploy instructions), `.gitignore` (`supabase/functions/`), `backend/functions/exams/parse.ts` (`draw_per_student` default), `.ai/` docs.

## Files Changed (repository, fourth session)
- New: `backend/functions/exams/{index,handler,parse}.ts`, `backend/tests/exams.test.ts`, `docs/sql-exams.md`, `frontend/assets/js/teacher/{api/exams.js,screens/exams.js,screens/examEditor.js}`, `frontend/tests/exams_e2e.py`.
- Edited: `frontend/tests/mock_server.py` (exams route), `frontend/tests/teacher_e2e.py` (nav assertion), `frontend/assets/js/teacher/router.js`, `frontend/assets/js/teacher/screens/shell.js` (Exams menu live), `frontend/assets/css/questions.css` (exam styles), `.ai/` docs.
- Second session: new `.github/workflows/frontend-tests.yml`, `frontend/tests/fixtures_dir.py`; edited `make_fixtures.py`, `media_e2e.py`, `question_editor_e2e.py` (flake fix), `.ai/` docs.
- First session (commit `4493577`): new `frontend/assets/js/teacher/screens/questionImport.js`, `frontend/tests/question_import_e2e.py`, `frontend/tests/unit/{make_xlsx_fixture.py,fixtures/import-sample.xlsx}`, `frontend/assets/templates/{make_import_template.py,import-template.xlsx,import-template.csv,README.md}`; edited router, bank screen/API, icons, config (APP_BUILD), questions.css, mock_server, unit tests, READMEs, `.ai/`.

## Database Changes
**Exam functions applied live on 2026-09-22** (fifth session) — recorded in git as `supabase/migrations/20260922000000_exams_functions.sql`.

**Session functions applied live on 2026-09-23** (seventh session) — recorded in git as `supabase/migrations/20260923000000_session_functions.sql`; `session` function deployed v1.

**Result functions applied live on 2026-09-24** (eighth session) — recorded in git as `supabase/migrations/20260924000000_result_functions.sql`; `results` function deployed v1. It re-creates `_session_grade` (the only change to a TASK-010 object: a hand-graded question is skipped on a re-grade).

Zero data changes left behind by any session (all verification rows deleted; live state after the eighth session: 0 exams, 0 sessions, 0 answers, 0 grades, 0 results, 0 events, 0 retake permissions, 0 rate-limit rows, 40 questions, 4 audit rows). Older migrations `v2_01`..`v2_12` are still only in the live project (ISSUE-001 partially fixed; `supabase db pull` brings the rest in).

## Current State (what works)
- Everything teacher-side now works against the **real backend**: sign-in, question bank, editor, import (`question-bank` v3 live), media (built; live upload still unverified), and **exams** (SQL + function live, whole flow verified with the admin account).
- Exams list `#/exams` and editor `#/exams/new`, `#/exams/edit/:id` — full create/edit flow (manual/auto question selection, schedule, live code uniqueness check, shuffle, tab limits, result rules, templates, duplicate). Tested 25 browser checks against the mock and live against the real backend.
- Verification levels (see `00_AI_RULES.md` section 7): exam flow = **LIVE-VERIFIED** (admin); import = live for the check call (a full import of real rows not yet run); `.xlsx` from a real Excel/Google Sheets = still NEEDS_VERIFICATION (ISSUE-013 caveat); media upload = still NEEDS_VERIFICATION (TASK-007).
- The **student side works**: `frontend/index.html` (join by code → take the test → result) against the deployed `session` function. Join (1 attempt per normalized name+class, single-use retake), a per-session snapshot with the answer key server-side, autosave with an offline queue, a server-backed timer with the 2-minute tolerance, page-leave warnings with the auto-submit limit, submit with automatic grading, and a result screen that follows the exam's visibility setting. Live-verified over HTTP with the admin account; the student *screens* were verified against the mock server only (one owner run against the real project is still worth doing).
- The **teacher's grading and results side works (eighth session)**: menu items **Grading** (with a waiting-essays badge) and **Results**; the hub lists every exam that has been taken; `#/grading/:examId` grades one essay question across all students in order (bubbles, guide, "Save and next student"); `#/results/:examId` is the results table of one exam (summary strip, score, right/wrong, time, page leaves, status); `#/results/:examId/session/:sessionId` is one attempt with every answer, the correct answer, per-question grading (essays and BR-18 corrections), the event history, and the actions **add time**, **reopen** (BR-11) and **allow a retake** (BR-02). Nothing about a result is hidden behind another screen and no answer key reaches a student (BR-09).
- What does **not** exist yet: the **statistics tabs** of the results screen (Questions/Classes, mockups 15) and the **exports** (Excel/CSV/PDF), the **live monitor** (in-progress view with the event timeline, TASK-013), a scheduled `expire_sessions()` (ISSUE-018) and the notification/email work (TASK-015).

## Testing Performed (fourth session, 2026-09-22)
- Backend `deno test --allow-env backend/` → **65 passed** (41 + 24 new exams tests); unit 21 ✓.
- All six browser suites green: teacher, bank, editor, media, import, **exams (new, run twice)**.
- `teacher_e2e.py` nav assertion updated for the now-live Exams menu item (3 links + 2 "soon" pills).
- Second session (2026-09-22): full local CI-sequence simulation in order: teacher → bank → editor → media → import, all pass (backend 41 and unit 21 re-checked green).
- `media_e2e.py` → 29/29 after the ISSUE-014 fix (regenerated fixtures in the portable temp dir).
- Editor suite 3× consecutive passes after the flake fix (ISSUE-016).
- First session: backend 41, unit 21, all five suites green (see the changelog entry for details).

## Remaining Work
1. **TASK-013 (next): the live monitor.** A teacher should be able to watch an exam while it runs — who is working, progress, time left, page leaves — and see one attempt's event timeline. `session_events`, `tab_switch_count`, `last_heartbeat_at` and `experiment`-ready SQL all exist; the reporting screens from TASK-012 are the natural place to hang it (`get_session_report` already returns the events and the actions, and `list_exam_results` already returns in-progress rows with `remaining_seconds`).
2. **TASK-012 remainder (smaller)**: the Questions and Classes tabs of the results screen (mockup 15 — hardest questions, what students chose, average per class with merged names) and the exports (Excel/CSV/PDF). The SQL for class merging is already used in `list_exam_results` (`class_aliases`); a questions/statistics function and a CSV/Excel writer are still missing. Note the frontend has **no** file-writing helper yet (the import parsers only read), so an export needs either a new small writer (no dependencies, DEC-007) or an owner decision.
3. **Owner steps**: disable public sign-up (ISSUE-007), one live media upload check (TASK-007), `supabase db pull` for `v2_01`..`v2_12` (TASK-008), TASK-006 step 4 (review the import formats, one real Excel file), and one owner run of the teacher grading screens + `frontend/index.html` against the real project (the screens were mock-tested; the live script behind them checked the API, not the pixels).
4. **Later**: a scheduled `expire_sessions()` + `purge_rate_limits()` (TASK-015, ISSUE-018/ISSUE-012).

## Known Problems
See `09_KNOWN_ISSUES.md`. Most important now: ISSUE-007 (public email sign-up still enabled — one dashboard flip), ISSUE-002 (media upload never run live), ISSUE-001 (older migrations still not in git), ISSUE-018 (nothing schedules `expire_sessions`), ISSUE-019 (no `beforeunload` guard on the student page, deliberate). **ISSUE-017 is closed** — the grading screen shipped this session and an essay result can now become final.

## Recommended Next Task
1. **Owner choice for release:** either approve promoting `ai-development` → `main` with documented leftovers (monitor untested; owner checklist items), **or** wait until TASK-013 has a Playwright suite.
2. Otherwise continue development on `ai-development`: finish TASK-013 (`monitor_e2e.py` + live check), or TASK-012 remainder (stats/exports).

## Suggested Work For Next AI
1. `git checkout ai-development && git pull`. Read RELEASE STATUS in this file first, then `.ai/00_AI_RULES.md`, `05_TASK_QUEUE.md` TASK-013, then the relevant source — and `docs/sql-results.md` + `docs/sql-sessions.md` before touching anything exam/result-related.
2. Before any live-DB or git-push action, confirm with the owner that no other agent session is currently active — see the "Concurrent-agent collision" note above.
3. Confirm your environment matches: backend **104** tests, unit 21 (with `--allow-read`), and the **nine** Playwright suites green (teacher, bank, editor, media, import, exams, student, results, **monitor**). `python frontend/dev-server.py 8123` serves both apps: the teacher page at `/teacher/index.html`, the student page at `/index.html`. Two SQL tests must pass with `npx supabase db query --linked --file …`: `supabase/tests/session_functions_test.sql` → `SESSION ENGINE TESTS PASSED (all rows rolled back)` and `supabase/tests/result_functions_test.sql` → `RESULT ENGINE TESTS PASSED (all rows rolled back)`.
4. Do not merge to `main` while RELEASE STATUS is BLOCKED unless the owner explicitly overrides.
5. If continuing TASK-013: add live verification (`20260925000000_monitor_overview_fields.sql` still not applied live) and one real browser run against an open exam.
6. To deploy or run SQL on v2 you need the owner's access token (`SUPABASE_ACCESS_TOKEN` env var, `npx supabase ...`) or Supabase MCP if connected. Deploy path: `python backend/sync_functions.py` then `npx supabase functions deploy <name> --no-verify-jwt --use-api`. Do not request the token again without need, and never store it in the repo or in chat.
7. Verify against live with the admin account only when the owner asks; clean up every test row afterwards (exams, sessions, audit entries) — the live DB is the real one.
8. CI status: both workflows were **green on `c495e0d`** (2026-09-24); the frontend browser job now runs **nine** suites as of TASK-013. Watch every later push the same way; the browser job is the one that flakes (`playwright install --with-deps chromium` is the slow step).
9. The review-table select-all is tri-state by design (first click fills the gaps, second clears everything); the default selection leaves exact duplicates and in-file duplicates unchecked. Keep those semantics unless the owner asks otherwise.
10. After your work: test, update `.ai/` (state, queue, changelog, this file — including the branch/commit fields at the top), commit on `ai-development`, push.
11. When `ai-development` is eventually merged into `main` (owner's call): resolve the import files in favor of `ai-development` and drop `frontend/tests/import.test.js` + `frontend/assets/js/teacher/import/model.js` (Codex's superseded variant, DEC-021 / ISSUE-015).

## Do NOT Do
- Do not rebuild the student page or the `session` function: the contract is fixed in `docs/sql-sessions.md` (action names, response fields, `validation`-hinted errors) and the handler + 21 Deno tests + 52 browser checks match it. Extend it instead.
- Do not rebuild the grading/results screens or the `results` function: the contract is fixed in `docs/sql-results.md` (action names, response fields, the `actions` block) and the handler + 18 Deno tests + 59 browser checks match it.
- Do not write `exam_results` anywhere except `_session_result_write`: it is the only place that keeps `status` and `pass_status` in step with the stored grades (the table has a CHECK that ties them together).
- Do not let an automatic re-grade overwrite a hand-made one: `_session_grade` must keep skipping a question whose `answer_grades.is_auto` is false (BR-18), or a reopen + second submit would silently undo a teacher's correction.
- Do not put the grading guide (`questions.essay_guidance`) into a session snapshot — it is the teacher's rubric, read live only where a staff payload is built.
- Do not add a second way for a student to start or continue a test (no extra `join`/`save`/`submit` path, no direct table access, no answer key in any response — BR-09).
- Do not send the answer key to the browser, and do not put `answer_key` or correct answers into `session_events.meta`, logs, or audit `changes`.
- Do not make the student page depend on the teacher's bug fix (the session-expired announcement gate in `core/api.js`): the student side has no session to expire.
- Do not insert into `exam_sessions.student_name_normalized`/`student_class_normalized` (generated columns) or into `accepted_answers.answer_normalized`/`question_class_labels.label_normalized` — the database computes them from `normalize_text` (DEC-005).
- Do not work directly on `main`; do not merge `ai-development` into `main` yourself (DEC-020).
- Do not force-push, reset `--hard`, or delete either branch.
- Do not rebuild the question editor, question bank, import parsers, media picker, sign in, the router, or the exam screens/API just built (F-02, F-04..F-09 are done or largely done; follow `docs/sql-exams.md` for the exam contract).
- Do not invent a different exam SQL contract than `supabase/migrations/20260922000000_exams_functions.sql` (the live SQL) and `docs/sql-exams.md` (the record) — the Edge Function handler and its tests match that exact function set and argument shape (`p`, `p_id`, `p_actor`, …). Remember the live-schema facts there: enum columns need casts, positions start at 1, `auto_filter` NOT NULL, code CHECK `^[A-Z0-9]{4,12}$`.
- Do not resurrect Codex's import variant from `main` or mix the two implementations (DEC-021, ISSUE-015).
- Do not add a second import/save path: parsing belongs in `frontend/assets/js/teacher/import/`, saving only through `question-bank` `import` → `import_questions` (DEC-004, DEC-014).
- Do not add frontend dependencies or a build step (DEC-007); the test-only `npm:linkedom` shim lives in the Deno unit tests, not in the browser code.
- Do not change the text normalization/hash rule in only one language (DEC-005).
- Do not add RLS policies or grants; do not query tables from the browser (DEC-002).
- Do not touch the v1 project (`Exam_Data_Base`) (DEC-015).
- Do not change the visual system (tokens, fonts, bubble motif) without the owner's approval (DEC-008).
- Do not push secrets (access tokens, passwords) — not into the repo, not into migration files, not into `.ai/`. The owner's token from the fifth session should be revoked; a new one can be minted when needed.
- Do not "fix" the `Admin` placeholder name or create accounts without the owner's request.
- Do not mark anything done without stating how it was verified — follow the TESTED / UNVERIFIED labels in this file and `03_FEATURES.md`.

## If Next AI Cannot Complete The Task
1. Stop rather than guessing.
2. Document the blocker.
3. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md` (including the branch/commit fields).
5. Continue with another `READY` task if appropriate (TASK-018 needs only the repository). Stay on `ai-development`.
