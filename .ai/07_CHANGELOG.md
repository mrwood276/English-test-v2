# 07 CHANGELOG

Newest first. Entries below the "Established" entry were reconstructed from git history and the live migration list only; nothing else is claimed.
Add a new entry for every meaningful change (what, files, database changes, verification).

## 2026-09-22 — CI for frontend tests (TASK-018) + test-environment fixes (ISSUE-014, editor flake) — git `ai-development`
- Agent: Buffy (Freebuff desktop agent, second session; direct git access, no Supabase access). Branch: `ai-development`.
- **TASK-018 / ISSUE-006**: new `.github/workflows/frontend-tests.yml` — job `unit` (Deno, the import parser tests incl. the xlsx fixture) and job `browser` (Python 3.12, Playwright + Chromium, Pillow; generates media fixtures, starts `dev-server.py 8123`, runs all five browser suites). ISSUE-006 closed, TASK-018 done pending the owner's first CI run on GitHub.
- **ISSUE-014 fixed**: new shared `frontend/tests/fixtures_dir.py` (`tempfile.gettempdir()`, override via `MEDIA_FIXTURES_DIR`) replaces the literal `/tmp/media_fixtures` in `make_fixtures.py` and `media_e2e.py`; the small-picture assertion now compares against the file's real size on disk (Pillow-version-proof); `media_e2e.py` exits with a clear message when fixtures are missing. All 29 media checks pass on Windows after `make_fixtures.py`.
- **Editor suite flake fixed** (ISSUE-016): the session-expired check now waits for the notice text itself instead of reading it right after `.login` appears (observed once during a full-sequence simulation; 3 consecutive runs pass after the fix).
- Owner sent a Supabase URL + publishable key during this session; they identify the **v1** project (`dtrgbjqfnkjiengpvbym` = `Exam_Data_Base`), not the v2 project (`lbhnadqmokloyfarrzfv` in `config.js`). Nothing was done with them (DEC-001/DEC-015: v1 is outside this repo and must not be touched; a publishable key cannot deploy v2 functions anyway). TASK-006 step 3 (deploy `question-bank` v3) stays BLOCKED for lack of v2 access.
- Database changes: none. Deployment: none.
- Verification: full local CI-sequence simulation in order (teacher → bank → editor → media → import) all pass; backend 41 and unit 21 still green; YAML structurally checked.

## 2026-09-22 — Import questions: screen, xlsx tests, templates (TASK-006 steps 1–2 complete) — git `ai-development` (see `git log` for the hash)

## 2026-09-22 — Import questions: screen, xlsx tests, templates (TASK-006 steps 1–2 complete) — git `ai-development` (see `git log` for the hash)
- Agent: Buffy (Freebuff desktop agent, direct git access to `origin`; no Supabase access). Branch: `ai-development`.
- **Import screen**: new `frontend/assets/js/teacher/screens/questionImport.js` and route `#/questions/import` (title "Import questions"); an "Import" button was added next to "Add question" in `screens/questionBank.js` (header actions wrapped in `.head-actions`). The screen: choose a `.xlsx`/`.csv` file or paste text (mutually exclusive, `Show an example` fills the pasted format), a defaults panel (class labels, topic with suggestions, difficulty, points) applied to rows that leave them blank, and a review table (row number, question text via `plainText`, type, answer summary, status pills Ready / Fix / Duplicate in bank / Duplicate in file / Similar, problem messages). Rows with problems cannot be selected; exact duplicates of bank questions and duplicates within the file start unchecked; select-all covers every row that can be imported (first click fills the gaps, second clears). `import_check` runs once per review over the rows the server can answer; a refused `import` (HTTP 400 `Row N: ...`) keeps the review open and says nothing was saved. An unsaved review triggers the leave guard; after a successful import the app returns to `#/questions` with a toast. Nothing is saved before the review is confirmed (DEC-014 unchanged).
- **ISSUE-013 closed**: `zip.js` and `xlsx.js` are now covered by 5 new Deno unit tests against `frontend/tests/unit/fixtures/import-sample.xlsx`, a real OOXML package (deflate ZIP written by Python's `zipfile`, shared strings with a rich-text run, inline strings, boolean and decimal cells, a skipped column) built by the committed `frontend/tests/unit/make_xlsx_fixture.py`. One fixture bug was found and fixed this way (a malformed `</rPr>` the lenient test DOM accepted but the browser refused). The unit tests set `globalThis.DOMParser` from `npm:linkedom` (dev-only, because Deno has no DOM); this is a test-environment dependency, not a frontend one (DEC-007 untouched). Run: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` (21 passed).
- **Mock server and browser tests**: `frontend/tests/mock_server.py` gained `import_check` (EXACT/similar matches) and `import` (appends questions, refuses bodies containing `FORCE_SERVER_ERROR` with `Row N: ...`) handlers; new `frontend/tests/question_import_e2e.py` covers the paste flow, statuses, default selection, select-all, the payload shape, a real `.xlsx` upload through the file picker, a refused batch, the leave guard, and the example button — 43 checks, all passing; **XLSX through the screen is now TESTED against the mock server, but still not against a real Excel file** (the fixture is hand-built to the OOXML spec; see ISSUE-013's remaining note).
- **Templates**: `frontend/assets/templates/import-template.xlsx` and `import-template.csv` (UTF-8 with BOM) with the recognized columns and example rows, generated by `frontend/assets/templates/make_import_template.py` (no dependencies; outputs committed); both are linked as downloads from the import screen; `frontend/assets/templates/README.md` explains regeneration. Both templates were parsed back through `readXlsxRows`/`parseCsv` as a sanity check.
- **Small additions**: `shared/icons.js` gained two fixed icons (`sheet`, `pencil`, same fixed-string pattern); `questions.css` gained the import styles (pick cards, defaults grid, review table rows, problem chips) using the existing tokens; `APP_BUILD` is now "Phase 2, question import"; `README.md` and `frontend/README.md` document the new route, files, and test commands.
- Database changes: **none** (schema and live functions unchanged). Nothing deployed.
- Verification: backend 41 passed; unit 21 passed; Playwright `teacher_e2e`, `question_bank_e2e`, `question_editor_e2e`, `question_import_e2e` all green; `media_e2e` 27 of 29 (two pre-existing fixture quirks, see ISSUE-014; media code untouched). Live behavior of the import actions is still unverified until `question-bank` v3 is deployed (TASK-006 step 3).
- **Collision found and resolved before push**: while preparing to push, this agent discovered that `origin/main` had moved past `46803f0` — Codex/GPT-5 had committed its own parallel import implementation directly to `main` on 2026-09-21 (`d21f82d`, `1606aed`, `9c293fc`), conflicting with the branch-workflow handoff. Per the owner's decision in the session (DEC-021, ISSUE-015): this `ai-development` implementation is the one that continues; Codex's `main` commits are left untouched and superseded at the next deliberate merge. The push below therefore goes only to `ai-development`, and `main` is not touched.

## 2026-09-21 — Git branch workflow introduced: `main` (stable) + `ai-development` (shared AI branch) — git `ai-development@6f5c223` (branch point `46803f0` on `main`)
- Agent: Claude (Sonnet 5, claude.ai chat), per the owner's explicit request.
- Created branch `ai-development` from `main` (`46803f0`). `main` is unchanged. In-progress uncommitted work at the time (the TASK-006 browser import parsers) was committed onto `ai-development` rather than `main`, since it is normal development work in progress, not a stable release (see the changelog entry below for what it contains).
- Updated `.ai/00_AI_RULES.md` (new section 12, "Git branch workflow," plus a note in the environment-facts table), `.ai/02_ARCHITECTURE.md` (short "Source control" note), `.ai/04_CURRENT_STATE.md` (branch/commit fields in the snapshot, work-in-progress note), `.ai/05_TASK_QUEUE.md` (TASK-006 now names its branch and marks step 1 done), `.ai/06_DECISIONS.md` (DEC-020), `.ai/08_HANDOFF.md` (branch fields and pull instructions). No existing `.ai/` file was replaced or restructured; only these targeted edits were made.
- Database changes: none. Application behavior: none.
- Verification: `git branch -a`, `git log --oneline` on both branches, and `git status` were checked before and after; the working tree was clean before starting and the only pending change (the import parsers) was intentionally committed onto `ai-development`, not lost. No push to GitHub was possible from this session (see DEC-018); the repository (both branches) is handed to the owner as before.

## 2026-09-21 — Import questions: browser parsers (TASK-006 step 1) — git `ai-development@6f5c223`
- Agent: Claude (Sonnet 5, claude.ai chat). Branch: `ai-development`.
- Added `frontend/assets/js/teacher/import/{rules,csv,zip,xlsx,text,rows}.js`: a CSV reader (delimiter detection, quoted fields, line numbers), a minimal ZIP reader (`DecompressionStream`, entry/size limits) and `.xlsx` sheet reader (shared strings, inline strings, numbers, booleans) built without new dependencies (per DEC-007), a pasted-text reader (numbered or blank-line-separated questions, lettered options, `Answer:`/`Kunci:`/`*` markers, meta lines, `[Reading text: ...]` blocks), and row/draft normalization mirroring the server's validation in `public.save_question`.
- Added `frontend/tests/unit/import.test.ts`, 16 Deno unit tests, all passing (run with `deno test --allow-env --no-check frontend/tests/unit/`; see the note on plain `deno test` type-checking in `05_TASK_QUEUE.md` TASK-006).
- Not yet wired to any screen; no route, no UI, nothing deployed. Database changes: none.
- Verification is uneven and must not be overstated: `rules.js`, `csv.js`, `rows.js`, and `text.js` are covered by the 16 unit tests (TESTED). **`zip.js` and `xlsx.js` have zero automated tests and have never been run against a real `.xlsx` file** — they are UNVERIFIED / UNTESTED. This is a gap, not a finished result; see `05_TASK_QUEUE.md` TASK-006 and `09_KNOWN_ISSUES.md` ISSUE-013.

## 2026-09-21 — AI memory and handoff system established
- Agent: Claude (Sonnet 5, claude.ai chat).
- Added `.ai/` (10 files), root `AGENTS.md` and `CLAUDE.md` (short pointers to `.ai/`), and a pointer paragraph in `README.md`.
- The repository was inspected first (code, tests, docs, workflow) and the live Supabase project was read (migrations, functions, tables, RLS, policies, storage, counts). `.ai/` reflects that state; uncertain items are marked UNKNOWN / NEEDS VERIFICATION.
- Included in the same delivery: the import backend work that was finished before this task (see next entry), committed separately.
- Database changes: none in this entry.
- Verification: backend tests 41 passed; all four Playwright suites passed (34, 57, 75, 29 checks); see `04_CURRENT_STATE.md`.

## 2026-09-21 — Import questions: backend half (TASK-006, IN_PROGRESS) — git `b9b5001`
- Database (applied to the live project, **not** in git): migration `v2_12_import_questions` → functions `find_similar_batch`, `import_questions`.
- Files: `backend/functions/question-bank/handler.ts` (actions `import_check`, `import`; request size limit 1 MB), `parse.ts` (`parseImportItems`, `parseImportCheckItems`), `backend/tests/question_bank.test.ts` (5 new tests).
- Not deployed: live `question-bank` is still version 2.
- Verification: SQL DO-block tests (8 groups, rolled back) passed; backend 41 tests passed.

## 2026-09-21 — Images and audio (TASK-005) — git `ad9b6d6`
- Database (live, not in git): migrations `v2_09_media_storage` (bucket `question-media`, `media_files` columns `original_name`, `duration_seconds`, functions `register_media`, `link_media`, `purge_orphan_media`, updated `save_question`, `save_passage`, `get_question`, `get_passage`), `v2_10_register_media_path_rule`, `v2_11_media_paths` (`get_media_paths`).
- Deployed: Edge Function `media` v1, `question-bank` v2 (accepts `media` lists).
- Frontend: `mediaPicker.js`, `imageCompress.js`, `api/media.js`, `questionView.js` media blocks, passage dialog files, styles; tests `media_e2e.py`, `media.test.ts`; `APP_BUILD` label updated.

## 2026-09-21 — Frontend repository commits — git `c974be7`, `1d50148`, `35d6561`
- `35d6561` project overview, design document, v1 audit, approved mockups.
- `1d50148` backend: shared library, `auth-me`, `question-bank`, `media` functions, unit tests.
- `c974be7` frontend: sign in, question bank, question editor, browser tests, dev server.
- (These commits were assembled at once from work done 2026-09-20/21; the finer history before them exists only in the chat.)

## 2026-09-20 — Foundation, question bank backend (live project, before the first commit)
- Migrations `v2_01_foundation` .. `v2_08_question_bank_functions` applied (schema, lockdown, content hash, text-rule fix, rate limit function, question bank functions).
- Edge Functions deployed: `auth-me` v1, `question-bank` v1 (later v2).
- 40 v1 questions migrated (fingerprint-verified against v1).
- Supabase project `English_Test_v2` created; admin account created by the owner in Supabase Auth; profile row inserted.
