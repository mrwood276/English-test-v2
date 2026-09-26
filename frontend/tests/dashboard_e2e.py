"""Browser test of the teacher dashboard with a mocked server (TASK-014).
Run: python frontend/tests/dashboard_e2e.py  (expects dev-server on 8123)
"""
import sys, time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
CODE = "DASH01"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


srv = Server()
exam = srv.session_exam(CODE)
srv.open_exam_row(CODE)
EXAM_ID = exam["id"]
by_type = {q["type"]: q for q in exam["questions"]}
mc, tf, sa, es = by_type["multiple_choice"], by_type["true_false"], by_type["short_answer"], by_type["essay"]
right_mc = next(o["body"] for o in mc["options"] if o["is_correct"])
right_tf = next(o["body"] for o in tf["options"] if o["is_correct"])
all_right = {mc["question_id"]: right_mc, tf["question_id"]: right_tf,
             sa["question_id"]: "past", es["question_id"]: "Orientation."}

# Aisyah is final and passed; Bima/Citra are working; Dimas still has an essay to grade.
sid_a = srv.results_seed(CODE, "Aisyah Putri", "XII TKJ A", all_right)
srv.manual_grades[(sid_a, es["question_id"])] = {"points": es["weight"], "feedback": "Good."}
srv.session_grade(sid_a, "submitted")
sid_b = srv.results_seed(CODE, "Bima Saputra", "XII TKJ A",
                          {mc["question_id"]: right_mc, tf["question_id"]: right_tf},
                          status="in_progress", tab_switch_count=2)
sid_c = srv.results_seed(CODE, "Citra Lestari", "XII TKJ B", {mc["question_id"]: right_mc},
                         status="in_progress", tab_switch_count=3)
srv.sessions[sid_c]["last_heartbeat_at"] = time.time() - 5
sid_d = srv.results_seed(CODE, "Dimas Pratama", "XII TKJ B", all_right)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="http://127.0.0.1:8123")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/dashboard")
    page.reload()
    page.wait_for_selector(".now")

    # ---------- header and "Open now" ----------
    check("the dashboard is the heading", page.inner_text("h1") == "Dashboard")
    check("today's date is under the heading", page.inner_text(".head .sub") != "")
    check("the new-exam action is in the header", page.query_selector(".head a[href='#/exams/new']") is not None)
    check("the big test code is written for the board", page.inner_text(".bigcode") == CODE)
    check("the exam title is shown", exam["title"] in page.inner_text(".now"))
    check("the exam facts are one short line",
          "4 questions" in page.inner_text(".now-meta") and "45 minutes" in page.inner_text(".now-meta"),
          page.inner_text(".now-meta"))
    check("the open card offers copy, change and close",
          page.query_selector(".now button:has-text('Copy code')") is not None
          and page.query_selector(".now button:has-text('Change code')") is not None
          and page.query_selector(".now button:has-text('Close exam')") is not None)
    check("the live count says who is working", "2 of 4 working" in page.inner_text(".now-count"))
    check("both classes are shown", len(page.query_selector_all(".now-count .pill.plain")) == 2,
          page.inner_text(".now-count"))
    live = page.inner_text(".now-r")
    check("the preview lists the working students first",
          live.index("Bima Saputra") < live.index("Citra Lestari") < live.index("Aisyah Putri"), live)
    check("Bima is warned for leaving the page", "Left the page" in live)
    check("Citra is flagged for many page exits", "Need a look" in live)
    check("the finished students are visible too", "Aisyah Putri" in live and "Dimas Pratama" in live)
    check("the full monitor is one click away",
          page.query_selector(f".now a[href='#/monitor/{EXAM_ID}']") is not None)

    # ---------- Notifications ----------
    notifications = page.locator('section[aria-label="Notifications"]')
    check("dashboard notifications are shown", notifications.count() == 1)
    notification_text = notifications.inner_text()
    check("notifications surface the essay work", "essay needs grading" in notification_text, notification_text)
    check("notifications surface the suspicious session", "session needs review" in notification_text, notification_text)
    check("notifications link to grading", page.query_selector(f'section[aria-label="Notifications"] a[href="#/grading/{EXAM_ID}"]') is not None)
    check("notifications link to the monitor", page.query_selector(f'section[aria-label="Notifications"] a[href="#/monitor/{EXAM_ID}"]') is not None)
    check("notifications link to results", page.query_selector(f'section[aria-label="Notifications"] a[href="#/results/{EXAM_ID}"]') is not None)
    page.click("#mark-notifications-read")
    check("mark all read removes the new count", "new" not in notifications.locator("h2").inner_text())
    check("read notifications stay visible", "essay needs grading" in notifications.inner_text())

    # ---------- "Needs your attention" ----------
    attention = page.inner_text('section[aria-label="Needs your attention"]')
    check("the essay queue is surfaced", "1 essay to grade" in attention, attention)
    check("the suspicious session is surfaced", "1 session has many page exits" in attention, attention)
    check("grading goes to the existing grading screen",
          page.query_selector(f"section[aria-label='Needs your attention'] a[href='#/grading/{EXAM_ID}']") is not None)
    check("review goes to the existing monitor",
          page.query_selector(f"section[aria-label='Needs your attention'] a[href='#/monitor/{EXAM_ID}']") is not None)

    # ---------- "Recent exams" ----------
    recent = page.inner_text('section[aria-label="Recent exams"]')
    check("the recent exam links to results",
          page.query_selector(f"section[aria-label='Recent exams'] a[href='#/results/{EXAM_ID}']") is not None)
    check("the recent exam shows the average and student count",
          "Average 80" in recent and "2 students" in recent, recent)
    check("the pass meter shows the decided result", "100% passed" in recent, recent)
    check("the meter is full for one passed result",
          page.get_attribute('section[aria-label="Recent exams"] .meter i', "style") == "width:100%",
          page.get_attribute('section[aria-label="Recent exams"] .meter i', "style"))
    check("the empty states are not shown while there is data",
          "No exam is open right now" not in page.inner_text(".main")
          and "Nothing needs you right now" not in attention
          and "No exam has been taken yet" not in recent)

    # ---------- actions: clipboard works; the dangerous ones ask first and can be cancelled ----------
    page.click(".now button:has-text('Copy code')")
    page.wait_for_selector(".toast")
    check("copying the code confirms it", "Test code copied." in page.inner_text(".toasts"))
    check("the code really reached the clipboard", page.evaluate("navigator.clipboard.readText()") == CODE)

    page.click(".now button:has-text('Change code')")
    page.wait_for_selector(".dialog")
    check("changing the code asks first", "Change the test code?" in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_selector(".dialog", state="detached")
    check("cancelled change leaves the code alone",
          not any(c.get("action") == "regenerate_code" for c in srv.exam_calls)
          and page.inner_text(".bigcode") == CODE)

    page.click(".now button:has-text('Close exam')")
    page.wait_for_selector(".dialog")
    check("closing asks first and says what happens",
          "Close this exam?" in page.inner_text(".dialog")
          and "Sessions in progress keep their time" in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_selector(".dialog", state="detached")
    check("cancelled close leaves the exam open",
          not any(c.get("action") == "set_status" for c in srv.exam_calls)
          and page.query_selector(".now") is not None)

    # ---------- phone width ----------
    page.set_viewport_size({"width": 375, "height": 700})
    check("the dashboard fits a phone", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    nav_box = page.locator(".nav").bounding_box()
    check("the phone menu is one compact row", nav_box is not None and nav_box["height"] <= 48,
          str(nav_box))
    check("the phone menu scrolls inside itself, not the page",
          page.evaluate("getComputedStyle(document.querySelector('.nav')).overflowX") in ("auto", "scroll")
          and page.evaluate("getComputedStyle(document.querySelector('.nav')).flexWrap") == "nowrap")
    check("the signed-in person stays visible on a phone", page.is_visible(".me"))

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(failures)} failed" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
