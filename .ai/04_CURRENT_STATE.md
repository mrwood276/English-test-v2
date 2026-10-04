# Current State — English Daily Test v2

Supabase + vanilla-JS school test platform. Two frontends in `frontend/`:
`student/` (join → take test → result, linear flow) and `teacher/` (hash-router SPA,
17 routes). Ten Deno Edge Functions in `backend/functions/`. 45 SQL migrations in
`supabase/migrations/`, 15 SQL test files in `supabase/tests/`.

## Verified this session (2026-10-04, UI/UX implementation phase)

No architecture or business logic was changed. All changes are frontend-only:
presentation, accessibility, and feedback. 13 files changed (see git status):

**Navigation & accessibility**
- `frontend/assets/js/teacher/router.js` — after every route render, focus moves to
  `<main>` (`container.focus({ preventScroll: true })`); the shell already gave `<main>`
  `tabindex="-1"` but nothing used it. Keyboard/screen-reader users no longer stay on
  the nav link they clicked (WCAG 2.4.3).
- `frontend/assets/js/teacher/screens/shell.js` — "Skip to content" link added as the
  first focusable element (WCAG 2.4.1); notification bell error state now has a
  "Try again" button and `role="alert"` (was a dead-end message); bell button got
  `aria-controls="notif-panel"` and the panel the matching `id`.
- `frontend/assets/js/student/screens/join.js` — the failing input gets
  `aria-invalid="true"`, cleared on the next keystroke (was: error card only).
- `frontend/assets/js/student/screens/exam.js` — the answered-progress bar is now a real
  `role="progressbar"` with `aria-valuemin/max/now` updated in `refreshChrome()`; was a
  purely visual `<i>` with a width style. Removed a leftover `console.log`/`console.error`
  around `sheet.showModal()` (a fresh dialog cannot throw; `closeSheet()` nulls it first).

**Feedback consistency**
- `frontend/assets/js/shared/ui.js` — error toasts (`kind` "bad" or "error") now stay
  9 s, others 4.5 s. The `kind` string is kept verbatim as the CSS class: many screens
  call `toast(msg, "bad")` and the e2e suites assert on the `.toast.bad` selector, so
  the class name is a test contract. `confirmDialog()` now returns focus to the element
  that opened it (guarded by `isConnected`); previously keyboard focus was dropped to
  `<body>` when the dialog closed. The dialog's message paragraph is now referenced by
  `aria-describedby` (was only `aria-labelledby`).
- `frontend/assets/css/student.css`, `frontend/assets/css/questions.css` — `.toast.bad`
  now paints red (it was unstyled, so error toasts on exams/dashboard/monitor/grading
  screens looked like info toasts); `.toast.warn` paints amber (was unstyled); added
  `.skel`/`.skel-row` skeleton styles with `prefers-reduced-motion` respect.

**Loading / error states (consistency with the question-bank pattern)**
- `frontend/assets/js/teacher/screens/questionBank.js` — skeleton rows on first load
  (only when the table is empty; later pages keep the old rows).
- `frontend/assets/js/teacher/screens/exams.js` — skeleton rows on first load; error
  state now has a "Try again" button (was message only).
- `frontend/assets/js/teacher/screens/grading.js` — skeleton rows on first load; error
  state now has a "Try again" button.
- `frontend/assets/js/teacher/screens/examMonitor.js` — both monitor boards' error
  states now have a "Try again" button.
- `frontend/assets/js/teacher/screens/examResults.js` — the question-statistics error
  state now has a "Try again" button (re-clicks the Questions tab, which re-runs the
  load because `dataset.loaded` is only set on success).

## Deliberately NOT changed
- Monitor boards have no skeleton rows: they auto-refresh every 30 s, so a skeleton on
  every load would flicker; the "Loading…" subtitle plus empty state is kept.
- `examResults.js` question-statistics error state has no retry button (minor, open).
- Student identity model, session engine, Edge Function code, migrations: untouched
  (see `09_KNOWN_ISSUES.md` for the audit findings that still need backend work).

## Test evidence (all actually run, 2026-10-04)
- 14 Playwright e2e suites against the static server (`python -m http.server 8123
  --directory frontend`) + `frontend/tests/mock_server.py`: 849 checks, all passed —
  accounts 46, audit 26, backups 42, dashboard 37, exams 94, media 34, monitor 34,
  notifications 31, question_bank 161, question_editor 87, question_import 43,
  results 87, student 91, teacher 37.
- `deno test --allow-env --allow-read --no-check frontend/tests/unit/`: 44 passed, 0 failed.
- One flaky failure observed: `monitor_e2e` check "empty hub explains itself" failed
  once, then passed in three consecutive runs with identical code (no edit between) —
  environmental timing, not a regression.
- Live checks (`frontend/tests/live_*_check.py`) could NOT be run: the provided
  `SUPABASE_ACCESS_TOKEN` is rejected by the Supabase Management API (HTTP 401
  "JWT could not be decoded", verified with a direct `GET /v1/projects` call).
  The full board also needs `SUPABASE_TEST_EMAIL`/`SUPABASE_TEST_PASSWORD`.
