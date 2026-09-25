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
