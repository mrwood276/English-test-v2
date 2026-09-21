# 00 AI RULES (read this first)

Rules for every AI agent (Claude, Codex/GPT, or any other) working in this repository.
Last verified against the repository: 2026-09-21 (commit `ad9b6d6` plus uncommitted-at-the-time import work; see `04_CURRENT_STATE.md`).

## 0. What `.ai/` is, and what it is not

`.ai/` is **contextual memory**: a shared project context, decision history, task queue, and handoff channel for AI agents.
It is **not** the source of truth. When `.ai/` and reality disagree, reality wins and `.ai/` must be corrected.

Source-of-truth hierarchy (highest first):

1. Actual source code in this repository
2. The live database/schema (Supabase project `lbhnadqmokloyfarrzfv`) and deployed Edge Functions
3. Tests and verified behavior
4. Git history
5. `.ai/` documentation (and `docs/design.md`, which is the product specification; the code overrides it where they differ)

If you find a conflict, do not follow `.ai/` blindly: inspect the code, then fix the documentation in the same change.

## 1. Before working (mandatory reading order)

1. `00_AI_RULES.md` (this file)
2. `01_PROJECT.md`
3. `02_ARCHITECTURE.md`
4. `03_FEATURES.md`
5. `04_CURRENT_STATE.md`
6. `05_TASK_QUEUE.md`
7. `06_DECISIONS.md`
8. `08_HANDOFF.md`
9. `09_KNOWN_ISSUES.md`
10. Then **inspect the actual source files** for the area you will touch, before changing anything.

Also read `docs/design.md` (product requirements, business rules BR-01..BR-22, data model, phases) when working on features that are not implemented yet.

## 2. Environment facts an agent must know (verified 2026-09-21)

| Topic | Fact |
|---|---|
| Repository | GitHub `mrwood276/English-test-v2` (private). Frontend and backend live together. |
| Database and functions | Supabase project **English_Test_v2**, ref `lbhnadqmokloyfarrzfv`, region ap-southeast-1. Changes to the database and to deployed Edge Functions are made **in the live project**, not by `git push`. |
| Migrations in git | **Not present.** The SQL of migrations `v2_01`..`v2_12` exists only inside the Supabase project (see `09_KNOWN_ISSUES.md` ISSUE-001). |
| Claude (claude.ai chat) | Has a sandbox (Deno 2.x, Python + Playwright, git) and the Supabase connector (apply_migration, execute_sql, deploy_edge_function). It has **no GitHub push/pull tool** in the chat used so far; it hands changes over as a repository zip which the owner pulls and pushes. |
| Codex/GPT | UNKNOWN / NEEDS VERIFICATION whether it can reach the Supabase project. If it cannot, any task that needs a database migration or an Edge Function deployment must be marked `BLOCKED` (see section 9) rather than worked around. |
| Owner | Communicates in casual Indonesian. All product UI text is English. Documentation in this repo is English. |
| Local run | Frontend: `python frontend/dev-server.py` then open `http://localhost:8000/teacher/`. Not deployed anywhere yet. |

## 3. Anti-rebuild rule

Never rebuild an existing feature because you prefer another implementation. Before creating anything, check:

- Does it already exist? Is it partially implemented?
- Is there an existing component/function/table/API for it (`03_FEATURES.md`, then grep the code)?
- Can the existing implementation be extended?

Reuse existing systems. Features marked `PROTECTED` in `03_FEATURES.md` may only receive the changes listed as allowed there.
Every protected feature carries the sentence: `DO NOT REBUILD THIS FEATURE WITHOUT A SPECIFIC REASON.`

## 4. Anti-duplicate rule

Do not create a second: page, component, function, database table, Edge Function endpoint, authentication mechanism, utility, or style
unless a documented reason exists in `06_DECISIONS.md`. In particular:

- Text rules exist twice on purpose (JS `backend/functions/_shared/text.ts` and SQL `public.normalize_text` / `public.question_content_hash`). Change both together or neither (DEC-005).
- Question saving has exactly one implementation: SQL function `public.save_question`. Do not add another path that inserts into `questions` directly.
- Staff authentication has exactly one implementation: `requireStaff` in `backend/functions/_shared/auth.ts`.

## 5. Architecture protection

Do not change the fundamental architecture without documenting in `06_DECISIONS.md`: what changed, why, affected files and features,
migration requirements, and risks. The protected architecture list is in `02_ARCHITECTURE.md` ("Protected Architecture Decisions").

## 6. Scope control

- Do not modify unrelated files. Do not refactor large parts "because it could be cleaner".
- Prefer the smallest safe change that solves the requested problem.
- Do not change application behavior merely to produce documentation.
- Do not add new dependencies without a reason recorded in `06_DECISIONS.md`. The frontend deliberately has **no build step and no runtime dependencies** (DEC-007); the backend uses only `npm:@supabase/supabase-js@2` inside `_shared/db.ts`.

## 7. Verification

Never claim something works unless it was actually verified. State what kind of verification happened:

| Level | Meaning |
|---|---|
| `LIVE-VERIFIED` | The owner or an agent ran it against the real Supabase project. |
| `TESTED` | Passes automated tests (Deno unit tests, SQL tests run against the live database inside rolled-back transactions, Playwright tests with mocked network). |
| `UNVERIFIED` | Written but not run against anything real. |

Test commands:

```
deno test --allow-env backend/tests/                      # backend unit tests (also run by GitHub Actions)
python frontend/tests/make_fixtures.py                     # once, creates sample files in /tmp/media_fixtures
python frontend/dev-server.py 8123                         # keep running in another terminal
python frontend/tests/teacher_e2e.py                       # sign in
python frontend/tests/question_bank_e2e.py                 # list, filters, preview, archive/delete
python frontend/tests/question_editor_e2e.py               # editor
python frontend/tests/media_e2e.py                         # images and audio (mocked storage)
```

The frontend tests need Playwright (`pip install playwright && playwright install chromium`) and use a **mocked** server (`frontend/tests/mock_server.py`).
They do not prove that the real Supabase behaves the same. SQL business rules were tested by running `DO` blocks against the live database that end with a deliberate exception (so nothing is kept); this technique is described in `04_CURRENT_STATE.md`.

## 8. Database and deployment rules

- Every table has RLS enabled and **zero policies**; `anon` and `authenticated` have no table privileges. Never add a policy or grant "to make something work". Data access goes through Edge Functions using the service role.
- Business rules that must be atomic are Postgres functions (`public.*`), called by Edge Functions through `callRpc`. Problems the person can fix are raised with `using hint = 'validation'`, which the Edge layer turns into a friendly HTTP 400.
- Any schema change must be a new numbered migration (`v2_NN_name`). Because migrations are not yet stored in git, **also save the SQL under `supabase/migrations/`** in the same change (see ISSUE-001) and list it in `07_CHANGELOG.md` and `08_HANDOFF.md`.
- Deploying an Edge Function: with the CLI (`supabase functions deploy <name> --no-verify-jwt`) the source imports `../_shared/...` as is. When uploading files through the API/connector, upload the function plus the needed `_shared` files and rewrite `../_shared/` to `./_shared/`. `verify_jwt` stays `false` for every function because each function verifies the caller itself.
- Record every deployment (function name, version) in `04_CURRENT_STATE.md`. Deployed code and repository code can drift (this happens today, see `04_CURRENT_STATE.md`).
- Never put the service role key, passwords, tokens, or `.env` files in the repository. The publishable key in `frontend/assets/js/core/config.js` is public by design.

## 9. If you cannot complete a task

1. Stop rather than guess.
2. Document the blocker (what you tried, what is missing).
3. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, and `08_HANDOFF.md`.
5. Continue with another `READY` task if appropriate.

## 10. Owner working agreement (source: owner's project brief, applies to all agents)

- Understand, ask, analyze, design, confirm, then implement. Do not decide important product features on the owner's behalf: explain options briefly with trade-offs and ask.
- Mark features as mandatory, important, optional, or deferred. Do not add features only because they seem nice. Do not remove existing features without a reason and approval.
- Work in small phases; make each phase stable before starting the next (phases are in `docs/design.md`, section 5).
- When changing code, explain: what changed, files affected, why, and impact. Give complete code for changed parts, not fragments.
- When something fails, analyze the cause first; never guess-fix.
- Ask questions in small batches with clear options; the owner answers faster with tappable choices (in Claude this is the ask-user tool).
- The owner reviewed and approved the visual direction ("answer sheet") through mockups; see DEC-008.

## 11. Coding conventions (verified from the existing code)

- Product UI text is English. Error messages shown to people are short, friendly, and say what to do next.
- Frontend: plain ES modules, no framework, no innerHTML with data. Build elements with `h()` from `frontend/assets/js/shared/dom.js`. Rich (teacher-written) text is displayed only through `shared/rich.js`. Icons come from `shared/icons.js` (fixed strings).
- Server errors: throw `ApiError` helpers from `backend/functions/_shared/errors.ts`; every endpoint is wrapped by `handle()` from `_shared/http.ts`. Unexpected errors are logged with a request id and shown to the person as a generic message.
- Input validation lives in `_shared/validate.ts` (friendly 400 messages naming the field). All input is also validated again inside the SQL functions.
- Every action a teacher/admin takes that changes data writes an audit entry **inside the same SQL function** (`public.write_audit`).
- Tests accompany every behavior change: Deno test for parsing/handlers, SQL test (rolled back) for database rules, Playwright test for screens.

## 12. Commit and sync protocol

Target workflow: read `.ai/` → do one task → test → update `.ai/` (state, task queue, changelog, handoff, plus decisions/issues if applicable) → commit → push.
Current limitation: Claude in the claude.ai chat cannot push; it delivers the repository (with commits) as a zip and the owner runs `git pull <folder> main` then `git push`. If you have direct git access, push yourself. Never rewrite pushed history.

## 13. Documentation duty after every meaningful change

| File | Update when |
|---|---|
| `03_FEATURES.md` | A feature's status, files, or limitations change |
| `04_CURRENT_STATE.md` | Always (last agent, date, what is deployed, what is verified) |
| `05_TASK_QUEUE.md` | Always (task status, next recommended task) |
| `07_CHANGELOG.md` | Always (what changed, files, database changes) |
| `08_HANDOFF.md` | Always (never leave it describing an outdated state) |
| `06_DECISIONS.md` | An architectural/technical decision is made or reversed |
| `09_KNOWN_ISSUES.md` | A bug or limitation is found or fixed |
