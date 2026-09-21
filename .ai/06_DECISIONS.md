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
- Affected: migrations `v2_09`..`v2_11`, `backend/functions/media/handler.ts`, `frontend/assets/js/teacher/components/mediaPicker.js`, `frontend/assets/js/shared/imageCompress.js`. Active: yes. Live verification pending (TASK-007).

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
