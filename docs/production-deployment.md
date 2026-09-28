# Production / go-live guide

Everything an AI agent could do from the repository is done (see the end of this file for the list and
for the evidence). What is left needs a person: a hosting account, the Supabase dashboard, a real
phone, and a real Excel file. Work through the numbered steps in order — step 3 must happen **before
the first real exam day**, and everything else can be done in any order.

Nothing here needs a paid plan.

---

## 1. Host the frontend (TASK-017)

The frontend is a plain static site: no build step, no Node, no environment variables, no
server-side rendering, no rewrite rules (the router is a **hash** router, so every screen lives under
`index.html#/…`). All asset paths in the two HTML files are relative, and no product file contains a
`localhost` address, so the exact same folder works on any static host, at the root or under a
subpath.

| Setting | Value |
|---|---|
| Publish / output directory | `frontend` |
| Build command | **(none — leave empty)** |
| Environment variables | none |
| Node / Python version | irrelevant, nothing is compiled |

Both expected hosts accept this as-is:

**Cloudflare Pages** — Workers & Pages → Create → Pages → Connect to Git → pick `mrwood276/English-test-v2`
→ Build command: empty → Build output directory: `frontend` → Save and Deploy.
`frontend/_headers` (already committed) is applied automatically: it sends
`Cache-Control: no-cache` (the app's file names carry no content hash, so the browser must revalidate
or a teacher can be served last week's JavaScript after a deploy — exactly the stale-cache problem
`dev-server.py` avoids locally), plus `X-Content-Type-Options`, `Referrer-Policy` and
`X-Frame-Options`.

**Netlify** — Add new site → Import an existing project → pick the repository → Base directory: empty
→ Build command: empty → Publish directory: `frontend`. Netlify reads the same `_headers` file.

The result has two addresses from one deployment:

- `https://<host>/` — the **student** page (name + class + exam code).
- `https://<host>/teacher/` — the **teacher/admin** app.

A direct visit to `/teacher/` must return `teacher/index.html`; every static host does this for a
directory request. If the host ever asks for a rewrite rule, the needed one is
`/teacher/* → /teacher/index.html 200` — nothing else, because the router never uses a path segment.

> **BLOCKED - USER ACTION REQUIRED**: this deployment needs your hosting account. Write the final
> address down; steps 2 and 3 use it.

## 2. Restrict which websites may call the backend (`ALLOWED_ORIGIN`)

The Edge Functions answer browsers with `Access-Control-Allow-Origin`. With nothing configured the
value is `*`, which is right for development and wrong for production — anybody's website could then
read an answer on behalf of a signed-in teacher's browser.

Set it in **Supabase Dashboard → Edge Functions → Secrets** (or `supabase secrets set
ALLOWED_ORIGIN=…`), for the project `lbhnadqmokloyfarrzfv`:

```
ALLOWED_ORIGIN=https://<your-app-address>
```

- **One address, or several separated by commas.** Keep a local one if you test on your own machine:
  `ALLOWED_ORIGIN=https://<your-app-address>,http://localhost:8000`
- The functions echo a caller's own `Origin` back **only** when it is on that list, and the answer
  always carries `Vary: Origin`. An off-list website gets a name that is not its own, so its browser
  refuses to hand the answer over.
- `*` also works as a list entry and means "allow any".
- The value is read per request, so no redeploy is needed — but the secret applies to **every**
  function, so set it once. Sessions and tokens are unaffected.
- No `Access-Control-Allow-Credentials` is involved: staff tokens travel in the `Authorization`
  header, never in cookies, so there is no cookie/`*` conflict to worry about.

> **BLOCKED - USER ACTION REQUIRED**: dashboard access.

## 3. Set `SESSION_TOKEN_SECRET` — **before the first real exam day**

A student has no account: the server hands the page a signed token
(`<session id>.<HMAC-SHA256>`, `backend/functions/session/token.ts`) and that token is the only
credential for that attempt. Its key comes from `SESSION_TOKEN_SECRET`, and **if that secret is not
set the service-role key is used instead** — deliberate, so the app works out of the box, but it means
one high-value key is doing two unrelated jobs (database access and student tokens).

Generate a dedicated secret and set it as an Edge Function secret:

```bash
openssl rand -hex 32          # or: python -c "import secrets; print(secrets.token_urlsafe(48))"
```

```
SESSION_TOKEN_SECRET=<the generated value>
```

**Changing this value invalidates every student session token that is in flight** — an attempt taken
across the change would be told its session is lost. That is why it must be done now, not on exam day.
Once set, leave it alone; rotating it later is a deliberate act with the same consequence.

Never commit the value, and never print it into a chat.

> **BLOCKED - USER ACTION REQUIRED**: dashboard access.

## 4. Supabase Auth: Site URL and redirect URLs

What the app actually does today: staff sign in with **email + password** over the REST password
grant (`/auth/v1/token?grant_type=password`), the session is kept in `sessionStorage`, and it is
refreshed with the refresh token. **The application never receives a redirect back from Supabase and
never uses an email link**, so **no redirect URL is required for any current feature.** Sign-in works
whatever the Site URL says.

Set it anyway, in **Dashboard → Authentication → URL Configuration**:

| Field | Value |
|---|---|
| Site URL | `https://<your-app-address>` |
| Redirect URLs | `https://<your-app-address>/**` (and `http://localhost:8000/**` if you test locally) |

Reasons: the Site URL is the base for any Supabase-generated link (it defaults to a localhost address,
which is misleading for a school system), and adding the redirect URL now means that if you later ask
for a **"forgot my password"** email, the link already has somewhere safe to land. Self-service
password reset is *not* built (ISSUE-028 needs a working mailer, which the free plan does not provide);
today the recovery path is an admin setting a new password on `#/accounts`.

Also worth doing while you are in the dashboard (each is optional):

- **Authentication → Policies → leaked password protection** — enable it if the plan allows
  (ISSUE-005).
- **Authentication → Providers → Email** — leave the provider **on** and sign-ups **off**. Turning the
  provider off instead of sign-ups is a mistake that has already broken every staff sign-in once
  (ISSUE-007). After any change here, check that a sign-up is still refused *and* that a staff sign-in
  still works.
- Rotate the credentials that have travelled through chats: the admin password, the staff test
  account's password, and the Supabase Management API token.

> **BLOCKED - USER ACTION REQUIRED**: dashboard access.

## 5. Real accounts (TASK-016)

This is no longer a database job — it is one screen. Sign in as the admin, open **Accounts**
(`#/accounts`):

1. Rename the placeholder `"Admin"` to your real name (the row shows "(you)"; renaming yourself is
   deliberately allowed).
2. **New account** → type the teacher's real email, name, role `teacher`, and a suggested temporary
   password. Hand it over; no email is sent.
3. Have the teacher sign in and, if you want, set their own password from the same screen.

An account is **deactivated, never deleted**, and two guards are enforced in the database: nobody can
change their own role or deactivate themselves, and the last active admin cannot be demoted or
deactivated.

> **BLOCKED - USER ACTION REQUIRED**: this is a real account for a real person.

## 6. The real end-to-end run (a teacher, a phone, a student)

The automated suites (13 browser suites, 627 checks) run against a **mocked** backend; a live
implementation was exercised through the deployed functions by an agent, but **nobody has yet walked
the whole thing by hand against the hosted public address**. Do this once before telling anyone the
system is live.

Teacher, on a computer:

1. Open `https://<your-app-address>/teacher/` and sign in.
2. `#/questions/new` — write one multiple-choice question and save it.
3. `#/exams/new` — create an exam: a title, a duration (use 3 minutes for the test), pick that
   question, and **Open** it. Note the 6-character code.
4. Copy the address `https://<your-app-address>/` and send it to the phone.

Student, on a phone (use real mobile data once, not only school Wi-Fi):

5. Open the address, type a name, a class, and the exam code, and join.
6. Answer **one question wrong on purpose** and the last one correctly; watch the countdown and the
   "Saved" pill; leave the page once and come back to check the attempt resumes.
7. Submit. The result should appear immediately for the choice questions.
8. Now scroll down and check the same things the automated tests check: nothing overlaps on a small
   screen, the buttons are big enough to tap, the timer counts down on its own, and the page does not
   scroll sideways.

Teacher again:

9. `#/monitor` — the running exam should be listed with the student on it.
10. `#/results` → open the exam → open the attempt. The score must match what you expected from step 6:
    the correct answer scores, the wrong one does not, and the total and pass/fail agree.
11. Refresh the page in the middle of grading; a finished attempt must still show the same numbers.
12. Try to submit the same exam a second time from the phone with the same name and class — it must be
    refused (one attempt per person, BR-02).

Write down anything that looks wrong; a screenshot of the phone and the console (F12 → Console) is
worth more than a description.

> **BLOCKED - USER ACTION REQUIRED**: a real phone and a real browser. The AI cannot do this one.

## 7. One real Excel file (TASK-006, ISSUE-013)

Import is built and tested, but always against a fixture this repository generates itself
(`frontend/tests/unit/fixtures/import-sample.xlsx`) — **no file that Excel or Google Sheets actually
saved has ever been opened through the screen.** That is a different thing and it is the last gap in
this feature.

What is needed: **one real spreadsheet from a teacher**, ideally the file that is actually used now,
plus one Google Sheets export if that is how questions are kept.

- Columns (case- and spacing-insensitive; English and Indonesian aliases both work):
  `type` (optional), `question` (required), `option_a` … `option_f`, `correct`, `guide` (essay),
  `explanation`, `topic`, `difficulty` (`easy`/`medium`/`hots`), `points`, `class`, `reading_text`,
  `reading_text_body`.
- `.xlsx` and `.csv` only (not `.xls`), up to 200 rows at a time; images and audio cannot be imported.
- Templates and the full format description are on the import screen itself
  (`#/questions/import` → help text, example, and the two template downloads).

To test: `#/questions/import` → choose the file → read the review table. Every row must be either
**Ready** or explain exactly what it needs; **nothing is saved until you press Import**, and a batch
with one bad row saves nothing.

> **BLOCKED - USER ACTION REQUIRED**: the real file. If the real file's layout differs from the format
> above, send it over — adapting the parser is a small job, guessing is not.

## 8. A backup that is not inside Supabase (ISSUE-027)

The project takes a nightly copy of the whole database **and the attached pictures/audio** by itself,
and an admin can take one on demand: `#/backups` → **Make a backup** → **Download**. A copy is one ZIP
(`data.json` plus the media files).

The gap is where those copies live: **in the same Supabase project as the data they protect**, i.e.
the same failure domain. Do this once a month (or at least once before exam season):

1. Open `https://<your-app-address>/teacher/#/backups` and sign in as the admin.
2. Press **Make a backup**, wait for it, then **Download** it.
3. Store that ZIP **outside Supabase** — a Google Drive/Dropbox folder and, better, also an external
   drive or a second machine.
4. Rename it with the date so the newest copy is obvious, e.g. `english-test-v2-2026-10-05.zip`.

Restoring is a documented-by-hand procedure, not a button: `data.json` has to be re-inserted in
dependency order and `media/<path>` re-uploaded, ideally into a scratch project first
(`docs/sql-backups.md`). Rehearsing that once, calmly, is worth more than taking twenty more backups.

> **BLOCKED - USER ACTION REQUIRED**: somewhere outside Supabase to keep the file.

## 9. Merge `ai-development` → `main`

Only after steps 1–8 have passed. `main` is the stable branch and merging into it is your decision
(DEC-020/021), never an agent's. The one thing the merge must handle: `main` still carries Codex's
superseded import implementation, so resolve the files listed in DEC-021 in favour of
`ai-development`, and drop `frontend/tests/import.test.js` and
`frontend/assets/js/teacher/import/model.js` (ISSUE-015).

> **BLOCKED - USER ACTION REQUIRED**: it is your branch and your signature.

---

## Deliberately deferred (not blockers)

| Item | Why it is fine to leave |
|---|---|
| **Google Fonts** | Two families load from `fonts.googleapis.com`. Both `font-family` tokens already end in a proper fallback stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` and `Georgia, "Times New Roman", serif`), so if the school's network blocks Google the app stays readable in a slightly different typeface. Self-hosting would remove one external request; it is polish, not a risk. LOW. |
| **Email notifications** | TASK-015's dashboard half is built; the email half waits for a provider decision (DEC-017) and the free plan has no configured mailer. Nothing else depends on it. |
| **PDF/Word export of *questions*** | TASK-021, LOW. The class-summary **PDF** of results is already built (TASK-012 complete). |
| **v1 cutover** | TASK-019. v1 keeps serving real students until v2 has passed everything above. |
| **Self-service password reset** | ISSUE-028. Needs a mailer plus step 4; the admin path on `#/accounts` covers recovery today. |
| **Restore button for backups** | ISSUE-027. Overwriting a live database is a design conversation, not a bolt-on. |

---

## What was already done in the repository (verified, not claimed)

Checked by reading the source and running the test suites; the runs are listed in
`.ai/07_CHANGELOG.md`.

- **Static-hosting compatibility**: asset paths relative in both `index.html` files, hash routing only
  (no path segments, so no rewrite rules), no server-side rendering, no build step, no
  `localhost`/`127.0.0.1` in any product file, and the Supabase address lives in exactly one place
  (`frontend/assets/js/core/config.js`).
- **Deployment files added**: `frontend/_headers` (revalidate + `nosniff` + `Referrer-Policy` +
  `X-Frame-Options`) and `frontend/robots.txt`.
- **CORS**: `ALLOWED_ORIGIN` now accepts a comma-separated allow-list, echoes only a listed origin, and
  sets `Vary: Origin`; covered by four new backend tests.
- **Auth flow reviewed**: password grant + refresh token, session in `sessionStorage`, no redirect URL
  needed — step 4 says exactly which setting matters and why.
- **`SESSION_TOKEN_SECRET`**: usage, fallback to the service-role key, and the rotation consequence
  documented in step 3.
- **Security review**: no secret in the repository (`.gitignore` covers `.env*`), no unsafe
  `innerHTML` on user data (only `icons.js`, from a fixed string map), no cookie-based auth, every
  table RLS-on with zero policies. The **publishable key in `config.js` is public by design**.
- **Backups, accounts, audit, monitor, grading, exports**: built and live-verified in earlier
  sessions; see `.ai/04_CURRENT_STATE.md`.
- **Automated tests**: `deno test --allow-env backend/tests/` = **147 passed, 0 failed**; the frontend
  unit tests and all **13** browser suites = **627 checks** green.

## What still cannot be claimed

- No live Supabase call was made in this session (**no credential**), so RLS, the security/performance
  advisors and the deployed function versions were **not** re-verified. Easiest way to see the whole
  live state: run the live checks listed in `frontend/README.md` with `SUPABASE_ACCESS_TOKEN` set.
- No CI run for this push was observed (no GitHub credential); check both workflows in the Actions tab.
- The hosted address has never been visited by a person (step 6).
