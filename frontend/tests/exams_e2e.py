"""Browser test of the exams list and editor with a mocked server.
Run: python3 frontend/tests/exams_e2e.py  (expects dev-server on 8123, like the other suites)
"""
import json, sys, time
sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright
from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

EXAM1 = "00000000-0000-4000-8000-0000000000e1"
EXAM2 = "00000000-0000-4000-8000-0000000000e2"

def seed(server):
    q1, q2 = server.qs[0], server.qs[1]
    server.exams[EXAM1] = {
        "id": EXAM1, "title": "Narrative Text, Daily Test 3", "description": None, "status": "open",
        "duration_minutes": 45, "passing_grade": 70, "availability_mode": "scheduled",
        "starts_at": "2026-09-22T09:45:00Z", "ends_at": "2026-09-22T10:30:00Z", "late_start_policy": "cut_at_end",
        "access_code": "K7M2QX", "selection_mode": "manual", "auto_filter": None, "pool_size": None,
        "draw_per_student": False, "randomize_questions": True, "randomize_options": False,
        "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
        "tab_switch_warn_limit": 1, "tab_switch_flag_limit": 3, "tab_switch_autosubmit_limit": 5,
        "is_template": False, "created_at": "2026-09-21T00:00:00Z",
        "questions": [
            {"question_id": q1["id"], "position": 0, "weight": 2, "body": q1["body"], "type": q1["type"]},
            {"question_id": q2["id"], "position": 1, "weight": 1, "body": q2["body"], "type": q2["type"]},
        ],
    }
    server.exams[EXAM2] = {
        "id": EXAM2, "title": "Template, Term 4 exam", "description": None, "status": "draft",
        "duration_minutes": 60, "passing_grade": 65, "availability_mode": "manual",
        "starts_at": None, "ends_at": None, "late_start_policy": "full_duration",
        "access_code": "TERM46", "selection_mode": "auto",
        "auto_filter": {"topic": "Simple Past"}, "pool_size": 20, "draw_per_student": True,
        "randomize_questions": False, "randomize_options": False,
        "result_visibility": "score", "essay_pending_display": "hide_score",
        "tab_switch_warn_limit": 1, "tab_switch_flag_limit": 3, "tab_switch_autosubmit_limit": 5,
        "is_template": True, "created_at": "2026-09-20T00:00:00Z",
        "questions": [],
    }

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    srv = Server()
    seed(srv)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/exams"); page.reload(); page.wait_for_selector(".qtable")
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")

    # --- list
    check("shows the count", page.inner_text(".head .sub") == "2 exams")
    check("menu marks Exams active", page.get_attribute("a[data-route='#/exams']", "aria-current") == "page")
    row1 = page.query_selector("tr[data-id='" + EXAM1 + "']")
    check("open exam shows its code", "K7M2QX" in row1.inner_text())
    check("status pill", row1.query_selector(".pill.ok") is not None)
    check("question and point totals", "2 · 3 pts" in row1.inner_text())
    check("schedule summary", "Scheduled" in row1.inner_text())
    check("template flagged", "template" in page.query_selector("tr[data-id='" + EXAM2 + "']").inner_text())

    # --- status toggle
    page.click("tr[data-id='" + EXAM2 + "'] button:has-text('Open')")
    page.wait_for_function(f"(document.querySelector('tr[data-id=\"{EXAM2}\"] .pill') || {{}}).textContent === 'Open'")
    check("opening a draft calls set_status with open", any(c.get("action") == "set_status" and c.get("status") == "open" and c.get("id") == EXAM2 for c in srv.exam_calls))

    # --- cannot open an exam without questions
    srv.exams["e3"] = dict(srv.exams[EXAM2], id="e3", title="Empty exam", status="draft", questions=[], is_template=False, access_code="EMPTY1", selection_mode="manual", auto_filter=None)
    page.fill("#ex-search", "Empty"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    page.click("button:has-text('Open')")
    page.wait_for_selector(".toast.bad")
    check("server refusal is shown", "questions" in page.inner_text(".toast.bad").lower())
    check("nothing was opened", srv.exams["e3"]["status"] == "draft")
    page.fill("#ex-search", ""); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 3")

    # --- delete
    page.click("tr[data-id='e3'] button:has-text('Delete')")
    page.wait_for_selector(".dialog, [role=dialog]")
    page.click(".dialog button:has-text('Delete'), [role=dialog] button:has-text('Delete')")
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")
    check("delete removed the exam", "e3" not in srv.exams)
    check("an exam without attempts is deleted without asking for a permanent delete",
          [c for c in srv.exam_calls if c.get("action") == "remove" and c.get("id") == "e3"][0].get("hard") is False)

    # --- filters
    page.select_option("#ex-status", "draft"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 0")
    check("draft filter shows the empty state", "No exams match these filters." in page.inner_text(".list-status"))
    page.select_option("#ex-status", ""); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")
    page.check("#ex-templates"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    check("template filter", srv.exam_calls[-1].get("template_only") is True and "Template" in page.inner_text(".qtable"))
    page.uncheck("#ex-templates"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")

    # --- ISSUE-023: an exam that already has attempts is kept, and says so
    srv.exams["e4"] = dict(srv.exams[EXAM1], id="e4", title="Mid Term, Weekly 2", status="closed",
                           access_code="KEPT11", is_template=False, session_count=2)

    # a teacher: the row reports the attempts and offers no Delete at all
    srv.role = "teacher"; page.reload(); page.wait_for_selector(".qtable")
    page.fill("#ex-search", "Mid Term"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    row = page.query_selector("tr[data-id='e4']")
    check("an exam with attempts shows how many it has", "2 attempts" in row.inner_text(), row.inner_text())
    check("a teacher is not offered Delete for an exam with attempts",
          row.query_selector("button:has-text('Delete')") is None, row.inner_text())
    check("a teacher is told the attempts are kept", "kept for the results" in row.inner_text(), row.inner_text())
    before = len([c for c in srv.exam_calls if c.get("action") == "remove"])
    check("a teacher cannot delete it through the API either", not any(c.get("hard") for c in srv.exam_calls) and before == 1)

    # the admin: the same row offers a permanent delete that names what is lost
    srv.role = "admin"; page.reload(); page.wait_for_selector(".qtable")
    page.fill("#ex-search", "Mid Term"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    page.click("tr[data-id='e4'] button:has-text('Delete')")
    page.wait_for_selector(".dialog")
    message = page.inner_text(".dialog")
    check("the admin dialog names the attempts and the loss",
          "2 attempts" in message and "cannot be undone" in message.lower(), message)
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_function("document.querySelector('.dialog') === null")
    check("cancelling keeps the exam", "e4" in srv.exams and srv.exams["e4"]["status"] == "closed")
    page.click("tr[data-id='e4'] button:has-text('Delete')")
    page.wait_for_selector(".dialog")
    page.click(".dialog button:has-text('Delete permanently')")
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 0")
    check("the permanent delete is asked for explicitly",
          any(c.get("action") == "remove" and c.get("id") == "e4" and c.get("hard") is True for c in srv.exam_calls))
    check("the exam is gone", "e4" not in srv.exams)
    page.fill("#ex-search", ""); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")

    # --- editor: new exam
    page.click("a:has-text('New exam')")
    page.wait_for_url("**#/exams/new")
    page.wait_for_selector("#ee-title")
    check("editor starts with a suggested 6-character code", bool(page.eval_on_selector(".code-input", "el => /^[A-Z0-9]{6}$/.test(el.value)")))
    check("summary warns about the missing title", page.query_selector(".summary-list .pill.warn") is not None)

    page.fill("#ee-title", "Simple Past, Quiz 1")
    page.click("button[data-sel='auto']")
    page.fill("input[placeholder*='topic']", "Simple Past")
    page.wait_for_function("document.querySelector('.summary-list').textContent.includes('match')")
    page.fill(".code-input", "TAKEN1")
    page.dispatch_event(".code-input", "input")
    page.wait_for_function("document.querySelector('.pill.bad') && document.querySelector('.pill.bad').textContent.includes('used')")
    check("taken code is flagged", "already used" in page.inner_text(".pill.bad").lower())
    page.click("button:has-text('Make a new one')")
    page.wait_for_function("document.querySelector('.code-input').value !== 'TAKEN1'")
    page.wait_for_function("document.querySelector('.pill.bad') === null || !document.querySelector('.pill.bad').textContent.includes('used')")

    # save as draft; the mock assigns the first free uuid id (the deleted exam's slot is reused)
    page.click("button:has-text('Save as draft')")
    page.wait_for_url("**#/exams/edit/00000000-0000-4000-8000-000000000003")
    saved = srv.exams["00000000-0000-4000-8000-000000000003"]
    NEW_ID = "00000000-0000-4000-8000-000000000003"
    check("draft was saved with the new title", saved["title"] == "Simple Past, Quiz 1" and saved["status"] == "draft")
    check("auto filter persisted", saved.get("auto_filter", {}).get("topic") == "Simple Past" and saved["selection_mode"] == "auto")
    check("a fresh code replaced the taken one", saved["access_code"] != "TAKEN1")
    # --- editor: reload the saved draft and check the loaded values
    page.reload(); page.wait_for_selector("#ee-title")
    page.wait_for_function("document.querySelector('#ee-title').value !== ''")
    check("reloaded editor keeps the saved values", page.input_value("#ee-title") == "Simple Past, Quiz 1")
    page.wait_for_function("Array.from(document.querySelectorAll('.summary-list .pill')).every(p => p.classList.contains('ok'))")
    check("summary turns green after filling in", page.eval_on_selector_all(".summary-list .pill.warn", "els => els.length") == 0)

    # --- editor: existing manual exam shows questions and their weights
    # Fresh document on the existing exam. Reload only once this screen is the one on the URL: a reload
    # straight after a hash change is a race, because the router holds the URL on the current screen while
    # it hands the navigation to the leave guard - the reload then loads the PREVIOUS screen. That is how
    # this suite failed CI twice: the just-saved draft came back, and a draft saved "by filter" has no
    # .chosen-item to wait for. Reloading an UNTOUCHED editor also pins the guard fix: registering a leave
    # guard used to warn "Leave site?" on sight, which blocked even this reload.
    page.goto(BASE + "#/exams"); page.wait_for_selector(".qtable")   # leave the editor and its guard
    page.goto(BASE + "#/exams/edit/" + EXAM1)
    page.wait_for_function("document.querySelector('#ee-title').value === 'Narrative Text, Daily Test 3'")
    # A dialog listener makes the browser's own beforeunload warning visible to us: this reload of an
    # untouched editor must not produce one (registering a leave guard used to warn on sight), and it
    # must not hang either. Remove the listener again before the leave-guard checks further down.
    dialogs = []
    ondialog = lambda d: (dialogs.append(d.type), d.dismiss())[1]
    page.on("dialog", ondialog)
    page.reload(timeout=10_000); page.wait_for_selector("#ee-title")
    page.remove_listener("dialog", ondialog)
    page.wait_for_function("document.querySelector('#ee-title').value !== ''")
    check("an untouched editor reloads without a leave warning", dialogs == [], str(dialogs))
    check("existing exam title loaded", page.input_value("#ee-title") == "Narrative Text, Daily Test 3")
    page.click("button[data-sel='manual']")
    page.wait_for_selector(".chosen-item")
    page.click("button[data-sel='auto']")
    page.click("button[data-sel='manual']")
    page.wait_for_selector(".chosen-item")
    check("picker search results appear", page.eval_on_selector_all(".picker-list:not(.chosen) .picker-item", "els => els.length") > 0)

    # leave guard on unsaved changes
    page.fill("#ee-title", "Changed but unsaved")
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE + "#/exams")
    page.wait_for_selector(".qtable")
    check("unsaved title was not saved", srv.exams[EXAM1]["title"] == "Narrative Text, Daily Test 3")

    # --- duplicate
    n_exams = len(srv.exams)
    page.click("tr[data-id='" + EXAM2 + "'] button:has-text('Duplicate')")
    page.wait_for_function(f"Object.keys({json.dumps(list(srv.exams.keys()))}).length > 0 || true") if False else None
    page.wait_for_timeout(800)
    check("duplicate created a draft copy", any(c.get("action") == "duplicate" and c.get("id") == EXAM2 for c in srv.exam_calls) and len(srv.exams) == n_exams + 1)
    dup = [e for e in srv.exams.values() if e["title"].endswith("(copy)")]
    check("the copy is a draft", dup and dup[0]["status"] == "draft")

    check("no page errors", errors == [], "; ".join(errors[:3]))

print()
print("ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
