# 06 DECISIONS

Only decisions that can be verified from the repository, `docs/design.md`, the live project, or that were made during the creation of `.ai/` are listed.
"Owner" = the project owner (the person the agents work for). Dates are approximate where the exact day is not recorded (the requirements interview ran over several days in September 2026).
"Active" means the decision is still in force. Do not reverse an active decision without recording a new decision that explains why.

## DEC-001 — Build v2 in a separate Supabase project; keep v1 running
- Date: 2026-09 (D-11, interview); project created 2026-09-20 (migration timestamps).
- Context: v1 is live for real classes; v2 changes almost everything.
- Reason: zero risk to v1; free plan allows two projects (cost checked: $0).
- Alternatives: same project with v2 tables next to v1 (risk to live exams); paid branching (~$0.013/hour).
- Consequences: two projects, two configurations; v2 becomes production later; v1 result data is archived at cutover (DEC-016).
- Affected: whole repository; `supabase/README.md`. Active: yes.

## DEC-002 — All data access through Edge Functions; RLS on with zero policies; no grants to anon/authenticated
- Date: 2026-09-20 (`v2_05_lockdown`); pattern inherited from v1.
- Reason: keeps answer keys and student data away from browsers even if the publishable key leaks.
- Consequences: no Supabase client in the browser for data; every feature needs an Edge Function endpoint + SQL functions.
- Affected: all tables, all functions, `frontend/assets/js/core/api.js`. Active: yes. PROTECTED.

## DEC-003 — Staff authentication with Supabase Auth; role read from `profiles`; `verify_jwt=false` with in-code verification
- Date: 2026-09-20 (D-07 approved split Teacher/Admin).
- Reason: replaces v1's shared plaintext password; role in the database can be changed/revoked without token reissue; works with the new publishable/secret key model.
- Consequences: every staff endpoint starts with `requireStaff`; disabling a profile (`is_active=false`) blocks access even with a valid token.
- Affected: `backend/functions/_shared/auth.ts`, all staff functions. Active: yes. PROTECTED.

## DEC-004 — Business rules as SQL functions (one transaction per action, audit inside); Edge Functions only validate, clean, and call
- Date: 2026-09-20.
- Reason: multi-step writes (question + answers + labels + files + audit) must be atomic; supabase-js has no cross-call transactions; rules become testable directly in SQL.
- Consequences: schema and rules live in the database; duplicated validation exists on purpose (friendly Edge messages + authoritative SQL checks).
- Affected: migrations `v2_08`, `v2_09`, `v2_12`; `backend/functions/*/handler.ts`, `parse.ts`. Active: yes. PROTECTED.

## DEC-005 — Shared text normalization and content-hash rules in JS and SQL
- Date: 2026-09-20 (`v2_07` fixed a trailing-space bug and made ordering locale independent).
- Decision: normalization = collapse whitespace, trim, lower-case. Content hash = SHA-256 of normalized body + "\n" + normalized options sorted by UTF-8 bytes (`collate "C"` in SQL). Names and classes are compared normalized (D-08, D-01).
- Reason: the browser/server must agree on "same student", "same class", "same question".
- Affected: `backend/functions/_shared/text.ts`, SQL `normalize_text`, `question_content_hash`, generated columns on `exam_sessions`, `question_class_labels`, `accepted_answers`. Verified: hashes from `text.ts` equal hashes stored in the database (test in `shared.test.ts`). Active: yes. PROTECTED: change both sides together.

## DEC-006 — Teacher text allows only simple inline HTML; sanitize on the server and again in the browser
- Date: 2026-09-20 (BR-22 approved with Draft 4).
- Allowed tags: b, strong, i, em, u, br, sub, sup, all attributes removed; script-like blocks removed with content; stray `<` escaped.
- Affected: `text.ts` `sanitizeInlineHtml` (fuzz-tested), `frontend/assets/js/shared/rich.js`, `parse.ts`. Active: yes. PROTECTED.

## DEC-007 — Frontend: plain ES modules, no framework, no build step, no runtime dependencies; hash router; own Supabase Auth REST client
- Date: 2026-09-20 (D-11 dev approach; audit finding M-7 about CDN dependence).
- Reason: matches v1's simplicity; works on school networks without CDN/tooling; small attack surface.
- Consequences: Tailwind/CDN libraries are not used; ES modules need a server (`dev-server.py`), and are cached aggressively by browsers (a stale cache caused a confusing bug on 2026-09-21).
- Affected: everything under `frontend/`. Active: yes. Any framework or bundler introduction requires a new decision.

## DEC-008 — Visual direction "answer sheet" (owner-approved through mockups)
- Date: 2026-09-20/21 (D-05, mockup rounds 1 and 2 approved).
- Decision: ballpoint-blue actions, highlighter-yellow marks, red-pen warnings, green correct; Bricolage Grotesque (UI) and Source Serif 4 (reading text and questions); A–D answer bubbles also used for question numbers.
- Affected: `frontend/assets/css/tokens.css`, `docs/design.md` 1.8, `docs/mockups/`. Active: yes. PROTECTED.

## DEC-009 — Classes and student names are typed freely, normalized, and mergeable; question class labels typed freely with suggestions
- Date: 2026-09 (D-01 answered twice: re-confirmed after the audit showed v1 used a fixed 3-class dropdown; D-03 "class" on questions = specific class).
- Consequences: no class master table; `class_aliases` lets the teacher merge variants ("XII TKJ A" vs "12 TKJ A") in results; the 1-attempt rule uses normalized name + class only (typos count as different students; accepted risk, D-08).
- Active: yes.

## DEC-010 — Exam code is mandatory for every exam
- Date: 2026-09 (D-02; resolved a conflict with the earlier "optional code" idea).
- Consequences: students find an exam only by code; code unique among open exams (DB constraint `exams_open_code_unique`); code format 4–12 chars A–Z/0–9; generator `_shared/codes.ts` avoids 0/O/1/I. Rate limiting of code attempts required (BR-17).
- Active: yes (not yet implemented in code beyond the schema).

## DEC-011 — Media design
- Date: 2026-09-21 (D-04, D-12).
- Decision: images and audio for questions and reading texts; private bucket; browser gets one-time signed upload URLs; server reads size/type from Storage and registers the file; viewing via 1-hour signed URLs; images shrunk in the browser to about 1 MB / 1600 px, WebP preferred; audio MP3/M4A up to 10 MB (owner chose the looser limit knowing egress cost); max 4 files per question or reading text; audio has no play limit.
- Affected: migrations `v2_09`..`v2_11`, `backend/functions/media/handler.ts`, `frontend/assets/js/teacher/components/mediaPicker.js`, `frontend/assets/js/shared/imageCompress.js`. Active: yes. **Live-verified 2026-09-25 (TASK-007, `frontend/tests/live_media_check.py` 32/32)** — the design held exactly as written: private bucket, one-time signed upload URL, server-read size/type, 1-hour viewing links, browser shrink to ~813 KB WebP. No change to this decision was needed.

## DEC-012 — Questions used by exams are archived, never hard-deleted; each exam session keeps its own snapshot
- Date: 2026-09-20 (BR-10; `remove_question`).
- Consequences: deleting a used question archives it; results never change when questions are edited later. Snapshot columns exist on `exam_sessions` (not yet used).
- Active: yes. PROTECTED.

## DEC-013 — Difficulty vocabulary: easy / medium / hots
- Date: 2026-09-21 (found during the v1 audit: v1 already used Easy/Medium/HOTS).
- Active: yes. Enum `difficulty_level`.

## DEC-014 — Import is all-or-nothing in one database transaction; reading texts are matched by normalized title
- Date: 2026-09-21 (made by Claude while implementing TASK-006; file formats are still PROPOSED and unreviewed by the owner).
- Reason: a half-imported batch is hard to clean; rows are pre-validated in the browser and re-validated by SQL; errors carry the row number.
- Alternatives: per-row import with partial success (rejected: harder to reason about duplicates and reading texts).
- Affected: migration `v2_12`, `parse.ts` (`parseImportItems`). Active: yes.

## DEC-015 — Do not patch the live v1 app
- Date: 2026-09 (D-15, after the audit).
- Consequences: v1's weaknesses (time not enforced by server, unlimited attempts, shared plaintext password, no rate limit) remain until cutover. Do not modify the v1 project.
- Active: yes.

## DEC-016 — v1 result data is archived (exported), not migrated into v2 structures; the 40 questions were migrated
- Date: 2026-09 (D-13). Active: yes. Implementation pending at cutover (TASK-019).

## DEC-017 — Notifications: teacher dashboard notices and email summaries
- Date: 2026-09 (D-06). Active: yes (not implemented). Email needs a provider; Supabase's built-in email service is rate-limited and meant for testing.

## DEC-018 — Operational: repository sync is manual while the chat agent cannot push
- Date: 2026-09-21. Claude in the chat delivers a zip with commits; the owner runs `git pull <folder> main` and pushes. Replace this decision when a GitHub connector or Claude Code workflow is available.
- Active: yes.

## DEC-019 — `.ai/` is contextual memory, not the source of truth
- Date: 2026-09-21. See `00_AI_RULES.md` section 0. Active: yes.

## DEC-020 — Two-branch Git workflow: `main` (stable) and `ai-development` (shared sequential AI branch)
- Date: 2026-09-21 (owner's request, implemented by Claude).
- Decision: `main` is the stable branch and is not used as the normal AI workspace. `ai-development` is where Claude and Codex/GPT do normal, everyday development. `ai-development` was created from `main` at commit `46803f0` (the commit that added `.ai/`). Only one AI actively modifies `ai-development` at a time — Claude and Codex/GPT are not expected to work on it simultaneously, they take turns sequentially (Claude → Codex/GPT → Claude → ...), each pulling the latest state, reading `08_HANDOFF.md`, doing a unit of work, testing, updating `.ai/`, committing, and pushing before the next agent starts.
- Reason: with two different AI systems (Claude and Codex/GPT) potentially touching the same repository at different times, working directly on `main` risks leaving it in a broken or half-finished state between hand-offs. A dedicated development branch lets work-in-progress accumulate safely while `main` keeps representing "the last version someone deliberately decided was stable."
- Why sequential, not concurrent: neither agent has a way to lock files or negotiate a merge with the other in real time within this workflow; a single shared branch worked on one-at-a-time (rather than each agent branching further and merging) keeps history linear and avoids merge conflicts between two AI agents that cannot coordinate directly.
- Why merging into `main` is deliberate rather than automatic: the owner (or whoever reviews the project) should be the one who decides a batch of AI work is ready to become "the stable version," not an agent mid-task. An agent finishing one task on `ai-development` does not imply the whole branch is stable — earlier work on the same branch might still be incomplete (as it is right now: TASK-006 is mid-flight).
- Alternatives considered: (a) one agent per feature branch, merged via pull request — more standard, but assumes both agents and a reviewer can manage PRs, which was not confirmed as available; (b) working directly on `main` with frequent small commits — rejected per the owner's explicit instruction and the risk above.
- Consequences: every task description in `05_TASK_QUEUE.md` and every entry in `08_HANDOFF.md` must state which branch the work is on. `00_AI_RULES.md` section 12 has the operational rules. The existing single-branch history (`35d6561` through `46803f0`) stays on `main` unchanged; only new work moves to `ai-development`.
- Affected: repository branch structure only; no application code, database, or UI changed because of this decision.
- Active: yes.

## DEC-021 — TASK-006's browser side continues on `ai-development` (Buffy's implementation); Codex's parallel `main` implementation is superseded at the next deliberate merge
- Date: 2026-09-22 (owner decision, made in the Freebuff conversation after the collision was found).
- Context: two independent implementations of the TASK-006 import screen came to exist. Codex/GPT-5 committed its version directly to `main` on 2026-09-21 19:40–19:57 +0800 (commits `d21f82d`, `1606aed`, `9c293fc`; parser layer restructured around a new `import/model.js`, `frontend/tests/import.test.js`, a minimal review screen) **before** the branch workflow existed and **before** Claude's separate step-1 parser commit (`6f5c223` on `ai-development`, 2026-09-21 23:11 UTC) landed; each handoff described a `main` that no longer matched. Buffy then built the full step-2 screen on top of `6f5c223` without knowing about the `main` commits. The file sets overlap (`import/*.js`, `screens/questionImport.js`, `router.js`, `api/questionBank.js`, `mock_server.py`, import tests) with incompatible contents — a merge will conflict by design.
- Decision: the owner chose to continue on `ai-development` with Buffy's implementation (fuller review flow: defaults panel, in-file duplicate detection, server duplicate check in the review, 21 unit tests including the zip/xlsx fixture, 43-check browser suite, template files) and to leave Codex's `main` commits untouched. When `ai-development` is one day merged into `main`, the import files resolve to the `ai-development` versions; Codex's variants are then dropped (their only unique idea worth keeping is the smaller `model.js` shape, recorded here for reference).
- Reason: avoids discarding the tested, specification-complete implementation; keeps `main`'s history untouched; the final "stable" definition stays the owner's deliberate merge decision (DEC-020).
- Affected: `frontend/assets/js/teacher/import/*`, `frontend/assets/js/teacher/screens/questionImport.js`, `frontend/assets/js/teacher/{router.js,api/questionBank.js}`, `frontend/tests/{import.test.js,unit/import.test.ts,question_import_e2e.py,mock_server.py}`, `frontend/assets/templates/*`. See ISSUE-015. Active: yes.

## DEC-022 — A student's session is a signed token (no accounts, no token column)
- Date: 2026-09-23 (made by Buffy while building the student exam engine, TASK-010).
- Context: students have no accounts (DEC-003 covers staff only). Something must prove to `get`, `save`, `submit`, `event`, `media` and `result` that the caller is the browser that joined a given session. The design's data model for `exam_sessions` has no token column, and the server must never trust a name/class sent back by the browser.
- Decision: `join` returns `<session id>.<signature>`, where the signature is `base64url(HMAC-SHA256(key, "session:" + session id))` and the key is the function secret `SESSION_TOKEN_SECRET` (falling back to `SUPABASE_SERVICE_ROLE_KEY`, which every function already has and which never reaches a browser). The Edge Function verifies it on every other action and passes only the session id to SQL. Verification (`backend/functions/session/token.ts`) compares all characters and rejects a missing/foreign signature.
- Reason: the session id is a UUIDv4 and unguessable, but this way a leaked id (a teacher screen URL later, a log line) is not enough to read or write another student's answers; nothing secret is stored at rest, no column was added to a PROTECTED table, and the browser holds one opaque string.
- Alternatives: (a) the raw session id as the only credential — simplest, but any leak of an id would be a full write capability; (b) a random token column on `exam_sessions` — same strength, but needs a schema change (a migration on a table owned by Phase 1) and stores another secret in the database; (c) a Supabase Auth anonymous sign-in per student — heavy, needs sign-ups enabled, and ISSUE-007 wants them off.
- Consequences: the token must be kept by the browser (`localStorage`, key `ENGLISH_TEST_V2_STUDENT_SESSION`) to survive a reload, and rotating `SESSION_TOKEN_SECRET` logs every running student out. The token carries no expiry of its own: the session's own `ends_at`/status is the authority.
- Affected: `backend/functions/session/{handler.ts,token.ts}`, `frontend/assets/js/student/{api.js,store.js}`. Active: yes.

## DEC-023 — A result is written in exactly one place, and a hand-made grade outranks an automatic one
- Date: 2026-09-24 (made by Buffy while building the teacher grading side, TASK-012).
- Context: TASK-010 wrote `exam_results` inside `_session_grade`, which the submit path called. TASK-012 introduces a second writer path (a teacher grading one answer, correcting another, or a re-grade after a `reopen` + second submit). Two writers of a row whose `status` and `pass_status` must stay consistent (the table has a CHECK tying them together) would drift apart; and a re-grade would silently overwrite a teacher's correction with the automatically computed points.
- Decision: `_session_result_write(session_id)` is the **only** function that inserts/updates `exam_results` — it recomputes points, percentage, right/wrong, `status`, `pass_status` and the review from the stored `answer_grades` plus the session snapshot, and both the submit path and every manual grade call it. `_session_grade` was re-created (replacing TASK-010's version) so that a question whose `answer_grades.is_auto` is false is **skipped** on re-grade: an automatic pass never touches a hand-made grade. A blank essay still counts as an answered question worth 0 points, so the result stays honest rather than silently final.
- Reason: one writer keeps `status`/`pass_status` coherent no matter which path runs, and BR-18 (the teacher's correction is final) is enforced in the database rather than in the UI.
- Alternatives: (a) let each action recompute and write the row itself (simplest to read, but three copies of the same arithmetic and a real drift risk); (b) keep the old `_session_grade` and skip hand-graded questions only in the UI (a `reopen` + resubmit would silently revert a correction — rejected); (c) add a `manually_graded` flag to `exam_results` instead of reading `answer_grades.is_auto` (a schema change with no extra benefit: the fact already lives on the grade row).
- Consequences: `_session_grade` is the only TASK-010 object changed by TASK-012; any future path that changes a grade must call `_session_result_write` rather than write the table. The stored `review_snapshot` is the source the statistics screens will read, so it must keep carrying the per-question detail.
- Affected: `supabase/migrations/20260924000000_result_functions.sql`, `docs/sql-results.md`, `backend/functions/results/*`, `frontend/assets/js/teacher/screens/{grading,gradingQuestion,sessionReport}.js`. Active: yes.

## DEC-024 — A monitor reads, never writes; and more time for a whole exam is one audited action
- Date: 2026-09-24 (decided by the eleventh session's owner-guided reconciliation, after two agents had built the monitor in parallel).
- Context: a teacher leaves the board open on a laptop while a class works, so it refreshes on its own (hub 30 s, per-exam board 15 s). That makes two temptations real: writing something onto a session while drawing the board (a status like `offline`), and letting the browser decide what a row means. A class that started late also needs "everyone still working gets five more minutes" without the teacher clicking through every student.
- Decision: the monitor's read is `list_exam_results` — `stable`, writes nothing, includes in-progress attempts. "Offline" and the one status label per row ("Saved" / "Left the page" / "Need a look" / Offline) are judgements made at read time, from the exam's own `tab_switch_warn_limit` / `tab_switch_flag_limit` (which the payload must therefore carry) and `last_heartbeat_at`. The browser only maps what it was given; it never computes a state. The single write the board offers is `add_exam_time(p_exam_id, p_seconds, p_actor)`: the exam-scope twin of BR-11, one transaction for every running attempt, one audit row, one `time_added` event per session (`meta.scope = 'exam'`), and `last_heartbeat_at` refreshed so the teacher's own action cannot flip the class to "offline". There is exactly **one** read path: `list_live_sessions` was dropped rather than kept beside `list_exam_results`.
- Reason: a board a teacher watches must be incapable of changing what a student is doing — a refresh, or a second teacher idly looking at it, must not touch a session. Computing "offline" at read time avoids a status that goes stale the moment the phone reconnects, and needs no schema change. One exam-wide action keeps BR-11 auditable in one row instead of N. One read path matters because a second one is how a payload and its screen drift apart — which is exactly what ISSUE-021 turned out to be.
- Alternatives: (a) write an `offline`/`left_page` status onto `exam_sessions` — a schema change on a PROTECTED table plus a judgement that stays on the row after the phone comes back (rejected); (b) let the browser compute the ladder from raw counters — it would then exist twice and drift from the report (rejected); (c) loop `add_session_time` from the Edge Function — the action would stop being one transaction and its audit trail would become N unrelated rows (rejected); (d) keep both read functions "just in case" — that is the drift the tenth and eleventh sessions collided over (rejected).
- Consequences: a new monitor state or pill must reach the screen through this payload, and the payload must carry every number the pill reads. `add_exam_time` refuses a 0-minute step, more than 2 hours, and an exam with nobody working, so a mis-click cannot write an audit row that says nothing happened. The students' phones need no change: they read `ends_at` from the server on each heartbeat (BR-20).
- Affected: `supabase/migrations/20260925000000_monitor_overview_fields.sql`, `supabase/migrations/20260927000000_exam_wide_add_time.sql`, `docs/sql-monitor.md`, `backend/functions/results/{handler.ts,parse.ts}`, `frontend/assets/js/teacher/{screens/examMonitor.js,screens/sessionTimeline.js,components/resultBits.js,api/results.js}`, `frontend/tests/{monitor_e2e.py,live_monitor_check.py,live_browser_check.py}`. Active: yes.

## DEC-025 — The exports are built in the browser, and both files come from one table
- Date: 2026-09-24 (made by Buffy while building the Excel export, TASK-012).
- Context: mockup 14 puts Excel, CSV and "PDF class summary" on the results screen, and the design document lists CSV/Excel/PDF under Phase 4. A teacher would rather open a spreadsheet than a web page, and the screen already holds every number. Two questions had to be answered: where the file is made (browser or Edge Function) and how two formats stay identical.
- Decision: the **browser** writes both files, with **no new dependency** — `frontend/assets/js/teacher/export/zip.js` (a ZIP writer whose entries are stored, CRC-32 computed in JavaScript) plus `xlsx.js` (`buildXlsx`) and one shared `resultsTable.js` that both exports are built from. Text cells become inline strings with every XML metacharacter escaped and control characters dropped; numbers stay numbers so Excel can sort and average them. The **PDF class summary is deliberately not built**: it needs the owner's decision on what a one-page summary should hold, and a dependency-free PDF writer is a much bigger lift.
- Reason: an export must not become a second read path for exam data (the lesson behind DEC-024) — it is the same `overview` payload the screen already shows, so a file can never disagree with the screen it was made from. A server-side writer would mean another deployed function and a second payload to keep in step with `list_exam_results`, for no gain on a file a browser can assemble; DEC-007 forbids new frontend dependencies, and Excel reads stored (uncompressed) zip entries perfectly well.
- Alternatives: (a) an Edge Function that streams the file (more moving parts, the same data read twice, and it must be kept in step with the screen — rejected); (b) a library such as SheetJS or jsPDF from a CDN (rejected: DEC-007, and the app is a plain static folder); (c) CSV only (rejected: the design document and mockup 14 both promise .xlsx, and numeric cells are the point of a spreadsheet); (d) build the PDF now (deferred to the owner's decision).
- Consequences: the writer is **proved by the repository's own reader** — the unit tests write a sheet and read it back with `teacher/import/xlsx.js`, and the browser suite opens the download with Python's `zipfile` and checks every CRC, an implementation independent of the one under test. Any future export (PDF, or questions to Word/Excel, TASK-021) must reuse `resultsTable.js`/the writer instead of adding a second path. Stored entries make the package slightly larger than Excel's own; for a class of forty that is a few kilobytes.
- Affected: `frontend/assets/js/teacher/export/{zip.js,xlsx.js,resultsTable.js}`, `frontend/assets/js/teacher/screens/examResults.js`, `frontend/tests/unit/export.test.ts`, `frontend/tests/results_e2e.py`. Active: yes.

## DEC-026 — The dashboard is a summary of existing payloads, not a second read path
- Date: 2026-09-24 (made by Codex while building TASK-014).
- Context: mockup 5 needs three kinds of data — open exams, things needing a teacher, and recent results. The Exams, Grading, Results and Monitor screens already have their payloads and their pills; a dashboard that queried its own tables or copied the status rules would drift from those screens exactly the way a duplicate monitor read path can (DEC-024).
- Decision: the dashboard reads only `exams.list({status:"open"})`, `results.activity()`, and `results.overview(examId)`. `list_exam_activity` was extended **additively** with `passed`/`failed` so the recent-exam meter comes from the same SQL row the Grading/Results hubs use; the Edge Function still passes the SQL JSON through unchanged. Live rows reuse `liveStatusPill`; the open card links to the real `#/monitor/:examId` instead of building a second monitor. `startRefresh` moved to `shared/ui.js` so the dashboard and monitor share one timer implementation.
- Reason: the dashboard must never disagree with the screen a teacher opens next, and a summary must not create a new authorization surface. Reusing the APIs also keeps the change small and avoids a redundant Edge Function action.
- Alternatives: (a) a dashboard-only SQL function returning everything in one call — another read path to keep in step with four screens (rejected); (b) copying status-label logic into dashboard.js — duplicate logic and a drift risk (rejected); (c) implementing the mockup's class-merge row now — no class-merge UI exists yet, so it would either be a dead button or a second BR-15 implementation (rejected; build it with the results flow first).
- Consequences: any new dashboard fact must come through these existing payloads (or be added additively to one of them), and a new live status must still be computed by the shared pill. The class-merge notice can be added later only after the real results merge UI exists.
- Affected: `supabase/migrations/20260928000000_dashboard_activity_fields.sql`, `frontend/assets/js/{shared/ui.js,teacher/screens/dashboard.js,teacher/screens/examMonitor.js,teacher/components/resultBits.js}`, `frontend/tests/{dashboard_e2e.py,mock_server.py,teacher_e2e.py}`. Active: yes.
