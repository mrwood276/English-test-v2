"""Browser test of the question bank screen with a mocked server.
Run: python3 -m http.server 8123 --directory frontend   (same terminal command), then  python3 frontend/tests/question_bank_e2e.py
"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123/teacher/index.html"
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

from mock_server import Server, make_questions

def rows(page): return page.query_selector_all(".qtable tbody tr")
def wait_rows(page, n): page.wait_for_function(f"document.querySelectorAll('.qtable tbody tr').length === {n}")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    srv = Server()
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/questions"); page.reload(); page.wait_for_selector(".qtable")
    wait_rows(page, 25)

    # --- list and paging
    check("shows the count", page.inner_text(".head .sub") == "30 questions")
    check("first page has 25 rows", len(rows(page)) == 25)
    check("pager text", "Showing 1 to 25 of 30" in page.inner_text(".pager"))
    check("previous is disabled on the first page", page.is_disabled("button[aria-label='Previous page']"))
    check("question bank is the active menu item", page.get_attribute("a[data-route='#/questions']", "aria-current") == "page")
    page.click("button[aria-label='Next page']"); wait_rows(page, 5)
    check("second page has 5 rows", len(rows(page)) == 5 and "Showing 26 to 30 of 30" in page.inner_text(".pager"))
    check("next is disabled on the last page", page.is_disabled("button[aria-label='Next page']"))
    page.click("button[aria-label='Previous page']"); wait_rows(page, 25)

    # --- row content, hostile text, media, classes
    hostile = page.query_selector("tr[data-id='00000000-0000-4000-8000-000000000001']")
    check("rows show plain text of rich questions", hostile is not None and "Bold" in hostile.inner_text() and "<" not in hostile.inner_text())
    check("hostile markup does not run", page.evaluate("window.__pwned") is None)
    check("row subtitle shows type and topic", "Multiple choice, Narrative Text" in hostile.inner_text())
    r5 = page.query_selector("tr[data-id='00000000-0000-4000-8000-000000000005']")
    check("audio icon shown for questions with audio", r5.query_selector("[aria-label='Has audio']") is not None)
    r7 = page.query_selector("tr[data-id='00000000-0000-4000-8000-000000000007']")
    check("image icon shown for questions with an image", r7.query_selector("[aria-label='Has image']") is not None)
    r3 = page.query_selector("tr[data-id='00000000-0000-4000-8000-000000000003']")
    check("class labels shown as tags", "XII TKJ A" in r3.inner_text() and "XII TKJ B" in r3.inner_text())
    check("usage text", "3 exams" in r3.inner_text() and "Not used" in page.query_selector("tr[data-id='00000000-0000-4000-8000-000000000004']").inner_text())
    check("topic and class suggestions were loaded", page.query_selector("#qb-topic option:has-text('Narrative Text (15)')") is not None and page.query_selector("#qb-class option:has-text('XII TKJ B')") is not None)

    # --- filters
    page.fill("#qb-search", "number 12"); page.wait_for_function("document.querySelector('.head .sub').textContent.includes('matches')")
    check("search is sent after a short pause", srv.calls[-1].get("q") == "number 12" and srv.calls[-1].get("page") == 1)
    check("one match reads well", page.inner_text(".head .sub") == "1 question matches" and len(rows(page)) == 1)
    page.fill("#qb-search", "zzzz nothing"); page.wait_for_selector("text=No questions match these filters.")
    check("empty result explains itself and offers to clear", page.is_visible("button:has-text('Clear filters')"))
    page.click("button:has-text('Clear filters')"); wait_rows(page, 25)
    check("clearing the filters restores the list", page.input_value("#qb-search") == "" and page.inner_text(".head .sub") == "30 questions")
    page.select_option("#qb-difficulty", "hots"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 10")
    check("difficulty filter", srv.calls[-1].get("difficulty") == "hots" and len(rows(page)) == 10)
    page.select_option("#qb-type", "essay"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length < 10")
    check("filters combine", srv.calls[-1].get("type") == "essay" and srv.calls[-1].get("difficulty") == "hots")
    page.select_option("#qb-difficulty", ""); page.select_option("#qb-type", ""); wait_rows(page, 25)
    page.select_option("#qb-class", "XII TKJ B"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 10")
    check("class label filter", srv.calls[-1].get("class_label") == "XII TKJ B" and len(rows(page)) == 10)
    page.select_option("#qb-class", ""); wait_rows(page, 25)
    page.select_option("#qb-used", "unused"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 7")
    check("unused filter", srv.calls[-1].get("used") == "unused")
    page.select_option("#qb-used", ""); wait_rows(page, 25)
    page.select_option("#qb-sort", "oldest"); page.wait_for_function("document.querySelector('.qtable tbody tr .qlink').textContent.includes('number 30')")
    check("sort is sent", srv.calls[-1].get("sort") == "oldest")
    page.select_option("#qb-sort", "newest"); wait_rows(page, 25)
    page.click("button[aria-label='Next page']"); wait_rows(page, 5)
    page.select_option("#qb-difficulty", "easy"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 10")
    check("changing a filter goes back to page 1", srv.calls[-1].get("page") == 1)
    page.select_option("#qb-difficulty", ""); wait_rows(page, 25)

    # --- preview
    page.click("tr[data-id='00000000-0000-4000-8000-000000000002'] .qlink"); page.wait_for_selector(".preview .qtext")
    p = page.inner_text(".preview")
    check("preview shows type, difficulty, points", "True or false" in p and "Medium" in p and "1 point" in p)
    check("true/false options with the correct one marked", page.query_selector_all(".preview .opt").__len__() == 2 and page.query_selector_all(".preview .opt.correct").__len__() == 1)
    check("reading text is shown", "The Lost Wallet" in p and "brown" in p)
    check("preview keeps allowed formatting", page.query_selector(".preview .passage-body u") is not None)
    page.click("tr[data-id='00000000-0000-4000-8000-000000000001'] .qlink"); page.wait_for_function("document.querySelector('.preview .opt') !== null")
    letters = [e.inner_text().strip() for e in page.query_selector_all(".preview .opt .bubble")]
    check("multiple choice shows letter bubbles and a green check on the correct answer", len(letters) == 4 and letters[0] == "A" and letters[2] == "C" and page.query_selector(".preview .opt.correct .bubble.ok svg") is not None)
    check("hostile question text is safe in the preview", page.evaluate("window.__pwned") is None and page.query_selector(".preview .qtext script") is None and page.query_selector(".preview .qtext img") is None and page.query_selector(".preview .qtext b") is not None)
    check("selected row is highlighted and pressed", page.query_selector("tr.sel") is not None and page.get_attribute("tr.sel .qlink", "aria-pressed") == "true")
    page.click("tr[data-id='00000000-0000-4000-8000-000000000003'] .qlink"); page.wait_for_function("document.querySelector('.preview .answer-box') !== null")
    check("short answer shows accepted answers", "past" in page.inner_text(".preview .answer-box") and "simple past" in page.inner_text(".preview .answer-box"))
    page.click("tr[data-id='00000000-0000-4000-8000-000000000004'] .qlink"); page.wait_for_function("document.querySelector('.preview .guide') !== null")
    check("essay shows the grading guide", "One mark per idea" in page.inner_text(".preview .guide"))
    page.click("tr[data-id='00000000-0000-4000-8000-000000000005'] .qlink"); page.wait_for_selector(".preview audio.q-audio")
    check("audio has a player in the preview", page.get_attribute(".preview audio.q-audio", "src").startswith("data:audio/"))
    page.click("tr[data-id='00000000-0000-4000-8000-000000000002'] .qlink"); page.wait_for_selector(".preview .passage img.q-image")
    check("images of the reading text are shown inside it", page.get_attribute(".preview .passage img.q-image", "src").startswith("data:image/"))
    check("edit and add are links to the editor", (page.get_attribute(".preview a:has-text('Edit')", "href") or "").startswith("#/questions/edit/00000000-0000-4000-8000-000000000002") and page.get_attribute("a:has-text('Add question')", "href") == "#/questions/new")
    page.focus("tr[data-id='00000000-0000-4000-8000-000000000006'] .qlink"); page.keyboard.press("Enter"); page.wait_for_function("document.querySelector('tr.sel') && document.querySelector('tr.sel').dataset.id.endsWith('006')")
    check("rows can be opened with the keyboard", True)

    # --- actions: archive, restore
    page.click("tr[data-id='00000000-0000-4000-8000-000000000008'] .qlink"); page.wait_for_selector(".preview-actions")
    page.click(".preview button:has-text('Archive')"); page.wait_for_selector(".toast:has-text('archived')")
    wait_rows(page, 25)
    check("archiving removes it from the list and closes the preview", page.inner_text(".head .sub") == "29 questions" and page.is_hidden(".preview"))
    page.check("#qb-archived"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 1")
    check("archived questions can be shown", "(archived)" in page.inner_text(".head .sub"))
    page.click(".qtable tbody tr .qlink"); page.wait_for_selector(".preview .pill.warn")
    check("archived pill is shown", "Archived" in page.inner_text(".preview-head"))
    page.click(".preview button:has-text('Restore')"); page.wait_for_selector(".toast:has-text('restored')")
    page.uncheck("#qb-archived"); wait_rows(page, 25)
    check("restore brings it back", page.inner_text(".head .sub") == "30 questions")

    # --- actions: delete (unused), delete (used -> archived), cancel
    page.click("tr[data-id='00000000-0000-4000-8000-000000000004'] .qlink"); page.wait_for_selector(".preview-actions")   # used_in_exams = 0
    page.click(".preview button:has-text('Delete')"); page.wait_for_selector("dialog[open]")
    check("delete dialog explains that it is permanent", "permanently deletes" in page.inner_text("dialog") and page.is_visible("dialog button:has-text('Delete')"))
    page.click("dialog button:has-text('Cancel')"); page.wait_for_function("document.querySelector('dialog') === null")
    check("cancel keeps the question", page.inner_text(".head .sub") == "30 questions")
    page.click(".preview button:has-text('Delete')"); page.wait_for_selector("dialog[open]"); page.keyboard.press("Escape"); page.wait_for_function("document.querySelector('dialog') === null")
    check("escape closes the dialog without deleting", page.inner_text(".head .sub") == "30 questions")
    page.click(".preview button:has-text('Delete')"); page.wait_for_selector("dialog[open]"); page.click("dialog button:has-text('Delete')")
    page.wait_for_selector(".toast:has-text('Question deleted.')"); page.wait_for_function("document.querySelector('.head .sub').textContent === '29 questions'")
    check("unused question is deleted", True)
    page.click("tr[data-id='00000000-0000-4000-8000-000000000003'] .qlink"); page.wait_for_selector(".preview-actions")     # used in 3 exams
    page.click(".preview button:has-text('Delete')"); page.wait_for_selector("dialog[open]")
    check("used question: dialog says it will be archived instead", "archived instead" in page.inner_text("dialog") and "3 exams" in page.inner_text("dialog") and page.is_visible("dialog button:has-text('Archive')"))
    page.click("dialog button:has-text('Archive')"); page.wait_for_selector(".toast:has-text('archived because exams use it')")
    page.wait_for_function("document.querySelector('.head .sub').textContent === '28 questions'")
    check("used question is archived, not deleted", True)

    # --- errors
    srv.fail_list = 1; page.select_option("#qb-difficulty", "easy"); page.wait_for_selector(".list-status.error")
    check("a failed load shows a message and a retry button", "Could not load questions" in page.inner_text(".list-status") and page.is_visible(".list-status button:has-text('Try again')"))
    page.click(".list-status button:has-text('Try again')"); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length > 0")
    check("retry loads the list", page.query_selector(".list-status.error") is None)
    page.select_option("#qb-difficulty", ""); page.wait_for_function("document.querySelectorAll('.qtable tbody tr').length === 25")

    # --- navigation
    page.click("a[data-route='#/dashboard']"); page.wait_for_selector("h1:has-text('Welcome')")
    check("dashboard link works", page.get_attribute("a[data-route='#/dashboard']", "aria-current") == "page" and page.is_hidden(".qtable") if page.query_selector(".qtable") else True)
    page.evaluate("location.hash = '#/nowhere'"); page.wait_for_selector("h1:has-text('Welcome')")
    check("unknown address falls back to the dashboard", True)
    page.click("a[data-route='#/questions']"); page.wait_for_selector(".qtable"); wait_rows(page, 25)
    check("filters start fresh when coming back", page.input_value("#qb-search") == "")

    # --- phone
    page.set_viewport_size({"width": 375, "height": 800})
    page.click("tr:first-child .qlink"); page.wait_for_selector(".preview .qtext")
    check("no sideways scrolling on a phone", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    check("preview shows under the list on a phone", page.is_visible(".preview"))
    page.set_viewport_size({"width": 1280, "height": 900})

    # --- session ended while on the page
    srv.status_all = 401; page.select_option("#qb-difficulty", "hots")
    page.wait_for_selector(".login"); 
    check("an ended session sends the person to sign in with an explanation", "session has expired" in page.inner_text(".notice.info"))

    check("no JavaScript errors in the console", not errors, "; ".join(errors[:3]))
    browser.close()

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL CHECKS PASSED")
sys.exit(1 if failures else 0)
