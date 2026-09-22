# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## Branch Context (read this first)

| | |
|---|---|
| Stable Branch | `main` — currently at commit `46803f0`. Not the workspace; do not commit normal work here. |
| Current Development Branch | **`ai-development`** — branched from `main` at `46803f0`, now includes the import-parser commit `6f5c223` plus this `.ai/` update. This is where you work. |
| Merged into `main`? | **No.** `ai-development` is mid-task (TASK-006) and is not stable enough to merge yet. Do not merge it yourself; that is the owner's deliberate decision (DEC-020). |

Before doing anything: `git checkout ai-development` (or confirm you're on it), `git pull` to get the latest, `git log --oneline -5` and `git status` to see exactly what is there — another agent may have pushed since this entry was written.

## Last Agent
Claude (Sonnet 5, claude.ai chat, with sandbox + Supabase connector; no direct GitHub push/pull to the real remote — see DEC-018).

## Date
2026-09-21

## Last Completed Task
- **TASK-005** Images and audio (built and tested with mocked Storage; real upload unverified -> TASK-007). Merged onto `main` (commit `ad9b6d6`).
- **TASK-006 backend half** (SQL + Edge Function code for import, not deployed). Merged onto `main` (commit `b9b5001`).
- Creation of the `.ai/` system (commit `46803f0`, on `main`).
- **TASK-006 step 1**: browser import parsers (CSV, XLSX, pasted text) with 16 unit tests. Done on the **new branch `ai-development`** (commit `6f5c223`) - this is genuinely in-progress work and was not merged to `main`.
- **This Git branch workflow itself** (`main` + `ai-development` split, this `.ai/` update) - also on `ai-development`, committed in this session (see "What Was Changed" below; check `git log` for the exact commit hash).

## What Was Changed (this session)
1. Created branch `ai-development` from `main` (`46803f0`); `main` itself untouched.
2. Committed the in-progress import parsers onto `ai-development` (they were uncommitted local work at the time; per the branch-workflow request, ongoing dev work belongs on `ai-development`, not `main`):
   - `frontend/assets/js/teacher/import/{rules,csv,zip,xlsx,text,rows}.js`
   - `frontend/tests/unit/import.test.ts` (16 Deno tests)
3. Updated `.ai/00_AI_RULES.md` (new section 12 "Git branch workflow"; renumbered the old section 12->13, 13->14; one line added to the environment-facts table), `.ai/02_ARCHITECTURE.md` (short "Source control" note before "Overview"), `.ai/03_FEATURES.md` (F-08 status/detail updated for the parsers and the XLSX test gap), `.ai/04_CURRENT_STATE.md` (branch/commit fields, work-in-progress note), `.ai/05_TASK_QUEUE.md` (TASK-006 step 1 marked mostly done, XLSX test gap called out, "next recommended task" moved to step 2), `.ai/06_DECISIONS.md` (DEC-020), `.ai/07_CHANGELOG.md` (two new entries: the parsers, and the branch workflow), `.ai/09_KNOWN_ISSUES.md` (ISSUE-013: XLSX reader untested), this file.
4. No `.ai/` file was replaced or redesigned; only these targeted edits were made, per the request.

## Files Changed (repository, this session)
- New: `frontend/assets/js/teacher/import/rules.js`, `csv.js`, `zip.js`, `xlsx.js`, `text.js`, `rows.js`, `frontend/tests/unit/import.test.ts`.
- Edited: `.ai/00_AI_RULES.md`, `.ai/02_ARCHITECTURE.md`, `.ai/03_FEATURES.md`, `.ai/04_CURRENT_STATE.md`, `.ai/05_TASK_QUEUE.md`, `.ai/06_DECISIONS.md`, `.ai/07_CHANGELOG.md`, `.ai/09_KNOWN_ISSUES.md`, `.ai/08_HANDOFF.md` (this file).

## Database Changes
None this session. (Live database still at migration `v2_12_import_questions`; still not stored in git - ISSUE-001.)

## Current State (what works)
- Everything recorded in earlier hand-offs still holds: sign-in, question bank, editor, media (built; live upload unverified) all work per `03_FEATURES.md`.
- New this session: import parsers (`rules`, `csv`, `rows`, `text.js`) are unit-tested and correct as far as tests can show. `zip.js`/`xlsx.js` are **untested and unverified** (ISSUE-013) - do not assume XLSX import works until that is fixed.
- Nothing from this session is deployed or wired into the running app; it is inert code + tests + docs until TASK-006 step 2 wires it up.
- Test commands still work exactly as documented in `00_AI_RULES.md` section 7, plus: `deno test --allow-env --no-check frontend/tests/unit/` for the new import parser tests (the `--no-check` is needed for a couple of type-inference issues in the test file itself, not the parser code - see TASK-006 in `05_TASK_QUEUE.md`).

## Remaining Work
TASK-006 steps 2-4 (import screen, deploy `question-bank` v3, templates) plus closing ISSUE-013 (test `zip.js`/`xlsx.js` against a real file), then TASK-007/008/009 and later phases (`05_TASK_QUEUE.md`).

## Known Problems
See `09_KNOWN_ISSUES.md`. Most important: ISSUE-001 (no migrations in git), ISSUE-002 (media upload never run against real Storage), ISSUE-003 (deployed code behind repository), ISSUE-004 (manual GitHub sync - now also applies per-branch: verify both `main` and `ai-development` reach GitHub), ISSUE-013 (new: XLSX reader untested).

## Recommended Next Task
**TASK-006 step 2** - build the import screen (`#/questions/import`) wired to the parsers already in `frontend/assets/js/teacher/import/`. Do this on `ai-development`.

## Suggested Work For Next AI
1. `git checkout ai-development && git pull`. Read `.ai/00_AI_RULES.md` (including the new section 12), then this file, then `05_TASK_QUEUE.md` TASK-006.
2. Run `deno test --allow-env backend/tests/` (expect 41 passed) and `deno test --allow-env --no-check frontend/tests/unit/` (expect 16 passed) to confirm your environment matches this hand-off.
3. Either close ISSUE-013 first (add tests for `zip.js`/`xlsx.js`, ideally against a real small `.xlsx` file) or build the import screen and come back to it - your judgment, but do not ship the screen to the owner as "done" while XLSX is still unverified; say so if you skip it.
4. For the screen: a route `#/questions/import` in `router.js`, a button next to "Add question" in `questionBank.js`, a review table (see the "Review screen" description in TASK-006) reusing `questionView.js`/`plainText` for display, `api/questionBank.js` gaining `importCheck`/`import` calls to the (still undeployed) `question-bank` actions, and a Playwright test extending `frontend/tests/mock_server.py` with `import_check`/`import` handlers.
5. Do not deploy `question-bank` or change its contract without recording it in `.ai/`. If you cannot deploy Edge Functions from your environment, finish the screen against the mock server and mark the deploy step `BLOCKED` in `05_TASK_QUEUE.md`.
6. Show the owner the proposed import formats (spreadsheet columns, pasted-text syntax - both described in TASK-006) before treating them as final; the owner has not reviewed them yet.
7. After your work: test, update `.ai/` (state, task queue, changelog, this file - including the branch/commit fields at the top), commit on `ai-development`, and push (or hand off the branch if you cannot push directly).

## Do NOT Do
- Do not work directly on `main`. Normal work happens on `ai-development` (section 12 of `00_AI_RULES.md`).
- Do not merge `ai-development` into `main` yourself; that is a deliberate owner decision, not something to do as part of finishing a task.
- Do not force-push, reset `--hard`, or delete either branch.
- Do not rebuild the question editor, question bank, media picker, sign in, or the router (F-02, F-04..F-07 are done).
- Do not add a second way to save questions or a second staff-auth mechanism.
- Do not replace Supabase, add a frontend framework/bundler, or add npm dependencies to the frontend.
- Do not add RLS policies or grants to `anon`/`authenticated`; do not query tables from the browser.
- Do not touch the v1 project (`Exam_Data_Base`) or its repository/hosting.
- Do not change the text normalization/hash rule in only one language.
- Do not change the visual system (tokens, fonts, bubble motif) without the owner's approval.
- Do not push secrets. Do not "fix" the `Admin` placeholder name or create accounts without the owner's request.
- Do not mark features or tests as done without stating how they were verified - the XLSX gap in this very hand-off (ISSUE-013) is the example to follow: it was built, but is explicitly flagged as untested rather than assumed to work.

## If Next AI Cannot Complete The Task
1. Stop rather than guessing.
2. Document the blocker.
3. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md` (including the branch/commit fields).
5. Continue with another `READY` task if appropriate (TASK-007/008 need Supabase access; TASK-018 needs only the repository). Stay on `ai-development` unless the task explicitly requires otherwise.
