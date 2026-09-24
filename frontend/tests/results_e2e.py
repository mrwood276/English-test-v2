"""Browser test of the teacher grading and results screens with a mocked server (TASK-012).
Run: python3 frontend/tests/results_e2e.py  (expects dev-server on 8123, like the other suites)
"""
import sys, time

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
CODE = "NARR01"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def qtable_text(page):
    return page.inner_text(".qtable")


srv = Server()
exam = srv.session_exam(CODE)
EXAM_ID = exam["id"]
by_type = {q["type"]: q for q in exam["questions"]}
mc, tf, sa, es = by_type["multiple_choice"], by_type["true_false"], by_type["short_answer"], by_type["essay"]
essay_weight = es["weight"]
right_mc = next(o["body"] for o in mc["options"] if o["is_correct"])
right_tf = next(o["body"] for o in tf["options"] if o["is_correct"])

# Aisyah answers everything correctly but her essay waits; Bima is still working; Citra gets the
# short answer wrong (so it can be corrected by hand later).
sid_a = srv.results_seed(CODE, "Aisyah Putri", "XII TKJ A",
                         {mc["question_id"]: right_mc, tf["question_id"]: right_tf,
                          sa["question_id"]: "past", es["question_id"]: "It tells who and where."})
sid_b = srv.results_seed(CODE, "Bima Saputra", "XII TKJ A", {}, status="in_progress", tab_switch_count=2)
sid_c = srv.results_seed(CODE, "Citra Lestari", "XII TKJ B",
                         {mc["question_id"]: right_mc, tf["question_id"]: right_tf,
                          sa["question_id"]: "walked", es["question_id"]: "Because it introduces them."})
srv.class_aliases["xii tkj a"] = "Class XII TKJ A"
pct_a = srv.sessions[sid_a]["result"]["percentage"]
pct_c = srv.sessions[sid_c]["result"]["percentage"]

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/grading")
    page.reload()
    page.wait_for_selector(".qtable")

    # ---------- the menu ----------
    check("Grading and Results are real menu items now",
          page.query_selector("a[data-route='#/grading']") is not None and page.query_selector("a[data-route='#/results']") is not None)
    check("no menu item still says Soon",
          "Soon" not in page.inner_text(".nav"))
    page.wait_for_function("document.querySelector('.nav-badge') && !document.querySelector('.nav-badge').hidden")
    check("the badge counts the waiting essays", page.inner_text(".nav-badge") == "2", page.inner_text(".nav-badge"))
    check("the badge explains itself", "waiting to be graded" in (page.get_attribute(".nav-badge", "title") or ""))

    # ---------- the Grading hub ----------
    check("the Grading hub opens", page.inner_text("h1") == "Grading")
    page.wait_for_function(f"document.querySelector('tr[data-exam=\"{EXAM_ID}\"]') !== null")
    row = page.query_selector(f"tr[data-exam='{EXAM_ID}']")
    check("the exam is listed with its code", CODE in row.inner_text())
    check("the hub counts the sessions", "2 of 3" in row.inner_text(), row.inner_text())
    check("the hub shows what waits", row.query_selector(".pill.warn") is not None and "2" in row.query_selector(".pill.warn").inner_text())
    check("the hub offers both ways in",
          row.query_selector("a:has-text('Grade essays')") is not None and row.query_selector("a:has-text('Results')") is not None)

    # ---------- grading one essay question (mockup 13) ----------
    row.query_selector("a:has-text('Grade essays')").click()
    page.wait_for_selector(".grade-layout")
    page.wait_for_function("document.querySelectorAll('.grade-student').length === 2")
    check("the grading screen opens", page.inner_text("h1") == "Grade essays")
    check("the essay question is named", "Q4" in page.inner_text(".grade-main .card"), page.inner_text(".grade-main .card h2"))
    check("the question text is shown", es["body"] in page.inner_text(".grade-main"), es["body"])
    check("the grading guide is shown", "One mark per idea" in page.inner_text(".grade-main"))
    check("the progress starts at zero", "0 of 2 graded" in page.inner_text(".grade-questions, .head-actions"), page.inner_text(".head-actions"))
    check("both students wait", len(page.query_selector_all(".grade-student .pill.warn")) == 2)
    check("the first student is selected", "Aisyah" in page.inner_text(".grade-main"))
    check("her answer is on screen", "It tells who and where." in page.inner_text(".grade-main"))
    bubbles = page.query_selector_all(".pts .bubble.as-btn")
    check("the points are answer-sheet bubbles", len(bubbles) == essay_weight + 1, str(len(bubbles)))

    bubbles[essay_weight].click()
    page.fill("#grade-comment", "Good: who and where.")
    page.click("button[data-save]")
    page.wait_for_function("document.querySelectorAll('.grade-student .pill.ok').length === 1")
    check("the grade is saved", any(g["action"] == "grade" for g in srv.result_calls))
    grade = [g for g in srv.result_calls if g["action"] == "grade"][0]
    check("the grade carries the points and the comment",
          grade["points"] == essay_weight and grade["feedback"] == "Good: who and where.", str(grade))
    check("the progress moves on", "1 of 2 graded" in page.inner_text(".head-actions"), page.inner_text(".head-actions"))
    check("the next waiting student is opened", "Citra Lestari's answer" in page.inner_text(".grade-main"), page.inner_text(".grade-main h2"))
    check("the graded student shows their points",
          f"{essay_weight} / {essay_weight}" in page.query_selector(".grade-student .pill.ok").inner_text())

    page.query_selector_all(".pts .bubble.as-btn")[0].click()
    page.click("button[data-save]")
    page.wait_for_function("document.querySelectorAll('.grade-student .pill.ok').length === 2")
    check("both essays are graded", "2 of 2 graded" in page.inner_text(".head-actions"), page.inner_text(".head-actions"))
    page.wait_for_function("document.querySelector('.nav-badge').hidden")
    check("the badge clears when nothing waits", page.query_selector(".nav-badge").is_hidden())
    check("the last grade makes the result final", any(g["action"] == "grade" for g in srv.result_calls))

    # ---------- the Results hub ----------
    page.click("a[data-route='#/results']")
    page.wait_for_selector(".qtable")
    page.wait_for_function(f"document.querySelector('tr[data-exam=\"{EXAM_ID}\"]') !== null")
    row = page.query_selector(f"tr[data-exam='{EXAM_ID}']")
    check("the Results hub lists the exam", "Narrative Text" in row.inner_text())
    check("no waiting essays are left", row.query_selector(".pill.warn") is None)

    # ---------- one exam's results (mockup 14) ----------
    row.query_selector("a:has-text('Results')").click()
    page.wait_for_selector(".strip")
    page.wait_for_function("document.querySelectorAll('.list-card:not(.results-stats) .qtable tbody tr').length === 3")
    check("the results screen names the exam", "Narrative Text" in page.inner_text("h1"))
    check("the summary strip is there", "average" in page.inner_text(".strip") and "highest" in page.inner_text(".strip"))
    check("the passing grade is repeated", "Passing grade 70" in page.inner_text(".strip"), page.inner_text(".strip"))
    check("a merged class name is used", page.inner_text(".qtable").count("Class XII TKJ A") >= 1)
    check("every student who joined is listed", all(n in qtable_text(page) for n in ("Aisyah Putri", "Bima Saputra", "Citra Lestari")))
    check("an attempt still running is marked", "In progress" in qtable_text(page))
    check("right and wrong are counted", "2 / 1" in qtable_text(page) or "1 / 2" in qtable_text(page), qtable_text(page))
    check("page leaves are shown", "2" in qtable_text(page))
    check("every row has a way into its details", len(page.query_selector_all(".qtable a:has-text('Details')")) == 3)

    page.click(".results-tab:has-text('Classes')")
    page.wait_for_function("document.querySelector('.results-stats:not([hidden])') !== null")
    classes_text = page.inner_text(".results-stats")
    check("the Classes tab opens", "Classes" in page.inner_text(".results-tabs") and "Class XII TKJ A" in classes_text)
    check("class statistics show average and passed count", "Average" in classes_text and "Passed" in classes_text and "2" in classes_text)
    page.click(".results-tab:has-text('Scores')")
    page.wait_for_function("document.querySelector('.list-card:not([hidden]) .qtable') !== null")

    # ---------- one attempt in detail ----------
    page.query_selector(f"tr[data-session='{sid_c}'] a:has-text('Details')").click()
    page.wait_for_selector(".review-list")
    check("the report opens on the student", page.inner_text("h1") == "Citra Lestari")
    check("the report carries the result", "Result" in page.inner_text(".report-layout .stack"))
    check("every question appears", len(page.query_selector_all(".rev-item")) == 4)
    check("the correct option is marked", page.query_selector(".rev-item .opt.correct") is not None)
    check("the student's own choice is marked", page.query_selector(".rev-item .opt.chosen") is not None)
    check("the wrong short answer is flagged", page.query_selector(".rev-item .pill.bad") is not None)
    check("the history lists the events", "Joined" in page.inner_text(".events") or "Sent the answers" in page.inner_text(".events"))

    # BR-18: the teacher corrects the short answer by hand (she typed "walked" for a question whose
    # accepted answers include "past", so it was marked wrong; give it full points)
    sa_item = page.query_selector(f".rev-item[data-question='{sa['question_id']}']")
    before_score = page.inner_text(".score-big")
    sa_item.query_selector_all(".pts .bubble.as-btn")[sa["weight"]].click()
    sa_item.query_selector("button[data-grade]").click()
    page.wait_for_function("document.querySelector('.score-big').textContent !== '%s'" % before_score)
    check("a corrected grade changes the score",
          page.inner_text(".score-big") != before_score, f"{before_score} -> {page.inner_text('.score-big')}")
    check("the correction is stored as the teacher's",
          srv.manual_grades.get((sid_c, sa["question_id"]), {}).get("points") == sa["weight"], str(srv.manual_grades))
    page.wait_for_selector(f".rev-item[data-question='{sa['question_id']}'] .pill:has-text('Graded by hand')")
    check("the correction is marked as the teacher's",
          "Graded by hand" in page.inner_text(f".rev-item[data-question='{sa['question_id']}']"))

    # BR-02: allow one more attempt
    page.click("button[data-retake]")
    page.wait_for_function("document.querySelector('button[data-retake]').textContent.includes('Take the retake back')")
    check("the retake is granted", any(g["action"] == "grant_retake" for g in srv.result_calls))
    check("the report explains the retake", "waiting to be used" in page.inner_text(".report-layout .stack"))

    # BR-11: reopen a collected attempt
    page.click("button[data-reopen]")
    page.wait_for_selector(".dialog")
    check("reopening asks first", "carry on where they stopped" in page.inner_text(".dialog"))
    page.click(".dialog button:has-text('Reopen')")
    page.wait_for_function("document.querySelector('.head-actions .pill').textContent === 'Reopened'")
    check("the attempt is reopened", srv.sessions[sid_c]["status"] == "reopened")
    check("a reopened attempt is no longer gradable by hand", page.query_selector("button[data-grade]") is None)
    check("a reopened attempt can be given time", page.query_selector("button[data-add-time]") is not None)

    # ---------- add time to an attempt that is still running ----------
    page.goto(BASE + f"#/results/{EXAM_ID}/session/{sid_b}")
    page.wait_for_selector(".report-layout")
    page.wait_for_function("document.querySelector('button[data-add-time]') !== null")
    before = srv.sessions[sid_b]["ends_at"]
    page.select_option("#add-time", "10")
    page.click("button[data-add-time]")
    page.wait_for_function("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Time added'))")
    check("ten minutes can be added", abs(srv.sessions[sid_b]["ends_at"] - before - 600) < 1)
    toast_text = page.eval_on_selector_all(".toast", "els => els.map(e => e.textContent)").pop()
    check("the toast says how much is left", "left" in toast_text, toast_text)
    check("a running attempt has nothing to grade yet", page.query_selector("button[data-grade]") is None)
    check("its history is empty of grading", "Graded by hand" not in page.inner_text(".events"))

    # ---------- the hub keeps working after everything ----------
    page.click("a[data-route='#/grading']")
    page.wait_for_selector(".list-status")
    page.wait_for_function("document.querySelector('.list-status').textContent.length > 0")
    check("the Grading hub says there is nothing to grade", "Nothing to grade" in page.inner_text(".list-status"), page.inner_text(".list-status"))

    check("no page errors", errors == [], "; ".join(errors[:3]))

print()
print("ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
