# 09 KNOWN ISSUES

Statuses: OPEN, INVESTIGATING, BLOCKED, FIXED, WONT_FIX, NEEDS_VERIFICATION. Only issues that are real or explicitly uncertain are listed.

## ISSUE-001 — Database migrations are not stored in git
- Severity: HIGH. Status: OPEN. Related: TASK-008.
- Description: the SQL of `v2_01`..`v2_12` exists only in the live Supabase project. The database cannot be rebuilt from the repository, and Codex/GPT cannot see the schema in code.
- Affected: `supabase/`. Workaround: read the schema from the live project (`list_tables`, `pg_proc`, `supabase_migrations.schema_migrations`). Investigation: `supabase db pull`.

## ISSUE-002 — Real image/audio upload has never been run
- Severity: HIGH. Status: NEEDS_VERIFICATION. Related: TASK-007, F-07.
- Description: 0 rows in `media_files`. The upload protocol was reproduced from `@supabase/storage-js` 2.116 source; tests use a mocked Storage. Live failures are possible (headers, multipart field naming, CORS, size limits).
- Affected: `frontend/assets/js/teacher/api/media.js`, `backend/functions/media/handler.ts`.

## ISSUE-003 — Deployed `question-bank` is behind the repository
- Severity: MEDIUM. Status: OPEN. Related: TASK-006 step 3.
- Description: live version 2 lacks `import_check` / `import`. Harmless until the import screen exists; deploying is additive.

## ISSUE-004 — Repository sync is manual
- Severity: MEDIUM. Status: OPEN.
- Description: Claude in chat cannot push or pull; the GitHub copy can differ from the agent's copy (the agent could not inspect the private remote when `.ai/` was written). Any change the owner makes directly on GitHub or locally must be shared with the agent, otherwise changes may collide.
- Workaround: the owner runs `git pull <delivered folder> main` and pushes. Codex/GPT with git access should start with `git pull` and compare against `.ai/04_CURRENT_STATE.md`.

## ISSUE-005 — Leaked-password protection is disabled in Supabase Auth
- Severity: LOW. Status: NEEDS_VERIFICATION.
- Description: the Supabase security advisor reported it. UNKNOWN whether the current plan allows enabling it. Workaround: strong unique password for the admin and teacher accounts.

## ISSUE-006 — Only backend tests run in CI
- Severity: LOW. Status: OPEN. Related: TASK-018.
- Description: `.github/workflows/backend-tests.yml` runs Deno tests only. Browser tests (Playwright) are run manually and use a mocked server.

## ISSUE-007 — Supabase Auth signup setting is unverified
- Severity: MEDIUM. Status: NEEDS_VERIFICATION.
- Description: the owner was asked to disable public signups in the Supabase dashboard (so nobody can create accounts). Even if enabled, a new account has no `profiles` row and is refused by `requireStaff` (403), so data stays protected. UNKNOWN whether it was disabled.

## ISSUE-008 — Placeholder display name for the admin
- Severity: LOW. Status: OPEN. `profiles.full_name` is "Admin" (the owner did not give a name). There is no UI to change it.

## ISSUE-009 — Menu takes a lot of space on phones; dashboard is a placeholder
- Severity: LOW. Status: OPEN. Related: TASK-014. Teachers use laptops per the mockups; phone layout works without horizontal scroll (tested) but is not polished.

## ISSUE-010 — Question list lacks the duplicate-overview banner from the mockup
- Severity: LOW. Status: OPEN. Related: TASK-020.

## ISSUE-011 — No UI for reading-text management and file reordering
- Severity: LOW. Status: OPEN. Reading texts are only reachable through the editor's picker/dialog; `passage_remove` has no UI; files cannot be reordered (upload order is kept).

## ISSUE-012 — Orphan files and stale rate-limit rows are never purged automatically
- Severity: LOW. Status: OPEN. `purge_unused` (admin action of `media`) and SQL `purge_rate_limits` exist but nothing schedules them (Phase 7).

## Legacy v1 issues (outside this repository; not being fixed, DEC-015)
Summarized from `docs/audit-v1.md`: server does not enforce exam time (H-1); no attempt limit or open/close/code (H-2); teacher password stored plaintext, no login throttling (H-3); token signing secret hard-coded in function code (H-4); no server-side validation of name/class and no rate limit on session creation (H-5); answers only in browser storage until submit (M-1); duplicate result rows possible (M-2). These disappear when v2 replaces v1.
