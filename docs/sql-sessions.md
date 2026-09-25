# SQL for the student exam engine (TASK-010)

The student side (join by code, take the test, send it) keeps its rules in the database like every
other feature (DEC-004). The tables it uses already existed from the Phase-1 migrations
(`exam_sessions`, `session_answers`, `answer_grades`, `exam_results`, `session_events`,
`retake_permissions`, `rate_limits`); this work added only functions.

The functions live in **`supabase/migrations/20260923000000_session_functions.sql`** — applied live
on 2026-09-23 (the dashboard SQL editor or the Management API query endpoint; there is no
`supabase db query` subcommand in CLI 2.117.0 — corrected 2026-09-25), which is the
canonical SQL source from now on. Keep changes there.

## Contract

| Function | Purpose |
|---|---|
| `exam_join(p jsonb)` | `{code, name, class}` → the session plus the question snapshot. Checks the code, the open/scheduled window, the 1-attempt rule (BR-01) and a single-use retake permission (BR-02); picks the questions (manual order or the exam's filter, per student when `draw_per_student`); writes the snapshot and the answer key; returns `{session, questions, answers}` (a resumed attempt returns the same payload). |
| `get_exam_session(p_id uuid)` | Everything the phone needs to resume: `session` (status, attempt, ends_at, `remaining_seconds`, `grace_seconds`, exam settings), `questions`, `answers`. |
| `save_session_answers(p_id uuid, p_answers jsonb)` | Upserts answers (unique `(session_id, question_id)`, so a resend from the phone cannot duplicate — BR-12). Refuses questions that are not part of this session and anything past `ends_at + 2 minutes` (BR-20), and closes the session itself when the deadline has passed. |
| `session_heartbeat(p_id uuid)` | Keeps `last_heartbeat_at` fresh, returns the status and time left, and submits a session that ran out of time. |
| `log_session_event(p_id uuid, p_event_type text, p_meta jsonb)` | Records tab switches, focus loss, online/offline, reloads (server decides severity). Counts page leaves and auto-submits at the exam's `tab_switch_autosubmit_limit`. |
| `submit_exam_session(p_id uuid, p_reason text)` | Grades the automatic questions (multiple choice, true/false, short answer) per BR-06, leaves essays for the teacher (BR-07), writes `exam_results`, and returns the student-visible result. Idempotent. |
| `get_session_result(p_id uuid)` | The result again, honouring the exam's `result_visibility` and `essay_pending_display` (BR-08). |
| `get_session_media_ids(p_id uuid)` | The media ids that belong to this session's snapshot, so the Edge Function can sign links for them without exposing storage paths. |
| `expire_sessions(p_tolerance interval)` | BR-21 cleanup: sessions nobody submitted become `auto_submitted` (if they have answers) or `timed_out`. For a scheduled job later (TASK-015). |
| `_session_grade`, `_session_public_result`, `_session_question_block`, `_session_key_entry` | Internal helpers (prefixed `_`), not part of the public contract. |

## Live schema facts (discovered while applying this SQL)

- `exam_sessions.student_name_normalized` and `student_class_normalized` are **GENERATED** columns
  (`normalize_text(...)`) — never insert them; the database fills them in. Same for
  `accepted_answers.answer_normalized` and `question_class_labels.label_normalized`.
- `exam_sessions` has `UNIQUE (exam_id, student_name_normalized, student_class_normalized, attempt_no)`;
  `session_answers` and `answer_grades` are unique on `(session_id, question_id)`; `exam_results` is
  unique on `session_id` — the functions rely on those for safe upserts.
- `answer_grades` has no `question_id`-only key: essay grades are written by the teacher later
  (TASK-012), so a pending result simply has no rows for the essays.
- The statuses in play: `session_status` = `in_progress | submitted | auto_submitted | timed_out | reopened`,
  `result_status` = `pending_review | graded`, `pass_status` = `passed | failed | not_final`,
  `event_severity` = `info | warning | suspicious | violation`.
- The tolerance after `ends_at` is a hard-coded 2 minutes in three places (`save_session_answers`,
  `session_heartbeat`, `expire_sessions`) and is reported to the client as `grace_seconds: 120`.
  Change them together.

## How it was verified

**SQL, against the live database, inside a rolled-back transaction** —
`supabase/tests/session_functions_test.sql`:

```
npx supabase db query --linked --file supabase/tests/session_functions_test.sql
```

Ends with `SESSION ENGINE TESTS PASSED (all rows rolled back)`; an `ASSERT FAILED: <rule>` message
means a rule is broken. It checks, among others: the snapshot never contains `correct`/`accepted`
answers; a resent answer updates instead of duplicating; an essay keeps the result `pending_review`
with `pass_status not_final`; `hide_score` keeps the partial number away from the student until the
teacher says otherwise; the second attempt is refused but a granted retake becomes attempt 2 and is
used up; an unfinished attempt is resumed instead of duplicated; an answer one minute past the
deadline is still accepted while ten minutes past is refused; the fifth page leave submits
automatically; a silent session becomes `timed_out`; `cut_at_end` shortens a late start.

**Deno, mocked database** — `backend/tests/session.test.ts` (21 tests: parsing, the signed session
token, rate limiting, the auth wall, media signing).

**LIVE-VERIFIED (2026-09-23)** — with the owner's access token and the admin account, through the
deployed `session` function: joins with `" livet1 "`, snapshot without keys, two answers saved then
resent, a foreign question id refused with `validation`, a page leave counted, heartbeat, resume,
submit → `percentage 75`, `3 / 4` points, `2 correct, 1 wrong`, `passed`, review of three questions
with the wrong one flagged; submitting again keeps the same result; then the refusals (second attempt
with the same name/class, unknown code, forged token, tokenless call, unknown event type) — **27/27
checks**. All test rows (exam, session, answers, grades, result, events, rate limits) were deleted
afterwards: live state back to 0 exams, 0 sessions, 40 questions.
