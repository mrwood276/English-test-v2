"""Browser test of the live monitor screens with a mocked server (TASK-013).
Run: python frontend/tests/monitor_e2e.py  (expects dev-server on 8123)
"""
import sys, time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
CODE = "MON001"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


srv = Server()
exam = srv.session_exam(CODE)
EXAM_ID = exam["id"]
by_type = {q["type"]: q for q in exam["questions"]}
mc, tf, sa, es = by_type["multiple_choice"], by_type["true_false"], by_type["short_answer"], by_type["essay"]
right_mc = next(o["body"] for o in mc["options"] if o["is_correct"])
right_tf = next(o["body"] for o in tf["options"] if o["is_correct"])

# Aisyah finished; Bima still working with 2 page leaves and 2 answers; Citra offline-ish (3 leaves).
sid_a = srv.results_seed(CODE, "Aisyah Putri", "XII TKJ A",
                          {mc["question_id"]: right_mc, tf["question_id"]: right_tf,
                           sa["question_id"]: "past", es["question_id"]: "Orientation."})
sid_b = srv.results_seed(CODE, "Bima Saputra", "XII TKJ A",
                          {mc["question_id"]: right_mc, tf["question_id"]: right_tf},
                          status="in_progress", tab_switch_count=2)
sid_c = srv.results_seed(CODE, "Citra Lestari", "XII TKJ B",
                          {mc["question_id"]: right_mc},
                          status="in_progress", tab_switch_count=3)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/monitor")
    page.reload()
    page.wait_for_selector(".qtable")

    # ---------- menu ----------
    check("Monitor is a real menu item", page.query_selector("a[data-route='#/monitor']") is not None)
    check("six menu links lead somewhere",
          len(page.query_selector_all(".nav a[data-route]")) == 6,
          str(len(page.query_selector_all(".nav a[data-route]"))))

    # ---------- hub: only exams with people working ----------
    check("the Monitor hub opens", page.inner_text("h1") == "Monitor")
    page.wait_for_function(f"document.querySelector('tr[data-exam=\"{EXAM_ID}\"]') !== null")
    hub_row = page.query_selector(f"tr[data-exam='{EXAM_ID}']")
    check("the open exam is listed", CODE in hub_row.inner_text())
    check("the hub counts who is working", "2" in hub_row.inner_text() and "Working" in page.inner_text("thead"))
    check("Watch opens the exam monitor", hub_row.query_selector("a:has-text('Watch')") is not None)

    hub_row.query_selector("a:has-text('Watch')").click()
    page.wait_for_function(f"location.hash.includes('{EXAM_ID}') && !location.hash.includes('session')")
    page.wait_for_selector(f"tr[data-session='{sid_b}']")

    # ---------- per-exam live table (mockup 12) ----------
    check("the exam title is the heading", exam["title"] in page.inner_text("h1"))
    check("the strip counts working and joined",
          "2" in page.inner_text(".strip") and "3" in page.inner_text(".strip"),
          page.inner_text(".strip"))
    check("Bima is listed while still working", "Bima Saputra" in page.inner_text(".qtable"))
    check("Aisyah is listed after submitting", "Aisyah Putri" in page.inner_text(".qtable"))
    bima = page.query_selector(f"tr[data-session='{sid_b}']")
    check("Bima shows page leaves", "2" in bima.inner_text())
    check("Bima is flagged for leaving the page",
          bima.query_selector(".pill.warn") is not None and "Left the page" in bima.inner_text())
    check("Bima's progress shows answered of total",
          "2/4" in bima.inner_text() or "2/" in bima.inner_text(), bima.inner_text())
    citra = page.query_selector(f"tr[data-session='{sid_c}']")
    check("Citra is flagged (offline or needs a look)",
          citra.query_selector(".pill.bad") is not None
          and ("Need a look" in citra.inner_text() or "Offline" in citra.inner_text()),
          citra.inner_text())
    aisyah = page.query_selector(f"tr[data-session='{sid_a}']")
    check("Aisyah shows a finished status", "Done" in aisyah.inner_text() or "Not final" in aisyah.inner_text() or "Passed" in aisyah.inner_text() or "Failed" in aisyah.inner_text())

    # ---------- one-session timeline ----------
    bima.query_selector("a:has-text('Open')").click()
    page.wait_for_function(f"location.hash.includes('{sid_b}')")
    page.wait_for_selector("[data-add-time], .events, .monitor-events, .card.sec")
    check("the session screen names the student", "Bima Saputra" in page.inner_text("h1"))
    check("the session shows page leaves in the strip", "page leave" in page.inner_text(".strip"))
    check("history lists page-leave events",
          "Left the page" in page.inner_text(".card") or "Left the page" in page.inner_text(".events")
          or "Left the page" in page.inner_text(".pill"),
          page.inner_text(".main")[:400])
    check("add time is available while they work", page.query_selector("[data-add-time]") is not None)
    before = page.inner_text(".strip")
    page.select_option("#monitor-add-time", "5")
    page.click("[data-add-time]")
    page.wait_for_timeout(400)
    check("add time was sent",
          any(c.get("action") == "add_time" and c.get("session_id") == sid_b for c in srv.result_calls),
          str(srv.result_calls[-3:]))
    check("full report link is present",
          page.query_selector(f"a[href='#/results/{EXAM_ID}/session/{sid_b}']") is not None)

    # ---------- the exam-wide action: more time for everyone still working ----------
    page.goto(BASE + f"#/monitor/{EXAM_ID}")
    page.wait_for_selector("[data-add-all]")
    check("the board offers time for the whole exam", page.query_selector("#monitor-add-all") is not None)
    page.select_option("#monitor-add-all", "5")
    page.click("[data-add-all]")
    page.wait_for_selector(".dialog")
    check("giving everyone time asks first",
          "Add time to everyone" in page.inner_text(".dialog"), page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Add time')")
    page.wait_for_function("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Time added for 2'))")
    check("the whole-exam action reached the backend",
          any(c.get("action") == "add_exam_time" and c.get("minutes") == 5 for c in srv.result_calls),
          str(srv.result_calls[-3:]))
    # Bima already had five minutes of his own earlier in this suite, so he now holds ten; Citra's five
    # are her first, which is what makes this an exam-wide action rather than a second single one.
    check("every working student got the five minutes",
          srv.sessions[sid_b].get("extra_seconds") == 600 and srv.sessions[sid_c].get("extra_seconds") == 300,
          str((srv.sessions[sid_b].get("extra_seconds"), srv.sessions[sid_c].get("extra_seconds"))))
    check("the finished attempt was not touched", srv.sessions[sid_a].get("extra_seconds") in (None, 0),
          str(srv.sessions[sid_a].get("extra_seconds")))
    page.wait_for_selector(f"tr[data-session='{sid_b}']")
    check("the table still reads after the action", "Bima Saputra" in page.inner_text(".qtable"))

    # ---------- empty hub when nobody is working ----------
    page.goto(BASE + "#/monitor")
    # Force no in-progress by grading/submitting remaining — simpler: wipe sessions
    for sid in list(srv.sessions):
        if srv.sessions[sid]["status"] == "in_progress":
            srv.session_grade(sid, "submitted")
    page.reload()
    page.wait_for_selector(".list-status, .qtable")
    check("empty hub explains itself",
          "No exam has students working" in page.inner_text(".main"),
          page.inner_text(".main")[:200])

    # with nobody working, the exam-wide control says so instead of failing on click
    page.goto(BASE + f"#/monitor/{EXAM_ID}")
    page.wait_for_selector("[data-add-all]")
    check("the exam-wide control is disabled when nobody is working",
          page.query_selector("[data-add-all]").is_disabled(),
          "button still enabled with no running attempts")

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(failures)} failed" if failures else f"\nAll checks passed ({0 if failures else 'ok'})")
# count passes roughly
sys.exit(1 if failures else 0)
