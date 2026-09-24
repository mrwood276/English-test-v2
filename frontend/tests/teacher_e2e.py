"""End-to-end test of the teacher/admin sign-in flow in a real browser, with the network mocked.
Run:  python3 -m http.server 8123 --directory frontend   (in another terminal), then  python3 frontend/tests/teacher_e2e.py
"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123/teacher/index.html"
ADMIN = {"id": "7b0a389c-0000-0000-0000-000000000001", "email": "admin@example.com"}
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def token_response():
    return {"access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "user": ADMIN}

class Net:
    """Mocked Supabase endpoints. Each test sets the behaviour it needs."""
    def __init__(self):
        self.login = "ok"; self.me = "ok"; self.calls = []
    def install(self, page):
        page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
        page.route("**/auth/v1/**", self.auth)
        page.route("**/functions/v1/**", self.fn)
    def auth(self, route):
        req = route.request
        self.calls.append((req.method, req.url.split("/auth/v1")[1], req.headers.get("authorization"), req.headers.get("apikey")))
        if "/logout" in req.url:
            return route.fulfill(status=204, body="")
        if "grant_type=password" in req.url:
            body = json.loads(req.post_data)
            if self.login == "network":
                return route.abort()
            if self.login == "ratelimit":
                return route.fulfill(status=429, content_type="application/json", body=json.dumps({"code": 429, "error_code": "over_request_rate_limit", "msg": "Request rate limit reached"}))
            if body.get("password") == "correct" and self.login == "ok":
                return route.fulfill(status=200, content_type="application/json", body=json.dumps(token_response()))
            return route.fulfill(status=400, content_type="application/json", body=json.dumps({"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}))
        if "grant_type=refresh_token" in req.url:
            return route.fulfill(status=400, content_type="application/json", body=json.dumps({"error_code": "refresh_token_not_found", "msg": "nope"}))
        route.fulfill(status=404, body="{}")
    def fn(self, route):
        req = route.request
        path = req.url.split("/functions/v1")[1]
        self.calls.append((req.method, path, req.headers.get("authorization"), req.headers.get("apikey")))
        if req.method == "OPTIONS":
            return route.fulfill(status=204, body="")
        body = json.loads(req.post_data or "{}")
        # The dashboard reads these two on every visit; answer them like the real server would
        # for a fresh project: no open exams, nothing taken, nothing to grade.
        if path == "/exams" and body.get("action") == "list":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"exams": []}))
        if path == "/results" and body.get("action") == "activity":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"exams": []}))
        if path == "/results" and body.get("action") == "pending":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"pending": 0}))
        if self.me == "network":
            return route.abort()
        if self.me == "401":
            return route.fulfill(status=401, content_type="application/json", body=json.dumps({"error": "Your session has expired. Please sign in again.", "code": "unauthorized"}))
        if self.me == "403":
            return route.fulfill(status=403, content_type="application/json", body=json.dumps({"error": "This account does not have access.", "code": "forbidden"}))
        if self.me == "xss":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"user": {"id": ADMIN["id"], "fullName": "<img src=x onerror=window.__pwned=1>Evil", "role": "admin"}}))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"user": {"id": ADMIN["id"], "fullName": "Admin", "role": "admin"}}))

def fill_and_submit(page, email, password):
    page.fill("#email", email)
    page.fill("#password", password)
    page.click("button[type=submit]")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1200, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    net = Net(); net.install(page)

    # 1. no session -> sign in screen
    page.goto(BASE); page.wait_for_selector("h1")
    check("shows the sign in screen", page.inner_text("h1") == "Teacher sign in")
    check("no empty error box on first load", not page.is_visible("[role=alert]"))
    check("email field is focused", page.evaluate("document.activeElement && document.activeElement.id") == "email")

    # 2. validation
    page.click("button[type=submit]")
    check("asks for the email first", "Enter your email" in page.inner_text("[role=alert]"))
    page.fill("#email", "admin@example.com"); page.click("button[type=submit]")
    check("asks for the password", "Enter your password" in page.inner_text("[role=alert]"))
    check("no request was sent for empty fields", not any(c[1].startswith("/token") for c in net.calls))

    # 3. wrong password
    fill_and_submit(page, "admin@example.com", "wrong")
    page.wait_for_function("document.querySelector('[role=alert]') && !document.querySelector('[role=alert]').hidden && document.querySelector('[role=alert]').textContent.includes('not correct')")
    check("wrong password shows a friendly message", "email or password is not correct" in page.inner_text("[role=alert]"))
    check("password is cleared and focused", page.input_value("#password") == "" and page.evaluate("document.activeElement.id") == "password")
    check("button is usable again", page.is_enabled("button[type=submit]") and page.inner_text("button[type=submit]") == "Sign in")

    # 4. show/hide password
    page.fill("#password", "abc"); page.click(".input-toggle")
    check("show password toggles the field", page.get_attribute("#password", "type") == "text" and page.inner_text(".input-toggle") == "Hide")
    page.click(".input-toggle")

    # 5. rate limit and network errors
    net.login = "ratelimit"; fill_and_submit(page, "admin@example.com", "correct")
    page.wait_for_function("document.querySelector('[role=alert]').textContent.includes('Too many')")
    check("rate limit message", True)
    net.login = "network"; fill_and_submit(page, "admin@example.com", "correct")
    page.wait_for_function("document.querySelector('[role=alert]').textContent.includes('Could not reach')")
    check("network error message", True)

    # 6. success
    net.login = "ok"; fill_and_submit(page, "admin@example.com", "correct")
    page.wait_for_selector(".shell")
    page.wait_for_selector(".dash-layout")
    check("the dashboard opens with today's date under the title",
          page.inner_text(".main h1") == "Dashboard" and page.inner_text(".head .sub") != "")
    check("the empty dashboard explains itself", "No exam is open right now" in page.inner_text(".main"))
    check("the dashboard offers a new exam", page.query_selector("a:has-text('New exam')") is not None)
    check("shows the role in the menu", "Admin" in page.inner_text(".me"))
    check("the build label is shown", "Build:" in page.inner_text("[data-build]"))
    check("menu has the six sections", len(page.query_selector_all(".nav > *")) == 6)
    check("every menu item leads somewhere: dashboard, questions, exams, grading, results, monitor",
          len(page.query_selector_all(".nav span.item")) == 0 and len(page.query_selector_all(".nav a")) == 6,
          f"{len(page.query_selector_all('.nav a'))} links, {len(page.query_selector_all('.nav span.item'))} placeholders")
    me_calls = [c for c in net.calls if c[1] == "/auth-me"]
    check("auth-me is called with the user token", me_calls and me_calls[-1][2] == "Bearer AT1")
    check("the publishable key is sent as apikey", me_calls[-1][3].startswith("sb_publishable_"))
    stored = page.evaluate("sessionStorage.getItem('ENGLISH_TEST_V2_STAFF_SESSION')")
    check("session kept for this tab only", stored is not None and page.evaluate("localStorage.length") == 0)

    # 7. reload keeps the session
    page.reload(); page.wait_for_selector(".shell")
    check("reload goes straight to the app", page.inner_text(".main h1") == "Dashboard")

    # 8. sign out
    page.click("text=Sign out"); page.wait_for_selector(".login")
    check("sign out returns to sign in", page.inner_text("h1") == "Teacher sign in")
    check("session removed", page.evaluate("sessionStorage.getItem('ENGLISH_TEST_V2_STAFF_SESSION')") is None)
    check("logout endpoint called with the token", any(c[1] == "/logout" and c[2] == "Bearer AT1" for c in net.calls))

    # 9. expired session
    net.me = "ok"; fill_and_submit(page, "admin@example.com", "correct"); page.wait_for_selector(".shell")
    net.me = "401"; page.reload(); page.wait_for_selector(".login")
    check("expired session goes back to sign in with a notice", "session has expired" in page.inner_text(".notice.info"))
    check("expired session is cleared", page.evaluate("sessionStorage.getItem('ENGLISH_TEST_V2_STAFF_SESSION')") is None)

    # 10. account without access
    net.me = "403"; fill_and_submit(page, "admin@example.com", "correct")
    page.wait_for_function("document.querySelector('[role=alert]') && document.querySelector('[role=alert]').textContent.includes('does not have access')")
    check("account without a profile is refused with a clear message", True)
    check("no half-open session is left behind", page.evaluate("sessionStorage.getItem('ENGLISH_TEST_V2_STAFF_SESSION')") is None)

    # 11. server unreachable while a session exists
    net.me = "ok"; fill_and_submit(page, "admin@example.com", "correct"); page.wait_for_selector(".shell")
    net.me = "network"; page.reload(); page.wait_for_selector("text=Can't connect")
    check("unreachable server shows a retry screen, not the sign in screen", page.is_visible("button:has-text(\"Try again\")"))
    net.me = "ok"; page.click("button:has-text(\"Try again\")"); page.wait_for_selector(".shell")
    check("retry works and keeps the session", page.inner_text(".main h1") == "Dashboard")

    # 12. names from the server are never treated as HTML
    net.me = "xss"; page.reload(); page.wait_for_selector(".shell")
    check("a hostile name is shown as text", page.evaluate("window.__pwned") is None and "Evil" in page.inner_text(".me") and page.query_selector(".me img") is None)

    # 13. narrow phone screen
    page.set_viewport_size({"width": 375, "height": 700})
    check("no sideways scrolling on a phone", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    net.me = "ok"; page.click("text=Sign out"); page.wait_for_selector(".login")
    check("sign in fits a phone", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))

    check("no JavaScript errors in the console", not errors, "; ".join(errors[:3]))
    browser.close()

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL CHECKS PASSED")
sys.exit(1 if failures else 0)
