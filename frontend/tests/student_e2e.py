"""Browser test of the student page: join, take the test, send it, see the result.
Run: python3 frontend/tests/student_e2e.py  (expects the dev-server on 8123, like the other suites)
"""
import sys
import time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/index.html"
CODE = "K7M2QX"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def cls(page, selector, index=0):
    return page.query_selector_all(selector)[index].get_attribute("class") or ""


def wait_for(page, action, predicate=lambda call: True, timeout=8.0):
    """Waits until the mock server has received a matching call (autosave is debounced).

    The loop pumps Playwright's message loop (page.wait_for_timeout), otherwise the mocked route
    handler never runs while we are sleeping.
    """
    end = time.time() + timeout
    while time.time() < end:
        if any(c["action"] == action and predicate(c) for c in SRV.session_calls):
            return True
        page.wait_for_timeout(200)
    return False


def saved_text(text):
    """True when any answer in any save call carries this text."""
    return any(a.get("answer", {}).get("text") == text for c in SRV.session_calls if c["action"] == "save" for a in c.get("answers", []))


def join(page, name, klass, code=CODE):
    page.fill("#student-name", name)
    page.fill("#student-class", klass)
    page.fill("#test-code", code)
    page.click("button:has-text('Start test')")


def block(page):
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", SRV.handle)
    page.goto(BASE)


SRV = Server()
SRV.session_exam(CODE)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    block(page)

    # ---------- join screen ----------
    check("the join screen opens", page.inner_text("h1") == "Join your test")
    check("a test code is required", "code" in page.inner_text("form").lower())
    join(page, "Aisyah Putri", "XII TKJ A", "WRONG1")
    page.wait_for_selector(".errcard")
    check("a wrong code is explained", "code was not found" in page.inner_text(".errcard"))
    check("the student stays on the join screen", page.query_selector("#test-code") is not None)

    # ---------- join: the code may be typed in any case, with spaces ----------
    page.fill("#test-code", " k7m 2qx ")
    page.click("button:has-text('Start test')")
    page.wait_for_selector(".qbody")
    joins = [c for c in SRV.session_calls if c["action"] == "join"]
    check("the code is cleaned before it is sent", joins[-1].get("code") == CODE, str(joins[-1].get("code")))
    check("the name and class go along", joins[-1].get("name") == "Aisyah Putri" and joins[-1].get("class") == "XII TKJ A")

    # ---------- the exam screen ----------
    check("the question counter starts at one", page.inner_text(".qtop .q") == "Question 1 of 4")
    check("the exam title is shown", "Narrative Text" in page.inner_text(".exam-title"))
    check("the timer starts at the exam length", page.inner_text(".timer") in ("45:00", "44:59"), page.inner_text(".timer"))
    check("answers start out saved", "All answers saved" in page.inner_text(".saved"))
    check("a multiple choice question shows its bubbles", len(page.query_selector_all(".qbody .opt")) == 4)

    # ---------- answering, autosave ----------
    right_body = SRV.full(SRV.qs[0])["options"][1]["body"]
    page.query_selector_all(".qbody .opt")[1].click()
    check("the chosen bubble is filled", "sel" in cls(page, ".qbody .opt", 1))
    page.wait_for_function("document.querySelector('.saved').textContent.includes('All answers saved')")
    saves = [c for c in SRV.session_calls if c["action"] == "save"]
    check("the answer reaches the server", bool(saves) and saves[-1]["answers"][0]["answer"]["text"] == right_body)
    check("progress moved", page.eval_on_selector(".bar > i", "el => parseFloat(el.style.width)") == 25)

    # ---------- navigation ----------
    page.click(".qnav button:has-text('Next')")
    check("Next moves forward", "Question 2 of 4" in page.inner_text(".qtop .q"))
    check("true or false shows two choices", len(page.query_selector_all(".qbody .opt")) == 2)
    page.click(".qbody .opt:has-text('False')")
    check("previous works", (page.click(".qnav .icobtn[aria-label='Previous question']") or True)
          and "Question 1 of 4" in page.inner_text(".qtop .q"))
    page.click(".qnav button:has-text('Next')")

    # ---------- marking ----------
    page.click(".qnav button:has-text('Mark')")
    check("marking flips the button", "Marked" in page.inner_text(".qnav .btn.mark"))
    check("marking is saved too", wait_for(page, "save", lambda c: any(a.get("is_flagged") for a in c.get("answers", []))))

    # ---------- answer sheet ----------
    page.click(".qnav .icobtn[aria-label='Answer sheet']")
    page.wait_for_selector(".sheetgrid")
    cells = page.query_selector_all(".sheetgrid button")
    check("the sheet lists every question", len(cells) == 4)
    check("answered questions are filled in", "answered" in (cells[0].get_attribute("class") or ""))
    check("marked questions are highlighted", "marked" in (cells[1].get_attribute("class") or ""))
    check("the current question is ringed", "current" in (cells[1].get_attribute("class") or ""))
    check("the summary counts what is left", "2 answered, 2 still empty" in page.inner_text(".sheet .sub"))
    cells[3].click()
    check("tapping a number jumps there and closes the sheet", page.query_selector(".sheet") is None and "Question 4 of 4" in page.inner_text(".qtop .q"))
    check("the last question offers Finish", page.inner_text(".qnav button:last-child").strip() == "Finish")

    # ---------- essay, then short answer ----------
    page.fill(".qbody textarea", "I visited my grandmother last holiday.")
    page.wait_for_function("document.querySelector('.saved').textContent.includes('All answers saved')")
    check("the written answer is saved", wait_for(page, "save", lambda c: any(a.get("answer", {}).get("text", "").startswith("I visited") for a in c.get("answers", []))))
    page.click(".qnav .icobtn[aria-label='Previous question']")
    check("a short answer has a text box", page.query_selector(".qbody input.input") is not None)

    # ---------- losing the connection ----------
    ctx.set_offline(True)
    page.wait_for_selector(".offbar:not([hidden])")
    check("the offline banner appears", "No connection" in page.inner_text(".offbar"))
    page.fill(".qbody input.input", "went")
    page.wait_for_function("document.querySelector('.saved').textContent.includes('Saved on this phone only')")
    check("an answer typed offline stays marked as unsent", page.input_value(".qbody input.input") == "went")
    ctx.set_offline(False)
    page.wait_for_function("document.querySelector('.saved').textContent.includes('All answers saved')", timeout=15000)
    check("queued answers are sent once the connection is back", wait_for(page, "save", lambda c: any(a.get("answer", {}).get("text") == "went" for a in c.get("answers", []))))
    check("the offline banner is gone", page.query_selector(".offbar:not([hidden])") is None)

    # ---------- leaving the page ----------
    page.evaluate("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_selector(".dialog")
    check("leaving the page is explained to the student", "You left the test page" in page.inner_text(".dialog"))
    check("the leave is recorded on the server", any(e["type"] == "tab_hidden" for e in SRV.session_events))
    check("the warning names the automatic limit", "submitted automatically" in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Back to the test')")
    page.wait_for_selector(".dialog", state="detached")
    page.evaluate("Object.defineProperty(document, 'hidden', {value: false, configurable: true})")
    check("the warning closes again", page.query_selector(".dialog") is None)

    # ---------- sending the test ----------
    page.fill(".qbody input.input", "")  # leave one question empty on purpose
    page.click(".qnav .icobtn[aria-label='Answer sheet']")
    page.wait_for_selector(".sheetgrid")
    page.query_selector_all(".sheetgrid button")[3].click()
    page.click(".qnav button:has-text('Finish')")
    page.wait_for_selector(".dialog")
    check("sending warns about the empty question", "1 question is still empty" in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Keep working')")
    check("cancelling keeps the test open", page.query_selector(".qbody") is not None)
    page.click(".qnav button:has-text('Finish')")
    page.wait_for_selector(".dialog")
    page.click(".dialog button:has-text('Send my test')")
    page.wait_for_selector(".result")
    check("the send used the student reason", any(c.get("action") == "submit" and c.get("reason") == "student" for c in SRV.session_calls))

    # ---------- the result ----------
    check("the result says the test was sent", "Test submitted" in page.inner_text(".result"))
    check("the student sees their own name and class", "Aisyah Putri, XII TKJ A" in page.inner_text(".result"))
    check("the partial score is shown", page.inner_text(".score") == "40", page.inner_text(".score"))
    check("the result is marked not final while the essay waits", "Not final" in page.inner_text(".result"))
    check("the student is told about the waiting written answer", "waiting for your teacher" in page.inner_text(".note").lower())
    check("the automatic answers are counted", "2 correct, 1 wrong" in page.inner_text(".card"))
    check("the passing grade is repeated", "passing grade is 70" in page.inner_text(".result").lower())
    check("every question appears in the review", len(page.query_selector_all(".review-item")) == 4)
    check("the wrong answer is flagged in the review", len(page.query_selector_all(".review-item .pill.bad")) == 1)
    check("the correct option is highlighted in the review", page.query_selector_all(".review-item .opt.correct") is not None)
    check("the essay waits for the teacher", "Waiting for your teacher" in page.inner_text(".review-item:nth-child(4)"))

    page.click(".result button:has-text('Done')")
    page.wait_for_selector("#test-code")
    check("Done returns to the join screen", page.inner_text("h1") == "Join your test")

    # ---------- one attempt only ----------
    join(page, "Aisyah Putri", "xii  tkj a")  # same student, typed differently
    page.wait_for_selector(".errcard")
    check("the same student cannot take the test twice", "already took this test" in page.inner_text(".errcard"))

    # ---------- time up ----------
    SRV.session_seconds = 1
    page.fill("#test-code", CODE)
    page.fill("#student-name", "Bima Saputra")
    page.fill("#student-class", "X TKJ A")
    page.click("button:has-text('Start test')")
    page.wait_for_selector(".result", timeout=20000)
    check("the test is sent automatically when time is up", any(c.get("action") == "submit" and c.get("reason") == "time_up" for c in SRV.session_calls))
    check("the student is told why it was sent", "Time was up" in page.inner_text(".result"))
    SRV.session_seconds = None

    check("no page errors", errors == [], "; ".join(errors[:3]))

    # ---------- a reload continues the same attempt ----------
    ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
    page2 = ctx2.new_page()
    errors2 = []
    page2.on("pageerror", lambda e: errors2.append(str(e)))
    block(page2)
    join(page2, "Citra Dewi", "XI TKJ A")
    page2.wait_for_selector(".qbody")
    page2.query_selector_all(".qbody .opt")[1].click()
    page2.reload()
    page2.wait_for_selector(".qbody")
    check("a reload comes back to the same question", page2.inner_text(".qtop .q") == "Question 1 of 4")
    check("the reload asked the server for the session", any(c["action"] == "get" for c in SRV.session_calls))
    check("the answer typed just before the reload is still there", "sel" in cls(page2, ".qbody .opt", 1))

    # The page itself still loads (the phone has the app), but the server cannot be reached:
    # the answers and the questions on the phone keep the test going (design section 1.7).
    page2.route("**/functions/v1/**", lambda route: route.abort())
    page2.reload()
    page2.wait_for_selector(".qbody")
    check("a reload without the server still opens the test", page2.inner_text(".qtop .q") == "Question 1 of 4")
    check("the student can still answer", page2.inner_text(".saved") != "")
    page2.unroute("**/functions/v1/**")
    page2.route("**/functions/v1/**", SRV.handle)
    check("no page errors on the second device", errors2 == [], "; ".join(errors2[:3]))

print()
print("ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
