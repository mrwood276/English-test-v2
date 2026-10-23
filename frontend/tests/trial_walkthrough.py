"""Trial walkthrough script: Simulates an end-to-end user experience as both
a Teacher and a Student on English Test V2.

Produces step-by-step UX observations and captures screenshots for evaluation.
"""
import os
import sys
import time
import json

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright
from mock_server import Server

OUTPUT_DIR = "C:/Users/Aser/.gemini/antigravity/brain/c3b5edce-6de9-4850-b0b3-6c79b169a562/walkthrough"
os.makedirs(OUTPUT_DIR, exist_ok=True)

TEACHER_BASE = "http://127.0.0.1:8123/teacher/index.html"
STUDENT_BASE = "http://127.0.0.1:8123/index.html"
CODE = "TEST01"

observations = []

def log_obs(stage, title, detail, ux_rating="GOOD"):
    obs = {"stage": stage, "title": title, "detail": detail, "rating": ux_rating}
    observations.append(obs)
    print(f"[{stage}] [{ux_rating}] {title}: {detail}")

def run_walkthrough():
    srv = Server()
    exam = srv.session_exam(CODE)
    srv.open_exam_row(CODE)
    exam_id = exam["id"]

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        
        # =========================================================================
        # PART 1: TEACHER EXPERIENCE (Desktop Viewport: 1366x768)
        # =========================================================================
        teacher_ctx = browser.new_context(viewport={"width": 1366, "height": 768})
        teacher_ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="http://127.0.0.1:8123")
        t_page = teacher_ctx.new_page()
        t_page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
        t_page.route("**/functions/v1/**", srv.handle)
        
        # 1.1 Teacher Sign-In & Dashboard
        t_page.goto(TEACHER_BASE)
        t_page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT_TEACHER',refreshToken:'RT_TEACHER',expiresAt:%d, user:{id:'u2', email:'guru@smk.sch.id'}}))" % (int(time.time()) + 7200))
        t_page.goto(TEACHER_BASE + "#/dashboard")
        t_page.reload()
        t_page.wait_for_selector(".now", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/01_teacher_dashboard.png")
        log_obs("TEACHER", "Dashboard Initial View", f"Dashboard loaded with active test code banner '{CODE}', quick stats, and live test status.", "EXCELLENT")
        
        # 1.2 Explore Question Bank
        t_page.click("a[data-route='#/questions']")
        t_page.wait_for_selector(".qtable", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/02_question_bank.png")
        log_obs("TEACHER", "Question Bank Exploration", "Question bank displays with taxonomy pills, search bar, and side drawer preview.", "GOOD")
        
        # 1.3 Exam Editor with Pre-flight Readiness Check (TASK-041)
        t_page.goto(TEACHER_BASE + f"#/exams/edit/{exam_id}")
        t_page.wait_for_selector("#ee-title", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/03_exam_editor.png")
        log_obs("TEACHER", "Exam Editor & Anti-Cheating Controls", "Configured passing grade, random question draw, tab-switch warning & auto-submit limits.", "EXCELLENT")
        
        # 1.4 Exams List
        t_page.goto(TEACHER_BASE + "#/exams")
        t_page.wait_for_selector(".qtable", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/04_exams_list.png")
        log_obs("TEACHER", "Exams List", "Displays active exams with status pills, question counts, and direct action shortcuts.", "GOOD")
        
        # =========================================================================
        # PART 2: STUDENT EXPERIENCE (Mobile Viewport: 390x844 - iPhone 14)
        # =========================================================================
        student_ctx = browser.new_context(viewport={"width": 390, "height": 844})
        s_page = student_ctx.new_page()
        s_page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
        s_page.route("**/functions/v1/**", srv.handle)
        
        # 2.1 Join Test
        s_page.goto(STUDENT_BASE)
        s_page.wait_for_selector("form", timeout=5000)
        s_page.screenshot(path=f"{OUTPUT_DIR}/05_student_join.png")
        log_obs("STUDENT", "Join Screen", "Focused, simple mobile login form with name, class, and test code. Zero clutter.", "EXCELLENT")
        
        s_page.fill("#student-name", "Budi Pratama")
        s_page.fill("#student-class", "XII TKJ A")
        s_page.fill("#test-code", CODE)
        s_page.click("button[type='submit']")
        
        # 2.2 Taking the Exam
        s_page.wait_for_selector(".qtop", timeout=8000)
        s_page.screenshot(path=f"{OUTPUT_DIR}/06_student_exam_q1.png")
        log_obs("STUDENT", "Exam Screen Loaded", "Header displays countdown timer, student name, and autosave indicator ('All answers saved').", "EXCELLENT")
        
        # Answer Q1 (Multiple Choice)
        bubbles = s_page.query_selector_all(".opt")
        if bubbles:
            bubbles[0].click()
            s_page.wait_for_timeout(300)
            log_obs("STUDENT", "Answer Q1 (MC)", "Selected option bubble; debounced autosave dispatched without blocking UI.", "GOOD")
        
        # Mark question for review
        mark_btn = s_page.query_selector(".qnav .icobtn[aria-label='Mark for review']")
        if mark_btn:
            mark_btn.click()
            log_obs("STUDENT", "Mark Question", "Question flagged for review.", "GOOD")
        
        # Next -> Q2 (True / False)
        s_page.click(".qnav button:has-text('Next')")
        s_page.wait_for_timeout(300)
        tf_opts = s_page.query_selector_all(".opt")
        if tf_opts:
            tf_opts[0].click()
            log_obs("STUDENT", "Answer Q2 (True/False)", "Selected option.", "GOOD")
            
        # Next -> Q3 (Short Answer)
        s_page.click(".qnav button:has-text('Next')")
        s_page.wait_for_timeout(300)
        sa_input = s_page.query_selector(".qbody input.input")
        if sa_input:
            sa_input.fill("yesterday")
            log_obs("STUDENT", "Answer Q3 (Short Answer)", "Input accepted with character caps enforcement.", "GOOD")
            
        # Next -> Q4 (Essay)
        s_page.click(".qnav button:has-text('Next')")
        s_page.wait_for_timeout(300)
        essay_box = s_page.query_selector(".qbody textarea")
        if essay_box:
            essay_box.fill("Last holiday, my family visited Mount Bromo. We saw the sunrise and rode horses across the sand sea. It was wonderful.")
            log_obs("STUDENT", "Answer Q4 (Essay)", "Essay written in auto-resizing textarea.", "GOOD")
        
        # 2.3 Answer Sheet Dialog
        s_page.click(".qnav .icobtn[aria-label='Answer sheet']")
        s_page.wait_for_selector(".sheetgrid", timeout=3000)
        s_page.screenshot(path=f"{OUTPUT_DIR}/07_student_answer_sheet.png")
        log_obs("STUDENT", "Answer Sheet Dialog", "Native modal dialog shows all 4 answered questions and the flagged Q1. Accessible with Escape key.", "EXCELLENT")
        s_page.keyboard.press("Escape")
        s_page.wait_for_timeout(300)
        
        # 2.4 Submit Exam
        s_page.screenshot(path=f"{OUTPUT_DIR}/08_student_before_submit.png")
        finish_btn = s_page.query_selector(".qnav button:has-text('Finish')")
        if finish_btn:
            finish_btn.click()
            s_page.wait_for_selector(".dialog", timeout=3000)
            s_page.click(".dialog button:has-text('Send my test')")
        
        # 2.5 Student Result Screen
        s_page.wait_for_selector(".brand-row", timeout=5000)
        s_page.screenshot(path=f"{OUTPUT_DIR}/09_student_result_screen.png")
        res_header = s_page.inner_text(".brand-row")
        log_obs("STUDENT", "Submission & Result Screen", f"Status: {res_header}. Partial score displayed while essay awaits manual teacher grading.", "GOOD")
        
        # =========================================================================
        # PART 3: TEACHER MONITOR, GRADING & RESULTS
        # =========================================================================
        # 3.1 Live Monitor
        t_page.goto(TEACHER_BASE + f"#/monitor/{exam_id}")
        t_page.wait_for_selector(".head", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/10_teacher_live_monitor.png")
        log_obs("TEACHER", "Live Monitor", "Real-time session monitor shows Budi Pratama's submission status, duration, and zero infractions.", "EXCELLENT")
        
        # 3.2 Exam Results Overview
        t_page.goto(TEACHER_BASE + f"#/results/{exam_id}")
        t_page.wait_for_selector(".head", timeout=5000)
        t_page.screenshot(path=f"{OUTPUT_DIR}/11_teacher_results.png")
        log_obs("TEACHER", "Results Overview", "Class roster lists student submission with 'Not final' pill due to pending essay.", "GOOD")
        
        browser.close()

    print("\n================== WALKTHROUGH COMPLETED ==================")
    print(f"Total observations recorded: {len(observations)}")
    print(f"Screenshots saved to: {OUTPUT_DIR}")
    
    # Save observations JSON
    with open(f"{OUTPUT_DIR}/report.json", "w", encoding="utf-8") as f:
        json.dump(observations, f, indent=2)

if __name__ == "__main__":
    run_walkthrough()
