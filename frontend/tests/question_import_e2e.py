"""Browser test of the question import screen with a mocked server.
Run: python frontend/dev-server.py 8123   (keep it running), then  python frontend/tests/question_import_e2e.py
"""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123/teacher/index.html"
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

from mock_server import Server

FIXTURE = pathlib.Path(__file__).resolve().parent / "unit" / "fixtures" / "import-sample.xlsx"

PASTE = """1. What did Dina do first after she found the wallet?
A. She kept the money.
B. She looked around for the owner.*
C. She called the police.
D. She left it under the bench.
Topic: Narrative Text
Level: HOTS
Points: 2
Class: XII TKJ A, XII TKJ B

2. Dina found a key.
Answer: False
Topic: Narrative Text

3. This one EXACT match in the bank?
Answer: yes | yep

4. A broken row with no answer at all
A. One
B. Two

5. This one is similar to a question in the bank: what did Dina do first when she found the wallet?
A. She looked around.
B. She called for help.
Answer: A
"""

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
    page.goto(BASE + "#/questions/import"); page.reload(); page.wait_for_selector("#imp-paste")

    # --- empty state
    page.click("#imp-review")
    check("review without a source explains itself", page.is_visible("#imp-error") and "Choose a file or paste" in page.inner_text("#imp-error"))

    # --- pasted text through the whole flow
    page.fill("#imp-paste", PASTE)
    page.click("#imp-review")
    page.wait_for_selector("#imp-tbody tr")
    check("five rows are shown", page.eval_on_selector_all("#imp-tbody tr", "els => els.length") == 5)
    status = page.inner_text("#imp-status")
    check("status counts the rows and the selection", "5 read from pasted text" in status and "3 of 5 selected" in status and "1 need fixing" in status, status)
    check("row 1 is ready", "Ready" in page.inner_text("#imp-tbody tr:nth-child(1)"))
    check("row 1 keeps its meta", "Narrative Text" in page.inner_text("#imp-tbody tr:nth-child(1) .qcell"))
    check("row 3 is an exact duplicate of the bank", "Duplicate in bank" in page.inner_text("#imp-tbody tr:nth-child(3)"))
    check("row 3 note names the bank question", "Already in the bank" in page.inner_text("#imp-tbody tr:nth-child(3) .qcell"))
    check("row 4 needs fixing and cannot be chosen", "Fix" in page.inner_text("#imp-tbody tr:nth-child(4)") and page.is_disabled("#imp-tbody tr:nth-child(4) input[type=checkbox]"))
    check("row 4 shows a friendly problem", page.query_selector("#imp-tbody tr:nth-child(4) .imp-problem") is not None)
    check("row 5 is similar to a bank question", "Similar" in page.inner_text("#imp-tbody tr:nth-child(5)"))
    check("the server checked the four answerable rows once", len(srv.import_checks) == 1 and len(srv.import_checks[0]["items"]) == 4)
    first_check = srv.import_checks[0]["items"][0]
    check("the check sends text and answers", first_check["body"].startswith("What did Dina do first") and first_check["options"][0] == "She kept the money.")

    # --- default selection
    checked = page.eval_on_selector_all("#imp-tbody input[type=checkbox]:checked", "els => els.length")
    check("ready and similar rows start checked, exact duplicates and broken rows do not", checked == 3, f"{checked} checked")
    check("the import button counts the selection", page.inner_text("#imp-save") == "Import 3 questions")
    check("select-all is off while the exact duplicate is left out", page.eval_on_selector("#imp-check-all", "el => el.checked") is False)

    # --- select-all: first click adds the duplicate in, second clears everything, third checks all again
    page.click("#imp-check-all")
    check("the first click checks the duplicates too", page.eval_on_selector_all("#imp-tbody input[type=checkbox]:checked", "els => els.length") == 4)
    check("row 4 stays unchecked after select-all", page.is_checked("#imp-tbody tr:nth-child(4) input[type=checkbox]") is False)
    check("the import button counts the new selection", page.inner_text("#imp-save") == "Import 4 questions")
    page.click("#imp-check-all")
    check("the second click clears every choice", page.eval_on_selector_all("#imp-tbody input[type=checkbox]:checked", "els => els.length") == 0)
    check("the import button disables without a selection", page.is_disabled("#imp-save"))
    page.click("#imp-check-all")
    check("the third click checks the importable rows again", page.eval_on_selector_all("#imp-tbody input[type=checkbox]:checked", "els => els.length") == 4)
    page.click("#imp-save")
    page.wait_for_selector(".toast:has-text('Imported 4 questions')")
    check("the import went to the server once", len(srv.imports) == 1 and len(srv.imports[0]["items"]) == 4)
    sent = srv.imports[0]["items"]
    check("the items carry row numbers for error messages", sent[0].get("row") == 1)
    check("true/false arrives with True/False options", sent[1]["type"] == "true_false" and [o["body"] for o in sent[1]["options"]] == ["True", "False"] and sent[1]["options"][1]["is_correct"] is True)
    check("class labels arrive as a list", sent[0]["class_labels"] == ["XII TKJ A", "XII TKJ B"])
    check("the screen returns to the question bank", page.url.endswith("#/questions"))
    page.wait_for_selector(".qtable")
    check("the bank still lists 25 rows per page", page.eval_on_selector_all(".qtable tbody tr", "els => els.length") == 25)

    # --- import from a real .xlsx file
    page.goto(BASE + "#/questions/import")
    page.wait_for_selector("#imp-paste")
    page.set_input_files("#imp-file", str(FIXTURE))
    page.click("#imp-review")
    page.wait_for_function("document.querySelector('#imp-status') && document.querySelector('#imp-status').textContent.includes('selected')")
    rows_text = page.inner_text("#imp-tbody")
    check("the xlsx file was read (multiple choice present)", "What did Dina do first after she found the wallet?" in rows_text)
    check("the xlsx file was read (true/false present)", "Dina found a key." in rows_text)
    check("the file name is named in the status", "import-sample.xlsx" in page.inner_text("#imp-status"))
    mc_row = page.inner_text("#imp-tbody tr:nth-child(1)")
    check("an existing reading text is noted", "already exists" in mc_row, mc_row)
    check("the row without a type is flagged", "Fix" in page.inner_text("#imp-tbody tr:nth-child(4)"))
    check("import button counts the three good rows", page.inner_text("#imp-save") == "Import 3 questions")

    # --- a refused batch keeps the review open and explains the row
    page.unroute("**/functions/v1/**")
    page.route("**/functions/v1/**", lambda route: route.fulfill(status=400, content_type="application/json",
        body=json.dumps({"error": "Row 1: Choose exactly one correct answer.", "code": "bad_request"}))
        if '"import"' in (route.request.post_data or "") else srv.handle(route))
    page.click("#imp-save")
    page.wait_for_function("document.querySelector('#imp-status').textContent.includes('Nothing was saved')")
    check("a refused batch names the row and says nothing was saved", "Row 1:" in page.inner_text("#imp-status") and "Nothing was saved" in page.inner_text("#imp-status"))
    check("the import button comes back after a refusal", page.is_enabled("#imp-save"))
    check("the review is still open after a refusal", page.is_visible("#imp-tbody"))
    check("no import was recorded by the server for the refused batch", len(srv.imports) == 1)

    # --- leaving with an unsaved review asks first
    page.goto(BASE + "#/questions/import")
    page.wait_for_selector("#imp-paste")
    page.fill("#imp-paste", "1. Only one question?\nA. yes\nB. no\nAnswer: A")
    page.click("#imp-review")
    page.wait_for_selector("#imp-tbody tr")
    page.evaluate("location.hash = '#/questions'")
    page.wait_for_selector("dialog.dialog")
    check("leaving with a ready review asks first", "Leave without importing?" in page.inner_text("dialog.dialog"))
    page.click("dialog.dialog button:has-text('Keep reviewing')")
    check("staying keeps the review", page.url.endswith("#/questions/import") and page.is_visible("#imp-tbody"))
    page.evaluate("location.hash = '#/questions'")
    page.wait_for_selector("dialog.dialog")
    page.click("dialog.dialog button:has-text('Leave')")
    page.wait_for_function("location.hash === '#/questions' && document.querySelector('.qb-layout') !== null")
    check("leaving after confirming lands on the bank", page.url.endswith("#/questions"))

    # --- example button fills the textarea
    page.goto(BASE + "#/questions/import")
    page.wait_for_selector("#imp-paste")
    check("the textarea starts empty", page.input_value("#imp-paste") == "")
    page.click("#imp-example")
    check("the example fills the textarea", "Reading text: The Lost Wallet" in page.input_value("#imp-paste"))
    check("no page errors so far", errors == [], "; ".join(errors))

    browser.close()

print()
if failures:
    print(f"{len(failures)} FAILED: " + "; ".join(failures)); sys.exit(1)
print("All import checks passed.")
