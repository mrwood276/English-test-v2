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
  `'closed'`; `exam_code_available` returns a boolean (kept for `regenerate_exam_code`); since TASK-031
  `check_code` asks `exam_code_used_by`, which returns `'open'`, `'draft'` or null — who holds the code;
  `regenerate_exam_code` returns the new code; `duplicate_exam` returns the new draft id;
  `set_exam_status` returns void.
- `list_exams` also returns **`session_count`** (how many attempts the exam has), added 2026-09-25 so the
  screen can say what a delete will do before the click. Additive: existing readers are unaffected; since
  TASK-032 `get_exam` returns it too (the editor needs it to decide whether an exam may become a template).
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

## The open-code conflict (2026-10-02, TASK-031 / INS-04 / ISSUE-049) — migration `20261002000002_open_exam_code_conflict.sql`

`save_exam` refuses a code an open exam already holds, and `exams_open_code_unique` allows only one open
exam per code — but two **drafts** may still be saved with the same code (a copy/paste, or a code reused
from the board). Opening the second could only hit the partial index: Supabase answered `23505` without a
`hint`, `callRpc` rethrew it, and the teacher saw "Something went wrong. Please try again." while
`check_code` had said the code was free.

The migration replaces `public.set_exam_status` with the same rule `save_exam` applies: when
`p_status = 'open'` and another exam (`x.id <> p_id`) holds the code while open (`x.status = 'open' or
public._exam_is_open(x)`), it raises

    The test code <CODE> is already used by an open exam. Close that exam or give this one a different code.

with `hint = 'validation'`, so the handler answers **400** and the exams screen's toast shows the
sentence; the exam stays a draft. No table, column or index changes.

The same migration adds `public.exam_code_used_by(p_code text, p_exclude uuid default null) returns text`
— `'open'`, `'draft'`, or null (free) — and `check_code` now calls it instead of `exam_code_available`, so
the editor's code field says **"Already used by another draft"** before Open, when the conflict can still
be avoided cheaply. `exam_code_available` keeps its boolean rule for `regenerate_exam_code` (open exams
only; a closed exam does not hold its code), and `save_exam` is unchanged.

Mirrored by `frontend/tests/mock_server.py`; asserted by `supabase/tests/exam_status_test.sql` (rolled
back) and `frontend/tests/exams_e2e.py` (the Open refusal and the code-field warning — all three checks
failed on the pre-fix client+mock first).

**Live status:** the migration is **not yet applied** — it was written on 2026-10-02 in a session without
a Management credential. Applying it as one request with its `schema_migrations` row (`20261002000002` /
`open_exam_code_conflict`), running the SQL test, **redeploying the `exams` Edge Function** (its handler now
calls `exam_code_used_by` — the SQL must land first, or `check_code` would 500) and re-running
`live_ledger_check.py` is the next live run's first task; the result belongs here.

## A live exam cannot become a template (2026-10-02, TASK-032 / INS-05 / ISSUE-050) — migration `20261002000003_template_only_when_safe.sql`

`exam_join` refuses a template outright ("That code belongs to a template, not a running test"), and
`save_exam` accepted `is_template` for any status — so one tick + Save on an **open** exam turned a running
test into one nobody could join, while the list still said "Open". The same state was reachable by opening
a template from the list's Open button. The migration closes both paths and repairs what the bug could
already have made:

- `save_exam` refuses `is_template = true` unless the save is a draft, the exam is not currently open, and
  it has no attempts (`exam_sessions` rows). All three are `hint = 'validation'` 400s:

        A template must be saved as a draft.
        An open exam cannot become a template. Close it first.
        This exam already has attempts, so it cannot become a template. Duplicate it and save the copy as a template.

- `set_exam_status` refuses to **open** a template: `A template cannot be opened. Duplicate it and open the
  copy.` It also carries TASK-031's open-code check (`20261002000002`) forward unchanged, being a
  `create or replace` of the same function — so the two migrations must be applied in that order.
- `get_exam` also returns **`session_count`** (like `list_exams` since ISSUE-023), which the editor uses to
  disable the checkbox and say why.
- one repair statement clears `is_template` from any exam that is open **right now** — such an exam was
  never joinable, so the flag is what the bug left behind; it becomes joinable again as it stands.

The editor mirrors it: `examEditor.js` disables "Save as a template" for an open exam or one with attempts,
prints the reason in its place and forces the flag off on save. `mock_server.py` mirrors both gates (and now
keeps an exam's `session_count` across a save). Asserted by the rolled-back
`supabase/tests/exam_template_test.sql` and 7 new `exams_e2e.py` checks (they failed on the pre-fix
client+mock first; 94 checks after the fix, was 87).

**Live status:** not yet applied — written 2026-10-02 without a Management credential. Apply it as one
request with its `schema_migrations` row (`20261002000003` / `template_only_when_safe`) **after**
`20261002000002`, run `supabase/tests/exam_template_test.sql`, then record the result here. Unlike TASK-031,
no Edge Function redeploy goes with this one (`get_exam`'s payload simply gains a field); TASK-031's `exams`
redeploy still belongs to the `20261002000002` apply.
