# English Daily Test v2

A test platform for English daily tests (ulangan harian) at one school, grades X to XII. Teachers and admins manage a question bank and exams; students take tests on their own phones in the classroom with a name, class, and exam code.

Status: **Phase 2 (core)**. Done so far: database schema, teacher/admin sign in, question bank (list, filters, preview), question editor (4 question types, duplicate warnings, reading texts), images and audio for questions and reading texts (shrunk in the browser, uploaded to private storage), and question import from Excel/CSV and pasted text with a review step before anything is saved. Next: deploying `question-bank` v3 (the import actions), exams.

## For AI agents

Read `.ai/00_AI_RULES.md` first (project memory, task queue, and handoff for Claude and Codex/GPT). `AGENTS.md` and `CLAUDE.md` point to it.

## Folders

| Folder | What is inside |
|---|---|
| `frontend/` | Teacher and admin web app. Plain HTML, CSS, and JavaScript modules, no build step. Has its own README and browser tests. |
| `backend/` | Supabase Edge Functions (Deno/TypeScript), the shared library, and unit tests. |
| `supabase/` | Notes about the Supabase project and how to deploy and pull migrations. |
| `docs/` | Design document (`design.md`), audit of the first version (`audit-v1.md`), and the approved mockups (`mockups/`). |

## Run the frontend

```
cd frontend
python dev-server.py
```

Open http://localhost:8000/teacher/ and sign in with the admin account. See `frontend/README.md`.

## Run the tests

```
deno test --allow-env backend/tests/                      # backend, also runs on every push (GitHub Actions)
deno test --allow-env --allow-read --no-check frontend/tests/unit/   # import parser unit tests
python frontend/tests/question_editor_e2e.py              # frontend, needs Playwright and dev-server.py 8123 (see frontend/README.md)
```

## Security notes

- Keep this repository **private**: it describes a school system, even though it holds no secrets.
- The publishable key in `frontend/assets/js/core/config.js` is meant to be public. The service role key must never be committed.
- Every table has row level security on with no policies; all data access goes through Edge Functions that check who is calling.
