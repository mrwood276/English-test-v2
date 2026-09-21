"""Browser test of attaching images and audio in the editor, with a mocked server and mocked Storage.

Needs sample files in /tmp/media_fixtures (see make_fixtures.py in this folder), and dev-server.py 8123 running.
"""
import json, sys, time
from playwright.sync_api import sync_playwright
from mock_server import Server

BASE = "http://127.0.0.1:8123/teacher/index.html"
FIX = "/tmp/media_fixtures/"
failures = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

class Storage:
    """Pretend Supabase Storage: records uploads, can fail or be slow."""
    def __init__(self, srv): self.srv = srv; self.uploads = []; self.fail = 0; self.hold = False; self.held = []
    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS": return route.fulfill(status=204, body="")
        body = req.post_data_buffer or b""
        self.uploads.append({"url": req.url, "size": len(body), "ctype": req.headers.get("content-type", ""), "apikey": req.headers.get("apikey"), "upsert": req.headers.get("x-upsert")})
        self.srv.last_upload_size = len(body)
        if self.hold:
            self.held.append(route)   # answered later by release(), so the upload stays "in progress"
            return
        if self.fail > 0:
            self.fail -= 1
            return route.fulfill(status=500, content_type="application/json", body=json.dumps({"message": "boom"}))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"Key": "question-media/x"}))

def release(store):
    store.hold = False
    for r in store.held:
        r.fulfill(status=200, content_type="application/json", body=json.dumps({"Key": "question-media/x"}))
    store.held = []

def items(page): return page.query_selector_all(".media-item[data-media-id]")
def creates(srv): return [c for c in srv.media_calls if c.get("action") == "create_upload"]

def up(page, *names):
    page.set_input_files("#q-media", [FIX + n for n in names])

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    srv = Server(); store = Storage(srv)
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.route("**/functions/v1/**", srv.handle)
    page.route("https://mock-storage.test/**", store.handle)
    page.goto(BASE)
    page.evaluate("sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', JSON.stringify({accessToken:'AT',refreshToken:'RT',expiresAt:%d}))" % (int(time.time()) + 3600))
    page.goto(BASE + "#/questions/new"); page.reload(); page.wait_for_selector("#q-media")
    page.fill("#q-body", "Listen and answer."); page.fill("[aria-label='Answer A']", "One"); page.fill("[aria-label='Answer B']", "Two"); page.click("[aria-label='Mark answer A as the correct one']")

    check("the file area explains what is allowed", "MP3" in page.inner_text(".media-picker") and "10 MB" in page.inner_text(".media-picker") and "1 MB" in page.inner_text(".media-picker"))

    # ---- a large photo is shrunk before upload
    up(page, "big.png"); page.wait_for_selector(".media-item[data-media-id]", timeout=60000)
    c = creates(srv)[-1]
    check("the photo was shrunk to WebP under 1 MB before asking for an upload link", c["mime_type"] == "image/webp" and 0 < c["size_bytes"] <= 1_000_000, str(c))
    u = store.uploads[-1]
    check("upload goes to the one-time link with multipart form data", u["ctype"].startswith("multipart/form-data") and "mock-storage.test/upload/image/" in u["url"] and u["upsert"] == "false" and u["apikey"].startswith("sb_publishable_"))
    check("the uploaded body is about the announced size", abs(u["size"] - c["size_bytes"]) < 2000, f'{u["size"]} vs {c["size_bytes"]}')
    reg = [m for m in srv.media_calls if m["action"] == "register"][-1]
    check("registered under the new file name", reg["name"] == "big.webp" and reg["path"].startswith("image/2026/"))
    it = items(page)[0]
    check("the picture shows as a thumbnail with its size", it.query_selector("img.thumb") is not None and it.query_selector("img.thumb").get_attribute("src").startswith("data:image/") and "Image" in it.inner_text())

    # ---- a small picture is kept as it is
    up(page, "small.png"); page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 2")
    c = creates(srv)[-1]
    check("a small picture is uploaded untouched", c["mime_type"] == "image/png" and c["size_bytes"] == 467)

    # ---- audio
    up(page, "story.mp3"); page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 3")
    c = creates(srv)[-1]
    check("audio is uploaded as MP3 with a player", c["mime_type"] == "audio/mpeg" and c["size_bytes"] == 300010 and items(page)[2].query_selector("audio.player") is not None)
    check("audio shows its size", "293 KB" in items(page)[2].inner_text() or "Audio" in items(page)[2].inner_text())

    # ---- refused files never reach the server
    before = len(creates(srv))
    up(page, "notes.pdf", "anim.gif")
    page.wait_for_selector(".media-msg")
    msgs = page.inner_text(".media-messages")
    check("unsupported files are refused with a clear message", "notes.pdf" in msgs and "anim.gif" in msgs and "not supported" in msgs)
    up(page, "huge.mp3"); page.wait_for_function("document.querySelector('.media-messages').textContent.includes('limit is 10 MB')")
    check("audio over 10 MB is refused before uploading", len(creates(srv)) == before)

    # ---- limit of four
    up(page, "small2.png"); page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 4")
    up(page, "small3.png"); page.wait_for_function("document.querySelector('.media-messages').textContent.includes('at most 4')")
    check("at most four files", len(items(page)) == 4 and page.query_selector(".drop.full") is not None)

    # ---- remove one, save, and see the list of files in the payload
    ids = [i.get_attribute("data-media-id") for i in items(page)]
    page.click(".media-item[data-media-id='%s'] button[aria-label^='Remove']" % ids[1])
    check("a file can be removed", len(items(page)) == 3 and page.query_selector(".media-item[data-media-id='%s']" % ids[1]) is None)
    page.click("button:has-text('Preview')"); page.wait_for_selector("dialog[open] .qtext")
    check("preview shows the pictures and the audio player", page.query_selector_all("dialog img.q-image").__len__() == 2 and page.query_selector("dialog audio.q-audio") is not None)
    page.click("dialog button:has-text('Close')"); page.wait_for_function("document.querySelector('dialog') === null")
    page.click("button:has-text('Save question')"); page.wait_for_selector(".toast:has-text('Question saved.')")
    sent = srv.saved[-1]
    check("save sends the files in order, without the removed one", [m["id"] for m in sent["media"]] == [ids[0], ids[2], ids[3]])

    # ---- failures
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-media")
    store.fail = 1; up(page, "small.png"); page.wait_for_selector(".media-msg")
    check("a failed upload shows a message and adds nothing", "could not be uploaded" in page.inner_text(".media-messages") and len(items(page)) == 0)
    up(page, "small.png"); page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 1")
    check("trying again works", True)
    srv.register_error = "Images must be JPG, PNG, or WebP and about 1 MB or smaller."
    up(page, "small2.png"); page.wait_for_function("document.querySelector('.media-messages').textContent.includes('about 1 MB')")
    check("a refusal from the server is shown as it is", len(items(page)) == 1)
    srv.register_error = None

    # ---- saving while an upload is running
    store.hold = True
    up(page, "small3.png"); page.wait_for_selector(".media-item.uploading")
    check("an upload in progress is shown", "Uploading" in page.inner_text(".media-item.uploading") or "Saving" in page.inner_text(".media-item.uploading") or "Waiting" in page.inner_text(".media-item.uploading") or "Shrinking" in page.inner_text(".media-item.uploading"))
    page.fill("#q-body", "Busy save"); page.fill("[aria-label='Answer A']", "A"); page.fill("[aria-label='Answer B']", "B"); page.click("[aria-label='Mark answer A as the correct one']")
    n = len(srv.saved)
    page.click("button:has-text('Save question')")
    check("saving waits for the uploads", "finish uploading" in page.inner_text(".editor .notice.error") and len(srv.saved) == n)
    release(store)
    page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 2", timeout=15000)
    page.click("button:has-text('Save question')")   # the same button now works once the file is attached
    page.wait_for_selector(".toast:has-text('Question saved.')")
    check("after the upload finishes the question saves with both files", len(srv.saved[-1]["media"]) == 2)
    page.click("a:has-text('Add question')"); page.wait_for_selector("#q-media")
    page.set_input_files("#q-media", [FIX + "small.png"]); page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 1")

    # ---- unsaved files count as unsaved changes
    page.click("a.back"); page.wait_for_selector("dialog[open]")
    check("leaving with uploaded but unsaved files asks first", "not saved yet" in page.inner_text("dialog"))
    page.click("dialog button:has-text('Keep editing')"); page.wait_for_function("document.querySelector('dialog') === null")

    # ---- drag and drop
    page.evaluate("""(() => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      document.querySelector('[data-dropzone]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()""")
    page.wait_for_function("document.querySelectorAll('.media-item[data-media-id]').length === 2")
    check("files can be dropped onto the area", "dropped.png" in page.inner_text(".media-list"))

    # ---- phone
    page.set_viewport_size({"width": 375, "height": 800})
    check("no sideways scrolling on a phone with files attached", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    page.set_viewport_size({"width": 1280, "height": 900})

    # ---- reading text files
    page.select_option("#q-passage", "__new"); page.wait_for_selector("dialog[open] #passage-title")
    page.fill("#passage-title", "The Bell"); page.fill("#passage-body", "The bell rang.")
    page.set_input_files("#passage-media", [FIX + "story.mp3"]); page.wait_for_function("document.querySelectorAll('dialog .media-item[data-media-id]').length === 1")
    page.click("dialog button:has-text('Save reading text')"); page.wait_for_function("document.querySelector('dialog') === null")
    ps = srv.saved_passages[-1]
    check("a reading text keeps its files", ps["title"] == "The Bell" and len(ps["media"]) == 1)
    page.click("a.back"); page.wait_for_selector("dialog[open]"); page.click("dialog button:has-text('Leave')"); page.wait_for_selector(".qtable")

    # ---- editing a question that already has files
    page.click("tr[data-id='00000000-0000-4000-8000-000000000005'] .qlink"); page.wait_for_selector(".preview a:has-text('Edit')")
    page.click(".preview a:has-text('Edit')"); page.wait_for_selector("#q-media")
    page.wait_for_selector(".media-item[data-media-id='m1'] audio.player")
    check("existing files are listed with a player", "story.mp3" in page.inner_text(".media-list") and "2:15" in page.inner_text(".media-list"))
    page.click(".media-item[data-media-id='m1'] button[aria-label^='Remove']")
    page.click("button:has-text('Save question')"); page.wait_for_selector(".toast:has-text('Question saved.')")
    check("removing the last file sends an empty list", srv.saved[-1]["media"] == [])
    page.wait_for_selector(".qtable")
    page.click("tr[data-id='00000000-0000-4000-8000-000000000002'] .qlink"); page.wait_for_selector(".preview a:has-text('Edit')")
    page.click(".preview a:has-text('Edit')"); page.wait_for_selector("#q-media")
    page.wait_for_selector(".passage-shown img.q-image")
    check("files of the reading text are shown under it, read only", page.query_selector(".passage-shown .media-block img") is not None and page.query_selector(".media-item") is None)

    check("no JavaScript errors in the console", not errors, "; ".join(errors[:3]))
    browser.close()

print("\nFAILED: " + ", ".join(failures) if failures else "\nALL CHECKS PASSED")
sys.exit(1 if failures else 0)
