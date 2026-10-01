# English Daily Test v2, frontend

Plain HTML, CSS, and JavaScript modules. No build step and no framework. Fonts come from Google Fonts (with system fallbacks).

## Try it on your computer

The page uses JavaScript modules, so it must be opened through a small local server (double-clicking the file will not work).
Use the included server, which tells the browser never to keep old copies of the files:

```
python dev-server.py
```

Run that in this folder (the one that contains `teacher` and `assets`), then open http://localhost:8000/teacher/ and sign in
with the admin account created in Supabase Auth. The **student** page is the site root: http://localhost:8000/ —
a student enters their name, class, and the exam code from the teacher, with no account.

**After replacing the folder with a newer version:** stop the old server (Ctrl+C), start it again from the new folder, and press
Ctrl+Shift+R in the browser. The bottom of the menu shows "Build: ..." so you can see which version is loaded.

## Layout

```
teacher/index.html              teacher and admin app (sign in, then the app shell)
index.html                      student app (join with name + class + exam code, take the test, see the result)
assets/css/tokens.css           colors, fonts, sizes (the approved "answer sheet" direction)
assets/css/base.css             buttons, fields, notices, pills
assets/css/teacher.css          sign in and app shell
assets/css/questions.css        question bank list, preview, dialog, toast
assets/css/student.css          the student screens (join, exam, result) for phones first
assets/css/results.css          grading, per-exam results, the attempt report and the live monitor
assets/js/core/                 config, http (timeouts, friendly errors), auth (Supabase Auth), api (Edge Functions)
assets/js/shared/               dom (element builder), rich (safe rich text), icons, ui (toast, confirm dialog, debounce), imageCompress
assets/js/teacher/app.js        boot and session handling
assets/js/teacher/router.js     small hash router (#/dashboard, #/questions, #/questions/new, #/questions/edit/<id>, #/questions/import,
                                #/exams, #/exams/new, #/exams/edit/<id>, #/monitor, #/monitor/<exam id>,
                                #/monitor/<exam id>/session/<session id>, #/grading, #/grading/<exam id>, #/results,
                                #/results/<exam id>, #/results/<exam id>/session/<session id>,
                                #/audit, #/backups, #/accounts)
assets/js/teacher/api/          one file per Edge Function (questionBank.js, media.js, exams.js, results.js,
                                audit.js, backups.js, accounts.js)
assets/js/teacher/import/       readers that turn files or pasted text into questions (csv, xlsx, zip, text, rows, rules)
assets/js/teacher/export/       writers for the results exports, built in the browser with no dependency
                                (zip.js and xlsx.js; resultsTable.js is the one table the CSV and the Excel file
                                are both made from, so the two cannot drift apart; pdfDoc.js is a small PDF
                                writer and classSummaryPdf.js lays the class summary out on it — one row per
                                student, Name/Class/Score/Status, from the same overview payload the screen
                                has, DEC-033; schoolName.js remembers the school name the header asks for
                                once per device)
assets/js/teacher/screens/      login, shell, dashboard, questionBank, questionEditor, questionImport, exams,
                                examEditor, examMonitor (the live board, with exam-wide add time),
                                sessionTimeline (one attempt while it runs), grading, gradingQuestion,
                                examResults, sessionReport, auditLog (the admin audit viewer),
                                backups (the admin backups: list, make one, download, delete),
                                accounts (user management: create with a typed temporary password and
                                hand it over, rename, promote/demote, deactivate/reactivate, new password;
                                deactivation is the design — DEC-031, docs/sql-accounts.md)
assets/js/teacher/components/   questionView, richTextarea, chipsInput, passageDialog, mediaPicker,
                                duplicateGroupsDialog (the question list's Review dialog: one section per
                                group of questions that look alike, each linked to its editor),
                                resultBits (status pills, score, formatting), reviewItem (one answer in a report)
assets/js/teacher/guard.js      unsaved-changes guard used by the editors and the import screen
                                (setLeaveGuard(ask, hasUnsavedWork); the browser warning and the
                                router's ask only fire while something is really unsaved)
assets/js/student/app.js        student boot: reads the saved attempt, resumes it, mounts a screen
assets/js/student/api.js        calls the session function (join, get, save, heartbeat, event, submit, result, media)
assets/js/student/store.js      the attempt kept in localStorage (answers, flags, timer, offline queue)
assets/js/student/screens/      join, exam, result
assets/js/student/components/   question (one question rendered for answering)
tests/                          browser tests with a mocked server (mock_server.py, teacher_e2e.py, question_bank_e2e.py,
                                question_editor_e2e.py, media_e2e.py, question_import_e2e.py, exams_e2e.py, student_e2e.py,
                                results_e2e.py, monitor_e2e.py, dashboard_e2e.py, audit_e2e.py, backups_e2e.py,
                                accounts_e2e.py, notifications_e2e.py)
                                and Deno unit tests (tests/unit/). e2e_harness.py is shared: every suite
                                above ends through it, so a suite that dies unexpectedly prints a CRASH
                                block (checks run, the last few with their source lines, the page, the
                                console errors, the traceback) and exits 2, never 1 — a crash cannot be
                                mistaken for a failed check (ISSUE-039). The same text is kept in
                                git-ignored tests/.last-crash/. live_harness.py does the same for the
                                live_*.py checks below: each ends through it, so a crash also names
                                the live rows the check may have left (its sweep hint plus any id it
                                registered) and exits 2, never 1; its logs go to git-ignored
                                tests/.last-live-crash/. run_live_checks.py is the board: one
                                command runs all thirteen checks in a deliberate order and ends
                                with one line per check (PASS / FAIL / CRASH / HELD / SKIP).
                                Three one-off
                                scripts talk to the real backend by hand (owner's account, password from the
                                environment): live_results_check.py (the grading loop),
                                live_monitor_check.py (the monitor payload + exam-wide add time) and
                                live_browser_check.py (the same check driven through the real screens in
                                Chromium). All three build a real exam with real attempts and, with
                                SUPABASE_ACCESS_TOKEN set, remove it again and assert the rows are
                                gone through tests/live_cleanup.py (ISSUE-041); without the token they
                                print the ids and cleanup_live_monitor.sql (or the block in
                                docs/sql-results.md) remains the by-hand path — and a run that died
                                mid-way is swept by the next one.
                                live_crash_recovery_check.py is the proof of that last sentence
                                (ISSUE-042): it kills each self-cleaning check mid-run on purpose,
                                shows what the dead run left behind, and requires the next run to
                                pass and to sweep every one of them — monitor, browser, results,
                                housekeeping, notifications and accounts — while live_backup_check.py
                                (the guard case) must refuse to run while the project holds copies.
                                All ten writable checks are covered now; the four that once had no
                                cross-run sweep — media, bulk, exam_bulk, exam_delete — sweep their
                                own leftovers too (ISSUE-043, closed the same day).
                                live_media_check.py uploads a real photo and a real MP3 to Storage through
                                the editor (needs ffmpeg to build the MP3), moves the second answer and the
                                second file above the first with the reorder grip, and checks the database
                                came back in that order, then deletes its own rows and objects again (and a
                                killed run's leftovers first — its question by its fixed body, its files
                                by their sample names — ISSUE-043); live_exam_delete_check.py walks the
                                exam delete rule (teacher closes, admin really deletes) with both
                                accounts, sweeps a leftover DELCHK exam before it starts, and mints the
                                admin a one-time login link when only SUPABASE_ACCESS_TOKEN is set; add
                                SUPABASE_ACCESS_TOKEN to also check the database side of the last two.
                                live_duplicates_check.py is the newest and the easiest to run: with the
                                token alone it signs in as the staff test account (a one-time login
                                link, so no password), then compares the deployed duplicate scan, the
                                SQL function and the banner in #/questions. It writes nothing.
                                live_housekeeping_check.py needs no dev server and no browser: it
                                builds a throwaway exam with one abandoned attempt, a spare upload
                                and a stale rate-limit row, lets the nightly pg_cron jobs fire for
                                real, and checks each one did its job (40 checks; also proves the
                                file's bytes are gone from Storage) before deleting everything it
                                created
                                live_backup_check.py also needs no dev server and no browser (63
                                checks), but it needs a project with no copies to start from: it
                                deletes every row in public.backups (row and file) to assert its
                                counts, so since 2026-09-30 it refuses to run when the project holds
                                any, prints them, and names the opt-in
                                `BACKUP_CHECK_DELETE_EXISTING=1` (ISSUE-041 — the live project's
                                nightly copies are not this check's to destroy). It takes a real
                                manual backup, downloads the archive
                                through its signed link and opens it with zipfile (the media bytes
                                and every table's count compared with the live database), proves
                                the eighth nightly copy prunes the oldest row AND its file, lets
                                pg_cron fire the nightly job for real, deletes one copy, and cleans
                                up everything it created
                                live_accounts_check.py also needs no dev server and no browser (44
                                checks): it creates a throwaway account with a typed password that
                                really signs in, renames, promotes, demotes, deactivates and
                                reactivates it, sets a new password (the old one stops working) and
                                proves the guards (self-demotion and self-deactivation refused), then
                                deletes the account again and compares the project's own two
                                accounts row for row with the ones it read at the start
                                live_bulk_check.py is the bulk half of the question bank (F-17). It
                                writes, and it says exactly what it writes: three throwaway questions
                                of its own, changed in bulk through the deployed question-bank —
                                topic, difficulty, points, class labels add/remove/replace, an id
                                that is gone, the archive/restore round trip — with every refusal
                                tried as well, plus a control question read before and after to
                                prove nothing else moved. It drives the real screen once (filter,
                                select the page, new topic, preview, apply), then deletes its three
                                questions and its two test topics and compares the live counts with
                                the ones it took at the start. A killed run is not left behind: the
                                next one sweeps its three questions (by their `LIVE BULK CHECK`
                                marker) and any of its test topics (by name pattern) before it
                                starts (ISSUE-043). Needs the dev server for the screen half
                                (`--api-only` skips it); the owner's own questions are never
                                modified
                                live_exam_bulk_check.py is the exam half of it (F-18): put many
                                questions on one exam, or take many off it, from the exam
                                editor and from the bank through the deployed `exams`
                                function. It creates one throwaway draft exam and five
                                throwaway questions of its own, proves the refusals
                                (including an archived question offered and left untouched),
                                proves add/remove counts, order, points and the renumbering
                                when a question is removed, drives the real exam editor once
                                (the change is visible before Save and reaches the database
                                only when Save is pressed, and the new question is moved to the
                                top of the list with the keyboard before that Save), then
                                deletes its exam and all
                                five questions and compares the live counts with the ones it
                                took at the start, sweeping a killed run's exam (by its title) and
                                its questions (by their `LIVE EXAM BULK` marker) before it starts
                                (ISSUE-043). Needs the dev server for its screen half
                                (`--api-only` skips it)
                                live_notifications_check.py also needs no dev server and no browser
                                (36 checks): it signs the admin and the staff test account in with
                                one-time links, builds a real exam with an essay waiting and a
                                suspicious attempt, a real backup and a real created account
                                through the deployed functions, and reads the bell they produce —
                                the door (401/200), the teacher-vs-admin split, per-person read
                                marks, a card per real thing, and both refusals — then deletes
                                everything it made and compares **accounts, questions, archived
                                questions, backups, exams and read marks** before and after. It
                                learned that last part the hard way (ISSUE-040): its cleanup used
                                the question-bank `remove` action before the exam was gone, and
                                `remove_question` archives anything still referenced, so it had
                                been leaving its own essay behind since 2026-09-26
                                live_ledger_check.py needs only SUPABASE_ACCESS_TOKEN and writes
                                nothing (3 checks): it reconciles the live migration ledger
                                against `supabase/migrations/` (every row has a file or is the
                                same SQL under another name) and checks that every live public
                                function matches the newest file that defines it. Contract:
                                `docs/migration-ledger-reconciliation.md`
```

## Notes

- The exam editor's question list is the exam's **order**: every row has a grip that drags it (the row follows the pointer, `Escape` puts the order back, and `touch-action: none` makes the gesture work on a phone) and that is also the keyboard control — Tab reaches it and ↑ ↓ move the row one place, Home/End jump to the ends, with the focus following the row and each move announced. Save writes that order (`save_exam` numbers the list it is given), so nothing is sent before it. F-18 / DEC-036.
- That grip is **one shared component** (`components/reorderList.js`), used by the three lists that have a stored order: the exam's questions, the **answer options** in the question editor (the A/B/C/D a student sees) and the **files attached** to a question (the picture and the audio in the order they should appear — this is the reordering half of ISSUE-011). The same picker is used for a reading text's own files, so those reorder too. A file that is still uploading has no grip, and a true/false pair is a fixed two labels, so neither can be reordered.
- Staff accounts are an admin job (`#/accounts`): create one by typing the email and a temporary password and handing it over (no mailer is needed), rename, promote/demote, deactivate/reactivate, and set a new password. An account is **deactivated, never deleted** — the profile is what the audit trail and the rows the person created point at. DEC-031; contract: `docs/sql-accounts.md`.
- The question bank shows a banner when the whole-bank duplicate scan finds questions that look like copies (mockup 6): the count comes from the server, the scan runs once per visit, and **Review** lists the groups with a link to each question's editor. Contract: `docs/sql-duplicates.md`.
- The publishable key in `assets/js/core/config.js` is meant to be public. All tables are locked; data only comes through Edge Functions that check who is calling.
- The sign-in session lives in `sessionStorage`: closing the tab signs the person out.
- The student page has **no account**: it joins with a code and keeps its attempt (session token, answers, flags, timer) in `localStorage`, so a reload — even with no connection — resumes the same attempt. The answer key never reaches the browser; the server grades the test.
- Password reset by email needs the app's address to be set in Supabase Auth (Site URL and redirect URLs), so it is added once the app has a home address.

## Running the browser test (optional)

```
deno test --allow-env --allow-read --no-check tests/unit/   # import parsers + export writers (Deno)
pip install playwright && playwright install chromium
python dev-server.py 8123
python tests/teacher_e2e.py
python tests/question_bank_e2e.py
python tests/question_editor_e2e.py
python tests/media_e2e.py   # needs the sample files: python tests/make_fixtures.py (once)
python tests/question_import_e2e.py
python tests/exams_e2e.py
python tests/student_e2e.py
python tests/results_e2e.py  # includes downloading the CSV and the Excel export and opening the .xlsx with Python
python tests/monitor_e2e.py
python tests/dashboard_e2e.py
python tests/audit_e2e.py     # admin audit-log viewer
python tests/backups_e2e.py   # admin backups: make one, download it, delete it
python tests/accounts_e2e.py  # admin user management: create, rename, promote, deactivate, password
python tests/notifications_e2e.py  # the notification bell (TASK-015, DEC-037)
```

A suite that dies unexpectedly reports itself. Each one ends through **`tests/e2e_harness.py`**, which catches an uncaught exception and prints a `CRASH` block — how many checks ran, the last five of them with their source lines, the page it was on, the console errors it had collected and the full traceback — then exits **2** instead of 1, so a crash can never be read as a failed check. The same text is written to `tests/.last-crash/` (git-ignored; `E2E_CRASH_DIR` moves the folder). A normal run ends with one line, `ALL CHECKS PASSED (82 checks)`. `python tests/e2e_harness.py --self-test` proves the three endings (green → 0, failed check → 1, crash → 2) without a browser.

The hand-run `live_*.py` checks below report a crash the same way through **`tests/live_harness.py`**: a `CRASH` block (checks run, the last five with their source lines, the live rows this check is known to leave behind, the full traceback) written to `tests/.last-live-crash/` (git-ignored; `LIVE_CRASH_DIR` moves the folder) and exit **2**, while a normal run still ends with the check's own `ALL LIVE … PASSED` line. `python tests/live_harness.py --self-test` proves its four endings (green → 0, failed check → 1, a plain `sys.exit(1)` → 1, crash → 2) without a browser.

The whole live board runs in one command: **`tests/run_live_checks.py`** runs all thirteen `live_*_check.py` scripts in a deliberate order — the two read-only checks first, then the quick writers, the bulk importers, the slow housekeeping run and the backup guard last — streams each check's output unchanged as it runs, starts `dev-server.py` on 8123 itself for the checks that need the app (and stops the one it started; a server already answering is left alone) and ends with one recap line per check: `PASS ledger 0:06 (13 checks)`, `CRASH monitor 1:02 died at PASS 3 exam MON001 exists (live_monitor_check.py:120)`. A check that exits 2, times out, or exits with anything but 0/1 is a **CRASH** and the board itself exits **2**; a failed check exits **1**; `live_backup_check.py` refusing to run while the owner's copies exist is **HELD**, the safe outcome on the live project, not a failure; a missing credential (or ffmpeg for media) is **SKIP** — the check is not run and is not counted as a failure. `--read-only` runs only the two checks that write nothing, `--api-only` skips the two bulk checks' browser halves, `--only ledger,monitor` picks checks, `--with-crash-proof` appends `live_crash_recovery_check.py`, and `python tests/run_live_checks.py --self-test` proves all six endings plus the timeout kill, the skip and the exit codes on fake checks without touching the live project. In practice the network to `*.supabase.co` can reset in bursts (`WinError 10054`, ISSUE-045), killing whichever check is mid-run whatever it is; the cadence this project uses then is to re-run the crashed checks one at a time (`--only <check>`) with up to four bounded attempts, because every writable check sweeps its previous run's leftovers as it starts (ISSUE-042/043), so a retry both re-verifies and cleans. A check that crashed this way is not a product failure, and its assertions must not be weakened because a wave killed a run.
