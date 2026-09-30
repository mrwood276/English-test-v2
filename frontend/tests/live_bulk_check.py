"""LIVE run of bulk question management (F-17, TASK-024).

Not part of CI. **This one writes**, so it is built to be harmless and to leave nothing behind:

* it creates **three throwaway questions** of its own (each body carries a unique `LIVE BULK CHECK <stamp>`
  marker) and deletes all three again at the end — through the same `question-bank` function a teacher uses;
* the owner's own questions are **never modified**: the only real question it reads is a *control* — fetched
  before and after the bulk calls, read-only, to prove a bulk change touches exactly the selected ids;
* it restores the counts it measured at the start (questions, archived questions) and says so;
* the only things it deliberately leaves behind are (a) the **audit history of its own acts** — that is the
  feature, an audit trail is not something a test should erase — and (b) two test topics in `public.topics`,
  which it deletes when a Management token is available (a topic has no delete UI); without a token those
  two rows stay, and the run says so.

    python frontend/dev-server.py 8123                       # in another terminal (needed for the screen part)
    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_bulk_check.py
    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_bulk_check.py --api-only   # skip the browser part

Signing in needs no password when `SUPABASE_ACCESS_TOKEN` (a Supabase Management token) is set: the check
asks the Auth admin API for a one-time login link and exchanges it for a session itself. Set
`SUPABASE_TEST_PASSWORD` as well and it uses the password instead. The account must have a `profiles` row
with role `teacher` or `admin`. With a token it also asks the **database** directly, so the Edge layer's
answer can be compared with the SQL function's.

What it proves, in order:

 1. the staff test account signs in, and the staff gate calls it a teacher or an admin;
 2. a tokenless `bulk_update` is 401, and every payload the screen could not produce is refused with a
    friendly 400 (nothing to change, an unknown difficulty, points out of range, an unknown label action,
    adding no label, more than 500 ids, a selection that no longer exists);
 3. three questions are created, and one bulk request changes their **topic, difficulty and points** —
    `matched 3 / updated 3 / unchanged 0 / missing 0` — while the control question is byte-for-byte the
    same afterwards;
 4. the same change again reports `updated 0 / unchanged 3`: a call that changes nothing is not allowed to
    claim work it did not do;
 5. the topic is matched case- and space-insensitively (one topic row, never a second);
 6. class labels **add** (keeping what is there), **remove** (taking exactly those) and **replace** (ending
    with exactly those), and adding a label a question already has is a no-op;
 7. an id that no longer exists is **counted** (`missing 1`), not fatal — and the questions that still exist
    are still changed;
 8. the real screen (the deployed function, a real staff session) filters the list to the three questions,
    ticks the page with the header checkbox, opens the bulk dialog, chooses a **new** topic, reads the
    preview, applies it, and the toast and the database both say the same thing;
 9. archive takes all three out of the default list and puts them in the archived list; restore brings them
    back;
10. one audit entry per act and **never one per question** (`question.bulk_update` with the real `count`,
    and no `question.update` rows pretending to be ours);
11. the three throwaway questions are deleted again and the live counts are back where they started.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, "frontend/tests")
import live_cleanup
from playwright.sync_api import sync_playwright

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
BASE = "http://127.0.0.1:8123/teacher/index.html"
MARKER = f"LIVE BULK CHECK {time.strftime('%Y%m%d-%H%M%S')}"
TOPIC_A = f"Live bulk {time.strftime('%H%M%S')}"
TOPIC_B = f"{TOPIC_A} browser"
LABEL_A = "LIVE CHECK A"
LABEL_B = "LIVE CHECK B"
BOGUS = "00000000-0000-4000-8000-000000000000"


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_harness

harness = live_harness.Run("live_bulk_check",
                           sweep="the LIVE BULK CHECK questions and their test topics - the next run"
                                 " sweeps them by marker")
harness.install()
check = harness.check


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


def sql(query):
    """One statement through the Management API (one request = one session), rows back."""
    return mgmt("database/query", {"query": query}, "POST")


def norm(t):
    """public.normalize_text: case and runs of whitespace do not count."""
    return " ".join(str(t or "").split()).lower()


def main(api_only=False):
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

    # A run that died mid-way must not block this one: its three questions and their two topics are this
    # check's own (ISSUE-043). The questions go through the same `remove` action the end of this check
    # uses, so their history is written the same way; a question the function will not remove is removed
    # by hand (children first, its audit rows kept — that history is the feature). The topics follow, once
    # nothing points at them.
    if ACCESS:
        stale = sql("select id from public.questions where body like 'LIVE BULK CHECK %'")
        for row in stale:
            status, body = call("question-bank", {"action": "remove", "id": row["id"]}, token)
            if (body or {}).get("result") != "deleted":
                live_cleanup.wipe_question(sql, row["id"], keep_audit=True)
        stale_topics = sql("delete from public.topics t where public.normalize_text(t.name) like 'live bulk %' "
                           "and not exists (select 1 from public.questions q where q.topic_id = t.id) returning t.name")
        if stale or stale_topics:
            check(f"an earlier run's leftovers ({len(stale)} questions, {len(stale_topics)} topics) "
                  f"were swept before this one started", True)

    calls = 0  # how many bulk_update calls reached the database, for the audit count at the end

    def bulk(ids, changes, expect_status=200, label=""):
        nonlocal calls
        status, body = call("question-bank", {"action": "bulk_update", "ids": ids, "changes": changes}, token)
        if status == 200:
            calls += 1
        if expect_status is not None:
            check(f"bulk_update {label or json.dumps(changes)}", status == expect_status,
                  f"{status} {json.dumps(body)[:200]}")
        return status, body

    def get(qid):
        status, body = call("question-bank", {"action": "get", "id": qid}, token)
        return status, (body or {}).get("question") if isinstance(body, dict) else None

    def listing(**filters):
        status, body = call("question-bank", {"action": "list", "page": 1, "page_size": 100, **filters}, token)
        return (body or {}).get("total") if status == 200 else None

    # ---------- 2. every refusal, before anything is written ----------
    status, body = call("question-bank", {"action": "bulk_update", "ids": [BOGUS], "changes": {"archived": True}})
    check("a tokenless bulk_update is refused", status == 401, f"{status} {json.dumps(body)[:120]}")
    _, body = bulk([BOGUS], {}, 400, "with nothing to change")
    check("the refusal explains itself", "at least one thing to change" in json.dumps(body), json.dumps(body)[:160])
    bulk([BOGUS], {"difficulty": "impossible"}, 400, "with an unknown difficulty")
    bulk([BOGUS], {"weight": 0}, 400, "with points of zero")
    bulk([BOGUS], {"weight": 101}, 400, "with points over the cap")
    bulk([BOGUS], {"class_labels": {"mode": "merge", "labels": [LABEL_B]}}, 400, "with an unknown label action")
    bulk([BOGUS], {"class_labels": {"mode": "add", "labels": []}}, 400, "adding no class label")
    status, body = bulk([str(uuid.uuid4()) for _ in range(501)], {"archived": True}, 400, "with more than 500 ids")
    check("the cap says how much is too much", "at most 500" in json.dumps(body), json.dumps(body)[:160])
    status, body = bulk([BOGUS], {"archived": True}, 400, "with a selection that no longer exists")
    check("a selection that matches nothing says so", "no longer exist" in json.dumps(body), json.dumps(body)[:160])

    # ---------- 3. the snapshot this run promises to restore ----------
    before = {"questions": None, "archived": None, "bulk_audits": None}
    if ACCESS:
        row = sql("select (select count(*) from public.questions) as questions, "
                  "(select count(*) from public.questions where is_archived) as archived, "
                  "(select count(*) from public.audit_logs where action = 'question.bulk_update') as bulk_audits")[0]
        before = {k: int(row[k]) for k in before}
        print(f"live before: {before['questions']} questions ({before['archived']} archived), "
              f"{before['bulk_audits']} question.bulk_update audit rows")

    # ---------- 4. three throwaway questions, through the real save path ----------
    created = []
    for i in (1, 2, 3):
        status, body = call("question-bank", {"action": "save", "type": "short_answer", "difficulty": "medium",
                                             "topic": "", "body": f"{MARKER} fixture {i}", "weight": 1,
                                             "accepted_answers": [f"alpha{i}"], "class_labels": [LABEL_A]}, token)
        created.append((body or {}).get("id") if status == 200 else None)
    check("three throwaway questions can be created", all(created) and len(set(created)) == 3,
          f"{status} {json.dumps(body)[:200]}")
    if not all(created):
        for i in [x for x in created if x]:  # do not leave a half-made fixture behind
            call("question-bank", {"action": "remove", "id": i}, token)
        return 1
    ids = created

    # A control: a real question that must not move.
    items = (call("question-bank", {"action": "list", "page": 1, "page_size": 100}, token)[1] or {}).get("items") or []
    control_id = next((q["id"] for q in items if q["id"] not in ids), None)
    control_before = get(control_id)[1] if control_id else None

    # ---------- 5. one act, three questions ----------
    status, result = bulk(ids, {"topic": TOPIC_A, "difficulty": "hots", "weight": 2.5}, 200, "on three questions")
    check("the reply counts what really happened",
          result == {"matched": 3, "updated": 3, "unchanged": 0, "missing": 0}, json.dumps(result))
    after = [get(i)[1] for i in ids]
    check("the topic really changed on all three", all(q and q["topic"] == TOPIC_A for q in after),
          ", ".join(str(q and q["topic"]) for q in after))
    check("the difficulty really changed on all three", all(q and q["difficulty"] == "hots" for q in after))
    check("the points really changed on all three", all(q and float(q["weight"]) == 2.5 for q in after))
    if control_before:
        now = get(control_id)[1]
        check("a question that was not selected is untouched",
              all(now[k] == control_before[k] for k in ("topic", "difficulty", "weight", "class_labels", "is_archived")),
              f"{json.dumps(control_before)[:120]} vs {json.dumps(now)[:120]}")

    # ---------- 6. the same change again claims no work ----------
    _, again = bulk(ids, {"topic": TOPIC_A, "difficulty": "hots", "weight": 2.5}, 200, "with the same values again")
    check("a repeated change reports nothing done", again == {"matched": 3, "updated": 0, "unchanged": 3, "missing": 0},
          json.dumps(again))

    # ---------- 7. the topic is matched, not re-created ----------
    bulk(ids, {"topic": f"  {TOPIC_A.upper()}  "}, 200, "with the topic in another case and spacing")
    _, topics = call("question-bank", {"action": "topics"}, token)
    same = [t for t in (topics or {}).get("topics", []) if norm(t["name"]) == norm(TOPIC_A)]
    check("one topic row, however it was typed", len(same) == 1, json.dumps(same))
    check("the topic knows how many questions use it", same and same[0]["question_count"] == 3, json.dumps(same))

    # ---------- 8. class labels: add, remove, replace ----------
    bulk(ids, {"class_labels": {"mode": "add", "labels": [LABEL_B]}}, 200, "adding a class label")
    labels = get(ids[0])[1]["class_labels"]
    check("adding a label keeps the ones already there", norm(LABEL_A) in [norm(x) for x in labels] and norm(LABEL_B) in [norm(x) for x in labels],
          json.dumps(labels))
    _, added_again = bulk(ids, {"class_labels": {"mode": "add", "labels": [f"  {LABEL_B.lower()} "]}}, 200,
                          "adding a label it already has")
    check("adding a label a question already has changes nothing", added_again["updated"] == 0, json.dumps(added_again))
    bulk(ids, {"class_labels": {"mode": "remove", "labels": [LABEL_B]}}, 200, "removing that label")
    labels = get(ids[0])[1]["class_labels"]
    check("removing takes exactly that one away", norm(LABEL_B) not in [norm(x) for x in labels] and norm(LABEL_A) in [norm(x) for x in labels],
          json.dumps(labels))
    bulk(ids, {"class_labels": {"mode": "replace", "labels": [LABEL_B]}}, 200, "replacing the labels")
    labels = get(ids[0])[1]["class_labels"]
    check("replacing leaves exactly the labels asked for", [norm(x) for x in labels] == [norm(LABEL_B)], json.dumps(labels))
    bulk(ids, {"class_labels": {"mode": "replace", "labels": [LABEL_A]}}, 200, "putting the first label back")

    # ---------- 9. an id that no longer exists is counted ----------
    _, partial = bulk([ids[0], BOGUS], {"weight": 1}, 200, "with one id that is gone")
    check("a missing id is reported, not fatal", partial == {"matched": 1, "updated": 1, "unchanged": 0, "missing": 1},
          json.dumps(partial))
    check("the question that still exists was still changed", float(get(ids[0])[1]["weight"]) == 1)
    check("the other two were not touched", float(get(ids[1])[1]["weight"]) == 2.5)
    bulk(ids, {"weight": 2.5}, 200, "putting the points back")

    # ---------- 10. the real screen, against the real project ----------
    errors = []
    screen_acts = 0  # successful bulk_update calls the screen made itself (not through bulk())
    if not api_only:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1440, "height": 950})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

            page.goto(BASE)
            page.evaluate("s => sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', s)", json.dumps(session))
            page.goto(BASE + "#/questions")
            page.reload()
            page.wait_for_selector(".qtable tbody tr", timeout=30000)
            check("the question bank loads for a real staff session", page.query_selector("tr") is not None)

            page.fill("#qb-search", MARKER)
            page.wait_for_function(f"document.querySelectorAll('.qtable tbody tr').length === 3", timeout=30000)
            check("filtering the list finds exactly the three questions", page.inner_text(".head .sub") == "3 questions match",
                  page.inner_text(".head .sub"))

            page.check("#qb-pick-all")
            page.wait_for_selector(".bulkbar:not([hidden])")
            check("the header box selects the whole page", "3 questions selected" in page.inner_text(".bulkbar"),
                  page.inner_text(".bulkbar"))

            page.click(".bulkbar button:has-text('Edit')")
            page.wait_for_selector("dialog.bulk-dialog[open]", timeout=15000)
            check("the dialog names how many questions it will change", "Edit 3 questions" in page.inner_text("dialog.bulk-dialog"))
            page.select_option("#bulk-topic", "__new")
            page.fill("#bulk-topic-new", TOPIC_B)
            page.click("dialog.bulk-dialog button:has-text('Preview changes')")
            preview = page.inner_text("dialog.bulk-dialog")
            check("the preview says what will happen before it happens",
                  "You selected 3 questions." in preview and "3 questions will be affected." in preview and TOPIC_B in preview,
                  preview[:250])
            page.click("dialog.bulk-dialog button:has-text('Apply changes')")
            page.wait_for_selector(".toast:has-text('3 questions updated')", timeout=30000)
            screen_acts += 1
            page.wait_for_function("document.querySelector('dialog.bulk-dialog') === null", timeout=15000)
            check("the screen reports what the server did and lets the selection go", page.is_hidden(".bulkbar"))
            moved = [get(i)[1] for i in ids]
            check("the browser's change really reached the database", all(q and q["topic"] == TOPIC_B for q in moved),
                  ", ".join(str(q and q["topic"]) for q in moved))
            check("the filtered list still shows the three of them", page.query_selector_all(".qtable tbody tr").__len__() == 3)
            check("no page errors", errors == [], "; ".join(errors[:3]))
            browser.close()

    # ---------- 11. archive and restore the whole selection ----------
    active_before = listing()
    archived_before = listing(archived=True)
    _, archived = bulk(ids, {"archived": True}, 200, "archiving three questions")
    check("archiving reports all three", archived["updated"] == 3 and archived["missing"] == 0, json.dumps(archived))
    check("they leave the default list", listing() == active_before - 3, f"{listing()} vs {active_before - 3}")
    check("and appear in the archived list", listing(archived=True) == archived_before + 3,
          f"{listing(archived=True)} vs {archived_before + 3}")
    _, restored = bulk(ids, {"archived": False}, 200, "restoring them")
    check("restoring brings them back", restored["updated"] == 3 and listing() == active_before, json.dumps(restored))
    check("and they leave the archived list again", listing(archived=True) == archived_before)

    # ---------- 12. the audit trail: one entry per act, never one per question ----------
    if ACCESS:
        row = sql("select count(*) as n from public.audit_logs where action = 'question.bulk_update'")[0]
        # Every successful act is audited exactly once: the calls this file made through bulk(), plus the
        # one the screen made itself when its Apply button was used.
        check("every successful act wrote exactly one audit entry",
              int(row["n"]) - before["bulk_audits"] == calls + screen_acts,
              f"{int(row['n']) - before['bulk_audits']} new rows for {calls} + {screen_acts} acts")
        entry = sql("select changes from public.audit_logs where action = 'question.bulk_update' "
                    "order by created_at desc limit 1")[0]["changes"]
        check("the newest entry names the change that was just made",
              (entry.get("changes") or {}).get("archived") is False and entry.get("selected") == 3,
              json.dumps(entry)[:200])
        check("it records how many questions really changed", (entry.get("count") or 0) >= 1, json.dumps(entry)[:160])
        ids_lit = ",".join(f"'{i}'" for i in ids)
        row = sql(f"select count(*) as n from public.audit_logs where action = 'question.update' and entity_id in ({ids_lit})")[0]
        check("a bulk change does not pretend to be three single-question updates", int(row["n"]) == 0, str(row["n"]))

    # ---------- 13. put it all back ----------
    results = []
    for i in ids:
        status, body = call("question-bank", {"action": "remove", "id": i}, token)
        results.append((body or {}).get("result") if status == 200 else f"HTTP {status}")
    check("all three throwaway questions are deleted again", results == ["deleted"] * 3, json.dumps(results))
    check("and they are really gone", all(get(i)[0] == 404 for i in ids))
    if control_before:
        check("the control question is still exactly where it was",
              all(get(control_id)[1][k] == control_before[k] for k in ("topic", "difficulty", "weight", "class_labels")))
    if ACCESS:
        row = sql("select (select count(*) from public.questions) as questions, "
                  "(select count(*) from public.questions where is_archived) as archived")[0]
        check("the live bank is back where it started",
              int(row["questions"]) == before["questions"] and int(row["archived"]) == before["archived"],
              f"{row} vs {before}")
        removed = sql(f"delete from public.topics t where public.normalize_text(t.name) in "
                      f"('{norm(TOPIC_A)}', '{norm(TOPIC_B)}') "
                      f"and not exists (select 1 from public.questions q where q.topic_id = t.id) returning t.name")
        check("the two test topics are gone too", len(removed) == 2, json.dumps(removed))
    else:
        print(f"note: no Management token, so the two test topics ({TOPIC_A!r}, {TOPIC_B!r}) stay in "
              f"public.topics, and the database's own counts could not be compared")
    print(f"note: {calls + screen_acts} question.bulk_update audit rows remain — that history is the feature, not litter")

    print(f"\n{harness.passed}/{harness.total} checks passed")
    return harness.finish("ALL LIVE BULK CHECKS PASSED")


if __name__ == "__main__":
    try:
        sys.exit(main(api_only="--api-only" in sys.argv))
    except urllib.error.HTTPError as err:  # a wrong or expired Management token, said plainly
        print(f"the Supabase Management API refused that token: HTTP {err.code} {err.reason}")
        print("use a current SUPABASE_ACCESS_TOKEN (or SUPABASE_TEST_PASSWORD instead)")
        sys.exit(1)
