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
                                #/results/<exam id>, #/results/<exam id>/session/<session id>)
assets/js/teacher/api/          one file per Edge Function (questionBank.js, media.js, exams.js, results.js)
assets/js/teacher/import/       readers that turn files or pasted text into questions (csv, xlsx, zip, text, rows, rules)
assets/js/teacher/export/       writers for the results exports, built in the browser with no dependency
                                (zip.js and xlsx.js; resultsTable.js is the one table the CSV and the Excel file
                                are both made from, so the two cannot drift apart)
assets/js/teacher/screens/      login, shell, dashboard, questionBank, questionEditor, questionImport, exams,
                                examEditor, examMonitor (the live board, with exam-wide add time),
                                sessionTimeline (one attempt while it runs), grading, gradingQuestion,
                                examResults, sessionReport
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
                                results_e2e.py, monitor_e2e.py) and Deno unit tests (tests/unit/). Three one-off
                                scripts talk to the real backend by hand (owner's account, password from the
                                environment): live_results_check.py (the grading loop),
                                live_monitor_check.py (the monitor payload + exam-wide add time;
                                cleanup_live_monitor.sql removes what it created) and live_browser_check.py
                                (the same check driven through the real screens in Chromium).
                                live_media_check.py uploads a real photo and a real MP3 to Storage through
                                the editor (needs ffmpeg to build the MP3) and deletes its own rows and
                                objects again; live_exam_delete_check.py walks the exam delete rule
                                (teacher closes, admin really deletes) with both accounts; add
                                SUPABASE_ACCESS_TOKEN to also check the database side of the last two.
                                live_duplicates_check.py is the newest and the easiest to run: with the
                                token alone it signs in as the staff test account (a one-time login
                                link, so no password), then compares the deployed duplicate scan, the
                                SQL function and the banner in #/questions. It writes nothing
```

## Notes

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
```
