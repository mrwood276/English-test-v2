# 02 ARCHITECTURE

Verified against the repository and the live Supabase project on 2026-09-23.

## Source control

Two branches: `main` (stable) and `ai-development` (shared, sequential AI workspace — Claude and Codex/GPT take turns, one at a time).
Normal development happens on `ai-development`; `main` only receives deliberate merges once the owner considers the development branch stable.
Full rules: `00_AI_RULES.md` section 12. This is a process convention, not an application architecture change — nothing below in this file changes because of it.

## Overview

```
Browser (static files, ES modules)                   Supabase project lbhnadqmokloyfarrzfv
  Teacher/admin: frontend/teacher/index.html          ┌─────────────────────────────────────────────┐
  Student:       frontend/index.html                  │ Auth (email+password) — staff only           │
  (student joins with name + class + code, no account)│                                             │
       │  Staff sign in: POST /auth/v1/token ───────► │                                              │
       │                                              │ Edge Functions (Deno)  verify_jwt = false    │
       │  POST /functions/v1/<name>  Bearer <token> ► │   auth-me, question-bank, media, exams,      │
       │                                              │   results  (teachers: grading, reports),      │
       │                                              │   audit  (admin only: the log viewer)       │
       │  POST /functions/v1/session ───────────────► │   requireStaff/session token → validate      │
       │   Bearer <session>.<signature>               │   → callRpc                                  │
       │                                              │              │ service role (bypasses RLS)   │
       │  PUT one-time signed upload URL ───────────► │              ▼                               │
       │   (image/audio bytes go straight to Storage) │ Postgres: 22 tables (RLS on, no policies),   │
       │                                              │ 62 public functions (business rules, audit)  │
       ▼                                              │ Storage: private bucket question-media       │
  localStorage: the student's attempt + token          └─────────────────────────────────────────────┘
```

Key property: **the browser never reads or writes a table directly.** Everything goes through Edge Functions that check who is calling and then call SQL functions.

## Directories

| Path | Purpose |
|---|---|
| `frontend/` | Two static apps: teacher/admin (`teacher/index.html`) and student (`index.html`) |
| `frontend/assets/js/core/` | `config.js` (URLs, public key, build label), `http.js` (fetch with timeout and friendly errors), `auth.js` (Supabase Auth REST client, session in `sessionStorage`), `api.js` (`callStaffFunction`: adds the token; a 401 clears the session and fires `staff:session-expired`) |
| `frontend/assets/js/shared/` | `dom.js` (element builder, no innerHTML), `rich.js` (safe display of teacher-written rich text), `icons.js`, `ui.js` (toast, confirm dialog, segmented control, debounce), `imageCompress.js` (shrink photos in the browser) |
| `frontend/assets/js/teacher/` | `app.js` (boot, sign-in/out, session events), `router.js` (hash routes), `guard.js` (unsaved-changes guard), `api/` (`questionBank.js`, `media.js`, `exams.js`, `results.js`, `audit.js`), `components/` (incl. `resultBits.js`, `reviewItem.js`), `screens/` (incl. `grading.js`, `gradingQuestion.js`, `examResults.js`, `sessionReport.js`, `examMonitor.js`, `sessionTimeline.js`, `auditLog.js`) |
| `frontend/assets/js/student/` | `app.js` (boot, resumes a saved attempt), `api.js` (the `session` function), `store.js` (attempt state in `localStorage`), `screens/{join,exam,result}.js`, `components/question.js` |
| `frontend/assets/css/` | `tokens.css` (design tokens), `base.css`, `teacher.css` (sign in, shell), `questions.css` (bank, editor, dialogs, files), `student.css` (student screens, phone first), `results.css` (grading, exam results, attempt report, live monitor) |
| `frontend/tests/` | Playwright tests with a mocked server: `teacher_e2e.py`, `question_bank_e2e.py`, `question_editor_e2e.py`, `media_e2e.py`, `question_import_e2e.py`, `exams_e2e.py`, `student_e2e.py`, `results_e2e.py`, `monitor_e2e.py`, `audit_e2e.py` (admin audit viewer), plus `mock_server.py`, `make_fixtures.py`, `fixtures_dir.py`, three one-off live scripts that need the owner's account (`live_results_check.py` for the grading loop, `live_monitor_check.py` for the monitor payload + exam-wide add time, `live_browser_check.py` for the monitor screens in a real browser — the two monitor ones share `cleanup_live_monitor.sql` — plus `live_media_check.py` for the image/audio upload against real Storage and `live_exam_delete_check.py` for the exam close-vs-delete rule), and the Deno unit tests in `tests/unit/` (import parsers, incl. zip/xlsx) |
| `frontend/dev-server.py` | Local static server that disables caching (needed because ES modules are cached aggressively) |
| `backend/functions/_shared/` | Shared library: `errors.ts`, `http.ts`, `validate.ts`, `auth.ts`, `rpc.ts`, `db.ts`, `text.ts`, `audit.ts`, `codes.ts`, `ratelimit.ts` |
| `backend/functions/<name>/` | One Edge Function each: `auth-me`, `question-bank` (`handler.ts` routing, `parse.ts` input parsing), `media`, `exams`, `session` (student-facing; `parse.ts` + `token.ts` signed session token), `results` (teacher-facing grading/reports, staff only), `audit` (admin-only log viewer; **deployed live 2026-09-25**) |
| `backend/tests/` | Deno tests: `shared.test.ts`, `question_bank.test.ts`, `media.test.ts`, `exams.test.ts`, `session.test.ts`, `results.test.ts`, `audit.test.ts` |
| `supabase/` | `README.md` + `migrations/` (the exams, session, result, monitor and lockdown SQL, applied live; `20260929000000_audit_functions.sql` applied live 2026-09-25, tracked as `v2_16_audit_functions`) + `tests/` (rolled-back SQL assertions: `session_functions_test.sql`, `result_functions_test.sql`, `monitor_functions_test.sql`, `audit_functions_test.sql`). Older `v2_01`..`v2_12` are still only in the live project (ISSUE-001) |
| `docs/` | `design.md`, `audit-v1.md`, `mockups/`, `sql-exams.md`, `sql-sessions.md`, `sql-results.md`, `sql-monitor.md`, `sql-audit.md`, `verification-checklist.md` |
| `.ai/` | This memory/handoff system |

## Frontend architecture

- Routes (hash): `#/dashboard`, `#/questions`, `#/questions/new`, `#/questions/edit/<uuid>`, `#/questions/import`, `#/exams`, `#/exams/new`, `#/exams/edit/<uuid>`, `#/monitor`, `#/monitor/<examId>`, `#/monitor/<examId>/session/<sessionId>`, `#/grading`, `#/grading/<examId>`, `#/results`, `#/results/<examId>`, `#/results/<examId>/session/<sessionId>`, `#/audit` (admin only). Unknown hashes fall back to the dashboard. A new route render increments `container.dataset.render`; slow async screens compare it to detect that they are stale.
- Screens: `login`, `shell` (menu + router host; the menu shows one more item — Audit log — to admins), `dashboard` (TASK-014), `questionBank` (list, filters, preview, archive/delete), `questionEditor` (add/edit), `questionImport`, `exams` (list) + `examEditor`, `examMonitor` (the live board; the hub and the per-exam table, with exam-wide add time), `sessionTimeline` (one attempt while it runs), `grading` (hub) + `gradingQuestion`, `examResults` (one exam's table) + `sessionReport` (one attempt), `auditLog` (admin's audit-log table).
- Components: `questionView` (student-style view used by list preview and editor preview), `richTextarea` (B/I/U buttons), `chipsInput` (class labels with suggestions), `passageDialog`, `mediaPicker` (upload queue), `resultBits` (status pills — including `liveStatusPill` for the monitor — score and duration formatting), `reviewItem` (one graded answer).
- Session: `sessionStorage` key `ENGLISH_TEST_V2_STAFF_SESSION`. Tokens are refreshed shortly before expiry. Any screen can end a session; `app.js` listens for `staff:session-expired`.
- Unsaved work: screens call `setLeaveGuard(fn)`; the router asks before changing routes; `beforeunload` warns on tab close.
- Design: tokens in `tokens.css`; the "answer sheet" motif (A–D bubbles) is used for answer options and question numbers (DEC-008).

**Student app** (separate, no account, no hash router — one screen at a time):
- Entry `frontend/index.html`; `student/app.js` reads the saved attempt from `localStorage` (`ENGLISH_TEST_V2_STUDENT_ATTEMPT`-style key in `config.js`) and mounts `join`, `exam`, or `result`. A reload resumes the same attempt, even offline.
- `student/api.js` calls only `session` (`join`, `get`, `save`, `heartbeat`, `event`, `submit`, `result`, `media`) with the signed session token from `join`; a lost/expired token goes back to the join screen without losing the answers.
- `student/store.js` holds the attempt: answers, flagged questions, remaining time, and an **offline queue** of unsaved answers (retried on `online`/interval); nothing is graded in the browser.
- Exam screen: one question at a time, progress + counter from server time, answer sheet (jump/flag), autosave, connection banner, page-leave warning, submit confirmation. Result screen follows the exam's visibility setting (nothing / score / score + review) and shows "Not final" while an essay is ungraded.
- The student page deliberately has **no `beforeunload` guard** (phones fire it for notifications) — ISSUE-019.

## Backend architecture

Every Edge Function: `Deno.serve(handle(handler))`.
- `handle` (`_shared/http.ts`): CORS (`ALLOWED_ORIGIN` secret, default `*`), JSON responses, request id, ApiError → `{error, code}` with its status, unexpected errors → logged + generic 500.
- `requireStaff(req, db, roles)` (`_shared/auth.ts`): verifies the bearer token with Supabase Auth, then loads the person's **role from `public.profiles`** (never from the token); inactive or missing profile → 403.
- Endpoints use one URL with `POST { action, ... }`.

| Function | Actions | Roles |
|---|---|---|
| `auth-me` | `GET` returns `{user:{id, fullName, role}}` | teacher, admin |
| `question-bank` | `list`, `get`, `save`, `remove`, `archive`, `restore`, `check_duplicates`, `duplicate_groups` (the list banner's whole-bank scan), `topics`, `class_labels`, `passages`, `passage_get`, `passage_save`, `passage_remove`, `import_check`, `import` (all live; `duplicate_groups` was live before it was in git — ISSUE-024, resolved 2026-09-25) | teacher, admin |
| `media` | `create_upload`, `register`, `signed_urls`, `purge_unused` (admin only; **also callable by the scheduled housekeeping job** with the `x-housekeeping-key` header — that key opens this one action and nothing else, DEC-029) | teacher, admin (+ the nightly cron job) |
| `exams` | `save`, `list`, `get`, `remove` (`hard: true` = permanent delete with the attempts, admin only), `set_status`, `check_code`, `regenerate_code`, `duplicate` | teacher, admin (delete-with-attempts: admin only) |
| `session` | `join` (anonymous, rate limited per address), then `get`, `save`, `heartbeat`, `event`, `submit`, `result`, `media` — all with the signed session token | students (no Supabase account) |
| `results` | `activity`, `pending`, `overview`, `report`, `grading_questions`, `queue`, `grade`, `add_time`, `reopen`, `grant_retake`, `revoke_retake` (all live since v1, 2026-09-24) | teacher, admin |
| `audit` | `list` (live since 2026-09-25: function deployed v1, `list_audit_logs` applied; tokenless call → 401) | **admin only** |

## Database architecture (live project, verified)

22 tables in `public`, all with RLS enabled and **0 policies**; `anon`/`authenticated` have no table or function privileges (migration `v2_05_lockdown`).

| Group | Tables | Used by code today |
|---|---|---|
| Accounts/system | `profiles` (id = auth.users.id, role teacher/admin, is_active), `app_settings`, `rate_limits`, `audit_logs`, `backups` | `profiles`, `audit_logs` yes; `rate_limits` only via SQL function (no endpoint uses it yet); `app_settings`, `backups` not yet |
| Master data | `topics`, `class_aliases` | `topics` yes; `class_aliases` not yet |
| Question bank | `passages`, `questions`, `question_options`, `accepted_answers`, `question_class_labels`, `media_files`, `question_media` | yes |
| Exams | `exams`, `exam_questions`, `retake_permissions` | **live-verified (2026-09-22)**: SQL functions applied (`supabase/migrations/20260922000000_exams_functions.sql`) + `exams` function deployed; whole teacher flow verified with the admin account. Schema facts (enum columns, position > 0, code CHECK) in `docs/sql-exams.md` |
| Sessions/results | `exam_sessions`, `session_answers`, `answer_grades`, `exam_results`, `session_events` | **live**: the student engine writes/reads all of them through `session` (2026-09-23); since 2026-09-24 the teacher side writes `answer_grades` and recalculates `exam_results` through the `results` function (TASK-012) |

Key constraints (all verified by SQL tests): one correct option per question; unique exam code among **open** exams; scheduled exams need valid dates; tab-switch limits ordered; unique `(exam_id, normalized name, normalized class, attempt_no)` for the 1-attempt rule; one result per session; result status consistent with pass status; media size cap; question media attached to exactly one of question or passage.

60 public SQL functions (all revoked from public roles; callable only by the service role):

| Purpose | Functions |
|---|---|
| Text/rules | `normalize_text`, `question_content_hash`, `set_updated_at` (trigger) |
| Rate limit | `rate_limit_hit`, `purge_rate_limits` |
| Audit | `write_audit` (the write side, since v2_08), `list_audit_logs` (the admin viewer's read side — migration `20260929000000_audit_functions.sql`, **applied live 2026-09-25**, executable only by `postgres`/`service_role`; contract: `docs/sql-audit.md`) |
| Questions | `save_question`, `remove_question`, `set_question_archived`, `get_question`, `list_questions`, `find_similar_questions`, `upsert_topic`, `list_topics`, `list_class_labels` |
| Reading texts | `save_passage`, `get_passage`, `list_passages`, `remove_passage` |
| Media | `register_media`, `link_media`, `purge_orphan_media`, `get_media_paths` |
| Import | `find_similar_batch`, `import_questions` (applied to the live database; migration `v2_12`) |
| Duplicates (TASK-020) | `find_duplicate_groups(p_threshold real default 0.55, p_limit int default 50)` — the whole-bank scan behind the list banner: exact `content_hash` groups plus trigram pairs, read-only, `security invoker` + `stable`. In git as `20260925060607_v2_17_duplicate_overview.sql` + `20260925060638_v2_17_duplicate_overview_fix_search_path.sql`, **committed verbatim from the live migration history** (DEC-028; the drift that was ISSUE-024 is closed). Contract: `docs/sql-duplicates.md` |
| Exams | `_exam_is_open`, `save_exam`, `list_exams`, `get_exam`, `remove_exam`, `set_exam_status`, `exam_code_available`, `regenerate_exam_code`, `duplicate_exam` |
| Student sessions | `exam_join`, `get_exam_session`, `save_session_answers`, `session_heartbeat`, `log_session_event`, `submit_exam_session`, `get_session_result`, `get_session_media_ids`, `expire_sessions`; helpers `_session_grade`, `_session_public_result`, `_session_question_block`, `_session_key_entry` |
| Grading/results | `save_answer_grade`, `list_grading_questions`, `get_grading_queue`, `count_pending_grading`, `list_exam_activity`, `list_exam_results`, `get_session_report`, `add_session_time`, `reopen_session`, `grant_retake`, `revoke_retake`; helper `_session_result_write` (the **only** writer of `exam_results`; `_session_grade` was re-created to skip hand-graded questions) |
| Live monitor | `list_exam_results` is the board's **only** read (read-only `stable`, in-progress rows included, with the exam's own tab limits on every row) and `add_exam_time` is its only write (BR-11 for every running attempt at once, audited). DEC-024 records both, and the duplicate `list_live_sessions` was dropped rather than kept beside it |

Migrations in git: `20260922000000_exams_functions.sql` (exams, 2026-09-22), `20260923000000_session_functions.sql` (student engine, 2026-09-23), `20260924000000_result_functions.sql` (grading + results, 2026-09-24), `20260925000000_monitor_overview_fields.sql` (the monitor's progress/heartbeat fields, 2026-09-24), `20260926000000_security_lockdown_function_execute.sql` (ISSUE-020 lockdown), `20260926002454_scheduled_housekeeping_jobs.sql` (the three `pg_cron` jobs + `pg_net` + the Vault housekeeping key, **applied live 2026-09-26 with its own `schema_migrations` row**, DEC-029), `20260927000000_exam_wide_add_time.sql` (exam-wide add time + the monitor payload drift fix, 2026-09-24), `20260929000000_audit_functions.sql` (the admin audit-log viewer, **applied live 2026-09-25**), `20260930000000_exam_delete_with_attempts.sql` (the exam delete rule: `list_exams.session_count` + the admin-only forced delete, **applied live 2026-09-25**, DEC-027). All of them are applied live now; each has an annotated contract in `docs/`.

## Scheduled work (lives inside the database — DEC-029)

Three `pg_cron` jobs, one concern each, running as `postgres` in the `postgres` database: `expire-sessions`
every five minutes (`select public.expire_sessions()`), and nightly `purge-rate-limits`
(`select public.purge_rate_limits()`) and `purge-orphan-media`, which is **not** plain SQL — it calls the
deployed `media` function over `pg_net` with `{"action": "purge_unused"}` and the `x-housekeeping-key`
header, because file bytes can only be deleted through the Storage API. The key is generated in the
migration into `vault.secrets` and mirrored as the function secret `HOUSEKEEPING_KEY`; it opens exactly
one action and never becomes a staff identity. There is no external scheduler and no hosting requirement:
the clock is the database's own. Contract and evidence: `docs/sql-jobs.md`; configuration test:
`supabase/tests/scheduled_jobs_test.sql`; end-to-end live check: `frontend/tests/live_housekeeping_check.py`.

Live migrations (names only; SQL not in git): `v2_01_foundation`, `v2_02_question_bank`, `v2_03_exams`, `v2_04_sessions_results`, `v2_05_lockdown`, `v2_06_question_content_hash`, `v2_07_text_rules_and_rate_limit`, `v2_08_question_bank_functions`, `v2_09_media_storage`, `v2_10_register_media_path_rule`, `v2_11_media_paths`, `v2_12_import_questions`.

Storage: bucket `question-media`, private, 10 MB limit, mime types image/jpeg, image/png, image/webp, audio/mpeg, audio/mp4, audio/x-m4a. No storage policies. Paths: `image/<year>/<uuid>.(jpg|png|webp)` and `audio/<year>/<uuid>.(mp3|m4a)`.

## Data flow examples

1. **Sign in:** browser → Supabase Auth `token?grant_type=password` (publishable key) → session in `sessionStorage` → `auth-me` (verifies role) → app shell.
2. **Save a question:** editor → `question-bank` `save` → `parseQuestionInput` (validate + `sanitizeInlineHtml`) → RPC `save_question` (one transaction: question, options/accepted answers, labels, media links, audit) → id.
3. **Upload a file:** `mediaPicker` shrinks images → `media` `create_upload` (signed upload URL) → browser PUT (multipart, `cacheControl` + empty-name file field, same as supabase-js `uploadToSignedUrl`) → `media` `register` (server reads real size/type from Storage, then RPC `register_media`; refused files are deleted from Storage) → the editor holds media ids → included in the next `save`.
4. **View a file:** `media` `signed_urls` (1 hour) → `<img>`/`<audio>` in previews.
5. **Take a test:** student page → `session` `join` (name + class + code; rate limited; `exam_join` creates the session and copies a per-session snapshot) → the function returns a signed token (`<id>.<HMAC>`, key = `SESSION_TOKEN_SECRET` or the service role key) → `get` (questions, **no answers**), `save` (autosaved answers), `heartbeat` (server time; `expired` past the tolerance), `event` (tab switches) → `submit` → `submit_exam_session` grades objective questions in SQL → `result` renders per the exam's visibility setting. The answer key never leaves the database (BR-09).
6. **Grade and review:** teacher opens `#/grading/:examId` → `results` `grading_questions` (essay questions with the teacher's guide read live) + `queue` (each student's answer) → `grade` → `save_answer_grade` writes `answer_grades` (`is_auto = false`, `graded_by`) and `_session_result_write` recomputes `exam_results`, flipping `pending_review` → `graded`. `#/results/:examId` reads `overview` + `activity` + `list_exam_results`; `#/results/:examId/session/:sessionId` reads `report` (every answer with the correct one, the events, the actions) and calls `add_time`, `reopen`, `grant_retake`, `revoke_retake`. No endpoint returns the answer key of a running session, and `essay_guidance` is only ever read for a staff payload.
7. **Watch a running exam:** teacher opens `#/monitor` (exams with students working right now, polled every 30 s) → `#/monitor/:examId` polls `results` `overview` every 15 s → `list_exam_results` answers with one row per attempt carrying progress, the server clock, the exit count, the heartbeat and the exam's own tab limits; the pill (`liveStatusPill`) turns one row into one label, and the screen computes no state of its own (DEC-024). Picking a student opens `#/monitor/:examId/session/:sessionId` (`results` `report`) with that attempt's event timeline and per-attempt add time. **Add time to everyone** on the per-exam board calls `results` `add_exam_time` → `add_exam_time()`; the phones pick it up from their next heartbeat (BR-20), and the board itself never writes a session state.

## Environment and configuration

- Frontend: `frontend/assets/js/core/config.js` (project URL, publishable key, timeouts, session key, `APP_BUILD` label). No `.env`.
- Edge Functions: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically; optional secret `ALLOWED_ORIGIN` (not set; `*` is used until the app has an address) and optional `SESSION_TOKEN_SECRET` (not set — the service role key signs student session tokens until it is). **`HOUSEKEEPING_KEY` is set** (2026-09-26) and must equal `vault.secrets.housekeeping_key`; it is the scheduled media job's door (DEC-029).
- Auth settings (signup disabled, redirect URLs, leaked-password protection) live in the Supabase dashboard, not in git. **Verified live 2026-09-25**: the email provider is ON and `disable_signup: true` (sign-ups refused with `signup_disabled`, staff sign-in works — ISSUE-007; re-check `auth/v1/settings` after any dashboard change).

## External integrations

Supabase (Auth, Postgres, Edge Functions, Storage); Google Fonts stylesheet (Bricolage Grotesque, Source Serif 4). No other third-party services. No email provider yet (needed later for teacher email summaries, DEC-017).

## Dependency relationships

`teacher/app.js` → `router.js` → screens → `api/*.js` → `core/api.js` → `core/auth.js` + `core/http.js` → Edge Functions → SQL functions. Student side: `student/app.js` → `store.js` + `api.js` → `session` → session SQL functions; `core/config.js` and `shared/*` are shared by both apps, `core/auth.js` is staff-only. `questionView.js` is shared by list preview and editor preview. `text.ts`/`normalize_text`/`question_content_hash` must stay identical (DEC-005). `parse.ts` output shape must match what `save_question` / `import_questions` accept.

## Protected Architecture Decisions

Do NOT change these casually (each has a decision entry in `06_DECISIONS.md`):

1. **RLS on, zero policies, no grants to anon/authenticated; all access through Edge Functions with the service role** (DEC-002).
2. **Staff auth = Supabase Auth + role from `profiles` checked in `requireStaff`; `verify_jwt=false` with in-code verification** (DEC-003).
3. **Business rules are SQL functions, one transaction per action, audit inside** (DEC-004). Edge Functions validate and call; they do not implement multi-step writes.
4. **Text normalization and content hash rules exist in JS and SQL and must match** (DEC-005).
5. **Only simple inline HTML (b, strong, i, em, u, br, sub, sup) in teacher text, sanitized on the server and again in the browser** (DEC-006).
6. **Frontend without framework/build step/dependencies; hash router; own Supabase Auth REST client** (DEC-007).
7. **Design system: "answer sheet" tokens and motif, approved via mockups** (DEC-008).
8. **Media: private bucket, signed upload/view links, server reads metadata, limits** (DEC-011).
9. **Questions used by exams are archived, not deleted; each session will store its own snapshot** (DEC-012).
10. **Separate Supabase project for v2; v1 is untouched** (DEC-001, DEC-015).
11. **Students have no accounts: a session is a capability proved by a signed token (`<session id>.<HMAC-SHA256>`), and the answer key stays in the database** (DEC-022, BR-09/BR-10).
12. **`exam_results` has exactly one writer (`_session_result_write`) and a hand-made grade is never overwritten by an automatic re-grade** (DEC-023, BR-18).
13. **The live monitor only reads** (one read path, `list_exam_results`; "offline" and the status pill are judgements made at read time from the exam's own limits) **and giving a whole exam more time is one audited action** (`add_exam_time`, DEC-024, BR-11).
