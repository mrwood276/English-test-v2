"""Browser test of the question editor with a mocked server."""
import json, sys, time
from playwright.sync_api import sync_playwright
from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def rows(page): return page.query_selector_all(".qtable tbody tr")

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
    page.goto(BASE + "#/questions"); page.reload(); page.wait_for_selector(".qtable tbody tr")

    # ---- opening the editor
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-body")
    check("add opens the editor", page.inner_text("h1") == "Add question" and page.url.endswith("#/questions/new"))
    check("question bank stays highlighted in the menu", page.get_attribute("a[data-route='#/questions']", "aria-current") == "page")
    check("four question types, multiple choice selected", page.query_selector_all(".seg input[name=qtype]").__len__() == 4 and page.is_checked("#qtype-multiple_choice"))
    check("four empty answers to start", page.query_selector_all(".answers .optrow").__len__() == 4)
    check("medium difficulty and 1 point by default", page.is_checked("#qdiff-medium") and page.input_value("#q-weight") == "1")
    check("topic suggestions loaded", page.query_selector_all("#q-topics option").__len__() == 2)

    # ---- validation
    page.click("button:has-text('Save question')")
    check("empty question is refused with a message and focus", page.is_visible("#err-body") and "Write the question" in page.inner_text("#err-body") and page.evaluate("document.activeElement.id") == "q-body")
    check("nothing was sent to the server", len(srv.saved) == 0)
    page.fill("#q-body", "What did Dina do first?")
    page.click("button:has-text('Save question')")
    check("needs at least two answers", "Add at least 2 answers" in page.inner_text("#err-answers"))
    check("summary shows the same message", page.is_visible(".editor .notice.error"))
    page.fill("[aria-label='Answer A']", "Same"); page.fill("[aria-label='Answer B']", " same ")
    page.click("button:has-text('Save question')")
    check("two identical answers are refused", "same" in page.inner_text("#err-answers").lower())
    page.fill("[aria-label='Answer B']", "Different")
    page.click("button:has-text('Save question')")
    check("a correct answer must be chosen", "Select the bubble" in page.inner_text("#err-answers"))
    page.click("[aria-label='Mark answer B as the correct one']")
    check("choosing marks the bubble green with a check", page.get_attribute("[aria-label='Mark answer B as the correct one']", "aria-pressed") == "true" and page.query_selector(".answers .bubble.ok svg") is not None)
    page.click("[aria-label='Mark answer A as the correct one']")
    check("only one answer can be correct", page.query_selector_all(".answers .bubble.ok").__len__() == 1 and page.get_attribute("[aria-label='Mark answer A as the correct one']", "aria-pressed") == "true")
    page.fill("#q-weight", "0"); page.click("button:has-text('Save question')")
    check("points must be more than zero", "Points must be" in page.inner_text("#err-weight"))
    page.fill("#q-weight", "2")

    # ---- add / remove answers
    for _ in range(2): page.click("button:has-text('Add an answer')")
    check("up to six answers", page.query_selector_all(".answers .optrow").__len__() == 6 and page.is_disabled("button:has-text('Add an answer')"))
    for _ in range(4): page.click("[aria-label^='Remove answer']:not([disabled]) >> nth=-1")
    check("at least two answers stay", page.query_selector_all(".answers .optrow").__len__() == 2 and all(b.is_disabled() for b in page.query_selector_all("[aria-label^='Remove answer']")))
    for _ in range(2): page.click("button:has-text('Add an answer')")
    page.fill("[aria-label='Answer C']", "Third"); page.fill("[aria-label='Answer D']", "Fourth")

    # ---- formatting
    page.evaluate("(() => { const t = document.querySelector('#q-body'); t.focus(); t.setSelectionRange(9, 13); })()")
    page.click("button[aria-label='Underline']")
    check("underline wraps the selected text", page.input_value("#q-body") == "What did <u>Dina</u> do first?")
    page.evaluate("(() => { const t = document.querySelector('#q-body'); t.focus(); t.setSelectionRange(0, 4); })()")
    page.keyboard.press("Control+i")
    check("Ctrl+I makes the selection italic", page.input_value("#q-body").startswith("<i>What</i>"))
    page.fill("#q-body", "What did <u>Dina</u> do first?")

    # ---- class labels
    page.fill("#q-labels", "XII TKJ A"); page.keyboard.press("Enter")
    check("Enter adds a label", [e.inner_text().strip() for e in page.query_selector_all(".chips-row .chipx")] == ["XII TKJ A"])
    page.fill("#q-labels", "xii   tkj a"); page.keyboard.press("Enter")
    check("the same label with different spacing/case is not added twice", page.query_selector_all(".chipx").__len__() == 1 and "already added" in page.inner_text(".chips-input > .hint"))
    page.fill("#q-labels", "xii"); page.wait_for_selector(".suggest:not([hidden]) .s-item")
    check("suggestions skip labels already added", [e.inner_text().split()[0:3] for e in page.query_selector_all(".s-item")] == [["XII", "TKJ", "B"]])
    page.keyboard.press("ArrowDown"); page.keyboard.press("Enter")
    check("a suggestion is added with the keyboard", page.query_selector_all(".chipx").__len__() == 2)
    page.fill("#q-labels", "XI TKJ A"); page.wait_for_selector(".suggest:not([hidden]) .s-item"); page.click(".s-item")
    check("a suggestion is added with the mouse", page.query_selector_all(".chipx").__len__() == 3)
    page.fill("#q-labels", "XII TKJ C,"); 
    check("a comma adds a label", page.query_selector_all(".chipx").__len__() == 4)
    page.click("[aria-label='Remove XII TKJ C']")
    check("labels can be removed", page.query_selector_all(".chipx").__len__() == 3)
    page.focus("#q-labels"); page.keyboard.press("Backspace")
    check("Backspace removes the last label when the box is empty", page.query_selector_all(".chipx").__len__() == 2)
    for i in range(8): page.fill("#q-labels", f"Extra {i}"); page.keyboard.press("Enter")
    page.fill("#q-labels", "One too many"); page.keyboard.press("Enter")
    check("at most 10 labels", page.query_selector_all(".chipx").__len__() == 10 and "at most 10" in page.inner_text(".chips-input > .hint"))
    for _ in range(8): page.click(".chipx:last-child .chip-x")
    check("labels list can be trimmed again", page.query_selector_all(".chipx").__len__() == 2)

    # ---- topic and difficulty
    page.fill("#q-topic", "Narrative Text"); page.click("label[for=qdiff-hots]")
    check("difficulty can be changed", page.is_checked("#qdiff-hots"))

    # ---- duplicate warnings
    page.fill("#q-body", "What did Dina do first when she found the wallet?")
    page.wait_for_selector(".dup:not([hidden])", timeout=4000)
    check("a similar question is flagged", "Looks similar" in page.inner_text(".dup") and "91% similar" in page.inner_text(".dup") and "used in 2 exams" in page.inner_text(".dup"))
    check("the check ignores the question itself and sends answers", srv.dup_calls[-1].get("exclude_id") is None and srv.dup_calls[-1]["options"][0] == "Same")
    check("open it goes to the other question in a new tab", page.get_attribute(".dup a", "target") == "_blank")
    page.click(".dup button:has-text('It is different')")
    check("a match can be dismissed", page.is_hidden(".dup"))
    page.fill("#q-body", "EXACT copy of a question"); page.wait_for_selector(".dup.exact", timeout=4000)
    check("an exact copy is flagged more strongly", "exact question already exists" in page.inner_text(".dup"))
    page.fill("#q-body", "A short one"); page.wait_for_function("document.querySelector('.dup').hidden", timeout=4000)
    check("no warning when there is no match", True)
    page.fill("#q-body", "What did <u>Dina</u> do first?")

    # ---- reading text
    check("existing reading texts are listed", page.query_selector_all("#q-passage option").__len__() == 4)
    page.select_option("#q-passage", "pa1"); page.wait_for_selector(".passage-shown .passage")
    check("choosing a reading text shows it with formatting", "The Lost Wallet" in page.inner_text(".passage-shown") and page.query_selector(".passage-shown u") is not None)
    page.click("button:has-text('Edit text')"); page.wait_for_selector("dialog[open] #passage-title")
    check("editing a shared text warns about the other questions", "used by 3 questions" in page.inner_text("dialog"))
    page.click("dialog button:has-text('Cancel')"); page.wait_for_function("document.querySelector('dialog') === null")
    page.select_option("#q-passage", "__new"); page.wait_for_selector("dialog[open] #passage-title")
    page.click("dialog button:has-text('Save reading text')")
    check("a new reading text needs a title", "needs a title" in page.inner_text("dialog .notice.error"))
    page.fill("#passage-title", "The Old Lighthouse"); page.click("dialog button:has-text('Save reading text')")
    check("the empty text is refused too", "is empty" in page.inner_text("dialog .notice.error"))
    page.fill("#passage-body", "A keeper lived in an <b>old</b> lighthouse."); page.click("dialog button:has-text('Save reading text')")
    page.wait_for_function("document.querySelector('dialog') === null")
    page.wait_for_function("document.querySelector('#q-passage').value === 'pa3'")
    check("the new reading text is saved and selected", page.input_value("#q-passage") == "pa3" and "The Old Lighthouse" in page.inner_text(".passage-shown"))
    page.select_option("#q-passage", "__new"); page.wait_for_selector("dialog[open]"); page.keyboard.press("Escape"); page.wait_for_function("document.querySelector('dialog') === null")
    check("cancelling a new text keeps the previous choice", page.input_value("#q-passage") == "pa3")
    page.select_option("#q-passage", "pa1"); page.wait_for_selector(".passage-shown .passage")

    # ---- preview
    page.click("button:has-text('Preview')"); page.wait_for_selector("dialog[open] .qtext")
    pv = page.inner_text("dialog")
    check("preview shows the question as students will see it", "Dina" in pv and "Multiple choice" in pv and "2 points" in pv and "HOTS" in pv and "The Lost Wallet" in pv)
    check("preview marks the correct answer", page.query_selector("dialog .opt.correct") is not None and "Same" in page.inner_text("dialog .opt.correct"))
    check("preview keeps allowed formatting", page.query_selector("dialog .qtext u") is not None)
    page.click("dialog button:has-text('Close')"); page.wait_for_function("document.querySelector('dialog') === null")

    # ---- saving
    page.click("button:has-text('Save question')")
    page.wait_for_selector(".toast:has-text('Question saved.')"); page.wait_for_selector(".qtable")
    sent = srv.saved[-1]
    check("saved and back to the list", page.url.endswith("#/questions") and "31 questions" in page.inner_text(".head .sub"))
    check("payload: type, text, difficulty, topic, points", sent["type"] == "multiple_choice" and sent["body"] == "What did <u>Dina</u> do first?" and sent["difficulty"] == "hots" and sent["topic"] == "Narrative Text" and sent["weight"] == 2 and "id" not in sent)
    check("payload: answers with one correct", [o["is_correct"] for o in sent["options"]] == [True, False, False, False] and [o["body"] for o in sent["options"]] == ["Same", "Different", "Third", "Fourth"])
    check("payload: labels and reading text", sent["class_labels"] == ["XII TKJ A", "XII TKJ B"] and sent["passage_id"] == "pa1" and sent["accepted_answers"] == [])

    # ---- type switching keeps entered data
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-body")
    page.fill("#q-body", "Switching test"); page.fill("[aria-label='Answer A']", "Kept answer"); page.click("[aria-label='Mark answer A as the correct one']")
    page.click("label[for=qtype-true_false]")
    check("true or false has two fixed answers", page.query_selector_all(".answers .optrow").__len__() == 2 and "True" in page.inner_text(".answers"))
    page.click("button:has-text('Save question')")
    check("true or false needs a choice", "True or False" in page.inner_text("#err-answers"))
    page.click("[aria-label='Mark False as the correct answer']")
    page.click("label[for=qtype-multiple_choice]")
    check("switching back restores the multiple choice answers", page.input_value("[aria-label='Answer A']") == "Kept answer" and page.get_attribute("[aria-label='Mark answer A as the correct one']", "aria-pressed") == "true")
    page.click("label[for=qtype-short_answer]")
    page.fill("[aria-label='Accepted answer 1']", "past"); page.click("button:has-text('Add another accepted answer')"); page.fill("[aria-label='Accepted answer 2']", " PAST ")
    page.click("button:has-text('Save question')")
    check("duplicate accepted answers are refused", "same" in page.inner_text("#err-answers").lower())
    page.fill("[aria-label='Accepted answer 2']", "simple past")
    page.click("label[for=qtype-essay]")
    check("essay shows a grading guide box", page.is_visible("#q-guidance") and page.query_selector(".answers .optrow") is None)
    page.fill("#q-guidance", "One mark per idea.")
    page.click("button:has-text('Save and add another')"); page.wait_for_selector(".toast:has-text('Question saved.')")
    sent = srv.saved[-1]
    check("essay payload has a guide and no answers", sent["type"] == "essay" and sent["essay_guidance"] == "One mark per idea." and sent["options"] == [] and sent["accepted_answers"] == [])
    page.wait_for_function("document.querySelector('#q-body') && document.querySelector('#q-body').value === ''")
    check("save and add another gives a fresh form", page.input_value("#q-body") == "" and page.is_checked("#qtype-multiple_choice") and page.url.endswith("#/questions/new"))

    # ---- short answer save + carried details
    page.fill("#q-labels", "XII TKJ A"); page.keyboard.press("Enter"); page.fill("#q-topic", "Simple Past"); page.click("label[for=qdiff-easy]")
    page.click("label[for=qtype-short_answer]"); page.fill("#q-body", "The story was told in the ____ tense."); page.fill("[aria-label='Accepted answer 1']", "past")
    page.click("button:has-text('Save and add another')"); page.wait_for_selector(".toast:has-text('Question saved.')")
    sent = srv.saved[-1]
    check("short answer payload", sent["type"] == "short_answer" and sent["accepted_answers"] == ["past"] and sent["options"] == [])
    page.wait_for_function("document.querySelector('#q-body') && document.querySelector('#q-body').value === ''")
    check("labels, topic, and difficulty are kept for the next question", [e.inner_text().strip() for e in page.query_selector_all(".chipx")] == ["XII TKJ A"] and page.input_value("#q-topic") == "Simple Past" and page.is_checked("#qdiff-easy"))

    # ---- server messages
    page.fill("#q-body", "FORCE_SERVER_ERROR"); page.click("label[for=qtype-essay]"); page.fill("#q-guidance", "x")
    page.click("button:has-text('Save question')"); page.wait_for_selector(".editor .notice.error:not([hidden])")
    check("a message from the server is shown and the form stays usable", "Choose exactly one correct answer." in page.inner_text(".editor .notice.error") and page.is_enabled("button:has-text('Save question')") and page.inner_text("button:has-text('Save question')") == "Save question")

    # ---- unsaved changes guard
    page.click("a.back"); page.wait_for_selector("dialog[open]")
    check("leaving with unsaved changes asks first", "not saved yet" in page.inner_text("dialog") and page.url.endswith("#/questions/new"))
    page.click("dialog button:has-text('Keep editing')"); page.wait_for_function("document.querySelector('dialog') === null")
    check("keep editing stays and keeps the text", page.url.endswith("#/questions/new") and page.input_value("#q-body") == "FORCE_SERVER_ERROR")
    page.click("a[data-route='#/dashboard']"); page.wait_for_selector("dialog[open]")
    page.click("dialog button:has-text('Leave')"); page.wait_for_selector("h1:has-text('Welcome')")
    check("leaving anyway works from the menu too", page.url.endswith("#/dashboard"))

    # ---- editing an existing question
    page.click("a[data-route='#/questions']"); page.wait_for_selector(".qtable tbody tr")
    page.click("tr[data-id='00000000-0000-4000-8000-000000000003'] .qlink"); page.wait_for_selector(".preview a:has-text('Edit')")
    page.click(".preview a:has-text('Edit')"); page.wait_for_selector("#q-body")
    check("edit opens the saved question", page.inner_text("h1") == "Edit question" and page.is_checked("#qtype-short_answer") and page.input_value("#q-body").startswith("Question number 3"))
    check("edit shows its labels and usage", page.query_selector_all(".chipx").__len__() == 2 and "Used in 3 exams" in page.inner_text(".editor"))
    check("edit has no save-and-add-another", page.query_selector("button:has-text('Save and add another')") is None)
    page.click("a.back"); page.wait_for_selector(".qtable")
    check("leaving without changes needs no confirmation", True)
    page.click("tr[data-id='00000000-0000-4000-8000-000000000003'] .qlink"); page.wait_for_selector(".preview a:has-text('Edit')"); page.click(".preview a:has-text('Edit')"); page.wait_for_selector("#q-body")
    page.fill("#q-body", "Question number 3 (edited)"); page.click("label[for=qdiff-easy]")
    page.click("button:has-text('Save question')"); page.wait_for_selector(".toast:has-text('Question saved.')"); page.wait_for_selector(".qtable")
    sent = srv.saved[-1]
    check("editing sends the id", sent.get("id") == "00000000-0000-4000-8000-000000000003" and sent["body"] == "Question number 3 (edited)" and sent["difficulty"] == "easy")
    check("edited question shows in the list", "edited" in page.inner_text("tr[data-id='00000000-0000-4000-8000-000000000003']"))

    # ---- hostile text and unknown question
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-body")
    page.fill("#q-body", "Safe <script>window.__pwned=1</script><img src=x onerror=window.__pwned=2><b>bold</b>"); page.fill("[aria-label='Answer A']", "<img src=x onerror=window.__pwned=3>Yes"); page.fill("[aria-label='Answer B']", "No"); page.click("[aria-label='Mark answer A as the correct one']")
    page.click("button:has-text('Preview')"); page.wait_for_selector("dialog[open] .qtext")
    check("hostile text in the preview does nothing", page.evaluate("window.__pwned") is None and page.query_selector("dialog script") is None and page.query_selector("dialog img") is None and page.query_selector("dialog .qtext b") is not None)
    page.click("dialog button:has-text('Close')"); page.wait_for_function("document.querySelector('dialog') === null")
    page.click("a.back"); page.wait_for_selector("dialog[open]"); page.click("dialog button:has-text('Leave')"); page.wait_for_selector(".qtable")
    page.evaluate("location.hash = '#/questions/edit/00000000-0000-4000-8000-00000000ffff'"); page.wait_for_selector(".editor-grid, .notice.error")
    check("an unknown question shows a message and a way back", "no longer exists" in page.inner_text("#content") and page.is_visible("a:has-text('Back to the question bank')"))

    # ---- phone
    page.click("a:has-text('Back to the question bank')"); page.wait_for_selector(".qtable")
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-body")
    page.set_viewport_size({"width": 375, "height": 800})
    check("no sideways scrolling on a phone", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    check("answer buttons are large enough to tap", page.evaluate("(() => { const b = document.querySelector('.answers .bubble'); const r = b.getBoundingClientRect(); return r.width >= 32 && r.height >= 32; })()"))
    page.set_viewport_size({"width": 1280, "height": 900})

    # ---- session ended while saving
    page.fill("#q-body", "Session test"); page.fill("[aria-label='Answer A']", "A1"); page.fill("[aria-label='Answer B']", "B1"); page.click("[aria-label='Mark answer A as the correct one']")
    srv.status_all = 401; page.click("button:has-text('Save question')"); page.wait_for_selector(".login")
    # the sign-in screen appears before its notice text is filled in, so wait for the words
    page.wait_for_function("document.querySelector('.notice.info') && document.querySelector('.notice.info').textContent.includes('session has expired')")
    check("an ended session while saving goes back to sign in", "session has expired" in page.inner_text(".notice.info"))

    check("no JavaScript errors in the console", not errors, "; ".join(errors[:3]))
    browser.close()

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL CHECKS PASSED")
sys.exit(1 if failures else 0)
