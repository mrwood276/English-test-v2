"""Browser test of the admin backups screen with a mocked server (TASK-015).
Run: python frontend/tests/backups_e2e.py  (expects dev-server on 8123)
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


def wait_for_text(page, selector, text):
    """Toasts (and status lines) can appear a tick after the click, so wait for the words."""
    page.wait_for_function(f"t => (document.querySelector({selector!r}) || {{}}).innerText?.includes(t)", arg=text)


srv = Server()
opened = []   # every address the browser tried to fetch, so a Download can be followed to Storage

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1200, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.on("request", lambda r: opened.append(r.url) if "storage.test" in r.url else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.route("https://storage.test/**", lambda r: r.fulfill(status=200, body="PK", headers={
        "content-type": "application/zip", "content-disposition": 'attachment; filename="backup.zip"'}))

    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/backups")
    page.reload()
    page.wait_for_selector(".qtable tbody tr")

    # ---------- the menu and the heading ----------
    check("the admin menu links to the backups",
          page.query_selector(".nav a[data-route='#/backups']") is not None
          and page.inner_text(".nav a[data-route='#/backups']") == "Backups")
    check("the menu marks the backups as current",
          page.get_attribute(".nav a[data-route='#/backups']", "aria-current") == "page")
    check("the heading is the backups", page.inner_text("h1") == "Backups")
    check("the count of copies is under the heading", page.inner_text(".head .sub") == "2 backups",
          page.inner_text(".head .sub"))
    caption = page.inner_text(".cap2")
    check("the screen explains what a copy holds and when it runs",
          "every question, exam, attempt, result and audit row" in caption and "02:41" in caption
          and "last seven" in caption, caption)

    # ---------- the table ----------
    rows = page.query_selector_all(".qtable tbody tr")
    check("both copies are listed", len(rows) == 2, str(len(rows)))
    heads = [th.inner_text() for th in page.query_selector_all(".qtable th")]
    check("the column headers are the four facts", heads[:4] == ["When", "Kind", "Size", "Made by"], str(heads))
    nightly = page.query_selector("tr[data-kind='automatic']")
    manual = page.query_selector("tr[data-kind='manual']")
    check("the newest copy is the nightly one, first",
          rows[0].get_attribute("data-id") == "bk-1", rows[0].inner_text())
    check("a nightly copy is labelled Nightly and made by the job",
          "Nightly" in nightly.inner_text() and "Nightly job" in nightly.inner_text(), nightly.inner_text())
    check("the nightly size is shown in megabytes", "3.4 MB" in nightly.inner_text(), nightly.inner_text())
    check("a manual copy is labelled Manual and names the admin",
          "Manual" in manual.inner_text() and "Admin" in manual.inner_text(), manual.inner_text())
    check("the manual size is shown in kilobytes", "44 kB" in manual.inner_text(), manual.inner_text())
    check("each row carries the exact timestamp in its title",
          page.get_attribute("tr[data-id='bk-2'] td", "title") == "2026-09-25T09:15:00Z")

    # ---------- download: ask the server, then follow its link ----------
    page.click("tr[data-id='bk-2'] button:has-text('Download')")
    for _ in range(50):
        if opened:
            break
        page.wait_for_timeout(100)
    check("Download asks the server for one copy",
          srv.backup_calls[-1] == {"action": "download", "id": "bk-2"}, str(srv.backup_calls[-1]))
    check("the browser then opens the signed link the server gave",
          opened and opened[0].startswith("https://storage.test/signed/20260925T091500Z_manual_2222bbbb.zip"),
          str(opened[:1]))
    check("the button comes back after the download",
          page.get_attribute("tr[data-id='bk-2'] button:has-text('Download')", "disabled") is None)

    # ---------- delete: it asks first ----------
    page.click("tr[data-id='bk-2'] button:has-text('Delete')")
    page.wait_for_selector(".dialog")
    dialog = page.inner_text(".dialog")
    check("Delete asks before removing anything",
          "Delete this backup?" in dialog and "cannot be undone" in dialog, dialog)
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_function("document.querySelector('.dialog') === null")
    check("cancelling keeps the copy and tells the server nothing",
          len(page.query_selector_all(".qtable tbody tr")) == 2
          and not any(c.get("action") == "delete" for c in srv.backup_calls))

    page.click("tr[data-id='bk-2'] button:has-text('Delete')")
    page.wait_for_selector(".dialog")
    page.click(".dialog button:has-text('Delete')")
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    check("agreeing removes the row from the table",
          page.query_selector("tr[data-id='bk-2']") is None)
    check("the count follows the removal", page.inner_text(".head .sub") == "1 backup",
          page.inner_text(".head .sub"))
    check("the server was asked to delete that one copy",
          {"action": "delete", "id": "bk-2"} in srv.backup_calls and all(b["id"] != "bk-2" for b in srv.backups))
    wait_for_text(page, ".toasts", "Backup deleted")
    check("the deletion is confirmed with a message", "Backup deleted" in page.inner_text(".toasts"))

    # ---------- making one by hand ----------
    page.click("#bk-create")
    wait_for_text(page, ".toasts", "Backup created")
    check("the toast says what was made: size and file count",
          "Backup created (45 kB, 3 files)" in page.inner_text(".toasts"), page.inner_text(".toasts"))
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 2")
    check("the new copy appears at the top, marked manual",
          page.query_selector(".qtable tbody tr").get_attribute("data-kind") == "manual"
          and "Admin" in page.inner_text(".qtable tbody tr"))
    check("the count goes up", page.inner_text(".head .sub") == "2 backups", page.inner_text(".head .sub"))
    check("the button is ready again for the next copy",
          page.inner_text("#bk-create") == "Create backup now"
          and page.get_attribute("#bk-create", "disabled") is None)
    check("the screen never claims a kind: the server decides manual or nightly",
          all("kind" not in c for c in srv.backup_calls))

    # ---------- a copy that could not hold every file says so ----------
    srv.backup_note = "1 file could not be added: it is over the archive size limit"
    srv.backup_pruned = 2
    page.click("#bk-create")
    wait_for_text(page, ".toasts", "could not be added")
    toasts = page.inner_text(".toasts")
    check("a copy missing files warns instead of passing silently",
          "1 file could not be added" in toasts and "over the archive size limit" in toasts, toasts)
    check("the toast says how many older nightly copies went",
          "2 older nightly copies were removed" in toasts, toasts)
    check("a warning is not dressed up as success",
          page.query_selector(".toasts .toast.warn") is not None)

    # ---------- a failed copy ----------
    srv.fail_backup = True
    page.click("#bk-create")
    wait_for_text(page, ".toasts", "Something went wrong")
    check("a failed copy reports the error", "Something went wrong. Please try again." in page.inner_text(".toasts"))
    check("a failed copy leaves the list and the button untouched",
          page.inner_text(".head .sub") == "3 backups"
          and page.inner_text("#bk-create") == "Create backup now"
          and page.get_attribute("#bk-create", "disabled") is None)
    srv.fail_backup = False

    # ---------- nothing stored yet ----------
    srv.backups = []
    page.reload()
    page.wait_for_selector(".list-status:has-text('No backups yet.')")
    check("an empty screen says what to do", "No backups yet. Make one before the next exam." in page.inner_text(".list-status"))
    check("an empty screen counts zero", page.inner_text(".head .sub") == "0 backups"
          and len(page.query_selector_all(".qtable tbody tr")) == 0)
    check("an empty screen still offers the button", page.query_selector("#bk-create") is not None)

    # ---------- a teacher: no menu entry, and the door stays shut ----------
    creates_before = len([c for c in srv.backup_calls if c.get("action") == "create"])
    srv.role = "teacher"
    page.reload()
    page.wait_for_selector(".list-status.error")
    check("a teacher is not offered the backups in the menu",
          page.query_selector(".nav a[data-route='#/backups']") is None
          and len(page.query_selector_all(".nav a")) == 6, str(len(page.query_selector_all(".nav a"))))
    check("a teacher who lands on the screen by hand is refused",
          "You do not have access to this." in page.inner_text(".list-status"), page.inner_text(".list-status"))
    page.click("#bk-create")
    wait_for_text(page, ".toasts", "do not have access")
    check("a teacher cannot make a copy through the screen either",
          srv.backup_calls[-1] == {"action": "create"} and srv.backups == []
          and "You do not have access to this." in page.inner_text(".toasts"), str(srv.backup_calls[-1]))

    # ---------- what the screen asked the server ----------
    actions = [c.get("action") for c in srv.backup_calls]
    check("the screen only ever used the four backup actions",
          set(actions) <= {"list", "create", "download", "delete"} and len(actions) > 0, str(sorted(set(actions))))
    check("every action was exercised", set(actions) == {"list", "create", "download", "delete"}, str(sorted(set(actions))))
    check("the list is asked for a page of 100", any(c.get("limit") == 100 for c in srv.backup_calls))

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(failures)} failed" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
