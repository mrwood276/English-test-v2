# SQL and the Auth Admin API for user management (TASK-015)

`docs/design.md`'s User Management module asks for "Buat dan nonaktifkan akun guru/admin" — the admin creates
teacher and admin accounts and deactivates them (design.md 1.2 makes this an admin job). It also closes the
gap TASK-016 was opened for: the teacher account had to be created by hand in the Supabase dashboard, and the
admin's display name was still the placeholder "Admin".

**This slice touches two systems, and the split between them is the whole design.** Supabase **Auth** owns the
login: the email, the password, and `last_sign_in_at`. `public.profiles` (id = `auth.users.id`) owns what the
application asks about a person on every request: `role`, `full_name`, `is_active`. Only the service role may
create or change an auth user, and only the Edge layer holds that key (DEC-002) — so creating the login is an
**Auth Admin API** call from the `accounts` function, while the bookkeeping and the rules that must never
break stay in SQL.

The statements live in **`supabase/migrations/20260926021234_account_functions.sql`** and are **applied live
(2026-09-26)** — recorded in `supabase_migrations.schema_migrations` as `20260926021234` / `account_functions`
(8,339 characters, written in the same session that applied it, so no ISSUE-001 drift). The Edge layer is
**`backend/functions/accounts/`**, deployed live. The screen is `#/accounts`.

## The owner's decision (DEC-031)

| Question | Answer | Why it matters here |
|---|---|---|
| How does a new person get their login? | **The admin types their email and a temporary password and hands it over.** No invitation email, no "set your own password" link. | The free plan has no working mailer for this project (sign-ups are disabled deliberately — ISSUE-007 — and SMTP is not configured), so anything that depends on mail delivery is a feature that would silently not work. The screen shows the password once, with a Copy button, and the admin tells the person. |
| What happens when somebody leaves? | **Deactivate, never delete.** `is_active = false` stops them at the front door; the row and its history stay. | A profile is the target of the audit trail (`actor_id`, `entity_id`) and of the rows the person created (`created_by` on exams, questions and backups). Deleting it would orphan that history — and "recreating" the account makes a *different* auth user with a different id, which is not the same person as far as the trail is concerned. |
| Where do the rules live? | **In SQL** (`_require_active_admin`, `update_account`'s two guards), not in JavaScript. | DEC-004: the database owns the rules, so they hold for every caller, present and future. The Edge function validates input for friendly messages; the SQL refuses independently. |

## The functions

| Function | What it does |
|---|---|
| `_require_active_admin(p_actor uuid)` | The gate every other function calls first: the actor must exist, be an `admin` and be active. The Edge layer already refuses everybody else; this is the same rule at the layer that owns the data. |
| `list_accounts()` | The admin screen's read. Joins `auth.users` for the email and `last_sign_in_at` (a `security definer` function may read it; the Edge function has already checked who is asking), and orders **admins first, then by lower-cased name**, so the list leads with the people who can administer the project. Returns `{total, rows}`. |
| `record_account(id, email, full_name, role, actor)` | The bookkeeping half of a create: inserts the `profiles` row and writes `account.create` (with the email, name and role — never the password). Refuses an id that already has a profile. The Edge function calls this **after** the Auth user was created, and deletes that user again if this raises. |
| `update_account(id, full_name, role, is_active, actor)` | Rename, promote/demote, deactivate/reactivate — each argument is optional, so an update touches only what was sent. Writes `account.update` with the new values **and** a `was` snapshot of the old ones, which is what makes the audit entry readable later. |
| `record_account_password(id, actor)` | Called after the Auth Admin API changed a password. Writes `account.password` with a note; **the password itself never reaches the database**. |

All five are `revoke`d from `public`, `anon` and `authenticated` — only `postgres` and `service_role` may
execute them, verified live (`anybody_can_execute: false` for each).

## The two guards (DEC-031)

```sql
-- Guard 1: nobody may demote or deactivate the account they are using.
if p_id = p_actor and (v_role <> v_before.role or not v_active) then
  raise exception 'You cannot change your own role or deactivate your own account.' using hint = 'validation';
end if;

-- Guard 2: whatever happens, one active admin remains.
if v_before.role = 'admin' and v_before.is_active and (v_role <> 'admin' or not v_active) then
  select count(*) into v_admins from public.profiles p where p.role = 'admin' and p.is_active;
  if v_admins <= 1 then
    raise exception 'This is the only active admin: somebody has to be able to administer the project.' using hint = 'validation';
  end if;
end if;
```

Guard 1 exists because an admin's one careless keypress should not lock them out of their own project.
Guard 2 exists because "deactivate the other admin first, then demote yourself" is a two-step way to reach a
project nobody can administer. Renaming yourself is deliberately **allowed** — that is how the placeholder
"Admin" gets a real name — and so is changing the role of somebody else.

Other refusals in the same layer: a missing actor, a missing id, a role that is not teacher/admin, a name
outside 1–120 characters, and an id that no longer exists (`That account no longer exists.`) — every one of
them a `validation` hint, so `callRpc` turns it into a friendly 400 rather than a 500.

## The Edge function (`accounts`)

| Action | Input | What it does |
|---|---|---|
| `list` | — | `list_accounts()`, unchanged. |
| `create` | `email`, `full_name`, `role`, `password` | Validates (`asEmail` lower-cases and rejects an address without a real domain; password 8–72 characters), then `auth.admin.createUser({email, password, email_confirm: true, user_metadata: {full_name}})` and `record_account`. **If the database refuses, the auth user is deleted again** — a person who cannot sign in *and* cannot be seen in the list is the one state worth going out of the way to avoid. |
| `update` | `id`, and any of `full_name`, `role`, `is_active` | `update_account`. Nothing to change → 400 `"There is nothing to change."`. |
| `password` | `id`, `password` | `auth.admin.updateUserById(id, {password})`, then `record_account_password`. |

`email_confirm: true` on purpose: the admin is standing next to the person and knows the address is right,
and there is no mailer to click a confirmation link in.

Auth problems are translated into sentences a person can act on (`authProblem`): "already registered" → 400
*"An account with this email address already exists."*; anything mentioning a password → 400 with the
8–72 range; anything mentioning the email → 400 *"That email address cannot be used."*; **anything else is a
logged 500** with a generic message — an unexpected error from the sign-in service is not something to relay
verbatim to a browser.

The whole endpoint is `requireStaff(req, db, ["admin"])` — the second admin-only endpoint after `audit`, and
a teacher gets 403 from the staff gate before any action is read.

## The admin screen (`#/accounts`)

A table of Name / Email / Role / Status / Last signed in:

* the signed-in admin's own row says **"(you)"** next to the name and offers *"This is you"* instead of a
  Deactivate button, and the role select on that row is disabled — the same two rules the SQL enforces, shown
  before they are hit;
* Role is a select (teacher/admin) and Status is Deactivate/Reactivate — each change is one `update` call and
  refreshes the row from the server's answer;
* **New account** asks for name, email, role and a suggested 12-character password (no `0/O/1/l/I`, so it can
  be read aloud), and then shows a **hand-over panel** with the password as text plus a Copy button. The
  dialog closes *before* that panel appears, so the panel is never hidden behind it;
* Deactivating is the destructive-looking action, so it goes through the shared confirm dialog; there is no
  Delete anywhere, because deactivation is the design (DEC-031).

Menu: `ADMIN_NAV` gained "Accounts" (`users` icon) between Audit log and Backups; the menu is now **9 items**
for an admin (the assertions in `teacher_e2e.py` and `monitor_e2e.py` were bumped 8 → 9).

## How it was verified (2026-09-26)

**In git, no live project needed**

* `deno test --allow-env backend/` → **143 passed** (was 130). `backend/tests/accounts.test.ts` is 13 tests:
  the admin gate, the exact Auth Admin API calls (`createUser` with `email_confirm`, `updateUserById`, the
  `deleteUser` rollback when the database refuses), the friendly 400s, the password range and the 401/405
  walls, with a fake `auth.admin` recording its calls.
* `python frontend/tests/accounts_e2e.py` → **46 checks** against the mock server: the menu item and
  `aria-current`, the table contents and ordering, the "(you)" row with its disabled select and "This is you",
  promote/demote/deactivate/reactivate round-trips, the new-account dialog and its refused-create path
  (duplicate email, then corrected), the hand-over panel with the password and Copy, a failed password change,
  the empty state, and a teacher who is neither offered the menu item nor allowed to call the function.
  CI runs it as the thirteenth browser suite (`frontend-tests.yml`).

**Live**

* `supabase/tests/account_functions_test.sql` → `ACCOUNT TESTS PASSED (2 accounts, 1 active admins, 4 audit
  entries written and rolled back)` — grants on all five functions, the shape and ordering of
  `list_accounts`, every guard and refusal, the `was` snapshot, and that nothing leaked; all inside a
  rolled-back `do $acct$` block, so the project was untouched.
* `frontend/tests/live_accounts_check.py` → **44/44**, `ALL LIVE ACCOUNT CHECKS PASSED`. In order: the admin
  and the teacher sign in through one-time links; the door's rules (tokenless 401, teacher 403 on `list` and
  on `create`); a **throwaway account created with a typed password that really signs in**, is called a
  teacher by the app with the typed name, can use the teacher endpoints and cannot touch `accounts`; duplicate
  email, bad address and short password refused; rename (and the person's own view changes with it);
  promote → the promoted person can list → demote → 403 again; deactivate → the front door refuses while
  `auth` still knows them (the gate is the application's) → reactivate; a new password (old one stops working,
  new one works, audit entry holds no password); the guards (self-demotion 400, self-deactivation 400, unknown
  account 400); then the throwaway account deleted through the Auth Admin API, its audit rows removed, and the
  project's own two accounts compared **row for row** before and after.
* Live state afterwards: 2 auth users, **0 strays**, 2 profiles, 0 `account.%` audit rows.
* Live public SQL functions 69 → **74**; the live `profiles` rows are the admin (`7b0a389c…`, "Admin") and the
  staff test account (`d4d16135…`, "Test Upload", `testguru211l@gmail.com`).

## What is deliberately not here

* **Email invitations and password-reset-by-email.** Both need a mailer the free plan does not give this
  project, and password reset additionally needs the app's own address set in Supabase Auth — that is TASK-017
  (hosting), and `frontend/README.md` already says so.
* **Deleting an account.** DEC-031: deactivate instead. A "delete" would have to decide what happens to the
  audit rows and the exams the person created, and there is no answer that is better than keeping them.
* **Self-service sign-up.** Disabled deliberately (ISSUE-007); accounts are an admin job (design.md 1.2).
* **Sessions and 2FA.** There is no "sign out everywhere" and no second factor; sessions are Supabase Auth's
  own, and a deactivated profile is refused on every request regardless of a valid token (DEC-003).
* **Student accounts.** Students have none by design (DEC-001/BR-09); user management here is staff only.
* **Roles beyond teacher/admin.** The `user_role` enum has exactly those two, and nothing in `docs/design.md`
  asks for more.
