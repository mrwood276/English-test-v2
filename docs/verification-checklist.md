# Verification checklist for the owner (Supabase side)

Nobody needs to work through this list any more — **every item on it is done**. It is kept as the record of what was asked of the owner and how it was confirmed. Live checks are now run by an agent with real network access (the Supabase Management API token plus the project host reachable from the Windows clone); a claude.ai chat session still cannot reach `*.supabase.co`, which is why the earlier version of this file asked the owner to do everything by hand.

Verified remotely with the publishable key only (no login, read-only, 2026-09-22; re-checked since):

- Anon request to `rest/v1/questions` is refused (HTTP 401, `permission denied`) — the zero-policy lockdown really holds.
- `question-bank` without a token answers 401 "Please sign in." — the in-code auth wall works on the deployed function.
- The private `question-media` bucket leaks nothing to anon (listing says "Bucket not found").
- CORS preflight from `http://localhost:8000` is answered with `Access-Control-Allow-Origin: *` (the `ALLOWED_ORIGIN` secret is not set yet — expected until the app has an address; TASK-017).

## 1. Disable public sign-up (ISSUE-007) — DONE, and it needed a repair

Sign-ups are refused (`disable_signup: true`): a real sign-up attempt answers `signup_disabled` and creates nothing. **Careful with the provider switch**: on 2026-09-24 the "disable sign-ups" step actually turned the **Email provider off** (`external_email_enabled: false`), and every staff sign-in answered `HTTP 422 email_provider_disabled` — the teacher app was unusable until an agent switched the provider back on (owner-approved, 2026-09-25). After any dashboard change, re-read `GET https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings` (publishable key as `apikey`) and check **both** halves: sign-ups still refused **and** a staff sign-in still works.

## 2. Deploy `question-bank` v3 (TASK-006 step 3, ISSUE-003) — DONE 2026-09-22

Deployed live as v3 (`--no-verify-jwt`). `import_check` was verified against the real 40-question bank and `list` regression-checked. What is still worth a human: the owner opening one real Excel- or Google-Sheets-saved file through the import screen (the repository's fixture is generated, not Excel-made — ISSUE-013's remaining caveat) and a look at the proposed formats in `05_TASK_QUEUE.md`.

## 3. Verify one real media upload (TASK-007, ISSUE-002) — DONE 2026-09-25

Run by an agent through the app itself with the staff test account `testguru211l@gmail.com`: a 7.6 MB photo (shrunk by the app to an 813 KB WebP) and a real 3-second MP3 were uploaded to the private bucket, saved on a question, reopened and played back; a 4.5 MB JPEG forced into Storage was refused and deleted again; everything the run created was removed. `frontend/tests/live_media_check.py` reports **32/32**. See `.ai/08_HANDOFF.md` for the full evidence and how to repeat it.

## 4. Export the migrations into git (TASK-008, ISSUE-001) — DONE 2026-09-24

All 12 live migrations (`v2_01`..`v2_12`) are committed verbatim under `supabase/migrations/`, so the database can be rebuilt from the repository. **One small follow-up left** (needs the database password, which nobody has): three migrations that are live and working have no row in `supabase_migrations.schema_migrations`, and two live migrations are tracked under a different version than their git filename — a future `supabase db push` would just re-run them harmlessly (`create or replace`). Details in `09_KNOWN_ISSUES.md` (ISSUE-001).

## 5. Still worth doing in the dashboard (optional, when convenient)

- Enable leaked-password protection (Authentication → Policies) if the plan allows it (ISSUE-005).
- Rotate the credentials that have travelled through chats: the admin password, the staff test account's password (`testguru211l@gmail.com`) and the Supabase Management API token.
- When v2 has a real address: set the `ALLOWED_ORIGIN` function secret and the Auth Site URL / redirect URLs (TASK-017). Until then `*` is intentional.
