# 04 CURRENT STATE

## Snapshot

| Item | Value |
|---|---|
| Last updated | 2026-09-22 (fifth session — owner supplied a Supabase access token) |
| Last AI agent | Buffy (Freebuff desktop agent; deployed live via the Supabase CLI with the owner's access token; token was session-only and not stored in the repo) |
| Development phase | Phase 2 (core), following `docs/design.md` section 5 (Phases 0 and 1 are done) |
| Current focus | Everything teacher-side is live: `question-bank` v3 (import actions live), the new `exams` function (whole flow live-verified with the admin account), exam SQL applied as the first migration in git (`supabase/migrations/20260922000000_exams_functions.sql`). Next milestone: TASK-010 student side. |
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
| Edge Functions | `auth-me` v1, `question-bank` **v2**, `media` v1; all ACTIVE, `verify_jwt=false` |
| Storage | bucket `question-media`, private, 10 MB limit |
| Data | 40 questions (0 archived), 5 passages, 13 topics, 0 media files, 0 exams, 0 sessions, 1 profile (admin), 4 audit rows |
| Auth users | 1 admin (email known to the owner; not repeated here). No teacher account |

## Live system facts (re-verified 2026-09-22, fifth session, via the CLI + admin sign-in)

- Anon REST read of `questions` → HTTP 401, `permission denied` (Postgres 42501) — the zero-policy lockdown holds on the live data (re-checked).
- Tokenless calls to `question-bank` **and** `exams` → HTTP 401, body exactly `"Please sign in."` — the in-code auth wall works in production for both functions.
- Anon `storage/v1/bucket` list → `"Bucket not found"` — the private `question-media` bucket leaks nothing (unchanged).
- CORS preflight from `http://localhost:8000` → `Access-Control-Allow-Origin: *` — the `ALLOWED_ORIGIN` secret is not set (expected until hosting exists; TASK-017).
- `auth/v1/settings` → **email sign-ups are still ENABLED** (checked in the third session; the owner has not flipped it yet — ISSUE-007).
- Admin sign-in via the API works (HTTP 200, `expires_in` 3600); `profiles` has exactly one row (admin, `is_active`).
- Live schema facts discovered while applying the exam SQL: `exams.status`/`availability_mode`/`late_start_policy`/`selection_mode`/`result_visibility`/`essay_pending_display` are Postgres **enums**; `exam_questions.position` has `CHECK (position > 0)` + deferred `UNIQUE (exam_id, position)`; `exams.access_code` has `CHECK (^[A-Z0-9]{4,12}$)`; `auto_filter` is NOT NULL default `'{}'`. Full list in `docs/sql-exams.md`.

## Drift between repository and live system (important)

| Area | Repository | Live | Consequence |
|---|---|---|---|
| `question-bank` | has actions `import_check`, `import` (`handler.ts`, `parse.ts`, tests) | version 2 **without** those actions | Deploying it (TASK-006 step 3) is now the **only** thing between the finished import screen and a working feature: the screen calls the actions and fails with "Nothing was saved" until they are live. Safe: it only adds actions |
| `exams` | full handler + parser + 24 Deno tests; screens list + editor | **v1 live** (deployed 2026-09-22); SQL functions applied live; whole flow live-verified with the admin account (save/get/list/update/open/code-rules/duplicate/remove + refusals + 401 wall) | The exam screens work against the real backend; student join is TASK-010 |
| `question-bank` | has actions `import_check`, `import` | **v3 live** (deployed 2026-09-22); `import_check` answered live, `list` regression-checked | The import screen works against the real backend; left: owner format review + a real Excel file check |
| SQL migrations | first migration in git: `supabase/migrations/20260922000000_exams_functions.sql` (applied live) | `v2_01`..`v2_12` + the exams functions | ISSUE-001 partially closed; `supabase db pull` can bring the older ones in |
| Frontend | `APP_BUILD` = "Phase 2, question import" | not deployed | The owner runs it locally with `frontend/dev-server.py` |

## Recently completed work (newest first)

1. **TASK-009 teacher-side exams (2026-09-22)**: `exams` Edge Function (list/get/save/remove/set_status/regenerate_code/check_code/duplicate) with 24 Deno tests; exams list screen (filters, open/close, duplicate, delete) and exam editor (manual/auto selection, schedule, live code uniqueness check, shuffle, 1/3/5 tab limits, result visibility, summary, leave guard, templates); routes + live Exams menu; mock-server handlers; `exams_e2e.py` (25 checks); SQL reference `docs/sql-exams.md` **not yet run live**.
2. **TASK-006 steps 1–2, import browser work is done**: the import screen `#/questions/import` (file or paste → defaults → review table with statuses → all-or-nothing import), wired into the router and the question bank; zip/xlsx readers now tested against a real .xlsx fixture (ISSUE-013 closed); template files under `frontend/assets/templates/`; new Playwright suite `question_import_e2e.py` (43 checks). Verified only against the mock server — see the XLSX and live caveats below.
2. Import parsers for CSV, XLSX, and pasted text with 21 Deno unit tests.
3. Import backend: SQL `find_similar_batch`, `import_questions` (live, tested); Edge code + tests (repo only, not deployed).
4. Images and audio: bucket, SQL, `media` function (deployed), file picker, previews, tests. Not yet verified with real Storage.
5. Question editor, reading texts, question bank screens (live-verified basics by the owner).
6. Sign in, app shell, shared backend library, `auth-me`.
7. Database schema, dev Supabase project, migration of the 40 v1 questions (fingerprint-verified against v1).
8. Design document Draft 4, audit of v1, two rounds of approved mockups.

## Work in progress

- **TASK-009 Exams**, on branch `ai-development`: teacher side built and mock-tested. Remaining: run `docs/sql-exams.md` on the live project, deploy the `exams` function, live-verify create + open + join; then the student side is TASK-010.
- **TASK-006 Import questions**, on branch `ai-development`: browser work complete (parsers, screen, tests, templates). Remaining: step 3 — deploy `question-bank` with the import actions (needs Supabase access, else BLOCKED) and step 4 — show the owner the proposed file formats before calling the feature done for teachers.

## Pending work (see `05_TASK_QUEUE.md`)

Verify media upload live (TASK-007), store migrations in git (TASK-008), exams (TASK-009), then Phases 3–7.

## Blocked work

TASK-006 step 3 (deploy `question-bank` v3) is BLOCKED for an agent without Supabase access — this agent has none. TASK-007 needs the owner to run the app against real Supabase. Any task needing a migration or function deployment is blocked for an agent without Supabase access.

## What the owner has verified live

- Signing in with the admin account works (`Welcome`, connection check).
- The question bank shows the 40 migrated questions; add/edit editor opens and works after clearing a stale browser cache (old JS modules were cached; fixed by `dev-server.py`).
- Everything else about the editor beyond opening and basic add/edit is verified only by automated tests.

## Known regressions

None from this session. One pre-existing environment quirk was found and left alone: `media_e2e.py` expects the generated `small.png` fixture to be exactly 467 bytes, but the installed Pillow writes 468 bytes, so that single check fails locally after running `make_fixtures.py`. It is unrelated to the import work (media code untouched). See `09_KNOWN_ISSUES.md` ISSUE-014 for the exact description.

## Current risks

1. Migrations only in the live project (ISSUE-001).
2. Media upload untested against real Storage (ISSUE-002).
3. GitHub sync is manual; two copies of the code can diverge (ISSUE-004).
4. v1 keeps serving real students with its known weaknesses (`docs/audit-v1.md`); owner decided not to patch it (DEC-015). (ISSUE-006 — frontend not in CI — was closed on 2026-09-22 by TASK-018; the new workflow's first real run still needs to be watched.)

## Current priorities

1. TASK-006 step 3: deploy `question-bank` v3 (owner or an agent with **v2** Supabase access) — then the import screen actually works. Note: the URL/key the owner sent on 2026-09-22 point at the v1 project (`dtrgbjqfnkjiengpvbym`), which must not be touched (DEC-015); v2 access (`lbhnadqmokloyfarrzfv`) is what this needs.
2. Owner reviews the proposed import file formats (see TASK-006 in `05_TASK_QUEUE.md`); the screen ships an example and templates that match them.
3. Check the first CI run of `.github/workflows/frontend-tests.yml` (TASK-018) after this push.
4. TASK-007 and TASK-008 (verification and reproducibility) as soon as the owner can run them.
5. TASK-009 (exams), which unblocks the student-facing phases.

## How SQL business rules were tested (technique)

Because the live database is the only database, SQL tests are `DO` blocks executed with the Supabase `execute_sql` tool that create data, assert results (including that invalid input is refused with the expected message and `validation` hint), and end with `RAISE EXCEPTION 'X_TESTS_PASSED'` so the whole transaction rolls back. A returned error message that starts with the pass marker means success and nothing persists. After such a run the row counts in "Live system facts" must be unchanged.
