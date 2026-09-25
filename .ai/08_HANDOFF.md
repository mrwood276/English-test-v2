# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**`READY` — no release blocker is open.** The merge into `main` is the owner's decision (DEC-020) and needs the DEC-021 import reconciliation; nothing technical is missing.

**TASK-007 is COMPLETE and LIVE-VERIFIED (2026-09-25, eighteenth session)** — the last blocker. A real photo and a real MP3 were uploaded through the app **with the staff test account** to the live private bucket, saved on a question, reopened and played back; a forced oversized file was refused and deleted from Storage again; every row and object the run created was removed and verified gone. `frontend/tests/live_media_check.py` reports **32/32** (`ALL LIVE MEDIA CHECKS PASSED`). The `@supabase/storage-js` protocol reproduction was correct, so **no product code changed** — this was verification, not a fix. ISSUE-002 is closed.

**ISSUE-023 is fixed the same day (DEC-027, live at `exams` v4)**: an exam that already has attempts now says so in the list, a teacher cannot delete one (no Delete button, and the SQL would close it), and the **admin** can permanently delete it behind a dialog that names the attempt count and the answers, grades and results that go with it. `frontend/tests/live_exam_delete_check.py` **17/17**.

**Live hazard found and fixed on 2026-09-25 (ISSUE-007)** — worth remembering: the owner's "disable public sign-up" step had switched the **Email provider off entirely** (`external_email_enabled: false`), so every staff sign-in answered `HTTP 422 email_provider_disabled` and the teacher app was unusable. It is fixed and verified (provider on, `disable_signup: true` kept: a real sign-up attempt is refused with `signup_disabled`, admin sign-in returns 200). **After any dashboard change, re-read `GET https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings` (publishable key as `apikey`) and check both halves: sign-ups refused AND a staff sign-in still works.** Turning a provider off is not the same as disabling sign-ups.

The staff test account `testguru211l@gmail.com` (`profiles`: `role = 'teacher'`, `is_active = true`; 2 profiles live) is what the media check signs in as; its password was supplied by the owner through chat and must not be committed. **Sandbox limitation reminder**: a claude.ai chat session's network cannot reach `*.supabase.co`/`*.supabase.com` at all (confirmed via `x-deny-reason: host_not_allowed`) — Storage upload, Edge Function calls and the Auth password-grant login all need HTTP access to that host. **This Windows/Codebuff clone can reach it** (that is how every live check in this file was run); a claude.ai chat session cannot.

Do not merge `ai-development` into `main` without the owner's explicit go-ahead (DEC-020); when it happens, resolve the DEC-021 import files in favour of `ai-development`.

## BRANCH CONTEXT

| | |
|---|---|
| Stable branch | `main`. Do not develop or merge here without the owner's explicit decision. |
| Development branch | **`ai-development`**. Started this session at `2fcce90` (clean tree, in sync with `origin/ai-development`). Head after this session: **`5252359`** (`cdad496` the exam-delete feature, `5252359` its docs), on top of the TASK-007 commits `d99ca92` + `d479ed1` + `c816dc2`. All pushed. |
| Starting point | `2fcce90` — `git status --short --branch` showed a clean tree and no commits behind/ahead. Nothing was fetched-and-missing this time; the previous session's green CI and docs were confirmed before work started. |
| Push / CI status | **Both workflows green on the final head `5252359`** (and earlier on `d479ed1`). Locally: backend **118**, unit **31**, all **eleven** browser suites green after the exam-delete change; the two live checks 32/32 and 17/17. |
| Live database | **English_Test_v2** (`lbhnadqmokloyfarrzfv`). Do not touch the v1 project `Exam_Data_Base`. |

## LAST AGENT

Buffy — eighteenth session, 2026-09-25 (Windows clone with real network + Supabase Management API access). It closed the last release blocker by running the **first real media upload** against the live project with the staff test account, through the app's own editor, and turned that run into the committed live check `frontend/tests/live_media_check.py` (**32/32**). It changed **no product code** there (the upload protocol was already right) and deleted everything it created. Then, from the live audit log, it found **ISSUE-023** (the owner's five Delete attempts on an exam that had attempts), **asked the owner** what should happen instead of guessing, and implemented the answer end to end — migration applied live, `exams` redeployed as v4, a role-aware exams screen, backend tests 114→118, the browser suite 28→37 checks, and the new live check `frontend/tests/live_exam_delete_check.py` (**17/17**). The owner's own live exam/session were left untouched.

## CREDENTIAL / COLLISION WARNING

- Earlier sessions used an owner-supplied Supabase access token and the admin password for live checks. They were not committed, but both have travelled through chat and should still be revoked/rotated by the owner.
- Two earlier AI sessions built overlapping features concurrently. Always fetch/read `origin/ai-development` before starting, and confirm with the owner that no other agent is active before live-DB writes or pushes.
- **A third instance of the same problem is live right now (ISSUE-024, found 2026-09-25)**: TASK-020's backend — the SQL function `find_duplicate_groups` (live migrations `v2_17_duplicate_overview` + `…_fix_search_path`, 06:06 UTC) **and** a `duplicate_groups` action on the deployed `question-bank` — exists in the live project with **no file and no commit in this repository** (both remote branches were unchanged when this was found). It is not this clone's work. **Do not implement TASK-020 from scratch before asking the owner whose it is.**

## LAST COMPLETED TASK

**ISSUE-023 — the exam delete rule now tells the truth, and only the admin can really delete an exam that has attempts (DEC-027, applied and deployed live 2026-09-25).**

The owner had hit Delete five times on the same exam (five `exam.close` audit rows with `reason: "delete requested while sessions exist"`) because the confirmation dialog promised the exam "will be removed" while `remove_exam` only ever closed it. The rule itself is right (BR-10 / DEC-012: attempts and their results are never lost), so the fix makes the behaviour **explicit** instead of changing it for every role:

- **SQL** `supabase/migrations/20260930000000_exam_delete_with_attempts.sql` (**applied live**): `list_exams` additively returns **`session_count`**; `remove_exam(p_id, p_actor, p_force default false)` closes an exam with attempts when `p_force` is false (auditing `exam.close` with `attempts`), and with `p_force = true` deletes `exam_questions`, then **`exam_sessions`** (answers, grades, results and events cascade from them — `exam_sessions.exam_id` is `on delete restrict`, so they must go first), then the exam, auditing `exam.delete` with `attempts` and `permanent: true`. The old **two-argument `remove_exam` was dropped** on purpose: a force-less overload left lying around is exactly what a future caller would hit by accident.
- **Edge** `backend/functions/exams/handler.ts`: the body is parsed before the auth check (like `media`), and `hard: true` on `remove` switches the required role to `["admin"]` — a teacher's request is **403 and never reaches the database**. **Redeployed live as `exams` v4** (was v3).
- **Screen** `frontend/assets/js/teacher/screens/exams.js` (+ `api/exams.js`): the route already passes `ctx`, so the list now knows the role. A row shows "N attempts" in its summary; for an exam with attempts a **teacher** sees "N attempts — kept for the results" **instead of** a Delete button, while the **admin** keeps Delete and its dialog becomes "Delete this exam and its attempts?" with the count and the losses named (`Delete permanently`). No attempts: unchanged.
- **Verified live** (`frontend/tests/live_exam_delete_check.py`, new, **17/17**): teacher `hard: true` → 403 with the exam untouched; teacher plain delete → `'closed'`, attempt intact; admin forced delete → `'deleted'`, `not_found` after, **0 rows** in `exams`/`exam_sessions`/`session_answers`/`session_events`/`exam_results`; audit `exam.close` + `exam.delete` (`permanent: true`); tokenless 401. It removes its own `rate_limits` row and sweeps up if an earlier step fails.
- **Tests**: backend **118** (four new), `exams_e2e.py` **37** (nine new; it flips the mock to the teacher role to prove the other side), unit 31, all eleven browser suites green. The mock's `remove` now honours the same rule, so it can no longer be more generous than the backend (the ISSUE-021 lesson).

### Earlier in the same session

**TASK-007 — the first real image and audio upload against live Storage is LIVE-VERIFIED (2026-09-25). The last release blocker is closed.**

F-07 had only ever run against a mocked Storage and `media_files` had 0 rows; the upload protocol had been copied from `@supabase/storage-js` 2.116 source and never executed. `frontend/tests/live_media_check.py` is the new, repeatable proof — **32/32, `ALL LIVE MEDIA CHECKS PASSED`**:

- signs the **staff test account** in through the real Auth endpoint, checks `auth-me` reports `role: teacher`, and confirms a teacher is refused the admin-only `purge_unused` (403) while a tokenless call is refused (401);
- checks the link `create_upload` hands out is absolute — `https://<project>/storage/v1/object/upload/sign/question-media/<kind>/<year>/<uuid>.<ext>?token=…` — and that an over-limit announced size is refused before anything is uploaded ("File size must be between 1 and 1500000.");
- drives the real editor in Chromium (`#/questions/new`) and picks a **7,593,366-byte PNG** plus a **real 3-second MP3** (ffmpeg); the app's own `prepareImage` shrank the photo to an **813,506-byte WebP**; each file was PUT once to Storage (HTTP 200, `apikey: sb_publishable_…`, `x-upsert: false`, `multipart/form-data`) — the browser CORS path works;
- checks the rows carry what **Storage** reported, not what the browser claimed: `image/webp` / 813,506 bytes and `audio/mpeg` / 48,944 bytes with `duration_seconds = 3`, both attached to the question in order;
- saves, **reopens** `#/questions/edit/<id>`, and confirms playback from the signed viewing links: `img.naturalWidth > 0`, `audio.readyState 4`, `duration 3`, position advancing, and the link serving the exact 48,944 MP3 bytes;
- pushes a **4,504,504-byte JPEG** into Storage on purpose to prove the refusal path: `register_media` answers 400 "Images must be JPG, PNG, or WebP and about 1 MB or smaller." and the handler's `bucket.remove([path])` really deletes it (`storage.objects` 0, `media_files` 0);
- deletes its own question, its `question_media`/`media_files` rows and its Storage objects, then verifies the bucket is back to its previous object count.

**No product code changed** — `frontend/assets/js/teacher/api/media.js` and `backend/functions/media/handler.ts` were left untouched because the reproduction was right in every detail (absolute signed URL, token in the URL so no `Authorization` header, `cacheControl` + one file field with an empty name). Live state after the run: 0 `media_files`, 0 objects, 40 questions, 2 profiles; the only trace is 9 `audit_logs` rows, deliberately kept.

**Found in the live data (not a code defect):** the project holds the **owner's own** test — exam `3ad8eb38` ("test", code `4KHU2A`, closed) with one submitted session (`jonathan`, `XII TKJ A`), created 07:14 UTC on 2026-09-25 — plus five `exam.close` rows with `reason: "delete requested while sessions exist"`: the owner hit Delete five times and the app closed the exam instead, on purpose (BR-10/DEC-012). Left untouched; recorded as **ISSUE-023** for an owner decision.

**Previous session — TASK-015 slice 1, the admin audit-log viewer (already live, described in the next section):**

Every staff action has written an `audit_logs` row since v2_08 (BR-13); nothing could read them. This slice adds the read side, admin-only (design.md 1.2 — teachers cannot manage the system audit log):

- **SQL** `list_audit_logs(p_limit, p_offset, p_action, p_entity_type, p_days)` → `{total, rows}` newest-first, `actor_name` from profiles, friendly validation hints. Service-role-only like every other staff function (DEC-002, ISSUE-020). Migration: `supabase/migrations/20260929000000_audit_functions.sql` — **applied live** (recorded `20260925001719` / `v2_16_audit_functions`; ACL verified `postgres` + `service_role` only).
- **Edge Function** `backend/functions/audit/` — action `list`, body key `filter_action` (because `action` is the endpoint's own enum); the one staff endpoint that requires role `admin` (`requireStaff(req, db, ["admin"])`) — **deployed live, v1, ACTIVE**; tokenless call answers HTTP 401 `Please sign in.`
- **Screen** `#/audit` — admin-only menu item "Audit log" (`ADMIN_NAV` in `shell.js`), table When/Who/Action/Entity/Details, debounced action/entity filters + day-window chip-select + Clear, pager (25/page), "System" for actor-less rows, empty states. New `api/audit.js` + `screens/auditLog.js`; `router.js`/`shell.js` edited; no CSS changes.
- The write side (`write_audit`, `backend/functions/_shared/audit.ts`) is untouched — the viewer is read-only.

## LIVE VERIFICATION PERFORMED (2026-09-25, eighteenth session) — the exam delete rule

**Do not repeat this unless the delete rule changes.** `SUPABASE_TEST_EMAIL`/`SUPABASE_TEST_PASSWORD` (teacher) + `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` (admin) + `SUPABASE_ACCESS_TOKEN` → `python frontend/tests/live_exam_delete_check.py`. It creates one throwaway exam (code `DELCHK`), opens it, joins one student, then walks teacher-refusal → teacher-close → admin-permanent-delete, checks every table afterwards and cleans up after itself. 17/17.

It taught one thing worth reusing: `rate_limits` rows are bucketed by the **minute**, so a cleanup that deletes "rows since `<now>`" misses the row the run itself created — look back a few minutes instead.

## LIVE VERIFICATION PERFORMED (2026-09-25, eighteenth session) — the real media upload

**Do not repeat this unless something in the media path changes.** Run it against the live project with `python frontend/dev-server.py 8123`, then `SUPABASE_TEST_EMAIL=… SUPABASE_TEST_PASSWORD=… [SUPABASE_ACCESS_TOKEN=…] python frontend/tests/live_media_check.py` (ffmpeg builds the real MP3; `--keep` leaves the artifacts for inspection). It needs the Management token only for the database/bucket assertions and its self-cleanup — without it the app part still runs and prints the ids to clean up.

Two things it taught the session that are worth knowing before writing another such check:

1. `@supabase/storage-js`'s reproduction was **correct**: `create_upload` returns an **absolute** URL, the PUT needs no `Authorization` header (the token is a query parameter), and the multipart body is `cacheControl` + one file field with an **empty name**. `exams`/`session`/`results`/`audit` are unrelated; nothing else needs re-checking.
2. Headless Chromium's audio clock advances **much slower than wall time** — a 900 ms wait only moved `currentTime` to ~0.18 s. The check now waits for the position to actually move (> 0.05 s, polling up to 5 s) instead of asserting a wall-clock amount; and `preload="none"` means `readyState` stays 0 until `load()`/`play()` is called, so never wait for `readyState` before starting playback.

## LIVE VERIFICATION PERFORMED (2026-09-25, seventeenth session) — the audit viewer (already covered; kept for the record)

**The migration was already applied and the function already deployed when this session started** (the sixteenth session's own follow-up did it, without updating the docs). Nothing was re-applied. What was actually run:

1. `supabase/tests/audit_functions_test.sql` sent as **one** request (one session, so the file's `pg_temp` helper resolves) → `AUDIT VIEWER TESTS PASSED (all rows rolled back)`. Live row counts unchanged afterwards: 4 audit rows, **0** `audit_test` rows leaked, 40 questions, 0 exams/sessions, 2 profiles.
2. Read-only schema checks: `list_audit_logs` exists, `security definer`, `stable`, `pg_proc.proacl` = `postgres` + `service_role` only; live public SQL functions **61**.
3. Admin smoke through the deployed function: `list` → `{total: 4, rows: 4}` with actor names resolved; `limit 1 / offset 2` → 1 row, `question.create` by `Admin`; `days=2 + entity_type=question` → 0 (every real row is from 2026-09-21); `days=0` → HTTP 400 "Days must be between 1 and 3650."; tokenless → HTTP 401.
4. **Auth configuration repaired** (owner approved): `external_email_enabled: true` with `disable_signup: true`; verified sign-in 200, a sign-up attempt refused `signup_disabled`, and `auth/v1/settings` reporting both.

**How to run SQL against the live project from here** (the previous handoff's command does not exist — CLI 2.117.0 has no `supabase db query`): `POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query` with `{"query": "…"}` and `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` (one request = one session), or the dashboard SQL editor. `npx supabase functions deploy <name> --no-verify-jwt --use-api` works normally. `supabase db push`/`db pull` still need the database password, which no agent has.

## TESTING PERFORMED (2026-09-25, eighteenth session — both halves)

- **TASK-007 (media)**: no product code changed, so only the live check was new — `live_media_check.py` **32/32**; `media_e2e.py` **29/29** and `teacher_e2e.py` **36/36** re-run locally green.
- **ISSUE-023 (exam delete rule)**: backend `deno test --allow-env backend/` **118 passed / 0 failed** (was 114; four new tests in `exams.test.ts`), frontend unit `deno test --allow-env --allow-read --no-check frontend/tests/unit/` **31 passed**, and **all eleven browser suites** run one after another like CI with **zero failures**: teacher 36, question bank 57, question editor 75, media 29, question import 43, **exams 37** (was 28: nine new checks), student 61, results 79, monitor 30, dashboard 34, audit 25. Live: `live_exam_delete_check.py` **17/17**, run twice (the first run exposed the minute-bucketed `rate_limits` sweep, fixed, re-run clean).
- Everything above was run **before** the docs were written, on the pushed `ai-development`; watch the Actions runs for this session's two commits.

## TESTING PERFORMED (2026-09-25: the whole project re-run from scratch, all green)

- Backend: `deno test --allow-env backend/` → **114 passed, 0 failed**.
- Frontend unit: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed, 0 failed**.
- Browser (mocked, dev server on 8123, one suite after another exactly like CI): all **eleven** green — teacher 36, question bank 57, question editor 75, media 29, question import 43, **exams 28** (was 27; the new check pins the guard fix), student 61, results 79, monitor 30, dashboard 34, audit 25. Every suite exit 0, zero `FAIL` lines.
- Falsification of the guard fix: with the old semantics temporarily restored, `exams_e2e.py` dies at the new reload (`Page.reload` timeout after 21 checks). So the new check really catches the defect, not just a happy path.
- Diagnostics that settled ISSUE-022 (standalone probes, not committed): a busy-renderer hash/reload probe, and a `beforeunload` probe showing that with a `page.on("dialog")` listener a fired warning makes `page.reload()` hang for its whole timeout, while without a listener Playwright auto-dismisses it and navigation proceeds.
- Live: the rolled-back SQL test and the admin smoke listed above, plus the Auth configuration verification.
- `question_editor_e2e.py`'s older toast-animation flake (a click racing a toast, `<html> intercepts pointer events`) is unrelated and still stands — it passed every run here.

## DATABASE CHANGES (2026-09-25, eighteenth session, ISSUE-023)

- **One migration applied live**: `supabase/migrations/20260930000000_exam_delete_with_attempts.sql` (replaces `list_exams` and `remove_exam`, drops the old two-argument `remove_exam`). Re-running it is safe (both objects are re-created; the drops are `if exists`). Nothing else changed: no table, column, policy, RLS state or grant (both functions keep the same ACL: `postgres` + `service_role` only).
- **One Edge Function redeployed**: `exams` **v3 → v4** (`python backend/sync_functions.py`, then `npx supabase functions deploy exams --no-verify-jwt --use-api`). The others are untouched: `auth-me` v1, `question-bank` **v7**, `media` v1, `session` v1, `results` v4, `audit` v1 — all ACTIVE, `verify_jwt=false`. (The v7 for `question-bank` is a live fact worth keeping: the older notes say v3.)
- Live rows after the work: 40 questions, 0 media files, 0 objects in `question-media`, 2 profiles, **1 exam + 1 session (the owner's own test — do not touch)** and 6 `rate_limits` rows from the owner's 07:1x run. `audit_logs` ≈ 32 rows (nine from the media check, four from the delete-rule check, the rest real owner/admin activity).

## DATABASE CHANGES (2026-09-25, eighteenth session, TASK-007)

- **No SQL was applied and no schema, policy, function or Edge Function was changed.** The media check created one question, two `media_files` rows, two `question_media` rows and two Storage objects, then deleted all of them; the bucket's object count before and after is identical (0).
- The only lasting trace is **9 `audit_logs` rows** (3× `question.create`, 6× `media.upload`, 12:14–12:16 UTC) — a truthful record of a real staff action; leave them.
- **The owner's own live test is in the database and must not be touched**: exam `3ad8eb38` ("test", code `4KHU2A`, `closed`) + one submitted session (`jonathan`, `XII TKJ A`). That is why `exams`/`sessions` are 1/1 now rather than 0/0 (see ISSUE-023).

## DATABASE CHANGES (2026-09-25, seventeenth session)

- **No SQL was applied by that session** — the audit migration was already live. Row counts unchanged before and after every check: 40 questions, 4 audit rows, 0 exams, 0 sessions, 2 profiles.
- **The one live change was configuration:** `external_email_enabled: true` (with `disable_signup: true` kept), fixed through the Management API after the owner approved it in this conversation. No data, no schema, no policies.
- Live state for the next agent: Edge Functions `auth-me` v1, `question-bank` v3, `media` v1, `exams` v3, `session` v1, `results` v4, **`audit` v1** — all ACTIVE, `verify_jwt=false`; **61** public SQL functions; `supabase_migrations` newest row `20260925001719 v2_16_audit_functions`.

## FILES CHANGED (2026-09-25, eighteenth session — ISSUE-023)

- **New:** `supabase/migrations/20260930000000_exam_delete_with_attempts.sql`, `frontend/tests/live_exam_delete_check.py`.
- **Changed:** `backend/functions/exams/handler.ts` (body before auth; `hard: true` ⇒ admin-only, `p_force`), `frontend/assets/js/teacher/api/exams.js` (`remove(id, hard)`), `frontend/assets/js/teacher/screens/exams.js` (role-aware row, attempt text, permanent-delete dialog), `backend/tests/exams.test.ts` (4 new tests), `frontend/tests/exams_e2e.py` (9 new checks), `frontend/tests/mock_server.py` (`session_count`, the close-vs-delete rule, a switchable `role`).
- **Docs:** `docs/sql-exams.md` (the delete rule + its live record), `.ai/{02_ARCHITECTURE,03_FEATURES,04_CURRENT_STATE,05_TASK_QUEUE,06_DECISIONS (DEC-027),07_CHANGELOG,08_HANDOFF,09_KNOWN_ISSUES}.md`, `frontend/README.md`, `supabase/README.md`.

## FILES CHANGED (2026-09-25, eighteenth session — TASK-007)

- **New:** `frontend/tests/live_media_check.py` — the live media check (32 checks; signs in with the staff test account, drives the real editor, verifies Storage, the database, playback, refusals and its own cleanup). Not part of CI, credentials from the environment, same convention as the other `live_*_check.py` scripts.
- **Docs corrected:** `.ai/03_FEATURES.md` (F-07 → LIVE-VERIFIED), `.ai/04_CURRENT_STATE.md`, `.ai/05_TASK_QUEUE.md` (TASK-007 → COMPLETE; new next-task line), `.ai/06_DECISIONS.md` (DEC-011 → live-verified), `.ai/07_CHANGELOG.md`, `.ai/08_HANDOFF.md` (this file), `.ai/09_KNOWN_ISSUES.md` (ISSUE-002 closed, **ISSUE-023 added**), `frontend/README.md` (the live-check list).
- **No product file was changed** — `frontend/assets/js/teacher/api/media.js` and `backend/functions/media/handler.ts` were verified, not edited.

## FILES CHANGED (2026-09-25, seventeenth session — git `7a5b09e` plus that session's docs commit)

- **Fixed (the behavior change):** `frontend/assets/js/teacher/guard.js` (`setLeaveGuard(fn, hasUnsavedWork?)`, `hasUnsavedChanges()`), `frontend/assets/js/teacher/router.js` (ask and URL hold-back only while something is unsaved), `frontend/assets/js/teacher/screens/{examEditor,questionEditor,questionImport}.js` (pass their synchronous dirt predicate), `frontend/tests/exams_e2e.py` (wait for the target screen before reloading; new "untouched editor reloads with no leave warning" check).
- **Corrected (the docs that had the live state wrong):** `.ai/{02_ARCHITECTURE,03_FEATURES,04_CURRENT_STATE,05_TASK_QUEUE,07_CHANGELOG,08_HANDOFF,09_KNOWN_ISSUES}.md`, `docs/sql-audit.md`, `supabase/tests/audit_functions_test.sql` (header), `supabase/migrations/20260929000000_audit_functions.sql` (header), `frontend/README.md`.
- Not a file change, but it is corrected everywhere now: the sixteenth session's `npx supabase db query --linked --file …` instruction was wrong (no such subcommand in CLI 2.117.0).

## REMAINING WORK

1. **Nothing is pending on TASK-007 or the audit viewer** — do not re-run or re-apply either one (see the two LIVE VERIFICATION PERFORMED sections above).
2. **No release blocker is open.** The merge of `ai-development` into `main` is the owner's decision (DEC-020) and needs the DEC-021 import reconciliation; the previous session's CI runs were green at `2fcce90`.
3. Ordinary next code task: the TASK-015 remainder — scheduled purge jobs need pg_cron on the live project; notifications need the owner's email-provider decision (DEC-017); backups likewise need live access.
4. Owner decisions wanted: what belongs on the PDF class summary (the last TASK-012 piece) and whether the proposed import formats are accepted. (The exam-delete question was answered by the owner and is implemented — DEC-027.)
5. Low-priority follow-up: reconcile the already-live but untracked migration rows (ISSUE-001), using a real DB connection/password.

## SUGGESTED WORK FOR NEXT AI

1. Start on `ai-development`; run `git status --short --branch` and `git pull --ff-only` **before** changing anything.
2. Read `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `09_KNOWN_ISSUES.md`, and this file. Let source code, database facts, tests, and git history win over stale `.ai/` notes.
3. If you have a live Supabase connection, read LIVE VERIFICATION PERFORMED above first — the audit slice is already live and verified; do not re-apply or redeploy it.
4. **Ask the owner about ISSUE-024 before touching TASK-020** (its backend is already live from another session), then continue with the TASK-015 remainder or that task. Do not invent a random feature if the queue is empty; audit documented debt instead.
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
- Do not delete the owner's live test exam `3ad8eb38` ("test", code `4KHU2A`) or its submitted session, and do not "clean up" the 9 `audit_logs` rows the media check produced — they are real records, not test fixtures (ISSUE-023).
- Do not change `remove_exam`'s close-instead-of-delete rule, or give a teacher the permanent delete, without a new owner decision (BR-10 / DEC-012 protect attempt history; DEC-027 records the current split).
- Do not re-apply `20260930000000_exam_delete_with_attempts.sql` or redeploy `exams` — it is live as v4 (2026-09-25), and re-applying the migration is harmless but pointless.
- Do not add a force-less `remove_exam` overload back: the two-argument version was dropped on purpose so nothing can delete an exam with attempts by accident.
- Do not commit, rewrite, or re-implement the live-only TASK-020 SQL/Edge code of another session (ISSUE-024) without the owner's word: it is someone else's in-flight work, and two implementations of the duplicate scan is exactly the DEC-021 mistake repeating.
- Do not add media handling to the CI suites — `live_media_check.py` is a live check and stays out of CI, like the other `live_*` scripts.
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
