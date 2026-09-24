# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**`BLOCKED` — not ready for `main`.**

The TASK-015 audit-log viewer is complete and fully tested in git (not yet applied live — see below). The TASK-014 dashboard/mobile-menu work is complete and CI-verified at `2ea6ac0`. **One release blocker remains: TASK-007** — verify one real image/audio upload against live Storage. ISSUE-007 (public sign-up) was disabled by the owner on 2026-09-24 (not independently re-verified — see ISSUE-007; the claude.ai chat sandbox cannot reach `*.supabase.co` at all). The low-priority migration-tracking follow-up in ISSUE-001 also needs a real database connection/password. **Non-blocking but needed before TASK-015 is fully done**: apply `supabase/migrations/20260929000000_audit_functions.sql` live and run `supabase/tests/audit_functions_test.sql`.

A staff test account is ready for TASK-007: `testguru211l@gmail.com` (a `profiles` row with `role = 'teacher'`, `is_active = true` was added 2026-09-24 for it). **Important, sandbox limitation**: a claude.ai chat session's network cannot reach `*.supabase.co`/`*.supabase.com` at all (confirmed via `x-deny-reason: host_not_allowed` on every attempt, including with a valid Management API token) — Storage upload, Edge Function calls, and the Auth password-grant login all need HTTP access to that host, so **TASK-007 cannot be completed from a claude.ai chat session**, no matter what credential is provided. It needs the owner testing manually in a browser, or an agent with real network access (Claude Code, Claude in Chrome).

Do not merge `ai-development` into `main` unless the owner explicitly overrides this.

## BRANCH CONTEXT

| | |
|---|---|
| Stable branch | `main`. Do not develop or merge here without the owner's explicit decision. |
| Development branch | **`ai-development`**. Its head after this session is the TASK-015 audit-viewer commit on top of `2f5de2c` (the docs-only regression check). |
| Starting point | This session started at `2f5de2c` with a clean tree; `origin/ai-development` had not moved. |
| Push / CI status | Backend run #36 and Frontend run #28 were green at `2ea6ac0`. **The new commit adds an eleventh browser suite (`audit_e2e.py`) to CI — watch that first run.** |
| Live database | **English_Test_v2** (`lbhnadqmokloyfarrzfv`). Do not touch the v1 project `Exam_Data_Base`. |

## LAST AGENT

Claude Code — sixteenth session, 2026-09-29. It pulled `ai-development`, built the first TASK-015 slice (the admin audit-log viewer: SQL migration + Edge Function + screen + three test layers) entirely in git, ran every available suite locally (all green, including the new ones, on the first run), and deferred the live apply + deploy to the next agent because this machine has no live Supabase connection.

## CREDENTIAL / COLLISION WARNING

- Earlier sessions used an owner-supplied Supabase access token and the admin password for live checks. They were not committed, but both have travelled through chat and should still be revoked/rotated by the owner.
- Two earlier AI sessions built overlapping features concurrently. Always fetch/read `origin/ai-development` before starting, and confirm with the owner that no other agent is active before live-DB writes or pushes.

## LAST COMPLETED TASK

**TASK-015 slice 1 — the admin audit-log viewer (TESTED in git; live apply pending).**

Every staff action has written an `audit_logs` row since v2_08 (BR-13); nothing could read them. This slice adds the read side, admin-only (design.md 1.2 — teachers cannot manage the system audit log):

- **SQL** `list_audit_logs(p_limit, p_offset, p_action, p_entity_type, p_days)` → `{total, rows}` newest-first, `actor_name` from profiles, friendly validation hints. Service-role-only like every other staff function (DEC-002, ISSUE-020). Migration: `supabase/migrations/20260929000000_audit_functions.sql` — **in git, NOT yet applied live.**
- **Edge Function** `backend/functions/audit/` — action `list`, body key `filter_action` (because `action` is the endpoint's own enum); the one staff endpoint that requires role `admin` (`requireStaff(req, db, ["admin"])`) — **in git, NOT yet deployed.**
- **Screen** `#/audit` — admin-only menu item "Audit log" (`ADMIN_NAV` in `shell.js`), table When/Who/Action/Entity/Details, debounced action/entity filters + day-window chip-select + Clear, pager (25/page), "System" for actor-less rows, empty states. New `api/audit.js` + `screens/auditLog.js`; `router.js`/`shell.js` edited; no CSS changes.
- The write side (`write_audit`, `backend/functions/_shared/audit.ts`) is untouched — the viewer is read-only.

## THE LIVE APPLY — THE NEXT AGENT'S FIRST JOB

This machine had no live Supabase connection, so the feature is **TESTED, not LIVE-VERIFIED**. An agent with one (Supabase MCP or CLI) must, in order:

1. Confirm with the owner that no other AI session is active.
2. `npx supabase db query --linked --file supabase/migrations/20260929000000_audit_functions.sql` (or Supabase MCP `execute_sql` with the file's contents) — the migration is idempotent (drops the function first).
3. `npx supabase db query --linked --file supabase/tests/audit_functions_test.sql` — success is the error `AUDIT VIEWER TESTS PASSED (all rows rolled back)`; everything rolls back, so live row counts must not change.
4. `python backend/sync_functions.py` (keeps `supabase/functions` in sync; output is gitignored).
5. `npx supabase functions deploy audit --no-verify-jwt --use-api`.
6. One live smoke check: tokenless call → 401; a teacher (none exists yet — the profile is admin) would get 403; admin `list` → `{total: 4, rows: [...the four real audit rows...]}`.
7. Flip the statuses to LIVE-VERIFIED: `03_FEATURES.md` (F-14), `04_CURRENT_STATE.md` (drift table), `02_ARCHITECTURE.md` ("deploy pending" notes), this file, and the "Applied live" header line in the migration file. Commit + push the doc flips.

## TESTING PERFORMED (all local, all green, first run)

- Backend: `deno test --allow-env backend/tests/` → **114 passed, 0 failed** (106 existing + 8 new `audit.test.ts`).
- Frontend unit: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed, 0 failed**.
- Browser (mocked): new `frontend/tests/audit_e2e.py` → **25/25**; all **ten** existing suites still green after the teacher menu went from six to seven items (`teacher_e2e.py`, `monitor_e2e.py` assertions updated): teacher, question bank, question editor, media, question import, exams, student, results, monitor, dashboard.
- `deno check backend/functions/audit/index.ts` → clean. `git diff --check` → clean.
- **The runtime note in older `.ai/` files was stale**: this Windows clone DOES have Python 3.12 + Playwright + Chromium working (verified by actually running the suites). `04_CURRENT_STATE.md` has been corrected.
- `supabase/tests/audit_functions_test.sql` is written but could NOT be run here (no live connection). It seeds rows under the `audit_test` entity marker so live data can never disturb its counts, and ends with `AUDIT VIEWER TESTS PASSED (all rows rolled back)`.

## DATABASE CHANGES

- **No live database was touched this session.** Everything landed in git only.
- In git, pending live apply: `supabase/migrations/20260929000000_audit_functions.sql` — one new function `list_audit_logs`, no tables, no policies, no grants to public/anon/authenticated.

## FILES CHANGED (this session)

- New: `supabase/migrations/20260929000000_audit_functions.sql`, `supabase/tests/audit_functions_test.sql`, `backend/functions/audit/{index.ts,handler.ts}`, `backend/tests/audit.test.ts`, `frontend/assets/js/teacher/api/audit.js`, `frontend/assets/js/teacher/screens/auditLog.js`, `frontend/tests/audit_e2e.py`, `docs/sql-audit.md`.
- Edited: `frontend/assets/js/teacher/router.js`, `frontend/assets/js/teacher/screens/shell.js`, `frontend/tests/mock_server.py`, `frontend/tests/teacher_e2e.py`, `frontend/tests/monitor_e2e.py`, `.github/workflows/frontend-tests.yml`, `supabase/README.md`, `.ai/02_ARCHITECTURE.md`, `.ai/03_FEATURES.md`, `.ai/04_CURRENT_STATE.md`, `.ai/05_TASK_QUEUE.md`, `.ai/07_CHANGELOG.md`, `.ai/08_HANDOFF.md`.

## REMAINING WORK

1. **Apply the audit slice live** (the numbered sequence above) — any agent with a live connection.
2. Ordinary next code task: **TASK-020** (duplicate-overview banner) or the TASK-015 remainder — scheduled purge jobs need pg_cron on the live project; notifications need the owner's email-provider decision (DEC-017); backups likewise need live access.
3. Owner decision: what belongs on the PDF class summary (the last TASK-012 piece).
4. Owner-only release steps: disable public sign-up (ISSUE-007) and run one real image/audio upload against live Storage (TASK-007).
5. Low-priority follow-up: reconcile the three already-live but untracked migration rows (ISSUE-001), using a real DB connection/password.

## SUGGESTED WORK FOR NEXT AI

1. Start on `ai-development`; run `git status --short --branch` and `git pull --ff-only` **before** changing anything.
2. Read `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `09_KNOWN_ISSUES.md`, and this file. Let source code, database facts, tests, and git history win over stale `.ai/` notes.
3. If you have a live Supabase connection, do THE LIVE APPLY above, watch the CI run (eleven browser suites now), then flip the statuses.
4. Otherwise continue with TASK-020. Do not invent a random feature if the queue is empty; audit documented debt instead.
5. Before any live-DB or git-push action, confirm with the owner that no other AI session is active. Previous sessions collided twice; if a push is rejected, park the work on a local branch and ask the owner rather than forcing it.

## SESSION TOOLING — skill discovery (post-task, 2026-09-29)

Ran after the main task was pushed, per the owner's workflow. Result: **no new skill installed — nothing justified.**

- **Already available in this Claude Code environment** (do not reinstall): the superpowers process skills (`brainstorming` before planning a new feature, `systematic-debugging` before chasing a bug), the context-mode MCP (context-window management — this session's long run relied on it), claude-mem (cross-session memory), the gsd-* skill set, and ui-ux-pro-max (UI/UX guideline data; marginal here since the app uses hand-written vanilla CSS).
- **Searched, evaluated, rejected:** the only marketplace catalog present (ruflo — 506 agent-template skills) is overwhelmingly multi-agent swarm orchestration (queen/gossip/mesh coordinators, swarm testers). It conflicts with this project's explicit **one-AI-at-a-time** rule, so none was installed. No Supabase, Postgres/SQL, Playwright, Deno, or PDF skill exists in that catalog.
- **The real P0 tool gap is not a skill:** live Supabase access needs the owner's credentials (Supabase MCP or a CLI access token) — see THE LIVE APPLY above. That is a user action, not an install.
- **P2 candidate for later:** a dependency-free PDF-writing approach for the TASK-012 class summary — but only after the owner decides the one-page content; do not build ahead of that decision.

## DO NOT DO

- Do not work on `main`, merge to `main`, force-push, reset hard, or delete either branch.
- Do not rebuild the project, workflow, dashboard, monitor, results, exams, student engine, auth system, or the audit viewer this session finished.
- Do not add a second audit read path, a teacher-facing audit view, or public function grants; the viewer reads only via the admin-only `audit` Edge Function.
- Do not touch `write_audit` or `backend/functions/_shared/audit.ts` (the write side) or change what `audit_logs` records.
- Do not add frontend dependencies, a build step, RLS policies, or direct browser table access.
- Do not send answer keys to students or put them in session snapshots, events, logs, or audit changes.
- Do not reopen TASK-014 without a new concrete defect; its browser suite is green in Actions at `2ea6ac0`.
- Do not touch the v1 project (`Exam_Data_Base`).
- Do not push secrets or owner credentials anywhere.
- Keep user-facing UI text in English.

## IF NEXT AI CANNOT COMPLETE THE TASK

1. Stop rather than guessing or building a dangerous workaround.
2. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
3. Record the blocker, what was attempted, and what input is needed.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md`, and `09_KNOWN_ISSUES.md` where relevant.
5. Continue another non-dependent `READY` task only if it is safe to do so.
