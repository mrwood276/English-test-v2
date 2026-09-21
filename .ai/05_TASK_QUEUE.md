# 05 TASK QUEUE

Statuses: READY, IN_PROGRESS, BLOCKED, COMPLETED, PLANNED, CANCELLED. Priorities: CRITICAL, HIGH, MEDIUM, LOW.
Order follows dependencies. Completed tasks are listed at the end for history (all verifiable from git, migrations, or the design document).

## NEXT RECOMMENDED TASK

**TASK-006, step 2: import review screen and mocked browser test.**
Reason: step 1's dependency-free parser/validation modules and Deno tests are complete. The screen can reuse those modules and the existing question-bank page/router patterns without Supabase access.

---

## TASK-006 — Import questions from Excel/CSV and pasted text
- Priority: HIGH. Status: **IN_PROGRESS**. Feature: F-08.
- Description: Teachers add many questions at once: upload a `.xlsx`/`.csv` file, or paste text copied from Word. The browser parses and shows a review (ready / needs fixing / duplicate) before anything is saved; saving is all-or-nothing.
- Done so far: SQL `find_similar_batch`, `import_questions` (live, tested); Edge `parseImportItems`, `parseImportCheckItems`, actions `import_check` and `import`, unit tests (repository only).
- Relevant files: `backend/functions/question-bank/handler.ts`, `parse.ts`; `backend/tests/question_bank.test.ts`; future: `frontend/assets/js/teacher/import/*`, `screens/questionImport.js`, `api/questionBank.js`, `frontend/assets/templates/*`.
- Dependencies: F-05 editor rules (same validation rules), F-06 reading texts.
- Constraints: parsing happens in the browser with **no new dependencies** (DEC-007): write a small CSV parser (delimiter `,` `;` or tab), a minimal ZIP reader using `DecompressionStream("deflate-raw")` and an XML reader using `DOMParser` for `.xlsx`; only `.xlsx` and `.csv` (not `.xls`). Nothing is saved before the review is confirmed. Batch limit 200. Files (images/audio) cannot be imported.
- Server contract (already implemented):
  - `POST question-bank {action:"import_check", items:[{i, body, options:[text]}]}` → `{results:[{i, matches:[{id, body, similarity, exact, is_archived, used_in_exams}]}]}` (only rows with matches appear).
  - `POST question-bank {action:"import", items:[{row, type, body, difficulty, topic, weight, options:[{body,is_correct}], accepted_answers:[text], essay_guidance, explanation, class_labels:[text], passage?:{title, body?}}]}` → `{created, passages_created, ids}`. A problem returns HTTP 400 with `Row N: <message>` and nothing is saved.
- **PROPOSED formats (the owner has NOT reviewed them; show them clearly in the UI and ask if changes are wanted):**
  - Spreadsheet: first row = header, one question per row. Columns (case/spacing-insensitive, English and Indonesian aliases): `type` (optional: multiple_choice/true_false/short_answer/essay; inferred when blank), `question` (required), `option_a`..`option_f`, `correct` (letter for multiple choice; True/False for true/false; accepted answers separated by `|` for short answer), `guide` (essay), `explanation`, `topic`, `difficulty` (easy/medium/hots), `points`, `class` (labels separated by `,` `;` or `|`), `reading_text` (title) and `reading_text_body` (text; needed only when a text with that title does not exist yet; rows with the same title share one text).
  - Pasted text: questions separated by numbering (`1.` / `1)`) or blank lines; options `A.` / `A)` / `(A)` to F; correct answer by a line `Answer: B` (also `Key:`, `Jawaban:`, `Kunci:`) or by `*` after/before an option; meta lines `Topic:`, `Level:`/`Difficulty:`, `Points:`, `Class:`, `Explanation:`, `Type:`, `Guide:`, `Reading text: <title>`; reading text defined by blocks `[Reading text: Title] ... [/Reading text]`; no options + `Answer: True|False` = true/false; no options + other answer = short answer (accepted answers separated by `|`).
  - Defaults panel (class labels, topic, difficulty, points) applied to rows that leave them blank.
- Review screen: table with import checkbox, row number, question text, type, answer summary, status pills (Ready, Fix, Duplicate in bank, Duplicate in file, Similar) and messages. Rows with errors cannot be imported; exact duplicates are unchecked by default; similar ones are checked with a warning. "Import N questions" then goes back to the list with a toast. Unsaved review triggers the leave guard.
- Steps:
  1. **COMPLETED 2026-09-21 (Codex/GPT-5):** Parsers + row normalization + validation with Deno unit tests. Added `frontend/assets/js/teacher/import/{csv,zip,xlsx,text,rows,model}.js` and `frontend/tests/import.test.js`; 45 combined Deno tests passed. A Playwright test remains part of step 2 because no import screen exists yet.
  2. Import screen `#/questions/import`, route in `router.js`, "Import" button next to "Add question", API calls in `api/questionBank.js`, Playwright test with the mock server (extend `mock_server.py` with `import_check`/`import`).
  3. Deploy `question-bank` (repository code, includes import actions) — needs Supabase access; if unavailable mark this step BLOCKED.
  4. CSV and XLSX template files under `frontend/assets/templates/`, README updates, update `.ai/`.
- Acceptance criteria: the three input paths produce the same review model for equivalent content; every parse/validation problem names its row; a batch with any refused row saves nothing; duplicates within the file are detected; hostile HTML in cells is neutralized (server sanitizes, browser displays through `rich.js`); all suites green; template opens in Excel with correct characters (UTF-8).

## TASK-007 — Verify image/audio upload against real Supabase Storage
- Priority: HIGH. Status: READY (needs a human or an agent with browser + Supabase access). Feature: F-07. Issue: ISSUE-002.
- Description: Run the app, upload a large photo and an MP3, save, reopen the question, confirm the image and player load. Inspect the Network tab for the PUT to `.../storage/v1/object/upload/sign/question-media/...`.
- Relevant files: `frontend/assets/js/teacher/api/media.js` (`uploadToSignedUrl`), `backend/functions/media/handler.ts`.
- Acceptance: `media_files` gets rows; file appears in bucket `question-media`; viewing links work; a refused/oversized file is removed from Storage. If the PUT fails, compare with `@supabase/storage-js` `uploadToSignedUrl` and fix `media.js`; record the finding in `06_DECISIONS.md` if the protocol differs.
- Note: run `purge_unused` (admin) afterwards if test files were left unattached.

## TASK-008 — Store database migrations in the repository
- Priority: HIGH. Status: READY (needs Supabase access: `supabase db pull` or reading `supabase_migrations.schema_migrations`). Issue: ISSUE-001.
- Description: Export the SQL of `v2_01`..`v2_12` into `supabase/migrations/` (one file per migration, same order/names) so the database can be rebuilt from git.
- Acceptance: files match what is applied; `supabase/README.md` updated; `00_AI_RULES.md` section 8 rule is now satisfiable for future migrations.

## TASK-009 — Exams: create, edit, code, schedule, selection, templates
- Priority: HIGH. Status: PLANNED (after TASK-006). Feature: F-09.
- Description: SQL functions + Edge function `exams` + screens per mockup 11: title, duration, passing grade, mandatory exam code (auto-generated, editable, unique among open exams), manual or scheduled availability, late-start policy, selection manual or by filter (pool, draw per student), shuffle, 1 attempt, tab-switch limits 1/3/5 (warn/flag/auto-submit), result visibility, essay pending display, duplicate exam/template, open/close.
- Relevant: tables `exams`, `exam_questions`; `docs/design.md` BR-03..BR-06, BR-17; `_shared/codes.ts`; mockup `docs/mockups/round-2.html` (frame 11).
- Constraints: questions used by an exam are archived, not deleted (already implemented); business rules in SQL functions (DEC-004); audit inside functions.
- Acceptance: teacher can create and open an exam with a code; DB constraints hold; tests at SQL, Deno, and Playwright levels.

## TASK-010 — Export questions to PDF/Word — PLANNED, LOW priority
Depends on TASK-006 completion. Needs a decision on how to generate PDF/Word without new heavy dependencies (ask the owner).

## TASK-011 — Phase 3: student join and exam engine
- Priority: HIGH. Status: PLANNED (after TASK-009). Feature: F-11.
- Description: student app (`index.html`), join with name + class + code, 1 attempt (normalized) or remedial, sessions with a per-session snapshot and answer key kept server-side, server-enforced time with 2-minute tolerance (BR-20), autosave with offline queue (BR-12), submit + automatic grading, add time / reopen (BR-11), rate limiting of joins/code attempts (BR-21, `rate_limit_hit`), `timed_out` cleanup.
- Constraints: answer keys never leave the server (BR-09); sessions keep their own snapshot (BR-10).

## TASK-012 — Phase 4: grading, results, statistics, exports — PLANNED (mockups 13–15; BR-07, BR-08, BR-15, BR-18).
## TASK-013 — Phase 5: anti-cheating events and live monitor — PLANNED (design.md section 4; mockups 7–9, 12).
## TASK-014 — Phase 6: dashboard and UX polish — PLANNED (mockup 5 dashboard; mobile menu).
## TASK-015 — Phase 7: backups (manual + scheduled), audit log viewer, notifications (dashboard + email), scheduled purge jobs — PLANNED (D-06, D-13).

## TASK-016 — Create the teacher account and set display names
- Priority: MEDIUM. Status: READY (owner action + one SQL insert into `profiles`).
- Description: The owner creates the teacher in Supabase Auth (Auto Confirm), then a `profiles` row (role `teacher`) is inserted; the admin's `full_name` "Admin" is a placeholder awaiting the real name. A user-management screen is part of TASK-015.

## TASK-017 — Hosting and Auth URLs
- Priority: MEDIUM. Status: PLANNED (needs an owner decision). Choose static hosting for v2; then set the `ALLOWED_ORIGIN` function secret, Supabase Auth Site URL/redirect URLs (password reset), self-host or preload fonts (audit M-7).

## TASK-018 — Run frontend browser tests in CI
- Priority: LOW. Status: PLANNED. Issue: ISSUE-006. Add a GitHub Actions job that installs Playwright, runs `make_fixtures.py`, starts `dev-server.py 8123`, and runs the four suites.

## TASK-019 — v1 cutover
- Priority: LOW (after Phases 3–4). Status: PLANNED. Export v1 results (CSV/Excel) and archive (D-13), switch students to v2, retire v1. Nothing to do in v1 until then (D-15).

## TASK-020 — Duplicate overview banner in the question list
- Priority: LOW. Status: PLANNED. Mockup 6 shows "N questions look like duplicates"; needs a new action scanning the bank (`content_hash` groups and trigram pairs).

---

## COMPLETED (history)

| ID | Task | Evidence |
|---|---|---|
| TASK-001 | Requirements interview, design document (Draft 4), audit of v1, mockups rounds 1–2 (Phase 0) | `docs/` |
| TASK-002 | Phase 1 foundation: dev Supabase project, schema `v2_01`..`v2_07`, Supabase Auth admin account, shared backend library, `auth-me`, sign-in screen, migration of 40 v1 questions | migrations list, `backend/functions/_shared`, git `1d50148`, `c974be7` |
| TASK-003 | Question bank backend + list/preview screen | migration `v2_08`, `question-bank` function, `questionBank.js` |
| TASK-004 | Question editor + reading texts | `questionEditor.js`, `passageDialog.js`, tests |
| TASK-005 | Images and audio (built) | migrations `v2_09`..`v2_11`, `media` function, `mediaPicker.js`, git `ad9b6d6`; live verification pending (TASK-007) |
