# 02 ARCHITECTURE

Verified against the repository and the live Supabase project on 2026-09-21.

## Overview

```
Browser (teacher/admin app, static files)            Supabase project lbhnadqmokloyfarrzfv
  frontend/teacher/index.html                         ┌─────────────────────────────────────────────┐
  ES modules, hash router                             │ Auth (email+password)                        │
       │  Sign in: POST /auth/v1/token ─────────────► │                                              │
       │                                              │ Edge Functions (Deno)  verify_jwt = false    │
       │  POST /functions/v1/<name>  Bearer <token> ► │   auth-me, question-bank, media              │
       │                                              │   each: requireStaff → validate → callRpc    │
       │                                              │              │ service role (bypasses RLS)   │
       │  PUT one-time signed upload URL ───────────► │              ▼                               │
       │   (image/audio bytes go straight to Storage) │ Postgres: 22 tables (RLS on, no policies),   │
       │                                              │ 25 public functions (business rules, audit)  │
       ▼                                              │ Storage: private bucket question-media       │
  Students (NOT BUILT YET): name + class + exam code  └─────────────────────────────────────────────┘
```

Key property: **the browser never reads or writes a table directly.** Everything goes through Edge Functions that check who is calling and then call SQL functions.

## Directories

| Path | Purpose |
|---|---|
| `frontend/` | Teacher/admin web app (static). `teacher/index.html` is the only entry point |
| `frontend/assets/js/core/` | `config.js` (URLs, public key, build label), `http.js` (fetch with timeout and friendly errors), `auth.js` (Supabase Auth REST client, session in `sessionStorage`), `api.js` (`callStaffFunction`: adds the token; a 401 clears the session and fires `staff:session-expired`) |
| `frontend/assets/js/shared/` | `dom.js` (element builder, no innerHTML), `rich.js` (safe display of teacher-written rich text), `icons.js`, `ui.js` (toast, confirm dialog, segmented control, debounce), `imageCompress.js` (shrink photos in the browser) |
| `frontend/assets/js/teacher/` | `app.js` (boot, sign-in/out, session events), `router.js` (hash routes), `guard.js` (unsaved-changes guard), `api/` (`questionBank.js`, `media.js`), `components/`, `screens/` |
| `frontend/assets/css/` | `tokens.css` (design tokens), `base.css`, `teacher.css` (sign in, shell), `questions.css` (bank, editor, dialogs, files) |
| `frontend/tests/` | Playwright tests with a mocked server: `teacher_e2e.py`, `question_bank_e2e.py`, `question_editor_e2e.py`, `media_e2e.py`, plus `mock_server.py`, `make_fixtures.py` |
| `frontend/dev-server.py` | Local static server that disables caching (needed because ES modules are cached aggressively) |
| `backend/functions/_shared/` | Shared library: `errors.ts`, `http.ts`, `validate.ts`, `auth.ts`, `rpc.ts`, `db.ts`, `text.ts`, `audit.ts`, `codes.ts`, `ratelimit.ts` |
| `backend/functions/<name>/` | One Edge Function each: `auth-me`, `question-bank` (`handler.ts` routing, `parse.ts` input parsing), `media` |
| `backend/tests/` | Deno tests: `shared.test.ts`, `question_bank.test.ts`, `media.test.ts` |
| `supabase/` | Notes only (`README.md`). **No migrations yet** (ISSUE-001) |
| `docs/` | `design.md`, `audit-v1.md`, `mockups/` |
| `.ai/` | This memory/handoff system |

## Frontend architecture

- Routes (hash): `#/dashboard`, `#/questions`, `#/questions/new`, `#/questions/edit/<uuid>`. Unknown hashes fall back to the dashboard. A new route render increments `container.dataset.render`; slow async screens compare it to detect that they are stale.
- Screens: `login`, `shell` (menu + router host), `dashboard` (placeholder welcome/connection check), `questionBank` (list, filters, preview, archive/delete), `questionEditor` (add/edit).
- Components: `questionView` (student-style view used by list preview and editor preview), `richTextarea` (B/I/U buttons), `chipsInput` (class labels with suggestions), `passageDialog`, `mediaPicker` (upload queue).
- Session: `sessionStorage` key `ENGLISH_TEST_V2_STAFF_SESSION`. Tokens are refreshed shortly before expiry. Any screen can end a session; `app.js` listens for `staff:session-expired`.
- Unsaved work: screens call `setLeaveGuard(fn)`; the router asks before changing routes; `beforeunload` warns on tab close.
- Design: tokens in `tokens.css`; the "answer sheet" motif (A–D bubbles) is used for answer options and question numbers (DEC-008).

## Backend architecture

Every Edge Function: `Deno.serve(handle(handler))`.
- `handle` (`_shared/http.ts`): CORS (`ALLOWED_ORIGIN` secret, default `*`), JSON responses, request id, ApiError → `{error, code}` with its status, unexpected errors → logged + generic 500.
- `requireStaff(req, db, roles)` (`_shared/auth.ts`): verifies the bearer token with Supabase Auth, then loads the person's **role from `public.profiles`** (never from the token); inactive or missing profile → 403.
- Endpoints use one URL with `POST { action, ... }`.

| Function | Actions | Roles |
|---|---|---|
| `auth-me` | `GET` returns `{user:{id, fullName, role}}` | teacher, admin |
| `question-bank` | `list`, `get`, `save`, `remove`, `archive`, `restore`, `check_duplicates`, `topics`, `class_labels`, `passages`, `passage_get`, `passage_save`, `passage_remove`; **repository only, not deployed:** `import_check`, `import` | teacher, admin |
| `media` | `create_upload`, `register`, `signed_urls`, `purge_unused` (admin only) | teacher, admin |

## Database architecture (live project, verified)

22 tables in `public`, all with RLS enabled and **0 policies**; `anon`/`authenticated` have no table or function privileges (migration `v2_05_lockdown`).

| Group | Tables | Used by code today |
|---|---|---|
| Accounts/system | `profiles` (id = auth.users.id, role teacher/admin, is_active), `app_settings`, `rate_limits`, `audit_logs`, `backups` | `profiles`, `audit_logs` yes; `rate_limits` only via SQL function (no endpoint uses it yet); `app_settings`, `backups` not yet |
| Master data | `topics`, `class_aliases` | `topics` yes; `class_aliases` not yet |
| Question bank | `passages`, `questions`, `question_options`, `accepted_answers`, `question_class_labels`, `media_files`, `question_media` | yes |
| Exams | `exams`, `exam_questions`, `retake_permissions` | **no code yet** (Phase 2 exams / Phase 3) |
| Sessions/results | `exam_sessions`, `session_answers`, `answer_grades`, `exam_results`, `session_events` | **no code yet** (Phase 3+) |

Key constraints (all verified by SQL tests): one correct option per question; unique exam code among **open** exams; scheduled exams need valid dates; tab-switch limits ordered; unique `(exam_id, normalized name, normalized class, attempt_no)` for the 1-attempt rule; one result per session; result status consistent with pass status; media size cap; question media attached to exactly one of question or passage.

25 public SQL functions (all revoked from public roles; callable only by the service role):

| Purpose | Functions |
|---|---|
| Text/rules | `normalize_text`, `question_content_hash`, `set_updated_at` (trigger) |
| Rate limit | `rate_limit_hit`, `purge_rate_limits` |
| Audit | `write_audit` |
| Questions | `save_question`, `remove_question`, `set_question_archived`, `get_question`, `list_questions`, `find_similar_questions`, `upsert_topic`, `list_topics`, `list_class_labels` |
| Reading texts | `save_passage`, `get_passage`, `list_passages`, `remove_passage` |
| Media | `register_media`, `link_media`, `purge_orphan_media`, `get_media_paths` |
| Import | `find_similar_batch`, `import_questions` (applied to the live database; migration `v2_12`) |

Live migrations (names only; SQL not in git): `v2_01_foundation`, `v2_02_question_bank`, `v2_03_exams`, `v2_04_sessions_results`, `v2_05_lockdown`, `v2_06_question_content_hash`, `v2_07_text_rules_and_rate_limit`, `v2_08_question_bank_functions`, `v2_09_media_storage`, `v2_10_register_media_path_rule`, `v2_11_media_paths`, `v2_12_import_questions`.

Storage: bucket `question-media`, private, 10 MB limit, mime types image/jpeg, image/png, image/webp, audio/mpeg, audio/mp4, audio/x-m4a. No storage policies. Paths: `image/<year>/<uuid>.(jpg|png|webp)` and `audio/<year>/<uuid>.(mp3|m4a)`.

## Data flow examples

1. **Sign in:** browser → Supabase Auth `token?grant_type=password` (publishable key) → session in `sessionStorage` → `auth-me` (verifies role) → app shell.
2. **Save a question:** editor → `question-bank` `save` → `parseQuestionInput` (validate + `sanitizeInlineHtml`) → RPC `save_question` (one transaction: question, options/accepted answers, labels, media links, audit) → id.
3. **Upload a file:** `mediaPicker` shrinks images → `media` `create_upload` (signed upload URL) → browser PUT (multipart, `cacheControl` + empty-name file field, same as supabase-js `uploadToSignedUrl`) → `media` `register` (server reads real size/type from Storage, then RPC `register_media`; refused files are deleted from Storage) → the editor holds media ids → included in the next `save`.
4. **View a file:** `media` `signed_urls` (1 hour) → `<img>`/`<audio>` in previews.

## Environment and configuration

- Frontend: `frontend/assets/js/core/config.js` (project URL, publishable key, timeouts, session key, `APP_BUILD` label). No `.env`.
- Edge Functions: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically; optional secret `ALLOWED_ORIGIN` (not set; `*` is used until the app has an address).
- Auth settings (signup disabled, redirect URLs, leaked-password protection) live in the Supabase dashboard, not in git. UNKNOWN whether signups are disabled (the owner was asked to disable them; NEEDS VERIFICATION).

## External integrations

Supabase (Auth, Postgres, Edge Functions, Storage); Google Fonts stylesheet (Bricolage Grotesque, Source Serif 4). No other third-party services. No email provider yet (needed later for teacher email summaries, DEC-017).

## Dependency relationships

`teacher/app.js` → `router.js` → screens → `api/*.js` → `core/api.js` → `core/auth.js` + `core/http.js` → Edge Functions → SQL functions. `questionView.js` is shared by list preview and editor preview. `text.ts`/`normalize_text`/`question_content_hash` must stay identical (DEC-005). `parse.ts` output shape must match what `save_question` / `import_questions` accept.

## Protected Architecture Decisions

Do NOT change these casually (each has a decision entry in `06_DECISIONS.md`):

1. **RLS on, zero policies, no grants to anon/authenticated; all access through Edge Functions with the service role** (DEC-002).
2. **Staff auth = Supabase Auth + role from `profiles` checked in `requireStaff`; `verify_jwt=false` with in-code verification** (DEC-003).
3. **Business rules are SQL functions, one transaction per action, audit inside** (DEC-004). Edge Functions validate and call; they do not implement multi-step writes.
4. **Text normalization and content hash rules exist in JS and SQL and must match** (DEC-005).
5. **Only simple inline HTML (b, strong, i, em, u, br, sub, sup) in teacher text, sanitized on the server and again in the browser** (DEC-006).
6. **Frontend without framework/build step/dependencies; hash router; own Supabase Auth REST client** (DEC-007).
7. **Design system: "answer sheet" tokens and motif, approved via mockups** (DEC-008).
8. **Media: private bucket, signed upload/view links, server reads metadata, limits** (DEC-011).
9. **Questions used by exams are archived, not deleted; each session will store its own snapshot** (DEC-012).
10. **Separate Supabase project for v2; v1 is untouched** (DEC-001, DEC-015).
