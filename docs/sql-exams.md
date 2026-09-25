# SQL for the exams feature (TASK-009)

Tables `exams`, `exam_questions`, `exam_sessions`, `retake_permissions` existed from the Phase-1
migrations; the exams work added only business-rule functions, per DEC-004 (rules in SQL, one
transaction per action, audit inside the transaction).

The functions live in `supabase/migrations/20260922000000_exams_functions.sql` — **applied live on
2026-09-22** (the way a file like this gets applied: the dashboard SQL editor or the Management API
query endpoint — note CLI 2.117.0 has **no** `supabase db query` subcommand, corrected 2026-09-25),
which is the canonical
SQL source from now on. Keep changes there.

Live-discovered facts about the schema that the SQL must respect (found when first applying it):

- `exams.status`, `availability_mode`, `late_start_policy`, `selection_mode`, `result_visibility`,
  `essay_pending_display` are **Postgres enums**, not text — every text value must be cast
  (`...::public.exam_status` etc.), and `list_exams` casts them back to text in its output.
- `exams.id` is a plain uuid (default `gen_random_uuid()`) — `save_exam` generates the id itself
  with `coalesce(p_id, gen_random_uuid())`.
- `exams.auto_filter` is `NOT NULL` with default `'{}'` — insert `coalesce(..., '{}'::jsonb)`.
- `exam_questions.position` has `CHECK (position > 0)` and `UNIQUE (exam_id, position)` deferred —
  positions start at 1, so `row_number() over ()` (not `- 1`).
- `exams.access_code` has `CHECK (access_code ~ '^[A-Z0-9]{4,12}$')` — `duplicate_exam` must mint a
  fresh confusion-safe code (same alphabet as `_shared/codes.ts`), not an md5 snippet.
- Changing the return type of `list_exams` needs `drop function ... first` (done in the file).

Contract notes for the handler in `backend/functions/exams/handler.ts`:

- Errors raised with `hint = 'validation'` reach the teacher as friendly 400 messages; anything
  else is a hidden 500 (`callRpc`).
- `save_exam` returns the exam id (insert **and** update); `remove_exam` returns `'deleted'` or
  `'closed'`; `exam_code_available` returns a boolean; `regenerate_exam_code` returns the new code;
  `duplicate_exam` returns the new draft id; `set_exam_status` returns void.
- `list_exams` also returns **`session_count`** (how many attempts the exam has), added 2026-09-25 so the
  screen can say what a delete will do before the click. Additive: existing readers are unaffected.
- `remove_exam(p_id, p_actor, p_force)` — the third argument was added on 2026-09-25 (the old
  two-argument function was **dropped**, so there is no force-less overload to call by accident):
  with attempts and `p_force = false` it closes the exam and answers `'closed'`; with `p_force = true` it
  deletes the exam, its `exam_questions`, **its `exam_sessions`** (whose answers, grades, results and
  events cascade, v2_04) and answers `'deleted'`. `exam_sessions.exam_id` is `on delete restrict`, which
  is why the sessions are removed before the exam. The Edge Function passes `p_force = true` **only** for
  the admin role (`ISSUE-023`); the audit row is `exam.close` (with `attempts`) or `exam.delete`
  (with `attempts` and `permanent: true`).

Live verification (2026-09-22, all through the deployed `exams` function as the admin):

- save draft (2 questions, weights 2+1) → id; get returns questions with positions 1..n; list shows
  counts and points; update via save-with-id changes title/duration/grade/questions.
- `set_status` draft→open; saving a second exam with the open exam's code is refused with
  "The test code LVQA01 is already used by an open exam."; `check_code` returns `available:false`
  for it and `true` after the exam is closed.
- `regenerate_code` returns a fresh 6-character code; `duplicate` creates a draft copy with a new
  code and both question rows; `remove` deletes the draft (`"deleted"`).
- Refusals: empty manual exam at save ("Add at least one question…"), scheduled window with
  end before start ("Closing time must be after the opening time.").
- Tokenless calls are refused with 401 "Please sign in." (auth wall works in production).
- All test rows (exams + their audit entries) were deleted afterwards; the bank (40 questions) was
  untouched.

## The delete rule (2026-09-25, ISSUE-023) — migration `20260930000000_exam_delete_with_attempts.sql`

An exam that already has attempts cannot be deleted by a teacher: the rule is BR-10 / DEC-012 (attempts
and their results are never lost), and DEC-027 records that only the admin may override it, deliberately.
The screen used to offer a Delete button that quietly closed such an exam while its confirmation had just
promised it "will be removed" — the owner clicked it five times on 2026-09-25. Now `list_exams` reports
`session_count`, a teacher's row shows "N attempts — kept for the results" with no Delete button, and the
admin's dialog names the count before asking again.

**Live verification (2026-09-25, `frontend/tests/live_exam_delete_check.py`, 17/17)** — through the
deployed `exams` function (v4) against the real project, with the staff test account as the teacher and
the admin account as the admin:

- the check code was free; a throwaway exam was created with 2 bank questions, opened, and one student
  joined it through the `session` function (a real attempt); `list_exams` reported `session_count: 1`.
- the **teacher** asking for `hard: true` got **HTTP 403** and the exam was untouched; the teacher's plain
  `remove` answered `'closed'` and the exam stayed, status `closed`, attempt intact.
- the **admin**'s `remove` with `hard: true` answered `'deleted'`, the API then answered `not_found`, and
  the exam plus its attempt were gone from every table (`exams`, `exam_sessions`, `session_answers`,
  `session_events`, `exam_results` — all 0).
- `audit_logs` held `exam.close` (reason `delete requested while sessions exist`, `attempts: 1`) and
  `exam.delete` (`attempts: 1`, `permanent: true`); a tokenless call was refused with 401.
- Nothing was left behind: the permanent delete is the cleanup, and the check sweeps up after itself (and
  its own `rate_limits` row) if an earlier step fails. Live state unchanged: the owner's own exam
  (`4KHU2A`, closed) with its 1 attempt is still there, 40 questions, 0 media rows.
