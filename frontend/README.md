# English Daily Test v2, frontend

Plain HTML, CSS, and JavaScript modules. No build step and no framework. Fonts come from Google Fonts (with system fallbacks).

## Try it on your computer

The page uses JavaScript modules, so it must be opened through a small local server (double-clicking the file will not work).
Use the included server, which tells the browser never to keep old copies of the files:

```
python dev-server.py
```

Run that in this folder (the one that contains `teacher` and `assets`), then open http://localhost:8000/teacher/ and sign in
with the admin account created in Supabase Auth.

**After replacing the folder with a newer version:** stop the old server (Ctrl+C), start it again from the new folder, and press
Ctrl+Shift+R in the browser. The bottom of the menu shows "Build: ..." so you can see which version is loaded.

## Layout

```
teacher/index.html              teacher and admin app (sign in, then the app shell)
assets/css/tokens.css           colors, fonts, sizes (the approved "answer sheet" direction)
assets/css/base.css             buttons, fields, notices, pills
assets/css/teacher.css          sign in and app shell
assets/css/questions.css        question bank list, preview, dialog, toast
assets/js/core/                 config, http (timeouts, friendly errors), auth (Supabase Auth), api (Edge Functions)
assets/js/shared/               dom (element builder), rich (safe rich text), icons, ui (toast, confirm dialog, debounce), imageCompress
assets/js/teacher/app.js        boot and session handling
assets/js/teacher/router.js     small hash router (#/dashboard, #/questions, #/questions/new, #/questions/edit/<id>)
assets/js/teacher/api/          one file per Edge Function (questionBank.js, media.js)
assets/js/teacher/screens/      login, shell, dashboard, questionBank, questionEditor
assets/js/teacher/components/   questionView, richTextarea, chipsInput, passageDialog, mediaPicker
assets/js/teacher/guard.js      unsaved-changes guard used by the editor
tests/                          browser tests with a mocked server (mock_server.py, teacher_e2e.py, question_bank_e2e.py, question_editor_e2e.py, media_e2e.py)
```

## Notes

- The publishable key in `assets/js/core/config.js` is meant to be public. All tables are locked; data only comes through Edge Functions that check who is calling.
- The sign-in session lives in `sessionStorage`: closing the tab signs the person out.
- Student pages (join with name, class, and code) are added in the exam engine phase.
- Password reset by email needs the app's address to be set in Supabase Auth (Site URL and redirect URLs), so it is added once the app has a home address.

## Running the browser test (optional)

```
pip install playwright && playwright install chromium
python dev-server.py 8123
python tests/teacher_e2e.py
python tests/question_bank_e2e.py
python tests/question_editor_e2e.py
python tests/media_e2e.py   # needs the sample files described at the top of the test
```
