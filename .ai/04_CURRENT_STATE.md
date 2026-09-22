# 04 CURRENT STATE

## Snapshot

| Item | Value |
|---|---|
| Last updated | 2026-09-21 |
| Last AI agent | Claude (Sonnet 5, claude.ai chat) |
| Development phase | Phase 2 (core), following `docs/design.md` section 5 (Phases 0 and 1 are done) |
| Current focus | TASK-006: import questions from Excel/CSV and pasted text |
| Branch model | **New as of this entry.** `main` = stable branch. `ai-development` = shared branch where Claude and Codex/GPT do normal work, one agent at a time. See `00_AI_RULES.md` section 12 and DEC-020. `ai-development` is **not yet stable enough to merge into `main`** — TASK-006 is mid-flight on it. |
| Current branch / commit | Work is on **`ai-development`**, commit `6f5c223` ("TASK-006 step 1: browser import parsers..."), branched from `main` at `46803f0`. `main` itself is unchanged and still points at `46803f0`. |
| Repository baseline | Delivered as git history `ad9b6d6` (media) → `b9b5001` (import backend, function not deployed) → `46803f0` (adds `.ai/`, `AGENTS.md`, `CLAUDE.md`, on `main`) → branch `ai-development` created from `46803f0` → `6f5c223` (import parsers, on `ai-development`). The agent could not read the private GitHub remote (no `origin` configured in its sandbox, and cloning asked for credentials), so it worked from its own local copy; **NEEDS VERIFICATION** that GitHub's `main` matches `46803f0` and that `ai-development` gets created there once the owner has pulled and pushed both branches |

## What was inspected to write `.ai/`

- All files of the repository copy (65 tracked files before `.ai/`), including code, tests, docs, workflow.
- The **live Supabase project**: migrations list, Edge Function list and versions, tables and RLS state, policies count, functions count, storage buckets, row counts, extensions.
- Test runs (2026-09-21, from the repository copy): backend `deno test` = 41 passed, 0 failed; Playwright suites (mocked network) all green: `teacher_e2e` 34 checks, `question_bank_e2e` 57, `question_editor_e2e` 75, `media_e2e` 29.
- No TODO/FIXME comments exist in the code (scan returned nothing).

## Live system facts (verified 2026-09-21)

| Item | Value |
|---|---|
| Tables | 22, all RLS on, 0 policies (public and storage schemas) |
| Public SQL functions | 25 |
| Migrations applied | `v2_01` .. `v2_12` (12) |
| Edge Functions | `auth-me` v1, `question-bank` **v2**, `media` v1; all ACTIVE, `verify_jwt=false` |
| Storage | bucket `question-media`, private, 10 MB limit |
| Data | 40 questions (0 archived), 5 passages, 13 topics, 0 media files, 0 exams, 0 sessions, 1 profile (admin), 4 audit rows |
| Auth users | 1 admin (email known to the owner; not repeated here). No teacher account |

## Drift between repository and live system (important)

| Area | Repository | Live | Consequence |
|---|---|---|---|
| `question-bank` | has actions `import_check`, `import` (`handler.ts`, `parse.ts`, tests) | version 2 **without** those actions | Deploying it (TASK-006 step 3) is required before the future import screen can work. Safe: it only adds actions |
| SQL migrations | none stored | `v2_01`..`v2_12` applied | Cannot rebuild the database from git (ISSUE-001) |
| Frontend | `APP_BUILD` = "Phase 2, images and audio" | not deployed | The owner runs it locally with `frontend/dev-server.py` |

## Recently completed work (newest first)

1. Import backend: SQL `find_similar_batch`, `import_questions` (live, tested); Edge code + tests (repo only).
2. Images and audio: bucket, SQL, `media` function (deployed), file picker, previews, tests. Not yet verified with real Storage.
3. Question editor, reading texts, question bank screens (live-verified basics by the owner).
4. Sign in, app shell, shared backend library, `auth-me`.
5. Database schema, dev Supabase project, migration of the 40 v1 questions (fingerprint-verified against v1).
6. Design document Draft 4, audit of v1, two rounds of approved mockups.

## Work in progress

- **TASK-006 Import questions**, on branch `ai-development`. Done: SQL backend (live, tested) and browser parsers for CSV, XLSX, and pasted text (`frontend/assets/js/teacher/import/`, 16 Deno unit tests passing — run with `--no-check`, see note in `05_TASK_QUEUE.md`). Remaining: the import screen (`#/questions/import`), wiring the parsers to it, a Playwright test, template files, and deploying `question-bank` v3.

## Pending work (see `05_TASK_QUEUE.md`)

Verify media upload live (TASK-007), store migrations in git (TASK-008), exams (TASK-009), then Phases 3–7.

## Blocked work

None formally blocked. TASK-007 needs the owner to run the app against real Supabase (an agent without access to it cannot verify). Any task needing a migration or function deployment is blocked for an agent without Supabase access (NEEDS VERIFICATION which agents have it).

## What the owner has verified live

- Signing in with the admin account works (`Welcome`, connection check).
- The question bank shows the 40 migrated questions; add/edit editor opens and works after clearing a stale browser cache (old JS modules were cached; fixed by `dev-server.py`).
- Everything else about the editor beyond opening and basic add/edit is verified only by automated tests.

## Known regressions

None known. Automated suites were green at the last run.

## Current risks

1. Migrations only in the live project (ISSUE-001).
2. Media upload untested against real Storage (ISSUE-002).
3. GitHub sync is manual; two copies of the code can diverge (ISSUE-004).
4. Only backend tests run in CI; frontend browser tests do not (ISSUE-006).
5. v1 keeps serving real students with its known weaknesses (`docs/audit-v1.md`); owner decided not to patch it (DEC-015).

## Current priorities

1. Finish TASK-006 (import).
2. TASK-007 and TASK-008 (verification and reproducibility) as soon as the owner can run them.
3. TASK-009 (exams), which unblocks the student-facing phases.

## How SQL business rules were tested (technique)

Because the live database is the only database, SQL tests are `DO` blocks executed with the Supabase `execute_sql` tool that create data, assert results (including that invalid input is refused with the expected message and `validation` hint), and end with `RAISE EXCEPTION 'X_TESTS_PASSED'` so the whole transaction rolls back. A returned error message that starts with the pass marker means success and nothing persists. After such a run the row counts in "Live system facts" must be unchanged.
