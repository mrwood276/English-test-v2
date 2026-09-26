# 01 PROJECT

## Identity

| Item | Value |
|---|---|
| Name | English Daily Test v2 (working title "English Testing Platform"; Claude project "APP_V2") |
| Repository | `mrwood276/English-test-v2` (GitHub, public) |
| Purpose | A web platform for English **daily tests** (ulangan harian) at one school, grades X, XI, XII, all majors |
| Development stage | **Phase 5 done; Phase 6 dashboard/UX polish done.** Foundation, auth, question bank, editor, media, import, exams (teacher side), the student exam engine, essay grading + results, the live monitor and the mockup-5 dashboard are built — the teacher, exam, import, student, grading and monitor flows are live against the v2 project (the monitor was watched in a real browser while a real exam ran, 2026-09-24). Not finished: the PDF class summary (the last piece of TASK-012), and notifications (TASK-015 — its audit viewer, its scheduled purge jobs, its **backup slice** — manual + nightly — and its **user management** — LIVE-VERIFIED 2026-09-26 — are done) |
| Deployment | v2 is **not deployed anywhere yet**; it runs locally against the live Supabase project. Hosting for the frontend is UNKNOWN (not chosen). The older v1 app is live on a separate static host + separate Supabase project and is **outside this repository** |

## Problem being solved

v1 (a single-exam prototype for class XII TKJ) had no exam codes, no attempt limits, no server-side time enforcement, a shared teacher password, and only multiple choice. The school needs a platform where one teacher (helped by an admin) can build a question bank of several question types, create exams for several classes, run them on students' own phones in the classroom, grade essays, and see results. Details: `docs/audit-v1.md` and `docs/design.md`.

## Target users and roles

| Role | Who | Access |
|---|---|---|
| Student | Students of grades X to XII | No account. Enters name + class (typed freely) + exam code. Takes the exam on a personal phone in the classroom. **Built (2026-09-23)**: `frontend/index.html` — join, take (autosave, offline tolerance, server-enforced time, tab-switch limits), submit, result; live-verified over HTTP, screens verified against the mock server |
| Teacher | One teacher for now | Email + password (Supabase Auth). Manages questions, exams, grading, results. An admin creates and manages the account on `#/accounts` (DEC-031); the live project's only teacher is the staff test account, and the owner's real teacher account is created whenever he types it in (TASK-016) |
| Admin | The owner (helps the teacher) | Email + password (Supabase Auth). Everything a teacher can do, plus accounts, backup, audit log, purge. Account **exists** (profile role `admin`); the placeholder name "Admin" can be replaced on `#/accounts`, since renaming yourself is deliberately allowed (DEC-031) |

Only teachers and admins may see student scores.

## Main goals

1. A flexible question bank: 4 question types (multiple choice, true/false, short answer, essay), reading texts, images and audio, class labels, topics, difficulty Easy/Medium/HOTS, duplicate detection, import from Excel/CSV and pasted text.
2. Exams with mandatory exam code, scheduling or manual open/close, manual or automatic question selection, 1 attempt per student (remedial by teacher permission).
3. A robust exam engine for phones (server-enforced time, autosave, offline tolerance, essay grading — the engine is built, essay grading is TASK-012).
4. Realistic anti-cheating (warnings, event log, live monitor) without harming honest students.
5. Results, statistics, exports (Excel/CSV/PDF), audit log, backups.

## Technology stack (verified in the repository)

| Layer | Technology |
|---|---|
| Frontend | Plain HTML + CSS + JavaScript ES modules. No framework, no bundler, no npm dependencies. Hash router. Fonts from Google Fonts (with system fallbacks) |
| Backend | Supabase Edge Functions (Deno, TypeScript). Only dependency: `npm:@supabase/supabase-js@2` (in `_shared/db.ts`) |
| Database | Supabase Postgres (v2 server version not checked; the v1 project runs 17) with extensions `pgcrypto` and `pg_trgm`; business rules as PL/pgSQL functions |
| Auth | Supabase Auth (email + password) for staff; students have no accounts |
| File storage | Supabase Storage, private bucket `question-media` |
| Tests | Deno tests (backend + frontend unit), Playwright + Python (frontend, mocked network), SQL DO-block tests run against the live database |
| CI | GitHub Actions: backend Deno tests (`.github/workflows/backend-tests.yml`) and frontend unit + browser tests (`.github/workflows/frontend-tests.yml`, since 2026-09-22) |

## Important constraints

- One school; one teacher for now; classes and student names are typed freely and normalized (DEC-009).
- Students use their own phones in class (mobile first, unreliable connection, notifications may look like "leaving the page").
- UI language is English only. The owner writes to agents in Indonesian.
- Supabase free plan (two free projects: v1 and v2). Egress quota about 5 GB uncached + 5 GB cached per month; audio up to 10 MB per file was chosen consciously (DEC-011).
- The service role key never leaves Edge Functions.
- Legacy v1 keeps running untouched until v2 is ready; the owner decided **not** to patch v1 (DEC-015).

## Where things are documented

| Need | File |
|---|---|
| Product requirements, business rules, data model, phases | `docs/design.md` (Draft 4, approved by the owner) |
| Exam SQL contract and live schema facts | `docs/sql-exams.md` |
| Student session-engine contract, live facts, verification record | `docs/sql-sessions.md` |
| Scheduled jobs (the database's own clock) | `docs/sql-jobs.md` |
| Backups (manual + nightly, and how to restore one by hand) | `docs/sql-backups.md` |
| User management (what an admin can do to an account, and why deactivate) | `docs/sql-accounts.md` |
| What was wrong with v1 | `docs/audit-v1.md` |
| Approved screens | `docs/mockups/round-1.html`, `docs/mockups/round-2.html` (open in a browser) |
| How to run and test | `README.md`, `frontend/README.md`, `backend/README.md`, `00_AI_RULES.md` section 7 |
