# 10 ROADMAP (strict inspection, 2026-10-01)

This file is the output of an **inspection-only** session: it inspected the repository, did not change a
single line of product code, SQL, migration, Edge Function, CI file or test, and turned what it found
into tasks in `05_TASK_QUEUE.md`. Read this file with `05_TASK_QUEUE.md`'s OPEN TASKS section and
`08_HANDOFF.md`; then read the source of whatever you are about to touch (`00_AI_RULES.md` §1).

Evidence discipline used here (same as `00_AI_RULES.md` §7):

| Label | Meaning in this file |
|---|---|
| CODE-VERIFIED | Read in the source at the commit named at the end of this file; line-level evidence is quoted. |
| MEASURED | A number computed or grepped in this checkout (contrast ratios, counts). |
| TEST-VERIFIED | An existing automated test was read and does cover the claim. |
| RUNTIME-VERIFIED | Someone ran it against the live project (recorded elsewhere in `.ai`, **not** re-run in this session). |
| NOT-VERIFIED | Nobody has proved it; the finding says so explicitly. |

**What this session could not do:** no Supabase credential, so nothing live was re-read (RLS, advisors,
deployed function versions, the live ledger, `notification_reads`). No browser, no phone, no real Excel
file. Every claim below is therefore source- or measurement-backed, and any finding that still needs live
evidence says so in its own Status line.

## Coverage of the inspection

| Area | State | Notes |
|---|---|---|
| Backend (Edge Functions, `_shared/*`) | SOURCE-INSPECTED | All 10 functions' entry points + `_shared/{http,auth,errors,db,rpc,validate,ratelimit,codes,audit,text}.ts`; handlers for session, question-bank, exams, results, media, accounts, backups, notifications read in full. |
| Database (migrations, functions, RLS) | SOURCE-INSPECTED + MEASURED | 33 migrations read or grepped; 81 distinct `public.*` functions and 23 `create table` targets measured; RLS enabled in 5 migration files; the exams/session/result function families read in full. |
| Live project | NOT-VERIFIED (this session) | No credential. The last recorded live picture is `04_CURRENT_STATE.md` 2026-10-01 (415 checks, 12 PASSED / 1 HELD). |
| Frontend — student | SOURCE-INSPECTED + TEST-READ | `app.js`, `store.js`, `api.js`, `screens/{join,exam,result}.js`, `components/question.js` in full; `student_e2e.py` read. |
| Frontend — teacher/admin | SOURCE-INSPECTED | core (`api/auth/http/config`), `router.js`, `guard.js`, `app.js`, `accounts.js`, `questionEditor.js` (save path), screens list, CSS tokens. Not read line-by-line: `examEditor.js` (604 lines), `questionBank.js` (517), `results.js` export writers. |
| UI / UX | SOURCE-INSPECTED, VISUAL-VERIFICATION-REQUIRED | No browser was opened. Layout/tap-target/hierarchy claims are not made; everything reported is state, wording or code-path behaviour. |
| Security | SOURCE-INSPECTED | `requireStaff`, `verify_jwt=false` + in-code verification, `apiKey` usage, storage signing, bulk/ledger revokes, `ALLOWED_ORIGIN`, no service key in the tree. One live-only item (RLS of `notification_reads`) is recorded as verified by an earlier session only. |
| Performance | SOURCE-INSPECTED (reasoned) | No profiling. Only structural issues reported. |
| Testing | TEST-FILES READ, NOT RUN | Suites/harness/mock server read; this session ran no `deno test` and no browser suite (nothing changed, so nothing was re-verified). |
| Accessibility | SOURCE + MEASURED (contrast) | Contrast ratios computed from `tokens.css`; no axe/pa11y run; no keyboard test; no screen reader. |
| Mobile | SOURCE-INSPECTED | `student_e2e.py` runs at 390×844 and asserts no sideways scrolling; tap-target, keyboard and contrast on a phone remain VISUAL-VERIFICATION-REQUIRED. |
| Documentation / AI workflow | SOURCE-INSPECTED | Every `.ai/*.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/production-deployment.md`, the `docs/sql-*.md` titles, the two workflows. |

## Findings index

Priority: P0 none found. P1 = fix before a real exam day. P2 = next development cycle. P3 = useful, not urgent.

| ID | Area | Pri | One line | Task |
|---|---|---|---|---|
| INS-01 | Student correctness | P1 | The tab-limit auto-submit never flushes the answers still on the phone. | TASK-028 |
| INS-02 | Student reliability | P1 | One refused answer blocks every later autosave for that attempt, forever. | TASK-029 |
| INS-03 | Fairness / anti-cheating | P1 | A phone notification (`blur`) counts as a page leave and can auto-submit. | TASK-030 |
| INS-04 | Exam lifecycle / errors | P2 | Two drafts may share a code; opening the second answers a generic 500. | TASK-031 |
| INS-05 | Exam settings footgun | P2 | "Save as a template" is available on a live exam and locks its code out. | TASK-032 |
| INS-06 | Product / identity | P2 | Same name+class = one attempt; no way to see a score on a second phone. | TASK-033 (DECISION REQUIRED) |
| INS-07 | Accessibility (measured) | P2 | Green/red status text is below WCAG AA contrast (3.6–4.1:1). | TASK-034 |
| INS-08 | Accessibility | P2 | `aria-live="polite"` wraps the whole app on both pages. | TASK-034 |
| INS-09 | Accessibility | P2 | The student answer sheet is a `role="dialog"` with no focus/`aria-modal`/Escape. | TASK-034 |
| INS-10 | Test fidelity | P2 | The mock server's `save` contradicts the live contract (caps, `reopened`). | TASK-035 |
| INS-11 | Test coverage | P2 | No test drives the leave-limit auto-submit or a save after a reopen. | TASK-035 |
| INS-12 | Teacher UX | P2 | The question editor has no persistent saved/unsaved state. | TASK-036 |
| INS-13 | Documentation | P2 | `03_FEATURES.md` still says F-02/F-07/F-08/F-11/F-13/F-14 are unbuilt/undeployed. | TASK-037 |
| INS-14 | Documentation | P2 | `02_ARCHITECTURE.md` counts and inventory are stale (74/22 vs 81/23). | TASK-037 |
| INS-15 | Documentation / privacy | P2 | Repo is called "public" in `.ai/01` and "private" elsewhere; a real email is in 15 tracked files. | TASK-037 / owner |
| INS-16 | AI workflow | P2 | The actionable state is buried under session narratives in `04`/`05`/`08`. | TASK-038 |
| INS-17 | Security hardening | P2 | No CSP in `_headers`; `SESSION_TOKEN_SECRET` silently falls back to the service-role key. | TASK-039 |
| INS-18 | Security | P3 | Student tokens never expire. | TASK-040 |
| INS-19 | Product | P3 | No authoritative pre-flight readiness check for exam day. | TASK-041 |
| INS-20 | Product / mobile | P3 | The student page cannot start at all without a network (no offline shell). | TASK-042 |
| INS-21 | Quality gates | P3 | No accessibility automation, no lint/format/typecheck gate for product JS. | TASK-043 |
| INS-22 | Scale | P3 | The Questions tab sends one report request per finished attempt; the duplicate scan runs on every bank load. | TASK-044 |
| INS-23 | Product / data honesty | P3 | An attempt that expires with zero answers gets no result row at all. | TASK-045 (DECISION REQUIRED) |
| INS-24 | Maintainability | P3 | Duplicated code alphabet/generator and copy-pasted screen helpers. | TASK-046 |
| INS-25 | Verification habit | P3 | The live/SQL half of the board only runs when a human remembers. | TASK-047 |

NO SIGNIFICANT ISSUE FOUND in these areas, inspected and left alone: the RLS/zero-policy posture and the
"all access through Edge Functions" design; `requireStaff` (role always read from `profiles`, inactive
profiles refused); the signed student-session token design; server-enforced time with the 2-minute grace;
the one-writer rule for `exam_results` and the "a hand grade is never overwritten" rule; audit-inside-the-
transaction; media upload/verify/purge split; backup retention and the "refuse while copies exist" live
check; the browser-suite/live-check crash-reporting harnesses; `docs/production-deployment.md`.

## P1 findings

### INS-01 — the tab-limit auto-submit does not flush the answers still on the phone
- Category: student correctness / data loss. Priority: P1. Area: student exam screen. Status: CONFIRMED (code), not reproduced in a browser (no browser this session).
- Problem: when a page-leave event trips the exam's auto-submit limit, the phone goes straight to the result without first sending the answers that are still queued locally (`SAVE_DEBOUNCE_MS = 1200`). The time-up path does flush first; this path does not.
- Evidence: `frontend/assets/js/student/screens/exam.js` — `logEvent()` sets `submitted = true; stopTimers(); return goToResult("tab_switch_limit")` on `res.autosubmit`; compare `timeUp()` which does `await flush(); await submitTest("time_up")`. `mock_server.py:467` and `20260923000000_session_functions.sql#log_session_event` grade the session the moment the limit is reached.
- Current behaviour: the server grades without the last ≤1.2 s of typing; the client marks the answers `pending` forever and (because `save_session_answers` refuses a submitted session) they can never be saved.
- Expected: nothing a student typed before a server-side submission is dropped.
- Why it matters: an honest student can lose their last sentence, and the loss is invisible — the result screen looks normal.
- Recommended solution: make the leave path safe: `await flush()` before logging a leave event that may be the one that flips the limit (or send the pending answers with the event), and have `goToResult()` attempt one final flush while the session is still `in_progress`/`reopened`.
- Implementation guidance: only `exam.js` needs changing; keep the offline path intact (`flush()` already no-ops without a connection) so a leave event can never block the UI for long — bound the flush with the existing 15 s request timeout, and fall through to `goToResult` on failure.
- Acceptance criteria: with the leave limit reached, the answers typed in the last second are visible to the teacher's report; `submitted`/`StopTimers` ordering stays the same; the exam screen never hangs waiting for a save that cannot happen.
- Testing required: browser check in `student_e2e.py` — type into the last question, do not wait for the debounce, drive `tab_hidden` to the limit, assert the typed text reached the server (the mock server's session state) before the result screen appeared. Should fail on today's code.
- Dependencies: none. Related: INS-02 (a refused flush must not wedge the screen), INS-11.

### INS-02 — one refused answer blocks every later autosave for that attempt
- Category: student reliability / error recovery. Priority: P1. Area: student autosave + Edge validation. Status: CONFIRMED (code), NOT-VERIFIED in a browser.
- Problem: an autosave batch is one atomic call: the Edge parser allows 20,000 characters for **every** answer type, while `save_session_answers` refuses a non-essay answer over 1,000 characters and raises, rolling the whole batch back. The client marks nothing saved, keeps every answer `pending`, and re-sends the same batch after the next keystroke — so one oversized answer blocks all later answers and repeats the same error until a human shortens the text.
- Evidence: `backend/functions/session/parse.ts` (`MAX_ANSWER_CHARS = 20_000`); `20260923000000_session_functions.sql` (`char_length(v_text) > (case when v_type = 'essay' then 20000 else 1000 end)`); `exam.js` `flush()` catch branch sets a warning and returns without isolating or dropping the offending answer; `question.js` gives the short-answer input no `maxlength`. Same class: a batch larger than the session endpoint's 2 MB body limit (`readJson(req, 2_000_000)`) can never succeed (200 essay answers × 20,000 chars ≈ 4 MB).
- Current behaviour: permanent "That answer is too long." (or "That request is too large.") with no way forward except retyping; later answers are never saved.
- Expected: the bad answer is isolated and named; the rest keep saving; the limits agree everywhere.
- Why it matters: silent, unrecoverable answer loss on a phone, during an exam, with a message the student cannot act on.
- Recommended solution: (1) align the caps — the Edge parser caps non-essay at 1,000 like SQL, essay at 20,000; (2) make the client resilient: on a 400, retry the pending answers one at a time (or in small chunks), keep the offending one flagged locally with a visible message naming the question, and never send more than ~40 answers or ~200 KB per save.
- Implementation guidance: `session/parse.ts` takes a per-type limit (it already receives the answer shape, not the question type — pass the type check to the SQL side or cap all non-essay at the essay limit and let SQL stay the authority); `store.js`/`exam.js` gain a small `retryIndividually()` path. Do not change SQL semantics: the 1,000-character rule is deliberate.
- Acceptance criteria: a batch containing one too-long short answer saves every other answer; the student sees which answer is refused and can fix it; no repeated identical error loop; caps documented in `docs/sql-sessions.md`.
- Testing required: `session.test.ts` (parser cap per type), `student_e2e.py` (a too-long answer does not freeze the queue; the next answer still reaches the server), `mock_server.py` must mirror the caps (see INS-10).
- Dependencies: INS-10 for the browser test to mean anything.

### INS-03 — a phone notification counts as a page leave and can auto-submit the test
- Category: fairness / anti-cheating UX. Priority: P1 (a product decision was required before a real exam day). Area: student exam screen + exam settings. Status: **FIXED 2026-10-02 (DEC-039)** — the owner chose "only a hidden page counts"; `blur` is recorded but never counts. TASK-030 complete; migration `20261002000001_leave_count_only_tab_hidden.sql` applied live with its ledger row; proved red first (SQL case failed on the old function live; 3 new `student_e2e.py` checks failed on the old mock).
- Problem: both `visibilitychange` (counted) and `window.blur` (counted, throttled to one per 10 s) increment `tab_switch_count`, and the exam's default limits are warn 1 / flag 3 / auto-submit 5. Notifications, a call, the notification shade, tapping the browser's address bar or the on-screen keyboard's overflow can fire `blur` without the student ever leaving the page — and `00_AI_RULES.md`/ISSUE-019 already record that phones fire these events for notifications.
- Evidence: `exam.js` `onVisibility`/`onBlur` (`BLUR_THROTTLE_MS = 10_000`), `20260923000000_session_functions.sql#log_session_event` (`v_leave := p_event_type in ('tab_hidden','blur')`), `backend/functions/exams/parse.ts` defaults (1/3/5).
- Current behaviour: five blur-like events auto-submit the attempt, grade it as it stands, and tell the student "You left the test page too many times" — for a student who never left it.
- Expected: the automatic-submit rule should punish real page-leaving, and it must be the teacher's explicit choice.
- Why it matters: this is the single most likely way an honest student is graded early on exam day, and it is combined with INS-01 (the answers typed just before are also lost).
- Recommended solution (DECISION REQUIRED — pick one before the first real exam): (a) count only `tab_hidden` toward the limits and keep `blur` as an info-only event; (b) keep both but raise the defaults; (c) add an exam-level switch "count blur as a page leave" (default off) to the editor; (d) never auto-submit on leaves — record and flag for the teacher, who decides (safest, most work for the teacher).
- Implementation guidance: the SQL is the authority (`log_session_event`); option (a) or (c) needs a one-line SQL change plus a settings column/JSON key and the exam editor's copy. The monitor already shows the pill "Left the page", so the teacher keeps the information in every option.
- Acceptance criteria: an exam whose settings are untouched cannot auto-submit a student for a blur-only event (proved by a test that fires `blur` N times and asserts the session is still open); the chosen rule is visible in the exam editor and recorded in `06_DECISIONS.md`.
- Testing required: `session_functions_test.sql` (which event types count), `student_e2e.py` (N blurs do not submit; N real hides do), `mock_server.py` mirroring the same rule.
- Dependencies: an owner decision; INS-01 should land with or before it.

## P2 findings

### INS-04 — two drafts may share an exam code, and opening the second answers a generic 500
- Category: error handling / data correctness. Priority: P2. Area: exams SQL + `exams` Edge Function. Status: **FIXED 2026-10-02 (TASK-031, `b7ed106`)** — code and tests complete; the live apply waits on a Management credential (resolution bullet at the end of this finding).
- Problem: code uniqueness is enforced only against **open** exams at save time (`save_exam`) and by a partial unique index (`... where status = 'open'`). `set_exam_status` performs no code check, so opening the second draft hits the index, Supabase returns `23505` with no `hint = 'validation'`, and `callRpc` rethrows it as a hidden error → HTTP 500 "Something went wrong. Please try again." The teacher cannot tell what happened, and `check_code` told them the code was free.
- Evidence: `supabase/migrations/20260920095429_v2_03_exams.sql#L40`; `20260922000000_exams_functions.sql` (`save_exam` code check, `set_exam_status`); `backend/functions/_shared/rpc.ts`; `_shared/http.ts` (500 fallback).
- Current behaviour: a raw 500 at Open; a code can be prepared on two drafts and one of them is unusable until renamed.
- Expected: a friendly 400 naming the conflict, or a save-time rule that no two non-closed exams share a code.
- Why it matters: a teacher preparing several exams with the same code (copy/paste, or a code reused from the board) meets an unexplained failure at the worst moment — right before a class.
- Recommended solution: add the same "code already used by an open exam" check to `set_exam_status` and raise it with `hint = 'validation'` (a new numbered migration), and have the exams screen show the message next to the code field.
- Implementation guidance: one SQL migration (`create or replace function public.set_exam_status`), no table change; optionally also make `exam_code_available` warn about drafts ("used by a draft") so the editor can say so before Open.
- Acceptance criteria: opening a draft whose code is taken is refused with a sentence that names the code; the exam stays `draft`; no 500.
- Testing required: a rolled-back SQL test for the refusal, a backend test asserting 400 + message, an `exams_e2e.py` check on the Open button.
- Dependencies: none.
- **Resolution (2026-10-02, TASK-031, `b7ed106`)**: migration `20261002000002_open_exam_code_conflict.sql` replaces `set_exam_status` with the same open-code check `save_exam` applies, raised with `hint = 'validation'` (HTTP 400 naming the code; the exam stays a draft), and adds `public.exam_code_used_by` so `check_code` reports `'open'` / `'draft'` / null and the editor's code field says "Already used by another draft" before Open. Mirrored in `mock_server.py`; covered by the rolled-back `supabase/tests/exam_status_test.sql`, two new backend tests (the `used_by` answers and the 400) and 3 new `exams_e2e.py` checks — all of which failed on the pre-fix code first (87 checks after the fix). **Not yet applied live — no Management credential in the session that wrote it**; the apply with its ledger row, the SQL test and the `exams` Edge Function redeploy (its handler now calls `exam_code_used_by`, so the SQL must land first) are the next live run's first task. Contract: `docs/sql-exams.md` ("The open-code conflict").

### INS-05 — "Save as a template" is available on a live exam and locks its code out
- Category: settings footgun. Priority: P2. Area: exam editor + `exam_join`. Status: **FIXED 2026-10-02 (TASK-032)** — code and tests complete; the live apply waits on a Management credential (resolution bullet at the end of this finding).
- Problem: `is_template` is accepted for any exam status, but `exam_join` refuses a template outright ("That code belongs to a template, not a running test"), and templates are not listed for students anywhere. Marking an open exam as a template therefore turns a live exam into one nobody can join — the students get a refusal the teacher cannot see from their own screen.
- Evidence: `backend/functions/exams/parse.ts` (`is_template: asBool(b.is_template ?? false)`), `20260922000000_exams_functions.sql` (`save_exam` stores it; `exam_join` in `20260923000000_session_functions.sql` refuses it), `examEditor.js` ("Save as a template" checkbox beside the status controls).
- Current behaviour: one tick + Save silently disables the exam for students; the exam's own screen still says "Open".
- Expected: the checkbox is either hidden/disabled for an exam that is open or has attempts, or saved with a confirmation that says exactly what will happen.
- Recommended solution: refuse `is_template = true` for an exam whose status is `open` or that has attempts (needs a migration because the rule must hold for any caller), and disable the checkbox in the editor with the reason.
- Implementation guidance: `save_exam` is the right gate (one `create or replace function`); the editor's copy is English and short. Do not add a second settings path.
- Acceptance criteria: a template can only be made from a draft with no attempts; the editor explains why the checkbox is unavailable; an existing open exam stays joinable.
- Testing required: backend test (400 on the refusal, `exams_e2e.py` check that the checkbox is disabled and the tooltip/hint is shown.
- Dependencies: none.
- **Resolution (2026-10-02, TASK-032)**: migration `20261002000003_template_only_when_safe.sql` refuses `is_template = true` in `save_exam` unless the save is a draft, the exam is not open and it has no attempts (three validation-hinted sentences that say what to do instead: save it as a draft, close it first, or duplicate it), refuses opening a template in `set_exam_status` ("A template cannot be opened. Duplicate it and open the copy." — TASK-031's open-code check carried forward, so apply `20261002000002` first), adds `session_count` to `get_exam` so the editor can disable the checkbox with the reason, and repairs any exam that is open and marked a template (the flag is what made it unjoinable — clearing it makes the exam joinable again as it stands). The editor forces the flag off where it is locked and says why; `mock_server.py` mirrors both gates. **Proved red first:** 7 new `exams_e2e.py` checks failed on the pre-fix client+mock (94 after the fix, was 87); backend **171**, unit **44**, `dashboard_e2e.py` **37**, `question_bank_e2e.py` **151**. Covered by the rolled-back `supabase/tests/exam_template_test.sql` — **not yet run live: no Management credential**; the apply (after `20261002000002`) and both SQL tests are the next live run's first task. Contract: `docs/sql-exams.md` ("A live exam cannot become a template").

### INS-06 — one name+class is one attempt, and a second phone cannot show the score
- Category: product / identity. Priority: P2. Area: student join + results visibility. Status: CONFIRMED (code); DECISION REQUIRED.
- Problem: identity is the typed name + class, normalized (DEC-009). Two students with the same name in the same class collide: the second joins and is told "You already took this test", or worse resumes the first student's unfinished attempt (the server resumes on `name+class` alone, and the phone that holds the token is not checked). A student who finished cannot see their score on another phone: `join` refuses them, and `get`/`result` need the token that lives in `localStorage` on the phone that took the test.
- Evidence: `20260923000000_session_functions.sql#exam_join` (BR-01 lookup on `student_name_normalized`/`student_class_normalized`, resume on `in_progress`), `frontend/assets/js/student/app.js` (token from `localStorage`), `student/store.js`.
- Current behaviour: honest failure modes for duplicate names and lost/other phones; both look like the app is broken to a student.
- Expected: the owner decides how identity is proven (or explicitly accepts the risk) and how a score is retrieved.
- Why it matters: duplicate names in one class are common in Indonesian schools ("Ahmad Fauzi" twice), and "my phone died, can I see my score?" is the most likely support question on exam day.
- Recommended solution (DECISION REQUIRED — options to choose from): (a) add an optional "student number / absent number" typed by the student and used in the key with name+class (small change, big reduction in collisions); (b) keep the key but let the teacher see a "possible duplicate/typo" warning list on the monitor; (c) on the join screen, when the typed name+class already finished, offer "Show my result" behind the exam's own `result_visibility` (a product choice: anyone typing a friend's name could see their score); (d) do nothing and document it.
- Implementation guidance: (a) or (c) each touch `exam_join` + `parseJoin` + the join form + `docs/sql-sessions.md`; (c) needs the result path to be reachable by a join rather than only by a token, so treat it as a separate design item, not a quick toggle.
- Acceptance criteria: the chosen option is written in `06_DECISIONS.md` before code; the refusal message a student sees always says what to do next ("ask your teacher", "show your result").
- Testing required: SQL test for the chosen key/refusal; `student_e2e.py` for the student-visible flow.
- Dependencies: owner decision; do not implement (c) silently — it changes who can read a score.

### INS-07 — status colours are below WCAG AA contrast (measured)
- Category: accessibility (colour contrast). Priority: P2. Area: design tokens. Status: MEASURED in this checkout; visually unverified (no browser).
- Problem: the green/red pill and score text is 12.5–13px semibold on a tinted background, and the ratios are below the 4.5:1 AA threshold for normal text.
- Evidence (ratios computed from `frontend/assets/css/tokens.css`, WCAG 2 relative luminance): `--green #1e8e5a` on `--green-tint #e2f4ea` = **3.62**; `--red #d9364a` on `--red-tint #fce8eb` = **3.91**; `--green` on white = **4.14**. Used as text by `base.css` `.pill.ok` / `.pill.bad`, `student.css` `.score.pass` / `.score.fail`, `teacher.css` `.notif-pill-ok` / `.notif-pill-bad`, `questions.css` `.field-error`. (For reference, `--ink-2` on paper = 6.28 and `.pill.warn` `#6b5400` on `--mark-tint` = 6.63 pass.)
- Current behaviour: "Correct/Passed" and "Wrong/Not passed" — the two states a student most needs to read on a phone in a classroom — are the least legible text in the product; red-on-white warnings sit exactly at 4.59.
- Expected: ≥4.5:1 for this text, with the palette's meaning unchanged.
- Recommended solution: darken only the text values, measured: `--green: #146b45` (5.70 on the tint, 6.52 on white) and `--red: #b3202f` (5.65 on the tint, 6.64 on white). Keep the tints, keep `--mark`, keep the A–D motif; DEC-008's protected palette is preserved (the hues do not change, only the lightness).
- Implementation guidance: one file (`tokens.css`), then re-check that `--red` still reads as a warning on `--red-tint` for `.btn.danger` and that white text on `--green` (`.bubble.ok`) is ≥3:1 (it improves to ~5 at the proposed value).
- Acceptance criteria: every pairing used for text is ≥4.5:1 and every icon/border pairing ≥3:1; a note in `tokens.css` says so.
- Testing required: a small ratio table in the repo (a comment is enough) plus one manual check on a phone; an automated axe run is INS-21.
- Dependencies: none (documentation of the change belongs in `07_CHANGELOG.md`, not a new decision).

### INS-08 — `aria-live="polite"` wraps the entire app
- Category: accessibility (live regions). Priority: P2. Area: both `index.html` files. Status: CONFIRMED (code).
- Problem: `<div id="app" aria-live="polite">` is the mount point of every screen, so every render is an update inside one live region: the monitor's 15 s/30 s polls, the dashboard's 30 s polls, the exam screen's question swaps and toast-free status changes can all be announced as one large region, and screen-reader users cannot tell what actually changed.
- Evidence: `frontend/index.html`, `frontend/teacher/index.html`; `shared/ui.js` already has a proper `role="status"` toast region and screens already use `role="status"` / `role="alert"` for their own messages.
- Current behaviour: unpredictable, verbose announcements; the useful status lines compete with the whole screen.
- Expected: live regions are small, purposeful and per-message.
- Recommended solution: drop `aria-live` from `#app`; keep/rely on the existing `role="status"`/`role="alert"` elements (toasts, `.saved`, table status lines) and add `aria-live="polite"` only to the few values that must announce themselves (timer warning, save state, auto-refresh counts).
- Implementation guidance: two HTML files + a handful of `h()` calls; no CSS change. Verify the exam screen still announces "Saving…/All answers saved" through `.saved` (give that element `role="status"`).
- Acceptance criteria: no live region contains more than one message-level element; keyboard and screen-reader smoke test on the student flow.
- Testing required: manual screen reader pass (NVDA/TalkBack) — cannot be automated meaningfully; record it as VISUAL-VERIFICATION-REQUIRED in the changelog.
- Dependencies: none.

### INS-09 — the student answer sheet is a fake dialog
- Category: accessibility (dialogs, keyboard). Priority: P2. Area: student exam screen. Status: CONFIRMED (code).
- Problem: the answer sheet is built as `h("div", { class: "sheet", role: "dialog", "aria-label": "Answer sheet" })` and appended to `document.body` next to a `.dim` backdrop. There is no `aria-modal`, no focus move, no focus trap, no Escape handling, and the page behind stays reachable — a keyboard or screen-reader user can tab into the exam behind the sheet and cannot close it with Escape. The project's own `confirmDialog` uses a native `<dialog>` with `showModal()` (focus trap, Escape, backdrop) — the better pattern already exists in the codebase.
- Evidence: `exam.js` `openSheet`/`closeSheet`; `shared/ui.js` `confirmDialog`.
- Current behaviour: sheet usable by touch/mouse only; keyboard users can lose the sheet or reach hidden controls; the `aria-label` is not tied to the visible heading.
- Expected: the sheet behaves like the other dialogs in the app (native `<dialog>`, focus inside, Escape closes, focus returns to the trigger).
- Recommended solution: rebuild `openSheet` on `<dialog class="dialog sheet" aria-labelledby="sheet-title">` + `showModal()` (the CSS positions it, so the layout can stay), and keep the "Back to question"/"Submit test" buttons as they are.
- Implementation guidance: one screen, ~20 lines; ensure `paintSheet()` still works and that the grid keeps its focus order (A–Z by question number).
- Acceptance criteria: Tab never leaves the sheet while it is open; Escape closes it and returns focus to the answer-sheet button; the student can reach any question number with the keyboard.
- Testing required: `student_e2e.py` — open the sheet, press Escape, assert it closed and focus is on the trigger; tab once and assert the focused element is inside the sheet.
- Dependencies: none.

### INS-10 — the mock server's `save` contradicts the live contract
- Category: test fidelity / false confidence. Priority: P2. Area: `frontend/tests/mock_server.py`. Status: CONFIRMED (code).
- Problem: the mock accepts any answer text with no length limit and refuses every save when the session is not `in_progress`, while the live `save_session_answers` accepts a **reopened** session and caps non-essay answers at 1,000 characters. Both differences are invisible to the whole browser suite, and the first one hides INS-02 completely.
- Evidence: `mock_server.py` `save` branch (`if s["status"] != "in_progress": return accepted: false …`; no length check) vs `20260923000000_session_functions.sql#save_session_answers` (`return ... already_submitted` only for `submitted|auto_submitted|timed_out`; the 1,000/20,000 cap). `student_e2e.py` never exercises a save after `reopen_session`.
- Current behaviour: browser tests pass on a server that is more permissive than the real one, including on the reopened path the teacher's BR-11 action depends on.
- Expected: the mock mirrors the contract, or the differences are listed and deliberate.
- Recommended solution: mirror the two rules in `mock_server.py` (accept saves while `reopened`; enforce the caps and refuse the batch) and add a short comment block at its top listing what the mock deliberately simplifies (e.g. no trigram similarity, no rate limits of its own). Then add the two missing checks (INS-11).
- Implementation guidance: mirror the SQL error text for the too-long case ("That answer is too long.") so the browser check can assert the wording the student really sees.
- Acceptance criteria: a browser suite that saves after a reopen passes; a too-long short answer reproduces the live refusal.
- Testing required: `student_e2e.py` (both), `results_e2e.py` (reopen then save), `mock_server.py` self-consistency.
- Dependencies: do this before/with INS-02 and INS-11, otherwise both are unprovable in CI.

### INS-11 — the leave-limit auto-submit and the reopened-save path have no test
- Category: test coverage (student flows). Priority: P2. Area: `frontend/tests/student_e2e.py`. Status: CONFIRMED by reading the suite.
- Problem: `student_e2e.py` records **one** `tab_hidden` event and asserts it reached the server; nothing drives the count to `tab_switch_autosubmit_limit`, so INS-01 and INS-03 are both untested. Saving into a reopened session (BR-11: the teacher reopens a collected attempt, the student continues) has no browser test either, and the mock would have refused it anyway (INS-10). The time-up path is covered (`student_e2e.py` offline + time behaviors), which makes the gap look smaller than it is.
- Evidence: grep of `frontend/tests/` — `autosubmit` appears only in `mock_server.py` and exam fixtures; `reopen` appears in `results_e2e.py` (teacher side) but never as a subsequent student save.
- Current behaviour: the two riskiest student-facing behaviours are proved only by reading the code.
- Expected: both paths have a check that fails when the behaviour regresses.
- Recommended solution: add to `student_e2e.py`: (1) type without waiting for the debounce, fire leave events to the limit, assert the typed answer was saved **before** the result screen; (2) fire blur-only events to the limit and assert the session is still open (after the INS-03 decision); (3) a reopened session accepts a new answer and the report shows it.
- Implementation guidance: the harness already supports multi-context runs and the mock exposes its session state; keep each new check independent so a failure names the path.
- Acceptance criteria: three new checks, each proved to fail on the pre-fix code (state which commit the proof used).
- Testing required: this **is** the testing work; also re-run `student_e2e.py` in CI (it already runs there).
- Dependencies: INS-10 (mock fidelity) and the INS-03 decision.

### INS-12 — the question editor shows no saved/unsaved state
- Category: teacher UX / confidence. Priority: P2. Area: `frontend/assets/js/teacher/screens/questionEditor.js`. Status: CONFIRMED (code).
- Problem: the exam editor keeps a visible `saveStatus` ("Saving…" / "Saved.") beside its Save button; the question editor has only a transient toast followed by a navigation back to the bank, and its unsaved state is visible **only** through the leave guard when the teacher tries to navigate away. A teacher editing a long question (or one whose save failed) has no persistent signal of what state the form is in.
- Evidence: `examEditor.js` (`saveStatus.textContent = "Saving…" / "Saved."`), `questionEditor.js` `save()` (toast + `location.hash = "#/questions"`, `baseline`/`isDirty` used only for the guard), `guard.js`.
- Current behaviour: after a save the screen closes (fine); while editing, nothing tells the teacher the question has uncommitted changes, and a failed save is a banner they may have scrolled past.
- Expected: the editor's header always says one of Saved / Unsaved changes / Saving… / Save failed, like the exam editor.
- Recommended solution: reuse the exam editor's pattern — a small status line next to the Save buttons driven by the existing `isDirty()` and the save promise; keep the toast and the summary banner as they are (they explain *what* failed).
- Implementation guidance: `isDirty()`/`baseline`/`snapshot()` already exist in the file; only the DOM text and a `markDirty()` hook are missing. Do not add autosave — the leave guard is deliberate.
- Acceptance criteria: the three states are visible without scrolling on desktop and phone widths; the wording matches the exam editor's; the guard still fires only when there are real changes.
- Testing required: `question_editor_e2e.py` — after typing, the status is "Unsaved changes"; after Save (with the navigation suppressed) it is "Saved." / the toast path stays as is.
- Dependencies: none.

### INS-13 — `03_FEATURES.md` still declares built features unbuilt
- Category: documentation (AI workflow risk). Priority: P2. Area: `.ai/03_FEATURES.md`. Status: **FIXED 2026-10-02 (TASK-037)** — measured at the inspection (grep against the code/migrations).
- Problem: several "State / Limitations / Not built" lines are older than the paragraphs above them, and `00_AI_RULES.md` §3 tells an agent never to rebuild a feature it believes is complete. Wrong "not built" lines therefore cause duplicated work or a wrong premise:
  - **F-01**: "Files: **none in git** (ISSUE-001)" — 33 migrations are in git since 2026-09-24.
  - **F-02**: "Accounts are created by the owner in the Supabase dashboard … There is no user-management UI" — `#/accounts` has been live since 2026-09-26 (DEC-031).
  - **F-07**: "Limitations: the editor cannot reorder files" — reordering landed with F-18 (2026-09-28).
  - **F-08**: "the feature is not usable until `question-bank` is redeployed … the live `question-bank` function is version 2 and does not have the import actions" — v3 has been live since 2026-09-22 and was redeployed again on 2026-09-28.
  - **F-11**: "Not built: the live monitor (TASK-013) and the statistics tabs/exports (TASK-012 remainder)" — both exist.
  - **F-13**: "Not yet seen rendering against a real running exam in a browser" (20/20 on 2026-09-24) and "`monitor_e2e.py` (23 checks)" (34 today).
  - **F-14**: "Not started (rest of TASK-015): notifications" — the bell is the one notification system (DEC-037) and is live-verified.
- Evidence: the file itself (each line quoted above is present verbatim) vs `supabase/migrations/`, `backend/functions/question-bank/`, `router.js`, `frontend/tests/monitor_e2e.py`.
- Current behaviour: a next agent reading only the feature registry can start rebuilding `#/accounts`, the import screen, the monitor or the notification bell.
- Expected: one current status per feature; history stays in `07_CHANGELOG.md`.
- Recommended solution: when a feature's paragraph is superseded, move the old paragraph under a `### History` sub-heading and keep one authoritative Status/Limitations block per feature. Add a `Last reconciled: <date>` line per feature so the next reader knows how fresh it is.
- Implementation guidance: documentation-only; the source of truth order in `00_AI_RULES.md` §0 stays unchanged.
- Acceptance criteria: no "not built/not deployed/no UI" claim in `03_FEATURES.md` contradicts the code; every feature has a reconciliation date.
- Testing required: none (grep the claims against the code is the check).
- Dependencies: none.

### INS-14 — `02_ARCHITECTURE.md` counts and inventory are stale
- Category: documentation. Priority: P2. Area: `.ai/02_ARCHITECTURE.md`. Status: **FIXED 2026-10-02 (TASK-037)** — measured at the inspection.
- Problem: the file says "74 public SQL functions" and "22 tables"; the repository now defines **81** distinct `public.*` functions (`grep -rhoiE "create (or replace )?function +public\.[a-z_]+" | sort -u | wc -l` = 81, matching the live count recorded on 2026-09-30) and **23** `create table` targets (`notification_reads` is the newest). Its function table has no row for `notifications` (`list_notifications`, `mark_notifications_read`, `_essay_notifications`, `_suspicious_notifications`, `_actor_profile`) and its migration list stops before the newest files. The overview diagram also still shows the deployed-function set without `notifications`.
- Evidence: `02_ARCHITECTURE.md` ("22 tables in `public`", "74 public SQL functions", the migration list), `supabase/migrations/` (`20261001000000_notification_functions.sql`, `20261002000000_notification_reads_rls.sql`), measured counts above.
- Current behaviour: an agent trusting the architecture file under-counts the API surface and may miss the notification endpoint entirely.
- Expected: the file describes today's system, with counts that are recomputable.
- Recommended solution: correct the two counts, add the `notifications` function row (admin+teacher bell; `list`/`mark_read`), list the newest migrations, and put the measurement commands next to the numbers so the next reader can re-derive them.
- Implementation guidance: documentation-only. Do not renumber the protected-architecture list at the bottom.
- Acceptance criteria: counts and inventory re-derivable from the repository in one command; no missing Edge Function.
- Testing required: none.
- Dependencies: none.

### INS-15 — the repository's visibility is described two ways, and a real email address is in 15 tracked files
- Category: documentation / privacy. Priority: P2 (owner decision + one small cleanup). Area: `.ai/01_PROJECT.md`, `.ai/00_AI_RULES.md`, `README.md`, tests and docs. Status: **FIXED 2026-10-02 (TASK-037, DEC-040)** — the owner confirmed the repository is public and the address was stripped; the text below is the inspection's finding, kept for the record.
- Problem: `.ai/01_PROJECT.md` says the repository is "GitHub, public", while `00_AI_RULES.md` says "(private)" and `README.md` says "Keep this repository **private**". If it is public, the tree exposes the school's data model, staff display names and the **real staff test account's email address** (and its use as a login in the live checks). It also exposes the Supabase project ref and the publishable key (public by design, DEC-002 — not the issue here).
- Evidence: measured at the inspection — the address appeared 22 times across 15 tracked files: `.ai/{04,05,07,08}`, `docs/{sql-accounts,sql-duplicates,verification-checklist}.md`, `frontend/tests/live_{accounts,backup,bulk,duplicates,exam_bulk,housekeeping,media,notifications}_check.py` (and one untracked `__pycache__` file, which `.gitignore` covers).
- Current behaviour: whichever line is wrong is misleading; if the repo is public, an email tied to a live account is published.
- Expected: one truthful statement, and no personal data in the tree regardless of visibility.
- Recommended solution: (1) owner confirms the real visibility and `.ai/01`/`README.md`/`00_AI_RULES.md` are reconciled to it; (2) move the test account's address into an environment variable the live checks read (`SUPABASE_TEST_EMAIL`, which the checks already support) and replace the literal with `<staff test account>` in `.ai/` and `docs/`; (3) if the repository is public, rotate that account's password and consider renaming the Auth user (its address is also in the Auth dashboard, which is the durable place to fix it).
- Implementation guidance: the live checks' docstrings also print the address in failure messages; keep the behavior, drop the literal. Do not remove the tests' ability to sign in — `SUPABASE_TEST_EMAIL`/`SUPABASE_TEST_PASSWORD` and the one-time-link path already cover it.
- Acceptance criteria: `grep -r` for the address returns nothing in the working tree; the live checks still run with `SUPABASE_TEST_EMAIL` set; `.ai/01` and `README.md` agree on visibility.
- Testing required: one live-check run with the env var set (owner's credential).
- Dependencies: the owner's answer on visibility.

### INS-16 — the actionable state is buried under session narratives
- Category: AI workflow / maintainability of the memory system. Priority: P2. Area: `.ai/04_CURRENT_STATE.md`, `05_TASK_QUEUE.md`, `08_HANDOFF.md`, `07_CHANGELOG.md`. Status: **FIXED 2026-10-02 (TASK-038)** — the measurements below are the inspection's (pre-fix) ones.
- Problem: the three files a next agent is told to read first have grown into chronological logs. `05_TASK_QUEUE.md`'s "NEXT RECOMMENDED TASK" section is a stack of ~9 session narratives (the newest ones thousands of words each), and its message is "no code task is open"; `04_CURRENT_STATE.md`'s "Last updated" cell is a single ~30 KB paragraph; `08_HANDOFF.md` opens with ~10 KB of narrative before the reader learns what to do. Measured: 04 = 320 lines, 05 = 247, 08 = 403, 07 = 599 — with the newest session's story duplicated in all four.
- Evidence: the files; `grep -c` counts; `.ai/` total 5,824 lines for a project of 8,614 frontend + ~2,900 backend lines.
- Current behaviour: an agent must read ~40 KB to discover that there is nothing to do — and a human skimming it cannot see the current state at all.
- Expected: current state and open tasks are readable in under a minute; history lives in `07_CHANGELOG.md` (which already keeps it).
- Recommended solution: keep a short header block in each of 04/05/08 — Status (what is true now), Open tasks (ids only, pointing into the task list), Next recommended task (one paragraph), Branch/commit, and "what is deliberately not verified" — and move the session narratives into `07_CHANGELOG.md` entries (they already are) with a one-line pointer. This file (`10_ROADMAP.md`) is the model: index first, detail below.
- Implementation guidance: documentation-only. Preserve the facts (dates, counts, commits) — do not delete history, move it.
- Acceptance criteria: the first screen of 04/05/08 answers "what is this project, what is open, what do I do next"; no session narrative is lost (grep for its commit hash still finds it in `07_CHANGELOG.md`).
- Testing required: none.
- Dependencies: none — but do this **before** adding more sessions' worth of text to those files.

## P3 findings

### INS-17 — no Content-Security-Policy, and the student-token secret falls back to the service-role key
- Category: security hardening. Priority: P3 (a hardening step, not a hole: the app already escapes by construction). Area: `frontend/_headers`, `backend/functions/session/token.ts`, `docs/production-deployment.md`. Status: CONFIRMED (code).
- Problem (a): `frontend/_headers` sends `Cache-Control: no-cache`, `nosniff`, `Referrer-Policy` and `X-Frame-Options`, but no CSP. The app's injection surface is small (`dom.js` builds elements, the only `innerHTML` is `icons.js` from a fixed map, teacher text is sanitized twice), so a CSP is defence in depth rather than a fix.
- Problem (b): `sessionTokenSecret()` uses `SESSION_TOKEN_SECRET` **or** `SUPABASE_SERVICE_ROLE_KEY`. The deployment guide makes setting the secret before exam day a user step; if it is skipped, one key both opens the database and signs student tokens with no visible symptom, and the two concerns cannot be rotated independently.
- Evidence: `frontend/_headers`; `token.ts` `sessionTokenSecret()`; `docs/production-deployment.md` step 3 ("BLOCKED - USER ACTION REQUIRED").
- Recommended solution: (a) add a CSP that fits the app as written — `default-src 'self'; connect-src https://<project>.supabase.co; img-src 'self' data: blob: https://<project>.supabase.co; media-src https://<project>.supabase.co; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` — and test it on the hosted address (the inline `style=` attributes are the reason `'unsafe-inline'` is needed for styles; removing them is a separate cleanup, not a prerequisite). (b) either fail loudly when `SESSION_TOKEN_SECRET` is unset — a boot-time check that refuses `join` with a clear operator-facing message — or keep the fallback but have `/teacher/`'s dashboard or the live ledger check state it; the owner should pick (this is a small DECISION REQUIRED because failing loudly can lock a class out if the secret is missing at the wrong moment).
- Implementation guidance: `_headers` is read by Cloudflare Pages/Netlify only; the CSP must be verified there, not locally (`dev-server.py` does not read it).
- Acceptance criteria: the hosted app loads and works with the CSP in place (fonts, images, audio and the Supabase calls all pass); a decision on the secret fallback is recorded.
- Testing required: one manual pass on the hosted address (the guide's step 6 walkthrough is the natural place).
- Dependencies: hosting (step 1).

### INS-18 — student session tokens never expire
- Category: security / shared phones. Priority: P3. Area: `backend/functions/session/token.ts` + `get_exam_session`. Status: CONFIRMED (code).
- Problem: the token is `HMAC(secret, "session:" + id)` with no timestamp, so a token stays valid forever: `get` keeps returning the full question snapshot after the exam ended, and `result` keeps answering. On a shared phone, or a phone left with the page in `localStorage`, the attempt (and the questions of the exam) remain reachable.
- Evidence: `token.ts` (`signSessionToken`/`verifySessionToken`, no expiry claim); `get_exam_session` returns the snapshot with no time or status guard; `app.js` boots from `localStorage`.
- Recommended solution: add an `exp` (e.g. the session's `ends_at` + grace, refreshed on each accepted call) to the signed payload, and refuse `get`/`save`/`event`/`media` after it; keep `result` readable while the exam's `result_visibility` allows it (that is a product choice, see INS-06c). Alternatively, keep the token stateless and have `get_exam_session` refuse to return the snapshot once the session is finished and the exam is closed.
- Acceptance criteria: a token from a finished, closed exam can still display the student's own result (if that is the chosen behaviour) but cannot fetch the question snapshot.
- Testing required: `session.test.ts` (expiry math), `session_functions_test.sql` (the SQL-side guard), `student_e2e.py` (result still works after submit).
- Dependencies: coordinate with INS-06 (the result-retrieval decision) so the two do not pull in opposite directions.

### INS-19 — no authoritative pre-flight check before opening an exam
- Category: product (exam-day safety). Priority: P3 (cheap, high value on the first real exam day). Area: exam editor / exams screen. Status: CONFIRMED (the editor's readiness summary is drawn from local state).
- Problem: `set_exam_status` only refuses an empty **manual** exam; nothing tells the teacher, before Open, that e.g. 3 of the 20 questions are archived, that a question was deleted from the bank since the draft was saved, that the exam contains 12 essays (≈34 students × 12 answers to grade), that the total points are not 100, or that another open exam already holds the code. The editor shows a "ready to open" summary computed from the in-page draft, which can differ from what is saved.
- Evidence: `20260922000000_exams_functions.sql#set_exam_status` (only the empty-manual check); `examEditor.js` readiness summary from local state; `bulk_exam_questions` refuses archived questions when adding, but `save_exam` does not re-check questions that were archived after they were chosen.
- Recommended solution: one read-only SQL function (e.g. `exam_readiness(p_exam_id)`) returning counts and warnings (questions, total points, per type, archived/missing ids, essays vs students, code conflict), shown in the editor before Open and on the exams list as a small pill; make it the basis for a refusal only where the rule already exists (no questions, code conflict).
- Acceptance criteria: Open shows the same numbers the dashboard/results will produce; archived/missing questions are named; no new write path.
- Testing required: rolled-back SQL test for the function; `exams_e2e.py` for the panel; `live_ledger_check.py` will pick the new function up automatically once applied.
- Dependencies: INS-04 (code conflict) shares the query.

### INS-20 — the student page cannot start without a network
- Category: product / mobile reliability. Priority: P3. Area: `frontend/index.html` + a service worker. Status: CONFIRMED (no service worker, no manifest).
- Problem: the exam screen survives a disconnect after it has loaded (answers queue locally, BR-12), but a phone that is offline **before** loading the page — a dead spot in the school, a wrong Wi-Fi, a reload — gets nothing at all: the static files themselves need the network. The project's own constraint is "students' own phones, unreliable connection".
- Evidence: no `sw.js`, no `<link rel="manifest">` in `frontend/index.html`; `student/app.js` mounts from `localStorage` only after the modules load.
- Recommended solution: add a tiny service worker (cache-first for `assets/**` and the two HTML files, network-first for the API) registered from the student page only. It must be cache-busted on deploy (the file names carry no content hash — `_headers` already says so), so version the cache name with `APP_BUILD`.
- Acceptance criteria: with the page previously loaded, an offline reload still shows the exam (and the offline banner); a deploy invalidates the old cache; nothing is cached from `*.supabase.co`.
- Testing required: a Playwright check in `student_e2e.py` (load once, go offline, reload, assert the app mounts) — service workers work in Playwright with `serviceWorkers: 'allow'`.
- Dependencies: decide with the owner (it is new product surface, and DEC-007's "no build step" must stay true — a hand-written `sw.js` keeps that).

### INS-21 — no accessibility automation, no lint/format/typecheck gate for product JS
- Category: quality gates. Priority: P3. Area: `.github/workflows/*`, `frontend/tests/`. Status: CONFIRMED (workflows read).
- Problem: CI runs Deno tests (backend; frontend unit with `--no-check`) and fourteen Playwright suites. Nothing checks accessibility (INS-07/08/09 are invisible to it), nothing lints or type-checks `frontend/assets/js/**` (the product code is the part with no build step), and there is no `deno fmt --check`.
- Evidence: `.github/workflows/backend-tests.yml` (one `deno test` step), `.github/workflows/frontend-tests.yml` (unit with `--no-check`, then the suites). One upside: `deno lint`/`deno fmt`/`deno check` are dev-only tools already present in the Deno the workflow installs, so no runtime dependency is added (DEC-007 untouched).
- Recommended solution: (a) add `deno lint frontend/assets/js backend/functions` + `deno fmt --check` as a job (fix the findings first, or start with a small ignore list and an explicit plan); (b) add one axe-core run inside an existing suite — the suites already install Python deps, so a tiny Node/Playwright-with-axe step (`npm i -D axe-core` inside the workflow only, or the `axe-core` CDN script injected by the test) is acceptable as a **test-only** dependency (record it in `06_DECISIONS.md` since `00_AI_RULES.md` §6 forbids new dependencies without a decision).
- Acceptance criteria: a lint/format failure fails CI; an axe run reports no serious/critical violations on the join, exam, result and dashboard screens (or lists them in a known-issues file).
- Testing required: the workflows themselves; prove the a11y check fails on a seeded violation (e.g. remove a label).
- Dependencies: none, but do it after INS-07–09 so the baseline is honest.

### INS-22 — one report request per finished attempt, and a whole-bank scan on every bank load
- Category: performance / scale. Priority: P3 (fine at today's 40 questions and one class; the first thing to hurt as the school grows). Area: `frontend/assets/js/teacher/screens/examResults.js`, SQL `find_duplicate_groups`. Status: REASONED from the code (no profiling).
- Problem (a): the Questions statistics tab reads **one `results` report per finished attempt** from the browser (documented in `03_FEATURES.md` F-12), so a 5-class exam is ~170 requests.
- Problem (b): `questionBank.js` runs the duplicate scan on every visit; `find_duplicate_groups` is a trigram self-join over the non-archived bank with a 0.55 threshold.
- Evidence: F-12's text; `questionBank.js` (`duplicate_groups` action on load); `20260925060607_v2_17_duplicate_overview.sql`.
- Recommended solution: (a) a single SQL function returning per-question accuracy for an exam (the data is already in `review_snapshot`/`answer_grades`), so the tab makes one request; (b) keep the scan but make it opt-in ("Scan for duplicates" button) once the bank passes a few hundred questions, or cache its result per bank revision — decide with evidence (the ledger's `pg_trgm` index check).
- Acceptance criteria: the Questions tab makes one request; the bank screen's load does not depend on the scan.
- Testing required: SQL test for the aggregate; `question_bank_e2e.py` / `results_e2e.py` updated counts (the suites assert request shapes in places).
- Dependencies: none; do not start before there is a real need (see `00_AI_RULES.md` §6, and the project has 40 questions today).

### INS-23 — an attempt that expires with zero answers has no result at all
- Category: product / data honesty. Priority: P3 (DECISION REQUIRED). Area: `expire_sessions` + results screens. Status: CONFIRMED (code).
- Problem: `expire_sessions()` grades a timed-out attempt only if it has at least one answer; an attempt with none is marked `timed_out` **without an `exam_results` row**. Consequences: the student's result screen answers `visibility: 'none'` / "Your answers were sent" even when the exam shows scores, and the teacher's table shows the row with `has_result: false` — a student who joined and closed their phone becomes a blank line in the class results, and no 0 is recorded.
- Evidence: `20260923000000_session_functions.sql#expire_sessions` (`if exists (select 1 from session_answers …) then grade else status = 'timed_out'`), `_session_public_result` (no row → `visibility: 'none'`), `list_exam_results` (`has_result`, left join).
- Recommended solution (DECISION REQUIRED): choose one — (a) write a 0-point result for every timed-out attempt (the class statistics then include the student, which is what a teacher usually wants); (b) keep the hole but make it visible in words ("Did not answer", counted separately in the summary and excluded from the average) and make the student's screen say it plainly; (c) both, with (b)'s wording on top of (a)'s row.
- Acceptance criteria: a class of 34 where 1 student answered nothing shows one of: a 0 row, or an explicit "no answers" row that the average excludes and the summary counts. No blank line.
- Testing required: rolled-back SQL test for the chosen behaviour; `results_e2e.py` for the wording; `student_e2e.py` for the student's screen.
- Dependencies: owner decision.

### INS-24 — duplicated code alphabet/generator and copy-pasted screen helpers
- Category: maintainability. Priority: P3. Area: `frontend/assets/js/teacher/screens/examEditor.js`, `backend/functions/exams/handler.ts`, several screens. Status: CONFIRMED (code).
- Problem (a): the exam-code alphabet and generator exist twice — `backend/functions/_shared/codes.ts` (`CODE_ALPHABET`, `generateAccessCode`) and `examEditor.js` lines 15–21 (the same constant and the same `bytes[b & 31]` loop), and `regenerate_exam_code` in SQL repeats the alphabet a third time. Drift would not break anything (the CHECK accepts `[A-Z0-9]{4,12}`) but the "hard to mix up" guarantee and the three copies can diverge silently.
- Problem (b): `exams/handler.ts` exports `suggestCode()`, which nothing can call: an Edge Function exposes only its `Deno.serve` handler. Dead code with a comment that implies a client can call it.
- Problem (c): the `errorText` / `ignorable(SessionExpiredError)` pair and a small `dialog()` implementation are copy-pasted into accounts, backups, banks, exams and monitor screens; `confirmDialog` already exists in `shared/ui.js`.
- Recommended solution: (a) leave the SQL copy (it is a live function) but delete the frontend copy in favour of asking the server — or, cheapest and safest, add a comment in `_shared/codes.ts` naming the other two copies as "keep in sync" (the same discipline DEC-005 already imposes on text rules); (b) delete the unused export or document why it exists; (c) hoist `errorText`/`ignorable` into `shared/ui.js` the next time a screen is touched (no big-bang refactor).
- Acceptance criteria: no dead export; the three code-alphabet copies are named in one place; at least the two helpers are shared.
- Testing required: none for (a)/(b) beyond the existing suites; (c) is covered by the existing browser suites.
- Dependencies: none. Do **not** turn this into a refactor of the screens' structure — that is out of scope (00_AI_RULES.md §6).

### INS-25 — the live/SQL half of the board only runs when a human remembers
- Category: verification habit. Priority: P3. Area: `frontend/tests/run_live_checks.py`, the SQL tests, CI. Status: CONFIRMED (workflows read).
- Problem: the strongest evidence in this project (the thirteen live checks, the rolled-back SQL tests, the ledger check, the advisors) is produced by hand with a Management token. CI proves the pure logic and the mocked UI only, and a push that breaks the live contract (e.g. a renamed function, a wrong privilege) would be caught only the next time someone runs the board.
- Evidence: `.github/workflows/*` (no `SUPABASE_*` secrets, no live step); `docs/production-deployment.md` appendix ("a fresh database must be built by hand"); `05_TASK_QUEUE.md` (the board is a manual cadence).
- Recommended solution: one **nightly** GitHub Actions job (or a manual `workflow_dispatch` job) that runs `deno test`, the read-only pair `run_live_checks.py --read-only`, and the SQL tests, using repository secrets the owner adds (`SUPABASE_ACCESS_TOKEN`, and the test-account credentials for the rest). Write-only checks should stay manual (they mutate the live project).
- Acceptance criteria: a nightly run exists and is read-only by construction; a failing run is visible in the Actions tab; the secrets are documented in `docs/production-deployment.md` step 4 ("rotate the credentials that have travelled through chats" belongs there too).
- Testing required: one manual dispatch proving the job fails when the token is wrong (exit 2 path already exists).
- Dependencies: the owner's approval to store a Management token as a repository secret — treat as DECISION REQUIRED.

## Roadmap (implementation order)

The order below follows **risk to a real exam day first, then accuracy of the project's own memory, then
quality gates, then product value**. Each step names its task ids; the task text lives in
`05_TASK_QUEUE.md` (OPEN TASKS) and every finding's evidence is above.

```
PHASE A — SAFE TO RUN A REAL EXAM (do these before the owner's first class)
  TASK-028  the tab-limit auto-submit flushes first            (INS-01, P1)
  TASK-029  one bad answer cannot block the autosave queue      (INS-02, P1)
  TASK-030  the leave-count rule decision + implementation      (INS-03, P1 + DECISION)
  TASK-035  mock-server fidelity, so both can be proved        (INS-10/11, P2)

PHASE B — CORRECT THE PROJECT'S OWN MEMORY (cheap, unblocks everything after it)
  TASK-037  reconcile 02/03 + the visibility/email item         (INS-13/14/15, P2)
  TASK-038  short, actionable headers in 04/05/08               (INS-16, P2)

PHASE C — TRUST AND ACCESSIBILITY (a teacher and a student should not be surprised)
  TASK-031  a duplicate open code is refused kindly             (INS-04, P2)   ← DONE 2026-10-02, live apply waits on a credential
  TASK-032  a live exam cannot be turned into a template        (INS-05, P2)   ← DONE 2026-10-02, live apply waits on a credential
  TASK-036  the editor says Saved / Unsaved / Saving… / Failed  (INS-12, P2)
  TASK-034  contrast, live regions, a real dialog               (INS-07/08/09, P2)
  TASK-039  CSP + the token-secret decision                     (INS-17, P3 + DECISION)

PHASE D — QUALITY GATES AND PRODUCT DECISIONS
  TASK-040  student tokens expire                               (INS-18, P3)
  TASK-043  lint/format gate + one axe run in CI                (INS-21, P3)
  TASK-045  zero-answer attempts, decided and implemented       (INS-23, P3 + DECISION)
  TASK-033  identity: duplicate names and a second phone        (INS-06, P2 + DECISION)

PHASE E — PRODUCT VALUE (only after A–D, and only if the owner wants them)
  TASK-041  pre-flight readiness before Open                     (INS-19, P3)
  TASK-042  an offline-capable student shell                    (INS-20, P3)
  TASK-044  one-request statistics + duplicate-scan scale       (INS-22, P3)
  TASK-046  small cleanups (dead export, shared helpers)         (INS-24, P3)

PHASE F — OPTIONAL CONTINUOUS VERIFICATION (needs the owner's secret)
  TASK-047  a nightly read-only live job                        (INS-25, P3 + DECISION)
```

**Progress (2026-10-01, later the same day — implementation session):** PHASE A is two-thirds done.
**TASK-035** (`27e51ec`), **TASK-028** (`555fdf0`) and **TASK-029** (`d80be83`) are complete and pushed,
each with a check that was proved to fail on the pre-fix code first (2 checks red on the old mock, 1 on the
old exam screen, 8 on the old client). Backend **168**, unit **44**, `student_e2e.py` **85** checks, all
three harness self-tests green; nothing live was run (no credential). **TASK-030 remains BLOCKED on D-1** —
that is the one PHASE A item left, and it is a product decision. Detail: `05_TASK_QUEUE.md` (the three
tasks' status lines), `07_CHANGELOG.md` (2026-10-01, later the same day), `08_HANDOFF.md` (top block).

**Progress (2026-10-02 — implementation session with the owner's Supabase credential): PHASE A is
complete.** The owner answered D-1 (option a) and it is recorded as **DEC-039**: only a hidden page counts
as a page leave; a `blur` is recorded but never feeds the limits. **TASK-030** (`4ac8b35`) replaced
`public.log_session_event` through the new migration `20261002000001_leave_count_only_tab_hidden.sql`,
applied live with its `schema_migrations` row; the new `session_functions_test.sql` blur case failed on
the old function (`ASSERT FAILED: a blur never submits the attempt`) and passes after the apply; 3 new
`student_e2e.py` checks failed on the old mock and pass now. Numbers: backend **168**, unit **44**,
`student_e2e.py` **91**, `exams_e2e.py` **83**, `monitor_e2e.py` **34**, `results_e2e.py` **87**, all
three harness self-tests green. Next: PHASE B — TASK-038, then TASK-037 (its visibility/email half waits
on D-5). Detail: `05_TASK_QUEUE.md`, `07_CHANGELOG.md` (2026-10-02), `08_HANDOFF.md` (top block).

**Progress (2026-10-02, later — docs-only): PHASE B has started.** **TASK-038** (`3dc6f06` — the TASK-038 docs
commit) is complete: `04_CURRENT_STATE.md`, `05_TASK_QUEUE.md` and `08_HANDOFF.md` now open with short
Status / Open tasks / Next recommended task / Branch + commit / deliberately-not-verified headers and
point at `07_CHANGELOG.md` for history; the hash-coverage check (`comm`) proved every commit hash the
three files quote is greppable in 07 (the two the older text only implied — `084383d`, `b0c56bd` —
were named there the same day). No product code, SQL, migration, Edge Function, test or CI file was
touched and nothing was re-run. **Next: TASK-037** (its visibility/email half waits on D-5).

**Progress (2026-10-02, later — docs and test scripts only): PHASE B is complete.** **TASK-037** (`298a16d` — the
TASK-037 docs commit) reconciled `02_ARCHITECTURE.md` and `03_FEATURES.md` with the measured inventory
(**23 tables / 81 public functions / 34 migrations / 10 Edge Functions**, re-count commands at the end
of `02`), corrected every stale "not built / not deployed / no UI" claim in `03`, and — after the owner
answered D-5 (**DEC-040: the repository is public**) — removed the staff test account's address from
all 15 tracked files: the eight live checks read `SUPABASE_TEST_EMAIL` and refuse with a clear message
when it is unset, and docs and `.ai` name the variable. Verified: `grep -r` for the address returns
nothing in the working tree, the eight checks compile, backend **168** and unit **44** re-run green; no
live check was run (no credential). **Next: PHASE C — TASK-031**, then TASK-032, TASK-036, TASK-034,
TASK-039 (its secret half waits on D-4).

**Progress (2026-10-02, later — product code, tests and docs; the live apply is blocked on a credential):
PHASE C has started with TASK-031 (`b7ed106`).** Opening a second exam with a code an open exam already used could
only hit `exams_open_code_unique`, and the raw `23505` reached the teacher as a hidden 500.
`20261002000002_open_exam_code_conflict.sql` replaces `set_exam_status` (the `save_exam` rule, raised with
`hint = 'validation'` so the exams screen's toast shows the sentence and the exam stays a draft) and adds
`exam_code_used_by`, which `check_code` now asks: the editor's code field can say "Already used by another
draft" before Open. **Proved red first:** 3 new `exams_e2e.py` checks failed on the old mock+client and 2
new backend tests failed on the old `check_code`; green after: backend **170**, unit **44**, `exams_e2e.py`
**87**, `dashboard_e2e.py` **37**. **The migration is NOT applied live and
`supabase/tests/exam_status_test.sql` has not run — no Management credential in this session** (the same
place TASK-024/026 stood before their applies). **Next: TASK-032** (a live exam cannot be turned into a
template — it can share the same apply session), then TASK-036, TASK-034, TASK-039 (its secret half waits
on D-4).

**Progress (2026-10-02, later still — product code, tests and docs; the live apply is still blocked on a
credential): TASK-032 is code-complete, so PHASE C is half done.** A live exam could be ticked "Save as a
template", and `exam_join` refuses templates — one tick made a running test unjoinable — so
`20261002000003_template_only_when_safe.sql` replaces `save_exam` (`is_template` only on a draft that is
not open and has no attempts, all three refusals validation-hinted), `set_exam_status` (a template cannot
be opened; TASK-031's open-code check carried forward) and `get_exam` (`session_count` for the editor),
and one repair statement clears `is_template` from any exam that is open right now. The editor disables
the checkbox with the reason and forces the flag off. **Proved red first:** 7 new `exams_e2e.py` checks
failed on the old mock+client; green after: backend **171**, unit **44**, `exams_e2e.py` **94**,
`dashboard_e2e.py` **37**, `question_bank_e2e.py` **151**. **Neither `20261002000002` nor
`20261002000003` is applied live — no Management credential**; the next live run applies both in order
(TASK-031's `exams` redeploy after the first), runs `exam_status_test.sql` and `exam_template_test.sql`,
and records the results. **Next: TASK-036** (the editor says Saved / Unsaved / Saving… / Failed), then
TASK-034, TASK-039 (its secret half waits on D-4).

Decisions the owner must make (recorded in `06_DECISIONS.md` before the code lands):

| # | Question | Blocks |
|---|---|---|
| D-1 (answered 2026-10-02 — DEC-039) | Only a hidden page counts as a page leave; `blur` is recorded but never counts. | — (TASK-030 complete) |
| D-2 | How is a student identified (name+class only, or a student number), and how does a student see a score on another phone? | TASK-033 |
| D-3 | What does a timed-out attempt with no answers mean: a 0, or an explicit "no answers" row? | TASK-045 |
| D-4 | Should `SESSION_TOKEN_SECRET` be required (fail loudly) or keep its fallback to the service-role key? | TASK-039b |
| D-5 (visibility half answered 2026-10-02 — DEC-040) | The repository is public and the staff test account's address is stripped; **still open: may an offline-capable student shell (a service worker) be added?** | TASK-042 |
| D-6 | May a Supabase Management token live as a repository secret for a nightly read-only job? | TASK-047 |

### What this session did not verify (do not read as a clean bill)

- Nothing live: RLS, the advisors, deployed function versions, the live ledger, `notification_reads`,
the ten deployed Edge Functions. The last live picture is `04_CURRENT_STATE.md` 2026-10-01 (12 PASSED /
1 HELD, 415 checks) and it was produced by another session.
- Nothing was executed: no `deno test`, no browser suite, no live check, no `deno lint`, no axe.
- No browser and no phone, so **no layout, tap-target, hierarchy or overlap claim** is made here; the
project's own suites cover "no sideways scrolling" at 375–390 px, which is a different claim.
- No real Excel/Google Sheets file (ISSUE-013 caveat, unchanged).
- `examEditor.js` (604 lines), `questionBank.js` (517), the export writers and `sessionReport.js` were
read only in part; their findings above come from the parts that were read (the save path, the
readiness summary, the questions tab) and are marked as such.

### Context for the next agent

- Commit this inspection was written against: `ai-development` @ `98c2091` (working tree clean).
- Working copy: `D:/freebuff/English-test-v2`; a second worktree `D:/freebuff/etv-bulk` sits on
`feat-bulk` @ `53baaa1` and is **not** part of this repository's current line — do not merge it, do not
work in it (it is the pre-F-18 line already contained in `ai-development`).
- Nothing in this inspection changed product code, SQL, migrations, Edge Functions, tests or CI. Only
`.ai/` documentation was written (`10_ROADMAP.md` new; `04`, `05`, `06`, `07`, `08`, `09` and a pointer
in `00` updated).

