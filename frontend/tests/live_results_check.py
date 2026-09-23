"""LIVE verification of the grading loop against the v2 project (TASK-012).

Not part of CI: it talks to the real backend with the owner's admin account. The credentials are read
from the environment and are never stored here. Run it by hand:

    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' python frontend/tests/live_results_check.py

It creates one exam, two students join and send it in, the teacher grades both essays, corrects a
grade by hand, reopens an attempt, and allows a retake. Everything it creates is listed at the end so
the rows can be deleted (see docs/sql-results.md for the cleanup block).
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
CODE = "RLC001"
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


def main():
    if not EMAIL or not PASSWORD:
        print("set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD in the environment first")
        return 1
    status, data = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PASSWORD})
    if status != 200:
        print(f"sign-in failed: {status} {data}")
        return 1
    staff = data["access_token"]

    # ---------- one exam with a question of each kind ----------
    # The live bank holds only multiple choice (migrated from v1), so the short-answer and the essay
    # question are created here and removed again by the cleanup block.
    _, bank = call("question-bank", {"action": "list", "page_size": 100}, staff)
    mc_id = next(i["id"] for i in bank["items"] if i["type"] == "multiple_choice")
    _, mc = call("question-bank", {"action": "get", "id": mc_id}, staff)
    mc_right = next(o["body"] for o in mc["question"]["options"] if o["is_correct"])

    _, new_sa = call("question-bank", {"action": "save", "type": "short_answer", "difficulty": "easy",
                                       "body": "Write the simple past of go. (live results check)", "weight": 1,
                                       "accepted_answers": ["went"]}, staff)
    _, new_es = call("question-bank", {"action": "save", "type": "essay", "difficulty": "easy",
                                       "body": "Explain why the orientation part matters. (live results check)",
                                       "weight": 3, "essay_guidance": "Says who, where and when."}, staff)
    sa_id, es_id = new_sa.get("id"), new_es.get("id")
    check("the check can add the two question kinds the bank lacks", bool(sa_id) and bool(es_id),
          f"{new_sa} {new_es}")
    if not sa_id or not es_id:
        return 1
    sa_ok = "went"

    _, saved = call("exams", {"action": "save", "title": "Results live check (safe to delete)", "duration_minutes": 30,
                              "passing_grade": 70, "availability_mode": "manual", "access_code": CODE,
                              "selection_mode": "manual", "result_visibility": "score_and_review",
                              "essay_pending_display": "show_partial",
                              "questions": [{"question_id": mc_id, "weight": 2}, {"question_id": sa_id, "weight": 1},
                                            {"question_id": es_id, "weight": 3}]}, staff)
    exam_id = saved["id"]
    check("an exam with an essay can be created", bool(exam_id), str(saved))
    _, opened = call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, staff)
    check("the exam is open", opened == {"ok": True}, str(opened))

    # ---------- two students ----------
    _, join_a = call("session", {"action": "join", "code": CODE, "name": "Live Result A", "class": "XII TKJ Z"}, staff)
    token_a = join_a["token"]
    call("session", {"action": "save", "token": token_a, "answers": [
        {"question_id": mc_id, "answer": {"text": mc_right}},
        {"question_id": sa_id, "answer": {"text": sa_ok}},
        {"question_id": es_id, "answer": {"text": "The orientation tells who, where and when."}}]}, token_a)
    _, sent_a = call("session", {"action": "submit", "token": token_a, "reason": "student"}, token_a)
    check("a student's essay keeps the result pending", sent_a.get("pending_review") is True, str(sent_a)[:200])

    _, join_b = call("session", {"action": "join", "code": CODE, "name": "Live Result B", "class": "XII TKJ Z"}, staff)
    token_b = join_b["token"]
    call("session", {"action": "save", "token": token_b, "answers": [
        {"question_id": mc_id, "answer": {"text": "not the right option"}},
        {"question_id": es_id, "answer": {"text": "Because it starts the story."}}]}, token_b)
    _, sent_b = call("session", {"action": "submit", "token": token_b, "reason": "student"}, token_b)
    check("the second student sends it in", sent_b.get("submitted") is True, str(sent_b)[:200])
    sid_a, sid_b = join_a["session"]["id"], join_b["session"]["id"]

    # ---------- the grading side ----------
    _, pending = call("results", {"action": "pending"}, staff)
    check("the badge counts the waiting essays", pending["pending"] == 2, str(pending))

    _, activity = call("results", {"action": "activity"}, staff)
    row = next((e for e in activity["exams"] if e["exam_id"] == exam_id), None)
    check("the exam shows up in the Grading hub", row is not None, str(activity)[:200])
    check("the hub counts two sessions and two waiting essays",
          row and row["sessions"] == 2 and row["pending_essays"] == 2, str(row))

    _, questions = call("results", {"action": "grading_questions", "exam_id": exam_id}, staff)
    check("the essay question is listed with its guide",
          len(questions["questions"]) == 1 and questions["questions"][0]["waiting"] == 2, str(questions)[:200])

    _, queue = call("results", {"action": "queue", "exam_id": exam_id, "question_id": es_id}, staff)
    check("the queue holds both students", len(queue["queue"]["students"]) == 2, str(queue)[:200])
    check("the queue carries each answer",
          all(s["answer"] for s in queue["queue"]["students"]), str(queue["queue"]["students"])[:200])

    _, graded_a = call("results", {"action": "grade", "session_id": sid_a, "question_id": es_id,
                                   "points": 3, "feedback": "Good: who, where and when."}, staff)
    check("the first essay is graded and the result becomes final", graded_a["grade"]["final"] is True, str(graded_a))
    check("that student passes", graded_a["grade"]["pass_status"] == "passed", str(graded_a["grade"]))

    _, graded_b = call("results", {"action": "grade", "session_id": sid_b, "question_id": es_id, "points": 1}, staff)
    check("the second essay is graded", graded_b["grade"]["final"] is True, str(graded_b))
    check("the weak attempt fails", graded_b["grade"]["pass_status"] == "failed", str(graded_b["grade"]))

    _, too_many = call("results", {"action": "grade", "session_id": sid_b, "question_id": es_id, "points": 9}, staff)
    check("a grade above the maximum is refused with a friendly message",
          isinstance(too_many, dict) and "most points" in str(too_many.get("error", "")), str(too_many))

    _, pending_after = call("results", {"action": "pending"}, staff)
    check("nothing waits once both essays are graded", pending_after["pending"] == 0, str(pending_after))

    # the student sees the final number
    _, result_a = call("session", {"action": "result", "token": token_a}, token_a)
    check("the student's own view is final now", result_a.get("pending_review") is False, str(result_a)[:200])
    check("the student sees the score", result_a.get("score", {}).get("percentage") == 100, str(result_a)[:200])

    # ---------- the results table ----------
    _, overview = call("results", {"action": "overview", "exam_id": exam_id}, staff)
    check("the results table lists both students", len(overview["overview"]["rows"]) == 2, str(overview)[:200])
    check("the summary has one pass and one fail",
          overview["overview"]["summary"]["passed"] == 1 and overview["overview"]["summary"]["failed"] == 1,
          str(overview["overview"]["summary"]))
    check("nothing is 'not final' any more", overview["overview"]["summary"]["not_final"] == 0,
          str(overview["overview"]["summary"]))
    row_a = next(r for r in overview["overview"]["rows"] if r["student_name"] == "Live Result A")
    check("the row carries right and wrong counts and time used",
          row_a["correct_count"] == 2 and row_a["wrong_count"] == 0 and row_a["time_used_seconds"] >= 0, str(row_a))

    # ---------- one attempt in detail ----------
    _, report = call("results", {"action": "report", "session_id": sid_a}, staff)
    essay_item = next(x for x in report["report"]["review"] if x["question_id"] == es_id)
    check("the report shows the essay grade as the teacher's",
          essay_item["points"] == 3 and essay_item["manual"] is True, str(essay_item))
    check("the report keeps the comment", essay_item["feedback"] == "Good: who, where and when.", str(essay_item))
    check("the report shows the guide for the essay", bool(essay_item.get("guide")), str(essay_item)[:200])
    check("the history of the attempt is there", report["report"]["event_counts"].get("graded") == 1,
          str(report["report"]["event_counts"]))

    # BR-18: correct the short answer by hand, then reopen and send in again — the correction survives
    _, corrected = call("results", {"action": "grade", "session_id": sid_b, "question_id": sa_id,
                                    "points": 1, "feedback": "Accepted: same idea."}, staff)
    check("a short answer can be corrected by hand", corrected["grade"]["points"] == 1, str(corrected))
    total_after_correction = corrected["grade"]["total_points"]

    _, reopened = call("results", {"action": "reopen", "session_id": sid_b, "minutes": 10}, staff)
    check("an attempt can be reopened", reopened["session"]["status"] == "reopened", str(reopened))
    _, accepted = call("session", {"action": "save", "token": token_b,
                                   "answers": [{"question_id": es_id, "answer": {"text": "Because it starts the story and sets the scene."}}]}, token_b)
    check("the student can answer again after a reopen", accepted.get("accepted") is True, str(accepted))
    _, resent = call("session", {"action": "submit", "token": token_b, "reason": "student"}, token_b)
    check("the reopened attempt can be sent in again", resent.get("status") == "submitted", str(resent)[:200])
    _, after = call("results", {"action": "report", "session_id": sid_b}, staff)
    sa_item = next(x for x in after["report"]["review"] if x["question_id"] == sa_id)
    check("the manual correction survives the second send",
          sa_item["points"] == 1 and sa_item["manual"] is True, str(sa_item))
    check("the total still counts the correction",
          after["report"]["result"]["total_points"] == total_after_correction, str(after["report"]["result"]))

    _, timed = call("results", {"action": "add_time", "session_id": sid_a, "minutes": 5}, staff)
    check("a collected attempt is told to reopen instead of taking time",
          isinstance(timed, dict) and "already collected" in str(timed.get("error", "")), str(timed))

    # ---------- allow one retake ----------
    _, granted = call("results", {"action": "grant_retake", "session_id": sid_b}, staff)
    check("a retake can be allowed", granted["retake"]["granted"] is True, str(granted))
    _, join_again = call("session", {"action": "join", "code": CODE, "name": "live result b", "class": "xii  tkj z"}, staff)
    check("the same student gets attempt 2", join_again["session"]["attempt_no"] == 2, str(join_again)[:200])
    _, refused = call("results", {"action": "revoke_retake", "session_id": sid_b}, staff)
    check("a used retake cannot be taken back",
          isinstance(refused, dict) and "already used" in str(refused.get("error", "")), str(refused))

    # ---------- the auth wall ----------
    status, _ = call("results", {"action": "pending"}, "not-a-token")
    check("the results function refuses a stranger", status == 401, str(status))

    print()
    print("ids to clean up:")
    print(json.dumps({"exam_id": exam_id, "sessions": [sid_a, sid_b, join_again["session"]["id"]],
                      "questions": [sa_id, es_id]}))
    failed = [n for n, ok, _ in checks if not ok]
    print("ALL LIVE CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
