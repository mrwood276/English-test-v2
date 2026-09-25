# 03 FEATURES

Feature registry. Status values: COMPLETE, STABLE, PARTIAL, IN_PROGRESS, BLOCKED, PLANNED, DEPRECATED.
Protection values: PROTECTED (no casual rewrite), STABLE (modify carefully), ACTIVE (under development), EXPERIMENTAL (unfinished).
Verification (see `00_AI_RULES.md` section 7): LIVE-VERIFIED, TESTED, UNVERIFIED.

Requirement IDs (BR-xx, D-xx) refer to `docs/design.md`.

## Summary table

| # | Feature | Status | Protection | Verification |
|---|---|---|---|---|
| F-01 | Database schema (22 tables, 25 functions + 13 added since) | COMPLETE for Phases 1–2 (exam and session tables are now in use) | PROTECTED | TESTED (SQL) |
| F-02 | Staff authentication and roles | COMPLETE | PROTECTED | LIVE-VERIFIED (owner signed in) |
| F-03 | Teacher/admin app shell, router, dashboard | COMPLETE (mockup 5 dashboard + compact phone menu) | STABLE | LIVE-VERIFIED (shell); dashboard TESTED (CI + mocked browser) |
| F-04 | Question bank: list, filters, preview, archive, delete | COMPLETE | STABLE | LIVE-VERIFIED (40 questions shown), rest TESTED |
| F-05 | Question editor (4 types, labels, topics, duplicate warnings, preview, unsaved guard) | COMPLETE | STABLE | LIVE-VERIFIED (add/edit opened and worked per owner), rest TESTED |
| F-06 | Reading texts (passages) | COMPLETE | STABLE | TESTED; at least one created live |
| F-07 | Images and audio for questions and reading texts | PARTIAL (built; real Storage upload never run) | ACTIVE | TESTED (mocked); **UNVERIFIED live** |
| F-08 | Import questions from Excel/CSV and pasted text | LIVE (question-bank v3 deployed 2026-09-22) | ACTIVE | `import_check` answered live; parsers TESTED (21 unit tests incl. zip/xlsx); screen TESTED (43 browser checks, mocked); a real Excel/Google-Sheets file still NEEDS_VERIFICATION (ISSUE-013 caveat) |
| F-09 | Exams (create, exam code, schedule, selection, templates) | Teacher side LIVE-VERIFIED (2026-09-22) | ACTIVE | SQL applied + function live; whole flow verified with the admin account (save/update/open/code rules/duplicate/remove/refusals); student join is F-11 |
| F-10 | Export questions to PDF/Word | PLANNED | – | – |
| F-11 | Student join and exam engine | CORE COMPLETE (join, take, autosave, submit, auto-grade, result) | ACTIVE | LIVE-VERIFIED (2026-09-23, 27 checks through the deployed `session` function); SQL TESTED (rolled-back `session_functions_test.sql`); browser TESTED (`student_e2e.py`, 52 checks) |
| F-12 | Essay grading, results, statistics, exports | COMPLETE except the PDF class summary | ACTIVE | LIVE-VERIFIED (core, 2026-09-24); statistics and the CSV/Excel exports TESTED (browser, 2026-09-24) |
| F-13 | Anti-cheating events and live monitor | COMPLETE (screens + exam-wide add time + tests) | ACTIVE | **FULLY LIVE-VERIFIED (2026-09-24)**: real browser against a real running exam (`live_browser_check.py`, 20/20) + the payload-level check (`live_monitor_check.py`, 38/38); `monitor_e2e.py` 30/30 |
| F-14 | Audit log viewer (built), backups, notifications, user management | **PARTIAL — viewer LIVE-VERIFIED (2026-09-25)** | ACTIVE | Viewer LIVE-VERIFIED (live rolled-back SQL test + admin smoke call); backups/notifications/user management not built |
| F-15 | Design system and approved mockups | COMPLETE | PROTECTED | Owner-approved |
| F-16 | Legacy v1 app (outside this repo) | DEPRECATED (live, untouched) | – | – |

---

## F-01 Database schema

- Status: COMPLETE for Phases 1–2. Protection: **PROTECTED**.
- Description: 22 tables + 25 functions + storage bucket, as listed in `02_ARCHITECTURE.md`. The exam and session tables (`exams`, `exam_questions`, `exam_sessions`, `session_answers`, `answer_grades`, `exam_results`, `session_events`, `retake_permissions`, `rate_limits`) are now in use; backups, class aliases and app settings still have no code.
- Files: **none in git** (ISSUE-001). Design: `docs/design.md` section 3. Live migrations `v2_01`..`v2_12`.
- Notes: normalized name/class columns on `exam_sessions` are generated columns (`normalize_text`). `questions.legacy_id` links migrated v1 questions. `questions.content_hash` supports duplicate detection.
- Allowed: additive migrations, bug fixes, new indexes, new functions. Not allowed: dropping/renaming tables in use, opening RLS, granting to anon/authenticated, changing the normalization/hash rule without changing `text.ts` too.
- DO NOT REBUILD THIS FEATURE WITHOUT A SPECIFIC REASON.

## F-02 Staff authentication and roles

- Status: COMPLETE. Protection: **PROTECTED**.
- Behavior: email + password sign in; session in `sessionStorage`; refresh before expiry; sign out; a session that ends anywhere returns the person to sign in with an explanation.
- Files: `frontend/assets/js/core/auth.js`, `core/api.js`, `core/http.js`, `frontend/assets/js/teacher/app.js`, `teacher/screens/login.js`; `backend/functions/_shared/auth.ts`, `backend/functions/auth-me/index.ts`; table `profiles`.
- State: one profile exists (role `admin`, display name placeholder "Admin"). **No teacher account yet.** Accounts are created by the owner in the Supabase dashboard (Authentication → Users), then a `profiles` row is inserted (SQL). There is no user-management UI.
- Limitations: password reset by email is not wired (needs an app address configured in Auth). No rate limiting on sign in beyond Supabase Auth's own. Leaked-password protection reported disabled by the Supabase advisor (ISSUE-005).
- Allowed: bug fixes, security fixes, explicitly requested improvements. Not allowed: replacing Supabase Auth, reading the role from the token, custom password storage.
- DO NOT REBUILD THIS FEATURE WITHOUT A SPECIFIC REASON.

## F-03 App shell, router, dashboard

- Status: COMPLETE (TASK-014, 2026-09-24). Protection: STABLE.
- Behavior: left menu (six items since the TASK-013 monitor progress: Dashboard, Question bank, Exams, Grading — with a waiting-essays badge — Results, and Monitor), hash routes, build label at the bottom of the menu (`APP_BUILD` in `config.js`). On phones the shell is a compact sticky header: brand + signed-in person on the first row, all menu items in one horizontally scrollable row.
- Dashboard (mockup 5): "Open now" shows the exam title, question/duration/closing facts, the access code at 52 px, Copy code / Change code / Close exam, the working count, class pills, a five-person live preview (existing `liveStatusPill` labels), and a link to the real monitor. "Needs your attention" links pending essays to grading and suspicious sessions to the monitor. "Recent exams" links the three latest finished exams to results and shows the average plus a passed-percentage meter (or "Waiting for grading"). It refreshes every 30 seconds and keeps Sign out.
- Files: `frontend/teacher/index.html`, `assets/js/teacher/router.js`, `guard.js`, `screens/shell.js`, `screens/dashboard.js`, `assets/css/teacher.css`.
- Data: the dashboard has **no second read path**. It uses `exams.list`, `results.activity`, and `results.overview`; `list_exam_activity` was extended additively with `passed`/`failed`. The class-merge row from mockup 5 is intentionally absent because no class-merge UI exists yet — BR-15 belongs to the results flow, not a second implementation on the dashboard.
- Tests: `frontend/tests/dashboard_e2e.py` (open card, attention rows, recent meter, clipboard, confirm/cancel, phone menu — green in Frontend Actions run #28) and `frontend/tests/teacher_e2e.py` (empty dashboard + shell).

## F-04 Question bank (list)

- Status: COMPLETE. Protection: STABLE.
- Behavior: 25 per page; search; filters (class label, topic, difficulty, type, used/unused, archived); sort; preview panel (student view, correct answers, accepted answers, essay guide, explanation, files); archive/restore; delete (permanent if never used, otherwise archived; confirmation dialog explains which).
- Files: `frontend/assets/js/teacher/screens/questionBank.js`, `components/questionView.js`, `api/questionBank.js`; `backend/functions/question-bank/handler.ts` (`list`, `get`, `remove`, `archive`, `restore`, `topics`, `class_labels`); SQL `list_questions`, `get_question`, `remove_question`, `set_question_archived`, `list_topics`, `list_class_labels`.
- Tests: `frontend/tests/question_bank_e2e.py`, `backend/tests/question_bank.test.ts`, SQL tests (rolled back).
- Limitations: the mockup's "N questions look like duplicates" banner over the list is not implemented (duplicate checks happen in the editor).

## F-05 Question editor

- Status: COMPLETE. Protection: STABLE.
- Behavior: types multiple choice (2–6 answers, exactly one correct), true/false, short answer (1–10 accepted answers, case/space-insensitive), essay (grading guide); B/I/U formatting; reading text picker; free-typed class labels with suggestions (max 10); topic with suggestions; difficulty Easy/Medium/HOTS; points; explanation; live duplicate warning (exact / similar ≥ 0.55) after 700 ms; preview dialog; "Save and add another" keeps labels, topic, difficulty, reading text; unsaved-changes guard; switching type keeps entered data in memory.
- Files: `frontend/assets/js/teacher/screens/questionEditor.js`, `components/richTextarea.js`, `chipsInput.js`, `passageDialog.js`, `questionView.js`; `backend/functions/question-bank/handler.ts` + `parse.ts` (`save`, `check_duplicates`); SQL `save_question`, `find_similar_questions`, `upsert_topic`.
- Routes: `#/questions/new`, `#/questions/edit/<uuid>`.
- Tests: `frontend/tests/question_editor_e2e.py` (75 checks), `question_bank.test.ts`, SQL tests.
- Limitations: no Excel/Word import inside the editor (see F-08); a question keeps at most 4 files.

## F-06 Reading texts (passages)

- Status: COMPLETE. Protection: STABLE.
- Behavior: shared by several questions; created/edited in a dialog from the editor; editing warns about the number of questions using it; cannot be deleted while used; a reading text can have its own files.
- Files: `frontend/assets/js/teacher/components/passageDialog.js`, `screens/questionEditor.js`; backend actions `passages`, `passage_get`, `passage_save`, `passage_remove`; SQL `save_passage`, `get_passage`, `list_passages`, `remove_passage`.
- Notes: v1 questions 1–10 and 35–36 were migrated into 4 shared passages (titles "The Legend of Malin Kundang", "The Smart Monkey and the Crocodile", and two "Short Context"). The live database has 5 passages: the 4 migrated ones plus 1 additional passage whose origin and content were not inspected (NEEDS VERIFICATION).
- Limitations: there is no screen listing/managing all reading texts (only the picker and dialog); `passage_remove` exists in the backend but no UI calls it.

## F-07 Images and audio (media)

- Status: **COMPLETE and LIVE-VERIFIED (2026-09-25)** — a real photo and a real MP3 were uploaded to the private bucket through the app with the staff test account, saved on a question, reopened and played back; `frontend/tests/live_media_check.py` **32/32**. Protection: ACTIVE.
- Behavior: up to 4 files per question or reading text; images JPG/PNG/WebP shrunk in the browser to about 1 MB and 1600 px (WebP, JPEG fallback); audio MP3/M4A up to 10 MB with duration read in the browser; drag and drop; upload queue with progress; previews show real `<img>` and `<audio controls>`; audio has no play limit (D-04).
- Files: `frontend/assets/js/teacher/components/mediaPicker.js`, `api/media.js`, `shared/imageCompress.js`, `components/questionView.js` (`mediaBlock`), `screens/questionEditor.js`, `components/passageDialog.js`; `backend/functions/media/handler.ts`; SQL `register_media`, `link_media`, `purge_orphan_media`, `get_media_paths`; tables `media_files`, `question_media`; bucket `question-media`.
- The upload request imitates `uploadToSignedUrl` of `@supabase/storage-js` 2.116 (PUT to the signed URL, multipart form with `cacheControl` and a file field with an **empty name**, headers `apikey` and `x-upsert: false`). Reproduced from the library source and, since 2026-09-25, **executed against the real bucket and confirmed correct** (absolute signed URL, no `Authorization` header needed, CORS fine, 813 KB WebP + 48 KB MP3 stored and served back).
- Tests: `frontend/tests/media_e2e.py` (mocked Storage, 29 checks), `backend/tests/media.test.ts`, SQL tests, and the live run `frontend/tests/live_media_check.py` (32 checks against the real project).
- Limitations: `purge_unused` (delete unused files) is manual (admin-only action, no schedule, no UI); the editor cannot reorder files; passage files are edited only in the passage dialog.
- Live proof (2026-09-25, ISSUE-002): the app shrank a 7.6 MB PNG to an 813 KB WebP and uploaded it plus a real 3-second MP3; `media_files` rows carried the size/type Storage reported and the MP3's real duration; both were attached to a question and played back after reopening; a 4.5 MB JPEG forced into Storage was refused and deleted again. Nothing was left behind.

## F-08 Import questions (Excel/CSV and pasted text)

- Status: **Browser side COMPLETE**; the feature is not usable until `question-bank` is redeployed with the import actions (TASK-006 step 3) and the owner has reviewed the file formats (step 4). Branch `ai-development` (not merged to `main`). Protection: ACTIVE.
- Done: SQL functions `find_similar_batch` and `import_questions` (migration `v2_12`, live, tested with rolled-back DO blocks). Edge actions `import_check` / `import` in `backend/functions/question-bank/` with unit tests (41 backend tests pass; not deployed). Browser parsers `frontend/assets/js/teacher/import/{rules,csv,zip,xlsx,text,rows}.js` with 21 Deno unit tests, **including the zip/xlsx readers since 2026-09-22** (fixture `frontend/tests/unit/fixtures/import-sample.xlsx`, ISSUE-013 closed).
- **Import screen** (`frontend/assets/js/teacher/screens/questionImport.js`, route `#/questions/import`, "Import" button in the question bank header): file or pasted text, defaults panel (class labels, topic, difficulty, points), review table with Ready / Fix / Duplicate in bank / Duplicate in file / Similar pills and per-row problem messages, in-file duplicate detection (`dupKey`), server duplicate check before review, selection defaults (everything importable except exact duplicates), select-all, leave guard, refused-batch errors shown with the row number and nothing saved. Templates: `frontend/assets/templates/import-template.{xlsx,csv}` (downloadable from the screen, generated by `make_import_template.py`).
- Tests: `frontend/tests/question_import_e2e.py` (43 checks against the mock server, including a real `.xlsx` upload through the file picker); `mock_server.py` implements `import_check`/`import`.
- **Not deployed:** the live `question-bank` function is version 2 and does not have the import actions — the screen will report "Nothing was saved" until it is redeployed (TASK-006 step 3).
- **Not yet verified:** the import actions against the live database through the screen; a `.xlsx` saved by real Excel/Google Sheets (fixture is spec-built, see ISSUE-013's caveat).
- Planned design (PROPOSED by Claude; the owner has not reviewed the file formats): see `05_TASK_QUEUE.md` TASK-006. The formats are now visible to the owner in the screen's help text, example, and template files.

## F-09 Exams

- Status: **teacher side LIVE-VERIFIED (2026-09-22)**. Tables (`exams`, `exam_questions`, `retake_permissions`) plus the business-rule functions are live (`supabase/migrations/20260922000000_exams_functions.sql`); the `exams` Edge Function is deployed. Requirements: `docs/design.md` BR-03..BR-06, BR-11, mockup 11 ("New exam") in `docs/mockups/round-2.html`.
- What exists: `backend/functions/exams/` (list/get/save/remove/set_status/regenerate_code/check_code/duplicate; 28 Deno tests), `screens/exams.js` (list), `screens/examEditor.js` (mockup 11 flow), `api/exams.js`, routes, mock-server handlers, `exams_e2e.py` (**37 checks**). Live verification record + schema facts: `docs/sql-exams.md`.
- **Deleting an exam (DEC-027, live-verified 2026-09-25)**: an exam with attempts reports that count in the list; a teacher sees "N attempts — kept for the results" and no Delete button (the SQL would close it instead); only the admin may delete such an exam for real, after a dialog that names the attempts and the answers, grades and results that go with them (audit: `exam.delete`, `permanent: true`). The old two-argument `remove_exam` was dropped; the Edge Function passes the force flag only for the admin role.
- Verified live with the admin account: create draft (manual selection with weights) → read → update → open → code uniqueness among open exams (refusal + `check_code`) → regenerate code → duplicate as draft → delete; refusal paths (empty manual exam, end-before-start schedule); tokenless 401. The student side (join by code, sessions) is F-11/TASK-010 — built and live-verified on 2026-09-23.
- Do not create a second exam-settings mechanism; v1's single `exam_settings` row is intentionally replaced by the `exams` table.

## F-10 Export questions to PDF/Word — PLANNED (`docs/design.md` section 1.4 lists it as [PENTING], Phase 2; not started).

## F-11 Student join and exam engine

- Status: **CORE COMPLETE and LIVE-VERIFIED (2026-09-23)**. Protection: ACTIVE (the student screens must not be rebuilt; the engine contract is recorded in `docs/sql-sessions.md`).
- What exists: the student page `frontend/index.html` (join → take the test → result) with `assets/js/student/{app.js,api.js,store.js,screens/{join,exam,result}.js,components/question.js}` and `assets/css/student.css`; the Edge Function `backend/functions/session/` (actions `join`, `get`, `save`, `heartbeat`, `event`, `submit`, `result`, `media`; 21 Deno tests); the SQL functions in `supabase/migrations/20260923000000_session_functions.sql` (live) with `supabase/tests/session_functions_test.sql`; mock-server support and `frontend/tests/student_e2e.py` (52 checks).
- Behavior: name + class + code (the code may be typed in any case, spaces are cleaned), 1 attempt per normalized name+class with a single-use teacher permission for a retake (BR-01/BR-02), the exam's open/scheduled window and the late-start policy (BR-03/BR-04/BR-05), a per-session question snapshot with the answer key kept on the server (BR-09/BR-10), autosave with an offline queue and a local copy that survives a reload (BR-12), a server-backed timer with the 2-minute tolerance (BR-20), page-leave events with the warning and the automatic submit limit (design section 4), submit with automatic grading of multiple choice/true-false/short answer and essays left for the teacher (BR-06/BR-07), and a result screen that honours `result_visibility` + `essay_pending_display` (BR-08).
- Notes: a second attempt with the same normalized name+class is refused with a clear message; an unfinished attempt is *resumed* instead of duplicated; `expire_sessions()` is written but nothing calls it yet (TASK-015 puts it on a schedule); there is no `beforeunload` guard yet (see `09_KNOWN_ISSUES.md`).
- Not built: the live monitor (TASK-013) and the statistics tabs/exports (TASK-012 remainder).
- Next: TASK-013 (live monitor) — grading, results and the teacher's actions on an attempt exist since 2026-09-24 (see F-12).

## F-12 Grading, results (and the teacher's actions on an attempt)

- Status: **CORE COMPLETE and LIVE-VERIFIED (2026-09-24)**. Protection: ACTIVE (extend rather than rebuild; contract in `docs/sql-results.md`).
- What exists: the menu items **Grading** (with a waiting-essays badge) and **Results**; the hub `#/grading` / `#/results` (every exam that has sessions, with sessions/finished/waiting/average); the essay grading screen `#/grading/:examId` (mockup 13 — question picker with progress, the question plus the teacher's guide, each student's answer, points as answer-sheet bubbles, comment, "Save and next student"); the per-exam results screen `#/results/:examId` (mockup 14 — summary strip with average/highest/lowest/passed/not-final, then one row per student with class (merged names from `class_aliases` — BR-15), score, right/wrong, time used, page leaves, status and a Details link); the attempt report `#/results/:examId/session/:sessionId` (every answer with the correct answer and the student's pick, per-question grading for essays and BR-18 corrections, the event history, and the actions **add time**, **reopen** (BR-11) and **allow / take back a retake** (BR-02)).
- Backend: `results` Edge Function (11 actions, 18 Deno tests) over `supabase/migrations/20260924000000_result_functions.sql` (live), with `supabase/tests/result_functions_test.sql` for the rules. `_session_result_write` is the only writer of `exam_results`; `_session_grade` now skips questions a teacher graded by hand, so a reopen + second submit cannot undo a correction.
- Exports: **CSV and Excel (.xlsx)** buttons on `#/results/:examId`, both built in the browser with no dependencies (`frontend/assets/js/teacher/export/` — a hand-written ZIP writer and xlsx writer; the unit tests read the writer's own output back with the repository's import reader, and the browser suite opens the download with Python's `zipfile`). **Not built: the PDF class summary** of mockup 14 — a dependency-free PDF writer is a much bigger lift and needs the owner's decision on what a one-page class summary should contain.
- Statistics tabs: **Classes** (merged class names, students, average, passed, not final — from the overview payload) and **Questions** (hardest first: answered, accuracy, most chosen). The Questions tab reads one staff report per *finished* attempt, tolerates a report that fails to load, and never offers a written answer as a "most chosen" one.
- Notes: a blank essay still needs one click from the teacher (it counts as an answer worth 0), which is deliberate — the result stays honest about "not graded yet".

## F-13 Anti-cheating events and the live monitor

- Status: **CORE COMPLETE and LIVE-VERIFIED (2026-09-23)**. Protection: ACTIVE (extend rather than rebuild).
- What exists: `#/monitor` (exams with students working), `#/monitor/:examId` (mockup 12 table: progress, time left, page leaves, Saved / Left the page / Offline / Need a look), `#/monitor/:examId/session/:sessionId` (event history + add time while they work); menu item; auto-refresh 30s / 15s; `liveStatusPill` / shared event labels in `resultBits.js`.
- Backend: uses existing `results` actions `activity` / `overview` / `report` / `add_time`. `supabase/migrations/20260925000000_monitor_overview_fields.sql` adds `answered_count`, `question_count`, `last_heartbeat_at` to `list_exam_results` — **applied live 2026-09-23** (schema/privilege-verified via Supabase MCP; `anon`/`authenticated` still refused, `service_role` still allowed, security advisor clean). Not yet seen rendering against a real running exam in a browser.
- Tests: `frontend/tests/monitor_e2e.py` (23 checks); CI runs it as the ninth browser suite. Mock server returns the new overview fields.
- Not built: mass "add time to everyone", one real browser run against a live open exam, scheduled `expire_sessions` (TASK-015).

## F-14 Audit log viewer (built), backups, notifications, user management

- Status: **viewer LIVE-VERIFIED (2026-09-25)** — the migration and the `audit` Edge Function are applied/deployed on the real project, and both the rolled-back SQL test and an admin smoke call passed against it. Protection: ACTIVE.
- The audit-log **viewer** (first TASK-015 slice): an admin-only menu item ("Audit log", `#/audit`) and table — When / Who / Action / Entity / Details — newest first, 25 per page, with an action filter, an entity-type filter, a time-window select (All time / 7 / 30 / 90 days) and Clear. `Who` resolves the actor's name from `profiles` and says "System" for a row without an actor. Read-only; the screen only ever calls `list`.
- Files: `frontend/assets/js/teacher/screens/auditLog.js`, `api/audit.js`, route + admin menu in `router.js` / `shell.js`; Edge Function `backend/functions/audit/` (action `list`; the **only** staff endpoint restricted to `["admin"]` — design.md 1.2: teachers cannot manage the system's audit log); SQL `list_audit_logs` in `supabase/migrations/20260929000000_audit_functions.sql` (security definer, execute revoked from public/anon/authenticated like everything else; contract: `docs/sql-audit.md`).
- Tests: `backend/tests/audit.test.ts` (8), `frontend/tests/audit_e2e.py` (25 checks), `supabase/tests/audit_functions_test.sql` (rolled-back live assertions — **run live on 2026-09-25, passed**). All green locally 2026-09-29 and again 2026-09-25 (backend 114, unit 31, all eleven browser suites).
- **Live (applied before this session; verified 2026-09-25, seventeenth session):** the SQL is live — recorded in `supabase_migrations.schema_migrations` as `20260925001719 v2_16_audit_functions`; `pg_proc.proacl` shows `postgres` + `service_role` only (PUBLIC/anon/authenticated revoked), `security definer`, `stable`. The `audit` Edge Function is live (`v1`, ACTIVE, `verify_jwt=false`). Live public SQL functions went 60 → **61**. The rolled-back test passed live: `AUDIT VIEWER TESTS PASSED (all rows rolled back)`; the admin smoke returned `total 4` with 4 rows and resolved actor names, `limit 1 / offset 2` paged correctly, a 2-day + `question` filter returned 0 (the real rows are from 2026-09-21), `days=0` was refused with a friendly 400, and a tokenless call got 401 `Please sign in.` Row counts after the run: 4 audit rows, no `audit_test` rows leaked, 40 questions.
- **How to run SQL against the live project from this clone:** there is **no `supabase db query` subcommand** in CLI 2.117.0 (the command in the sixteenth session's handoff does not exist). Use the Management API query endpoint (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "..."}`, one request = one session so file-level `pg_temp.*` works) or the dashboard SQL editor. The `sql-audit.md` command note has been corrected.
- Not started (rest of TASK-015): backups (manual + scheduled), notifications (dashboard + email — needs the owner to choose a provider, DEC-017), scheduled purge jobs (`expire_sessions`, `purge_orphan_media`, `purge_rate_limits` — need pg_cron live), user management.

## F-15 Design system and approved mockups

- Status: COMPLETE. Protection: **PROTECTED** (owner-approved direction).
- Files: `frontend/assets/css/tokens.css`, `docs/mockups/round-1.html`, `round-2.html`, `docs/design.md` section 1.8.
- Allowed: implementing the approved screens, small accessibility/visual fixes. Not allowed: changing the palette, fonts, or the A–D bubble motif without the owner's approval.

## F-16 Legacy v1 app (outside this repository)

- Status: DEPRECATED but live. Separate Supabase project (`Exam_Data_Base`, ref `dtrgbjqfnkjiengpvbym`), single class-XII exam, shared teacher password, no attempt limit. **Do not modify it** (DEC-015). Its 40 questions were copied into v2; its result data will be exported/archived at cutover (DEC-016). Known v1 problems: `docs/audit-v1.md`.
