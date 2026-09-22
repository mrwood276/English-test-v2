# 08 HANDOFF

Keep this file current after every meaningful change. It must never describe an outdated state.

## Branch Context (read this first)

| | |
|---|---|
| Stable Branch | `main` — currently at commit `46803f0`. Not the workspace; do not commit normal work here. |
| Current Development Branch | **`ai-development`** — branched from `main` at `46803f0`, holds `6f5c223` (import parsers) plus the 2026-09-22 import-screen work. This is where you work. |
| Merged into `main`? | **No.** `ai-development` still has open TASK-006 work (deploy + owner review). Do not merge it yourself; that is the owner's deliberate decision (DEC-020). |

Before doing anything: `git checkout ai-development` (or confirm you're on it), `git pull` **and `git fetch origin`** to see the real remote state, `git log --oneline -5` and `git status` — another agent may have pushed since this entry was written. **This handoff was wrong once already**: on 2026-09-21 Codex pushed TASK-006 work straight to `main` while the handoff still said `main` was at `46803f0` (see ISSUE-015 / DEC-021). Never treat this file as proof of the remote state.

## Collision notice (read before touching import files)
`origin/main` contains Codex/GPT-5's own parallel implementation of the import parsers + screen (commits `d21f82d`, `1606aed`, `9c293fc`, 2026-09-21), which conflicts file-by-file with the `ai-development` implementation. The owner decided (DEC-021, 2026-09-22): **continue with `ai-development`'s version; Codex's `main` commits stay untouched and get superseded at the next deliberate merge.** Do not port Codex's variant back, and do not "reconcile" the two on your own initiative.

## Last Agent
Buffy (Freebuff desktop agent, fifth session — fourth built the exam screens/backend; direct git access to `origin`; **live Supabase access via the owner's access token (CLI) + admin credentials for the flow check — both session-only, not stored in the repo**).

## Date
2026-09-22 (fifth session)

## Last Completed Task
- **TASK-009 live step + TASK-006 step 3 done (fifth session)**: the exam SQL was applied to the v2 project (first migration in git: `supabase/migrations/20260922000000_exams_functions.sql`), the `exams` function deployed (v1), and `question-bank` v3 deployed (import actions live — ISSUE-003 closed). The whole exam flow was live-verified with the admin account: save draft (weights) → get → list → update → open → code-uniqueness refusal among open exams → check_code → regenerate_code → duplicate → remove, plus refusals (empty manual exam at save, end-before-start schedule) and the tokenless 401 wall. Three real schema facts were discovered and fixed while applying the SQL (enum casts, `auto_filter` NOT NULL, `position > 0`, access_code CHECK in duplicate_exam, `list_exams` return-type drop) — all recorded in `docs/sql-exams.md`. A parser default (`draw_per_student` false when absent) was fixed and redeployed. All test exams + audit rows were deleted afterwards: live state 0 exams, 40 questions.
- Fourth session: **TASK-009 teacher-side exams built**: `exams` Edge Function (8 actions) + 24 Deno tests (backend 41 → 65); exams list + editor screens per mockup 11 (manual/auto selection, schedule, live code check, tab limits 1/3/5, templates, duplicate, leave guard); routes `#/exams*`; Exams menu item live; mock-server exams handlers; `exams_e2e.py` (25 checks).
- **`docs/verification-checklist.md` written** — step-by-step owner instructions for the Supabase-side work (sign-up off, deploy v3, media upload check, migrations export).
- Second session: **TASK-018 done / ISSUE-006 closed** (`.github/workflows/frontend-tests.yml`), **ISSUE-014 fixed**, editor flake fixed (ISSUE-016).
- First session the same day: **TASK-006 steps 1–2 complete** (import screen, zip/xlsx tests, mock handlers, browser suite, templates) — commit `4493577`.

## Owner Credentials Warning
- Fifth session: the owner supplied a Supabase **access token** (`sbp_...`, used via the `SUPABASE_ACCESS_TOKEN` env var for the CLI only) and the **admin email + password** (for one password-grant sign-in to run the live exam flow). Neither was written to any file, script, or command in the repository; the token files under `/tmp` were deleted after use. The owner should revoke the token (Dashboard → Access Tokens) when convenient — and ideally rotate the admin password too, since it transited chat.
- Fourth session: the owner sent the **v2** publishable key (`sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E` for `lbhnadqmokloyfarrzfv`, matching `config.js`) — public by design, used for read-only probes only.
- Earlier: a URL + key for `dtrgbjqfnkjiengpvbym` identified the **v1 project (`Exam_Data_Base`)** — do not touch v1 (DEC-001/DEC-015).
- Remaining owner-side steps (checklist in `docs/verification-checklist.md`): disable public sign-up (ISSUE-007, still enabled), live media upload check (TASK-007), `supabase db pull` for the old migrations (TASK-008 remainder).

## What Was Changed (fifth session, 2026-09-22 — live deploy + verification)
1. **Exam SQL applied live** → `supabase/migrations/20260922000000_exams_functions.sql` (new, first migration in git). Real schema facts were discovered and fixed in the SQL while applying: enum columns need explicit casts, `save_exam` generates the id (`coalesce(p_id, gen_random_uuid())`), `auto_filter` NOT NULL, `exam_questions.position` starts at 1 (`position > 0` CHECK), `duplicate_exam` mints a confusion-safe code (access_code CHECK rejected the md5 snippet), `list_exams` casts enums to text and needs `drop function` before a return-type change (file is idempotent).
2. **Deployed live**: `exams` (v1) and `question-bank` (v3 — import actions live, ISSUE-003 closed). Deploy path: `python backend/sync_functions.py` (new; mirrors `backend/functions` → `supabase/functions/`, now gitignored) then `npx supabase functions deploy <name> --no-verify-jwt --use-api` (server-side bundling, no Docker).
3. **Live exam flow verified with the admin account** (password grant → bearer token → POST `/functions/v1/exams`): save draft (2 questions, weights 2+1) → get (positions 1..n) → list (counts/points) → update via save-with-id → open → second exam with the open code refused ("already used by an open exam") → `check_code` false/true around close → `regenerate_code` → `duplicate` (draft, both questions, new code) → `remove`; refusals live: empty manual exam, end-before-start schedule; tokenless 401 "Please sign in."
4. **Parser fix + redeploy**: `draw_per_student` now defaults to false when absent (was a 400); 24 Deno tests still green. `import_check` verified live (answers `{"results":[]}` for a non-matching row — no more "Unknown action"), `list` regression-checked (total: 40).
5. **Cleanup**: all verification exams + their audit rows deleted — live state back to 0 exams, 40 questions, 0 `exam.*` audit rows.
6. `.ai/` + `docs/sql-exams.md` (rewritten as the verification record + schema facts) + `supabase/README.md` deploy instructions updated.

## What Was Changed (third session, 2026-09-22)
1. **Read-only live probes** of the v2 project using the publishable key (no login): `auth/v1/settings` (email sign-ups still enabled), tokenless REST read of `questions` (401 `permission denied`, Postgres 42501 — zero-policy lockdown holds), tokenless `question-bank` call (401 `"Please sign in."` — matches `_shared/errors.ts`), `storage/v1/bucket` anon list ("Bucket not found" — nothing leaks), CORS preflight from `http://localhost:8000` (`Access-Control-Allow-Origin: *`, `ALLOWED_ORIGIN` secret not set — expected pre-hosting).
2. **`docs/verification-checklist.md`** — owner-facing steps 1–5 (disable sign-up, deploy v3 with verify commands, media upload check, migrations export, optional hardening).
3. `.ai/` updated: ISSUE-002/003 annotated with live facts, ISSUE-007 rewritten (OPEN, still enabled), TASK-006 queue note, changelog, this file.

## What Was Changed (second session)
1. **Import screen** — new `frontend/assets/js/teacher/screens/questionImport.js`, route `#/questions/import` in `router.js`, "Import" button next to "Add question" in `screens/questionBank.js`. Flow: choose a `.xlsx`/`.csv` file or paste text → optional defaults (class labels, topic, difficulty, points) → review table (Ready / Fix / Duplicate in bank / Duplicate in file / Similar, per-row problems) → all-or-nothing `import` of the checked rows → back to `#/questions` with a toast. In-file duplicates are detected with `dupKey`; `import_check` runs once per review; a refused batch (HTTP 400 `Row N: ...`) keeps the review open and saves nothing; an unsaved review triggers the leave guard.
2. **API** — `api/questionBank.js` gained `importCheck(items)` (returns the results list) and `import(items)`.
3. **ISSUE-013 closed** — 5 new Deno unit tests for `zip.js`/`xlsx.js` in `frontend/tests/unit/import.test.ts`, run against `frontend/tests/unit/fixtures/import-sample.xlsx`, a real OOXML package built by the committed `frontend/tests/unit/make_xlsx_fixture.py`. Unit tests now need `deno test --allow-env --allow-read --no-check frontend/tests/unit/` (the `--allow-read` is for the fixture; `npm:linkedom` provides the DOM in Deno — dev-only, DEC-007 untouched).
4. **Mock server + browser tests** — `mock_server.py` implements `import_check` (EXACT/similar) and `import` (refuses bodies containing `FORCE_SERVER_ERROR` with `Row N:`); new `frontend/tests/question_import_e2e.py` (43 checks: paste flow, statuses, defaults, select-all semantics, payload shape, a real `.xlsx` upload through the file picker, refused batch, leave guard, example button).
5. **Templates** — `frontend/assets/templates/import-template.xlsx` and `import-template.csv` (generated by `make_import_template.py`, outputs committed, downloadable from the screen); `frontend/assets/templates/README.md`.
6. **Small** — `shared/icons.js`: two fixed icons (`sheet`, `pencil`); `questions.css`: import styles (new `.head-actions`, `.import-*` classes using existing tokens); `APP_BUILD` = "Phase 2, question import"; root and frontend `README.md` updated; `.ai/` updated (state, queue, features, changelog, issues, this file).

## Files Changed (repository, fifth session)
- New: `supabase/migrations/20260922000000_exams_functions.sql` (applied live), `backend/sync_functions.py`.
- Edited: `docs/sql-exams.md` (rewritten: verification record + schema facts), `supabase/README.md` (deploy instructions), `.gitignore` (`supabase/functions/`), `backend/functions/exams/parse.ts` (`draw_per_student` default), `.ai/` docs.

## Files Changed (repository, fourth session)
- New: `backend/functions/exams/{index,handler,parse}.ts`, `backend/tests/exams.test.ts`, `docs/sql-exams.md`, `frontend/assets/js/teacher/{api/exams.js,screens/exams.js,screens/examEditor.js}`, `frontend/tests/exams_e2e.py`.
- Edited: `frontend/tests/mock_server.py` (exams route), `frontend/tests/teacher_e2e.py` (nav assertion), `frontend/assets/js/teacher/router.js`, `frontend/assets/js/teacher/screens/shell.js` (Exams menu live), `frontend/assets/css/questions.css` (exam styles), `.ai/` docs.
- Second session: new `.github/workflows/frontend-tests.yml`, `frontend/tests/fixtures_dir.py`; edited `make_fixtures.py`, `media_e2e.py`, `question_editor_e2e.py` (flake fix), `.ai/` docs.
- First session (commit `4493577`): new `frontend/assets/js/teacher/screens/questionImport.js`, `frontend/tests/question_import_e2e.py`, `frontend/tests/unit/{make_xlsx_fixture.py,fixtures/import-sample.xlsx}`, `frontend/assets/templates/{make_import_template.py,import-template.xlsx,import-template.csv,README.md}`; edited router, bank screen/API, icons, config (APP_BUILD), questions.css, mock_server, unit tests, READMEs, `.ai/`.

## Database Changes
**Exam functions applied live on 2026-09-22** (fifth session) — recorded in git as `supabase/migrations/20260922000000_exams_functions.sql`. Zero data changes left behind (all verification rows deleted; 40 questions, 0 exams, 0 `exam.*` audit rows). Older migrations `v2_01`..`v2_12` are still only in the live project (ISSUE-001 partially fixed; `supabase db pull` brings the rest in).

## Current State (what works)
- Everything teacher-side now works against the **real backend**: sign-in, question bank, editor, import (`question-bank` v3 live), media (built; live upload still unverified), and **exams** (SQL + function live, whole flow verified with the admin account).
- Exams list `#/exams` and editor `#/exams/new`, `#/exams/edit/:id` — full create/edit flow (manual/auto question selection, schedule, live code uniqueness check, shuffle, tab limits, result rules, templates, duplicate). Tested 25 browser checks against the mock and live against the real backend.
- Verification levels (see `00_AI_RULES.md` section 7): exam flow = **LIVE-VERIFIED** (admin); import = live for the check call (a full import of real rows not yet run); `.xlsx` from a real Excel/Google Sheets = still NEEDS_VERIFICATION (ISSUE-013 caveat); media upload = still NEEDS_VERIFICATION (TASK-007).
- What does **not** exist yet: the student side (join by code, sessions, snapshots, grading hooks) — that is TASK-010 / F-11.

## Testing Performed (fourth session, 2026-09-22)
- Backend `deno test --allow-env backend/` → **65 passed** (41 + 24 new exams tests); unit 21 ✓.
- All six browser suites green: teacher, bank, editor, media, import, **exams (new, run twice)**.
- `teacher_e2e.py` nav assertion updated for the now-live Exams menu item (3 links + 2 "soon" pills).
- Second session (2026-09-22): full local CI-sequence simulation in order: teacher → bank → editor → media → import, all pass (backend 41 and unit 21 re-checked green).
- `media_e2e.py` → 29/29 after the ISSUE-014 fix (regenerated fixtures in the portable temp dir).
- Editor suite 3× consecutive passes after the flake fix (ISSUE-016).
- First session: backend 41, unit 21, all five suites green (see the changelog entry for details).

## Remaining Work
1. **TASK-009 live step**: run `docs/sql-exams.md` on the v2 project (SQL editor or `supabase db pull` afterwards), deploy the new `exams` function (`supabase functions deploy exams --project-ref lbhnadqmokloyfarrzfv --no-verify-jwt`), then live-verify: sign in → Exams → New exam → save draft → open → code shown; and a refused open of an empty exam. Until then the exam screens fail live with "rpc save_exam failed".
2. **TASK-006 step 4**: the owner has not reviewed the proposed import formats yet; the screen's help text, example button, and template files make them easy to review — collect feedback and adjust. Also worth one live end-to-end import of a small real file (rows actually inserted), and the real-Excel-file check (ISSUE-013 caveat).
3. Then: TASK-007 (media live verification), TASK-008 remainder (`supabase db pull` for `v2_01`..`v2_12`), **TASK-010 (student join + exam engine)** — see `05_TASK_QUEUE.md`.

## Known Problems
See `09_KNOWN_ISSUES.md`. Most important now: ISSUE-001 (older migrations still not in git), ISSUE-002 (media upload never run live), **ISSUE-007 (public email sign-up still enabled — one dashboard flip)**, ISSUE-013 (closed with a caveat).

## Recommended Next Task
**TASK-010 — student join + exam engine** (the teacher side it depends on is live-verified; the exam SQL, session tables, and `rate_limit_hit` all exist). Design first: sessions with per-session snapshot + server-side answer key (BR-09/BR-10), server-enforced time with 2-minute tolerance (BR-20), rate-limited joins (BR-21), 1-attempt rule. Smaller parallel items: owner format review for import (TASK-006 step 4), TASK-007 media check, ISSUE-010 (duplicate banner).

## Suggested Work For Next AI
1. `git checkout ai-development && git pull`. Read `.ai/00_AI_RULES.md`, this file, `05_TASK_QUEUE.md` TASK-006, then the relevant source.
2. Confirm your environment matches: backend **65** tests, unit 21 (with `--allow-read`), and the **six** Playwright suites green (teacher, bank, editor, media, import, exams).
3. To deploy or run SQL on v2 you need the owner's access token (`SUPABASE_ACCESS_TOKEN` env var, `npx supabase ...`). Deploy path: `python backend/sync_functions.py` then `npx supabase functions deploy <name> --no-verify-jwt --use-api`. Do not request the token again without need, and never store it in the repo.
4. Verify against live with the admin account only when the owner asks; clean up every test row afterwards (exams, sessions, audit entries) — the live DB is the real one.
5. Watch the first real CI run of `frontend-tests.yml` (Actions tab) after this push; the browser job is the one to watch (`playwright install --with-deps chromium` is the slow step).
5. The review-table select-all is tri-state by design (first click fills the gaps, second clears everything); the default selection leaves exact duplicates and in-file duplicates unchecked. Keep those semantics unless the owner asks otherwise.
6. After your work: test, update `.ai/` (state, queue, changelog, this file — including the branch/commit fields at the top), commit on `ai-development`, push.
7. When `ai-development` is eventually merged into `main` (owner's call): resolve the import files in favor of `ai-development` and drop `frontend/tests/import.test.js` + `frontend/assets/js/teacher/import/model.js` (Codex's superseded variant, DEC-021 / ISSUE-015).

## Do NOT Do
- Do not work directly on `main`; do not merge `ai-development` into `main` yourself (DEC-020).
- Do not force-push, reset `--hard`, or delete either branch.
- Do not rebuild the question editor, question bank, import parsers, media picker, sign in, the router, or the exam screens/API just built (F-02, F-04..F-09 are done or largely done; follow `docs/sql-exams.md` for the exam contract).
- Do not invent a different exam SQL contract than `supabase/migrations/20260922000000_exams_functions.sql` (the live SQL) and `docs/sql-exams.md` (the record) — the Edge Function handler and its tests match that exact function set and argument shape (`p`, `p_id`, `p_actor`, …). Remember the live-schema facts there: enum columns need casts, positions start at 1, `auto_filter` NOT NULL, code CHECK `^[A-Z0-9]{4,12}$`.
- Do not resurrect Codex's import variant from `main` or mix the two implementations (DEC-021, ISSUE-015).
- Do not add a second import/save path: parsing belongs in `frontend/assets/js/teacher/import/`, saving only through `question-bank` `import` → `import_questions` (DEC-004, DEC-014).
- Do not add frontend dependencies or a build step (DEC-007); the test-only `npm:linkedom` shim lives in the Deno unit tests, not in the browser code.
- Do not change the text normalization/hash rule in only one language (DEC-005).
- Do not add RLS policies or grants; do not query tables from the browser (DEC-002).
- Do not touch the v1 project (`Exam_Data_Base`) (DEC-015).
- Do not change the visual system (tokens, fonts, bubble motif) without the owner's approval (DEC-008).
- Do not push secrets (access tokens, passwords) — not into the repo, not into migration files, not into `.ai/`. The owner's token from the fifth session should be revoked; a new one can be minted when needed.
- Do not "fix" the `Admin` placeholder name or create accounts without the owner's request.
- Do not mark anything done without stating how it was verified — follow the TESTED / UNVERIFIED labels in this file and `03_FEATURES.md`.

## If Next AI Cannot Complete The Task
1. Stop rather than guessing.
2. Document the blocker.
3. Mark the task `BLOCKED` in `05_TASK_QUEUE.md`.
4. Update `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md` (including the branch/commit fields).
5. Continue with another `READY` task if appropriate (TASK-018 needs only the repository). Stay on `ai-development`.
