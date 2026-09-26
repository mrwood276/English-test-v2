"""LIVE check of the scheduled housekeeping jobs (TASK-015).

Not part of CI and no dev server needed: this one is about what the *database* does on its own clock. It
builds a throwaway exam with one abandoned attempt, a spare upload nobody attached, and a stale
rate-limit row — then lets pg_cron fire for real and checks that each job did its job.

    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_housekeeping_check.py

Need SUPABASE_ACCESS_TOKEN (a Supabase Management token): the check reads the live job list, Vault and the
rows it created, and it mints a one-time login link for the admin account instead of needing a password.
Set SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD to override either (default: the admin account).

What it proves, in order:
  1. the three jobs exist and are active, with the documented schedules, commands and role;
  2. the deployed `media` function accepts the housekeeping key for `purge_unused` ONLY — a wrong key and
     a key on any other action are refused (401), and a tokenless staff call still is too;
  3. the key is not written down anywhere in the repository;
  4. a real orphan upload exists in Storage and its row is older than a day (positive control), and a
     stale rate-limit row and an abandoned session exist;
  5. with the jobs pointed at the next minute (and put back afterwards), pg_cron itself runs all three:
     `cron.job_run_details` records them as succeeded and pg_net gets HTTP 200 from the media function;
  6. the effects are real: the session is `timed_out` and stamped, the stale rate-limit row is gone, the
     media row is gone AND the file itself is gone from Storage (the row-only delete that a SQL job would
     have done is exactly what this check is looking for);
  7. the schedules are back to normal and everything this run created — exam, attempt, upload, rows,
     Storage object — is deleted and verified gone (the counts are back to their starting numbers).

The jobs' own configuration is also asserted by supabase/tests/scheduled_jobs_test.sql (runnable with no
browser and no login); this script is the end-to-end half.
"""
import json
import os
import pathlib
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
PROJECT = "lbhnadqmokloyfarrzfv"
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
ADMIN_EMAIL = os.environ.get("SUPABASE_ADMIN_EMAIL", "jonathan10g7@gmail.com")
ADMIN_PASSWORD = os.environ.get("SUPABASE_ADMIN_PASSWORD", "")
TEACHER_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL", "testguru211l@gmail.com")
CODE = "HSKEEP"
TITLE = "Housekeeping live check (safe to delete)"
JOBS = {
    "expire-sessions": "*/5 * * * *",
    "purge-rate-limits": "19 19 * * *",
    "purge-orphan-media": "29 19 * * *",
}
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def http(method, url, body=None, headers=None, raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
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


def delete_objects(paths):
    """Deletes Storage objects through the Storage API (the only way the bytes actually go away)."""
    if not paths:
        return 0
    status, _ = http("DELETE", f"{URL}/storage/v1/object/question-media", {"prefixes": paths},
                     {"Authorization": f"Bearer {service_key()}"})
    return status


def storage_names(path):
    """What Storage itself says is in the bucket under this path's folder (proves bytes exist or are gone)."""
    directory, name = path.rsplit("/", 1)
    status, data = http("POST", f"{URL}/storage/v1/object/list/question-media",
                        {"prefix": directory, "search": name, "limit": 10},
                        {"Authorization": f"Bearer {service_key()}"})
    return [o.get("name") for o in (data or [])] if status == 200 else []


def wipe_exam(where):
    """Removes the exams matching `where` with everything that hangs off them (the monitor cleanup chain)."""
    sql(f"""do $$
      declare v_exams uuid[]; v_sessions uuid[];
      begin
        select coalesce(array_agg(id), '{{}}') into v_exams from public.exams where {where};
        select coalesce(array_agg(id), '{{}}') into v_sessions from public.exam_sessions where exam_id = any (v_exams);
        delete from public.session_events where session_id = any (v_sessions);
        delete from public.session_answers where session_id = any (v_sessions);
        delete from public.answer_grades where session_id = any (v_sessions);
        delete from public.exam_results where session_id = any (v_sessions);
        delete from public.audit_logs where entity_id = any (v_exams::text[]) or entity_id = any (v_sessions::text[]);
        delete from public.exam_sessions where id = any (v_sessions);
        delete from public.retake_permissions where exam_id = any (v_exams);
        delete from public.exam_questions where exam_id = any (v_exams);
        delete from public.exams where id = any (v_exams);
      end $$;
      delete from public.rate_limits where bucket = 'housekeeping_check'
         or (bucket like 'session\\_%' and window_start > now() - interval '1 day');
      delete from public.media_files where original_name = 'housekeeping-check.png';""")


def runs_since(marker):
    return sql(f"""select j.jobname, d.status, d.return_message, d.start_time::text
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
        print("set SUPABASE_ACCESS_TOKEN first: this check reads the live job list, Vault and its own rows")
        return 1
    image = png_bytes()
    # A run that died halfway must not block this one; its leftovers are the check's own, nothing else.
    for row in sql("select storage_path from public.media_files where original_name = 'housekeeping-check.png'"):
        delete_objects([row["storage_path"]])
    wipe_exam(f"access_code = '{CODE}'")

    # ---------- 1. a real admin session and the live job list ----------
    status, data = sign_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    check("the admin account can sign in", status == 200, f"{status} {json.dumps(data)[:200]}")
    if status != 200:
        return 1
    token = data["access_token"]
    _, me = http("GET", f"{URL}/functions/v1/auth-me", None, {"Authorization": f"Bearer {token}"})
    role = ((me or {}).get("user") or {}).get("role")
    check("the staff gate calls it an admin (the purge is an admin action)", role == "admin", json.dumps(me)[:200])

    jobs = {j["jobname"]: j for j in sql("select jobid, jobname, schedule, command, username, active from cron.job")}
    check("the three housekeeping jobs are live", set(JOBS) <= set(jobs), str(sorted(jobs))[:200])
    check("their schedules are the documented ones", all(jobs[n]["schedule"] == s for n, s in JOBS.items()),
          json.dumps({n: jobs[n]["schedule"] for n in JOBS if n in jobs}))
    check("all three are active and run as postgres", all(jobs[n]["active"] and jobs[n]["username"] == "postgres" for n in JOBS),
          json.dumps({n: (jobs[n]["active"], jobs[n]["username"]) for n in JOBS if n in jobs}))
    check("the media job calls the media function with the Vault key",
          "net.http_post" in jobs["purge-orphan-media"]["command"]
          and "vault.decrypted_secrets" in jobs["purge-orphan-media"]["command"]
          and "purge_unused" in jobs["purge-orphan-media"]["command"],
          jobs["purge-orphan-media"]["command"][:160])

    # ---------- 2. the scheduled door in the deployed function ----------
    key = sql("select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key'")[0]["decrypted_secret"]
    house = {"x-housekeeping-key": key}
    status, purged = http("POST", f"{URL}/functions/v1/media", {"action": "purge_unused"}, house)
    check("the housekeeping key can ask for the unused-file purge", status == 200 and "removed" in (purged or {}),
          f"{status} {json.dumps(purged)[:200]}")
    check("a wrong key is refused", http("POST", f"{URL}/functions/v1/media", {"action": "purge_unused"},
                                         {"x-housekeeping-key": key[:-4] + "0000"})[0] == 401)
    check("the key opens no other action (uploads stay a person's job)",
          http("POST", f"{URL}/functions/v1/media", {"action": "create_upload", "mime_type": "image/png",
                                                     "size_bytes": len(image)}, house)[0] == 401)
    check("a tokenless staff call is still refused", call("media", {"action": "purge_unused"})[0] == 401)
    status, handed = call("media", {"action": "purge_unused"}, token)
    check("an admin can still purge by hand, exactly as before", status == 200 and "removed" in (handed or {}),
          f"{status} {json.dumps(handed)[:200]}")
    teacher_status, teacher_data = sign_in(TEACHER_EMAIL)
    teacher = teacher_data.get("access_token") if teacher_status == 200 else None
    check("a teacher signs in for the role rule", bool(teacher), f"{teacher_status} {json.dumps(teacher_data)[:160]}")
    check("and is still refused the purge (403, unchanged)",
          teacher is not None and call("media", {"action": "purge_unused"}, teacher)[0] == 403)

    # ---------- 3. the key is nowhere in the repository ----------
    found = []
    for path in pathlib.Path(".").rglob("*"):
        if not path.is_file() or ".git/" in str(path).replace("\\", "/") or path.suffix in (".png", ".xlsx", ".mp3", ".ico"):
            continue
        try:
            if key in path.read_text(encoding="utf-8"):
                found.append(str(path))
        except (UnicodeDecodeError, OSError):
            continue
    check("the key is not written down anywhere in the repository", found == [], str(found[:3]))

    # ---------- 4. the fixtures: one orphan upload, one stale row, one abandoned attempt ----------
    before = sql("""select (select count(*)::int from public.exams) exams,
                           (select count(*)::int from public.exam_sessions) sessions,
                           (select count(*)::int from public.media_files) media""")[0]
    print(f"live state before: {before}")

    status, upload = call("media", {"action": "create_upload", "mime_type": "image/png",
                                    "size_bytes": len(image), "name": "housekeeping-check.png"}, token)
    check("the check can ask for an upload link", status == 200 and upload.get("path"), f"{status} {json.dumps(upload)[:200]}")
    if status != 200:
        return 1
    put_status, _ = http("PUT", upload["upload_url"], image, {"content-type": "image/png", "x-upsert": "false"}, raw=True)
    check("the file really lands in Storage", put_status == 200, str(put_status))
    status, registered = call("media", {"action": "register", "path": upload["path"], "name": "housekeeping-check.png"}, token)
    media_id = (registered or {}).get("media", {}).get("id")
    check("it registers as a real media row", status == 200 and bool(media_id), f"{status} {json.dumps(registered)[:200]}")
    if not media_id:
        return 1
    check("Storage holds the object to begin with", upload["path"].rsplit("/", 1)[1] in storage_names(upload["path"]),
          str(storage_names(upload["path"])))
    sql(f"update public.media_files set created_at = now() - interval '2 days' where id = '{media_id}'")
    check("its row is now older than the purge's one-day age limit",
          sql(f"select (created_at < now() - interval '1 day') old from public.media_files where id = '{media_id}'")[0]["old"] is True)

    sql("insert into public.rate_limits (bucket, key, window_start, hits) "
        "values ('housekeeping_check', 'live-check', now() - interval '3 days', 5) on conflict do nothing")
    check("a stale rate-limit row is waiting", sql("select count(*)::int n from public.rate_limits where bucket = 'housekeeping_check'")[0]["n"] == 1)

    exam_id = session_id = None
    _, bank = call("question-bank", {"action": "list", "page_size": 100}, token)
    mc = [i["id"] for i in bank["items"] if i["type"] == "multiple_choice"][:2]
    _, created = call("exams", {"action": "save", "title": TITLE, "duration_minutes": 30, "passing_grade": 70,
                              "availability_mode": "manual", "access_code": CODE, "selection_mode": "manual",
                              "result_visibility": "score_and_review", "essay_pending_display": "show_partial",
                              "questions": [{"question_id": q, "weight": 1} for q in mc]}, token)
    exam_id = (created or {}).get("id")
    check("the check can create its throwaway exam", bool(exam_id), json.dumps(created)[:200])
    if not exam_id:
        return 1
    call("exams", {"action": "set_status", "id": exam_id, "status": "open"}, token)
    _, joined = call("session", {"action": "join", "code": CODE, "name": "Live Housekeeping", "class": "XII TKJ Z"}, token)
    session_id = (joined.get("session") or {}).get("id")
    check("one student joins it and then vanishes", bool(session_id), json.dumps(joined)[:200])
    if not session_id:
        return 1
    sql(f"update public.exam_sessions set ends_at = now() - interval '10 minutes' where id = '{session_id}'")
    check("that attempt is now past its end plus the two-minute tolerance",
          sql(f"select (ends_at + interval '2 minutes' < now()) late from public.exam_sessions where id = '{session_id}'")[0]["late"] is True)

    # ---------- 5. let pg_cron fire for real ----------
    run_marker = sql("select coalesce(max(runid), 0) m from cron.job_run_details")[0]["m"]
    response_marker = sql("select coalesce(max(id), 0) m from net._http_response")[0]["m"]
    ids = {name: jobs[name]["jobid"] for name in JOBS}
    for name in ("expire-sessions", "purge-rate-limits", "purge-orphan-media"):
        sql(f"select cron.alter_job({ids[name]}, '* * * * *')")
    check("every job is pointed at the next minute for the run (schedules are put back below)",
          all(j["schedule"] == "* * * * *" for j in sql("select schedule from cron.job")), "")

    print("waiting for the scheduler (up to four minutes) ...")
    rows = wait_for("runs", run_marker, lambda r: {x["jobname"] for x in r if x["status"] == "succeeded"} >= set(JOBS))
    succeeded = {x["jobname"] for x in rows if x["status"] == "succeeded"}
    check("pg_cron itself ran all three jobs (cron.job_run_details says succeeded)",
          set(JOBS) <= succeeded, json.dumps(rows)[:400])
    for name in sorted(JOBS):
        run = next((x for x in rows if x["jobname"] == name and x["status"] == "succeeded"), None)
        check(f"the {name} run succeeded", run is not None, str(run)[:200])

    replies = wait_for("responses", response_marker, lambda r: any(x["status_code"] == 200 for x in r), timeout=120)
    answer = next((x for x in replies if x["status_code"] == 200), None)
    check("the media job's HTTP call to the function came back 200", answer is not None, json.dumps(replies)[:300])
    check("and the function counted the files it removed", answer is not None and '"removed"' in (answer["content"] or ""),
          (answer or {}).get("content", "")[:200])

    # ---------- 6. the effects ----------
    after_session = sql(f"select status, (submitted_at is not null) stamped from public.exam_sessions where id = '{session_id}'")[0]
    check("the abandoned attempt was closed as timed_out and stamped",
          after_session["status"] == "timed_out" and after_session["stamped"] is True, json.dumps(after_session))
    check("the stale rate-limit row is gone",
          sql("select count(*)::int n from public.rate_limits where bucket = 'housekeeping_check'")[0]["n"] == 0)
    check("the unused upload's row is gone",
          sql(f"select count(*)::int n from public.media_files where id = '{media_id}'")[0]["n"] == 0)
    check("the file itself is gone from Storage (the whole point of doing this through the function)",
          storage_names(upload["path"]) == [], str(storage_names(upload["path"])))
    status, links = call("media", {"action": "signed_urls", "ids": [media_id]}, token)
    check("and the app is told there are no links, without an error",
          status == 200 and (links or {}).get("urls") == {}, f"{status} {json.dumps(links)[:200]}")

    # ---------- 7. put the schedules back and clean up ----------
    for name, schedule in JOBS.items():
        sql(f"select cron.alter_job({ids[name]}, '{schedule}')")
    restored = {j["jobname"]: j["schedule"] for j in sql("select jobname, schedule from cron.job")}
    check("every schedule is back to the documented one", restored == JOBS, json.dumps(restored))

    wipe_exam(f"id = '{exam_id}'")
    sql(f"delete from public.media_files where id = '{media_id}'")
    check("the attempt is gone from the session table",
          sql(f"select count(*)::int n from public.exam_sessions where id = '{session_id}'")[0]["n"] == 0)
    after = sql("""select (select count(*)::int from public.exams) exams,
                          (select count(*)::int from public.exam_sessions) sessions,
                          (select count(*)::int from public.media_files) media""")[0]
    check("the exam and its attempt are gone", after["exams"] == before["exams"] and after["sessions"] == before["sessions"],
          f"{json.dumps(after)} vs {json.dumps(before)}")
    check("nothing this check created is left in the media table", after["media"] == before["media"],
          f"{json.dumps(after)} vs {json.dumps(before)}")
    check("the check's own Storage object is not there either", storage_names(upload["path"]) == [])
    print(f"live state after cleanup: {after}")

    failed = [n for n, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    print("ALL LIVE HOUSEKEEPING CHECKS PASSED" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
