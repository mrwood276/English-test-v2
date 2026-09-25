"""LIVE check of ISSUE-023: what happens when an exam that already has attempts is deleted.

Not part of CI. `remove_exam` used to close an exam silently while the screen had just promised it
"will be removed", so a teacher could click Delete, get the exam back, and click again (the owner did
that five times on 2026-09-25). The rule now is explicit: a teacher only ever closes such an exam, and
only the admin may ask for a permanent delete that takes the attempts with it.

    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' \\
    SUPABASE_ADMIN_EMAIL='...' SUPABASE_ADMIN_PASSWORD='...' \\
    [SUPABASE_ACCESS_TOKEN='...'] python frontend/tests/live_exam_delete_check.py

It builds one throwaway exam through the real API, lets one student join it, then walks the whole rule:
the attempt count the list reports, the teacher's 403 on a permanent delete, the teacher's close-instead-
of-delete, the admin's permanent delete, and that the exam with its attempts is really gone from every
table. Everything it creates is removed again (the permanent delete is the cleanup; a leftover exam is
swept up at the end if an earlier step failed).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
TEACHER_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "")
TEACHER_PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
ADMIN_EMAIL = os.environ.get("SUPABASE_ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("SUPABASE_ADMIN_PASSWORD", "")
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
CODE = "DELCHK"
TITLE = "Delete-rule live check (safe to delete)"
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


def call(name, body, token=None):
    return http("POST", f"{URL}/functions/v1/{name}", body, {"Authorization": f"Bearer {token}"} if token else {})


def sql(query):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
                                 data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as res:
        return json.loads(res.read().decode() or "null")


def sign_in(email, password, label):
    status, data = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": email, "password": password})
    check(f"the {label} signs in", status == 200, f"{status} {json.dumps(data)[:160]}")
    return data.get("access_token") if status == 200 else None


def me(token):
    return http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {token}"})[1]


def main():
    if not TEACHER_EMAIL or not TEACHER_PASSWORD or not ADMIN_EMAIL or not ADMIN_PASSWORD:
        print("set SUPABASE_TEST_EMAIL/PASSWORD (teacher) and SUPABASE_ADMIN_EMAIL/PASSWORD in the environment first")
        return 1
    if not ACCESS:
        print("note: SUPABASE_ACCESS_TOKEN is not set — the database checks and the sweep-up are skipped\n")

    teacher = sign_in(TEACHER_EMAIL, TEACHER_PASSWORD, "teacher")
    admin = sign_in(ADMIN_EMAIL, ADMIN_PASSWORD, "admin")
    if not teacher or not admin:
        return 1
    check("the two accounts really have the two roles",
          (me(teacher) or {}).get("user", {}).get("role") == "teacher"
          and (me(admin) or {}).get("user", {}).get("role") == "admin",
          f"{json.dumps(me(teacher))[:120]} | {json.dumps(me(admin))[:120]}")

    exam_id = session_id = None
    # rate_limits rows are bucketed by the minute, so look back a little further than "now"
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 300))
    try:
        # ---------- one throwaway exam with one real attempt ----------
        status, available = call("exams", {"action": "check_code", "code": CODE}, admin)
        check(f"the test code {CODE} is free", status == 200 and available.get("available") is True, json.dumps(available))
        _, bank = call("question-bank", {"action": "list", "page_size": 100}, admin)
        mc = [i["id"] for i in bank["items"] if i["type"] == "multiple_choice"][:2]
        _, saved = call("exams", {"action": "save", "title": TITLE, "duration_minutes": 30, "passing_grade": 70,
                                  "availability_mode": "manual", "access_code": CODE, "selection_mode": "manual",
                                  "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                                  "questions": [{"question_id": q, "weight": 1} for q in mc]}, admin)
        exam_id = saved.get("id")
        check("the throwaway exam is created", bool(exam_id), json.dumps(saved)[:200])
        call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, admin)
        _, joined = call("session", {"action": "join", "code": CODE, "name": "Live Delete Check", "class": "XII TKJ Z"}, admin)
        session_id = (joined.get("session") or {}).get("id")
        check("one student joins it, so it has an attempt", bool(session_id), json.dumps(joined)[:200])

        before = None
        if ACCESS:
            before = sql(f"""select (select count(*)::int from public.exam_sessions where exam_id = '{exam_id}') as sessions,
                                    (select count(*)::int from public.session_answers a join public.exam_sessions s on s.id = a.session_id
                                       where s.exam_id = '{exam_id}') as answers,
                                    (select count(*)::int from public.session_events e join public.exam_sessions s on s.id = e.session_id
                                       where s.exam_id = '{exam_id}') as events""")[0]
            check("the attempt really is in the database", before["sessions"] == 1, json.dumps(before))

        # ---------- what the screen is told: the attempt count comes back with the list ----------
        _, listed = call("exams", {"action": "list", "q": TITLE}, admin)
        row = next((e for e in listed["exams"] if e["id"] == exam_id), {})
        check("the exam list reports how many attempts it has", row.get("session_count") == 1, json.dumps(row)[:220])

        # ---------- a teacher may not delete it, only close it ----------
        status, refused = call("exams", {"action": "remove", "id": exam_id, "hard": True}, teacher)
        check("a teacher asking for a permanent delete is refused", status == 403, f"{status} {json.dumps(refused)[:160]}")
        _, still = call("exams", {"action": "get", "id": exam_id}, admin)
        check("the exam is untouched after the refusal", (still.get("exam") or {}).get("id") == exam_id, json.dumps(still)[:160])

        status, closed = call("exams", {"action": "remove", "id": exam_id}, teacher)
        check("a teacher's delete closes the exam instead", status == 200 and closed.get("result") == "closed",
              f"{status} {json.dumps(closed)[:160]}")
        _, after_close = call("exams", {"action": "get", "id": exam_id}, admin)
        exam_now = after_close.get("exam") or {}
        check("closing kept the exam and its attempt",
              exam_now.get("id") == exam_id and exam_now.get("status") == "closed", json.dumps(exam_now)[:200])

        # ---------- the admin may really delete it ----------
        status, deleted = call("exams", {"action": "remove", "id": exam_id, "hard": True}, admin)
        check("the admin's permanent delete answers 'deleted'",
              status == 200 and deleted.get("result") == "deleted", f"{status} {json.dumps(deleted)[:160]}")
        _, gone = call("exams", {"action": "get", "id": exam_id}, admin)
        check("the exam is gone from the API", gone.get("code") == "not_found", json.dumps(gone)[:160])

        if ACCESS:
            left = sql(f"""select (select count(*)::int from public.exams where id = '{exam_id}') as exams,
                                  (select count(*)::int from public.exam_sessions where id = '{session_id}') as sessions,
                                  (select count(*)::int from public.session_answers where session_id = '{session_id}') as answers,
                                  (select count(*)::int from public.session_events where session_id = '{session_id}') as events,
                                  (select count(*)::int from public.exam_results where session_id = '{session_id}') as results""")[0]
            check("the exam and its attempt are gone from every table", all(v == 0 for v in left.values()), json.dumps(left))
            audit = sql(f"select action, changes from public.audit_logs where entity_id = '{exam_id}' order by created_at")
            actions = [a["action"] for a in audit]
            check("the audit trail records the close and the permanent delete",
                  "exam.close" in actions and "exam.delete" in actions
                  and any(a["changes"].get("permanent") for a in audit),
                  json.dumps(audit)[:300])
        status, _ = http("POST", f"{URL}/functions/v1/exams", {"action": "remove", "id": exam_id})
        check("a tokenless delete is refused", status == 401, str(status))
    finally:
        if ACCESS:
            # The permanent delete is the cleanup; this only sweeps up if an earlier step stopped the run.
            leftover = sql(f"select count(*)::int as n from public.exams where id = '{exam_id}'")[0]["n"] if exam_id else 0
            if leftover:
                print("\ncleanup: the run stopped early, removing the exam it created")
                call("exams", {"action": "remove", "id": exam_id, "hard": True}, admin)
                sql(f"delete from public.exam_sessions where exam_id = '{exam_id}'")
                sql(f"delete from public.exams where id = '{exam_id}'")
                print("leftover exam rows:", json.dumps(sql(f"select count(*)::int as n from public.exams where id = '{exam_id}'")))
            sql(f"delete from public.rate_limits where window_start >= '{started}'")
            print("live rate-limit rows after this run:",
                  json.dumps(sql("select count(*)::int as n from public.rate_limits")))

    print()
    failed = [n for n, ok, _ in checks if not ok]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE DELETE-RULE CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
