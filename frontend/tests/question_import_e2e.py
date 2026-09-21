"""Browser test for the question-import review and mocked save flow."""
import sys, time
from playwright.sync_api import sync_playwright
from mock_server import Server
BASE = "http://127.0.0.1:8123/teacher/index.html"
with sync_playwright() as pw:
  browser=pw.chromium.launch(); page=browser.new_page(); srv=Server()
  page.route("**/functions/v1/**", srv.handle); page.route("**/fonts.googleapis.com/**", lambda r:r.fulfill(status=200,body=""))
  page.goto(BASE); page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))"%(int(time.time())+3600))
  page.goto(BASE+"#/questions/import"); page.reload(); page.wait_for_selector("textarea[aria-label='Paste questions']")
  page.fill("textarea[aria-label='Paste questions']", "1. Who found it?\nA. *Dina\nB. Budi\n\n2. Bad question\nA. Only one")
  page.click("button:has-text('Review import')"); page.wait_for_selector("h2:has-text('Review import')")
  assert "Ready" in page.inner_text(".qtable") and "Answers need" in page.inner_text(".qtable")
  page.click("button:has-text('Import 1 question')"); page.wait_for_url("**/#/questions")
  assert len(srv.imported)==1 and len(srv.imported[0]["items"])==1
  browser.close()
print("ALL CHECKS PASSED")
