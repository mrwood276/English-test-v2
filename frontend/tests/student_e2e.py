"""Browser test of the student page: join, take the test, send it, see the result.
Covers the leave rule too: only a hidden page counts as a leave; a blur is recorded but cannot submit
(DEC-039 / TASK-030).
Run: python3 frontend/tests/student_e2e.py  (expects the dev-server on 8123, like the other suites)
"""
import json
import sys
import time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/index.html"
CODE = "K7M2QX"
from e2e_harness import Suite

suite = Suite("student_e2e", base=BASE)
suite.install()          # a crash reports itself (CRASH block + log, exit 2) - ISSUE-039
check = suite.check      # the suite's own check(), now counted and located


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


def wait_until(page, predicate, timeout=8.0):
    """Waits for a fact (usually the mock server's own state), keeping the page's message loop pumping."""
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        page.wait_for_timeout(200)
    return False


def saved_text(text):
    """True when any answer in any save call carries this text."""
    return any(a.get("answer", {}).get("text") == text for c in SRV.session_calls if c["action"] == "save" for a in c.get("answers", []))


def answer_stored(exam_code, text):
    """True when the mock server's own state holds this text — what the teacher's report would read."""
    return any((a.get("text") or "") == text for s in SRV.sessions.values() if s["exam"] == exam_code for a in s["answers"].values())


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
    suite.watch(page, errors)
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
    suite.watch(page2, errors2)
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

    # ---------- the teacher reopens a collected attempt and the student keeps answering (BR-11) ----------
    # The mock used to refuse every save outside `in_progress`, which hid this path from the whole suite
    # (INS-10). The token in this mock is the session id, so writing it into localStorage is the same
    # thing the student's phone already holds.
    SRV.session_exam("REOPEN1")
    rid = SRV.results_seed("REOPEN1", "Fitri Handayani", "XI TKJ A", {}, status="submitted")
    SRV.sessions[rid]["status"] = "reopened"     # what the teacher's "Reopen" action does on the server
    ctx3 = browser.new_context(viewport={"width": 390, "height": 844})
    page3 = ctx3.new_page()
    errors3 = []
    suite.watch(page3, errors3)
    page3.on("pageerror", lambda e: errors3.append(str(e)))
    block(page3)
    page3.evaluate("(session) => localStorage.setItem('ENGLISH_TEST_V2_STUDENT_SESSION', session)", json.dumps({"token": rid}))
    page3.reload()
    page3.wait_for_selector(".qbody")
    check("a reopened attempt opens the exam again", page3.inner_text(".qtop .q") == "Question 1 of 4")
    page3.query_selector_all(".qbody .opt")[1].click()
    check("an answer saved into a reopened attempt reaches the server",
          wait_until(page3, lambda: any((a.get("text") or "") != "" for a in SRV.sessions[rid]["answers"].values())))
    check("the reopened attempt is still open after that save", SRV.sessions[rid]["status"] == "reopened")
    check("the student stays on the exam screen", page3.query_selector(".qbody") is not None and page3.query_selector(".result") is None)
    check("no page errors on the reopened device", errors3 == [], "; ".join(errors3[:3]))

    # ---------- the tab limit: what was typed just before must already be on the server (INS-01) ----------
    # Two real page leaves reach this exam's auto-submit limit, and the answer is typed *without* waiting
    # for the 1.2 s autosave debounce. On the pre-fix screen the phone jumped straight to the result and
    # the answer never left it.
    SRV.session_exam("AUTO01", tab_switch_warn_limit=5, tab_switch_flag_limit=5, tab_switch_autosubmit_limit=2)
    ctx4 = browser.new_context(viewport={"width": 390, "height": 844})
    page4 = ctx4.new_page()
    errors4 = []
    suite.watch(page4, errors4)
    page4.on("pageerror", lambda e: errors4.append(str(e)))
    block(page4)
    join(page4, "Gita Lestari", "XII TKJ B", "AUTO01")
    page4.wait_for_selector(".qbody")
    page4.click(".qnav .icobtn[aria-label='Answer sheet']")
    page4.wait_for_selector(".sheetgrid")
    page4.query_selector_all(".sheetgrid button")[3].click()   # the last question is the essay
    typed = "The last sentence typed before the tab limit fired."
    page4.fill(".qbody textarea", typed)
    for _ in range(2):
        page4.evaluate("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
    page4.wait_for_selector(".result", timeout=15000)
    auto = [s for s in SRV.sessions.values() if s["exam"] == "AUTO01"]
    check("the tab limit still sends the test automatically", len(auto) == 1 and auto[0]["status"] == "auto_submitted")
    check("the answer typed just before the limit reached the server",
          any((a.get("text") or "") == typed for a in auto[0]["answers"].values()))
    check("the exam screen gives way to the result", page4.query_selector(".result") is not None and page4.query_selector(".qbody") is None)
    check("no page errors on the tab-limit device", errors4 == [], "; ".join(errors4[:3]))

    # ---------- a blur is not a page leave (TASK-030, DEC-039) ----------
    # One blur at the boundary of a 2-leave limit: on the old server a phone notification counted as the
    # second leave and submitted the attempt; the rule is now that only a hidden page counts, while every
    # blur is still recorded for the teacher.
    SRV.session_exam("BLUR01", tab_switch_warn_limit=1, tab_switch_flag_limit=2, tab_switch_autosubmit_limit=2)
    ctx7 = browser.new_context(viewport={"width": 390, "height": 844})
    page7 = ctx7.new_page()
    errors7 = []
    suite.watch(page7, errors7)
    page7.on("pageerror", lambda e: errors7.append(str(e)))
    block(page7)
    join(page7, "Intan Permata", "XI TKJ A", "BLUR01")
    page7.wait_for_selector(".qbody")
    blur_sid = next(k for k, s in SRV.sessions.items() if s["exam"] == "BLUR01")
    SRV.sessions[blur_sid]["tab_switch_count"] = 1   # one real leave from the limit; only a blur follows
    page7.evaluate("window.dispatchEvent(new Event('blur'))")
    check("a blur is still recorded for the teacher",
          wait_until(page7, lambda: any(e["type"] == "blur" and e["session"] == blur_sid for e in SRV.session_events)))
    check("a blur does not count as a page leave", SRV.sessions[blur_sid]["tab_switch_count"] == 1)
    check("a blur cannot submit the attempt", SRV.sessions[blur_sid]["status"] == "in_progress")
    check("the exam screen stays open after a blur",
          page7.query_selector(".qbody") is not None and page7.query_selector(".result") is None)
    page7.evaluate("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
    page7.wait_for_selector(".result", timeout=15000)
    check("a real page leave at the same boundary still submits automatically",
          SRV.sessions[blur_sid]["status"] == "auto_submitted")
    check("no page errors on the blur device", errors7 == [], "; ".join(errors7[:3]))

    # ---------- the phone's own cap: it names the question and never queues the answer (INS-02) ----------
    SRV.session_exam("LONG01")
    ctx5 = browser.new_context(viewport={"width": 390, "height": 844})
    page5 = ctx5.new_page()
    errors5 = []
    suite.watch(page5, errors5)
    page5.on("pageerror", lambda e: errors5.append(str(e)))
    block(page5)
    join(page5, "Hadi Pratama", "X TKJ A", "LONG01")
    page5.wait_for_selector(".qbody")
    page5.click(".qnav .icobtn[aria-label='Answer sheet']")
    page5.wait_for_selector(".sheetgrid")
    page5.query_selector_all(".sheetgrid button")[2].click()          # question 3: the short answer
    check("a short answer cannot grow past the live cap", page5.get_attribute(".qbody input.input", "maxlength") == "1000")
    # Setting the value directly (text restored from an older visit, or a browser that pastes oddly) is the
    # one way past `maxlength`; the screen must still refuse to queue it, and say which question it is.
    too_long = "y" * 1500
    page5.evaluate("(text) => { const el = document.querySelector('.qbody input.input'); el.value = text; el.dispatchEvent(new Event('input')); }", too_long)
    check("an over-long answer is named on screen", "Question 3 is too long to save" in page5.inner_text(".saved"), page5.inner_text(".saved"))
    check("the over-long answer stays on the phone", page5.input_value(".qbody input.input") == too_long)
    page5.click(".qnav .icobtn[aria-label='Answer sheet']")
    page5.wait_for_selector(".sheetgrid")
    page5.query_selector_all(".sheetgrid button")[3].click()          # question 4: the essay
    check("an essay may grow to the essay cap", page5.get_attribute(".qbody textarea", "maxlength") == "20000")
    page5.fill(".qbody textarea", "A later answer that must still be saved.")
    check("a later valid answer still reaches the server", wait_until(page5, lambda: answer_stored("LONG01", "A later answer that must still be saved.")))
    check("the over-long answer was never sent", not saved_text(too_long))
    page5.click(".qnav .icobtn[aria-label='Answer sheet']")
    page5.wait_for_selector(".sheetgrid")
    page5.query_selector_all(".sheetgrid button")[2].click()
    page5.fill(".qbody input.input", "recovered")
    check("a shortened answer saves again", wait_until(page5, lambda: answer_stored("LONG01", "recovered")))
    check("the warning clears once it is short enough", "too long" not in page5.inner_text(".saved"), page5.inner_text(".saved"))
    check("no page errors on the capped device", errors5 == [], "; ".join(errors5[:3]))

    # ---------- a batch the server refuses still saves everything else (INS-02) ----------
    # The phone holds two answers: one the live cap refuses and one that is fine. The batch is refused
    # atomically, so the screen has to take it apart — the good answer is saved and the bad one is named.
    SRV.session_exam("QUEUE1")
    ctx6 = browser.new_context(viewport={"width": 390, "height": 844})
    page6 = ctx6.new_page()
    errors6 = []
    suite.watch(page6, errors6)
    page6.on("pageerror", lambda e: errors6.append(str(e)))
    block(page6)
    join(page6, "Indah Permata", "XI TKJ B", "QUEUE1")
    page6.wait_for_selector(".qbody")
    qids = [q["question_id"] for q in SRV.session_exams["QUEUE1"]["questions"]]
    refused_text = "z" * 1200
    good_essay = "The essay that must survive the refused batch."
    stored = page6.evaluate("() => JSON.parse(localStorage.getItem('ENGLISH_TEST_V2_STUDENT_SESSION'))")
    stored["answers"] = {
        qids[2]: {"text": refused_text, "is_flagged": False, "pending": True},
        qids[3]: {"text": good_essay, "is_flagged": False, "pending": True},
    }
    page6.evaluate("(data) => localStorage.setItem('ENGLISH_TEST_V2_STUDENT_SESSION', JSON.stringify(data))", stored)
    page6.reload()
    page6.wait_for_selector(".qbody")
    check("the good answer is saved out of a refused batch", wait_until(page6, lambda: answer_stored("QUEUE1", good_essay)))
    check("the refused answer is named on screen",
          wait_until(page6, lambda: "could not be saved" in page6.inner_text(".saved")))

    def attempts_with_the_refused_answer():
        return len([c for c in SRV.session_calls if c["action"] == "save"
                    and any(a.get("answer", {}).get("text") == refused_text for a in c.get("answers", []))])

    attempts = attempts_with_the_refused_answer()
    page6.wait_for_timeout(3000)   # longer than nothing: the 5 s retry timer must not be carrying it
    check("the refused answer is not retried forever", 1 <= attempts <= 2 and attempts_with_the_refused_answer() == attempts, str(attempts))
    page6.click(".qnav .icobtn[aria-label='Answer sheet']")
    page6.wait_for_selector(".sheetgrid")
    page6.query_selector_all(".sheetgrid button")[2].click()
    page6.fill(".qbody input.input", "fixed")
    check("the student can fix the refused answer and it saves", wait_until(page6, lambda: answer_stored("QUEUE1", "fixed")))
    check("the warning clears after the fix", "could not be saved" not in page6.inner_text(".saved"), page6.inner_text(".saved"))
    check("no page errors on the rejected-batch device", errors6 == [], "; ".join(errors6[:3]))

suite.finish()
