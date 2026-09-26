# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## RELEASE STATUS

**TASK-015 notifications — dashboard half implemented (2026-09-26, DEC-032).** The owner chose option 4: dashboard notifications first, email deferred. `frontend/assets/js/teacher/screens/dashboard.js` now derives notices from the existing results activity and exam overview payloads: pending essays, page-exit flags and newly submitted results. Notices deep-link to existing Grading/Monitor/Results screens. Read state is browser-local and “Mark all read” is available. CSS and `dashboard_e2e.py` were updated. No SQL, Edge Function, email provider or new read path was added. The email half of TASK-015 remains pending a provider decision.


**`READY` — no release blocker is open.** The merge into `main` is the owner's decision (DEC-020) and needs the DEC-021 import reconciliation; nothing technical is missing.

**TASK-015's user-management slice is LIVE-VERIFIED (2026-09-26, twenty-second session, DEC-031)** — an admin creates a teacher's or another admin's account on `#/accounts` by typing the email address and a temporary password and handing it over (the owner's answer: no invitation email, because the free plan has no working mailer for this project), and renames, promotes, demotes, deactivates (**never** deletes) and re-passes people. The rules live in SQL (`_require_active_admin`, `list_accounts`, `record_account`, `update_account` with the two guards — nobody changes their own role or deactivates themselves, the last active admin stays — and `record_account_password`, which never records the password); the new `accounts` Edge Function (deployed, admin-only) calls the **Auth Admin API** for the login half and deletes a just-created login again if the database refuses the bookkeeping; and the audit trail gains `account.create` / `account.update` (with a `was` snapshot) / `account.password`. Evidence: backend **143**, `frontend/tests/accounts_e2e.py` **46 checks** (CI's thirteenth browser suite; the menu went 8 → 9), the rolled-back `account_functions_test.sql` passed live (`ACCOUNT TESTS PASSED (2 accounts, 1 active admins, 4 audit entries written and rolled back)`), and `frontend/tests/live_accounts_check.py` **44/44** — a throwaway account that really signed in with its typed password, honoured every change on its own next call, refused its old password after a change, and was deleted again with the project's own two accounts compared **row for row** before and after. **TASK-016's reason to exist is gone**: the teacher's real account, and the admin's real name, are now something the owner types on that screen. Contract: `docs/sql-accounts.md`.

**TASK-007 is COMPLETE and LIVE-VERIFIED (2026-09-25, eighteenth session)** — the last blocker. A real photo and a real MP3 were uploaded through the app **with the staff test account** to the live private bucket, saved on a question, reopened and played back; a forced oversized file was refused and deleted from Storage again; every row and object the run created was removed and verified gone. `frontend/tests/live_media_check.py` reports **32/32** (`ALL LIVE MEDIA CHECKS PASSED`). The `@supabase/storage-js` protocol reproduction was correct, so **no product code changed** — this was verification, not a fix. ISSUE-002 is closed.

**The TASK-015 scheduled purge jobs are LIVE-VERIFIED (2026-09-26, twentieth session, DEC-029)** — `pg_cron` + `pg_net` enabled live and three jobs running as `postgres`: `expire-sessions` every five minutes (BR-21), nightly `purge-rate-limits`, and nightly `purge-orphan-media` — the last one calling the deployed `media` function over `pg_net` with a **housekeeping key** kept in Supabase Vault and as the function secret `HOUSEKEEPING_KEY` (it opens only `purge_unused` and never becomes a staff identity), because file **bytes** can only be deleted through the Storage API. Evidence: `supabase/tests/scheduled_jobs_test.sql` (configuration, run live) and `frontend/tests/live_housekeeping_check.py` (**40/40**, end to end — the jobs fired, the attempt closed, the stale row went, the bytes left the bucket, the schedules were restored, nothing was left behind). The migration recorded its own `schema_migrations` row, so no new ISSUE-001 drift; ISSUE-012, ISSUE-018 and ISSUE-010 are closed, and **ISSUE-026** (`signed_urls` answered 500 for ids that no longer exist — found by the new live check) is fixed. Contract: `docs/sql-jobs.md`.

**The TASK-015 backup slice is LIVE-VERIFIED (2026-09-26, twenty-first session, DEC-030)** — an admin takes a copy by hand on `#/backups` and the project takes one nightly at 02:41 Jakarta (the fourth `cron.job` row, reusing DEC-029's Vault housekeeping key over `pg_net` and opening `create` only). **A copy is one ZIP** in a new private `backups` bucket: `data.json` holds every table read through the `public.backup_tables()` allowlist (22 names — the contract), the applied migrations and a media manifest; `media/<path>` holds the bytes of every file really attached to a question or a reading text. The database reads itself and keeps the table honest (`build_backup_payload`, `record_backup` — including the retention sweep — `list_backups`, `get_backup`, `delete_backup`), while zipping, signing, uploading and deleting are the Edge function's job, because only the Storage API can move bytes. **Retention**: the newest **7 automatic** copies are kept, **manual copies until an admin deletes them** (rows prune in SQL, files go through the function; both audited). Evidence: `supabase/tests/backup_functions_test.sql` and the extended `scheduled_jobs_test.sql` (both run live, `BACKUP TESTS PASSED (7 functions, 22 tables, 0 stored copies, nothing written)` / `SCHEDULED JOBS TESTS PASSED (4 jobs active, key 64 chars, nothing written)`), `frontend/tests/backups_e2e.py` (**42 checks**, CI's twelfth browser suite; the menu went 7 → 8) and `frontend/tests/live_backup_check.py` (**63/63**, `ALL LIVE BACKUP CHECKS PASSED`: a real archive downloaded through its signed link and opened with `zipfile` — byte-identical media inside, every table's count equal to the live count, the owner's real exam `4KHU2A` inside — then the eighth automatic copy pruning exactly one row **and its file** while the manual one survived, and the job fired by pg_cron itself with `net._http_response` 200). Contract: `docs/sql-backups.md` (it also documents how to restore an archive by hand, and that copies still live in the same project as the data they protect — off-site copies wait for hosting, TASK-017).

**TASK-020 is COMPLETE and LIVE-VERIFIED (2026-09-25, nineteenth session)** — the duplicate-overview banner from mockup 6 is on the question list. The backend arrived as another session's **live-only** work (the drift that was ISSUE-024): its two live statements were committed **verbatim** out of `supabase_migrations.schema_migrations.statements` (DEC-028, file names = live version numbers, nothing re-applied) and the `duplicate_groups` action was matched to the deployed function; the screen side (banner + Review dialog) was then written on top. `frontend/tests/live_duplicates_check.py` reports **15/15** against the real project, read-only. The staff password is **no longer needed** for that check: with `SUPABASE_ACCESS_TOKEN` it mints a one-time login link. ISSUE-024 is closed; `docs/sql-duplicates.md` has the contract.

**ISSUE-023 is fixed the same day (DEC-027, live at `exams` v4)**: an exam that already has attempts now says so in the list, a teacher cannot delete one (no Delete button, and the SQL would close it), and the **admin** can permanently delete it behind a dialog that names the attempt count and the answers, grades and results that go with it. `frontend/tests/live_exam_delete_check.py` **17/17**.

**Live hazard found and fixed on 2026-09-25 (ISSUE-007)** — worth remembering: the owner's "disable public sign-up" step had switched the **Email provider off entirely** (`external_email_enabled: false`), so every staff sign-in answered `HTTP 422 email_provider_disabled` and the teacher app was unusable. It is fixed and verified (provider on, `disable_signup: true` kept: a real sign-up attempt is refused with `signup_disabled`, admin sign-in returns 200). **After any dashboard change, re-read `GET https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings` (publishable key as `apikey`) and check both halves: sign-ups refused AND a staff sign-in still works.** Turning a provider off is not the same as disabling sign-ups.

The staff test account `testguru211l@gmail.com` (`profiles`: `role = 'teacher'`, `is_active = true`; 2 profiles live) is what the media check signs in as; its password was supplied by the owner through chat and must not be committed. **Sandbox limitation reminder**: a claude.ai chat session's network cannot reach `*.supabase.co`/`*.supabase.com` at all (confirmed via `x-deny-reason: host_not_allowed`) — Storage upload, Edge Function calls and the Auth password-grant login all need HTTP access to that host. **This Windows/Codebuff clone can reach it** (that is how every live check in this file was run); a claude.ai chat session cannot.

Do not merge `ai-development` into `main` without the owner's explicit go-ahead (DEC-020); when it happens, resolve the DEC-021 import files in favour of `ai-development`.

## BRANCH CONTEXT

| | |
|---|---|
| Stable branch | `main`. Do not develop or merge here without the owner's explicit decision. |
| Development branch | **`ai-development`**. The twenty-second session started at `c4ac2f7` (clean tree, in sync with `origin/ai-development`; `git fetch` was the first command, per the post-collision rule — nothing had moved) and pushed **the user-management slice** — `1218caa` (the feature) and its `.ai/` docs commit, with a records/CI commit on top. Before it, the twenty-first session started at `d4502da` (clean tree, in sync with `origin/ai-development`; `git fetch` was the first command, per the post-collision rule — nothing had moved) and pushed **the backups slice** — `5c6e685` (the feature) and `3cb714c` (its `.ai/` docs), with this records/CI commit on top. The twentieth session pushed `eedf6d4` (the scheduled jobs + the ISSUE-026 fix) and `e4820a6` (its `.ai/` docs), then `d4502da` (their hashes/CI). History below it: `857b096`/`cc2b0d5` (TASK-020), `cdad496`/`5252359` (ISSUE-023), `d99ca92` (TASK-007). All pushed. |
| Starting point | `c4ac2f7` — `git status --short --branch` showed a clean tree, in sync with `origin/ai-development` (the twenty-second session's `git fetch` was the first command, and nothing had moved). (The twenty-first started from `d4502da`, the nineteenth from `b520f80`; the eighteenth from `2fcce90`.) |
| Push / CI status | **Both workflows green on `bd7c78c`** (Backend tests 36213053547 + Frontend tests 36213053640, 2026-09-26 — the first run of the thirteenth browser suite; the records commit on top carries no code change). Locally in the twenty-second session: backend **143**, unit **31**, all thirteen browser suites green, the rolled-back `account_functions_test.sql` passed live and the live accounts check **44/44**; before it: **both workflows green on `3cb714c`** (Backend tests + Frontend tests, 2026-09-26 — the first run of the new twelfth browser suite) and on `e4820a6`/`d4502da` (twentieth session). Locally in the twenty-first session: backend **130**, unit **31**, `backups_e2e.py` **42 checks**, the five suites re-run by hand (teacher, monitor, audit, dashboard, backups) green, both live SQL tests passed, and the two live checks **40/40** (housekeeping) and **63/63** (backups). The new suite's first CI run was green (all twelve browser steps). The nineteenth session's head was `d00a77d` (both workflows green, 2026-09-25), where locally: backend **120**, unit **31**, all **eleven** browser suites green, live duplicate check **15/15**. (For the eighteenth session: green on `b520f80`.) One red run on the way back then — the Frontend `cc2b0d5` was pushed together with its docs, so `d00a77d` carries its run. Locally this session: backend **120**, unit **31**, all **eleven** browser suites green, and the live duplicate check **15/15**. (For the eighteenth session, both workflows were green on `b520f80`.) One red run on the way back then — the Frontend **Question editor** step failed on the docs-only `b799af1` after all its checks had passed, and **passed on re-run**: that is the known flake, now written up as **ISSUE-025** with its real mechanism and a suggested fix. Locally: backend **118**, unit **31**, all **eleven** browser suites green after the exam-delete change; the two live checks 32/32 and 17/17. |
| Live database | **English_Test_v2** (`lbhnadqmokloyfarrzfv`). Do not touch the v1 project `Exam_Data_Base`. |

## LAST AGENT

Buffy — twenty-second session, 2026-09-26 (Windows clone with real network + Supabase Management API access). On the owner's "continue the project to the next step" it took the next recommended item — the TASK-015 remainder — and, of the two halves left, the one that needs no external provider: **user management**. Two questions went to the owner **before anything was built** (the discipline that produced DEC-029 and DEC-030): how a new person should receive their login, and what happens to somebody who leaves. His answers became **DEC-031** — the admin types the email and a temporary password and hands it over; deactivate, never delete — and the work followed: migration `20260926021234_account_functions.sql` applied live **with its own `schema_migrations` row in the same session** (no new ISSUE-001 drift), the `accounts` Edge Function deployed, the admin screen `#/accounts` with its hand-over panel, 13 new backend tests (130 → **143**), a **46-check** browser suite (CI's thirteenth step), the rolled-back SQL test run live, and `frontend/tests/live_accounts_check.py` **44/44** against the real project — a throwaway account that really signed in, was renamed, promoted, demoted, deactivated, reactivated and re-passed (its old password refused afterwards), then deleted again with the project's own two accounts compared **row for row**. The live project has exactly **one active admin** (the owner), so the last-admin guard refuses to demote or deactivate him — as designed. Nothing belonging to the owner was touched (2 auth users, 0 strays, 2 profiles, 0 `account.%` audit rows before and after). **TASK-016 is unblocked by this**: the teacher's account is now a two-minute screen action, not a database insert.

### Previous session — twenty-first, 2026-09-26 (the backup slice, DEC-030)

The owner was asked first (what a copy must contain, how long to keep it, where the admin takes one) and chose everything including the media bytes, the newest 7 nightly copies with manual ones kept until deleted, and a `#/backups` screen. A backup became **one ZIP** in a new private `backups` bucket (`data.json` + `media/<path>`), built by seven SQL functions with the Edge layer zipping, signing and touching Storage (the DEC-029 split), retained by `record_backup`, and taken nightly by the fourth `pg_cron` job at 02:41 Jakarta through the same Vault housekeeping key (`create` only). Evidence: `backup_functions_test.sql` and the extended `scheduled_jobs_test.sql` both run live, `backups_e2e.py` (42 checks, CI's twelfth suite) and `live_backup_check.py` **63/63** — a real archive downloaded through its signed link and opened, the owner's exam inside, the eighth automatic copy pruning a row **and its file**, the job fired by pg_cron itself. Contract: `docs/sql-backups.md`.

### Previous session — twentieth, 2026-09-26 (the scheduled purge jobs, DEC-029)

Buffy — twentieth session, 2026-09-26 (Windows clone with real network + Supabase Management API access). On the owner's "continue the project to the next step" it took the queue's **next recommended** item — the TASK-015 remainder — and did the half that needs no owner decision, after **asking the owner** the one question it could not answer alone: how the nightly media sweep should be allowed to delete files. The answer ("a narrow housekeeping key, not the service-role key") became **DEC-029**, and the work followed: `pg_cron` + `pg_net` enabled live, three jobs scheduled, a housekeeping key generated into Vault and mirrored as the `media` function secret, the `media` handler given a scheduled door that opens exactly one action, seed-and-backdate fixtures proving each job's effect through `cron.job_run_details` and `net._http_response`, and two new committed checks (`supabase/tests/scheduled_jobs_test.sql`, `frontend/tests/live_housekeeping_check.py` **40/40**). It also found and fixed **ISSUE-026** (`signed_urls` 500 for ids that no longer exist — storage refuses to sign an empty list) and closed ISSUE-012, ISSUE-018 and the stale ISSUE-010. The migration recorded its own `schema_migrations` row so the live project and git agree. Nothing that belonged to the owner was deleted — the live project's own exam/attempt were counted before and after.

### Previous session — nineteenth, 2026-09-25

Buffy — nineteenth session, 2026-09-25 (Windows clone with real network + Supabase Management API access). On the owner's instruction it did two things in one task: **brought another session's live-only TASK-020 backend into git verbatim** (`find_duplicate_groups` and its `search_path` fix copied out of `supabase_migrations.schema_migrations.statements` into migration files named after their live versions, DEC-028; the `duplicate_groups` action added to the question-bank handler and proved identical to the deployed function by re-downloading it) and **finished the half that was missing** — the question-list banner and its Review dialog, with the count coming from the server and the scan asked for once per visit. Tests went backend 118→120, `question_bank_e2e.py` 57→67, and the new read-only live check `frontend/tests/live_duplicates_check.py` is **15/15**, signing in as the staff test account **without its password** (a one-time login link minted with the Management token — reusable for future live checks). Nothing was re-applied to the live database and nothing was written to it. ISSUE-024 is closed.

**Previous session — eighteenth, 2026-09-25.** It closed the last release blocker by running the **first real media upload** against the live project with the staff test account, through the app's own editor, and turned that run into the committed live check `frontend/tests/live_media_check.py` (**32/32**). It changed **no product code** there (the upload protocol was already right) and deleted everything it created. Then, from the live audit log, it found **ISSUE-023** (the owner's five Delete attempts on an exam that had attempts), **asked the owner** what should happen instead of guessing, and implemented the answer end to end — migration applied live, `exams` redeployed as v4, a role-aware exams screen, backend tests 114→118, the browser suite 28→37 checks, and the new live check `frontend/tests/live_exam_delete_check.py` (**17/17**). The owner's own live exam/session were left untouched.

## CREDENTIAL / COLLISION WARNING

- Earlier sessions used an owner-supplied Supabase access token and the admin password for live checks. They were not committed, but both have travelled through chat and should still be revoked/rotated by the owner.
- Two earlier AI sessions built overlapping features concurrently. Always fetch/read `origin/ai-development` before starting, and confirm with the owner that no other agent is active before live-DB writes or pushes.
- **ISSUE-024 (found 2026-09-25, CLOSED the same day) is the useful example**: TASK-020's backend existed in the live project with no file and no commit, and the right move was **not** to re-implement it — the owner was asked, said to bring it in, and the live statements came out of `supabase_migrations.schema_migrations.statements` **verbatim** (DEC-028). Before starting anything that smells like someone else's work: `git fetch`, read `origin/ai-development`, and check the live migration history and deployed functions.
- **Live checks no longer need the staff password in chat**: set `SUPABASE_ACCESS_TOKEN` and let the check mint a one-time login link (`POST /auth/v1/admin/generate_link` → `POST /auth/v1/verify`). First used by `live_duplicates_check.py`; `live_housekeeping_check.py` uses it for the **admin** account too. The older live checks still read `SUPABASE_TEST_PASSWORD`/`SUPABASE_ADMIN_PASSWORD`, which the owner should still rotate.
- **The scheduled jobs brought a new secret into the project** (DEC-029): `HOUSEKEEPING_KEY` as a function secret, mirrored by `vault.secrets.housekeeping_key`. It is deliberately narrow (one action), it is never in the repository, and rotating it is a Vault update + a secret update — `docs/sql-jobs.md` has the exact steps. Do not paste it into chat; read it out of Vault on the machine that needs it.

## LAST COMPLETED TASK

**The TASK-015 user-management slice — an admin can run the staff accounts, and the rules that must never break live in SQL (DEC-031, live-verified 2026-09-26).**

design.md's User Management module ("Buat dan nonaktifkan akun guru/admin", an admin job per 1.2) and TASK-016 were both open for the same reason: the only way to make an account was the Supabase dashboard. Two questions had no default answer, so **the owner was asked before anything was built**:

- **How does a new person get their login?** His answer: **the admin types the email and a temporary password and hands it over.** No invitation email — the free plan has no working mailer for this project (sign-ups off deliberately, ISSUE-007; SMTP unconfigured) — so the screen shows a suggested 12-character password (no `0/O/1/l/I`, so it can be read aloud) once, in a hand-over panel with a Copy button.
- **What happens to somebody who leaves?** His answer: **deactivate, never delete.** A profile is what the audit trail and every `created_by` row point at, and a recreated account is a different id.

What is live:

- **SQL** `supabase/migrations/20260926021234_account_functions.sql` — applied live **and recorded as `20260926021234` / `account_functions` in the same session** (8,339 chars): `_require_active_admin` (only an active admin acts), `list_accounts` (auth.users joined for the email and last sign-in; admins first, then by name), `record_account` (profile row + `account.create`), `update_account` with **the two guards** — nobody changes their own role or deactivates themselves, and the last active admin cannot be demoted or deactivated — plus a `was` snapshot in every `account.update` entry, and `record_account_password` (`account.password`; never the password). All five revoked from `public`/`anon`/`authenticated`. Live public SQL functions 69 → **74**.
- **Edge** `backend/functions/accounts/` — deployed, **admin-only** (the second endpoint after `audit`): `list` / `create` / `update` / `password`. The login half is the Auth Admin API (only the service role may); if the database refuses the bookkeeping after a create, the just-created login is **deleted again**.
- **Screen** `#/accounts` — Name / Email / Role / Status / Last signed in, the signed-in row marked "(you)" with its controls disabled, a role select, deactivate/reactivate behind a confirm, and the hand-over panel (the dialog closes before it appears, so the panel is never hidden behind it). `ADMIN_NAV` is nine items now.
- **Verified**: backend 130 → **143**; `accounts_e2e.py` **46 checks** (CI's thirteenth browser suite); `account_functions_test.sql` run live → `ACCOUNT TESTS PASSED (2 accounts, 1 active admins, 4 audit entries written and rolled back)`; `live_accounts_check.py` **44/44** with the live project's own two accounts compared row for row before and after. Contract: `docs/sql-accounts.md`.

**TASK-016 is unblocked by this** — the teacher's real account and the admin's real name are now typed on that screen, not inserted by an agent. **Notifications are the only piece of TASK-015 left** (they need the owner's provider decision, DEC-017).

### The session before — the backup slice (DEC-030, live-verified 2026-09-26, twenty-first session)

An admin takes a copy by hand on `#/backups` and a fourth `pg_cron` job takes one nightly at 02:41 Jakarta; a copy is **one ZIP** in a new private bucket holding every table (the 22-table allowlist) plus the attached media bytes, with the newest 7 nightly copies kept and manual ones until deleted. `live_backup_check.py` **63/63** — a real archive downloaded and opened, the owner's exam inside, the eighth nightly copy pruning a row **and its file**. Contract: `docs/sql-backups.md`.

### The session before that — the scheduled purge jobs (DEC-029, live-verified 2026-09-26, twentieth session)

**The TASK-015 scheduled purge jobs — the database now cleans up after itself (DEC-029, live-verified 2026-09-26).**

Phase 7 asks for work nobody should have to remember: close the sessions a student walked away from (BR-21), drop spent rate-limit windows, delete the uploads nobody ever attached. All three SQL functions had existed for days — nothing called them (ISSUE-012, ISSUE-018).

- **The clock lives in the database** (`docs/sql-jobs.md`): `supabase/migrations/20260926002454_scheduled_housekeeping_jobs.sql` enables `pg_cron` 1.6.4 + `pg_net` 0.20.4 and schedules three jobs, active, running as `postgres` (job ids 1/2/3): `expire-sessions` `*/5 * * * *` → `select public.expire_sessions()`; `purge-rate-limits` `19 19 * * *` → `select public.purge_rate_limits()`; `purge-orphan-media` `29 19 * * *` → `net.http_post(…/functions/v1/media, x-housekeeping-key: <Vault>, {"action": "purge_unused"})`. The two nightly jobs never share a minute; the times are 02:19 and 02:29 Jakarta.
- **Why the media job is an HTTP call**: `purge_orphan_media()` deletes the rows, but the **bytes** are in Storage and only the Storage API removes them (what the admin's Purge button already did). A database-only job would delete the bookkeeping rows and leave the files with nothing pointing at them — a silent leak. **The owner was asked** and chose a narrow key over the service-role key in Vault.
- **The housekeeping key**: generated in the migration into `vault.secrets` (`housekeeping_key`, 64 hex chars), mirrored as the function secret **`HOUSEKEEPING_KEY`** through the Management API (the one step a migration cannot do), and **never in the repository** — the live check greps the whole tree for it. `_shared/auth.ts#isScheduledJob` hashes both sides and compares byte by byte; `media` returns before `requireStaff` for it, so it is never a staff identity and opens **exactly one action**. Rotation = a Vault update + a secret update, no code change.
- **Applied live without adding drift**: the file went to the Management API query endpoint (CLI 2.117.0 still has no `supabase db query`; `npx` fetched 2.118.0 for the function deploy) **and the same session inserted the matching `supabase_migrations.schema_migrations` row** (`20260926002454` / `scheduled_housekeeping_jobs`, statements = the file byte-for-byte), so `supabase db push` will treat it as applied. ISSUE-001's older gap still needs a real DB connection.
- **Verified live**: `supabase/tests/scheduled_jobs_test.sql` → `SCHEDULED JOBS TESTS PASSED (3 jobs active, key 64 chars, nothing written)`; `frontend/tests/live_housekeeping_check.py` → **40/40** (`ALL LIVE HOUSEKEEPING CHECKS PASSED`), which builds its own orphan upload (real bytes in the bucket, row backdated two days), a stale `rate_limits` row and a throwaway exam whose single attempt is backdated past the tolerance, points the three jobs at the next minute, waits for `cron.job_run_details` to show all three **succeeded** and `net._http_response` to show **HTTP 200** with `removed`, then checks every effect — including that **listing the bucket proves the bytes are gone** — restores the schedules, deletes everything it created and compares the counts with the ones it started from.
- **The owner's live data was left untouched** (exam `4KHU2A`, one submitted attempt): the check counts rows before and after rather than assuming an empty project. **Do not "clean up" the live project — it now holds real owner data.**
- **Also fixed (ISSUE-026)**: `signed_urls` asked Storage to sign an empty list when none of the ids exist any more, which Storage refuses, so the app answered `500 internal_error`; it now returns `{urls: {}}` with a pinned unit test. Backend tests **120 → 122**.

### Earlier the same tail of work — the nineteenth session (TASK-020)

**TASK-020 — the question list now notices questions that look like copies, and another session's live-only scan is in git verbatim (DEC-028, ISSUE-024 closed, live-verified 2026-09-25).**

Mockup 6 shows a banner over the question bank — *"N questions look like duplicates of each other."* with a **Review** action — and the live project already had the SQL for it (`find_duplicate_groups`) plus a `duplicate_groups` action on the deployed `question-bank`, none of it in this repository (ISSUE-024). The eighteenth session refused to commit someone else's in-flight work; the owner then asked for it to be brought in and finished.

- **Recovered verbatim (DEC-028)**: `supabase/migrations/20260925060607_v2_17_duplicate_overview.sql` and `20260925060638_v2_17_duplicate_overview_fix_search_path.sql` are the live statements copied out of `supabase_migrations.schema_migrations.statements` — **file names = live version numbers**, so a later `supabase db push` recognises them as applied. Nothing was re-applied live. `docs/sql-duplicates.md` keeps a script that re-proves this (`VERBATIM` for both); it is the recipe to reuse if live-only SQL is found again.
- **Edge matched, not guessed**: `backend/functions/question-bank/handler.ts` gained the same 3 lines the deployed function has (`duplicate_groups` in `ACTIONS`, and a case calling `callRpc(db, "find_duplicate_groups")` with **no arguments** — the SQL defaults are the contract). Verified by re-downloading the deployed function and diffing: identical. **Downloader gotcha for the next session**: `supabase functions download` returns every bundle's shared `text.ts` with `&lt;` turned into `<` (proved against `exams`, which was deployed from this repo minutes earlier) — normalize that before concluding a function differs.
- **Screen** (`screens/questionBank.js`, new `components/duplicateGroupsDialog.js`, `api/questionBank.js`, CSS from the mockup's `--mark`/`--mark-tint`): the banner carries the server's own count, is requested **once per visit** (never on a filter change), reappears after archive/restore/delete, and is simply hidden if the scan fails — the list never fails because of it. **Review** opens one section per group ("Same text (2 questions)" or "57% alike"), each question linked to its own editor with its used-count, and the dialog closes itself when the address changes so a link never leaves it on top of the editor.
- **Verified live, read-only** (`frontend/tests/live_duplicates_check.py`, **15/15**): as the staff test account (`role: teacher`) the real 40-question bank reports **6 questions that look duplicated (0 exact groups, 3 similar pairs)**; the deployed action, the SQL function asked directly and the banner all report the same number; filtering runs no second scan; Review lists the same groups; tokenless call 401; no page errors. Nothing was written, so there is nothing to clean up.
- **Tests**: backend **120** (the action's no-argument call, its payload passthrough, teacher *and* admin allowed), `question_bank_e2e.py` **67** (10 new), unit 31, all eleven browser suites green. Falsified first: with the banner switched off the suite dies on `waiting for locator(".banner:not([hidden])")`.

### Earlier the same day (eighteenth session)

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

## LIVE VERIFICATION PERFORMED (2026-09-26, twenty-second session) — user management

**Do not repeat this unless the accounts SQL, the `accounts` handler or the screen changes.** It needs no dev server and no browser: with `SUPABASE_ACCESS_TOKEN` set, one command does everything and cleans up after itself:

```
SUPABASE_ACCESS_TOKEN='…' python frontend/tests/live_accounts_check.py
```

What it proves (44 checks, `ALL LIVE ACCOUNT CHECKS PASSED`): the starting state is the project's own two accounts with no account history; the admin signs in by one-time link; the deployed function lists them with emails and last sign-ins, admin first; a tokenless call is 401 and a teacher is 403 on `list` and `create`; a throwaway `accounts-check-…@example.com` is created with a random typed password that **really signs in** (password grant), is called a teacher with the typed name by `auth-me`, can use `question-bank` and cannot touch `accounts`; the creation is audited and the list shows three; a duplicate address, a bad address and a short password are refused **before** anything is created; renaming moves the person's own `fullName` and the audit entry carries the `was` snapshot; promoting makes the promoted person able to `list` and demoting takes it away (403 again); deactivating stops the person at the front door (403 from `auth-me`) while the sign-in service still accepts their password — the gate is the application's (DEC-003) — and their profile and history stay; reactivating brings them straight back; a new password works, the old one answers 400, and the audit entry holds neither of them; the guards refuse self-demotion, self-deactivation and an unknown id with 400 and the right sentence. Then it deletes the throwaway auth user through the Auth Admin API, removes its `account.%` audit rows, and compares the project's two accounts **row for row** with the ones read at the start; its `wipe_check()` also clears anything a half-finished earlier run left under the `Live Accounts Check` name. One bug was found in the check itself while writing it: the Management API's query endpoint returns a **list of rows**, so `accounts_state()` had to unwrap its single row (the same shape `live_backup_check.py` uses).

Do **not** expect an empty project: the live project holds the owner's own exam and attempt, and the check counts and compares instead of assuming.

## TESTING PERFORMED (2026-09-26, twenty-second session)

- `deno test --allow-env backend/` → **143 passed**, 0 failed (was 130; `backend/tests/accounts.test.ts` adds 13).
- `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed**.
- All **thirteen** browser suites green locally against `dev-server.py 8123` (teacher, question_bank, question_editor, media, question_import, exams, student, results, monitor, dashboard, audit, backups, accounts). `media_e2e.py` failed once on "an upload in progress is shown" — that check races the download and passed on re-run — so it is noted with ISSUE-025's family.
- `python frontend/tests/accounts_e2e.py` → **46 checks, all pass**. Its gotchas, for the next session: read the hand-over password with `inner_text`, not `input_value`; the mock receives a `list` call on every reload, so assert "has been called" rather than "the last call"; and the screen deliberately re-sends a refused create, so expect **two** create calls in that flow.
- `git diff --check` clean; `deno check` on the new function clean.

## DATABASE CHANGES (2026-09-26, twenty-second session)

`supabase/migrations/20260926021234_account_functions.sql` — applied to the live project through the Management API query endpoint **with its own `supabase_migrations.schema_migrations` row written in the same session** (recorded as `20260926021234` / `account_functions`, statements byte-for-byte the file, 8,339 chars), so git and the live project agree and `supabase db push` will treat it as applied. It adds five functions, all `security definer` with `search_path = ''`, execute revoked from `public`/`anon`/`authenticated`. **No table, column, policy or bucket changed.** The Edge function was deployed with `python backend/sync_functions.py` + `npx --yes supabase@2.118.0 functions deploy accounts --no-verify-jwt --use-api`.

## FILES CHANGED (2026-09-26, twenty-second session — git `1218caa` plus its docs commit)

New: `supabase/migrations/20260926021234_account_functions.sql`, `supabase/tests/account_functions_test.sql`, `backend/functions/accounts/{handler.ts,index.ts}`, `backend/tests/accounts.test.ts`, `frontend/assets/js/teacher/api/accounts.js`, `frontend/assets/js/teacher/screens/accounts.js`, `frontend/tests/accounts_e2e.py`, `frontend/tests/live_accounts_check.py`, `docs/sql-accounts.md`.
Edited: `backend/functions/_shared/validate.ts` (`asEmail`), `frontend/assets/js/shared/icons.js` (the `users` icon), `frontend/assets/js/teacher/router.js` (`#/accounts`), `frontend/assets/js/teacher/screens/shell.js` (`ADMIN_NAV`, nine items), `frontend/tests/mock_server.py` (`handle_accounts` + fixtures + `fail_account`), `frontend/tests/{teacher_e2e.py,monitor_e2e.py}` (menu 8 → 9), `.github/workflows/frontend-tests.yml` (thirteenth step), and the docs (`.ai/01`–`09`, `docs/sql-accounts.md`, the three READMEs).

## LIVE VERIFICATION PERFORMED (2026-09-25, nineteenth session) — the duplicate banner

**Do not repeat this unless the banner, the scan or the question-bank handler changes.** With the dev server up (`python frontend/dev-server.py 8123`), one command is enough:

```
SUPABASE_ACCESS_TOKEN=… python frontend/tests/live_duplicates_check.py
```

`SUPABASE_TEST_EMAIL` defaults to `testguru211l@gmail.com`; **no password is needed** — the check mints a one-time login link with the token and exchanges it for a session, then compares the deployed action, the SQL function asked directly, and the banner in `#/questions` (one section per group in **Review**, every link checked against the ids the server sent). It writes nothing at all: no question, no media row, no audit row. 15/15 on 2026-09-25.

Two details worth reusing: `find_duplicate_groups` is called with **no arguments** (so the live answer is the SQL defaults: threshold 0.55, at most 50 pairs, non-archived questions only), and the live bank currently holds **6 questions that look duplicated**. If the count ever changes, the check compares against the server, not against a fixed number, so it stays honest.

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

## TESTING PERFORMED (2026-09-25, nineteenth session)

- Backend: `deno test --allow-env backend/` → **120 passed / 0 failed** (was 118; two new tests in `question_bank.test.ts`).
- Frontend unit: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **31 passed / 0 failed**.
- Browser (mocked, dev server on 8123, one suite after another like CI): all **eleven** green — teacher 36, **question bank 67** (was 57: ten new checks for the banner), question editor 75, media 29, question import 43, exams 37, student 61, results 79, monitor 30, dashboard 34, audit 25. Zero `FAIL` lines.
- Falsification of the new checks: with the banner temporarily switched off, `question_bank_e2e.py` dies on `waiting for locator(".banner:not([hidden])")` (TimeoutError) — so they test the feature, not a happy path.
- Live: `live_duplicates_check.py` **15/15** (read-only), the verbatim comparison script (**VERBATIM** for both migration files), and a re-download of the deployed `question-bank` diffed against the repository handler (identical).
- Everything above was run **before** the docs were written; both Actions runs are green on the pushed head `d00a77d`.

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
2. **No release blocker is open.** The merge of `ai-development` into `main` is the owner's decision (DEC-020) and needs the DEC-021 import reconciliation; the twenty-first session's CI runs were green at `3cb714c` and this session's push follows the same shape.
3. Ordinary next code task: **TASK-015's last piece — notifications** (needs the owner's email-provider decision, DEC-017). **Do not re-apply any of TASK-015's four migrations**: the audit viewer (2026-09-25), the scheduled jobs (2026-09-26, DEC-029), the backups (DEC-030) and user management (DEC-031) are **all live and verified**.
4. Owner decisions wanted: what belongs on the PDF class summary (the last TASK-012 piece) and whether the proposed import formats are accepted. (The exam-delete question was answered by the owner and is implemented — DEC-027 — and the user-management questions were answered too, DEC-031.) **TASK-016 is unblocked**: the teacher's account is now a two-minute action on `#/accounts`, not a SQL insert, and the admin's placeholder name can be replaced on the same screen.
5. Low-priority follow-up: reconcile the already-live but untracked migration rows (ISSUE-001), using a real DB connection/password.

## SUGGESTED WORK FOR NEXT AI

1. Start on `ai-development`; run `git status --short --branch` and `git pull --ff-only` **before** changing anything.
2. Read `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `09_KNOWN_ISSUES.md`, and this file. Let source code, database facts, tests, and git history win over stale `.ai/` notes.
3. If you have a live Supabase connection, read LIVE VERIFICATION PERFORMED above first — **TASK-015's four slices (audit viewer, scheduled jobs, backups, user management) are all live and verified**; do not re-apply or redeploy any of them.
4. **TASK-020 is done and ISSUE-024 is closed** (DEC-028); do not re-implement it. The queue's remaining ordinary task is **notifications**, which needs the owner's provider decision (DEC-017) before any code. Do not invent a random feature if the queue is empty; audit documented debt instead.
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
- Do not re-apply `20260926021234_account_functions.sql` or redeploy `accounts` — both live since 2026-09-26, tracked as `20260926021234` / `account_functions`.
- Do not add account deletion, an invitation-email flow, a password-reset email, self-service sign-up, or a "sign out everywhere" action without a new owner decision (DEC-031 records why each is deliberately absent) — and never put a password (or a password hint) into an audit `changes` value.
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
