# 09 KNOWN ISSUES

Statuses: OPEN, INVESTIGATING, BLOCKED, FIXED, WONT_FIX, NEEDS_VERIFICATION. Only issues that are real or explicitly uncertain are listed.

## ISSUE-001 — Database migrations are not stored in git
- Severity: HIGH. Status: **MOSTLY FIXED (2026-09-24)**. Related: TASK-008.
- Description: the SQL of `v2_01`..`v2_12` existed only in the live Supabase project. The database could not be rebuilt from the repository, and Codex/GPT could not see the schema in code.
- **Resolution (2026-09-24, Claude reviewer session)**: pulled the exact live SQL for `v2_01_foundation` through `v2_12_import_questions` from `supabase_migrations.schema_migrations` (via Supabase MCP — no CLI/DB-password access was available; `supabase link`/`db pull` fail in that sandbox because `api.supabase.com` isn't reachable there) and committed them verbatim as `supabase/migrations/20260920095357_v2_01_foundation.sql` through `20260921064042_v2_12_import_questions.sql`, matching the CLI's own `<version>_<name>.sql` convention and exact timestamps. `git` now has all 16 of the live project's tracked migrations end to end.
- **New discrepancy found while fixing this (not yet resolved)**: the reverse problem exists for three files already in git — `20260922000000_exams_functions.sql`, `20260923000000_session_functions.sql`, `20260924000000_result_functions.sql` (TASK-009/010/012) — **none of the three has a matching row in `supabase_migrations.schema_migrations`**, even though their content is confirmed live and working (tested extensively this session). They were evidently applied by direct DB access (CLI with a DB password, or the dashboard SQL editor) rather than through `supabase db push`, which is the only path that registers a migration. Practical risk is low — all three use `create or replace function` throughout, no bare `create table`/`create type`, so a future `supabase db push` would just no-op re-apply them rather than error — but `supabase migration list` will misreport them as "not applied remotely" until someone with a real DB connection inserts matching rows into `supabase_migrations.schema_migrations` (or runs a proper `supabase db push` once to register them). Low priority; flagging so the next agent doesn't waste time being confused by it.
- Affected: `supabase/`. The live project and `git` are now much closer, but still not byte-identical in tracking metadata — see the discrepancy above.

## ISSUE-002 — Real image/audio upload has never been run
- Severity: HIGH. Status: NEEDS_VERIFICATION. Related: TASK-007, F-07.
- Description: 0 rows in `media_files`. The upload protocol was reproduced from `@supabase/storage-js` 2.116 source; tests use a mocked Storage. Live failures are possible (headers, multipart field naming, CORS, size limits).
- Affected: `frontend/assets/js/teacher/api/media.js`, `backend/functions/media/handler.ts`.
- Partially verified live (2026-09-22, read-only): the private `question-media` bucket leaks nothing to anon (list_buckets says "Bucket not found"), and `rest/v1/questions` refuses anon reads with 401 `permission denied` (Postgres 42501) — the zero-policy lockdown holds. What still needs a human: an actual signed upload + playback through the app (TASK-007).

## ISSUE-003 — Deployed `question-bank` is behind the repository
- Severity: MEDIUM. Status: **FIXED (2026-09-22)**. Related: TASK-006 step 3.
- Description: live version 2 lacked `import_check` / `import`. Harmless until the import screen exists; deploying is additive.
- Resolution: **question-bank v3 deployed live on 2026-09-22** (via `npx supabase functions deploy question-bank --no-verify-jwt --use-api`). `import_check` verified live against the 40-question bank (answered `{"results":[]}` for a non-matching row — no more "Unknown action"), `list` regression-checked (total: 40).

## ISSUE-004 — Repository sync is manual
- Severity: MEDIUM. Status: OPEN.
- Description: Claude in chat cannot push or pull; the GitHub copy can differ from the agent's copy (the agent could not inspect the private remote when `.ai/` was written). Any change the owner makes directly on GitHub or locally must be shared with the agent, otherwise changes may collide.
- Workaround: the owner runs `git pull <delivered folder> main` and pushes. Codex/GPT with git access should start with `git pull` and compare against `.ai/04_CURRENT_STATE.md`.

## ISSUE-005 — Leaked-password protection is disabled in Supabase Auth
- Severity: LOW. Status: NEEDS_VERIFICATION.
- Description: the Supabase security advisor reported it. UNKNOWN whether the current plan allows enabling it. Workaround: strong unique password for the admin and teacher accounts.

## ISSUE-006 — Only backend tests run in CI
- Severity: LOW. Status: **FIXED (2026-09-22 / closed by TASK-018)**. Related: TASK-018.
- Resolution: `.github/workflows/frontend-tests.yml` runs Deno unit tests and eight Playwright suites; both workflows have been green on `c495e0d` and later `ai-development` commits. Backend workflow unchanged.

## ISSUE-007 — Public sign-up by email is still ENABLED in Supabase Auth
- Severity: MEDIUM. Status: **FIXED (2026-09-24, owner-confirmed)**.
- Description: the owner was asked to disable public signups in the Supabase dashboard (so nobody can create accounts). Even if enabled, a new account has no `profiles` row and is refused by `requireStaff` (403), so data stays protected.
- **2026-09-22**: LIVE-VERIFIED still ON (publishable key, read-only probe of `auth/v1/settings`).
- **2026-09-24**: the owner disabled it in Dashboard → Authentication → Providers → Email. **Not independently re-verified this session** — the claude.ai chat sandbox cannot reach `*.supabase.co` at all (network egress blocks the host entirely, confirmed via `x-deny-reason: host_not_allowed`; no access token or credential can work around a network-level host block). A future agent with real network access (Claude Code, Claude in Chrome, or the owner) can confirm with a plain `GET https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings` (with the publishable key as `apikey`) and check `"disable_signup": true`, or just try creating a new account and confirm it's refused.

## ISSUE-008 — Placeholder display name for the admin
- Severity: LOW. Status: OPEN. `profiles.full_name` is "Admin" (the owner did not give a name). There is no UI to change it.

## ISSUE-009 — Menu takes a lot of space on phones; dashboard is a placeholder
- Severity: LOW. Status: **FIXED (2026-09-24, TASK-014)**. The dashboard is now the mockup-5 screen, and the phone shell is a compact sticky header: brand + signed-in person on one row, all six menu items in one horizontally scrollable row. `dashboard_e2e.py` checks the one-row menu, internal scrolling, and that the page itself does not scroll sideways.

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

## ISSUE-016 — Session-expired notice could be overwritten by a second announcement (real product bug behind the CI flake)
- Severity: MEDIUM (was misdiagnosed LOW twice). Status: **FIXED-AT-ROOT (2026-09-22, second fix)**.
- History: first "fixed" by making the editor test wait for the notice text (still flaked: CI run #4 on commit `87acd3b` failed the Question-editor step with a 30 s `wait_for_function` timeout). Reproduced locally 1-in-2 when running the full suite chain.
- Root cause (product, not test): every `SessionExpiredError` dispatched `staff:session-expired`. After a 401 the session is cleared, so any later background request (the editor's debounced duplicate-check timer fires ~600 ms after typing, even detached from the removed screen) throws `SessionExpiredError("Please sign in.")` and re-dispatches, and `app.js` re-renders the login screen **replacing the first notice** ("Your session has expired...") with "Please sign in." The test waits for the first text and times out. Slow CI machines lose the race; fast local ones read the notice before the overwrite.
- Fix (core/api.js): announcements are gated by a module flag `sessionExpiredAnnounced` — only the first error per signed-out period announces; the flag resets on `staff:signed-in`, dispatched in `app.js#showApp` (single choke-point after every sign-in/boot path). Behavior is unchanged for users: they still land on sign-in with the first explanation; later redundant re-renders are gone.
- Verification: 3 consecutive full browser chains (all 5 suites) pass 15/15 (crashed on cycle 2 before the fix); unit 21/21; `deno check` clean.

## ISSUE-015 — Two parallel implementations of the TASK-006 import screen exist (`main` by Codex, `ai-development` by Buffy)
- Severity: MEDIUM (process), resolved by DEC-021. Status: **RESOLVED-BY-DECISION (2026-09-22)**; the file divergence persists until the next deliberate merge.
- Description: Codex/GPT-5 committed its own TASK-006 step 1+2 directly to `main` on 2026-09-21 (commits `d21f82d` parser layer with a new `import/model.js`, `1606aed` screen, `9c293fc` tests; 4 parser tests in `frontend/tests/import.test.js`, a 17-line e2e) while Claude's independent step-1 parsers (`6f5c223`) and Buffy's step-2 screen live on `ai-development` with different file contents. Each side's handoff described a stale `main`, which is why nobody noticed. Root causes: Codex worked directly on `main` before DEC-020 was pushed, and both agents trusted the handoff instead of re-reading the remote (violating `00_AI_RULES.md` section 12 rule 4).
- Resolution: the owner decided (2026-09-22, DEC-021) that `ai-development`'s implementation is the one that continues; Codex's `main` commits stay untouched and will be superseded file-by-file at the next deliberate merge of `ai-development` into `main`.
- What the next merge must do: resolve conflicts on the files listed in DEC-021 in favor of `ai-development`, and delete `frontend/tests/import.test.js` + `frontend/assets/js/teacher/import/model.js` (main-only files of the superseded variant) unless the owner says otherwise.
- Prevention: agents must `git fetch` and diff the actual remote before starting work — a handoff (even `.ai/`) is never proof that the remote has not moved (source-of-truth hierarchy, `00_AI_RULES.md` section 0).

## ISSUE-017 — An exam with a written answer can never become final (no teacher grading screen yet)
- Severity: MEDIUM (blocked completing the student loop). Status: **CLOSED (2026-09-24, eighth session)** — fixed by TASK-012; no misdiagnosis history.
- Was: `submit_exam_session` graded multiple choice, true/false and short answer and left essays alone, so `exam_results.status` stayed `pending_review` and `pass_status` `not_final` forever, with no screen to write the `answer_grades` rows.
- Fix: `supabase/migrations/20260924000000_result_functions.sql` (`save_answer_grade` writes `is_auto = false` plus `graded_by`, then `_session_result_write` recalculates the result and moves `pending_review` → `graded`), the `results` Edge Function, and the grading screen `#/grading/:examId` (mockup 13) with per-question grading in the attempt report too. Contract: `docs/sql-results.md`.
- Verified: rolled-back SQL assertions (`supabase/tests/result_functions_test.sql`), 18 Deno tests, 59 browser checks, and a live run against the real project (`frontend/tests/live_results_check.py`, 38/38 checks) where two essays were graded and both results turned final — one `passed`, one `failed`.

## ISSUE-018 — Abandoned student sessions are only closed on demand
- Severity: LOW. Status: **OPEN** — planned as part of TASK-015 (scheduled jobs).
- Description: `public.expire_sessions(p_tolerance)` marks silent sessions `auto_submitted`/`timed_out`, but nothing calls it on a schedule, so a student who closes the browser without submitting stays `in_progress` in the database. Their `ends_at` has passed, so a heartbeat, a save, or `exam_join` still closes it correctly the next time that student's phone talks to the server (and the teacher screens will show it as overdue), but the row is not tidied by itself.
- What is needed: a scheduled call (Supabase cron / `pg_cron`) — the same job that will purge old `rate_limits` rows (`purge_rate_limits` already exists, ISSUE-012).

## ISSUE-021 — The monitor's status pill read two fields the live function never sent
- Severity: **MEDIUM** (wrong labels on a live board, no data loss). Status: **FIXED (2026-09-24)**. Related: TASK-013.
- Description: `liveStatusPill` (`frontend/assets/js/teacher/components/resultBits.js`) decides "Left the page" / "Need a look" from `row.tab_switch_warn_limit` and `row.tab_switch_flag_limit`, and those two fields existed only in the **mocked** server's payload, never in the real `list_exam_results`. Every browser suite passed, because the mock was more generous than the database; against the live backend the pill silently fell back to the built-in defaults (1 and 3), so an exam whose teacher had set different tab-switch limits would be labelled wrongly on the live board — exactly the failure a live payload check exists to catch.
- How it was found: while adding the exam-wide add time, the live payload and the mock were compared field by field (the eleventh session's `frontend/tests/live_monitor_check.py` is what made that possible).
- Resolution: `20260927000000_exam_wide_add_time.sql` re-creates `list_exam_results` with `tab_switch_warn_limit`, `tab_switch_flag_limit` and `tab_switch_autosubmit_limit` on every row (nothing else changed); applied live, and the live check now asserts a **non-default** limit comes back in the payload.
- Lesson for later sessions: a mock that is *more complete* than the real backend hides drift. When a screen starts reading a new field, assert it against the live function, not only the mock.

## ISSUE-020 — `anon`/`authenticated` could call 35 staff-only functions directly, bypassing every Edge Function
- Severity: **CRITICAL**. Status: **FIXED (2026-09-23)**. Related: TASK-009, TASK-010, TASK-012.
- Description: `v2_05`/`v2_08` already `REVOKE EXECUTE ... FROM PUBLIC` on the foundation/question-bank functions, but the exams, session and results/grading function families (TASK-009/010/012), plus an undocumented `add_exam_time`/`list_live_sessions` pair found live but never committed, were created later by a role without that same `ALTER DEFAULT PRIVILEGES` override — so they kept Postgres's default: EXECUTE granted to `PUBLIC`. That meant the publishable (`anon`) key baked into the frontend could call `save_exam`, `remove_exam`, `set_exam_status`, `duplicate_exam`, `regenerate_exam_code`, `grant_retake`, `revoke_retake`, `add_exam_time`, `add_session_time`, `reopen_session`, `save_answer_grade`, `list_exam_results`, `get_session_report` and 23 others directly via `/rest/v1/rpc/<name>`, bypassing `requireStaff()`, the signed session-token check, rate limiting and audit logging — all of which only exist in the Edge Functions (DEC-002 says all access must go through them). No table, RLS, or application-logic changes were needed.
- Resolution: `revoke execute on all functions in schema public from public, anon, authenticated;` + a matching `alter default privileges` so future functions default the same way. Also fixed a WARN advisor while in there: mutable `search_path` on `_exam_is_open`. Security advisor clean afterward (only the expected zero-policy INFO items remain).
- **Found and fixed independently by two concurrent AI sessions minutes apart** (see `08_HANDOFF.md`'s "Concurrent-agent collision" note) — both applied the same idempotent revoke directly to the live project before either had committed to git. Consolidated into `supabase/migrations/20260925000000_security_lockdown_function_execute.sql`.
- Affected: every function created by `20260922000000_exams_functions.sql`, `20260923000000_session_functions.sql`, `20260924000000_result_functions.sql`, plus any live-only function not yet in git (continues ISSUE-001).

## ISSUE-019 — The student exam page has no "are you sure you want to leave" browser guard
- Severity: LOW. Status: **OPEN** (deliberate scope cut, 2026-09-23).
- Description: leaving or reloading the page is recorded (visibilitychange → `tab_hidden`) and warned about in-app, and the answers are kept in `localStorage` plus the server, so nothing typed is lost. What is missing is the browser-level `beforeunload` confirmation for an accidental back/reload/close. It was left out on purpose because an always-on confirmation annoys honest students and interferes with the automated browser tests; the in-app warning and the server-side limits already cover the anti-cheating requirement (design section 4).
- If it is added later: register the listener only while a session is `in_progress`, and remove it right after submitting.

## Legacy v1 issues (outside this repository; not being fixed, DEC-015)
Summarized from `docs/audit-v1.md`: server does not enforce exam time (H-1); no attempt limit or open/close/code (H-2); teacher password stored plaintext, no login throttling (H-3); token signing secret hard-coded in function code (H-4); no server-side validation of name/class and no rate limit on session creation (H-5); answers only in browser storage until submit (M-1); duplicate result rows possible (M-2). These disappear when v2 replaces v1.
