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
| F-03 | Teacher/admin app shell, router, dashboard | COMPLETE (dashboard is a placeholder) | STABLE | LIVE-VERIFIED (shell), dashboard minimal |
| F-04 | Question bank: list, filters, preview, archive, delete | COMPLETE | STABLE | LIVE-VERIFIED (40 questions shown), rest TESTED |
| F-05 | Question editor (4 types, labels, topics, duplicate warnings, preview, unsaved guard) | COMPLETE | STABLE | LIVE-VERIFIED (add/edit opened and worked per owner), rest TESTED |
| F-06 | Reading texts (passages) | COMPLETE | STABLE | TESTED; at least one created live |
| F-07 | Images and audio for questions and reading texts | PARTIAL (built; real Storage upload never run) | ACTIVE | TESTED (mocked); **UNVERIFIED live** |
| F-08 | Import questions from Excel/CSV and pasted text | LIVE (question-bank v3 deployed 2026-09-22) | ACTIVE | `import_check` answered live; parsers TESTED (21 unit tests incl. zip/xlsx); screen TESTED (43 browser checks, mocked); a real Excel/Google-Sheets file still NEEDS_VERIFICATION (ISSUE-013 caveat) |
| F-09 | Exams (create, exam code, schedule, selection, templates) | Teacher side LIVE-VERIFIED (2026-09-22) | ACTIVE | SQL applied + function live; whole flow verified with the admin account (save/update/open/code rules/duplicate/remove/refusals); student join is F-11 |
| F-10 | Export questions to PDF/Word | PLANNED | – | – |
| F-11 | Student join and exam engine | CORE COMPLETE (join, take, autosave, submit, auto-grade, result) | ACTIVE | LIVE-VERIFIED (2026-09-23, 27 checks through the deployed `session` function); SQL TESTED (rolled-back `session_functions_test.sql`); browser TESTED (`student_e2e.py`, 52 checks) |
| F-12 | Essay grading, results, statistics, exports | CORE COMPLETE (stats/exports remain) | ACTIVE | LIVE-VERIFIED (core, 2026-09-24); stats/exports UNVERIFIED |
| F-13 | Anti-cheating events and live monitor | CORE COMPLETE (screens + tests) | ACTIVE | LIVE-VERIFIED (`monitor_e2e.py` + live schema/privilege check, 2026-09-23); real browser run against a live open exam still pending |
| F-14 | Audit log viewer, backups, notifications, user management | PLANNED | – | – |
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

- Status: COMPLETE (dashboard is only a welcome + connection check). Protection: STABLE.
- Behavior: left menu (six items since the TASK-013 monitor progress: Dashboard, Question bank, Exams, Grading — with a waiting-essays badge — Results, and Monitor), hash routes, build label at the bottom of the menu (`APP_BUILD` in `config.js`, now "Phase 4, grading and results").
- Files: `frontend/teacher/index.html`, `assets/js/teacher/router.js`, `guard.js`, `screens/shell.js`, `screens/dashboard.js`, `assets/css/teacher.css`.
- Notes: the mockup dashboard (running exam with big code, "needs your attention", recent exams) is **not implemented**; it depends on exams.
- Limitations: on phones the menu takes much vertical space (mockups are desktop for teachers; low priority).

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

- Status: **PARTIAL** — fully built, but **the real upload to Supabase Storage has never been run** (0 rows in `media_files`). Protection: ACTIVE.
- Behavior: up to 4 files per question or reading text; images JPG/PNG/WebP shrunk in the browser to about 1 MB and 1600 px (WebP, JPEG fallback); audio MP3/M4A up to 10 MB with duration read in the browser; drag and drop; upload queue with progress; previews show real `<img>` and `<audio controls>`; audio has no play limit (D-04).
- Files: `frontend/assets/js/teacher/components/mediaPicker.js`, `api/media.js`, `shared/imageCompress.js`, `components/questionView.js` (`mediaBlock`), `screens/questionEditor.js`, `components/passageDialog.js`; `backend/functions/media/handler.ts`; SQL `register_media`, `link_media`, `purge_orphan_media`, `get_media_paths`; tables `media_files`, `question_media`; bucket `question-media`.
- The upload request imitates `uploadToSignedUrl` of `@supabase/storage-js` 2.116 (PUT to the signed URL, multipart form with `cacheControl` and a file field with an **empty name**, headers `apikey` and `x-upsert: false`). Reproduced from the library source, never executed against real Storage. If it fails live, compare with that library first.
- Tests: `frontend/tests/media_e2e.py` (mocked Storage), `backend/tests/media.test.ts`, SQL tests.
- Limitations: `purge_unused` (delete unused files) is manual (admin-only action, no schedule, no UI); the editor cannot reorder files; passage files are edited only in the passage dialog.
- Next: TASK-007 (verify live).

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
- What exists: `backend/functions/exams/` (list/get/save/remove/set_status/regenerate_code/check_code/duplicate; 24 Deno tests), `screens/exams.js` (list), `screens/examEditor.js` (mockup 11 flow), `api/exams.js`, routes, mock-server handlers, `exams_e2e.py` (25 checks). Live verification record + schema facts: `docs/sql-exams.md`.
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
- Not built (TASK-012 remainder): the **Questions** and **Classes** tabs (mockup 15 — hardest questions, option distribution, average per class) and the **exports** (Excel/CSV/PDF). Statistics are readable from the stored `exam_results.review_snapshot`, so no schema work is needed; an export needs a small dependency-free writer or an owner decision.
- Notes: a blank essay still needs one click from the teacher (it counts as an answer worth 0), which is deliberate — the result stays honest about "not graded yet".

## F-13 Anti-cheating and live monitor

- Status: **CORE COMPLETE and LIVE-VERIFIED (2026-09-23)**. Protection: ACTIVE (extend rather than rebuild).
- What exists: `#/monitor` (exams with students working), `#/monitor/:examId` (mockup 12 table: progress, time left, page leaves, Saved / Left the page / Offline / Need a look), `#/monitor/:examId/session/:sessionId` (event history + add time while they work); menu item; auto-refresh 30s / 15s; `liveStatusPill` / shared event labels in `resultBits.js`.
- Backend: uses existing `results` actions `activity` / `overview` / `report` / `add_time`. `supabase/migrations/20260925000000_monitor_overview_fields.sql` adds `answered_count`, `question_count`, `last_heartbeat_at` to `list_exam_results` — **applied live 2026-09-23** (schema/privilege-verified via Supabase MCP; `anon`/`authenticated` still refused, `service_role` still allowed, security advisor clean). Not yet seen rendering against a real running exam in a browser.
- Tests: `frontend/tests/monitor_e2e.py` (23 checks); CI runs it as the ninth browser suite. Mock server returns the new overview fields.
- Not built: mass "add time to everyone", one real browser run against a live open exam, scheduled `expire_sessions` (TASK-015).

## F-14 Audit log viewer, backups, notifications, user management — PLANNED

Audit entries are already **written** (table `audit_logs`) by all SQL write functions; no viewer exists. Notifications: dashboard + email (DEC-017), email provider not chosen.

## F-15 Design system and approved mockups

- Status: COMPLETE. Protection: **PROTECTED** (owner-approved direction).
- Files: `frontend/assets/css/tokens.css`, `docs/mockups/round-1.html`, `round-2.html`, `docs/design.md` section 1.8.
- Allowed: implementing the approved screens, small accessibility/visual fixes. Not allowed: changing the palette, fonts, or the A–D bubble motif without the owner's approval.

## F-16 Legacy v1 app (outside this repository)

- Status: DEPRECATED but live. Separate Supabase project (`Exam_Data_Base`, ref `dtrgbjqfnkjiengpvbym`), single class-XII exam, shared teacher password, no attempt limit. **Do not modify it** (DEC-015). Its 40 questions were copied into v2; its result data will be exported/archived at cutover (DEC-016). Known v1 problems: `docs/audit-v1.md`.
