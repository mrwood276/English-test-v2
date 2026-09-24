# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**`BLOCKED` — not ready for `main`.**

The TASK-014 dashboard/mobile-menu work is complete and CI-verified at `2ea6ac0`. Two owner-only release blockers remain: disable public sign-up in Supabase Auth (ISSUE-007) and verify one real image/audio upload against live Storage (TASK-007). The low-priority migration-tracking follow-up in ISSUE-001 also needs a real database connection/password.

Do not merge `ai-development` into `main` unless the owner explicitly overrides this.

## BRANCH CONTEXT

| | |
|---|---|
| Stable branch | `main`. Do not develop or merge here without the owner's explicit decision. |
| Development branch | **`ai-development`**. Its current head is this docs-only handoff commit on top of the verified product state `2ea6ac0` (itself on `dab2a48`, TASK-014 dashboard/mobile-menu work). |
| Starting point | `origin/ai-development` was pulled with `git pull --ff-only` before work; it was already at `dab2a48`. |
| Push / CI status | The first frontend run at `dab2a48` failed `dashboard_e2e.py` on a test-setup `KeyError`. The setup fix was pushed as `2ea6ac0`; Backend run #36 and Frontend run #28 are both green. |
| Live database | **English_Test_v2** (`lbhnadqmokloyfarrzfv`). Do not touch the v1 project `Exam_Data_Base`. |

## LAST AGENT

Codex — fifteenth session, 2026-09-24. It pulled the shared branch, watched the first dashboard CI run, inspected the real Actions log, fixed the missing mock-server setup at the root, re-ran the available Deno tests, and confirmed the follow-up Actions run green.

## CREDENTIAL / COLLISION WARNING

- Earlier sessions used an owner-supplied Supabase access token and the admin password for live checks. They were not committed, but both have travelled through chat and should still be revoked/rotated by the owner.
- Two earlier AI sessions built overlapping features concurrently. Always fetch/read `origin/ai-development` before starting, and confirm with the owner that no other agent is active before live-DB writes or pushes.

## LAST COMPLETED TASK

**TASK-014 — Phase 6 dashboard and UX polish (now complete and CI-green).**

- The teacher dashboard now follows mockup 5: the currently open exam with its facts and 52-px access code, copy/change/close actions, a live preview using the existing `liveStatusPill`, working/class counts, attention rows, and the latest finished exams with a pass-rate meter.
- The phone shell now uses a sticky compact header: brand and signed-in person on the first row, all six menu links in one horizontally scrollable row.
- `list_exam_activity` was extended additively with `passed` and `failed`; the dashboard has no second read path (DEC-026).
- No class-merge dashboard row was invented: the results merge UI does not exist yet, so a dead button would only add a second, premature implementation.
- The first frontend Actions run failed before an assertion because `dashboard_e2e.py` called `open_exam_row(CODE)` before registering the session exam. The test now calls `session_exam(CODE)` first and then mirrors it with `open_exam_row(CODE)`.
- The follow-up run at `2ea6ac0` passed: Backend run #36 and Frontend run #28, including all ten mocked browser suites and `dashboard_e2e.py`, are green.

## CURRENT STATE

- The dashboard reads only:
  - `exams.list({ status: "open", sort: "newest" })`
  - `results.activity()`
  - `results.overview(examId)`
- `startRefresh()` now lives in `frontend/assets/js/shared/ui.js`; both the monitor and dashboard use that one implementation.
- `supabase/migrations/20260928000000_dashboard_activity_fields.sql` is tracked in git and **already applied live**. It re-creates `list_exam_activity` and adds `passed` / `failed`.
- No Edge Function redeploy was needed: the existing `results` activity handler passes the SQL function's JSON through unchanged.
- Live verification after the change: `list_exam_activity(false)` returned `[]` with the live project's 0 exams and 0 sessions; `pg_proc.proacl` is still `{postgres=X/postgres,service_role=X/postgres}`; `has_function_privilege()` says service-role execute is true and anon/authenticated execute is false.
- Security advisor after the change: only the expected RLS-no-policy INFO findings (22 tables) and the pre-existing leaked-password-protection WARN. No new security finding was introduced.
- No data rows were created or left behind.

## TESTING PERFORMED

Available local checks were run from this Windows clone:

- Backend: `deno test --allow-env backend/tests/` → **106 passed, 0 failed**.
- Frontend unit: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed, 0 failed**.
- `git diff --check` → clean.
- GitHub Actions at `2ea6ac0` → Backend run #36 and Frontend run #28 green; the browser job passed all ten suites, including `dashboard_e2e.py`.
- Supabase live function/ACL/security checks from the fourteenth session remain the latest live verification; this session made no database change.

This Windows environment still has no Python or Playwright, so browser execution was delegated to GitHub Actions as designed. The first dashboard run exposed the test-setup error; the follow-up Actions run is green, so TASK-014's browser suite is verified.

## DATABASE CHANGES

- **This session changed no database, schema, Edge Function, or live data.**
- From the completed TASK-014 work: new git migration `supabase/migrations/20260928000000_dashboard_activity_fields.sql`.
- Applied live via Supabase MCP.
- Change: `list_exam_activity(boolean)` now returns `passed` and `failed`; every existing field and action remains unchanged.
- No tables, RLS policies, roles, Edge Function code, or application secrets were changed.
- No Edge Function was redeployed.

## FILES CHANGED

- This CI-closure session:
  - `frontend/tests/dashboard_e2e.py`
  - `.ai/03_FEATURES.md`, `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `07_CHANGELOG.md`, `08_HANDOFF.md`
- Earlier TASK-014 work already on the branch:
- Dashboard/shared frontend:
  - `frontend/assets/js/teacher/screens/dashboard.js`
  - `frontend/assets/js/teacher/screens/examMonitor.js`
  - `frontend/assets/js/shared/ui.js`
  - `frontend/assets/js/shared/icons.js`
  - `frontend/assets/css/teacher.css`
- SQL/docs:
  - `supabase/migrations/20260928000000_dashboard_activity_fields.sql`
  - `docs/sql-results.md`
- Tests/CI:
  - `frontend/tests/dashboard_e2e.py` (new)
  - `frontend/tests/mock_server.py`
  - `frontend/tests/teacher_e2e.py`
  - `.github/workflows/frontend-tests.yml`
- `.ai/`: `01_PROJECT.md`, `03_FEATURES.md`, `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `06_DECISIONS.md`, `07_CHANGELOG.md`, `08_HANDOFF.md`, `09_KNOWN_ISSUES.md`.

## REMAINING WORK

1. Ordinary next code task: **TASK-015** (scheduled `expire_sessions()` / `purge_rate_limits()`, audit-log viewer, notifications) or **TASK-020** (duplicate-overview banner).
2. Owner decision: what belongs on the PDF class summary (the last TASK-012 piece).
3. Owner-only release steps: disable public sign-up (ISSUE-007) and run one real image/audio upload against live Storage (TASK-007).
4. Low-priority follow-up: reconcile the three already-live but untracked migration rows described in ISSUE-001, using a real DB connection/password.
5. A human/owner walkthrough of the new dashboard against the real project is still valuable even after CI is green.

## SUGGESTED WORK FOR NEXT AI

1. Start on `ai-development`; run `git status --short --branch` and `git pull --ff-only` **before** changing anything.
2. Read `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `09_KNOWN_ISSUES.md`, and this file. Let source code, database facts, tests, and git history win over stale `.ai/` notes.
3. CI is already green at `2ea6ac0` (Backend #36, Frontend #28). Re-check it only if the remote has moved.
4. Continue with TASK-015 or TASK-020. Do not invent a random feature if the queue is empty; audit documented debt instead.
5. Before any live-DB or git-push action, confirm with the owner that no other AI session is active. Previous sessions collided twice; if a push is rejected, park the work on a local branch and ask the owner rather than forcing it.

## DO NOT DO

- Do not work on `main`, merge to `main`, force-push, reset hard, or delete either branch.
- Do not rebuild the project, workflow, dashboard, monitor, results, exams, student engine, or auth system.
- Do not add a dashboard-only SQL read function or a second monitor read path.
- Do not copy `liveStatusPill` logic into the dashboard; import the existing component.
- Do not add frontend dependencies, a build step, RLS policies, direct browser table access, or public function grants.
- Do not send answer keys to students or put them in session snapshots, events, logs, or audit changes.
- Do not implement the dashboard class-merge row until the real results merge UI exists.
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
