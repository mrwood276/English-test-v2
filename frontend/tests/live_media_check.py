"""LIVE run of the image and audio upload against real Supabase Storage (TASK-007 / ISSUE-002).

Not part of CI. This is the check the mocked suite cannot make: the *local* teacher app, talking to
the real project with the real publishable key, uploading a real photo and a real MP3 through the
editor's own file picker into the private `question-media` bucket, and reading them back through the
short-lived viewing links the app itself asks for.

    python frontend/dev-server.py 8123        # in another terminal
    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' python frontend/tests/live_media_check.py

Set SUPABASE_ACCESS_TOKEN (a Supabase Management token) too and the run also checks the database and
the bucket, and removes its own test rows and Storage objects afterwards (`--keep` skips that).
Without the token the app part still runs; the ids to clean up are printed at the end.

What it proves, in order:
  1. the staff test account signs in and passes the staff gate;
  2. the one-time upload link the `media` function hands out is an absolute Storage URL;
  3. the app shrinks the large photo, PUTs both files straight to Storage, and the rows that come
     back carry the size and type Storage itself reported (not what the browser claimed);
  4. saving attaches both files to the question;
  5. reopening the question shows the picture and the player, and both really load and really play;
  6. a file put into Storage on purpose that is over the limit is refused and deleted again;
  7. the function refuses a teacher's admin-only action and a tokenless call.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "frontend/tests")
from playwright.sync_api import sync_playwright

from fixtures_dir import fixtures_dir

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
BUCKET = "question-media"
EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD", "")
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
KEEP = "--keep" in sys.argv
BASE = "http://127.0.0.1:8123/teacher/index.html"
TITLE = "Live media check (safe to delete)"
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None, raw=False):
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode("utf-8", "replace")
            return res.status, (text if raw else json.loads(text or "null"))
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(text or "null")
        except ValueError:
            return err.code, text


def call(name, body, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return http("POST", f"{URL}/functions/v1/{name}", body, headers)


def mgmt(path, body=None, method="GET"):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/{path}",
                                 data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as res:
        return json.loads(res.read().decode() or "null")


def sql(query):
    return mgmt("database/query", {"query": query}, "POST")


def api_key(name):
    return next(k["api_key"] for k in mgmt("api-keys") if k["name"] == name)


def storage_remove(paths):
    key = api_key("service_role")
    req = urllib.request.Request(f"{URL}/storage/v1/object/{BUCKET}", data=json.dumps({"prefixes": paths}).encode(),
                                 method="DELETE",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode() or "null")


# ---------- the sample files: a large photo, a real MP3, an over-limit JPEG ----------
def make_files():
    from PIL import Image
    folder = os.path.join(fixtures_dir(), "live")
    os.makedirs(folder, exist_ok=True)
    photo, tone, oversized = (os.path.join(folder, n) for n in
                              ("live-photo.png", "live-tone.mp3", "live-oversized.jpg"))
    if not os.path.exists(photo):                       # the "large photo" the app must shrink
        import random
        random.seed(11)
        w, h = 2400, 1600
        img = Image.new("RGB", (w, h))
        px = img.load()
        for y in range(h):
            for x in range(w):
                n = random.randint(-40, 40)
                px[x, y] = ((x * 255 // w + n) % 256, (y * 255 // h + n) % 256, ((x + y) * 255 // (w + h) + n) % 256)
        img.save(photo)
    if not os.path.exists(tone):                        # a real, decodable 3-second tone
        try:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                            "-c:a", "libmp3lame", "-b:a", "128k", tone], check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            raise SystemExit("ffmpeg is needed for the real MP3. Install it, or put a 3-second MP3 at "
                             + tone + " yourself and run again.")
    if not os.path.exists(oversized):                   # a JPEG that only the *server* can see is too big
        import random
        random.seed(12)
        w, h = 2400, 1600
        img = Image.new("RGB", (w, h))
        px = img.load()
        for y in range(h):
            for x in range(w):
                px[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        img.save(oversized, quality=95)
    return photo, tone, oversized


def main():
    if not EMAIL or not PASSWORD:
        print("set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD in the environment first"
              " (the staff test account, e.g. testguru211l@gmail.com)")
        return 1
    if not ACCESS:
        print("note: SUPABASE_ACCESS_TOKEN is not set — the database, bucket and cleanup checks are skipped\n")

    # ---------- 1. the staff test account ----------
    status, data = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PASSWORD})
    check("the staff test account signs in", status == 200 and data.get("user", {}).get("email") == EMAIL,
          f"{status} {json.dumps(data)[:200]}")
    if status != 200:
        return 1
    staff = data["access_token"]
    name = {"accessToken": staff, "refreshToken": data.get("refresh_token", ""),
            "expiresAt": data.get("expires_at") or int(time.time()) + 3600, "user": {"email": EMAIL}}

    status, me = http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {staff}"})
    role = (me or {}).get("user", {}).get("role") if isinstance(me, dict) else None
    check("the staff gate accepts it as a teacher", status == 200 and role == "teacher", f"{status} {json.dumps(me)[:200]}")

    # ---------- 2. the one-time upload link ----------
    status, upload = call("media", {"action": "create_upload", "mime_type": "audio/mpeg", "size_bytes": 48000}, staff)
    url = (upload or {}).get("upload_url", "")
    check("the upload link is an absolute Storage URL inside the private bucket",
          status == 200 and url.startswith(f"{URL}/storage/v1/object/upload/sign/{BUCKET}/") and "token=" in url,
          f"{status} {url[:120]}")
    check("the link path is kind/year/uuid.ext", str((upload or {}).get("path", "")).startswith("audio/2026/")
          and str((upload or {}).get("path", "")).endswith(".mp3"), str(upload)[:200])

    status, refused = call("media", {"action": "create_upload", "mime_type": "image/png", "size_bytes": 2_000_000}, staff)
    check("an over-limit size is refused before anything is uploaded",
          status == 400 and "1500000" in json.dumps(refused), f"{status} {refused}")

    status, _ = call("media", {"action": "create_upload", "mime_type": "audio/mpeg", "size_bytes": 48000})
    check("a tokenless call is refused", status == 401, str(status))

    status, _ = call("media", {"action": "purge_unused"}, staff)
    check("an admin-only action is refused for a teacher", status == 403, str(status))

    # ---------- 3./4./5. the real app, the real Storage ----------
    photo, tone, oversized = make_files()
    tone_size = os.path.getsize(tone)
    big_size = os.path.getsize(oversized)
    if not 1_500_000 < big_size < 8_000_000:
        print(f"note: the over-limit photo is {big_size} bytes on disk, which is not over the 1.5 MB rule")
    print(f"sample files: big photo {os.path.getsize(photo)} bytes, MP3 {tone_size} bytes, over-limit JPEG {big_size} bytes")

    puts, errors = [], []
    question_id = None
    media_ids, paths = [], []
    objects_before = sql(f"select count(*)::int as n from storage.objects where bucket_id = '{BUCKET}'")[0]["n"] if ACCESS else None
    print(f"the bucket holds {objects_before} objects before this run")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        page.on("response", lambda r: puts.append(
            {"status": r.status, "method": r.request.method, "url": r.url, "apikey": r.request.headers.get("apikey", ""),
             "ctype": r.request.headers.get("content-type", ""), "upsert": r.request.headers.get("x-upsert")})
            if "/storage/v1/object/upload/sign/" in r.url else None)

        # the real app, signed in the same way the sign-in screen leaves the session behind
        page.goto(BASE)
        page.evaluate("s => sessionStorage.setItem('ENGLISH_TEST_V2_STAFF_SESSION', s)", json.dumps(name))
        page.goto(BASE + "#/questions/new")
        page.reload()
        page.wait_for_selector("#q-media", timeout=30000)
        check("the question editor opens with the file area", page.query_selector(".media-picker") is not None)

        page.fill("#q-body", "Live media check: listen and answer. (safe to delete)")
        page.fill("[aria-label='Answer A']", "One")
        page.fill("[aria-label='Answer B']", "Two")
        page.click("[aria-label='Mark answer A as the correct one']")
        page.set_input_files("#q-media", [photo, tone])
        page.wait_for_function(
            "() => document.querySelectorAll('.media-item[data-media-id]').length === 2"
            " && document.querySelectorAll('.media-item.uploading').length === 0", timeout=180000)
        check("the photo and the MP3 upload through the app with no error",
              page.inner_text(".media-messages").strip() == "", page.inner_text(".media-messages"))

        puts = [p for p in puts if p["method"] == "PUT"]
        check("both files were PUT straight to Storage (one request each)",
              len(puts) == 2 and all(p["status"] == 200 for p in puts)
              and all(f"/storage/v1/object/upload/sign/{BUCKET}/" in p["url"] for p in puts),
              json.dumps(puts)[:400])
        check("the PUT carries the publishable key, multipart body and no overwrite",
              all(p["apikey"].startswith("sb_publishable_") and p["ctype"].startswith("multipart/form-data")
                  and p["upsert"] == "false" for p in puts), json.dumps(puts)[:400])

        items = page.query_selector_all(".media-item[data-media-id]")
        media_ids = [i.get_attribute("data-media-id") for i in items]
        img = page.query_selector(".media-item img.thumb")
        player = page.query_selector(".media-item audio.player")
        img_src = (img.get_attribute("src") if img else None) or ""
        audio_src = (player.get_attribute("src") if player else None) or ""
        check("the picture shows a real viewing link, not a placeholder",
              img_src.startswith(f"{URL}/storage/v1/object/sign/{BUCKET}/"), img_src[:160])
        check("the audio shows a real player with a viewing link",
              audio_src.startswith(f"{URL}/storage/v1/object/sign/{BUCKET}/"), audio_src[:160])

        def photo_plays():
            page.wait_for_function("() => { const i = document.querySelector('.media-item img.thumb');"
                                   " return i && i.complete && i.naturalWidth > 0; }", timeout=30000)
            return page.evaluate("() => { const i = document.querySelector('.media-item img.thumb');"
                                 " return {w: i.naturalWidth, h: i.naturalHeight}; }")

        def audio_plays():
            # the player is created with preload="none", so the file is only fetched when it plays
            return page.evaluate("""async () => {
                const a = document.querySelector('.media-item audio.player');
                const out = {src: a.src, readyState: a.readyState};
                a.load();
                const deadline = Date.now() + 20000;
                while (a.readyState < 2 && !a.error && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                out.readyState = a.readyState;
                out.duration = a.duration;
                out.error = a.error ? a.error.code : null;
                try { await a.play(); } catch (e) { out.playError = String(e); }
                const moving = Date.now() + 5000;
                while (a.currentTime <= 0.05 && Date.now() < moving) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                out.currentTime = a.currentTime;
                a.pause();
                return out;
            }""")

        shot = photo_plays()
        check("the picture really renders from Storage", shot["w"] > 0 and shot["h"] > 0, json.dumps(shot))
        heard = audio_plays()
        check("the MP3 really decodes and plays",
              heard["error"] is None and round(heard["duration"]) == 3 and heard["currentTime"] > 0.05, json.dumps(heard))

        # ---------- save, then reopen ----------
        with page.expect_response(lambda r: r.request.method == "POST" and "/functions/v1/question-bank" in r.url) as info:
            page.click("button:has-text('Save question')")
        page.wait_for_selector(".toast:has-text('Question saved.')", timeout=30000)
        question_id = (info.value.json() or {}).get("id")
        check("saving the question with both files works", bool(question_id), str(info.value.status))

        page.goto(BASE + "#/questions/edit/" + question_id)
        page.wait_for_selector("#q-media", timeout=30000)
        page.wait_for_function("() => document.querySelectorAll('.media-item[data-media-id]').length === 2", timeout=30000)
        again = [i.get_attribute("data-media-id") for i in page.query_selector_all(".media-item[data-media-id]")]
        check("reopening the question lists the same two files", sorted(again) == sorted(media_ids), str(again))
        shot = photo_plays()
        check("the picture loads again after reopening", shot["w"] > 0, json.dumps(shot))
        heard = audio_plays()
        check("the player plays again after reopening", heard["error"] is None and round(heard["duration"]) == 3
              and heard["currentTime"] > 0.05, json.dumps(heard))

        got = ctx.request.get(audio_src)
        check("the viewing link serves the real MP3 bytes",
              got.status == 200 and got.headers.get("content-type", "").startswith("audio/mpeg")
              and int(got.headers.get("content-length", "0")) == tone_size,
              f"{got.status} {got.headers.get('content-type')} {got.headers.get('content-length')} vs {tone_size}")
        got_img = ctx.request.get(img_src)
        check("the viewing link serves the real picture bytes",
              got_img.status == 200 and got_img.headers.get("content-type", "").startswith("image/")
              and len(got_img.body()) > 1000,
              f"{got_img.status} {got_img.headers.get('content-type')} {len(got_img.body())}")

        # ---------- 6. a file over the limit must not stay in Storage ----------
        result = page.evaluate("""async ({base, key, token, b64, mime}) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: mime });
            const send = (body) => fetch(base + '/functions/v1/media', {
                method: 'POST',
                headers: { apikey: key, Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
            const link = await send({ action: 'create_upload', mime_type: mime, size_bytes: 400000 });
            const form = new FormData();
            form.append('cacheControl', '3600');
            form.append('', blob, 'live-oversized.jpg');
            const put = await fetch(link.body.upload_url, { method: 'PUT', headers: { apikey: key, 'x-upsert': 'false' }, body: form });
            const reg = await send({ action: 'register', path: link.body.path, name: 'live-oversized.jpg' });
            return { created: link.status, path: link.body.path, put: put.status, register: reg.status, message: reg.body && reg.body.error };
        }""", {"base": URL, "key": KEY, "token": staff, "b64": base64.b64encode(open(oversized, "rb").read()).decode(), "mime": "image/jpeg"})
        check("an over-limit file can be put into Storage on purpose", result["created"] == 200 and result["put"] == 200, json.dumps(result)[:300])
        check("the server refuses to register it with the friendly message",
              result["register"] == 400 and "about 1 MB" in str(result["message"]), json.dumps(result)[:300])

        check("no page errors", errors == [], "; ".join(errors[:3]))
        browser.close()

    paths = []
    if ACCESS:
        rows = sql(f"select storage_path from public.media_files where id = any('{{{','.join(media_ids)}}}'::uuid[]) order by kind")
        paths = [r["storage_path"] for r in rows]
        check("the database has both files under the paths the app used", len(paths) == 2
              and any(p.startswith("image/") for p in paths) and any(p.startswith("audio/") for p in paths),
              json.dumps(rows)[:300])
        info = sql(f"""select kind::text, mime_type, size_bytes, duration_seconds, original_name,
                              (select count(*)::int from public.question_media qm where qm.media_id = m.id) as attached
                       from public.media_files m where m.id = any('{{{','.join(media_ids)}}}'::uuid[]) order by kind""")
        image = next((r for r in info if r["kind"] == "image"), {})
        audio = next((r for r in info if r["kind"] == "audio"), {})
        check("the image row carries the shrunk size and WebP type Storage reported",
              image.get("mime_type") == "image/webp" and 0 < image.get("size_bytes", 0) <= 1_500_000, json.dumps(image))
        check("the audio row carries the exact MP3 size and the real length",
              audio.get("mime_type") == "audio/mpeg" and audio.get("size_bytes") == tone_size
              and audio.get("duration_seconds") == 3, json.dumps(audio))
        check("both files are attached to the question",
              all(r["attached"] == 1 for r in info) and len(info) == 2, json.dumps(info))
        objects = sql(f"select name, (metadata->>'size')::int as size from storage.objects"
                      f" where bucket_id = '{BUCKET}' and name = any(array[{','.join(repr(p) for p in paths)}])")
        check("the private bucket really holds the two objects",
              len(objects) == 2 and all(o["size"] > 0 for o in objects), json.dumps(objects))

        left = sql(f"select count(*)::int as n from storage.objects where bucket_id = '{BUCKET}' and name = '{result['path']}'"
                   f" union all select count(*)::int as n from public.media_files where storage_path = '{result['path']}'")
        check("the refused file was deleted from Storage and left no row",
              all(r["n"] == 0 for r in left), json.dumps(left))

        # ---------- 7. remove everything this run created ----------
        if KEEP:
            print("\n--keep: the test question, its rows and its Storage objects are left in place")
        else:
            if paths:
                storage_remove(paths)
            sql(f"delete from public.questions where id = '{question_id}'")
            sql(f"delete from public.media_files where id = any('{{{','.join(media_ids)}}}'::uuid[])")
            after = sql(f"""select (select count(*)::int from public.questions where id = '{question_id}') as questions,
                                   (select count(*)::int from public.question_media where media_id = any('{{{','.join(media_ids)}}}'::uuid[])) as attachments,
                                   (select count(*)::int from public.media_files where id = any('{{{','.join(media_ids)}}}'::uuid[])) as files,
                                   (select count(*)::int from storage.objects where bucket_id = '{BUCKET}'
                                     and name = any(array[{','.join(repr(p) for p in paths)}])) as objects""")[0]
            check("the test question, its rows and its Storage objects are gone again",
                  all(v == 0 for v in after.values()), json.dumps(after))
            back = sql(f"select count(*)::int as n from storage.objects where bucket_id = '{BUCKET}'")[0]["n"]
            check("the bucket is back to the files it had before", back == objects_before, f"{back} vs {objects_before}")

    print()
    print("ids:")
    print(json.dumps({"question_id": question_id, "media_ids": media_ids, "paths": paths}))
    failed = [n for n, ok, _ in checks if not ok]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE MEDIA CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
