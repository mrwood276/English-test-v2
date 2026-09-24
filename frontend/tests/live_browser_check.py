"""LIVE browser run of the monitor screens against the real project (TASK-013 / TASK-022).

Not part of CI. This is the check the mocked suite cannot make: the *local* teacher app, served by
`frontend/dev-server.py`, talking to the real Supabase project with a real signed-in staff session,
while real students are really taking a test. It drives the same page the owner would open.

    python frontend/dev-server.py 8123        # in another terminal
    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' python frontend/tests/live_browser_check.py

It builds one exam through the API, makes four students join (one quiet, one over the page-leave
warning, one over the flag limit, one finished), then opens `#/monitor` and `#/monitor/<exam>` in
Chromium and checks what a teacher would see. Finally it gives the whole exam five more minutes through
the button itself and confirms the students' clocks moved.

Clean up afterwards with frontend/tests/cleanup_live_monitor.sql.
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
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
BASE = "http://127.0.0.1:8123/teacher/index.html"
CODE = "MON001"
WARN, FLAG = 2, 4
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            return res.status, json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode() or "null")


def call(name, body, token):
    return http("POST", f"{URL}/functions/v1/{name}", body, {"Authorization": f"Bearer {token}"})


def join(code, name, klass, staff):
    return call("session", {"action": "join", "code": code, "name": name, "class": klass}, staff)[1]


def leave_page(token, times):
    for _ in range(times):
        call("session", {"action": "event", "token": token, "event_type": "tab_hidden",
                         "meta": {"away_seconds": 12}}, token)


def main():
    if not EMAIL or not PASSWORD:
        print("set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD in the environment first")
        return 1
    status, data = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PASSWORD})
    if status != 200:
        print(f"sign-in failed: {status} {data}")
        return 1
    staff = data["access_token"]

    # ---------- the exam and the four students, through the real API ----------
    _, bank = call("question-bank", {"action": "list", "page_size": 100}, staff)
    mc_ids = [i["id"] for i in bank["items"] if i["type"] == "multiple_choice"][:2]
    if len(mc_ids) != 2:
        print("the live bank does not have two questions to build the test from")
        return 1
    _, saved = call("exams", {"action": "save", "title": "Monitor browser check (safe to delete)",
                              "duration_minutes": 30, "passing_grade": 70, "availability_mode": "manual",
                              "access_code": CODE, "selection_mode": "manual",
                              "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                              "tab_switch_warn_limit": WARN, "tab_switch_flag_limit": FLAG,
                              "tab_switch_autosubmit_limit": 6,
                              "questions": [{"question_id": q, "weight": 1} for q in mc_ids]}, staff)
    exam_id = saved.get("id")
    if not exam_id:
        print(f"could not create the exam: {saved}")
        return 1
    call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, staff)
    _, mc = call("question-bank", {"action": "get", "id": mc_ids[0]}, staff)
    right = next(o["body"] for o in mc["question"]["options"] if o["is_correct"])

    a = join(CODE, "Live Monitor A", "XII TKJ Z", staff)
    call("session", {"action": "save", "token": a["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, a["token"])
    b = join(CODE, "Live Monitor B", "XII TKJ Z", staff)
    call("session", {"action": "save", "token": b["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, b["token"])
    leave_page(b["token"], WARN)
    c = join(CODE, "Live Monitor C", "XII TKJ Z", staff)
    leave_page(c["token"], FLAG)
    d = join(CODE, "Live Monitor D", "XII TKJ Y", staff)
    call("session", {"action": "save", "token": d["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, d["token"])
    call("session", {"action": "submit", "token": d["token"], "reason": "student"}, d["token"])
    sid = {k: v["session"]["id"] for k, v in (("a", a), ("b", b), ("c", c), ("d", d))}
    print(f"exam {exam_id} with four live sessions is ready")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

        # the real app, the real backend: sign in by putting the token the API just gave us in the
        # same storage the sign-in screen uses
        page.goto(BASE)
        page.evaluate(
            "s => sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', s)",
            json.dumps({"accessToken": staff, "refreshToken": data.get("refresh_token", ""),
                        "expiresAt": data.get("expires_at") or int(time.time()) + 3600,
                        "user": {"email": EMAIL}}))
        page.goto(BASE + "#/monitor")
        page.reload()
        page.wait_for_selector(".qtable", timeout=30000)

        # ---------- the hub, from the real database ----------
        check("the signed-in app opens the Monitor hub", page.inner_text("h1") == "Monitor")
        page.wait_for_function(f"document.querySelector('tr[data-exam=\"{exam_id}\"]') !== null", timeout=20000)
        hub = page.query_selector(f"tr[data-exam='{exam_id}']")
        check("the running exam is on the hub with its code", CODE in hub.inner_text(), hub.inner_text())

        hub.query_selector("a:has-text('Watch')").click()
        page.wait_for_function(f"location.hash.includes('{exam_id}') && !location.hash.includes('session')")
        page.wait_for_selector(f"tr[data-session='{sid['a']}']", timeout=20000)

        # ---------- the per-exam live table, rendered from live rows ----------
        check("the exam title heads the board", "Monitor browser check" in page.inner_text("h1"), page.inner_text("h1"))
        table = page.inner_text(".qtable")
        check("all four live students are listed",
              all(f"Live Monitor {x}" in table for x in "ABCD"), table[:300])
        row_a = page.query_selector(f"tr[data-session='{sid['a']}']")
        row_b = page.query_selector(f"tr[data-session='{sid['b']}']")
        row_c = page.query_selector(f"tr[data-session='{sid['c']}']")
        row_d = page.query_selector(f"tr[data-session='{sid['d']}']")

        check("progress renders as a real fraction, not a dash",
          "1/2" in row_a.inner_text(), row_a.inner_text())
        check("the progress bar has a width",
          row_a.query_selector(".prog i") is not None
          and row_a.query_selector(".prog i").get_attribute("style") not in (None, "", "width:0%"),
          str(row_a.query_selector(".prog")))
        import re
        # the board writes durations the way fmtDuration does: "29m 44s", not a dash
        time_cell = re.findall(r"\d+m \d+s", row_a.inner_text()) or re.findall(r"\d+:\d\d", row_a.inner_text())
        check("a working student shows a real clock, not a dash", bool(time_cell), row_a.inner_text())
        check("a quiet phone reads as Saved", "Saved" in row_a.inner_text(), row_a.inner_text())
        check("a student over the warning limit reads as Left the page",
              "Left the page" in row_b.inner_text(), row_b.inner_text())
        check("a student over the flag limit reads as Need a look",
              "Need a look" in row_c.inner_text(), row_c.inner_text())
        check("the exit counts are shown", "2" in row_b.inner_text() and "4" in row_c.inner_text(),
              f"{row_b.inner_text()} | {row_c.inner_text()}")
        check("the finished attempt reads as done", "Done" in row_d.inner_text(), row_d.inner_text())

        # ---------- the whole-exam action through the button ----------
        before = {x: call("results", {"action": "report", "session_id": sid[x]}, staff)[1]
                  ["report"]["session"]["remaining_seconds"] for x in ("a", "b", "c")}
        page.click("[data-add-all]")
        page.wait_for_selector(".dialog")
        check("the button asks before giving a whole class time",
              "Add time to everyone" in page.inner_text(".dialog"), page.inner_text(".dialog"))
        page.select_option("#monitor-add-all", "5")
        page.click(".dialog button:has-text('Add time')")
        page.wait_for_function("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Time added for 3'))", timeout=20000)
        check("the toast names how many students got the time",
              any("Time added for 3" in t for t in page.eval_on_selector_all(".toast", "els => els.map(e => e.textContent)")))

        after = {x: call("results", {"action": "report", "session_id": sid[x]}, staff)[1]
                 ["report"]["session"]["remaining_seconds"] for x in ("a", "b", "c")}
        check("every working student's clock moved five minutes in the database",
              all(after[x] - before[x] >= 290 for x in ("a", "b", "c")),
              str({"before": before, "after": after}))
        _, rep_d = call("results", {"action": "report", "session_id": sid["d"]}, staff)
        check("the finished student was left alone",
              rep_d["report"]["session"]["extra_seconds"] == 0, str(rep_d["report"]["session"]["extra_seconds"]))

        # ---------- the board keeps itself current: its own 15-second timer, no manual reload ----------
        def time_left(session_id):
            return page.query_selector(f"tr[data-session='{session_id}'] td:nth-child(4)").inner_text().strip()

        t1 = time_left(sid["c"])
        page.wait_for_timeout(17_000)
        t2 = time_left(sid["c"])
        check("the board counts the time down on its own", t1 != t2, f"{t1!r} -> {t2!r}")
        check("the board still renders after the action",
              "Live Monitor A" in page.inner_text(".qtable"), page.inner_text(".qtable")[:200])

        check("no page errors", errors == [], "; ".join(errors[:3]))
        browser.close()

    print()
    print("ids to clean up:")
    print(json.dumps({"exam_id": exam_id, "code": CODE, "sessions": list(sid.values())}))
    failed = [n for n, ok, _ in checks if not ok]
    print("ALL LIVE BROWSER CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
