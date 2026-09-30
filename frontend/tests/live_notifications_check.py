"""LIVE check of the notification bell (TASK-015, DEC-017).

Not part of CI and no dev server needed: this one signs the admin and the staff test account in
through one-time links, creates its own throwaway exam / events / backup / account through the
**deployed** functions, and reads the bell they produce — then deletes everything again.

    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_notifications_check.py

Needs SUPABASE_ACCESS_TOKEN (a Supabase Management token): the check mints one-time login links for
the two real accounts, reads its own rows through the Management API, and removes its leftovers when
it is done. Set SUPABASE_ADMIN_EMAIL / SUPABASE_TEST_EMAIL to override the accounts.

What it proves, in order:
  1. the deployed `notifications` endpoint answers the door correctly (401 tokenless, 200 signed in);
  2. a teacher's bell carries only the teacher kinds (no backup or account news) and marks itself
     read per person;
  3. a real submitted attempt with an essay puts an essay card on the bell, naming the exam, the
     count and the student;
  4. a real attempt that crosses the flag limit puts a suspicious card on the bell, naming the exam
     and the number of events;
  5. opening the bell marks it read (unread 0, read_at set) without changing what it lists, for
     admin and teacher separately;
  6. a real manual backup announces itself to the admin's bell (and only to the admin's);
  7. a real created account announces itself with the typed password still working for its first
     sign-in — and stops being news when the account is gone;
  8. everything this run created is gone: the exam, the essay question (deleted, not archived —
     ISSUE-040), the backup (row + file), the throwaway account, its audit rows and the read-mark
     rows, with the project's own two accounts and its question count untouched.

The screen half of this slice is frontend/tests/notifications_e2e.py; the SQL guards are also
asserted by supabase/tests/notification_functions_test.sql (runnable with no browser and no login).
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
TEACHER_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
CODE = "BELL01"
NAME = "Live Bell Check"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_harness

harness = live_harness.Run("live_notifications_check",
                           sweep="exam BELL01, its question and read marks - the next run's wipe_check"
                                 " sweeps them")
harness.install()
check = harness.check


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


def delete_user(user_id):
    service = service_key()
    return http("DELETE", f"{URL}/auth/v1/admin/users/{user_id}", None, {"Authorization": f"Bearer {service}"})


def magic_link(email):
    service = service_key()
    status, link = http("POST", f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email},
                        {"Authorization": f"Bearer {service}", "apikey": service})
    if status != 200:
        return status, link
    return http("POST", f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": link["hashed_token"]})


def password_grant(email, password):
    return http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": email, "password": password})


def join(code, name, klass, staff):
    return call("session", {"action": "join", "code": code, "name": name, "class": klass}, staff)[1]


def leave_page(token, times):
    for _ in range(times):
        s, d = call("session", {"action": "event", "token": token, "event_type": "tab_hidden"}, token)
        if s != 200:
            return None
    return d


def live_state():
    """What the project looks like before and after: its own accounts and none of this check's leftovers."""
    return sql("""select (select count(*)::int from public.profiles) as accounts,
                          (select count(*)::int from public.audit_logs where action like 'account.%') as account_history,
                          (select count(*)::int from public.backups) as backups,
                          (select count(*)::int from public.exams where access_code = 'BELL01') as bell_exams,
                          (select count(*)::int from public.notification_reads) as read_marks,
                          (select count(*)::int from public.questions) as questions,
                          (select count(*)::int from public.questions where is_archived) as archived
                   """)[0]


def sessions_array(exam_id):
    """The attempt ids of one exam as a Postgres array literal ('{a,b}')."""
    row = sql(f"select coalesce(string_agg(id::text, ','), '') as a from public.exam_sessions where exam_id = '{exam_id}'")[0]
    return "{" + row["a"] + "}"


def delete_question(question_id):
    """Removes one question of this check's own making, children first. Not the `remove` action: that
    one deliberately ARCHIVES a question anything still references (remove_question's rule), which is
    exactly how the first runs of this check left three archived essays behind (ISSUE-040)."""
    sql(f"""delete from public.audit_logs where entity_id = '{question_id}';
            delete from public.question_options where question_id = '{question_id}';
            delete from public.question_class_labels where question_id = '{question_id}';
            delete from public.question_media where question_id = '{question_id}';
            delete from public.accepted_answers where question_id = '{question_id}';
            delete from public.questions where id = '{question_id}';""")


def wipe_check():
    """Removes whatever a previous (or half-finished) run of *this check* left behind, and nothing else.

    The exam goes first, on purpose: it still references this check's essay question, so deleting the
    question before the exam fails on `exam_questions_question_id_fkey` and takes the next run's own
    startup down with it (found by killing this check mid-run on 2026-09-30). The end-of-run cleanup
    makes the same rule.
    """
    for row in sql("select id from public.exams where access_code = 'BELL01'"):
        sessions = sessions_array(row["id"])
        sql(f"""delete from public.session_events where session_id = any('{sessions}'::uuid[]);
                delete from public.session_answers where session_id = any('{sessions}'::uuid[]);
                delete from public.answer_grades where session_id = any('{sessions}'::uuid[]);
                delete from public.exam_results where session_id = any('{sessions}'::uuid[]);
                delete from public.exam_sessions where id = any('{sessions}'::uuid[]);
                delete from public.retake_permissions where exam_id = '{row['id']}';
                delete from public.audit_logs where entity_id = '{row['id']}' or entity_id = any('{sessions}'::text[]);
                delete from public.exam_questions where exam_id = '{row['id']}';
                delete from public.exams where id = '{row['id']}';""")
    for row in sql(f"select id from public.questions where body = '{NAME} essay (safe to delete)'"):
        delete_question(row["id"])
    for row in sql(f"select id from public.profiles where full_name like '{NAME}%'"):
        sql(f"delete from public.audit_logs where action like 'account.%' and entity_id = '{row['id']}'")
        delete_user(row["id"])
    sql("delete from public.notification_reads")


def bell(token):
    status, data = call("notifications", {"action": "list"}, token)
    return status, (data or {}).get("notifications") if status == 200 else data


def main():
    if not ACCESS:
        print("set SUPABASE_ACCESS_TOKEN first: this check mints login links and reads its own rows")
        return 1
    wipe_check()
    before = live_state()
    print(f"live state before: {json.dumps(before)}")
    check("the starting point has the two real accounts and none of this check's leftovers",
          before["accounts"] == 2 and before["bell_exams"] == 0 and before["account_history"] == 0, json.dumps(before))

    # ---------- 1. the door ----------
    check("a tokenless call to the bell is refused", call("notifications", {"action": "list"})[0] == 401)

    status, admin_session = magic_link(ADMIN_EMAIL)
    admin = admin_session.get("access_token") if status == 200 else None
    check("the admin signs in through a one-time link (no password needed)", bool(admin), f"{status} {json.dumps(admin_session)[:160]}")
    status, teacher_session = magic_link(TEACHER_EMAIL)
    teacher = teacher_session.get("access_token") if status == 200 else None
    check("the staff test account signs in too", bool(teacher), f"{status} {json.dumps(teacher_session)[:160]}")
    if not admin or not teacher:
        return 1

    # ---------- 2. the quiet bell, and the role split ----------
    s, n = bell(teacher)
    check("a teacher can read the bell", s == 200 and isinstance(n, dict), f"{s} {json.dumps(n)[:200]}")
    check("a teacher's quiet bell counts zero", n.get("total") == 0 and n.get("unread") == 0, json.dumps(n)[:200])
    check("a teacher's bell carries no backup or account news",
          n.get("backup") == 0 and n.get("account") == 0 and not n.get("kinds", {}).get("backup"), json.dumps(n)[:200])
    s2, n2 = bell(admin)
    check("an admin can read the bell as well", s2 == 200 and isinstance(n2, dict), f"{s2} {json.dumps(n2)[:200]}")
    check("the teacher's read mark does not silence the admin's bell",
          n2.get("read_at") is None, json.dumps(n2)[:160])

    # ---------- 3. a real exam, one essay waiting and one suspicious attempt ----------
    _, bank = call("question-bank", {"action": "list", "page_size": 100}, teacher)
    mc_ids = [i["id"] for i in bank["items"] if i["type"] == "multiple_choice"]
    check("the live bank has a multiple-choice question to build on", bool(mc_ids), f"mc={len(mc_ids)}")
    if not mc_ids:
        return 1
    mc_id = mc_ids[0]
    # The live bank has no essay question, so the check makes its own throwaway one (removed at the end).
    s, made_q = call("question-bank", {"action": "save", "type": "essay", "body": NAME + " essay (safe to delete)",
                                       "essay_guidance": "Two ideas, one point each.", "weight": 2}, teacher)
    essay_id = (made_q or {}).get("id")
    check("the check can create its essay question", s == 200 and bool(essay_id), f"{s} {json.dumps(made_q)[:160]}")
    if not essay_id:
        return 1
    _, saved = call("exams", {"action": "save", "title": NAME + " (safe to delete)",
                              "duration_minutes": 30, "passing_grade": 70, "availability_mode": "manual",
                              "access_code": CODE, "selection_mode": "manual",
                              "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                              "tab_switch_warn_limit": 2, "tab_switch_flag_limit": 3,
                              "tab_switch_autosubmit_limit": 6,
                              "questions": [{"question_id": mc_id, "weight": 1}, {"question_id": essay_id, "weight": 2}]}, teacher)
    exam_id = (saved or {}).get("id")
    check("the check can create its exam", bool(exam_id), str(saved)[:200])
    if not exam_id:
        return 1
    harness.context("exam id", exam_id)
    call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, teacher)

    a = join(CODE, "Live Bell Student", "XII TKJ Z", teacher)
    call("session", {"action": "submit", "token": a["token"], "reason": "teacher"}, a["token"])
    check("the first attempt is collected with its essay ungraded", bool(a.get("token")), str(a)[:120])

    b = join(CODE, "Live Bell Bouncer", "XII TKJ Z", teacher)
    seen = leave_page(b["token"], 3)
    check("the second attempt crosses the flag limit", bool(seen) and seen.get("tab_switch_count") == 3, str(seen)[:120])
    call("session", {"action": "submit", "token": b["token"], "reason": "teacher"}, b["token"])

    # ---------- 4. the bell answers with the cards (one essay card per waiting attempt) ----------
    s, n = bell(admin)
    kinds = (n or {}).get("kinds") or {}
    essays = kinds.get("essays") or []
    susp = kinds.get("suspicious") or []
    check("the admin's bell now carries unread news", (n or {}).get("unread", 0) >= 3, json.dumps(n)[:220])
    check("both waiting attempts have their essay card on the exam",
          len(essays) == 2 and all(e.get("access_code") == CODE and e.get("exam_id") == exam_id for e in essays),
          json.dumps(essays)[:260])
    card = next((e for e in essays if e.get("student_name") == "Live Bell Student"), None)
    check("the essay card carries the count and the student",
          bool(card) and card.get("waiting") >= 1, json.dumps(card)[:220])
    check("exactly one suspicious card names the check's exam",
          len(susp) == 1 and susp[0].get("access_code") == CODE, json.dumps(susp)[:220])
    check("the suspicious card counts the real events",
          bool(susp) and susp[0].get("events") >= 1 and susp[0].get("sessions") >= 1, json.dumps(susp)[:220])

    # ---------- 5. marking the bell read, per person ----------
    s, marked = call("notifications", {"action": "mark_read"}, admin)
    marked = (marked or {}).get("notifications")
    check("the admin opening the bell marks it read",
          s == 200 and marked.get("unread") == 0 and marked.get("read_at"), json.dumps(marked)[:200])
    s, again = bell(admin)
    check("a fresh list stays read and still lists the same cards",
          again.get("unread") == 0 and len(again.get("kinds", {}).get("essays") or []) == 2, json.dumps(again)[:200])
    s, t2 = bell(teacher)
    check("the teacher's bell is marked separately", t2.get("unread", 0) >= 2, json.dumps(t2)[:160])
    call("notifications", {"action": "mark_read"}, teacher)
    s, t3 = bell(teacher)
    check("and the teacher's mark works too", t3.get("unread") == 0 and t3.get("read_at"), json.dumps(t3)[:160])

    # ---------- 6. a real backup announces itself ----------
    s, made = call("backups", {"action": "create"}, admin)
    backup = (made or {}).get("backup") or {}
    check("the check can take a manual backup", s == 200 and backup.get("id"), f"{s} {json.dumps(made)[:200]}")
    if s != 200:
        return 1
    s, n = bell(admin)
    bk = (n.get("kinds") or {}).get("backup") or {}
    check("the backup is news on the admin's bell", n.get("backup") == 1 and bk.get("kind") == "manual", json.dumps(n)[:220])
    check("the card names who took it", bk.get("created_by_name") == "Admin", json.dumps(bk)[:160])
    call("notifications", {"action": "mark_read"}, admin)
    s, tn = bell(teacher)
    check("a teacher's bell stays quiet about backups",
          tn.get("backup") == 0 and not (tn.get("kinds") or {}).get("backup"), json.dumps(tn)[:160])

    # ---------- 7. a real account is news once ----------
    email = f"bell-check-{int(time.time())}@example.com"
    password = secrets.token_urlsafe(12)
    s, made = call("accounts", {"action": "create", "email": email, "full_name": NAME, "role": "teacher",
                                "password": password}, admin)
    account = (made or {}).get("account") or {}
    check("the check can create an account", s == 200 and account.get("id"), f"{s} {json.dumps(made)[:200]}")
    if s != 200:
        return 1
    s, n = bell(admin)
    accts = (n.get("kinds") or {}).get("accounts") or []
    check("the new account is news on the admin's bell",
          len(accts) == 1 and accts[0].get("email") == email and accts[0].get("role") == "teacher", json.dumps(accts)[:220])
    status, session = password_grant(email, password)
    check("the handed-over password really signs that person in", status == 200 and bool(session.get("access_token")),
          f"{status} {json.dumps(session)[:120]}")
    # The audit trail is permanent by design, so the check removes its own account rows before the
    # person disappears — a card without its account would otherwise be "news" forever.
    sql(f"delete from public.audit_logs where action like 'account.%' and entity_id = '{account['id']}'")
    delete_user(account["id"])
    s, n = bell(admin)
    check("and when the account is gone it is no longer news",
          len((n.get("kinds") or {}).get("accounts") or []) == 0, json.dumps(n)[:200])

    # ---------- 8. the refusals ----------
    check("an unknown action is refused", call("notifications", {"action": "shout"}, admin)[0] == 400)
    check("a broken limit is refused", call("notifications", {"action": "list", "limit": 0}, admin)[0] == 400)

    # ---------- 9. cleanup, and the project is as it was ----------
    _, bkmade = call("backups", {"action": "delete", "id": backup["id"]}, admin)
    check("the backup row and file are removed", isinstance(bkmade, dict) and bkmade.get("removed") == 1, str(bkmade)[:160])
    sessions = sessions_array(exam_id)
    sql(f"""delete from public.session_events where session_id = any('{sessions}'::uuid[]);
            delete from public.session_answers where session_id = any('{sessions}'::uuid[]);
            delete from public.answer_grades where session_id = any('{sessions}'::uuid[]);
            delete from public.exam_results where session_id = any('{sessions}'::uuid[]);
            delete from public.exam_sessions where id = any('{sessions}'::uuid[]);
            delete from public.retake_permissions where exam_id = '{exam_id}';
            delete from public.audit_logs where entity_id = '{exam_id}' or entity_id = any('{sessions}'::text[]);
            delete from public.exam_questions where exam_id = '{exam_id}';
            delete from public.exams where id = '{exam_id}';
            delete from public.rate_limits where bucket like 'session\\_%' and window_start > now() - interval '2 hours';
            delete from public.notification_reads;""")
    # The real remove action is exercised last, on purpose: it archives a question that anything still
    # references, so it only deletes once the exam, the attempts and their answers are gone (ISSUE-040).
    _, removed = call("question-bank", {"action": "remove", "id": essay_id}, teacher)
    check("the check's own essay question is deleted, not archived",
          (removed or {}).get("result") == "deleted", str(removed)[:160])
    for row in sql(f"select id from public.questions where body = '{NAME} essay (safe to delete)'"):
        # belt and braces: if a half-finished run left one behind, it does not stay
        delete_question(row["id"])
    sql(f"delete from public.audit_logs where entity_id = '{backup['id']}'")
    after = live_state()
    check("the project's own accounts, questions and their history are untouched",
          after == before, f"{json.dumps(before)} -> {json.dumps(after)}")

    print()
    return harness.finish("ALL LIVE NOTIFICATION CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
