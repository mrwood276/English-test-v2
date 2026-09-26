"""Browser test of the admin accounts screen with a mocked server (TASK-015).
Run: python frontend/tests/accounts_e2e.py  (expects dev-server on 8123)
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
    """Dialogs and toasts appear a tick after the click, so wait for the words."""
    page.wait_for_function(f"t => (document.querySelector({selector!r}) || {{}}).innerText?.includes(t)", arg=text)


srv = Server()

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)

    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/accounts")
    page.reload()
    page.wait_for_selector(".qtable tbody tr")

    # ---------- the menu and the heading ----------
    check("the admin menu links to the accounts",
          page.query_selector(".nav a[data-route='#/accounts']") is not None
          and page.inner_text(".nav a[data-route='#/accounts']") == "Accounts")
    check("the menu marks the accounts as current",
          page.get_attribute(".nav a[data-route='#/accounts']", "aria-current") == "page")
    check("the heading is the accounts", page.inner_text("h1") == "Accounts")
    check("the count of accounts is under the heading", page.inner_text(".head .sub") == "3 accounts",
          page.inner_text(".head .sub"))
    caption = page.inner_text(".cap2")
    check("the screen explains that accounts are deactivated, never deleted",
          "deactivated, never deleted" in caption and "last admin cannot be removed" in caption, caption)

    # ---------- the table ----------
    rows = page.query_selector_all(".qtable tbody tr")
    check("every account is listed", len(rows) == 3, str(len(rows)))
    heads = [th.inner_text() for th in page.query_selector_all(".qtable th")]
    check("the column headers are the six facts", heads[:5] == ["Name", "Email", "Role", "Status", "Last signed in"], str(heads))
    me = page.query_selector("tr[data-id='u1']")
    check("the signed-in admin is first and marked as you",
          me is not None and me.get_attribute("data-role") == "admin" and "(you)" in me.inner_text(), me.inner_text() if me else "")
    check("the admin row shows the admin pill and Active",
          "Admin" in me.inner_text() and "Active" in me.inner_text())
    check("the admin cannot deactivate themselves from the screen",
          me.query_selector("button:has-text('Deactivate')") is None and "This is you" in me.inner_text(),
          me.inner_text())
    teacher = page.query_selector("tr[data-id='u2']")
    check("a teacher row shows the teacher pill and the email",
          "Teacher" in teacher.inner_text() and "rina@example.com" in teacher.inner_text(), teacher.inner_text())
    inactive = page.query_selector("tr[data-id='u3']")
    check("a deactivated account says Inactive and shows no last sign-in",
          "Inactive" in inactive.inner_text() and "Never" in inactive.inner_text(), inactive.inner_text())
    check("a deactivated account offers Reactivate, not Deactivate",
          inactive.query_selector("button:has-text('Reactivate')") is not None
          and inactive.query_selector("button:has-text('Deactivate')") is None)

    # ---------- editing ----------
    page.click("tr[data-id='u2'] button:has-text('Edit')")
    page.wait_for_selector(".dialog")
    check("editing opens with what is already there",
          page.input_value("#ac-edit-name") == "Ms. Rina" and page.input_value("#ac-edit-role") == "teacher")
    page.fill("#ac-edit-name", "Ms. Rina Wijaya")
    page.select_option("#ac-edit-role", "admin")
    page.click(".dialog button:has-text('Save')")
    wait_for_text(page, ".toasts", "saved")
    page.wait_for_function("document.querySelector(\"tr[data-id='u2']\").innerText.includes('Ms. Rina Wijaya')")
    check("the rename and the role change land in the row",
          "Admin" in page.inner_text("tr[data-id='u2']"))
    check("the server was told exactly what changed",
          {"action": "update", "id": "u2", "full_name": "Ms. Rina Wijaya", "role": "admin"} in srv.account_calls,
          str(srv.account_calls[-3:]))
    check("the count does not change when somebody is edited", page.inner_text(".head .sub") == "3 accounts")

    # editing yourself cannot change your role
    page.click("tr[data-id='u1'] button:has-text('Edit')")
    page.wait_for_selector(".dialog")
    check("your own role is not editable, and the screen says why",
          page.get_attribute("#ac-edit-role", "disabled") is not None
          and "another admin has to" in page.inner_text(".dialog"), page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_function("document.querySelector('.dialog') === null")

    # ---------- a new password ----------
    page.click("tr[data-id='u3'] button:has-text('New password')")
    page.wait_for_selector(".dialog")
    first = page.input_value("#ac-new-password")
    check("the dialog offers a password ready to hand over", len(first) == 12, first)
    page.click(".dialog button:has-text('Generate another')")
    second = page.input_value("#ac-new-password")
    check("another one can be generated", second != first and len(second) == 12, f"{first} -> {second}")
    page.click(".dialog button:has-text('Set the password')")
    wait_for_text(page, ".dialog", "Hand this password over")
    check("the password is shown once, for handing over",
          page.query_selector("#ac-new-password") is None
          and page.inner_text("#ac-handover-password") == second, page.inner_text("#ac-handover-password"))
    check("the hand-over panel names the account and shows the password",
          "old.teacher@example.com" in page.inner_text(".dialog"))
    check("the server received that password and nothing else",
          {"action": "password", "id": "u3", "password": second} in srv.account_calls, str(srv.account_calls[-2:]))
    page.click(".dialog button:has-text('Done')")
    page.wait_for_function("document.querySelector('.dialog') === null")
    check("a password change does not alter the account row",
          "Inactive" in page.inner_text("tr[data-id='u3']") and page.inner_text(".head .sub") == "3 accounts")

    # ---------- deactivating ----------
    page.click("tr[data-id='u2'] button:has-text('Deactivate')")
    page.wait_for_selector(".dialog")
    dialog_text = page.inner_text(".dialog")
    check("deactivating asks first and says what stays",
          "Deactivate this account?" in dialog_text and "results stay" in dialog_text, dialog_text)
    page.click(".dialog button:has-text('Cancel')")
    page.wait_for_function("document.querySelector('.dialog') === null")
    check("cancelling keeps the account active and tells the server nothing",
          "Active" in page.inner_text("tr[data-id='u2']")
          and not any(c.get("is_active") is False for c in srv.account_calls))

    page.click("tr[data-id='u2'] button:has-text('Deactivate')")
    page.wait_for_selector(".dialog")
    page.click(".dialog button:has-text('Deactivate')")
    wait_for_text(page, ".toasts", "deactivated")
    page.wait_for_function("document.querySelector(\"tr[data-id='u2']\").innerText.includes('Inactive')")
    check("agreeing turns the row Inactive and offers Reactivate",
          page.query_selector("tr[data-id='u2'] button:has-text('Reactivate')") is not None)
    check("the server was told to deactivate that one account",
          {"action": "update", "id": "u2", "is_active": False} in srv.account_calls, str(srv.account_calls[-2:]))

    page.click("tr[data-id='u2'] button:has-text('Reactivate')")
    wait_for_text(page, ".toasts", "can sign in again")
    page.wait_for_function("document.querySelector(\"tr[data-id='u2']\").innerText.includes('Active')")
    check("reactivating is one click and one call",
          {"action": "update", "id": "u2", "is_active": True} in srv.account_calls, str(srv.account_calls[-2:]))

    # ---------- creating ----------
    page.click("#ac-create")
    page.wait_for_selector(".dialog")
    check("the create dialog starts as a teacher with a ready password",
          page.input_value("#ac-role") == "teacher" and len(page.input_value("#ac-password")) == 12)
    page.fill("#ac-email", "not-an-email")
    page.fill("#ac-name", "Ms. Dewi")
    page.click(".dialog button:has-text('Create account')")
    wait_for_text(page, ".dialog", "does not look like an email")
    check("a bad address is refused in the dialog, before the server",
          "does not look like an email" in page.inner_text(".dialog")
          and not any(c.get("action") == "create" for c in srv.account_calls))

    page.fill("#ac-email", "rina@example.com")
    page.click(".dialog button:has-text('Create account')")
    wait_for_text(page, ".dialog", "already exists")
    check("an address that is taken is refused by the server, in words the admin can act on",
          "already exists" in page.inner_text(".dialog"))
    check("the dialog stays open so nothing has to be typed again",
          page.input_value("#ac-name") == "Ms. Dewi" and page.query_selector(".dialog button:has-text('Create account')") is not None)

    page.fill("#ac-email", "dewi@example.com")
    page.click(".dialog button:has-text('Create account')")
    wait_for_text(page, ".dialog", "Hand this password over")
    made = page.inner_text("#ac-handover-password")
    check("the new account is shown with its password to hand over",
          "dewi@example.com" in page.inner_text(".dialog") and len(made) == 12, made)
    created = [c for c in srv.account_calls if c.get("action") == "create"]
    check("only the admin's two attempts were sent, the refused duplicate first",
          len(created) == 2 and created[0]["email"] == "rina@example.com", str(created))
    check("the server was sent the email, the name, the role and the password",
          created[-1]["email"] == "dewi@example.com" and created[-1]["full_name"] == "Ms. Dewi"
          and created[-1]["role"] == "teacher" and created[-1]["password"] == made, str(created[-1]))
    check("and nothing about status: a new account is active because the server says so",
          "is_active" not in created[-1])
    page.click(".dialog button:has-text('Done')")
    page.wait_for_function("document.querySelector('.dialog') === null")
    page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 4")
    check("the new account appears in the list and the count follows",
          page.inner_text(".head .sub") == "4 accounts" and "dewi@example.com" in page.inner_text(".qtable tbody"))
    check("a brand-new account has never signed in", "Never" in page.inner_text("tr[data-id='u4']"))

    # ---------- a failure the admin cannot fix ----------
    srv.fail_account = True
    page.click("#ac-create")
    page.wait_for_selector(".dialog")
    page.fill("#ac-email", "someone@example.com")
    page.fill("#ac-name", "Someone")
    page.click(".dialog button:has-text('Create account')")
    wait_for_text(page, ".dialog", "Something went wrong")
    check("a server failure is shown in the dialog, which stays open",
          "Something went wrong. Please try again." in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Cancel')")
    srv.fail_account = False

    # ---------- a teacher: no menu entry, and the door stays shut ----------
    accounts_before = len(srv.accounts)
    srv.role = "teacher"
    page.reload()
    page.wait_for_selector(".list-status.error")
    check("a teacher is not offered the accounts in the menu",
          page.query_selector(".nav a[data-route='#/accounts']") is None
          and len(page.query_selector_all(".nav a")) == 6, str(len(page.query_selector_all(".nav a"))))
    check("a teacher who lands on the screen by hand is refused",
          "You do not have access to this." in page.inner_text(".list-status"), page.inner_text(".list-status"))
    page.click("#ac-create")
    page.wait_for_selector(".dialog")
    page.fill("#ac-email", "sneaky@example.com")
    page.fill("#ac-name", "Sneaky")
    page.click(".dialog button:has-text('Create account')")
    wait_for_text(page, ".dialog", "do not have access")
    check("a teacher cannot create one through the screen either",
          len(srv.accounts) == accounts_before and not any(a["full_name"] == "Sneaky" for a in srv.accounts)
          and srv.account_calls[-1]["action"] == "create"
          and "You do not have access to this." in page.inner_text(".dialog"), str(srv.account_calls[-1]))
    page.click(".dialog button:has-text('Cancel')")

    # ---------- what the screen asked the server ----------
    actions = [c.get("action") for c in srv.account_calls]
    check("the screen only ever used the four account actions",
          set(actions) <= {"list", "create", "update", "password"} and len(actions) > 0, str(sorted(set(actions))))
    check("every action was exercised", set(actions) == {"list", "create", "update", "password"}, str(sorted(set(actions))))

    check("no page errors", errors == [], "; ".join(errors[:3]))
    browser.close()

print(f"\n{len(failures)} failed" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
