# 03 FEATURES

Feature registry. Status values: COMPLETE, STABLE, PARTIAL, IN_PROGRESS, BLOCKED, PLANNED, DEPRECATED.
Protection values: PROTECTED (no casual rewrite), STABLE (modify carefully), ACTIVE (under development), EXPERIMENTAL (unfinished).
Verification (see `00_AI_RULES.md` section 7): LIVE-VERIFIED, TESTED, UNVERIFIED.

Requirement IDs (BR-xx, D-xx) refer to `docs/design.md`.

## Summary table

| # | Feature | Status | Protection | Verification |
|---|---|---|---|---|
| F-01 | Database schema (22 tables, 25 functions) | COMPLETE for Phases 1–2 (exam/session tables unused) | PROTECTED | TESTED (SQL) |
| F-02 | Staff authentication and roles | COMPLETE | PROTECTED | LIVE-VERIFIED (owner signed in) |
| F-03 | Teacher/admin app shell, router, dashboard | COMPLETE (dashboard is a placeholder) | STABLE | LIVE-VERIFIED (shell), dashboard minimal |
| F-04 | Question bank: list, filters, preview, archive, delete | COMPLETE | STABLE | LIVE-VERIFIED (40 questions shown), rest TESTED |
| F-05 | Question editor (4 types, labels, topics, duplicate warnings, preview, unsaved guard) | COMPLETE | STABLE | LIVE-VERIFIED (add/edit opened and worked per owner), rest TESTED |
| F-06 | Reading texts (passages) | COMPLETE | STABLE | TESTED; at least one created live |
| F-07 | Images and audio for questions and reading texts | PARTIAL (built; real Storage upload never run) | ACTIVE | TESTED (mocked); **UNVERIFIED live** |
| F-08 | Import questions from Excel/CSV and pasted text | IN_PROGRESS | ACTIVE | DB functions TESTED; rest not built |
| F-09 | Exams (create, exam code, schedule, selection, templates) | PLANNED | – | – |
| F-10 | Export questions to PDF/Word | PLANNED | – | – |
| F-11 | Student join and exam engine | PLANNED | – | – |
| F-12 | Essay grading, results, statistics, exports | PLANNED | – | – |
| F-13 | Anti-cheating events and live monitor | PLANNED | – | – |
| F-14 | Audit log viewer, backups, notifications, user management | PLANNED | – | – |
| F-15 | Design system and approved mockups | COMPLETE | PROTECTED | Owner-approved |
| F-16 | Legacy v1 app (outside this repo) | DEPRECATED (live, untouched) | – | – |

---

## F-01 Database schema

- Status: COMPLETE for Phases 1–2. Protection: **PROTECTED**.
- Description: 22 tables + 25 functions + storage bucket, as listed in `02_ARCHITECTURE.md`. Tables for exams, sessions, answers, grades, results, events, retake permissions, backups, class aliases, app settings exist but no code uses them yet.
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
- Behavior: left menu (Dashboard, Question bank; Exams, Grading, Results shown as "Soon"), hash routes, build label at the bottom of the menu (`APP_BUILD` in `config.js`).
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

- Status: **IN_PROGRESS**. Protection: ACTIVE.
- Done: SQL functions `find_similar_batch` and `import_questions` (migration `v2_12`, applied to the live database and tested with rolled-back DO blocks: all-or-nothing, "Row N:" messages, reading texts matched by normalized title, limit 200). Edge code `parseImportItems`, `parseImportCheckItems`, and actions `import_check` / `import` in `backend/functions/question-bank/` with unit tests (41 backend tests pass).
- **Not deployed:** the live `question-bank` function is version 2 and does not have the import actions.
- **Not built:** browser parsers (CSV, XLSX, pasted text), the import screen, template files, browser tests.
- Planned design (PROPOSED by Claude; the owner has not reviewed the file formats): see `05_TASK_QUEUE.md` TASK-006.

## F-09 Exams

- Status: PLANNED. Tables exist (`exams`, `exam_questions`, `retake_permissions`). Requirements: `docs/design.md` BR-03..BR-06, BR-11, mockup 11 ("New exam") in `docs/mockups/round-2.html`. Helpers ready: `backend/functions/_shared/codes.ts` (exam code generation, unused so far).
- Do not create a second exam-settings mechanism; v1's single `exam_settings` row is intentionally replaced by the `exams` table.

## F-10 Export questions to PDF/Word — PLANNED (`docs/design.md` section 1.4 lists it as [PENTING], Phase 2; not started).

## F-11 Student join and exam engine — PLANNED

Name + class + code, 1 attempt (normalized), late-start policy, server time enforcement (BR-20), autosave with offline queue (BR-12), submit and automatic grading, remedial, add time. Helpers ready but unused: `_shared/ratelimit.ts` + SQL `rate_limit_hit`.

## F-12 Grading, results, statistics, exports — PLANNED (BR-07, BR-08; mockups 13–15).

## F-13 Anti-cheating and live monitor — PLANNED (design.md section 4; tables `session_events`).

## F-14 Audit log viewer, backups, notifications, user management — PLANNED

Audit entries are already **written** (table `audit_logs`) by all SQL write functions; no viewer exists. Notifications: dashboard + email (DEC-017), email provider not chosen.

## F-15 Design system and approved mockups

- Status: COMPLETE. Protection: **PROTECTED** (owner-approved direction).
- Files: `frontend/assets/css/tokens.css`, `docs/mockups/round-1.html`, `round-2.html`, `docs/design.md` section 1.8.
- Allowed: implementing the approved screens, small accessibility/visual fixes. Not allowed: changing the palette, fonts, or the A–D bubble motif without the owner's approval.

## F-16 Legacy v1 app (outside this repository)

- Status: DEPRECATED but live. Separate Supabase project (`Exam_Data_Base`, ref `dtrgbjqfnkjiengpvbym`), single class-XII exam, shared teacher password, no attempt limit. **Do not modify it** (DEC-015). Its 40 questions were copied into v2; its result data will be exported/archived at cutover (DEC-016). Known v1 problems: `docs/audit-v1.md`.
