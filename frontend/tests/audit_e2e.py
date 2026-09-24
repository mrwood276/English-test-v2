"""Browser test of the admin audit-log viewer with a mocked server (TASK-015).
Run: python frontend/tests/audit_e2e.py  (expects dev-server on 8123)
"""
import sys, time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


srv = Server()
srv.audit_seed()

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1200, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/audit")
    page.reload()
    page.wait_for_selector(".qtable tbody tr")

    # ---------- the menu and the heading ----------
    check("the admin menu links to the audit log",
          page.query_selector(".nav a[data-route='#/audit']") is not None
          and page.inner_text(".nav a[data-route='#/audit']") == "Audit log")
    check("the menu marks the audit log as current",
          page.get_attribute(".nav a[data-route='#/audit']", "aria-current") == "page")
    check("the heading is the audit log", page.inner_text("h1") == "Audit log")
    check("the count of events is under the heading", page.inner_text(".head .sub") == "6 events",
          page.inner_text(".head .sub"))

    # ---------- the table ----------
    rows = page.query_selector_all(".qtable tbody tr")
    check("six events are listed", len(rows) == 6, str(len(rows)))
    first = rows[0].inner_text()
    check("the newest event is first", "passage.update" in first, first)
    last = rows[5].inner_text()
    check("the 40-day-old retake is last", "retake_grant" in last, last)
    who = page.inner_text(".qtable tbody")
    check("actors are named", "Ms. Rina" in who and "Admin" in who)
    check("a row without an actor says System", who.count("System") == 1, who)
    heads = [th.inner_text() for th in page.query_selector_all(".qtable th")]
    check("the column headers are the five facts", heads == ["When", "Who", "Action", "Entity", "Details"], str(heads))
    check("the change details are shown", '"minutes":5' in who, who)
    pager = page.inner_text(".pager")
    check("the pager counts everything", "Showing 1 to 6 of 6" in pager, pager)
    check("both pager buttons rest on one page",
          page.get_attribute(".pager button[aria-label='Previous page']", "disabled") is not None
          and page.get_attribute(".pager button[aria-label='Next page']", "disabled") is not None)

    # ---------- filters ----------
    page.fill("#al-action", "grade")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '2 events'")
    check("the action filter narrows the list", len(page.query_selector_all(".qtable tbody tr")) == 2)

    page.fill("#al-action", "zzz")
    page.wait_for_selector(".list-status:has-text('Nothing matches these filters.')")
    check("a filter without matches says so",
          "Nothing matches these filters." in page.inner_text(".list-status")
          and page.query_selector(".list-status button:has-text('Clear filters')") is not None)

    page.click(".toolbar button:has-text('Clear')")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '6 events'")
    check("clearing the filters brings everything back",
          len(page.query_selector_all(".qtable tbody tr")) == 6
          and page.input_value("#al-action") == "")

    page.fill("#al-entity", "question")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '1 event'")
    check("the entity filter narrows the list", "question.create" in page.inner_text(".qtable tbody"))
    page.click(".toolbar button:has-text('Clear')")

    page.select_option("#al-days", "7")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '5 events'")
    check("the time window drops the old row", "retake_grant" not in page.inner_text(".qtable tbody"))
    page.select_option("#al-days", "")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '6 events'")
    check("all time brings the old row back", "retake_grant" in page.inner_text(".qtable tbody"))

    # ---------- paging ----------
    srv.audit_rows += [{"id": 100 + i, "created_at": f"2026-09-24T0{i // 10}:{i % 60:02d}:00Z", "actor_id": "u1", "actor_name": "Admin",
                        "action": "media.upload", "entity_type": "media", "entity_id": f"m-{i}", "changes": {}}
                       for i in range(24)]
    page.click(".toolbar button:has-text('Clear')")  # reloads page one against the bigger list
    page.wait_for_function("document.querySelector('.head .sub').textContent === '30 events'")
    check("the pager slices the list into pages",
          len(page.query_selector_all(".qtable tbody tr")) == 25
          and "Showing 1 to 25 of 30" in page.inner_text(".pager"))
    page.click(".pager button[aria-label='Next page']")
    page.wait_for_function("document.querySelector('.pager').textContent.includes('Showing 26 to 30 of 30')")
    check("the second page has the rest",
          len(page.query_selector_all(".qtable tbody tr")) == 5)
    page.click(".pager button[aria-label='Previous page']")
    page.wait_for_function("document.querySelector('.pager').textContent.includes('Showing 1 to 25 of 30')")
    check("going back lands on the first page",
          len(page.query_selector_all(".qtable tbody tr")) == 25)

    # ---------- what the screen asked the server ----------
    check("the screen only ever asks to list",
          all(c.get("action") == "list" for c in srv.audit_calls) and len(srv.audit_calls) > 0)
    check("the days filter went through as a number",
          any(c.get("days") == 7 for c in srv.audit_calls))

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(failures)} failed" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
