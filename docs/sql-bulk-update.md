# SQL for changes to many questions at once (F-05)

The question bank lets a teacher tinker with one question at a time (`#/questions/new` →
`save_question`, one transaction per question). F-05 asks for the other half: **tick many questions,
say what should change, see what will happen, and have it happen once** — select → filter → bulk edit →
preview → apply → feedback.

The statements live in **`supabase/migrations/20260928000001_bulk_question_update.sql`** and are **NOT
APPLIED LIVE YET** (written 2026-09-28 in a session with no Supabase credential — see "Applying it" below).
The Edge layer is **`backend/functions/question-bank/`** (`action: "bulk_update"`, deployed with the rest of
that function), the screen is **`frontend/assets/js/teacher/screens/questionBank.js`** with the dialog in
**`frontend/assets/js/teacher/components/bulkEditDialog.js`**.

## Why the work happens in one database function

DEC-004 says a business rule is one database function and one transaction. A bulk change is the clearest
case for it:

* **All or nothing.** Forty questions get their topic changed, or none of them do. A loop of forty `save`
  calls from the Edge layer can stop after sixteen and leave the bank in a state nobody asked for — and the
  teacher would be told "success" or, worse, nothing.
* **One audit entry per act, not per question** (`question.bulk_update`, with how many questions really
  changed and what was asked for). Forty `question.update` rows would bury the one fact worth keeping.
* **One round trip.** The Edge layer validates and calls; the size limits, the topic lookup, the class-label
  editing and the archive flag are decided in SQL, where the current rows are.

## The contract

```sql
public.bulk_update_questions(p_ids uuid[], p_changes jsonb, p_actor uuid) returns jsonb
```

`p_changes` keys, all optional, **at least one required**:

| Key | Type | Meaning |
|---|---|---|
| `topic` | text | Set the topic; a new name is created, an existing one is matched case- and space-insensitively (`upsert_topic`). `""` or `null` **clears** the topic. |
| `difficulty` | `easy` \| `medium` \| `hots` | The `difficulty_level` enum, no new values. |
| `weight` | number | `default_weight`, more than 0 and at most 100 — the same rule `save_question` enforces. |
| `archived` | boolean | Archive or restore. Archive, never delete (DEC-005: results keep working). |
| `class_labels` | object | `{ mode: "add" \| "remove" \| "replace", labels: [text, …] }` — `add` keeps what a question has and adds these, `remove` takes exactly these away, `replace` ends with exactly these. |

A key that is **absent means "leave this field alone"**. The dialog's "keep as it is" options produce no key
at all, so "keep" is never a value the database has to interpret — and a caller cannot smuggle a field that
is not on this list (the Edge layer whitelists, so `body`, `options`, `content_hash` and friends are simply
not reachable through `bulk_update`).

The reply is the honest count of what happened:

```json
{ "matched": 3, "updated": 2, "unchanged": 1, "missing": 0 }
```

* `matched` — how many of the selected ids still exist (`≤` the selection).
* `updated` — how many questions really changed. A question that already looked the way it was asked to look
  is **not** counted and its `updated_at` is not bumped.
* `unchanged` — `matched - updated`.
* `missing` — ids that no longer exist. A question deleted in another tab is skipped and counted; it never
  fails a whole batch, and it is never hidden from the teacher.

## Validation, and why every message is friendly

Problems the teacher can fix raise an exception with `hint = 'validation'`; the Edge layer turns those into
a 400 with the message as-is (`callRpc`). The list: an empty selection, a selection over 500, no change at
all, an unknown difficulty, points out of range, an unknown label action, adding nothing, a label over 40
characters, more than 10 labels on a question (including the ones it already has, when adding), a topic over
120 characters, and a selection that matches nothing at all ("Those questions no longer exist. Refresh the
list and try again."). Anything else is a 500 with no database detail quoted to the browser.

## The boundary

```sql
revoke execute on function public.bulk_update_questions(uuid[], jsonb, uuid) from public, anon, authenticated;
grant execute on function public.bulk_update_questions(uuid[], jsonb, uuid) to service_role;
```

Only the service role — that is, only an Edge Function — may call it, exactly like every other function in
this schema (ISSUE-020). The door in front of it is `requireStaff` in the `question-bank` handler: no token
is 401, a student or a stranger is 403, and an inactive account is refused. Nothing reaches the database
before that check, so a malicious caller cannot touch a question the question bank would not let them touch,
and they cannot raise their own privileges: `bulk_update_questions` writes only the fields listed above.

## Applying it

CLI 2.117.0 has **no `supabase db query` subcommand**; use the Management API query endpoint
(`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "…"}` — one request is one
session) or the dashboard SQL editor. Applying it that way leaves no tracking row, so the session that runs
it also inserts one (the pattern `docs/sql-jobs.md` describes):

1. Run the whole of `supabase/migrations/20260928000001_bulk_question_update.sql`.
2. Run `supabase/tests/bulk_update_test.sql` and require the message
   `BULK UPDATE TESTS PASSED (…)`. It creates its own questions and ends by raising an exception on purpose,
   so the transaction rolls back and nothing it wrote survives — the message is the result.
3. Record it: a row in `supabase_migrations.schema_migrations` (`version` `20260928000001`, name
   `bulk_question_update`).
4. Deploy the Edge function, which is only possible after step 1 or the action would 500:

   ```
   python backend/sync_functions.py
   npx supabase functions deploy question-bank --no-verify-jwt --use-api
   ```

## How it was verified (in git, no live project needed)

* `deno test --allow-env backend/tests/` → **153 passed** (`backend/tests/question_bank.test.ts` grew six
  tests: the parser sends only what was asked for and reads a blank topic as "remove it", it refuses a
  change that would change nothing or too much — including 501 ids, an unknown difficulty, points of 0 or
  101, an unknown label action, an eleventh label and an over-long topic — one `bulk_update` call carries
  `p_ids`, `p_changes` and the signed-in actor, a database refusal comes back as 400 with the message and a
  real failure as a 500 with nothing quoted, and a tokenless call is 401 with **zero** database calls).
* `python frontend/tests/question_bank_e2e.py` → **129 checks**, of which **62 are new**: no bar until
  something is ticked, the header box picks or clears the page, the half-ticked state, the counter and the
  "N not on this page" hint, picks adding up across pages, a filter change keeping the ticks, the archived
  switch clearing them (it flips what the buttons mean), "All 25 questions on this page are selected →
  Select all 28 matching questions" taking the whole result in one request, the dialog on keep-as-it-is, the
  refusal of an empty change set, the preview's wording, one request carrying every id with the untouched
  fields absent, only the picked questions changing, "Nothing changed — those questions already looked like
  that.", "1 question updated · 1 is no longer there", a refused change explained inside the dialog with the
  question untouched and a retry that works, closing without applying keeping the ticks, bulk archive and
  bulk restore behind a confirm dialog, and the "up to 500 at a time" guard changing and fetching nothing.
  The mock server (`frontend/tests/mock_server.py`) grew a `bulk_update` handler with the same rules.
* The other twelve browser suites are unchanged and green (689 checks in total).

## Running it against the live project (TASK-024)

`frontend/tests/live_bulk_check.py` is written and **has never been run** — the session that wrote it had no
Supabase credential (see ISSUE-033). It needs one:

```
python frontend/dev-server.py 8123                        # for its screen half
SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_bulk_check.py
SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_bulk_check.py --api-only   # skip the browser half
```

What it does, and what it promises: it **creates three throwaway questions of its own** (`LIVE BULK CHECK
<stamp>` in each body), changes them in bulk through the deployed function — topic, difficulty, points, class
labels add/remove/replace, an id that is gone, archive and restore — tries every refusal (tokenless 401, no
change, unknown difficulty, points out of range, unknown label action, no labels, more than 500 ids, a
selection that no longer exists), drives the real screen once (filter, select the page, choose a **new**
topic, read the preview, apply), checks the audit trail (one entry per act with the real count, and no
`question.update` rows for its ids), then **deletes its three questions and its two test topics** and compares
the live counts with the ones it took at the start. The owner's own questions are never modified — the one
real question it reads is a control, fetched before and after. The only thing it deliberately leaves behind
is the audit history of its own acts.

## Still to do, and honestly not done

* **`supabase/tests/bulk_update_test.sql` has never been run.** It is written against the real catalogue
  (`save_question`, `upsert_topic`, `question_class_labels`, `difficulty_level`, the audit table) and its
  header says so; it is the one file in this feature without a pass behind it. Run it as step 2 above.
* **`frontend/tests/live_bulk_check.py` has never been run either** — it compiles, and its two halves refuse
  to start without a credential and say so, but no pass line exists for it yet.
* **A bulk change does not touch the question text, answers, explanation or reading text** — deliberately.
  Those are per-question decisions, and a batch edit of a shared reading text is a de-duplication problem
  (see `duplicateGroupsDialog`), not a bulk-edit one.
* **Permanent delete is not part of a bulk change.** The bar offers archive/restore; deleting forty
  questions in one unconfirmed act is not a feature worth having.
