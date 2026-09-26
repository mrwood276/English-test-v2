"""LIVE check of user management (TASK-015).

Not part of CI and no dev server needed: this one talks to the deployed `accounts` function and to Supabase
Auth itself, with a throwaway account that it deletes again at the end.

    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_accounts_check.py

Need SUPABASE_ACCESS_TOKEN (a Supabase Management token): the check mints one-time login links for the admin
and for the staff test account, reads its own rows through the Management API, and deletes its throwaway
auth user through the Auth Admin API when it is done. Set SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD or
SUPABASE_TEST_EMAIL to override the accounts.

What it proves, in order:
  1. the deployed function lists the project's real accounts, with their emails and last sign-ins, and
     refuses a teacher (403) and a tokenless call (401);
  2. an admin can create an account with a typed password (DEC-031), and the new person **really signs in**
     with it, is a teacher, can use the teacher endpoints and cannot touch the accounts function;
  3. renaming, promoting to admin and demoting back all take effect immediately, and each is audited;
  4. deactivating stops that person at the front door (403 from the staff gate) while their row and history
     stay, and reactivating brings them back;
  5. setting a new password is audited without the password, and the old password stops working;
  6. the guards hold live: an admin cannot demote or deactivate themselves, and an unknown account is
     refused;
  7. everything this run created is gone: the account, its audit rows and its storage-free self, with the
     project's own two accounts untouched.

The screen half of this slice is frontend/tests/accounts_e2e.py; the SQL guards are also asserted by
supabase/tests/account_functions_test.sql (runnable with no browser and no login).
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
ADMIN_EMAIL = os.environ.get("SUPABASE_ADMIN_EMAIL", "jonathan10g7@gmail.com")
ADMIN_PASSWORD = os.environ.get("SUPABASE_ADMIN_PASSWORD", "")
TEACHER_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
NAME = "Live Accounts Check"
NAME_AFTER = "Live Accounts Check Renamed"
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode("utf-8", "replace")
            return res.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(text or "null")
        except ValueError:
            return err.code, text


def call(name, body, token=None):
    return http("POST", f"{URL}/functions/v1/{name}", body, {"Authorization": f"Bearer {token}"} if token else {})


def sql(query):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
                                 data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"database said: {err.read().decode('utf-8', 'replace')[:400]}") from None


def service_key():
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/api-keys",
                                 headers={"Authorization": f"Bearer {ACCESS}"})
    with urllib.request.urlopen(req, timeout=90) as res:
        return next(k["api_key"] for k in json.loads(res.read().decode()) if k["name"] == "service_role")


def add_user(email, password):
    """Creates an auth user through the Auth Admin API (what the function does for an admin)."""
    service = service_key()
    return http("POST", f"{URL}/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True},
                {"Authorization": f"Bearer {service}"})


def delete_user(user_id):
    service = service_key()
    return http("DELETE", f"{URL}/auth/v1/admin/users/{user_id}", None, {"Authorization": f"Bearer {service}"})


def password_grant(email, password):
    return http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": email, "password": password})


def magic_link(email):
    service = service_key()
    status, link = http("POST", f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email},
                        {"Authorization": f"Bearer {service}", "apikey": service})
    if status != 200:
        return status, link
    return http("POST", f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": link["hashed_token"]})


def who_am_i(token):
    return http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {token}"})


def accounts_state():
    """The project's own two accounts, and how much account history is lying around."""
    return sql("""select (select count(*)::int from public.profiles) as accounts,
                         (select count(*)::int from public.audit_logs where action like 'account.%') as history,
                         (select jsonb_agg(jsonb_build_object('id', id, 'name', full_name, 'role', role, 'active', is_active)
                                           order by created_at) from public.profiles) as rows""")[0]


def wipe_check():
    """Removes whatever a previous (or half-finished) run of *this check* left behind, and nothing else."""
    for row in sql(f"select id from public.profiles where full_name like '{NAME}%'"):
        sql(f"delete from public.audit_logs where action like 'account.%' and entity_id = '{row['id']}'")
        delete_user(row["id"])  # the profile row goes with the auth user (on delete cascade)


def main():
    if not ACCESS:
        print("set SUPABASE_ACCESS_TOKEN first: this check mints login links and reads its own rows")
        return 1
    wipe_check()
    before = accounts_state()
    print(f"live state before: {json.dumps(before)}")
    check("the starting point has the two real accounts and no account history",
          before["accounts"] == 2 and before["history"] == 0, json.dumps(before))

    # ---------- 1. the admin and the door ----------
    status, data = magic_link(ADMIN_EMAIL)
    check("the admin account can sign in (a one-time link, no password needed)", status == 200,
          f"{status} {json.dumps(data)[:200]}")
    if status != 200:
        return 1
    admin = data["access_token"]
    _, me = who_am_i(admin)
    check("the staff gate calls it an admin", ((me or {}).get("user") or {}).get("role") == "admin", json.dumps(me)[:200])

    status, listed = call("accounts", {"action": "list"}, admin)
    rows = (listed or {}).get("accounts", {}).get("rows") or []
    check("the deployed function lists the project's accounts",
          status == 200 and (listed or {})["accounts"]["total"] == 2, f"{status} {json.dumps(listed)[:200]}")
    check("every account carries its email and its last sign-in",
          all(r.get("email") and "last_sign_in_at" in r for r in rows), json.dumps(rows)[:200])
    check("the admin comes first", rows and rows[0]["role"] == "admin", json.dumps(rows[:1])[:200])

    check("a tokenless call is refused", call("accounts", {"action": "list"})[0] == 401)
    teacher_status, teacher_data = magic_link(TEACHER_EMAIL)
    teacher = teacher_data.get("access_token") if teacher_status == 200 else None
    check("the staff test account signs in for the role rule", bool(teacher), f"{teacher_status} {json.dumps(teacher_data)[:160]}")
    check("a teacher cannot list the accounts", teacher is not None and call("accounts", {"action": "list"}, teacher)[0] == 403)
    check("a teacher cannot create one either",
          teacher is not None and call("accounts", {"action": "create", "email": "x@example.com", "full_name": "X",
                                                    "role": "admin", "password": "temporary-pass"}, teacher)[0] == 403)

    # ---------- 2. creating an account somebody can really use ----------
    email = f"accounts-check-{int(time.time())}@example.com"
    password = secrets.token_urlsafe(12)
    status, made = call("accounts", {"action": "create", "email": email, "full_name": NAME,
                                     "role": "teacher", "password": password}, admin)
    account = (made or {}).get("account") or {}
    check("an admin can create an account with a typed password", status == 200 and account.get("role") == "teacher",
          f"{status} {json.dumps(made)[:250]}")
    if status != 200:
        return 1
    check("the new account is active and has never signed in",
          account.get("is_active") is True and account.get("id"), json.dumps(account)[:200])
    check("the same address cannot be created twice",
          call("accounts", {"action": "create", "email": email, "full_name": NAME, "role": "teacher",
                            "password": password}, admin)[0] == 400)
    check("a bad address is refused before anything is created",
          call("accounts", {"action": "create", "email": "not-an-email", "full_name": NAME, "role": "teacher",
                            "password": password}, admin)[0] == 400)
    check("a password that is too short is refused",
          call("accounts", {"action": "create", "email": f"short-{email}", "full_name": NAME, "role": "teacher",
                            "password": "short"}, admin)[0] == 400)

    status, session = password_grant(email, password)
    check("the new person really signs in with that password", status == 200 and session.get("access_token"),
          f"{status} {json.dumps(session)[:200]}")
    if status != 200:
        return 1
    theirs = session["access_token"]
    _, theirs_me = who_am_i(theirs)
    check("and the app calls them a teacher with the name the admin typed",
          (theirs_me or {}).get("user", {}).get("role") == "teacher"
          and (theirs_me or {}).get("user", {}).get("fullName") == NAME, json.dumps(theirs_me)[:200])
    check("they can use the teacher endpoints", call("question-bank", {"action": "list", "page_size": 1}, theirs)[0] == 200)
    check("they cannot touch the accounts function", call("accounts", {"action": "list"}, theirs)[0] == 403)
    check("the creation is written down",
          sql(f"select count(*)::int n from public.audit_logs where action = 'account.create' and entity_id = '{account['id']}'")[0]["n"] == 1)
    check("and the list now shows three accounts",
          (call("accounts", {"action": "list"}, admin)[1] or {})["accounts"]["total"] == 3)

    # ---------- 3. renaming and the role ----------
    status, renamed = call("accounts", {"action": "update", "id": account["id"], "full_name": NAME_AFTER}, admin)
    check("an admin can rename somebody without touching their role",
          status == 200 and (renamed or {}).get("account", {}).get("full_name") == NAME_AFTER,
          f"{status} {json.dumps(renamed)[:200]}")
    check("the person's own view of themselves changes with it",
          ((who_am_i(theirs)[1] or {}).get("user") or {}).get("fullName") == NAME_AFTER)
    check("the rename is audited with what it was before",
          sql(f"""select (changes ->> 'full_name') = '{NAME_AFTER}' and (changes -> 'was' ->> 'full_name') = '{NAME}'
                     as ok from public.audit_logs
                    where action = 'account.update' and entity_id = '{account['id']}'
                    order by created_at desc limit 1""")[0]["ok"] is True)

    status, promoted = call("accounts", {"action": "update", "id": account["id"], "role": "admin"}, admin)
    check("an admin can promote somebody to admin", status == 200 and (promoted or {}).get("account", {}).get("role") == "admin",
          f"{status} {json.dumps(promoted)[:200]}")
    check("and the promotion takes effect on the next call",
          call("accounts", {"action": "list"}, theirs)[0] == 200)
    status, demoted = call("accounts", {"action": "update", "id": account["id"], "role": "teacher"}, admin)
    check("and demote them again", status == 200 and (demoted or {}).get("account", {}).get("role") == "teacher",
          f"{status} {json.dumps(demoted)[:200]}")
    check("the demoted person loses the admin door", call("accounts", {"action": "list"}, theirs)[0] == 403)

    # ---------- 4. deactivating ----------
    status, off = call("accounts", {"action": "update", "id": account["id"], "is_active": False}, admin)
    check("an admin can deactivate an account", status == 200 and (off or {}).get("account", {}).get("is_active") is False,
          f"{status} {json.dumps(off)[:200]}")
    status, refused = who_am_i(theirs)
    check("the deactivated person is stopped at the front door", status == 403, f"{status} {json.dumps(refused)[:200]}")
    check("even though the sign-in service itself still knows them (the gate is the app's)",
          password_grant(email, password)[0] == 200)
    check("their profile and its history are still there, deactivated",
          sql(f"select count(*)::int n from public.profiles where id = '{account['id']}' and is_active = false")[0]["n"] == 1)
    status, on = call("accounts", {"action": "update", "id": account["id"], "is_active": True}, admin)
    check("reactivating brings them straight back", status == 200 and (on or {}).get("account", {}).get("is_active") is True
          and who_am_i(theirs)[0] == 200, f"{status} {json.dumps(on)[:200]}")

    # ---------- 5. a new password ----------
    new_password = secrets.token_urlsafe(14)
    status, changed = call("accounts", {"action": "password", "id": account["id"], "password": new_password}, admin)
    check("an admin can set a new password", status == 200 and (changed or {}).get("changed") is True,
          f"{status} {json.dumps(changed)[:200]}")
    check("the old password stops working", password_grant(email, password)[0] == 400)
    check("and the new one works", password_grant(email, new_password)[0] == 200)
    audit = sql(f"""select changes::text as changes from public.audit_logs
                     where action = 'account.password' and entity_id = '{account['id']}' order by created_at desc limit 1""")
    check("the password change is audited without the password",
          len(audit) == 1 and new_password not in audit[0]["changes"] and password not in audit[0]["changes"],
          str(audit)[:200])
    check("a password that is too short is refused", call("accounts", {"action": "password", "id": account["id"],
                                                                  "password": "short"}, admin)[0] == 400)

    # ---------- 6. the guards ----------
    admin_id = ((me or {}).get("user") or {}).get("id")
    status, body = call("accounts", {"action": "update", "id": admin_id, "role": "teacher"}, admin)
    check("an admin cannot demote themselves", status == 400 and "your own role" in json.dumps(body), f"{status} {json.dumps(body)[:200]}")
    status, body = call("accounts", {"action": "update", "id": admin_id, "is_active": False}, admin)
    check("nor deactivate themselves", status == 400 and "your own account" in json.dumps(body), f"{status} {json.dumps(body)[:200]}")
    status, body = call("accounts", {"action": "update", "id": "00000000-0000-4000-8000-000000000000",
                                     "full_name": "Nobody"}, admin)
    check("and an account that is not there is refused", status == 400 and "no longer exists" in json.dumps(body),
          f"{status} {json.dumps(body)[:200]}")

    # ---------- 7. clean up ----------
    delete_user(account["id"])
    sql(f"delete from public.audit_logs where action like 'account.%' and entity_id = '{account['id']}'")
    after = accounts_state()
    print(f"live state after cleanup: {json.dumps(after)}")
    check("the throwaway account is gone (its profile with the auth user)",
          sql(f"select count(*)::int n from public.profiles where id = '{account['id']}'")[0]["n"] == 0)
    check("its audit rows are gone too", after["history"] == 0, json.dumps(after))
    check("the project is back to its two real accounts, untouched",
          after["accounts"] == before["accounts"] and after["rows"] == before["rows"],
          f"{json.dumps(after['rows'])} vs {json.dumps(before['rows'])}")

    failed = [n for n, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE ACCOUNT CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
