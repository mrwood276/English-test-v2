"""Browser test of the notification bell with a mocked server (TASK-015, DEC-017).
Run: python frontend/tests/notifications_e2e.py  (expects dev-server on 8123)
"""
import sys, time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
from e2e_harness import Suite

suite = Suite("notifications_e2e", base=BASE)
suite.install()          # a crash reports itself (CRASH block + log, exit 2) - ISSUE-039
check = suite.check      # the suite's own check(), now counted and located


def wait_hidden(page, selector):
    page.wait_for_function(f"() => !document.querySelector({selector!r}) || document.querySelector({selector!r}).hidden")


srv = Server()

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    suite.watch(page, errors)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)

    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/dashboard")
    page.reload()
    page.wait_for_selector(".shell")

    # ---------- the badge, before anything is opened ----------
    page.wait_for_function("() => document.querySelector('#notif-bell') && !document.querySelector('#notif-bell .notif-badge').hidden")
    check("the bell sits in the shell, outside the menu", page.query_selector(".nav #notif-bell") is None)
    check("the badge counts the four unread cards", page.inner_text("#notif-bell .notif-badge") == "4",
          page.inner_text("#notif-bell .notif-badge"))
    check("the badge says what it counts", page.get_attribute("#notif-bell .notif-badge", "title") == "4 unread notifications")
    check("the bell starts closed", page.get_attribute("#notif-bell", "aria-expanded") == "false")
    check("the first load was one list call", [c["action"] for c in srv.notif_calls] == ["list"], str(srv.notif_calls))

    # ---------- opening the bell ----------
    page.click("#notif-bell")
    page.wait_for_selector(".notif-panel:not([hidden])")
    check("the bell opens", page.get_attribute("#notif-bell", "aria-expanded") == "true")
    check("opening marked it read on the server",
          [c["action"] for c in srv.notif_calls] == ["list", "mark_read"], str(srv.notif_calls))
    check("the panel says everything is read now", "all read" in page.inner_text(".notif-head"))
    check("the badge went quiet after the read mark", page.get_attribute("#notif-bell .notif-badge", "hidden") is not None)

    check("the panel groups the news under three kinds",
          [t.inner_text().lower() for t in page.query_selector_all(".notif-kind")] == ["essays to grade", "exams worth a look", "system"],
          str([t.inner_text() for t in page.query_selector_all(".notif-kind")]))

    essays = page.query_selector_all("a.notif-row[href='#/grading/e-1']")
    check("an essay card links to the grading of that exam", len(essays) == 1)
    if essays:
        t = essays[0].inner_text()
        check("the essay card names the exam, the count and the student",
              "Past Tense Quiz" in t and "2 waiting" in t and "Dina (XII TKJ A)" in t, t)
        check("the essay card is marked with a warning pill", essays[0].query_selector(".notif-pill-warn") is not None)

    susp = page.query_selector_all("a.notif-row[href='#/monitor/e-2']")
    check("a suspicious card links to the monitor of that exam", len(susp) == 1)
    if susp:
        t = susp[0].inner_text()
        check("the suspicious card names the exam, the events and the attempts",
              "Narrative Test" in t and "3 events" in t and "2 attempts" in t, t)
        check("the suspicious card is marked with a danger pill", susp[0].query_selector(".notif-pill-bad") is not None)

    bks = page.query_selector_all("a.notif-row[href='#/backups']")
    check("the newest backup is announced and links to the backups", len(bks) == 1)
    if bks:
        check("the backup card says which kind ran and who", "Nightly backup finished" in bks[0].inner_text()
              and "by the nightly job" in bks[0].inner_text(), bks[0].inner_text())

    accts = page.query_selector_all("a.notif-row[href='#/accounts']")
    check("a created account is announced and links to the accounts", len(accts) == 1)
    if accts:
        t = accts[0].inner_text()
        check("the account card names the person and the password hand-over",
              "Ms. Dewi" in t and "hand over the password" in t, t)

    check("the panel says email summaries are not switched on yet",
          "Email summaries are not switched on yet" in page.inner_text(".notif-foot"))

    # ---------- closing ----------
    page.mouse.click(640, 400)  # outside the panel
    wait_hidden(page, ".notif-panel")
    check("clicking outside closes the bell", page.get_attribute("#notif-bell", "aria-expanded") == "false")

    # navigating closes the bell and re-counts
    page.click("#notif-bell")
    page.wait_for_selector(".notif-panel:not([hidden])")
    page.evaluate("location.hash = '#/exams'")
    wait_hidden(page, ".notif-panel")
    check("navigating closes the bell", page.get_attribute("#notif-bell", "aria-expanded") == "false")
    page.wait_for_function("document.querySelectorAll('.notif-row').length > 0")
    check("navigation re-reads the bell", [c["action"] for c in srv.notif_calls].count("list") == 2, str(srv.notif_calls))

    # a screen that changes results tells the bell too (the calls land in this Python process, so poll here)
    before = len(srv.notif_calls)
    page.evaluate("window.dispatchEvent(new CustomEvent('staff:results-changed'))")
    deadline = time.time() + 5
    while len(srv.notif_calls) <= before and time.time() < deadline:
        page.wait_for_timeout(50)
    check("grading news refreshes the bell without a reload",
          len(srv.notif_calls) == before + 1 and srv.notif_calls[-1]["action"] == "list", str(srv.notif_calls[-1]))

    # ---------- a teacher's bell: the teacher half only ----------
    srv.role = "teacher"
    srv.notif_read = False  # a different person, who has never opened their bell
    page.reload()
    page.wait_for_selector(".shell")
    page.wait_for_function("() => document.querySelector('#notif-bell') && !document.querySelector('#notif-bell .notif-badge').hidden")
    check("a teacher's badge counts only the teacher news", page.inner_text("#notif-bell .notif-badge") == "2",
          page.inner_text("#notif-bell .notif-badge"))
    page.click("#notif-bell")
    page.wait_for_selector(".notif-panel:not([hidden])")
    kinds = [t.inner_text().lower() for t in page.query_selector_all(".notif-kind")]
    check("a teacher's bell has essays and suspicious events", "essays to grade" in kinds and "exams worth a look" in kinds, str(kinds))
    check("a teacher's bell has no system news (backups and accounts are admin screens)",
          "System" not in kinds and page.query_selector(".notif-row a[href='#/backups']") is None
          and page.query_selector(".notif-row a[href='#/accounts']") is None, str(kinds))
    check("the teacher menu still has six links and no bell inside it",
          len(page.query_selector_all(".nav a")) == 6 and page.query_selector(".nav #notif-bell") is None)

    # ---------- what the screen asked the server ----------
    actions = [c.get("action") for c in srv.notif_calls]
    check("the bell only ever used the two actions", set(actions) <= {"list", "mark_read"} and set(actions) == {"list", "mark_read"},
          str(sorted(set(actions))))

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

suite.finish()
