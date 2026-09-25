# SQL for grading and results (TASK-012)

The teacher side of an exam — grading written answers, reading the results, and the actions a teacher
may take on one attempt (more time, reopen, allow a retake) — keeps its rules in the database like
everything else (DEC-004). No table was added or changed: TASK-012 is functions only.

The functions live in **`supabase/migrations/20260924000000_result_functions.sql`** — applied live on
2026-09-24 (the dashboard SQL editor or the Management API query endpoint — CLI 2.117.0 has no
`supabase db query` subcommand; corrected 2026-09-25), which is the canonical
SQL source. Keep changes there.

## Contract

| Function | Purpose |
|---|---|
| `_session_result_write(p_id uuid)` | The **only** place that writes `exam_results`. Recomputes points, percentage, right/wrong, status, pass status and the review from the stored grades plus the session snapshot. Called after a submit and after every manual grade, so the two paths can never disagree. |
| `_session_grade(p_id uuid, p_status text)` | Re-created from TASK-010 with one change: a question the teacher graded by hand (`is_auto = false`) is **skipped** (BR-18), so a re-grade after a reopen cannot undo a correction. Everything else is unchanged (objective questions marked, essays left alone, result written by `_session_result_write`). |
| `save_answer_grade(p_session_id, p_question_id, p_points, p_feedback, p_actor)` | Grades one answer by hand (BR-07 essays, BR-18 corrections). Refuses a running session, a question outside the snapshot, a negative number, more than the question's weight, or a comment over 2000 characters. Writes `answer_grades` (`is_auto = false`, `graded_by`, `feedback`), recalculates the result, records a `graded` event and an audit row, and answers with `{saved, points, max_points, final, waiting_essays, percentage, total_points, pass_status}`. |
| `list_grading_questions(p_exam_id)` | The essay questions of an exam with `{question_id, position, body, weight, guide, taken, graded, waiting}` — what the grading screen shows in its picker. `guide` is read live from `questions.essay_guidance` (teacher-only; it is never put in a session snapshot, so a student can never receive it). |
| `get_grading_queue(p_exam_id, p_question_id)` | One essay question against every student who finished: `{question:{…, max_points, taken, graded, waiting}, students:[{session_id, student_name, student_class, attempt_no, answer, is_blank, graded, points, feedback, max_points}]}`. |
| `count_pending_grading()` | How many (session, essay) pairs have no grade yet — the number on the Grading menu badge. |
| `list_exam_activity(p_include_templates boolean)` | Every exam that has sessions, with `{sessions, finished, in_progress, passed, failed, pending_essays, average, last_submitted_at, essay_questions}`. Feeds the Grading hub, the Results hub, and the Dashboard's recent-exam meter. |
| `list_exam_results(p_exam_id)` | The results table of one exam: `exam`, `summary` (`with_result, in_progress, average, highest, lowest, passed, failed, not_final, pending_essays`) and `rows` (name, class, `class_display` through `class_aliases` — BR-15, score, points, right/wrong, time used, remaining time, page leaves, `last_heartbeat_at`, `answered_count` / `question_count` for the live monitor, session status, result status, pending essays, retake state). Progress fields added in `supabase/migrations/20260925000000_monitor_overview_fields.sql` (TASK-013). |
| `get_session_report(p_session_id)` | One attempt for the Details screen: the session, the result, the **graded review** (each question with `chosen`, `correct_text`, `accepted_text`, points, `manual`, `feedback`, and the essay `guide`), the grade rows, the event history with counts, the retake state, and an `actions` block (`can_add_time`, `can_reopen`, `can_grade`, `can_grant_retake`, `can_revoke_retake`). Staff-only payload: the correct answers are meant to be seen here (BR-09 keeps them away from *students*, not from the teacher). |
| `add_session_time(p_session_id, p_seconds, p_actor)` | BR-11: only while the test runs (`in_progress`/`reopened`). Adds 1 minute to 2 hours to `extra_seconds` and `ends_at`, records a `time_added` event and an audit row. |
| `reopen_session(p_session_id, p_seconds, p_actor)` | BR-11: only for a collected attempt. Sets the status to `reopened`, puts the given time on the clock (`ends_at = now() + p_seconds`), records a `reopen` event (with the previous status) and an audit row. The student's own endpoints already accept `reopened`, so the same phone continues with no change on that side; sending the test in again replaces the result. |
| `grant_retake(p_session_id, p_actor)` / `revoke_retake(p_session_id, p_actor)` | BR-02: writes/deletes the single unused `retake_permissions` row for the attempt's normalized name + class. `exam_join` (TASK-010) already reads it, so the student simply joins again as attempt 2. Granting twice is idempotent; a **used** retake cannot be taken back. |
| `_session_result_write`'s review rows | `is_correct` is `null` for an essay and for anything not graded yet; `manual` marks the teacher's grades; `points`/`max_points` per question. |

## Where the rules come from

- BR-06 points and percentage; BR-07 (a result stays `pending_review` / `not_final` until **every** essay
  in the snapshot has a grade — including one the student left blank); BR-08 (visibility only decides
  what the *student* sees; the teacher always sees everything); BR-11 (add time / reopen, both audited);
  BR-15 (`class_aliases.display_name` is what results show, the raw class stays untouched);
  BR-18 (a manual grade wins and is audited); BR-02 (one retake per student, granted by the teacher).
- `exam_results` has a check that keeps `status = 'pending_review'` and `pass_status = 'not_final'`
  in step; `_session_result_write` is written so they always move together.
- A provisional percentage is stored while essays wait, so the screen can show a number with a
  "Not final" pill (the mockups do exactly that). `hide_score` still keeps the number away from the
  student until the teacher says otherwise.

## How it was verified

**SQL, against the live database, inside a rolled-back transaction** —
`supabase/tests/result_functions_test.sql`:

```
# send the whole file as one request (one session keeps the file's own helpers alive):
#   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<file>"}
#   or paste it into the dashboard SQL editor - there is no `supabase db query` in CLI 2.117.0
python -c "import json,urllib.request,os,pathlib;print(urllib.request.urlopen(urllib.request.Request('https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query', data=json.dumps({'query': pathlib.Path('supabase/tests/result_functions_test.sql').read_text()}).encode(), headers={'Authorization':'Bearer '+os.environ['SUPABASE_ACCESS_TOKEN'],'Content-Type':'application/json'})).read().decode())"
```

Ends with `RESULT ENGINE TESTS PASSED (all rows rolled back)`. It covers, among others: the essay
queue and its guide; refusals (too many points, a question outside the test, a running session); a
result becoming final when the last essay is graded; a changed grade recalculating the result; the
student's own view turning final; a manual correction surviving a reopen + second submit; add time /
reopen (and their refusals); grant / revoke / a used retake; the merged class name in results; and the
audit rows for `grade`, `add_time`, `reopen`, `retake_grant`.

**Deno, mocked database** — `backend/tests/results.test.ts` (18 tests: parsing minutes/points/comments,
every action mapping to the right function, the auth wall, and error handling).

**Browser, mocked server** — `frontend/tests/results_e2e.py` (59 checks): the badge, both hubs, the
grading screen (bubbles, save and next, progress, final toast), the results table, the report
(correcting a grade, granting a retake, reopening, adding time).

**LIVE-VERIFIED (2026-09-24)** — with the owner's access token and the admin account, through the
deployed `results` function: an exam with a multiple-choice, a short-answer and an essay question; two
students joined through the `session` function and sent it in; the badge counted both essays; the
queue carried both answers; grading both essays turned both results final (one `passed`, one `failed`);
the student's own view showed `100` and `pending_review: false`; the results table reported one pass,
one fail and the right/wrong counts; the report showed the essay grade as the teacher's with its
comment and guide; a hand-corrected short answer survived a reopen + second submit; a collected attempt
was told to reopen instead of taking time; a granted retake produced attempt 2 and could no longer be
taken back; the tokenless call was refused with 401 — **38/38 checks**. Everything was deleted
afterwards (`frontend/tests/cleanup_live_results.sql`): live state 0 exams, 0 sessions, 0 rate-limit
rows, 40 questions.
