# SQL for putting many questions on one exam, or taking many off it (F-18)

The exam editor (`#/exams/edit/<id>`) owns the whole exam: it sends every field and every question row, and
`save_exam` rewrites the manual list from that payload. What it could not do is **change the question set
alone** — and the question bank, where a teacher has just ticked the questions they want, knows nothing
about exams at all. F-18 is the missing act: **tick questions, say which exam, see what will happen, and
have it happen once**, from either surface.

The statements live in **`supabase/migrations/20260928000002_bulk_exam_questions.sql`** and are
**APPLIED LIVE on 2026-09-28** (twice — the second run is the renumber-on-remove fix described below; the
function is `create or replace`, so the second run *is* the update). The Edge layer is
**`backend/functions/exams/`** (`action: "bulk_questions"`, deployed with the rest of that function). The
screens are **`frontend/assets/js/teacher/screens/examEditor.js`** (its "add questions" affordance) and
**`frontend/assets/js/teacher/screens/questionBank.js`** (its "add to / remove from an exam" entry), which
both open the same shared dialog, **`frontend/assets/js/teacher/components/examQuestionsDialog.js`** — the
same choose → preview → apply shape F-17 gave the question bank (`bulkEditDialog.js`), reused rather than
re-invented.

## Why this exists beside `save_exam`

`save_exam` is the right function for the editor's own Save: it owns the title, the duration, the access
code, the availability, the selection mode **and** the list, and it writes them as one act. It is the wrong
function for "put these eight questions on this exam":

* Reaching for `save_exam` from the question bank would mean rebuilding the whole exam payload in the
  browser — including the rules panel the bank screen does not show — from data that may be a minute old.
* Calling `save_exam` once per question would rewrite the list from an increasingly stale snapshot: the
  second write would already be racing the first.
* Either way the audit trail would record an `exam.update`, which is a lie about what happened: **nothing
  about the exam changed, its question list did.**

So F-18 is the "change one thing about an exam" path, shaped exactly like `bulk_update_questions`
(DEC-035 / DEC-004): one transaction, one audit entry, honest counts.

## Add and remove are one function, not two

They are the same act on the same table behind the same guards — the exam has to be there, it has to be a
manual selection, it must not be open and it must not have attempts. Two functions would be two places for
those guards to drift apart, and the caller already knows which way it wants to go. So there is one
function and one `p_mode`.

## The contract

```sql
public.bulk_exam_questions(p_exam_id uuid, p_mode text, p_ids uuid[], p_actor uuid) returns jsonb
```

`p_mode` is `'add'` or `'remove'` (trimmed, case-insensitive). `p_ids` is the **explicit selection**, never a
filter — the same rule F-17 chose, for the same reason: "what exactly did I change?" has to be answerable to
the teacher, and the preview step needs a count it can show before anything is committed. At most **500** ids
in one act, the same ceiling the question bank's own bulk path uses.

The reply is the honest count of what happened:

```json
{ "matched": 3, "updated": 3, "unchanged": 0, "missing": 0 }
```

| | `add` | `remove` |
|---|---|---|
| `matched` | ids that still exist in the bank | ids that were on the exam |
| `updated` | really added | really removed |
| `unchanged` | already on the exam | exist, but were not on the exam |
| `missing` | ids that no longer exist | ids that no longer exist |

Only what really changed is counted, so the same act twice reports `updated 0` and never claims work it did
not do, and an id that no longer exists is **counted and reported** rather than failing the batch or being
hidden.

An added question goes to **the end of the list**, in the order it was given, carrying **its own**
`default_weight` — the editor's reorder and points controls are where an order and a weight are chosen
deliberately.

## Choosing the order (one shared control, three lists)

The order of an exam's questions is the **order of the editor's list**, because the list is what `save_exam`
is given and `save_exam` numbers a manual exam from that payload (`row_number()` over the rows as they
arrive). Nothing has to be pushed to the server for the order to change: the editor holds the draft, and Save
is what writes it.

That control turned out to be needed by the question bank's own ordered lists too — the answer options (the
A/B/C/D a student sees is the order of the editor's array, and `save_question` numbers them from it) and the
files attached to a question (`set_question_media` numbers them from the array it is given), which closes the
"files cannot be reordered" half of **ISSUE-011**. Writing a second one would have been the duplication
`.ai/00_AI_RULES.md` §4 forbids, so it lives in **`frontend/assets/js/teacher/components/reorderList.js`**
and all three lists use it:

```js
const reorder = enableReorder(listEl, {
  note,                              // a polite live region (role="status")
  noun: "answer",                    // what one row is called in the announcement
  describe: (row) => "…",            // the row's own name for that message (optional)
  onOrder: (rows) => { paint() },     // the rows in their new order; repaint from your state
});
```

The caller keeps the ids, the objects and the state; the control only moves elements. That is what lets the
same code serve a list of records with ids (the exam's questions), a list with no ids at all (the answers,
tied back with a `WeakMap`) and a list where one row must not move (a file that is still uploading — it simply
has no grip, and the rows close up around it).

What one grip does:

* **drag**: the row under the pointer moves for real — the list is the preview — and the caller's state
  catches up when the drag is released. `Escape` puts the starting order back. The pointer listeners are on
  the **document**, not on the grip: the pointer leaves the grip immediately and the rows underneath move as
  it goes, so a grip-local listener (or pointer capture) misses most of the drag. `touch-action: none` on the
  grip is what makes the same gesture work on a phone instead of scrolling the list under the finger.
* **keyboard**: the grip is a button, so Tab reaches it, and ↑ ↓ move the row one place (Home and End jump to
  the ends, with `preventDefault` so an arrow key at either end cannot scroll the page instead). Focus moves
  with the row, so a second press keeps going, and every move is announced (*"… is now answer 3 of 4."*).
* **a button**: any control inside a row carrying `data-move="up|down|first|last"` moves it too and goes
  through exactly the same code — which is how the exam editor's older `↑`/`↓` buttons were folded in rather
  than left behind.

On a narrow screen (under 900 px) the exam editor's row **wraps** — seven controls and a question do not fit
across a phone — and the mocked suite measures that at 380 px. A reorder marks the draft dirty and, exactly
like every other edit on those screens, sends nothing until Save.

## An exam's list is always 1..n, whichever way it changed

Adding numbers on from the current end; **removing closes the gap the removed rows left behind**, keeping
the survivors' relative order and their own points. Gaps would be visible — the editor prints
`position + 1` as the question's number, so a hole reads as *"Question 1, Question 2, Question 4"* — and
`save_exam` already rewrites the list as one contiguous run, so nothing else in the system expects a hole.
The renumber is a statement of its own (so it sees the rows that just went) and `unique (exam_id, position)`
is `deferrable initially deferred`, so rewriting the numbers in one pass on the final set is safe. **This
is the one thing the first live run got wrong**: the function shipped without it, the live check caught the
hole, and the second apply is the fix — see "Applied live" below.

## Validation, and why every message is friendly

Every refusal raises an exception with `hint = 'validation'`, which the Edge layer turns into a 400 with the
message as-is. The list:

* a mode that is neither `add` nor `remove`;
* an empty selection, or more than 500 ids;
* an exam that no longer exists;
* an exam that draws its questions by a filter (`selection_mode <> 'manual'`) — it has no fixed list to add
  to;
* a **running** exam (`status = 'open'`) — those questions are what the students taking it are answering
  right now;
* an exam that already has attempts (`exam_sessions`) — its results are tied to the questions that were
  asked, so the set stays as it was and the message says to **duplicate the exam** instead (BR-10 / DEC-012:
  attempts are never rewritten);
* **adding** an archived question — archiving is how a question is retired, and `save_question`'s own rule is
  that an archived question cannot be used by a new exam;
* an add that would grow the exam past **200** questions — the same ceiling `parseExamQuestions` already
  enforces at the Edge layer, so the two paths cannot drift;
* a selection that matches no question at all (*"Those questions no longer exist. Refresh the list and try
  again."*).

Anything else is a 500 with no database detail quoted to the browser.

## The boundary

```sql
revoke execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) to service_role;
```

Only the service role — that is, only an Edge Function — may call it, exactly like every other function in
this schema (ISSUE-020). The door in front of it is `requireStaff` in the `exams` handler: no token is 401, a
student or a stranger is 403, an inactive account is refused. Nothing reaches the database before that check.

## One audit entry per act

`exam.questions`, entity `exam`, with `{ mode, title, count, selected, matched, unchanged, missing }` — the
mode, the exam's title and the real count. **Never one entry per question**, and never an `exam.update`: the
exam itself did not change, its question list did.

## Applying it (the recipe, and how the live apply was done)

CLI 2.117.0 has **no `supabase db query` subcommand**; use the Management API query endpoint
(`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "…"}` — one request is one
session) or the dashboard SQL editor. Applying it that way leaves no tracking row, so the session that runs
it also inserts one (the pattern `docs/sql-jobs.md` describes):

1. Run the whole of `supabase/migrations/20260928000002_bulk_exam_questions.sql`.
2. Run `supabase/tests/bulk_exam_questions_test.sql` and require the message
   `BULK EXAM QUESTION TESTS PASSED (…)`. It creates its own questions and exams and ends by raising an
   exception on purpose, so the transaction rolls back and nothing it wrote survives — the message is the
   result.
3. Record it: a row in `supabase_migrations.schema_migrations` (`version` `20260928000002`, name
   `bulk_exam_questions`).
4. Deploy the Edge function, which is only possible after step 1 or the action would 500:

   ```
   python backend/sync_functions.py
   npx supabase functions deploy exams --no-verify-jwt --use-api
   ```

## How it was verified (in git, no live project needed)

* `deno test --allow-env backend/tests/` → **158 passed** (`backend/tests/exams.test.ts` grew five tests:
  `parseBulkQuestions` reads `exam_id` / `mode` / `ids`, dedupes a repeated id, caps the selection at 500,
  and refuses an unknown mode and an empty one; one `bulk_questions` call carries the three arguments and the
  signed-in actor; a database refusal comes back as 400 with the message and a real failure as a 500 with
  nothing quoted; a tokenless call is 401 with **zero** database calls).
* `python frontend/tests/exams_e2e.py` → **82 checks** (was 37): the editor's pick-questions affordance,
  the shared dialog's preview, a change shown in the editor's list but **not** sent to the server until
  Save, the guards, and the reorder control (grips and per-row numbers, `ArrowDown`/`Home`/`End` moving the
  focused row with the focus following it, the live-region announcement, a real pointer drag moving the row
  under the cursor and `Escape` putting the order back, Save writing the order on screen, the order
  surviving a reload, and the grip going disabled when a single question is left).
* `python frontend/tests/question_bank_e2e.py` → **151 checks** (was 129): the "add to / remove from an
  exam" entry, the exam choice being *skipped* when the dialog is opened from the exam already being edited,
  the wording naming the exam, and questions already on the exam being marked and untickable.
* `python frontend/tests/mock_server.py` grew a `bulk_questions` handler with the same rules — including the
  renumber-on-remove the real function now does.
* Unit tests: `deno test --allow-env --allow-read --no-check frontend/tests/unit/` → **42 passed**.
* All **thirteen** browser suites green.

## Applied live, 2026-09-28

Project **`lbhnadqmokloyfarrzfv`** (`English_Test_v2`).

1. **The migration is applied** (twice: the first run, then the renumber fix). `public.bulk_exam_questions(
   p_exam_id uuid, p_mode text, p_ids uuid[], p_actor uuid)` exists with `search_path = ''` and an ACL of
   `{postgres=X/postgres, service_role=X/postgres}` only — `anon` and `authenticated` cannot execute it.
2. **The SQL test passed**: `supabase/tests/bulk_exam_questions_test.sql` raised
   `BULK EXAM QUESTION TESTS PASSED (refusals, add in order with own points, idempotence, mixed and missing
   ids, remove and its counts renumbering what stays, an untouched other exam, emptying the list, one audit
   entry per act) — everything rolled back`. The HTTP status is 400, which is expected: the file's last
   statement is a `raise`, and that is how it rolls back. Its first run found a **real fault in the
   function**: the renumber used `exam_questions.id`, which does not exist (the primary key is
   `(exam_id, question_id)`), so it now keys on `question_id`.
3. **The tracking row is recorded**: `supabase_migrations.schema_migrations` has `20260928000002` /
   `bulk_exam_questions`, so a later `supabase db push` will not re-run it.
4. **`exams` was redeployed** with the `bulk_questions` action.
5. **The live check passed**: `frontend/tests/live_exam_bulk_check.py` → **58/58 checks,
   `ALL LIVE EXAM BULK CHECKS PASSED`** (and **43/43** with `--api-only`). It reached the deployed function
   and a real teacher session, created one throwaway draft exam and five throwaway questions of its own,
   proved every refusal including an archived question being offered and left untouched, drove the real exam
   editor once — including moving the newly added question to the **top** of the list with the keyboard and
   then saving, so the order proof is against the real `save_exam` and the real `exam_questions` table (dense
   positions 1..5, each row's own points) — and then deleted its exam and all five questions: the live
   project ended at **0 exams, 43 questions / 3 archived** — exactly what it measured before it started. The
   only thing it deliberately leaves behind is the audit history of its own acts (`exam.questions` rows at
   the time of writing).

Re-running it is safe and idempotent; it needs a credential:

```
python frontend/dev-server.py 8123                        # for its screen half
SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_exam_bulk_check.py
SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_exam_bulk_check.py --api-only   # skip the browser half
```

**The first run failed two checks, and both were the test's, not the feature's** — one of them pointing at a
real gap:

* *"the survivors keep their order and their points, renumbered with no gap"* — the rows came back at
  positions 1, 2, 4. The check was right and the **function** was wrong: remove did not close the gap. That
  is why the migration was applied a second time with the renumber statement.
* *"and no per-question exam.update rows pretend to be ours"* — mis-specified. The check's own screen half
  presses **Save**, and Save calls `save_exam`, which legitimately writes one `exam.update` for that exam. It
  now counts that one save and asserts nothing beyond it — which is the thing worth proving: the bulk path
  itself writes no `exam.update` row.

## The three lists, and what proves each of them

| List | Where | Order stored as | Proven by |
|---|---|---|---|
| The exam's questions | `examEditor.js` (`.chosen-item`) | `exam_questions.position`, numbered 1..n by `save_exam` from the payload | `exams_e2e.py` (82 checks, incl. a Save and a reload) and **live**: `live_exam_bulk_check.py` 58/58 — the screen half moves the new question to the top with the keyboard before saving, and the real rows come back in that order |
| The answer options | `questionEditor.js` (`.optrow`) | `question_options.position`, 1..8 from the array | `question_editor_e2e.py` (83 checks: letters follow the rows, the bubble stays on the right answer, the payload order) and **live**: `live_media_check.py` 41/41 — `Two`/`One` read back from `question_options` in that order with the correct one still marked |
| The attached files | `mediaPicker.js` (`.media-item`) — the same picker serves a question's files and a reading text's (`set_question_media` takes an owner) | `question_media.position`, from the array `set_question_media` is given | `media_e2e.py` (34 checks: a still-uploading row has no grip, the payload order) and **live**: `live_media_check.py` 41/41 — the MP3 read back first from `question_media` with no gap in the numbering |

A true/false pair is deliberately **not** reorderable: those two rows are fixed labels ("True", "False"), not
a teacher's list, and the bubble is what says which one is right.

## Still to do, and honestly not done

* **An exam that already has attempts could not be exercised live** — no exam on the project has any
  (`exam_sessions` is empty). The refusal is covered by the rolled-back SQL test; the live check prints a
  `note:` saying so instead of pretending otherwise.
* **No live exam with a running status was available either**; that refusal is SQL-test-covered only.
* **A bulk change is not a reorder.** The function only appends to the end of the list or closes the gap a
  removal leaves; deciding the order is the editor's job, and it is done there (the grip, the arrow keys and
  the `↑`/`↓` buttons above) before `save_exam` writes the list whole.
* **The two positions are numbered differently** — `question_options` from 1, `question_media` from 0 —
  because that is how `save_question` and `set_question_media` were written. It is harmless (order is what
  matters, and both are read back in it) and changing it would touch existing rows for no benefit, so it is
  written down here instead of quietly "fixed".
* **The 200-question ceiling is asserted twice on purpose** (SQL and `parseExamQuestions`); if that number
  ever changes, both places have to change together.
