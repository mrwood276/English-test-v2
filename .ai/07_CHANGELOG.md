# 07 CHANGELOG

Newest first. Entries below the "Established" entry were reconstructed from git history and the live migration list only; nothing else is claimed.
Add a new entry for every meaningful change (what, files, database changes, verification).

## 2026-09-21 — AI memory and handoff system established
- Agent: Claude (Sonnet 5, claude.ai chat).
- Added `.ai/` (10 files), root `AGENTS.md` and `CLAUDE.md` (short pointers to `.ai/`), and a pointer paragraph in `README.md`.
- The repository was inspected first (code, tests, docs, workflow) and the live Supabase project was read (migrations, functions, tables, RLS, policies, storage, counts). `.ai/` reflects that state; uncertain items are marked UNKNOWN / NEEDS VERIFICATION.
- Included in the same delivery: the import backend work that was finished before this task (see next entry), committed separately.
- Database changes: none in this entry.
- Verification: backend tests 41 passed; all four Playwright suites passed (34, 57, 75, 29 checks); see `04_CURRENT_STATE.md`.

## 2026-09-21 — Import questions: backend half (TASK-006, IN_PROGRESS) — git `b9b5001`
- Database (applied to the live project, **not** in git): migration `v2_12_import_questions` → functions `find_similar_batch`, `import_questions`.
- Files: `backend/functions/question-bank/handler.ts` (actions `import_check`, `import`; request size limit 1 MB), `parse.ts` (`parseImportItems`, `parseImportCheckItems`), `backend/tests/question_bank.test.ts` (5 new tests).
- Not deployed: live `question-bank` is still version 2.
- Verification: SQL DO-block tests (8 groups, rolled back) passed; backend 41 tests passed.

## 2026-09-21 — Images and audio (TASK-005) — git `ad9b6d6`
- Database (live, not in git): migrations `v2_09_media_storage` (bucket `question-media`, `media_files` columns `original_name`, `duration_seconds`, functions `register_media`, `link_media`, `purge_orphan_media`, updated `save_question`, `save_passage`, `get_question`, `get_passage`), `v2_10_register_media_path_rule`, `v2_11_media_paths` (`get_media_paths`).
- Deployed: Edge Function `media` v1, `question-bank` v2 (accepts `media` lists).
- Frontend: `mediaPicker.js`, `imageCompress.js`, `api/media.js`, `questionView.js` media blocks, passage dialog files, styles; tests `media_e2e.py`, `media.test.ts`; `APP_BUILD` label updated.

## 2026-09-21 — Frontend repository commits — git `c974be7`, `1d50148`, `35d6561`
- `35d6561` project overview, design document, v1 audit, approved mockups.
- `1d50148` backend: shared library, `auth-me`, `question-bank`, `media` functions, unit tests.
- `c974be7` frontend: sign in, question bank, question editor, browser tests, dev server.
- (These commits were assembled at once from work done 2026-09-20/21; the finer history before them exists only in the chat.)

## 2026-09-20 — Foundation, question bank backend (live project, before the first commit)
- Migrations `v2_01_foundation` .. `v2_08_question_bank_functions` applied (schema, lockdown, content hash, text-rule fix, rate limit function, question bank functions).
- Edge Functions deployed: `auth-me` v1, `question-bank` v1 (later v2).
- 40 v1 questions migrated (fingerprint-verified against v1).
- Supabase project `English_Test_v2` created; admin account created by the owner in Supabase Auth; profile row inserted.
