# Verification checklist for the owner (Supabase side)

The agents have no Supabase dashboard/CLI access, so these steps need you. Each item says why it matters and how to confirm it. Tick them off in `.ai/05_TASK_QUEUE.md` / `09_KNOWN_ISSUES.md` as you go (or ask an agent to do it).

What was already verified remotely on 2026-09-22 with the publishable key only (no login, read-only):

- Anon request to `rest/v1/questions` is refused (HTTP 401, `permission denied`) — the zero-policy lockdown really holds.
- `question-bank` without a token answers 401 "Please sign in." — the in-code auth wall works on the deployed function.
- The private `question-media` bucket leaks nothing to anon (listing says "Bucket not found").
- CORS preflight from `http://localhost:8000` is answered with `Access-Control-Allow-Origin: *` (the `ALLOWED_ORIGIN` secret is not set yet — expected).
- **Signup by email is still ENABLED** (`auth/v1/settings` shows email sign-ups on). See step 1 below — this is the one urgent item.

## 1. Disable public sign-up (ISSUE-007) — urgent, 2 minutes

Dashboard → Authentication → Sign In / Providers → **Email**: turn off "Allow new users to sign up". Anyone can currently create an auth user; data stays safe (no `profiles` row → every API call gets 403), but the door should be closed. Confirm afterwards with `curl https://lbhnadqmokloyfarrzfv.supabase.co/auth/v1/settings -H "apikey: <publishable>"` — email should read `false`.

## 2. Deploy `question-bank` v3 (TASK-006 step 3, ISSUE-003) — unlocks the finished import screen

Either CLI (`supabase functions deploy question-bank --no-verify-jwt`, from a machine logged in to the `lbhnadqmokloyfarrzfv` project) or Dashboard → Edge Functions → question-bank → deploy new version (paste the repo files: `index.ts`, `handler.ts`, `parse.ts`, plus `../_shared/*` with the import path rewritten `../_shared/` → `./_shared/`). It is additive: the deployed v2 keeps working; v3 only adds `import_check`/`import`.

After deploying, verify in the running app (local `python frontend/dev-server.py`): sign in → Question bank → **Import** → "Show an example" → Review questions → Import. Expect a green toast "Imported N questions" and the rows appearing in the bank. Also try a broken row on purpose: nothing may be saved and the message must name the row.

## 3. Verify one real media upload (TASK-007, ISSUE-002)

Open `#/questions/new`, upload a photo and an MP3, save, reopen the question — the image and player must load. `media_files` should gain rows and the files appear in bucket `question-media`. If the upload PUT fails, check the browser Network tab for the request to `.../storage/v1/object/upload/sign/question-media/...` and tell the agent the status/error.

## 4. Export the migrations into git (TASK-008, ISSUE-001)

`supabase db pull` (or copy the SQL of `v2_01`..`v2_12` from Dashboard → Database → Migrations) into `supabase/migrations/`, one file per migration with the same names/order. After that the database can be rebuilt from the repository and future migrations can be stored in git (as `00_AI_RULES.md` section 8 requires).

## 5. Optional but recommended while you are in the dashboard

- Enable leaked-password protection (Authentication → Policies) if the plan allows it (ISSUE-005).
- Later, when v2 has a real address: set the `ALLOWED_ORIGIN` function secret and the Auth Site URL / redirect URLs (TASK-017). Until then `*` is intentional.
