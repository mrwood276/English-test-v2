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

## ISSUE-013 — Import: the XLSX (Excel) reader had no tests and had never read a real file
- Severity: MEDIUM. Status: **FIXED (2026-09-22) with one remaining caveat**. Branch: `ai-development`. Related: TASK-006.
- What was done: `frontend/tests/unit/import.test.ts` gained 5 tests for `zip.js` and `xlsx.js` against `frontend/tests/unit/fixtures/import-sample.xlsx` — a real OOXML package (OPC zip, deflate, rich-text shared strings, inline strings, boolean and decimal cells, skipped columns) built by the committed `frontend/tests/unit/make_xlsx_fixture.py` (Python `zipfile`, no dependencies). The browser suite `question_import_e2e.py` uploads the same file through the real file picker. Writing the tests caught and fixed a real fixture bug (malformed XML that the lenient test DOM accepted and the browser refused).
- Remaining caveat (NEEDS_VERIFICATION, LOW): the fixture still was not produced by Excel or Google Sheets themselves. Before telling teachers that spreadsheet import works, open one real Excel-saved file (and ideally a Google Sheets export) through the import screen once — TASK-007-style, needs a human with the app running.

## ISSUE-014 — Pre-existing test-environment quirks in `media_e2e.py`
- Severity: LOW. Status: **FIXED (2026-09-22)**. Related: TASK-018.
- What was wrong: (1) `make_fixtures.py` wrote to a literal `/tmp/media_fixtures`, which Windows Python resolves unpredictably (drive-relative `D:\tmp`), so fresh clones could hit `FileNotFoundError`; (2) `media_e2e.py` asserted the generated `small.png` as exactly 467 bytes while the installed Pillow writes 468.
- What was done: a shared `frontend/tests/fixtures_dir.py` (uses `tempfile.gettempdir()`, override with `MEDIA_FIXTURES_DIR`) is now used by `make_fixtures.py` and `media_e2e.py`; the size check compares against the file's real size on disk instead of a hard-coded number; `media_e2e.py` exits with a friendly message when the fixtures have not been generated. All 29 media checks pass on Windows after regenerating fixtures. The root cause (Pillow's byte-exact output varying by version) remains version-dependent by nature, but the test no longer depends on it.

## ISSUE-016 — Rare flake in `question_editor_e2e.py`: session-expired notice read before its text is set
- Severity: LOW. Status: **FIXED (2026-09-22)**.
- Description: the last check of the editor suite clicked Save with a 401-forcing mock, waited only for the `.login` selector, then read the notice text — which can be filled a tick later, so an occasional run failed "an ended session while saving goes back to sign in" (observed once during CI-sequence simulation on 2026-09-22).
- Fix: the test now `wait_for_function`s for the notice text itself before asserting. Three consecutive full-suite runs pass.

## ISSUE-015 — Two parallel implementations of the TASK-006 import screen exist (`main` by Codex, `ai-development` by Buffy)
- Severity: MEDIUM (process), resolved by DEC-021. Status: **RESOLVED-BY-DECISION (2026-09-22)**; the file divergence persists until the next deliberate merge.
- Description: Codex/GPT-5 committed its own TASK-006 step 1+2 directly to `main` on 2026-09-21 (commits `d21f82d` parser layer with a new `import/model.js`, `1606aed` screen, `9c293fc` tests; 4 parser tests in `frontend/tests/import.test.js`, a 17-line e2e) while Claude's independent step-1 parsers (`6f5c223`) and Buffy's step-2 screen live on `ai-development` with different file contents. Each side's handoff described a stale `main`, which is why nobody noticed. Root causes: Codex worked directly on `main` before DEC-020 was pushed, and both agents trusted the handoff instead of re-reading the remote (violating `00_AI_RULES.md` section 12 rule 4).
- Resolution: the owner decided (2026-09-22, DEC-021) that `ai-development`'s implementation is the one that continues; Codex's `main` commits stay untouched and will be superseded file-by-file at the next deliberate merge of `ai-development` into `main`.
- What the next merge must do: resolve conflicts on the files listed in DEC-021 in favor of `ai-development`, and delete `frontend/tests/import.test.js` + `frontend/assets/js/teacher/import/model.js` (main-only files of the superseded variant) unless the owner says otherwise.
- Prevention: agents must `git fetch` and diff the actual remote before starting work — a handoff (even `.ai/`) is never proof that the remote has not moved (source-of-truth hierarchy, `00_AI_RULES.md` section 0).

## Legacy v1 issues (outside this repository; not being fixed, DEC-015)
Summarized from `docs/audit-v1.md`: server does not enforce exam time (H-1); no attempt limit or open/close/code (H-2); teacher password stored plaintext, no login throttling (H-3); token signing secret hard-coded in function code (H-4); no server-side validation of name/class and no rate limit on session creation (H-5); answers only in browser storage until submit (M-1); duplicate result rows possible (M-2). These disappear when v2 replaces v1.
