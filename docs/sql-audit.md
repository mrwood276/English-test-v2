# SQL for the audit-log viewer (TASK-015)

Every staff action has written an `audit_logs` row inside its database function since v2_08 (BR-13):
`write_audit(p_actor, p_action, p_entity_type, p_entity_id, p_changes)` is the write side, and nothing
could read the rows back. TASK-015 adds the one function the admin's viewer needs. No table was added
or changed.

The function lives in **`supabase/migrations/20260929000000_audit_functions.sql`** and is **applied live
(2026-09-25)** — recorded in `supabase_migrations.schema_migrations` as `20260925001719` /
`v2_16_audit_functions`, alongside the deployed `audit` Edge Function (v1, ACTIVE). Do not re-apply it
blindly. To run SQL against the project: CLI 2.117.0 has **no `supabase db query` subcommand** (the
command in the sixteenth session's handoff does not exist) — use the Management API query endpoint
(`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "…"}`; one request
is one session, which is what lets a file's `pg_temp.*` helper work) or the dashboard SQL editor.

## Contract

| Function | Purpose |
|---|---|
| `list_audit_logs(p_limit, p_offset, p_action, p_entity_type, p_days)` | The read side of `audit_logs` (BR-13). Returns `{total, rows}` newest-first (`created_at desc, id desc`); each row carries `{id, created_at, actor_id, actor_name, action, entity_type, entity_id, changes}` with `actor_name` resolved from `profiles` (a row without an actor — a system action — stays null and the screen says "System"). `total` respects the filters, so the pager counts everything, not just the page. Limits: `p_limit` 1–200 (default 50), `p_offset` ≥ 0, `p_action`/`p_entity_type` exact-match filters, `p_days` a 1–3650-day window from now. Person-fixable mistakes raise with `hint = 'validation'` so the Edge answers a friendly 400. |

The function is `security definer` with `search_path = public` and its execute is revoked from
`public`, `anon` and `authenticated` (DEC-002, ISSUE-020), exactly like the other staff functions:
only the service role may call it. Who may read is decided one layer up: the `audit` Edge Function
checks `requireStaff(req, db, ["admin"])` — reading the system's audit log is an admin job
(design.md 1.2), which makes this the one staff endpoint a teacher cannot call.

### What the rows say

Actions recorded today (all written by the function that does the thing, with the staff member as
`actor_id`): `question.create`, `question.update`, `question.archive`, `question.restore`,
`question.import`, `passage.create`, `passage.update`, `passage.delete`, `media.upload`, `grade`,
`add_time`, `reopen`, `retake_grant`, `retake_revoke`, and the exam actions (`create`, `update`,
`open`, `set_status`, `regenerate_code`). Entity types: `question`, `passage`, `media`, `exam`,
`exam_session`. `changes` holds a small JSON summary of what changed (never secrets, tokens or
answer keys — the writer's contract in `backend/functions/_shared/audit.ts`).

## How it was verified

**SQL** — `supabase/tests/audit_functions_test.sql`, written against the same rolled-back-transaction
technique as the result engine test:

```
# one request = one session, so the file's pg_temp helper works: (CLI 2.117.0 has no `supabase db query`)
python - <<'PY'
import json, os, pathlib, urllib.error, urllib.request
sql = pathlib.Path("supabase/tests/audit_functions_test.sql").read_text()
req = urllib.request.Request(
    "https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"], "Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req).read().decode())
except urllib.error.HTTPError as e:
    print(e.read().decode())   # success: P0001: AUDIT VIEWER TESTS PASSED (all rows rolled back)
PY
```

Ends with `AUDIT VIEWER TESTS PASSED (all rows rolled back)`. It covers: the exact count under the
`audit_test` entity marker (live rows can never disturb it); newest-first order; the action, entity and
days filters; paging with limit/offset; the actor-name join (and the actor-less row); the `changes`
payload; and the friendly validation refusals. **Run live on 2026-09-25: it answered `AUDIT VIEWER TESTS
PASSED (all rows rolled back)`, with row counts unchanged afterwards (4 audit rows, no `audit_test` rows
left, 40 questions).**

**Deno, mocked database** — `backend/tests/audit.test.ts` (8 tests: the admin-only wall, defaults,
filter pass-through, friendly refusals, the auth wall, error handling).

**Browser, mocked server** — `frontend/tests/audit_e2e.py`: the admin menu entry, the table and its
five columns, "System" for an actor-less row, every filter, the empty state, paging, and that the
screen only ever asks to `list`.
