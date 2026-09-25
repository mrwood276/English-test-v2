# SQL for the duplicate overview (TASK-020)

The question bank can already compare **one** question against the bank while it is written
(`find_similar_questions`, used by the editor's live warning). Mockup 6 asks for the other direction:
the list itself should notice that the bank holds questions that read like copies of each other, and
say so — *"N questions look like duplicates of each other."* with a **Review** action.

`find_duplicate_groups` is that whole-bank scan. It is **read-only**: no table, index or privilege
change, and it writes nothing (it is `stable`).

## Where it lives

| Live migration | File in this repository |
|---|---|
| `20260925060607` / `v2_17_duplicate_overview` | `supabase/migrations/20260925060607_v2_17_duplicate_overview.sql` |
| `20260925060638` / `v2_17_duplicate_overview_fix_search_path` | `supabase/migrations/20260925060638_v2_17_duplicate_overview_fix_search_path.sql` |

Both rows were applied live on **2026-09-25 06:06 UTC by an earlier session that left no file and no
commit behind** (that drift was ISSUE-024). On the owner's instruction the two statements were taken
**verbatim out of `supabase_migrations.schema_migrations.statements`** and committed as files (DEC-028) —
they were *not* rewritten, and nothing was re-applied to the live database. The `fix_search_path`
migration exists because the first version set `search_path = public`, which cannot resolve the
trigram `%` operator or `similarity()`; the second sets `search_path = public, extensions`. Both live
rows are real history, so both files are kept.

The file names are the live version numbers on purpose: a later `supabase db push` compares the
version column, so these two are recognised as applied instead of being applied again. (This is the
opposite of the older round-numbered files in the same folder — see ISSUE-001.)

To run SQL against the project: CLI 2.117.0 has **no `supabase db query` subcommand** — use the
Management API query endpoint (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with
`{"query": "…"}`) or the dashboard SQL editor.

## Contract

| Function | Purpose |
|---|---|
| `find_duplicate_groups(p_threshold real default 0.55, p_limit int default 50)` | Returns `{question_count, exact_groups, similar_pairs}` over the **non-archived** questions. `exact_groups` holds one entry per `content_hash` (v2_06) shared by more than one question; `similar_pairs` holds pairs whose texts pass the trigram similarity threshold and do **not** share a hash, worse-first and capped by `p_limit`. `question_count` is the number of **distinct** questions involved, which is the number the banner shows. Refusals: `p_threshold` 0–1, `p_limit` 1–200, raised with `hint = 'validation'` so the Edge answers a friendly 400. |

Payload shapes (each `questions[]` entry is `{id, body, used_in_exams}`, and the screen uses
`used_in_exams` to say *"used in 3 exams"* or *"not used yet"*):

```json
{
  "question_count": 6,
  "exact_groups": [{ "kind": "exact", "questions": [ {…}, {…} ] }],
  "similar_pairs": [{ "kind": "similar", "similarity": 0.57, "questions": [ {…}, {…} ] }]
}
```

The function is `security invoker`, `stable`, with `search_path = public, extensions`, and its execute
is revoked from `public`, `anon` and `authenticated` (DEC-002, ISSUE-020): only the service role may
call it. **Who may see the result is decided one layer up** — the `question-bank` Edge Function's
`duplicate_groups` action sits behind `requireStaff`, so a teacher and an admin both get it, and a
tokenless call is refused with 401.

**No filters.** The screen asks with no arguments at all, so the SQL defaults *are* the contract; the
backend test asserts the call carries no arguments.

## The screen side

- `frontend/assets/js/teacher/screens/questionBank.js` shows the banner over the list (mockup 6 style:
  `--mark-tint` background, alert icon, underlined **Review**) with the server's own count, and asks
  for the scan **once per visit** — not on every filter change. It re-scans after archive, restore and
  delete, so the notice follows the bank. A scan that fails only hides the banner (`console.warn`); the
  list itself never fails because of it.
- `frontend/assets/js/teacher/components/duplicateGroupsDialog.js` is the Review dialog: one section
  per group ("Same text (2 questions)" or "57% alike"), every question linking to its editor, and the
  dialog closes itself when the address changes so a link never leaves it over the editor.

## How it was verified

**Verbatim-ness (one-off, worth repeating after any edit to those two files)** — compare each file's
statement with the live row:

```
python - <<'PY'
import json, os, urllib.request
from pathlib import Path
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
def q(sql):
    req = urllib.request.Request("https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req))
live = {r["version"]: r["statements"][0] for r in q(
    "select version, statements from supabase_migrations.schema_migrations "
    "where version in ('20260925060607','20260925060638')")}
norm = lambda t: "\n".join(l.rstrip() for l in t.replace("\r\n", "\n").split("\n")).strip()
for version, name in [("20260925060607", "20260925060607_v2_17_duplicate_overview.sql"),
                      ("20260925060638", "20260925060638_v2_17_duplicate_overview_fix_search_path.sql")]:
    text = Path("supabase/migrations/" + name).read_text(encoding="utf-8")
    body = text[text.index("create or replace"):]      # drop this file's header comment
    print(version, "VERBATIM" if norm(body) == norm(live[version]) else "MISMATCH")
PY
```

**LIVE, read-only** — `frontend/tests/live_duplicates_check.py` (**15/15, 2026-09-25**), signed in as
the staff test account `testguru211l@gmail.com` (role `teacher`). It signs in with the account's
password when `SUPABASE_TEST_PASSWORD` is set, and otherwise — this is the useful part — mints a
one-time login link through the Auth admin API with the Management token already used by the other
live checks, so **no password has to be written down anywhere**. Then it: calls the deployed
`question-bank` (`duplicate_groups`) and gets the live count (**6 questions: 0 exact groups, 3 similar
pairs** on the real 40-question bank); confirms a tokenless call is 401; asks the SQL function
directly through the Management API and gets the same number (**the Edge layer invents nothing**);
loads `#/questions` in Chromium with that real session and sees the banner carry exactly the server's
count; confirms filtering the list runs the scan no second time; opens **Review** and finds one section
per group the server sent, every question linked to its own editor, the same similarity percentages
and a used-count line per question; and no page errors. It writes nothing, so there is nothing to clean
up. (Re-run it: `python frontend/dev-server.py 8123`, then
`SUPABASE_ACCESS_TOKEN=… SUPABASE_TEST_EMAIL=testguru211l@gmail.com python frontend/tests/live_duplicates_check.py`.)

**Deno, mocked database** — `backend/tests/question_bank.test.ts` (120 backend tests in total): the
action is accepted, calls `find_duplicate_groups` with **no arguments**, returns the payload untouched,
and is available to a **teacher** as well as an admin.

**Browser, mocked server** — `frontend/tests/question_bank_e2e.py` (**67 checks**, 10 of them new):
the notice and its count, the single whole-bank call, the Review dialog's groups, links, percentages
and used-counts, Escape closing it, the notice disappearing after a change when nothing is left to
review, the same notice staying hidden when the scan fails while the list still loads, and no scan on
filter changes or console errors. Falsified before trusting it: with the banner switched off the suite
dies on `waiting for locator(".banner:not([hidden])")`.
