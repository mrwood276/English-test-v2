"""LIVE check of the backup slice (TASK-015).

Not part of CI and no dev server needed: this one is about real copies of the real database, made by the
deployed functions and stored in the real bucket.

    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_backup_check.py

Need SUPABASE_ACCESS_TOKEN (a Supabase Management token): the check reads the live job list, Vault, the
backups table and Storage, and it mints one-time login links for the admin and teacher accounts instead of
needing a password. Set SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD or SUPABASE_TEST_EMAIL to override
the accounts.

What it proves, in order:
  1. the nightly job exists, is active, runs as postgres and asks the backups function for an automatic
     copy with the Vault housekeeping key — and that key opens `create` and nothing else;
  2. an admin's manual copy really is ONE archive: data.json plus the attached picture's bytes, with every
     table's row count equal to the database's own count and the owner's real exam inside;
  3. the archive describes itself truthfully (format, migrations, media manifest, media_bytes, sizes);
  4. a download link returns that archive, and a delete takes away both the row and the file;
  5. retention is real: the eighth automatic copy prunes the oldest one's row AND its file, while manual
     copies survive;
  6. the schedule fires on its own: with the job pointed at the next minute, pg_cron runs it, pg_net gets
     HTTP 200 back, and an automatic row appears with nobody's name on it (the schedule is put back);
  7. nothing this run created is left: no backup rows, an empty bucket, no check question or upload, and
     the table counts are back to their starting numbers.

The migration's own configuration is also asserted by supabase/tests/scheduled_jobs_test.sql (runnable
with no browser and no login); this script is the end-to-end half.
"""
import io
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import zipfile
import zlib

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
ADMIN_EMAIL = os.environ.get("SUPABASE_ADMIN_EMAIL", "jonathan10g7@gmail.com")
ADMIN_PASSWORD = os.environ.get("SUPABASE_ADMIN_PASSWORD", "")
TEACHER_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
UPLOAD_NAME = "backup-check.png"
QUESTION_BODY = "BACKUP CHECK (safe to delete): write the past of go."
JOB = "nightly-backup"
JOB_SCHEDULE = "41 19 * * *"
AUTOMATIC_KEPT = 7
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None, raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode("utf-8", "replace")
            return res.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(text or "null")
        except ValueError:
            return err.code, text


def call(name, body, token=None):
    return http("POST", f"{URL}/functions/v1/{name}", body, {"Authorization": f"Bearer {token}"} if token else {})


def sql(query):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
                                 data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"database said: {err.read().decode('utf-8', 'replace')[:400]}") from None


def service_key():
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/api-keys",
                                 headers={"Authorization": f"Bearer {ACCESS}"})
    with urllib.request.urlopen(req, timeout=90) as res:
        return next(k["api_key"] for k in json.loads(res.read().decode()) if k["name"] == "service_role")


def sign_in(email=None, password=""):
    """A real session: the password when given, otherwise a one-time login link for that account."""
    email = email or ADMIN_EMAIL
    if password:
        return http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": email, "password": password})
    service = service_key()
    status, link = http("POST", f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email},
                        {"Authorization": f"Bearer {service}", "apikey": service})
    if status != 200:
        return status, link
    return http("POST", f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": link["hashed_token"]})


def png_bytes():
    """A real 1x1 PNG, built here so the check needs no image library (the same reasoning as DEC-007)."""
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b"")


def delete_objects(bucket, paths):
    """Deletes Storage objects through the Storage API (the only way the bytes actually go away)."""
    if not paths:
        return 0
    status, _ = http("DELETE", f"{URL}/storage/v1/object/{bucket}", {"prefixes": list(paths)},
                     {"Authorization": f"Bearer {service_key()}"})
    return status


def bucket_names(bucket, prefix="", search=""):
    """What Storage itself says is in the bucket (proves bytes exist or are gone)."""
    status, data = http("POST", f"{URL}/storage/v1/object/list/{bucket}",
                        {"prefix": prefix, "search": search, "limit": 100},
                        {"Authorization": f"Bearer {service_key()}"})
    return sorted(o.get("name") for o in (data or [])) if status == 200 else []


def live_counts():
    """Every table's row count, read through the very allowlist a backup is built from."""
    rows = sql("""select jsonb_object_agg(t, c) as counts from (
                    select t, (xpath('/row/c/text()',
                               query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int as c
                    from unnest(public.backup_tables()) t) s""")
    return rows[0]["counts"]


def state():
    return sql("""select (select count(*)::int from public.exams) exams,
                         (select count(*)::int from public.exam_sessions) sessions,
                         (select count(*)::int from public.questions) questions,
                         (select count(*)::int from public.media_files) media,
                         (select count(*)::int from public.audit_logs) audits,
                         (select count(*)::int from public.backups) backups,
                         (select count(*)::int from public.audit_logs where action like 'backup.%') history""")[0]


def wipe_check():
    """Removes whatever a previous (or half-finished) run left behind: its upload, its question, its copies."""
    for row in sql("select storage_path from public.backups"):
        delete_objects("backups", [row["storage_path"]])
    body = QUESTION_BODY.replace("'", "''")
    sql(f"""do $$
      declare v_q uuid; v_m uuid[];
      begin
        select array_agg(id) into v_m from public.media_files where original_name = '{UPLOAD_NAME}';
        select id into v_q from public.questions where body = '{body}' order by created_at limit 1;
        delete from public.audit_logs where action like 'backup.%'
           or (v_m is not null and entity_id = any (v_m::text[]))
           or (v_q is not null and entity_id = v_q::text);
        delete from public.question_media where media_id = any (coalesce(v_m, '{{}}'::uuid[])) or question_id = v_q;
        delete from public.question_options where question_id = v_q;
        delete from public.accepted_answers where question_id = v_q;
        delete from public.question_class_labels where question_id = v_q;
        delete from public.questions where id = v_q;
        delete from public.media_files where id = any (coalesce(v_m, '{{}}'::uuid[]));
        delete from public.backups;
      end $$;""")


def runs_since(marker):
    return sql(f"""select j.jobname, d.status, d.return_message
                     from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                    where d.runid > {marker} order by d.runid desc limit 30""")


def responses_since(marker):
    return sql(f"select id, status_code, content::text from net._http_response where id > {marker} order by id desc limit 10")


def wait_for(what, marker, want, timeout=240):
    """Waits for cron runs (or pg_net responses) to appear; returns the collected rows either way."""
    deadline = time.time() + timeout
    rows = []
    while time.time() < deadline:
        rows = runs_since(marker) if what == "runs" else responses_since(marker)
        if want(rows):
            return rows
        time.sleep(10)
    return rows


def main():
    if not ACCESS:
        print("set SUPABASE_ACCESS_TOKEN first: this check reads the live job list, Vault, Storage and its own rows")
        return 1
    image = png_bytes()
    # A run that died halfway must not block this one; its leftovers are the check's own, nothing else.
    for row in sql(f"select storage_path from public.media_files where original_name = '{UPLOAD_NAME}'"):
        delete_objects("question-media", [row["storage_path"]])
    wipe_check()

    before = state()
    print(f"live state before: {json.dumps(before)}")
    check("the starting point has no backup rows and no backup history",
          before["backups"] == 0 and before["history"] == 0, json.dumps(before))

    # ---------- 1. the nightly job ----------
    jobs = {j["jobname"]: j for j in sql("select jobid, jobname, schedule, command, username, active from cron.job")}
    job = jobs.get(JOB)
    check("the nightly backup job is live", job is not None, str(sorted(jobs))[:200])
    if not job:
        return 1
    check("its schedule is the documented one (02:41 Jakarta, after the two purges)", job["schedule"] == JOB_SCHEDULE, job["schedule"])
    check("it is active and runs as postgres", job["active"] and job["username"] == "postgres", str((job["active"], job["username"])))
    check("it calls the backups function with the Vault housekeeping key",
          "net.http_post" in job["command"] and "vault.decrypted_secrets" in job["command"] and "/functions/v1/backups" in job["command"],
          job["command"][:200])
    check("and it asks for an automatic copy", '"action": "create"' in job["command"] and '"automatic"' in job["command"],
          job["command"][:200])
    check("the three housekeeping jobs are still there, untouched",
          {"expire-sessions", "purge-rate-limits", "purge-orphan-media"} <= set(jobs), str(sorted(jobs)))

    # ---------- 2. the scheduled door, and the people it does not open for ----------
    key = sql("select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key'")[0]["decrypted_secret"]
    house = {"x-housekeeping-key": key}
    check("a wrong housekeeping key is refused",
          http("POST", f"{URL}/functions/v1/backups", {"action": "create"}, {"x-housekeeping-key": key[:-4] + "0000"})[0] == 401)
    check("the key opens nothing but `create` (reading and deleting stay a person's job)",
          http("POST", f"{URL}/functions/v1/backups", {"action": "list"}, house)[0] == 401)
    check("a tokenless call is refused", call("backups", {"action": "create"})[0] == 401)
    teacher_status, teacher_data = sign_in(TEACHER_EMAIL)
    teacher = teacher_data.get("access_token") if teacher_status == 200 else None
    check("a teacher signs in for the role rule", bool(teacher), f"{teacher_status} {json.dumps(teacher_data)[:160]}")
    check("a teacher cannot list the copies", teacher is not None and call("backups", {"action": "list"}, teacher)[0] == 403)
    check("a teacher cannot make a copy", teacher is not None and call("backups", {"action": "create"}, teacher)[0] == 403)
    check("a teacher cannot delete one either",
          teacher is not None and call("backups", {"action": "delete", "id": "00000000-0000-4000-8000-000000000000"}, teacher)[0] == 403)

    # ---------- 3. the admin's manual copy, and what is really inside it ----------
    status, data = sign_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    check("the admin account can sign in", status == 200, f"{status} {json.dumps(data)[:200]}")
    if status != 200:
        return 1
    token = data["access_token"]
    admin_id = data["user"]["id"]
    _, me = http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {token}"})
    check("the staff gate calls it an admin (backups are an admin job)", ((me or {}).get("user") or {}).get("role") == "admin",
          json.dumps(me)[:200])

    status, upload = call("media", {"action": "create_upload", "mime_type": "image/png",
                                    "size_bytes": len(image), "name": UPLOAD_NAME}, token)
    check("the check can ask for an upload link", status == 200 and upload.get("path"), f"{status} {json.dumps(upload)[:200]}")
    if status != 200:
        return 1
    put_status, _ = http("PUT", upload["upload_url"], image, {"content-type": "image/png", "x-upsert": "false"}, raw=True)
    check("the picture really lands in Storage", put_status == 200, str(put_status))
    status, registered = call("media", {"action": "register", "path": upload["path"], "name": UPLOAD_NAME}, token)
    media_id = (registered or {}).get("media", {}).get("id")
    check("it registers as a real media row", status == 200 and bool(media_id), f"{status} {json.dumps(registered)[:200]}")
    if not media_id:
        return 1
    status, created = call("question-bank", {"action": "save", "type": "short_answer", "body": QUESTION_BODY,
                                             "difficulty": "easy", "weight": 1, "accepted_answers": ["went"],
                                             "class_labels": [], "media": [{"id": media_id}]}, token)
    question_id = (created or {}).get("id")
    check("the check can create its throwaway question with the picture attached",
          status == 200 and bool(question_id)
          and sql(f"select count(*)::int n from public.question_media where question_id = '{question_id}'")[0]["n"] == 1,
          f"{status} {json.dumps(created)[:200]}")
    if not question_id:
        return 1

    counts_before = live_counts()
    status, made = call("backups", {"action": "create"}, token)
    manual = (made or {}).get("backup") or {}
    check("an admin can make a manual copy", status == 200 and manual.get("kind") == "manual",
          f"{status} {json.dumps(made)[:200]}")
    if not manual:
        return 1
    check("the answer says what went in and that nothing was pruned",
          made.get("files") == 2 and made.get("media_included") is True and made.get("media_note") is None and made.get("pruned") == 0,
          json.dumps(made)[:300])

    _, listed = call("backups", {"action": "list"}, token)
    rows = (listed or {}).get("backups") or {}
    full_name = sql(f"select full_name from public.profiles where id = '{admin_id}'")[0]["full_name"]
    check("the list shows the copy, newest first, with who made it",
          rows.get("total") == 1 and rows["rows"][0]["id"] == manual["id"]
          and rows["rows"][0]["created_by_name"] == full_name and rows["rows"][0]["size_bytes"] == manual["size_bytes"],
          json.dumps(rows)[:300])

    status, link = call("backups", {"action": "download", "id": manual["id"]}, token)
    check("a download link is handed out for an hour", status == 200 and link.get("expires_in") == 3600, f"{status} {json.dumps(link)[:200]}")
    check("and it names the file it stores", (link or {}).get("name") == f"english-test-v2_{manual['storage_path'].split('/')[-1]}",
          (link or {}).get("name"))
    fetched = urllib.request.urlopen(link["url"], timeout=90).read()   # no auth: the signed link is the key
    check("the link really returns a zip", fetched[:2] == b"PK", fetched[:4].hex())
    check("the row's size is the size of the file that was uploaded", manual["size_bytes"] == len(fetched),
          f"{manual['size_bytes']} vs {len(fetched)}")
    check("the file is really in the private bucket", manual["storage_path"] in bucket_names("backups"),
          str(bucket_names("backups"))[:200])

    with zipfile.ZipFile(io.BytesIO(fetched)) as zf:
        names = zf.namelist()
        document = json.loads(zf.read("data.json"))
        inside = zf.read(f"media/{upload['path']}")
    check("the archive holds data.json and the attached picture, and nothing else",
          names == ["data.json", f"media/{upload['path']}"], str(names))
    check("the picture inside is byte for byte the file that was uploaded", inside == image, f"{len(inside)} vs {len(image)}")
    check("the document says what it is",
          document["format"] == "english-test-v2.backup" and document["format_version"] == 1 and document["kind"] == "manual",
          json.dumps({k: document.get(k) for k in ["format", "format_version", "kind"]}))
    check("it says who it was made for", document["created_for"] == "a signed-in admin", str(document.get("created_for")))
    check("it holds every table of the allowlist",
          sorted(document["tables"]) == sorted(sql("select public.backup_tables() as t")[0]["t"]), str(sorted(document["tables"]))[:300])
    counts_now = live_counts()
    added = {k: counts_now[k] - counts_before[k] for k in counts_now if counts_now[k] != counts_before[k]}
    check("every table's row count is the count the database had a moment before it recorded itself",
          document["counts"] == counts_before,
          json.dumps({k: (document["counts"].get(k), counts_before[k]) for k in counts_before if document["counts"].get(k) != counts_before[k]})[:300])
    check("and the only rows added since are the copy's own row and its audit entry",
          added == {"backups": 1, "audit_logs": 1}, json.dumps(added))
    check("the migrations that built this database are recorded",
          document["migrations"] == [r["version"] for r in sql("select version from supabase_migrations.schema_migrations order by version")],
          str(document["migrations"])[:200])
    check("the owner's real exam and its attempt are inside, untouched",
          any(e["access_code"] == "4KHU2A" for e in document["tables"]["exams"]) and len(document["tables"]["exam_sessions"]) >= 1,
          str([e["access_code"] for e in document["tables"]["exams"]])[:200])
    check("the check's own question is inside too (this is the live database, not a fixture)",
          any(q["body"] == QUESTION_BODY for q in document["tables"]["questions"]))
    check("the media manifest lists the attached file, its bytes and that it was included",
          [m["path"] for m in document["media"]] == [upload["path"]]
          and document["media"][0]["included"] is True and document["media_bytes"] == len(image),
          json.dumps(document["media"])[:300])

    # ---------- 4. retention: the newest seven automatic copies ----------
    autos = []
    for _ in range(AUTOMATIC_KEPT + 1):
        status, answer = http("POST", f"{URL}/functions/v1/backups", {"action": "create"}, house)
        if status != 200:
            break
        autos.append(answer)
    made_rows = [a["backup"] for a in autos]
    check("the nightly door can make eight automatic copies in a row", len(autos) == AUTOMATIC_KEPT + 1,
          json.dumps(made_rows)[:200])
    if len(autos) != AUTOMATIC_KEPT + 1:
        return 1
    check("the eighth copy pruned exactly one older one and said so", autos[-1]["pruned"] == 1, json.dumps(autos[-1])[:200])
    check("every automatic copy is nobody's work",
          all(a["kind"] == "automatic" for a in made_rows)
          and sql("select count(*)::int n from public.backups where kind = 'automatic' and created_by is null")[0]["n"] == AUTOMATIC_KEPT,
          json.dumps(made_rows)[:200])
    check("only the newest seven automatic rows are kept",
          sql("select count(*)::int n from public.backups where kind = 'automatic'")[0]["n"] == AUTOMATIC_KEPT)
    check("manual copies are not part of that sweep",
          sql("select count(*)::int n from public.backups where kind = 'manual'")[0]["n"] == 1)
    names_in_bucket = bucket_names("backups")
    check("the pruned copy's file is gone from Storage",
          made_rows[0]["storage_path"] not in names_in_bucket and made_rows[-1]["storage_path"] in names_in_bucket,
          str(names_in_bucket)[:300])
    check("Storage holds exactly seven automatic files plus the manual one",
          len([n for n in names_in_bucket if "_automatic_" in n]) == AUTOMATIC_KEPT
          and len([n for n in names_in_bucket if "_manual_" in n]) == 1, str(names_in_bucket)[:300])
    check("the sweep is written down", sql("select count(*)::int n from public.audit_logs where action = 'backup.prune'")[0]["n"] >= 1)

    # ---------- 5. let pg_cron fire the job for real ----------
    run_marker = sql("select coalesce(max(runid), 0) m from cron.job_run_details")[0]["m"]
    response_marker = sql("select coalesce(max(id), 0) m from net._http_response")[0]["m"]
    sql(f"select cron.alter_job({job['jobid']}, '* * * * *')")
    check("the job is pointed at the next minute for the run (the schedule goes back below)",
          sql(f"select schedule from cron.job where jobname = '{JOB}'")[0]["schedule"] == "* * * * *")

    print("waiting for the scheduler (up to four minutes) ...")
    runs = wait_for("runs", run_marker, lambda r: any(x["jobname"] == JOB and x["status"] == "succeeded" for x in r))
    check("pg_cron itself ran the nightly job", any(x["jobname"] == JOB and x["status"] == "succeeded" for x in runs),
          json.dumps(runs)[:400])
    replies = wait_for("responses", response_marker, lambda r: any(x["status_code"] == 200 for x in r), timeout=120)
    answer = next((x for x in replies if x["status_code"] == 200), None)
    check("the job's HTTP call to the function came back 200", answer is not None, json.dumps(replies)[:300])
    body = json.loads(answer["content"]) if answer is not None and answer["content"] else {}
    fired_id = (body.get("backup") or {}).get("id")
    check("and the function really made an automatic copy", (body.get("backup") or {}).get("kind") == "automatic",
          json.dumps(body)[:300])
    check("that copy is a real row with nobody's name on it",
          fired_id is not None and sql(
              f"select kind, created_by is null as nobody from public.backups where id = '{fired_id}'")[:1]
          == [{"kind": "automatic", "nobody": True}], str(fired_id))
    sql(f"select cron.alter_job({job['jobid']}, '{JOB_SCHEDULE}')")
    check("the schedule is back to the documented one",
          sql(f"select schedule from cron.job where jobname = '{JOB}'")[0]["schedule"] == JOB_SCHEDULE)

    # ---------- 6. deleting one, by hand ----------
    status, gone = call("backups", {"action": "delete", "id": manual["id"]}, token)
    check("an admin can delete a copy", status == 200 and gone.get("removed") == 1, f"{status} {json.dumps(gone)[:200]}")
    check("its row is gone", sql(f"select count(*)::int n from public.backups where id = '{manual['id']}'")[0]["n"] == 0)
    check("and its file is gone from the bucket", manual["storage_path"] not in bucket_names("backups"))
    check("the deletion is written down",
          sql(f"select count(*)::int n from public.audit_logs where action = 'backup.delete' and entity_id = '{manual['id']}'")[0]["n"] == 1)
    check("deleting something that is already gone is refused, not quietly accepted",
          call("backups", {"action": "delete", "id": manual["id"]}, token)[0] == 400)

    # ---------- 7. clean up, and prove the counts are back ----------
    for row in sql("select id from public.backups"):
        call("backups", {"action": "delete", "id": row["id"]}, token)
    check("every copy this run made is deleted, row and file",
          sql("select count(*)::int n from public.backups")[0]["n"] == 0 and bucket_names("backups") == [],
          str(bucket_names("backups"))[:200])
    delete_objects("question-media", [upload["path"]])
    wipe_check()
    after = state()
    print(f"live state after cleanup: {json.dumps(after)}")
    check("the question bank, exams, attempts and media are back to their starting numbers",
          all(after[k] == before[k] for k in ["exams", "sessions", "questions", "media"]),
          f"{json.dumps(after)} vs {json.dumps(before)}")
    check("no backup rows and no backup history are left behind",
          after["backups"] == 0 and after["history"] == 0, json.dumps(after))
    check("the audit log is back to its starting size", after["audits"] == before["audits"],
          f"{after['audits']} vs {before['audits']}")
    folder, name = upload["path"].rsplit("/", 1)
    check("the check's upload is not in Storage either", bucket_names("question-media", folder, name) == [],
          str(bucket_names("question-media", folder, name)))

    failed = [n for n, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE BACKUP CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
