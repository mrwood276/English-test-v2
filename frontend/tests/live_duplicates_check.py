"""LIVE run of the duplicate-overview banner in the question list (TASK-020).

Not part of CI. Read-only: it writes nothing to the live project, changes no question and leaves no
rows behind — it only signs in, asks the deployed `question-bank` for the duplicate scan, checks the
SQL function behind it, and then looks at what the *local* teacher app shows with a real staff session.

    python frontend/dev-server.py 8123        # in another terminal
    SUPABASE_TEST_EMAIL='testguru211l@gmail.com' python frontend/tests/live_duplicates_check.py

Signing in needs no password when SUPABASE_ACCESS_TOKEN (a Supabase Management token) is set: the
check asks the Auth admin API for a one-time login link for that account and exchanges it for a
session itself. Set SUPABASE_TEST_PASSWORD as well and it uses the password instead. The account must
have a `profiles` row (role `teacher` or `admin`) — the staff gate is checked.

What it proves, in order:
  1. the staff test account signs in and the staff gate calls it a teacher (or an admin);
  2. the deployed `question-bank` answers `duplicate_groups`, and refuses a tokenless call (401);
  3. the SQL function asked directly, as the database, reports the same number of questions — the Edge
     layer is not inventing or reshaping anything;
  4. the list screen shows the banner with exactly that count (and no banner when there is nothing to
     review), asking for the whole-bank scan once per visit and not on every filter change;
  5. Review lists the same groups the server sent, every question linked to its own editor.

Pass `--keep` for nothing at all: this check never creates anything.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
BASE = "http://127.0.0.1:8123/teacher/index.html"
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(text or "null")
        except ValueError:
            return err.code, text


def call(name, body, token=None, key=KEY):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return http("POST", f"{URL}/functions/v1/{name}", body, {**headers, "apikey": key})


def mgmt(path, body=None, method="GET"):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/{path}",
                                data=json.dumps(body).encode() if body is not None else None, method=method,
                                headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as res:
        return json.loads(res.read().decode() or "null")


def service_key():
    return next(k["api_key"] for k in mgmt("api-keys") if k["name"] == "service_role")


def sign_in():
    """A real session for the staff test account: the password when given, otherwise a one-time link."""
    if PASSWORD:
        return http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PASSWORD})
    service = service_key()
    status, link = http("POST", f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": EMAIL},
                        {"Authorization": f"Bearer {service}", "apikey": service})
    if status != 200:
        return status, link
    return http("POST", f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": link["hashed_token"]})


def ids_of(groups):
    out = []
    for g in list(groups.get("exact_groups") or []) + list(groups.get("similar_pairs") or []):
        out += [q["id"] for q in g["questions"]]
    return sorted(set(out))


def banner_text(count):
    return "1 question looks like a duplicate of another." if count == 1 else f"{count} questions look like duplicates of each other."


def main():
    if not PASSWORD and not ACCESS:
        print("set SUPABASE_TEST_PASSWORD, or SUPABASE_ACCESS_TOKEN so a one-time login link can be minted")
        return 1

    # ---------- 1. a real staff session ----------
    status, data = sign_in()
    check("the staff test account can sign in", status == 200 and data.get("user", {}).get("email") == EMAIL,
          f"{status} {json.dumps(data)[:200]}")
    if status != 200:
        return 1
    token = data["access_token"]
    session = {"accessToken": token, "refreshToken": data.get("refresh_token", ""),
               "expiresAt": data.get("expires_at") or int(time.time()) + 3600, "user": {"email": EMAIL}}

    status, me = http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {token}"})
    me = me if isinstance(me, dict) else {}
    role = (me.get("user") or {}).get("role")
    check("the staff gate accepts it as a teacher or an admin", status == 200 and role in ("teacher", "admin"),
          f"{status} {json.dumps(me)[:200]}")
    print(f"signed in as {EMAIL} ({role})")

    # ---------- 2./3. the deployed function and the SQL function must agree ----------
    status, groups = call("question-bank", {"action": "duplicate_groups"}, token)
    check("the deployed question-bank answers duplicate_groups", status == 200 and "question_count" in groups,
          f"{status} {json.dumps(groups)[:300]}")
    if status != 200:
        return 1
    status, _ = call("question-bank", {"action": "duplicate_groups"})
    check("a tokenless call is refused", status == 401, str(status))
    count = groups["question_count"]
    print(f"the live bank reports {count} questions that look duplicated "
          f"({len(groups.get('exact_groups') or [])} exact groups, {len(groups.get('similar_pairs') or [])} similar pairs)")

    if ACCESS:
        direct = mgmt("database/query", {"query": "select public.find_duplicate_groups() as g"}, "POST")[0]["g"]
        check("the SQL function asked directly reports the same number of questions",
              direct["question_count"] == count, f"{direct['question_count']} vs {count}")

    # ---------- 4./5. the screen a teacher would look at ----------
    errors, scans, list_calls = [], [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        page.on("request", lambda r: scans.append(r.post_data or "") if "/functions/v1/question-bank" in r.url and "duplicate_groups" in (r.post_data or "") else None)
        page.on("request", lambda r: list_calls.append(r.post_data or "") if "/functions/v1/question-bank" in r.url and '"action":"list"' in (r.post_data or "") else None)

        page.goto(BASE)
        page.evaluate("s => sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', s)", json.dumps(session))
        page.goto(BASE + "#/questions")
        page.reload()
        page.wait_for_selector(".qtable tbody tr", timeout=30000)
        check("the question bank loads for a real staff session", page.query_selector("tr") is not None)

        if count == 0:
            page.wait_for_function("document.querySelector('.banner').hidden === true")
            check("with nothing to review the banner stays hidden", page.query_selector(".banner:not([hidden])") is None)
        else:
            page.wait_for_selector(".banner:not([hidden])", timeout=30000)
            check("the banner shows exactly the number the server reported",
                  page.inner_text(".banner .row").strip() == banner_text(count),
                  f"{page.inner_text('.banner .row').strip()!r} vs {banner_text(count)!r}")
            scans_before = len(scans)
            check("the screen asks the server for the whole-bank scan", scans_before >= 1, f"{scans_before} scans")
            page.select_option("#qb-difficulty", "easy"); page.wait_for_timeout(800)
            page.select_option("#qb-difficulty", ""); page.wait_for_timeout(800)
            check("filtering the list does not run the scan again", len(list_calls) > 1 and len(scans) == scans_before,
                  f"{len(scans)} scans, {len(list_calls)} list calls")

            page.click(".banner button")
            page.wait_for_selector("dialog.dup-dialog[open]", timeout=15000)
            text = page.inner_text("dialog.dup-dialog")
            sections = page.query_selector_all("dialog.dup-dialog .dup-group")
            expected = list(groups.get("exact_groups") or []) + list(groups.get("similar_pairs") or [])
            check("Review lists every group the server sent", len(sections) == len(expected), f"{len(sections)} vs {len(expected)}")
            links = sorted((a.get_attribute("href") or "").rsplit("/", 1)[-1] for a in page.query_selector_all("dialog.dup-dialog a"))
            check("every question in it links to its own editor", links == ids_of(groups), f"{links[:3]} vs {ids_of(groups)[:3]}")
            percents = [f"{round(p['similarity'] * 100)}% alike" for p in (groups.get("similar_pairs") or [])]
            check("the pairs show the similarity the server computed",
                  all(p in text for p in percents) and all(f"Same text ({len(g['questions'])} questions)" in text for g in (groups.get("exact_groups") or [])),
                  text[:200])
            items = page.query_selector_all("dialog.dup-dialog .dup-group li")
            check("the review names how often each question is used",
                  len(items) == len(ids_of(groups)) and all(i.query_selector(".hint") is not None
                                                            and ("used in" in i.inner_text() or "not used yet" in i.inner_text()) for i in items),
                  f"{len(items)} items vs {len(ids_of(groups))} questions")
            page.keyboard.press("Escape")
            page.wait_for_function("document.querySelector('dialog') === null")
            check("escape closes the review without leaving it on the screen", page.query_selector(".banner:not([hidden])") is not None)

        check("no page errors", errors == [], "; ".join(errors[:3]))
        browser.close()

    failed = [n for n, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE DUPLICATE-BANNER CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
