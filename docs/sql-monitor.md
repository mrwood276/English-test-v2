# SQL for the live monitor (TASK-013)

The board a teacher leaves open while a class works — who is taking the test, how far along they are,
how much time is left, how often they left the page — plus **more time for a whole exam at once**
(BR-11 at exam scope). It reads what the student engine already records; no table was added or changed.

Two migrations carry the SQL, both applied live on 2026-09-24:

| File | What it does |
|---|---|
| `supabase/migrations/20260925000000_monitor_overview_fields.sql` | Adds `answered_count`, `question_count` and `last_heartbeat_at` to **`list_exam_results`**, so the results table doubles as the monitor's read (one row per attempt, in-progress ones included). |
| `supabase/migrations/20260927000000_exam_wide_add_time.sql` | Adds **`add_exam_time`** (the exam-scope twin of BR-11), puts the exam's own tab-switch limits on every row (the drift fix below), and **drops `list_live_sessions`** — a second read function created live by a parallel session, which the shipped monitor never used. |

Live public function count after both: **60**.

## Contract

Everything the monitor draws comes from one staff call, `results` action **`overview`**
(`list_exam_results`), plus `results` **`report`** for one attempt's timeline:

| Payload | Fields the screen uses |
|---|---|
| `exam` | `id`, `title`, `status`, `access_code`, `duration_minutes`, `passing_grade`, `result_visibility`, `essay_pending_display`, `starts_at`, `ends_at` |
| `summary` | `with_result`, `in_progress`, `average`, `highest`, `lowest`, `passed`, `failed`, `not_final`, `pending_essays` |
| `rows[]` | `session_id`, `student_name`, `student_class`, `class_display` (merged through `class_aliases`, BR-15), `attempt_no`, `status`, `started_at`, `submitted_at`, `ends_at`, `remaining_seconds` (server clock; `null` when the attempt is not running), `tab_switch_count`, **`tab_switch_warn_limit`**, **`tab_switch_flag_limit`**, **`tab_switch_autosubmit_limit`**, `last_heartbeat_at`, `answered_count`, `question_count`, `has_result`, `percentage`, `total_points`, `max_points`, `pass_status`, `result_status`, `correct_count`, `wrong_count`, `time_used_seconds`, `pending_essays`, `retake_granted`, `retake_used` |

The three tab-switch limit fields are the ones the status pill reads; see the drift note below.

### `add_exam_time(p_exam_id uuid, p_seconds int, p_actor uuid)`

More time for **every** attempt still `in_progress`/`reopened`, in one transaction:

- adds the seconds to `extra_seconds` and `ends_at`;
- refreshes `last_heartbeat_at`, so the teacher's own action cannot make the class read as "offline";
- writes one `time_added` event per session (`meta.scope = 'exam'`, with the exam id) and one audit row
  (`action = 'add_time'`, `entity_type = 'exam'`, `changes = {seconds, sessions}`);
- answers `{updated, added_seconds, remaining_seconds}` — `updated` is the number on the toast;
- refuses a step under 1 minute or over 2 hours, an unknown exam, and an exam with nobody working.

The student page needs no change: it reads `ends_at` from the server on every heartbeat, so the extra
minutes appear on the phone by itself (BR-20 — the server clock is the only clock).

### The status rule the screen applies to those rows

`liveStatusPill` (`frontend/assets/js/teacher/components/resultBits.js`) turns one row into one label:
a result or a status other than `in_progress`/`reopened` is *finished*; otherwise **Offline** when
`last_heartbeat_at` is older than 90 s, else **Need a look** at `tab_switch_count >= tab_switch_flag_limit`,
else **Left the page** at `>= tab_switch_warn_limit`, else **Saved**. The rule lives in the browser, but
every number it reads comes from this payload — which is exactly why the limits must be in it.

## The drift this work fixed

`liveStatusPill` read `row.tab_switch_warn_limit` / `row.tab_switch_flag_limit` from the start, but the
shipped `list_exam_results` never sent them: only the **mocked** server did, so the browser suite could
not see the difference. Against the real backend the pill silently fell back to the built-in defaults
(1 and 3), so an exam whose teacher set different limits would be labelled wrongly on the live board.
`20260927000000_exam_wide_add_time.sql` adds the three limit fields to every row, and
`frontend/tests/live_monitor_check.py` now asserts a **non-default** limit comes back in the payload
(both of these are recorded as ISSUE-021: found live, fixed live).

## Where the rules come from

- BR-11 (extra time; here for a whole exam at once, audited), BR-05/BR-20 (the server decides "time is
  up" and how much is left), BR-15 (results and the board show `class_aliases.display_name`), and the
  four anti-cheating levels of `design.md` section 4 — decided by the exam's own limits, the same way
  `log_session_event` decides them for the student side.
- The board is **read-only**: `list_exam_results` is `stable` and writes nothing, "offline" is a
  judgement at read time rather than a status written onto a session, and a teacher's refresh can never
  change what a student is doing.
- One read path on purpose: `list_live_sessions` was dropped rather than kept beside
  `list_exam_results`, because two answers to "who is taking this test" is how a payload and its screen
  drift apart (DEC-024).

## How it was verified

**SQL, against the live database, inside a rolled-back transaction** — the monitor fields are covered
by their own assertions in `supabase/tests/` (session and result suites) and by the live checks below.

**Deno, mocked database** — `backend/tests/results.test.ts`: `add_exam_time` maps to the right function
with the actor, and it takes the same 1-minute-to-2-hour window as one session's time (backend 106).

**Browser, mocked server** — `frontend/tests/monitor_e2e.py` (30 checks): the hub, the per-exam table
(progress, time left, exits, pills), the session timeline, the exam-wide add-time button through its
confirm dialog, and the control disabling itself when nobody is working.

**LIVE-VERIFIED — API, 2026-09-24** (`frontend/tests/live_monitor_check.py`, **38/38 checks**): one exam
created and opened with **non-default** limits (warn 2, flag 4), four students joined through the
`session` function (one quiet, one at the warn limit, one at the flag limit, one submitted). The payload
came back with all four rows, the exam's own limits, progress (`1/2`), a heartbeat, a clock on the
running attempts and none on the finished one. The script applied the same rule `liveStatusPill` uses
and got `Saved` / `Left the page` / `Need a look` / finished. `add_exam_time` reported `updated: 3` and
`added_seconds: 300`, moved every running clock by five minutes, left the finished attempt at 0 and
wrote its `time_added` event; the refusals held (0 minutes, unknown exam, nobody working, tokenless 401).

**LIVE-VERIFIED — real browser, 2026-09-24** (`frontend/tests/live_browser_check.py`, **20/20 checks**,
this is TASK-022): the local teacher app served by `dev-server.py`, signed in with the real admin
account against the real project, opened `#/monitor` while the exam above was being taken. The hub
listed the exam with its code; the board showed all four students with real progress bars (`1/2`), a
real countdown (`29m 44s`), the exit counts and the four pills; **Add time to everyone** asked first,
toasted `Time added for 3`, and the three running students' clocks moved five minutes in the database
while the finished one stayed at 0; the board counted down on its own (15-second timer) with no manual
reload and produced no console errors.

Everything both live checks created was deleted afterwards (`frontend/tests/cleanup_live_monitor.sql`):
live state 0 exams, 0 sessions, 0 answers, 0 results, 0 events, 0 rate-limit rows, 40 questions.
