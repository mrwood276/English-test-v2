# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**`BLOCKED` — not ready for `main`.**

The TASK-015 audit-log viewer is **LIVE-VERIFIED (2026-09-25)**: the migration is applied (tracked as `20260925001719` / `v2_16_audit_functions`), the `audit` Edge Function is deployed (v1, ACTIVE), the rolled-back live SQL test passed, and the admin smoke returned the four real rows. The TASK-014 dashboard/mobile-menu work is complete and CI-verified at `2ea6ac0`. **One release blocker remains: TASK-007** — verify one real image/audio upload against live Storage.

**Live hazard found and fixed on 2026-09-25 (ISSUE-007)** — worth remembering: the owner's "disable public sign-up" step had switched the **Email provider off entirely** (`external_email_enabled: false`), so every staff sign-in answered `HTTP 422 email_provider_disabled` and the teacher app was unusable. It is fixed and verified (provider on, `disable_signup: true` kept: a real sign-up attempt is refused with `signup_disabled`, admin sign-in returns 200). **After any dashboard change, re-read `GET https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings` (publishable key as `apikey`) and check both halves: sign-ups refused AND a staff sign-in still works.** Turning a provider off is not the same as disabling sign-ups.

A staff test account is ready for TASK-007: `testguru211l@gmail.com` (its `profiles` row is `role = 'teacher'`, `is_active = true`; 2 profiles live). **Sandbox limitation**: a claude.ai chat session's network cannot reach `*.supabase.co`/`*.supabase.com` at all (confirmed via `x-deny-reason: host_not_allowed` on every attempt, even with a valid Management API token) — Storage upload, Edge Function calls and the Auth password-grant login all need HTTP access to that host. **This Windows/Codebuff clone can reach it** (that is how every live check in this file was run); a claude.ai chat session cannot.

Do not merge `ai-development` into `main` unless the owner explicitly overrides this.

## BRANCH CONTEXT

| | |
|---|---|
| Stable branch | `main`. Do not develop or merge here without the owner's explicit decision. |
| Development branch | **`ai-development`**. Its head after this session is `7a5b09e` (the leave-guard fix) plus this session's docs commit, on top of `51119a0`. |
| Starting point | This session started at `c4d6f3b` (clean tree) and found the remote three commits ahead (`f4eb5e7` audit viewer, `443cf45`, `51119a0`); it fast-forwarded to `51119a0` before touching anything. |
| Push / CI status | Backend green at `2ea6ac0`; **Frontend tests were RED twice** — at `f4eb5e7` and `2f5de2c`, both at the same `exams_e2e.py` check (ISSUE-022, fixed by `7a5b09e`). Both workflows were green again at `51119a0`. Watch the runs for `7a5b09e` and this docs commit. |
| Live database | **English_Test_v2** (`lbhnadqmokloyfarrzfv`). Do not touch the v1 project `Exam_Data_Base`. |

## LAST AGENT

Buffy — seventeenth session, 2026-09-25 (Windows clone with real network + Supabase Management API access). It pulled the three new commits, discovered the audit slice was **already applied and deployed live** while the docs still said "pending", verified the live system instead of re-applying it (rolled-back SQL test + admin smoke), corrected every stale "not yet live" note, found and fixed the live Auth misconfiguration that had blocked **all** staff sign-in (ISSUE-007), and traced and fixed the leave-guard defect behind the two red Frontend runs (ISSUE-022).

## CREDENTIAL / COLLISION WARNING

- Earlier sessions used an owner-supplied Supabase access token and the admin password for live checks. They were not committed, but both have travelled through chat and should still be revoked/rotated by the owner.
- Two earlier AI sessions built overlapping features concurrently. Always fetch/read `origin/ai-development` before starting, and confirm with the owner that no other agent is active before live-DB writes or pushes.

## LAST COMPLETED TASK

**TASK-015 slice 1 — the admin audit-log viewer is LIVE-VERIFIED (2026-09-25), plus the leave-guard defect behind the two red Frontend runs.**

Every staff action has written an `audit_logs` row since v2_08 (BR-13); nothing could read them. This slice adds the read side, admin-only (design.md 1.2 — teachers cannot manage the system audit log):

- **SQL** `list_audit_logs(p_limit, p_offset, p_action, p_entity_type, p_days)` → `{total, rows}` newest-first, `actor_name` from profiles, friendly validation hints. Service-role-only like every other staff function (DEC-002, ISSUE-020). Migration: `supabase/migrations/20260929000000_audit_functions.sql` — **applied live** (recorded `20260925001719` / `v2_16_audit_functions`; ACL verified `postgres` + `service_role` only).
- **Edge Function** `backend/functions/audit/` — action `list`, body key `filter_action` (because `action` is the endpoint's own enum); the one staff endpoint that requires role `admin` (`requireStaff(req, db, ["admin"])`) — **deployed live, v1, ACTIVE**; tokenless call answers HTTP 401 `Please sign in.`
- **Screen** `#/audit` — admin-only menu item "Audit log" (`ADMIN_NAV` in `shell.js`), table When/Who/Action/Entity/Details, debounced action/entity filters + day-window chip-select + Clear, pager (25/page), "System" for actor-less rows, empty states. New `api/audit.js` + `screens/auditLog.js`; `router.js`/`shell.js` edited; no CSS changes.
- The write side (`write_audit`, `backend/functions/_shared/audit.ts`) is untouched — the viewer is read-only.

## LIVE VERIFICATION PERFORMED (2026-09-25) — what the next agent does NOT need to repeat

**The migration was already applied and the function already deployed when this session started** (the sixteenth session's own follow-up did it, without updating the docs). Nothing was re-applied. What was actually run:

1. `supabase/tests/audit_functions_test.sql` sent as **one** request (one session, so the file's `pg_temp` helper resolves) → `AUDIT VIEWER TESTS PASSED (all rows rolled back)`. Live row counts unchanged afterwards: 4 audit rows, **0** `audit_test` rows leaked, 40 questions, 0 exams/sessions, 2 profiles.
2. Read-only schema checks: `list_audit_logs` exists, `security definer`, `stable`, `pg_proc.proacl` = `postgres` + `service_role` only; live public SQL functions **61**.
3. Admin smoke through the deployed function: `list` → `{total: 4, rows: 4}` with actor names resolved; `limit 1 / offset 2` → 1 row, `question.create` by `Admin`; `days=2 + entity_type=question` → 0 (every real row is from 2026-09-21); `days=0` → HTTP 400 "Days must be between 1 and 3650."; tokenless → HTTP 401.
4. **Auth configuration repaired** (owner approved): `external_email_enabled: true` with `disable_signup: true`; verified sign-in 200, a sign-up attempt refused `signup_disabled`, and `auth/v1/settings` reporting both.

**How to run SQL against the live project from here** (the previous handoff's command does not exist — CLI 2.117.0 has no `supabase db query`): `POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query` with `{"query": "…"}` and `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` (one request = one session), or the dashboard SQL editor. `npx supabase functions deploy <name> --no-verify-jwt --use-api` works normally. `supabase db push`/`db pull` still need the database password, which no agent has.

## TESTING PERFORMED (2026-09-25: the whole project re-run from scratch, all green)

- Backend: `deno test --allow-env backend/` → **114 passed, 0 failed**.
- Frontend unit: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed, 0 failed**.
- Browser (mocked, dev server on 8123, one suite after another exactly like CI): all **eleven** green — teacher 36, question bank 57, question editor 75, media 29, question import 43, **exams 28** (was 27; the new check pins the guard fix), student 61, results 79, monitor 30, dashboard 34, audit 25. Every suite exit 0, zero `FAIL` lines.
- Falsification of the guard fix: with the old semantics temporarily restored, `exams_e2e.py` dies at the new reload (`Page.reload` timeout after 21 checks). So the new check really catches the defect, not just a happy path.
- Diagnostics that settled ISSUE-022 (standalone probes, not committed): a busy-renderer hash/reload probe, and a `beforeunload` probe showing that with a `page.on("dialog")` listener a fired warning makes `page.reload()` hang for its whole timeout, while without a listener Playwright auto-dismisses it and navigation proceeds.
- Live: the rolled-back SQL test and the admin smoke listed above, plus the Auth configuration verification.
- `question_editor_e2e.py`'s older toast-animation flake (a click racing a toast, `<html> intercepts pointer events`) is unrelated and still stands — it passed every run here.

## DATABASE CHANGES (2026-09-25)

- **No SQL was applied by this session** — the audit migration was already live. Row counts are unchanged before and after every check: 40 questions, 4 audit rows, 0 exams, 0 sessions, 2 profiles.
- **The one live change was configuration:** `external_email_enabled: true` (with `disable_signup: true` kept), fixed through the Management API after the owner approved it in this conversation. No data, no schema, no policies.
- Live state for the next agent: Edge Functions `auth-me` v1, `question-bank` v3, `media` v1, `exams` v3, `session` v1, `results` v4, **`audit` v1** — all ACTIVE, `verify_jwt=false`; **61** public SQL functions; `supabase_migrations` newest row `20260925001719 v2_16_audit_functions`.

## FILES CHANGED (2026-09-25 — git `7a5b09e` plus this session's docs commit)

- **Fixed (the behavior change):** `frontend/assets/js/teacher/guard.js` (`setLeaveGuard(fn, hasUnsavedWork?)`, `hasUnsavedChanges()`), `frontend/assets/js/teacher/router.js` (ask and URL hold-back only while something is unsaved), `frontend/assets/js/teacher/screens/{examEditor,questionEditor,questionImport}.js` (pass their synchronous dirt predicate), `frontend/tests/exams_e2e.py` (wait for the target screen before reloading; new "untouched editor reloads with no leave warning" check).
- **Corrected (the docs that had the live state wrong):** `.ai/{02_ARCHITECTURE,03_FEATURES,04_CURRENT_STATE,05_TASK_QUEUE,07_CHANGELOG,08_HANDOFF,09_KNOWN_ISSUES}.md`, `docs/sql-audit.md`, `supabase/tests/audit_functions_test.sql` (header), `supabase/migrations/20260929000000_audit_functions.sql` (header), `frontend/README.md`.
- Not a file change, but it is corrected everywhere now: the sixteenth session's `npx supabase db query --linked --file …` instruction was wrong (no such subcommand in CLI 2.117.0).

## REMAINING WORK

1. **Nothing is pending on the audit viewer** — do not re-apply it (see LIVE VERIFICATION PERFORMED above).
2. Ordinary next code task: **TASK-020** (duplicate-overview banner) or the TASK-015 remainder — scheduled purge jobs need pg_cron on the live project; notifications need the owner's email-provider decision (DEC-017); backups likewise need live access.
3. Owner decision: what belongs on the PDF class summary (the last TASK-012 piece).
4. Owner-only release step: one real image/audio upload against live Storage (TASK-007).
5. Low-priority follow-up: reconcile the three already-live but untracked migration rows (ISSUE-001), using a real DB connection/password.

## SUGGESTED WORK FOR NEXT AI

1. Start on `ai-development`; run `git status --short --branch` and `git pull --ff-only` **before** changing anything.
2. Read `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `09_KNOWN_ISSUES.md`, and this file. Let source code, database facts, tests, and git history win over stale `.ai/` notes.
3. If you have a live Supabase connection, read LIVE VERIFICATION PERFORMED above first — the audit slice is already live and verified; do not re-apply or redeploy it.
4. Continue with TASK-020. Do not invent a random feature if the queue is empty; audit documented debt instead.
5. Before any live-DB or git-push action, confirm with the owner that no other AI session is active. Previous sessions collided twice; if a push is rejected, park the work on a local branch and ask the owner rather than forcing it.

## SESSION TOOLING — skill discovery (post-task, 2026-09-29)

Ran after the main task was pushed, per the owner's workflow. Result: **no new skill installed — nothing justified.**

- **Already available in this Claude Code environment** (do not reinstall): the superpowers process skills (`brainstorming` before planning a new feature, `systematic-debugging` before chasing a bug), the context-mode MCP (context-window management — this session's long run relied on it), claude-mem (cross-session memory), the gsd-* skill set, and ui-ux-pro-max (UI/UX guideline data; marginal here since the app uses hand-written vanilla CSS).
- **Searched, evaluated, rejected:** the only marketplace catalog present (ruflo — 506 agent-template skills) is overwhelmingly multi-agent swarm orchestration (queen/gossip/mesh coordinators, swarm testers). It conflicts with this project's explicit **one-AI-at-a-time** rule, so none was installed. No Supabase, Postgres/SQL, Playwright, Deno, or PDF skill exists in that catalog.
- **The P0 tool gap noted here is closed for this clone:** live Supabase access works (the owner's Management API token in the environment + the project host reachable) — that is how the 2026-09-25 live checks were run. A claude.ai chat session still cannot reach those hosts; that is a sandbox limitation, not a credential problem.
- **P2 candidate for later:** a dependency-free PDF-writing approach for the TASK-012 class summary — but only after the owner decides the one-page content; do not build ahead of that decision.

## DO NOT DO

- Do not work on `main`, merge to `main`, force-push, reset hard, or delete either branch.
- Do not rebuild the project, workflow, dashboard, monitor, results, exams, student engine, auth system, or the audit viewer this session finished.
- Do not add a second audit read path, a teacher-facing audit view, or public function grants; the viewer reads only via the admin-only `audit` Edge Function.
- Do not touch `write_audit` or `backend/functions/_shared/audit.ts` (the write side) or change what `audit_logs` records.
- Do not add frontend dependencies, a build step, RLS policies, or direct browser table access.
- Do not send answer keys to students or put them in session snapshots, events, logs, or audit changes.
- Do not reopen TASK-014 without a new concrete defect; its browser suite is green in Actions at `2ea6ac0`.
- Do not re-apply `20260929000000_audit_functions.sql` or redeploy `audit` (both live since 2026-09-25, tracked as `v2_16_audit_functions`) and do not add a `supabase db query` instruction anywhere — that subcommand does not exist.
- Do not disable the Email provider in Supabase Auth; `disable_signup` is what keeps the public out, and switching the provider off breaks every staff sign-in (ISSUE-007).
- In browser tests: do not `goto(hash)` and `reload()` back to back, and never register a leave guard on sight — a firing `beforeunload` warning plus a `page.on("dialog")` listener makes `page.reload()` hang until its timeout (ISSUE-022).
- Do not touch the v1 project (`Exam_Data_Base`).
- Do not push secrets or owner credentials anywhere.
- Keep user-facing UI text in English.

## IF NEXT AI CANNOT COMPLETE THE TASK

1. Stop rather than guessing or building a dangerous workaround.
2. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
3. Record the blocker, what was attempted, and what input is needed.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md`, and `09_KNOWN_ISSUES.md` where relevant.
5. Continue another non-dependent `READY` task only if it is safe to do so.
