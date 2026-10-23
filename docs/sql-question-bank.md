# Question bank — teacher data isolation (TASK-048, DEC-041)

The question bank's rules live in SQL functions; the `question-bank` Edge Function only checks who is
calling (`requireStaff`) and forwards. **Since `20261003000000_question_bank_isolation.sql`, every one
of those functions also checks what the caller owns.**

## The model (DEC-041, the owner's choice: the strict one)

- A **teacher** sees and changes only their own rows: `created_by = p_actor`.
- An **active admin** (`profiles.role = 'admin' and is_active`) sees and changes the whole school.
- A **null actor fails closed**: `_is_staff_admin(null)` is false and `created_by = null` matches
  nothing, so a forgotten `p_actor` returns empty results, never the whole bank.
- A **foreign id is exactly as invisible as a missing one** — reads return null/empty, writes raise
  the same "That question/reading text no longer exists." sentence with `hint = 'validation'`, so the
  Edge function answers a friendly 400 and nothing leaks existence.
- **Students are untouched** — they join by exam code and never call these functions.
- **Topics and class labels stay a shared taxonomy** (one school, one list), but their question
  counts count only the actor's own non-archived questions (`list_class_labels` also joined to
  `questions` now, which makes its counts match what `list_topics` always counted).
- The admin bypass lives in SQL (`public._is_staff_admin`), so it holds for any future caller — the
  same reasoning as DEC-031's account guards.

## Per-function rules

| Function | Signature now | Rule |
|---|---|---|
| `save_question` | `(uuid, jsonb, uuid)` | create: `created_by = actor`; update: only a row the actor owns; the referenced `passage_id` must be the actor's too |
| `remove_question` | `(uuid, uuid)` | existence check scoped → foreign id = "no longer exists" (delete-or-archive rule unchanged) |
| `set_question_archived` | `(uuid, boolean, uuid)` | update scoped |
| `get_question` | `(uuid, uuid)` | row filtered → null for a foreign id (Edge answers 404) |
| `list_questions` | `(jsonb, uuid)` | every row filtered before paging/counting |
| `find_similar_questions` | `(text, text[], uuid, real, uuid)` | candidates filtered (the editor's duplicate check sees only the actor's questions) |
| `find_similar_batch` | `(jsonb, real, uuid)` | forwards its actor to `find_similar_questions` |
| `find_duplicate_groups` | `(real, int, uuid)` | exact groups and similar pairs both filtered; a cross-owner pair can no longer exist anywhere |
| `list_topics` | `(uuid)` | shared list, own counts |
| `list_class_labels` | `(text, uuid)` | shared list, own counts (non-archived only, like `list_topics`) |
| `save_passage` | `(uuid, jsonb, uuid)` | create: `created_by = actor`; update scoped |
| `get_passage` | `(uuid, uuid)` | row filtered → null |
| `list_passages` | `(text, uuid)` | rows filtered |
| `remove_passage` | `(uuid, uuid)` | existence scoped (the "used by N questions" check is deliberately unscoped: the passage is the actor's own, so the count tells them which of *their* questions hold it) |
| `import_questions` | `(jsonb, uuid)` | a `passage` is matched by title **only against the actor's own**; otherwise a fresh own passage is created — an import can no longer inherit another teacher's reading text |
| `bulk_update_questions` | `(uuid[], jsonb, uuid)` | existence check scoped; foreign ids count as `missing`, exactly like ids a purge removed (all-or-nothing rule unchanged) |

The old unscoped signatures are **dropped** by the migration (`get_question(uuid)`,
`list_questions(jsonb)`, `find_similar_questions(text, text[], uuid, real)`, `find_similar_batch(jsonb, real)`,
`find_duplicate_groups(real, int)`, `list_topics()`, `list_class_labels(text)`, `list_passages(text)`,
`get_passage(uuid)`) — keeping them would have left unscoped functions behind.

## Not covered here (later slices of the same roadmap)

Exams, results, and the monitor are still role-checked only (`requireStaff`); a teacher can still see
another teacher's exams and results. That is the next isolation slice (exams first), decided with the
owner in the same session. Media files follow their own `media` function; the media attached to a
question is only reachable through the question's own (now scoped) payload, but the media endpoints
themselves are not owner-filtered yet. `used_in_exams` counts every exam that references a question,
regardless of the exam's owner — factual metadata about the question itself, to be revisited with the
exam slice.

## Apply order — done live 2026-10-03

1. Applied `supabase/migrations/20261003000000_question_bank_isolation.sql` as ONE Management API
   request with its ledger row (`20261003000000` / `question_bank_isolation`).
2. **Redeployed the `question-bank` Edge Function** immediately after — the deployed handler now has the
   new `p_actor` arguments. SQL first, redeploy second; either one alone breaks the endpoint
   (missing or extra rpc arguments).
3. `supabase/tests/question_bank_isolation_test.sql` passed live (finished with the
   `QUESTION BANK ISOLATION TESTS PASSED (...)` raise, delivered as an HTTP 400 body).
4. Result recorded: this section, the migration header, and `.ai/`. One fixture fault found and fixed in
   the SQL test file itself (assigning uuid into a jsonb variable); no product change.

Status: **written 2026-10-03, not yet applied live** (no Management credential in the session).
Existing data needs no repair — every row already carries its true `created_by`.
