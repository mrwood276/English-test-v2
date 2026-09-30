"""LIVE run of bulk exam question management (F-18, DEC-036).

Not part of CI. **This one writes**, so it is built to be harmless and to leave nothing behind:

* it creates **one throwaway draft exam** and **five throwaway questions** of its own (each question body
  carries a unique `LIVE EXAM BULK <stamp>` marker) through the same `exams` / `question-bank` functions a
  teacher uses, and deletes all of them again at the end;
* the owner's own exams are **never modified**: the only real exam it touches is one that *already has
  attempts*, used as a **refusal control** — its question list is read before and after and must be
  byte-for-byte the same (this is the guard that matters most: BR-10 / DEC-012, attempts are never rewritten);
* the only archived question in the owner's bank is read, never written: it is offered to the function as a
  question that must be refused;
* it restores the counts it measured at the start (exams, questions, archived questions) and says so;
* the only thing it deliberately leaves behind is the **audit history of its own acts** — that is the
  feature, an audit trail is not something a test should erase.

    python frontend/dev-server.py 8123                          # another terminal, for the screen part
    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_exam_bulk_check.py
    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_exam_bulk_check.py --api-only

Signing in needs no password when `SUPABASE_ACCESS_TOKEN` (a Supabase Management token) is set: the check
mints a one-time login link and exchanges it for a session itself. Set `SUPABASE_TEST_PASSWORD` as well and
it uses the password instead. The account must have a `profiles` row with role `teacher` or `admin`. With a
token it also asks the **database** directly, so the Edge layer's answer can be compared with the SQL
function's — every claim about the exam's question list below is read back from `public.exam_questions`,
not taken from the function's own reply.

What it proves, in order:

 1. the staff test account signs in, and the staff gate calls it a teacher or an admin;
 2. a tokenless `bulk_questions` is 401 before it is even parsed, and every payload the screen could not
    produce is refused with a friendly 400 (no mode, no ids, more than 500 ids, an exam that does not exist);
 3. an exam that already has attempts refuses the change and says to duplicate it instead, and its question
    list is byte-for-byte what it was;
 4. an archived question cannot be put on an exam, and it is still archived afterwards;
 5. three questions go onto the exam in **one act**, at the end of the list, in the order they were given,
    each carrying its own points, numbered on from what was already there with no gap;
 6. the same act again reports `updated 0 / unchanged 3`: a call that changes nothing may not claim work;
 7. an id that no longer exists is **counted** (`missing 1`), not fatal — and the questions that do exist
    are still changed;
 8. removing takes exactly the ids asked for, renumbers what stays and leaves its order and points alone; a
    question that is not on the exam is counted as unchanged, not as removed;
 9. the real screen — the exam editor, against the deployed function and a real staff session — searches the
    bank, ticks a question, reads the preview, applies it, and shows it in the exam's own list; it then moves
    that question to the top of the list with the reorder grip and the keyboard; **nothing reaches the server
    before Save** in that editor, and Save then writes exactly the list the screen showed, in the order it
    showed it — with the positions dense from 1;
10. one `exam.questions` audit entry per act and **never one per question**;
11. the throwaway exam and questions are deleted again and the live counts are back where they started.
"""
import json
import os
import random
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
checks = []

STAMP = time.strftime("%Y%m%d-%H%M%S")
MARKER = f"LIVE EXAM BULK {STAMP}"
TITLE = f"Live exam bulk check (safe to delete) {STAMP}"
BOGUS = "00000000-0000-4000-8000-000000000000"


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
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return http("POST", f"{URL}/functions/v1/{name}", body, headers)


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


def quoted(values):
    return ",".join("'" + str(v) + "'" for v in values)


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
    role = ((me if isinstance(me, dict) else {}).get("user") or {}).get("role")
    check("the staff gate accepts it as a teacher or an admin", status == 200 and role in ("teacher", "admin"),
          f"{status} {json.dumps(me)[:200]}")
    if status != 200 or role not in ("teacher", "admin"):
        return 1
    print(f"signed in as {EMAIL} ({role})")

    # A run that died mid-way must not block this one: its draft exam and its five questions are this
    # check's own (ISSUE-043). Both go through the same `remove` actions the end of this check uses (the
    # exam first — it points at the seed question); anything the functions will not remove is removed by
    # hand, bulk-style: the questions' audit rows are kept, that history is the feature.
    if ACCESS:
        stale_exams = sql("select id, title from public.exams "
                          "where title like 'Live exam bulk check (safe to delete)%'")
        for row in stale_exams:
            status, body = call("exams", {"action": "remove", "id": row["id"]}, token)
            if (body or {}).get("result") != "deleted":
                live_cleanup.wipe_exam(sql, row["id"])
        stale_q = sql("select id from public.questions where body like 'LIVE EXAM BULK %'")
        for row in stale_q:
            status, body = call("question-bank", {"action": "remove", "id": row["id"]}, token)
            if (body or {}).get("result") != "deleted":
                live_cleanup.wipe_question(sql, row["id"], keep_audit=True)
        if stale_exams or stale_q:
            check(f"an earlier run's leftovers ({len(stale_exams)} exams, {len(stale_q)} questions) "
                  f"were swept before this one started", True)

    # ---------- 2. a tokenless call, before anything exists ----------
    status, body = call("exams", {"action": "bulk_questions", "exam_id": BOGUS, "mode": "add", "ids": [BOGUS]})
    check("a tokenless bulk_questions is refused before it is even parsed", status == 401,
          f"{status} {json.dumps(body)[:120]}")

    # ---------- 3. the snapshot this run promises to restore ----------
    before = {"exams": None, "questions": None, "archived": None}
    if ACCESS:
        row = sql("select (select count(*) from public.exams) as exams, "
                  "(select count(*) from public.questions) as questions, "
                  "(select count(*) from public.questions where is_archived) as archived")[0]
        before = {k: int(row[k]) for k in before}
        print(f"live before: {before['exams']} exams, {before['questions']} questions "
              f"({before['archived']} archived)")

    # ---------- 4. throwaway fixtures, through the real functions ----------
    created = []
    for i in (1, 2, 3, 4, 5):
        status, body = call("question-bank", {"action": "save", "type": "short_answer", "difficulty": "medium",
                                             "topic": "", "body": f"{MARKER} fixture {i}", "weight": i,
                                             "accepted_answers": [f"alpha{i}"], "class_labels": []}, token)
        created.append((body or {}).get("id") if status == 200 else None)
    check("five throwaway questions can be created", all(created) and len(set(created)) == 5,
          f"{status} {json.dumps(body)[:200]}")
    if not all(created):
        for i in [x for x in created if x]:
            call("question-bank", {"action": "remove", "id": i}, token)
        return 1
    ids, seed, spare = created[:3], created[3], created[4]

    weights = {i: float(n) for n, i in enumerate(created, start=1)}   # what each question was saved with
    if ACCESS:
        rows = sql(f"select id, default_weight from public.questions where id in ({quoted(created)})")
        weights = {r["id"]: float(r["default_weight"]) for r in rows}
        check("the bank really holds those points", len(weights) == 5, json.dumps(weights)[:200])

    # `save_exam` refuses a manual exam with no questions at all, so the throwaway exam starts with one:
    # the seed question. The spare one is the question the screen half puts on it.
    code = "EB" + "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(4))
    status, body = call("exams", {"action": "save", "title": TITLE, "duration_minutes": 30, "passing_grade": 60,
                                  "availability_mode": "manual", "access_code": code, "selection_mode": "manual",
                                  "questions": [{"question_id": seed, "weight": weights[seed]}]}, token)
    exam_id = (body or {}).get("id") if status == 200 else None
    check("a throwaway draft exam can be created", bool(exam_id), f"{status} {json.dumps(body)[:200]}")
    if not exam_id:
        for i in created:
            call("question-bank", {"action": "remove", "id": i}, token)
        return 1

    def exam_rows():
        """The exam's question list straight from the database, in the order the exam will use it."""
        rows = sql(f"select question_id, position, weight from public.exam_questions "
                   f"where exam_id = '{exam_id}' order by position")
        return [(r["question_id"], int(r["position"]), float(r["weight"])) for r in rows]

    check("the exam starts with just the seed question", (not ACCESS) or exam_rows() == [(seed, 1, weights[seed])],
          json.dumps(exam_rows())[:200] if ACCESS else "")

    acts = 0   # how many bulk_exam_questions calls reached the database, for the audit count at the end

    # How many `exam.update` rows this brand-new exam already carries: none, and the bulk path must not add
    # one. The screen half below is allowed exactly one, because its own Save calls `save_exam` — the check
    # for that is at the end, where it can say which of the two it is looking at.
    exam_update_rows_at_start = (sql(f"select count(*) as n from public.audit_logs "
                                     f"where action = 'exam.update' and entity_id = '{exam_id}'")[0]["n"]
                                 if ACCESS else 0)

    def bulk(mode, qids, expect=200, label=""):
        nonlocal acts
        status, body = call("exams", {"action": "bulk_questions", "exam_id": exam_id, "mode": mode, "ids": qids}, token)
        if status == 200:
            acts += 1
        if expect is not None:
            check(f"bulk_questions {label or json.dumps([mode, qids])}", status == expect,
                  f"{status} {json.dumps(body)[:220]}")
        return status, (body or {}).get("result") if isinstance(body, dict) else None

    # ---------- 5. every refusal the screen could produce ----------
    bulk("merge", ids, 400, "with an unknown mode")
    bulk("add", [], 400, "with nothing selected")
    bulk("add", [str(uuid.uuid4()) for _ in range(501)], 400, "with more than 500 ids")
    status, body = call("exams", {"action": "bulk_questions", "exam_id": BOGUS, "mode": "add", "ids": ids}, token)
    check("an exam that no longer exists is refused", status == 400, f"{status} {json.dumps(body)[:160]}")
    check("the exam is untouched by any of those refusals",
          (not ACCESS) or exam_rows() == [(seed, 1, weights[seed])])

    # ---------- 6. the owner's own data: a refusal, and an untouched control ----------
    if ACCESS:
        # A manual exam that nobody is sitting right now: the attempts guard is the one under test, not the
        # "close it first" one.
        row = sql("select e.id from public.exams e where e.selection_mode = 'manual' and e.status <> 'open' "
                  "and exists (select 1 from public.exam_sessions s where s.exam_id = e.id) limit 1")
        taken = row[0]["id"] if row else None
        if taken:
            watch = f"select question_id, position, weight from public.exam_questions where exam_id = '{taken}' order by position"
            control_before = sql(watch)
            status, body = call("exams", {"action": "bulk_questions", "exam_id": taken, "mode": "add", "ids": ids}, token)
            check("an exam that already has attempts refuses any change", status == 400,
                  f"{status} {json.dumps(body)[:200]}")
            check("and it says why, and what to do instead",
                  "already has attempts" in json.dumps(body) and "Duplicate" in json.dumps(body),
                  json.dumps(body)[:200])
            check("an exam with attempts is byte-for-byte what it was", sql(watch) == control_before,
                  f"{json.dumps(control_before)[:120]} vs {json.dumps(sql(watch))[:120]}")
        else:
            print("note: no exam on this project has attempts, so the refusal for one could not be shown")

        row = sql("select id from public.questions where is_archived limit 1")
        if row:
            retired = row[0]["id"]
            status, body = call("exams", {"action": "bulk_questions", "exam_id": exam_id, "mode": "add",
                                          "ids": [retired]}, token)
            check("an archived question cannot be put on an exam", status == 400 and "archived" in json.dumps(body),
                  f"{status} {json.dumps(body)[:200]}")
            still = sql(f"select is_archived from public.questions where id = '{retired}'")[0]["is_archived"]
            check("and the archived question is still exactly as it was", still is True, str(still))
        else:
            print("note: this bank has no archived question, so that refusal could not be shown")

    # ---------- 7. three questions, one act ----------
    status, result = bulk("add", ids, 200, "putting three questions on the exam")
    check("the reply counts what really happened",
          result == {"matched": 3, "updated": 3, "unchanged": 0, "missing": 0}, json.dumps(result))
    rows = exam_rows() if ACCESS else []
    check("the database holds the seed and then the three, at the end of the list, in the order they were sent",
          (not ACCESS) or [r[0] for r in rows] == [seed] + ids, json.dumps(rows)[:220])
    check("numbered on with no gap in the exam's order",
          (not ACCESS) or [r[1] for r in rows] == [1, 2, 3, 4], json.dumps(rows)[:220])
    check("each question carries its own points, not the first one's",
          (not ACCESS) or [r[2] for r in rows] == [weights[i] for i in [seed] + ids],
          f"{[r[2] for r in rows]} vs {[weights[i] for i in [seed] + ids]}")

    # ---------- 8. the same act again claims no work ----------
    _, again = bulk("add", ids, 200, "with the very same three again")
    check("a repeated add reports nothing done",
          again == {"matched": 3, "updated": 0, "unchanged": 3, "missing": 0}, json.dumps(again))
    check("and the exam is not doubled up", (not ACCESS) or [r[0] for r in exam_rows()] == [seed] + ids)

    # ---------- 9. an id that no longer exists is counted ----------
    _, partial = bulk("add", [BOGUS] + ids[:2], 200, "with one id that is gone")
    check("a missing id is reported, not fatal",
          partial == {"matched": 2, "updated": 0, "unchanged": 2, "missing": 1}, json.dumps(partial))

    # ---------- 10. removing is exact, and leaves the rest alone ----------
    _, off = bulk("remove", [ids[1]], 200, "taking the middle question off")
    check("removing reports exactly the one that was on the exam",
          off == {"matched": 1, "updated": 1, "unchanged": 0, "missing": 0}, json.dumps(off))
    rows = exam_rows() if ACCESS else []
    check("the survivors keep their order and their points, renumbered with no gap",
          (not ACCESS) or rows == [(seed, 1, weights[seed]), (ids[0], 2, weights[ids[0]]), (ids[2], 3, weights[ids[2]])],
          json.dumps(rows)[:240])
    _, off_again = bulk("remove", [ids[1]], 200, "taking the same one off again")
    check("a question that is not on the exam is counted as unchanged, not as removed",
          off_again == {"matched": 0, "updated": 0, "unchanged": 1, "missing": 0}, json.dumps(off_again))
    _, mixed = bulk("remove", [BOGUS] + [ids[2]], 200, "taking off one that is there and one that is gone")
    check("a remove counts what it really took off",
          mixed == {"matched": 1, "updated": 1, "unchanged": 0, "missing": 1}, json.dumps(mixed))
    _, nothing = bulk("remove", [ids[2]], 200, "with nothing left to remove")
    check("an empty outcome is still an honest answer",
          nothing == {"matched": 0, "updated": 0, "unchanged": 1, "missing": 0}, json.dumps(nothing))
    status, body = call("exams", {"action": "bulk_questions", "exam_id": exam_id, "mode": "remove",
                                  "ids": [BOGUS]}, token)
    check("a remove whose selection no longer exists is refused, not silently ignored",
          status == 400 and "no longer exist" in json.dumps(body), f"{status} {json.dumps(body)[:200]}")

    # back to a known state for the screen half: the seed and all three, in order
    status, body = call("exams", {"action": "bulk_questions", "exam_id": exam_id, "mode": "add",
                                  "ids": [ids[1], ids[2]]}, token)
    acts += 1 if status == 200 else 0
    check("the exam is whole again for the screen half", status == 200, f"{status} {json.dumps(body)[:160]}")

    # ---------- 11. the real screen, against the real project ----------
    errors = []
    if not api_only:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1440, "height": 950})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.on("dialog", lambda d: d.accept())   # the editor's own leave guard, if it comes up

            page.goto(BASE)
            page.evaluate("s => sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', s)", json.dumps(session))
            page.goto(f"{BASE}#/exams/edit/{exam_id}")
            page.reload()
            page.wait_for_function(f"document.querySelector('#ee-title') && "
                                   f"document.querySelector('#ee-title').value === {json.dumps(TITLE)}", timeout=30000)
            chosen = page.query_selector_all(".chosen-item")
            check("the exam editor opens on the throwaway exam, showing the four questions on it",
                  len(chosen) == 4, str(len(chosen)))

            page.wait_for_selector("input[aria-label='Search questions']", timeout=15000)
            page.fill("input[aria-label='Search questions']", MARKER)
            page.wait_for_function("document.querySelectorAll('.picker-list:not(.chosen) .picker-item').length === 5",
                                   timeout=30000)
            here = page.inner_text(".picker-list:not(.chosen)")
            check("searching the bank finds the five throwaway questions", here.count("fixture") == 5, here[:200])
            check("the four already on the exam are marked, and cannot be ticked again",
                  all(page.is_disabled(f".picker-list:not(.chosen) .picker-item[data-id='{i}'] input.pick")
                      for i in [seed] + ids)
                  and "On this exam" in page.inner_text(f".picker-list:not(.chosen) .picker-item[data-id='{ids[0]}']"))
            check("and the spare one can be",
                  page.is_enabled(f".picker-list:not(.chosen) .picker-item[data-id='{spare}'] input.pick"))

            page.check(f".picker-list:not(.chosen) .picker-item[data-id='{spare}'] input.pick")
            page.wait_for_selector("#ee-add-bar:not([hidden])")
            check("ticking one offers to put it on this exam",
                  "1 question selected" in page.inner_text("#ee-add-bar")
                  and page.is_visible("#ee-add-bar button:has-text('Add 1 to this exam')"),
                  page.inner_text("#ee-add-bar"))

            page.click("#ee-add-bar button:has-text('Add 1 to this exam')")
            page.wait_for_selector("dialog.exam-questions-dialog[open]", timeout=15000)
            form = page.inner_text("dialog.exam-questions-dialog")
            check("the dialog skips the choice for the exam it is already editing",
                  "Add 1 question to an exam" in form and "You selected 1 question." in form, form[:200])
            check("and it names the exam and what will happen",
                  TITLE in form and "1 question will be added to" in form, form[:300])
            page.click("dialog.exam-questions-dialog button:has-text('Add to exam')")
            page.wait_for_function("document.querySelectorAll('.chosen-item').length === 5", timeout=15000)
            page.wait_for_selector(".toast:has-text('added to the exam')", timeout=15000)
            check("the question joins the exam's own list, and the screen says the save is still to come",
                  page.query_selector_all(".chosen-item").__len__() == 5
                  and "Save to keep the change" in page.inner_text(".toasts"), page.inner_text(".toasts")[:200])
            check("an applied change in the editor has NOT reached the database yet",
                  (not ACCESS) or [r[0] for r in exam_rows()] == [seed] + ids, json.dumps(exam_rows())[:200])

            # The list on screen IS the order the exam asks its questions in, so the reorder control is what
            # decides that - and `save_exam` is what writes it. This is the one claim a mocked suite can never
            # make for that: the mock stores the payload order, the real function numbers the payload it is
            # given, and only the real database says which of those the exam ended up with.
            page.focus(f".chosen-item[data-id='{spare}'] .grip")
            page.keyboard.press("Home")
            page.wait_for_function("document.querySelectorAll('.chosen-item')[0].dataset.id === " + json.dumps(spare),
                                   timeout=15000)
            check("the new question can be moved to the top of the exam with the keyboard, on the real screen",
                  [el.get_attribute("data-id") for el in page.query_selector_all(".chosen-item")] == [spare, seed] + ids,
                  str([el.get_attribute("data-id") for el in page.query_selector_all(".chosen-item")]))
            check("and a reorder, like every other edit here, has not reached the database yet",
                  (not ACCESS) or [r[0] for r in exam_rows()] == [seed] + ids, json.dumps(exam_rows())[:200])

            page.click("button:has-text('Save changes')")
            page.wait_for_selector(".toast:has-text('Exam saved as a draft')", timeout=30000)
            rows = exam_rows() if ACCESS else []
            check("and the exam the database holds is the list the screen showed, in the order it was put in",
                  (not ACCESS) or [r[0] for r in rows] == [spare, seed] + ids, json.dumps(rows)[:240])
            check("with the positions a dense 1..n, which is the order the exam really asks them in",
                  (not ACCESS) or [r[1] for r in rows] == [1, 2, 3, 4, 5], json.dumps(rows)[:240])
            check("and every question kept its own points through the reorder",
                  (not ACCESS) or [r[2] for r in rows] == [weights[i] for i in [spare, seed] + ids],
                  json.dumps(rows)[:240])
            check("no page errors", errors == [], "; ".join(errors[:3]))
            browser.close()

    # ---------- 12. the audit trail: one entry per act, never one per question ----------
    if ACCESS:
        row = sql(f"select count(*) as n from public.audit_logs where action = 'exam.questions' "
                  f"and entity_id = '{exam_id}'")[0]
        check("every act wrote exactly one audit entry", int(row["n"]) == acts,
              f"{int(row['n'])} rows for {acts} acts")
        entry = sql(f"select changes from public.audit_logs where action = 'exam.questions' "
                    f"and entity_id = '{exam_id}' order by created_at desc limit 1")[0]["changes"]
        check("the newest entry names the mode, the exam and the real count",
              entry.get("mode") in ("add", "remove") and entry.get("title") == TITLE
              and isinstance(entry.get("count"), int) and entry.get("selected") == 2,
              json.dumps(entry)[:240])
        # An act on an exam is one `exam.questions` entry — not an `exam.update` per question, and not one
        # per call. The screen half presses Save once and Save calls `save_exam`, which *is* the path that
        # writes `exam.update`; anything beyond that one row would be the bulk path helping itself.
        saves = 0 if api_only else 1
        row = sql(f"select count(*) as n from public.audit_logs where action = 'exam.update' "
                  f"and entity_id = '{exam_id}'")[0]
        check("the bulk path writes no exam.update row of its own — the only one is the screen's Save",
              int(row["n"]) == int(exam_update_rows_at_start) + saves,
              f"{int(row['n'])} rows, expected {int(exam_update_rows_at_start)} + {saves} save(s)")

    # ---------- 13. put it all back ----------
    status, body = call("exams", {"action": "remove", "id": exam_id}, token)
    check("the throwaway exam is deleted again", status == 200 and (body or {}).get("result") == "deleted",
          f"{status} {json.dumps(body)[:160]}")
    check("and it is really gone", call("exams", {"action": "get", "id": exam_id}, token)[0] == 404)
    if ACCESS:
        left = sql(f"select count(*) as n from public.exam_questions where exam_id = '{exam_id}'")[0]
        check("with no question rows left behind", int(left["n"]) == 0, str(left))
    results = []
    for i in created:
        status, body = call("question-bank", {"action": "remove", "id": i}, token)
        results.append((body or {}).get("result") if status == 200 else f"HTTP {status}")
    check("all five throwaway questions are deleted again", results == ["deleted"] * 5, json.dumps(results))
    if ACCESS:
        row = sql("select (select count(*) from public.exams) as exams, "
                  "(select count(*) from public.questions) as questions, "
                  "(select count(*) from public.questions where is_archived) as archived")[0]
        check("the live project is back where it started",
              all(int(row[k]) == before[k] for k in ("exams", "questions", "archived")), f"{row} vs {before}")
    print(f"note: {acts} exam.questions audit rows remain — that history is the feature, not litter")

    failed = [n for n, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE EXAM BULK CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main(api_only="--api-only" in sys.argv))
    except urllib.error.HTTPError as err:  # a wrong or expired Management token, said plainly
        print(f"the Supabase Management API refused that token: HTTP {err.code} {err.reason}")
        print("use a current SUPABASE_ACCESS_TOKEN (or SUPABASE_TEST_PASSWORD instead)")
        sys.exit(1)
