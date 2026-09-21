# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## Last Agent
Claude (Sonnet 5, claude.ai chat, with sandbox + Supabase connector; no GitHub push tool).

## Date
2026-09-21

## Last Completed Task
- **TASK-005** Images and audio (built and tested with mocked Storage; real upload unverified → TASK-007).
- Then, in the same session and **not finished**: **TASK-006** Import questions (backend half done, see below).
- Then: creation of this `.ai/` system (no application behavior changed).

## What Was Changed (this session, after TASK-005)
1. Database (live project): migration `v2_12_import_questions` added `find_similar_batch(jsonb, real)` and `import_questions(jsonb, uuid)`. `import_questions` saves up to 200 questions in one transaction through `save_question`, resolves reading texts by normalized title (creating them when text is supplied), prefixes errors with `Row N:`, and writes one audit entry.
2. Edge code: `question-bank` gained actions `import_check` and `import`, plus `parseImportItems` / `parseImportCheckItems`; request size limit raised to 1 MB.
3. Tests: 5 new backend tests (41 total, all pass) and 8 SQL test groups (rolled back).
4. `.ai/` (10 files), `AGENTS.md`, `CLAUDE.md`, README pointer.

## Files Changed (repository)
- `backend/functions/question-bank/handler.ts`, `backend/functions/question-bank/parse.ts`, `backend/tests/question_bank.test.ts`
- `.ai/*` (new), `AGENTS.md` (new), `CLAUDE.md` (new), `README.md` (pointer added)

## Database Changes
- Applied live (not in git): `v2_12_import_questions` (two functions, revoked from public roles).
- No table changes. Migrations `v2_01`..`v2_12` are still **not stored in the repository** (ISSUE-001).

## Current State (what works)
- Verified by the owner live: sign in as admin; question bank list shows the 40 migrated questions; the editor opens and adding/editing works.
- Verified only by automated tests: everything else in `03_FEATURES.md` marked TESTED.
- **Deployed vs repository:** live `question-bank` is v2 (no import actions); repository code has them. `auth-me` v1 and `media` v1 match the repository.
- Frontend runs locally only (`python frontend/dev-server.py`).

## Remaining Work
TASK-006 steps 1–4 (browser parsers, import screen, deployment of `question-bank` v3, templates), then TASK-007/008/009 and later phases (`05_TASK_QUEUE.md`).

## Known Problems
See `09_KNOWN_ISSUES.md`. Most important: ISSUE-001 (no migrations in git), ISSUE-002 (media upload never run against real Storage), ISSUE-003 (deployed code behind repository), ISSUE-004 (manual GitHub sync).

## Recommended Next Task
**TASK-006 step 1** — pure-JS parsers with tests (details in `05_TASK_QUEUE.md`).

## Suggested Work For Next AI
1. Read `.ai/` in the order given in `00_AI_RULES.md`, then run `deno test --allow-env backend/tests/` (expect 41 passed) to confirm your environment.
2. Create `frontend/assets/js/teacher/import/` with small modules: `csv.js` (RFC-4180-style parser, detect `,` `;` tab, strip BOM), `zip.js` + `xlsx.js` (read the first sheet: shared strings, inline strings, numbers, empty cells), `text.js` (pasted-text format), `rows.js` (header aliases, normalization, type inference), `model.js` (validation that mirrors `public.save_question`: 2–6 options with exactly one correct for multiple choice, exactly 2 for true/false, 1–10 accepted answers for short answer, none for essay, points 0–100, ≤10 labels, difficulty easy/medium/hots). Pure modules must be importable in Deno for unit tests (no DOM); only the XLSX XML step may use `DOMParser`.
3. Output of the parsers = the draft shape used by the server (see the contract in TASK-006) plus `row`, and a per-row list of problems.
4. Reuse: `frontend/assets/js/shared/rich.js` (`plainText`) for displaying text; `questionView.js` for a per-row detail view; the mock server in `frontend/tests/mock_server.py` for tests (add `import_check` / `import`).
5. Do not deploy or change the server contract without recording it. If you cannot deploy Edge Functions, finish steps 1–2 and mark step 3 BLOCKED.
6. Show the owner the proposed formats (TASK-006) in the UI and ask if they want changes; do not silently change them.

## Do NOT Do
- Do not rebuild the question editor, question bank, media picker, sign in, or the router (F-02, F-04..F-07 are done).
- Do not add a second way to save questions or a second staff-auth mechanism.
- Do not replace Supabase, add a frontend framework/bundler, or add npm dependencies to the frontend.
- Do not add RLS policies or grants to `anon`/`authenticated`; do not query tables from the browser.
- Do not touch the v1 project (`Exam_Data_Base`) or its repository/hosting.
- Do not change the text normalization/hash rule in only one language.
- Do not change the visual system (tokens, fonts, bubble motif) without the owner's approval.
- Do not push secrets. Do not "fix" the `Admin` placeholder name or create accounts without the owner's request.
- Do not mark features COMPLETE without stating how they were verified.

## If Next AI Cannot Complete The Task
1. Stop rather than guessing.
2. Document the blocker.
3. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md`.
5. Continue with another `READY` task if appropriate (TASK-007/008 need Supabase access; TASK-018 needs only the repository).
