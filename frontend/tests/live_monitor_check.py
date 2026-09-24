"""LIVE verification of the monitor payload against the v2 project (TASK-013 / TASK-022).

Not part of CI: it talks to the real backend with the owner's admin account. The credentials are read
from the environment and are never stored here. Run it by hand:

    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' python frontend/tests/live_monitor_check.py

The mocked browser suite (`monitor_e2e.py`) proves the *screens* work. This script proves the other
half: that the payload the shipped screens read from the real database actually carries what they
render. Four students join one exam with **non-default** tab limits, and the script then applies the
exact same status rule `liveStatusPill` uses, checks the progress/clock/heartbeat fields, gives the
whole exam five more minutes, and confirms the finished attempt was left alone.

Everything it creates is printed at the end; remove it with:

    npx supabase db query --linked --file frontend/tests/cleanup_live_monitor.sql
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
CODE = "MON001"
# Deliberately not the built-in defaults (1 / 3 / 5): the monitor must read the exam's own limits.
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
    """Logs `times` departures from the page, the way the student page does on visibilitychange."""
    last = None
    for _ in range(times):
        last = call("session", {"action": "event", "token": token, "event_type": "tab_hidden",
                                "meta": {"away_seconds": 12}}, token)[1]
    return last


def row_of(overview, name):
    return next((r for r in overview["rows"] if r["student_name"] == name), None)


def age_seconds(iso_ts):
    """Seconds since a timestamp the database sent (it always answers in UTC, per the API)."""
    ts = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds()


def live_pill(row):
    """The same rule as liveStatusPill() in components/resultBits.js, applied to the live payload."""
    if row.get("has_result") or row["status"] not in ("in_progress", "reopened"):
        return "finished"
    warn_limit = row.get("tab_switch_warn_limit") or 1
    flag_limit = row.get("tab_switch_flag_limit") or 3
    heartbeat = row.get("last_heartbeat_at")
    if heartbeat and age_seconds(heartbeat) > 90:
        return "Offline"
    exits = row.get("tab_switch_count") or 0
    if exits >= flag_limit:
        return "Need a look"
    if exits >= warn_limit:
        return "Left the page"
    return "Saved"


def main():
    if not EMAIL or not PASSWORD:
        print("set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD in the environment first")
        return 1
    status, data = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PASSWORD})
    if status != 200:
        print(f"sign-in failed: {status} {data}")
        return 1
    staff = data["access_token"]

    # ---------- one open exam with two questions from the live bank and its own tab limits ----------
    _, bank = call("question-bank", {"action": "list", "page_size": 100}, staff)
    mc_ids = [i["id"] for i in bank["items"] if i["type"] == "multiple_choice"][:2]
    check("the live bank has two questions to build the test from", len(mc_ids) == 2, str(len(mc_ids)))
    if len(mc_ids) != 2:
        return 1
    _, saved = call("exams", {"action": "save", "title": "Monitor live check (safe to delete)",
                              "duration_minutes": 30, "passing_grade": 70, "availability_mode": "manual",
                              "access_code": CODE, "selection_mode": "manual",
                              "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                              "tab_switch_warn_limit": WARN, "tab_switch_flag_limit": FLAG,
                              "tab_switch_autosubmit_limit": 6,
                              "questions": [{"question_id": q, "weight": 1} for q in mc_ids]}, staff)
    exam_id = saved.get("id")
    check("the check can create its exam", bool(exam_id), str(saved))
    if not exam_id:
        return 1
    _, opened = call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, staff)
    check("the exam is open", opened == {"ok": True}, str(opened))

    _, mc = call("question-bank", {"action": "get", "id": mc_ids[0]}, staff)
    right = next(o["body"] for o in mc["question"]["options"] if o["is_correct"])

    # ---------- four students, one behaviour each ----------
    a = join(CODE, "Live Monitor A", "XII TKJ Z", staff)
    call("session", {"action": "save", "token": a["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, a["token"])

    b = join(CODE, "Live Monitor B", "XII TKJ Z", staff)
    call("session", {"action": "save", "token": b["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, b["token"])
    seen_b = leave_page(b["token"], WARN)
    check("the warning-limit number of departures is counted",
          seen_b and seen_b.get("tab_switch_count") == WARN, str(seen_b))

    c = join(CODE, "Live Monitor C", "XII TKJ Z", staff)
    seen_c = leave_page(c["token"], FLAG)
    check("the flag-limit number of departures is counted",
          seen_c and seen_c.get("tab_switch_count") == FLAG, str(seen_c))

    d = join(CODE, "Live Monitor D", "XII TKJ Y", staff)
    call("session", {"action": "save", "token": d["token"],
                     "answers": [{"question_id": mc_ids[0], "answer": {"text": right}}]}, d["token"])
    _, sent = call("session", {"action": "submit", "token": d["token"], "reason": "student"}, d["token"])
    check("the fourth student sends hers in", sent.get("submitted") is True, str(sent)[:200])

    # ---------- what the shipped monitor screen draws from ----------
    _, live = call("results", {"action": "overview", "exam_id": exam_id}, staff)
    overview = live.get("overview")
    check("the monitor payload answers with exam, summary and rows",
          isinstance(overview, dict) and {"exam", "summary", "rows"} <= set(overview or {}), str(live)[:200])
    if not overview:
        return 1
    exam = overview["exam"]
    check("the board carries the code students typed", exam["access_code"] == CODE, str(exam))
    check("the board carries the exam status the teacher set", exam["status"] == "open", str(exam))
    check("the board carries the duration", exam["duration_minutes"] == 30, str(exam))
    check("every attempt of this exam has a row", len(overview["rows"]) == 4, str(len(overview["rows"])))

    ra, rb, rc, rd = (row_of(overview, f"Live Monitor {x}") for x in "ABCD")
    check("all four students are on the board", all([ra, rb, rc, rd]),
          str([r["student_name"] for r in overview["rows"]]))
    if not all([ra, rb, rc, rd]):
        return 1

    # the drift this check exists for: the pill reads the exam's own limits out of the payload
    check("the row carries the exam's own warning limit", ra.get("tab_switch_warn_limit") == WARN, str(ra))
    check("the row carries the exam's own flag limit", ra.get("tab_switch_flag_limit") == FLAG, str(ra))

    check("a quiet phone reads as saved", live_pill(ra) == "Saved", live_pill(ra))
    check("a working attempt is running with time left",
          ra["status"] in ("in_progress", "reopened") and 0 < ra["remaining_seconds"] <= 1800,
          str(ra["remaining_seconds"]))
    check("the progress shows one of two answered",
          ra["answered_count"] == 1 and ra["question_count"] == 2,
          f"{ra['answered_count']}/{ra['question_count']}")
    check("a fresh session carries a heartbeat the screen can age",
          bool(ra.get("last_heartbeat_at")), str(ra.get("last_heartbeat_at")))

    check(f"{WARN} exits read as leaving the page", live_pill(rb) == "Left the page", live_pill(rb))
    check("that row carries the exit count", rb["tab_switch_count"] == WARN, str(rb["tab_switch_count"]))
    check(f"{FLAG} exits read as needing a look", live_pill(rc) == "Need a look", live_pill(rc))
    check("a student who answered nothing shows no progress",
          rc["answered_count"] == 0 and rc["question_count"] == 2,
          f"{rc['answered_count']}/{rc['question_count']}")
    check("a sent-in attempt reads as finished", live_pill(rd) == "finished", live_pill(rd))
    check("a finished attempt has a result and no clock running",
          rd["has_result"] is True and rd["remaining_seconds"] is None, str(rd)[:200])

    s = overview["summary"]
    check("the summary counts who is still working", s["in_progress"] == 3, str(s))
    check("the summary counts who finished", s["with_result"] == 1, str(s))

    # ---------- five more minutes for the whole exam ----------
    _, added = call("results", {"action": "add_exam_time", "exam_id": exam_id, "minutes": 5}, staff)
    check("time is added for everyone still working", added.get("added", {}).get("updated") == 3, str(added))
    check("the answer reports the seconds added",
          added.get("added", {}).get("added_seconds") == 300, str(added))

    _, again = call("results", {"action": "overview", "exam_id": exam_id}, staff)
    after = again["overview"]
    ra2, rb2, rc2, rd2 = (row_of(after, f"Live Monitor {x}") for x in "ABCD")
    check("the quiet student's clock moved five minutes",
          ra2["remaining_seconds"] - ra["remaining_seconds"] >= 290,
          f"{ra['remaining_seconds']} -> {ra2['remaining_seconds']}")
    check("the exit counter still reads the same", rb2["tab_switch_count"] == WARN, str(rb2["tab_switch_count"]))
    check("the finished attempt is still finished with no clock",
          live_pill(rd2) == "finished" and rd2["remaining_seconds"] is None, str(rd2)[:120])

    # every working attempt got it, and the finished one did not (read from the attempt's own report)
    extras = {}
    for label, row in (("A", ra2), ("B", rb2), ("C", rc2), ("D", rd2)):
        _, rep = call("results", {"action": "report", "session_id": row["session_id"]}, staff)
        extras[label] = rep["report"]["session"]["extra_seconds"]
    check("every working attempt holds the five minutes",
          extras["A"] == 300 and extras["B"] == 300 and extras["C"] == 300, str(extras))
    check("the finished attempt was not touched", extras["D"] == 0, str(extras))
    check("the extra time is written into the attempt history",
          call("results", {"action": "report", "session_id": ra["session_id"]}, staff)[1]
          ["report"]["event_counts"].get("time_added") == 1,
          "no time_added event on the attempt")

    # ---------- the refusals ----------
    _, too_short = call("results", {"action": "add_exam_time", "exam_id": exam_id, "minutes": 0}, staff)
    check("a fraction of a minute is refused", isinstance(too_short, dict) and "error" in too_short, str(too_short))
    _, unknown = call("results", {"action": "overview",
                                 "exam_id": "00000000-0000-4000-8000-0000000000ff"}, staff)
    check("an unknown exam is refused with a friendly message",
          isinstance(unknown, dict) and "not found" in str(unknown.get("error", "")).lower(), str(unknown))
    status, _ = call("results", {"action": "overview", "exam_id": exam_id}, "not-a-token")
    check("the monitor refuses a stranger", status == 401, str(status))

    # with everybody collected there is nobody to give time to
    for token in (a["token"], b["token"], c["token"]):
        call("session", {"action": "submit", "token": token, "reason": "teacher"}, token)
    _, nobody = call("results", {"action": "add_exam_time", "exam_id": exam_id, "minutes": 5}, staff)
    check("an exam with nobody working is refused with a friendly message",
          isinstance(nobody, dict) and "no one to give time to" in str(nobody.get("error", "")), str(nobody))

    print()
    print("ids to clean up:")
    print(json.dumps({"exam_id": exam_id, "code": CODE,
                      "sessions": [x["session"]["id"] for x in (a, b, c, d)]}))
    failed = [n for n, ok, _ in checks if not ok]
    print("ALL LIVE MONITOR CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
