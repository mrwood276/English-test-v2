"""Proof of the crash path: a dead live check's leftovers are swept by the next run (ISSUE-041 follow-up).

Every live check that writes to the real project promises that a run which died mid-way does not block
or pollute the next one. This script makes that promise a measured fact instead of a comment. For each
check it:

  1. starts the check and **kills it on purpose** (taskkill /F /T on Windows, SIGKILL to the whole
     process group elsewhere) the moment its own rows exist in the live project;
  2. reads the project and prints exactly what the dead run left behind;
  3. runs the same check again, normally;
  4. requires that run to exit 0 with its own ALL-PASSED line, to say in its output that it swept the
     leftovers (where it prints one), and requires the project to hold none of the dead run's rows.

What each case exercises:

  monitor       exam MON001 with live attempts   next run sweeps by access code
  browser       exam MON001 with live attempts   next run sweeps by access code (needs 8123)
  results       exam RLC001 + its two questions  next run sweeps the code and the question marker
  housekeeping  exam HSKEEP + media + schedules  next run sweeps by code, restores borrowed schedules
  notifications exam BELL01 + question + rows    next run's wipe_check() at startup
  accounts      throwaway account + login        next run's wipe_check() at startup
  bulk          LIVE BULK CHECK questions/topics next run sweeps them by marker
  exam_bulk     LIVE EXAM BULK exam + questions  next run sweeps them by marker
  media         media-check question, files, bytes  next run sweeps by body and sample-file names
  exam_delete   exam DELCHK with one attempt     next run sweeps by access code

`live_backup_check.py` gets the opposite experiment, because it is destructive by design: run for
real, it must **refuse** to touch a project that already holds the owner's copies.

Every writable live check is covered; `live_duplicates_check.py` and `live_ledger_check.py` are
read-only by design and are not killed.

    SUPABASE_TEST_EMAIL='...' SUPABASE_TEST_PASSWORD='...' SUPABASE_ACCESS_TOKEN='...' \
        python frontend/tests/live_crash_recovery_check.py [--only monitor,browser]

Not part of CI. The browser case starts `frontend/dev-server.py` on 8123 itself when nothing answers
there. If a case fails, this script still removes the dead run's rows by hand before moving on, so the
live project ends as it began and the failure is reported rather than left behind.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import live_cleanup

URL = "https://lbhnadqmokloyfarrzfv.supabase.co"
KEY = "sb_publishable_WewR6gpQy3SdaoBaJxxDyg_l5gt-R7E"
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TMP = tempfile.mkdtemp(prefix="crash-recovery-")
SERVICE = None

# The counters every run must leave exactly as it found them, so a case cannot hide behind its own rows.
FINGERPRINT = """select
    (select count(*)::int from public.exams) as exams,
    (select count(*)::int from public.exam_sessions) as sessions,
    (select count(*)::int from public.questions) as questions,
    (select count(*)::int from public.questions where is_archived) as archived,
    (select count(*)::int from public.backups) as backups,
    (select count(*)::int from public.profiles) as profiles,
    (select count(*)::int from public.topics) as topics,
    (select count(*)::int from public.notification_reads) as read_marks,
    (select count(*)::int from public.rate_limits where bucket like 'session\\_%') as session_rates,
    (select count(*)::int from storage.objects where bucket_id = 'question-media') as media_objects"""


def sql(query):
    return live_cleanup.management_sql(ACCESS)(query)


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                headers={"apikey": KEY, "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode() or "null")


def service():
    """The service_role key, for the two things SQL cannot do: Auth users and Storage bytes."""
    global SERVICE
    if SERVICE is None:
        status, keys = http("GET", f"https://api.supabase.com/v1/projects/{live_cleanup.PROJECT}/api-keys", None,
                            {"Authorization": f"Bearer {ACCESS}"})
        SERVICE = next(k["api_key"] for k in keys if k["name"] == "service_role")
    return SERVICE


def delete_user(user_id):
    return http("DELETE", f"{URL}/auth/v1/admin/users/{user_id}", None,
                {"Authorization": f"Bearer {service()}"})


def delete_objects(paths):
    if not paths:
        return 0
    status, _ = http("DELETE", f"{URL}/storage/v1/object/question-media", {"prefixes": paths},
                     {"Authorization": f"Bearer {service()}"})
    return status


# ---------- probes: only this check's own rows, every one expected 0 after cleanup ----------

def probe_monitor():
    return sql("""select
        (select count(*)::int from public.exams where access_code = 'MON001') as exams,
        (select count(*)::int from public.exam_sessions s join public.exams e on e.id = s.exam_id
          where e.access_code = 'MON001') as sessions""")[0]


def probe_results():
    return sql("""select
        (select count(*)::int from public.exams where access_code = 'RLC001') as exams,
        (select count(*)::int from public.exam_sessions s join public.exams e on e.id = s.exam_id
          where e.access_code = 'RLC001') as sessions,
        (select count(*)::int from public.questions where body like '%(live results check)') as questions""")[0]


def probe_notifications():
    return sql("""select
        (select count(*)::int from public.exams where access_code = 'BELL01') as exams,
        (select count(*)::int from public.exam_sessions s join public.exams e on e.id = s.exam_id
          where e.access_code = 'BELL01') as sessions,
        (select count(*)::int from public.questions where body = 'Live Bell Check essay (safe to delete)') as questions,
        (select count(*)::int from public.profiles where full_name like 'Live Bell Check%') as profiles,
        (select count(*)::int from auth.users where email like 'bell-check-%') as logins""")[0]


def probe_accounts():
    return sql("""select
        (select count(*)::int from public.profiles where full_name like 'Live Accounts Check%') as profiles,
        (select count(*)::int from auth.users where email like 'accounts-check-%') as logins""")[0]


def probe_housekeeping():
    return sql("""select
        (select count(*)::int from public.exams where access_code = 'HSKEEP') as exams,
        (select count(*)::int from public.exam_sessions s join public.exams e on e.id = s.exam_id
          where e.access_code = 'HSKEEP') as sessions,
        (select count(*)::int from public.media_files where original_name = 'housekeeping-check.png') as media,
        (select count(*)::int from public.rate_limits where bucket = 'housekeeping_check') as rates,
        (select count(*)::int from cron.job where
             (jobname = 'expire-sessions' and schedule <> '*/5 * * * *')
          or (jobname = 'purge-rate-limits' and schedule <> '19 19 * * *')
          or (jobname = 'purge-orphan-media' and schedule <> '29 19 * * *')) as borrowed_jobs""")[0]


def probe_backup():
    return sql("select (select count(*)::int from public.backups) as backups")[0]


def probe_bulk():
    return sql("""select
        (select count(*)::int from public.questions where body like 'LIVE BULK CHECK %') as questions,
        (select count(*)::int from public.topics where public.normalize_text(name) like 'live bulk %') as topics""")[0]


def probe_exam_bulk():
    return sql("""select
        (select count(*)::int from public.exams
          where title like 'Live exam bulk check (safe to delete)%') as exams,
        (select count(*)::int from public.questions where body like 'LIVE EXAM BULK %') as questions""")[0]


def probe_media():
    return sql("""select
        (select count(*)::int from public.questions
          where body = 'Live media check: listen and answer. (safe to delete)') as questions,
        (select count(*)::int from public.media_files
          where original_name like 'live-photo.%' or original_name like 'live-tone.%') as files,
        (select count(*)::int from public.question_media qm join public.questions q on q.id = qm.question_id
          where q.body = 'Live media check: listen and answer. (safe to delete)') as attachments""")[0]


def probe_exam_delete():
    return sql("""select
        (select count(*)::int from public.exams where access_code = 'DELCHK') as exams,
        (select count(*)::int from public.exam_sessions s join public.exams e on e.id = s.exam_id
          where e.access_code = 'DELCHK') as sessions""")[0]


# ---------- sweeps: what this script does if a recovery run fails, so nothing is left behind ----------

def clean_monitor():
    live_cleanup.wipe_leftover_exam(sql, "MON001")
    live_cleanup.sweep_rate_limits(sql)


def clean_results():
    live_cleanup.wipe_leftover_exam(sql, "RLC001")
    for row in sql("select id from public.questions where body like '%(live results check)'"):
        live_cleanup.wipe_question(sql, row["id"])
    live_cleanup.sweep_rate_limits(sql)


def clean_notifications():
    # the exam first: it references the question (this order is itself half the point of the case)
    live_cleanup.wipe_leftover_exam(sql, "BELL01")
    for row in sql("select id from public.questions where body = 'Live Bell Check essay (safe to delete)'"):
        live_cleanup.wipe_question(sql, row["id"])
    sql("delete from public.audit_logs where action like 'account.%' and entity_id in "
        "(select id::text from public.profiles where full_name like 'Live Bell Check%')")
    ids = [r["id"] for r in sql("select id from public.profiles where full_name like 'Live Bell Check%'")]
    ids += [r["id"] for r in sql("select id from auth.users where email like 'bell-check-%'")]
    for uid in dict.fromkeys(ids):
        delete_user(uid)
    sql("delete from public.notification_reads")
    live_cleanup.sweep_rate_limits(sql)


def clean_accounts():
    sql("delete from public.audit_logs where action like 'account.%' and entity_id in "
        "(select id::text from public.profiles where full_name like 'Live Accounts Check%')")
    ids = [r["id"] for r in sql("select id from public.profiles where full_name like 'Live Accounts Check%'")]
    ids += [r["id"] for r in sql("select id from auth.users where email like 'accounts-check-%'")]
    for uid in dict.fromkeys(ids):
        delete_user(uid)


def clean_housekeeping():
    rows = sql("select storage_path from public.media_files where original_name = 'housekeeping-check.png'")
    delete_objects([r["storage_path"] for r in rows])
    live_cleanup.wipe_leftover_exam(sql, "HSKEEP")
    for name, schedule in (("expire-sessions", "*/5 * * * *"), ("purge-rate-limits", "19 19 * * *"),
                           ("purge-orphan-media", "29 19 * * *")):
        found = sql(f"select jobid from cron.job where jobname = '{name}'")
        if found:
            sql(f"select cron.alter_job({found[0]['jobid']}, '{schedule}')")


# ---------- the cases ----------

def clean_bulk():
    live_cleanup.wipe_leftover_questions(sql, "LIVE BULK CHECK %", keep_audit=True)
    sql("delete from public.topics t where public.normalize_text(t.name) like 'live bulk %' "
        "and not exists (select 1 from public.questions q where q.topic_id = t.id)")


def clean_exam_bulk():
    for row in sql("select id from public.exams "
                   "where title like 'Live exam bulk check (safe to delete)%'"):
        live_cleanup.wipe_exam(sql, row["id"])
    live_cleanup.wipe_leftover_questions(sql, "LIVE EXAM BULK %", keep_audit=True)


def clean_media():
    qids = [r["id"] for r in sql("select id from public.questions "
                                 "where body = 'Live media check: listen and answer. (safe to delete)'")]
    mids = [r["id"] for r in sql("select id from public.media_files "
                                 "where original_name like 'live-photo.%' or original_name like 'live-tone.%'")]
    if qids:
        mids += [r["media_id"] for r in sql(f"select media_id from public.question_media "
                                           f"where question_id = any('{{{','.join(qids)}}}'::uuid[])")]
    mids = list(dict.fromkeys(mids))
    if mids:
        rows = sql(f"select storage_path from public.media_files "
                   f"where id = any('{{{','.join(mids)}}}'::uuid[])")
        delete_objects([r["storage_path"] for r in rows])
        sql(f"delete from public.question_media where media_id = any('{{{','.join(mids)}}}'::uuid[])")
        sql(f"delete from public.media_files where id = any('{{{','.join(mids)}}}'::uuid[])")
    for qid in qids:
        live_cleanup.wipe_question(sql, qid, keep_audit=True)


def clean_exam_delete():
    live_cleanup.wipe_leftover_exam(sql, "DELCHK")


def cases():
    return [
        {
            "key": "monitor",
            "script": "frontend/tests/live_monitor_check.py",
            "about": "one exam (MON001) with four live attempts; the next run sweeps it by access code",
            "probe": probe_monitor,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 2,
            "required_text": ["was swept before this one started", "ALL LIVE MONITOR CHECKS PASSED"],
            "kill_deadline": 120, "timeout": 300, "clean": clean_monitor,
        },
        {
            "key": "results",
            "script": "frontend/tests/live_results_check.py",
            "about": "exam RLC001 plus the two questions it makes; the next run sweeps both",
            "probe": probe_results,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 1,
            "required_text": ["leftover questions", "was swept before this one started", "ALL LIVE CHECKS PASSED"],
            "kill_deadline": 120, "timeout": 300, "clean": clean_results,
        },
        {
            "key": "notifications",
            "script": "frontend/tests/live_notifications_check.py",
            "about": "exam BELL01, its essay question and read marks; the next run's wipe_check sweeps them",
            "probe": probe_notifications,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 1,
            "required_text": ["PASS the starting point has the two real accounts and none of this check's leftovers",
                              "ALL LIVE NOTIFICATION CHECKS PASSED"],
            "kill_deadline": 120, "timeout": 300, "clean": clean_notifications,
        },
        {
            "key": "accounts",
            "script": "frontend/tests/live_accounts_check.py",
            "about": "a throwaway account and its login; the next run's wipe_check deletes them",
            "probe": probe_accounts,
            "ready": lambda s: s["profiles"] >= 1,
            "required_text": ["PASS the starting point has the two real accounts and no account history",
                              "ALL LIVE ACCOUNT CHECKS PASSED"],
            "kill_deadline": 180, "timeout": 300, "clean": clean_accounts,
        },
        {
            "key": "bulk",
            "script": "frontend/tests/live_bulk_check.py",
            "about": ("three LIVE BULK CHECK questions and their two test topics; the next run sweeps"
                      " them by marker and by the topic name pattern"),
            "probe": probe_bulk,
            "ready": lambda s: s["questions"] >= 3 and s["topics"] >= 1,
            "required_text": ["swept before this one started", "ALL LIVE BULK CHECKS PASSED"],
            "kill_deadline": 180, "timeout": 420, "clean": clean_bulk, "needs_server": True,
        },
        {
            "key": "exam_bulk",
            "script": "frontend/tests/live_exam_bulk_check.py",
            "about": ("one Live exam bulk check draft exam and its five LIVE EXAM BULK questions;"
                      " the next run sweeps them by marker"),
            "probe": probe_exam_bulk,
            "ready": lambda s: s["exams"] >= 1 and s["questions"] >= 5,
            "required_text": ["swept before this one started", "ALL LIVE EXAM BULK CHECKS PASSED"],
            "kill_deadline": 180, "timeout": 420, "clean": clean_exam_bulk, "needs_server": True,
        },
        {
            "key": "media",
            "script": "frontend/tests/live_media_check.py",
            "about": ("the media check's question, its two media rows and their Storage bytes;"
                      " the next run sweeps by body text and sample-file names"),
            "probe": probe_media,
            "ready": lambda s: s["questions"] >= 1 and s["files"] >= 2,
            "required_text": ["swept before this one started", "ALL LIVE MEDIA CHECKS PASSED"],
            "kill_deadline": 240, "timeout": 480, "clean": clean_media, "needs_server": True,
        },
        {
            "key": "exam_delete",
            "script": "frontend/tests/live_exam_delete_check.py",
            "about": "one DELCHK exam with an attempt; the next run sweeps it by access code",
            "probe": probe_exam_delete,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 1,
            "required_text": ["swept before this one started", "ALL LIVE DELETE-RULE CHECKS PASSED"],
            "kill_deadline": 120, "timeout": 300, "clean": clean_exam_delete,
        },
        {
            "key": "housekeeping",
            "script": "frontend/tests/live_housekeeping_check.py",
            "about": ("exam HSKEEP, a media row, a rate row and the three borrowed job schedules;"
                      " the next run sweeps and puts back all of it"),
            "probe": probe_housekeeping,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 1 and s["borrowed_jobs"] >= 1,
            "required_text": ["while the schedules were borrowed", "ALL LIVE HOUSEKEEPING CHECKS PASSED"],
            "kill_deadline": 300, "timeout": 480, "clean": clean_housekeeping,
        },
        {
            "key": "browser",
            "script": "frontend/tests/live_browser_check.py",
            "about": "exam MON001 through Chromium; the next run sweeps it by access code",
            "probe": probe_monitor,
            "ready": lambda s: s["exams"] >= 1 and s["sessions"] >= 2,
            "required_text": ["was swept before this one started", "ALL LIVE BROWSER CHECKS PASSED"],
            "kill_deadline": 120, "timeout": 420, "clean": clean_monitor, "needs_server": True,
        },
        {
            "key": "backup",
            "script": "frontend/tests/live_backup_check.py",
            "about": "the destructive check must refuse while the owner's real copies exist",
            "probe": probe_backup,
            "guard": True,
            "required_text": ["refusing to run"],
            "timeout": 120,
        },
    ]


# ---------- running ----------

def start(script, log_path=None):
    out = open(log_path, "w", encoding="utf-8", errors="replace") if log_path else subprocess.PIPE
    flags = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
             else {"start_new_session": True})
    return subprocess.Popen([sys.executable, "-u", script], cwd=ROOT, env=dict(os.environ),
                            stdout=out, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", **flags)


def kill_tree(proc):
    """Kills the process and everything it spawned, the way a crash would leave it."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()


def tail(text, lines=8):
    return "\n".join(text.strip().splitlines()[-lines:])


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def safe_clean(case):
    """The script's own sweep-up, so a failed case still leaves the project as it found it."""
    try:
        case["clean"]()
        return True
    except Exception as err:
        print(f"  FAIL: this script's own sweep-up failed too: {err}")
        return False


def run_check(script, timeout):
    proc = start(script)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out or ""
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        out, _ = proc.communicate()
        print(f"  (the run did not finish within {timeout}s and was killed)")
        return -9, out or ""


def run_case(case):
    print(f"\n=== {case['key']}: {case['about']}")
    if case.get("guard"):
        before = case["probe"]()
        rc, out = run_check(case["script"], case["timeout"])
        after = case["probe"]()
        missing = [t for t in case["required_text"] if t not in out]
        ok = rc == 1 and not missing and after == before and (after.get("backups") or 0) > 0
        print(f"  the guard run exited {rc}; copies {json.dumps(before)} -> {json.dumps(after)}")
        if ok:
            print("  PASS: it refused to run and the owner's copies are untouched")
        else:
            print(f"  FAIL: missing {missing}\n{tail(out)}")
        return ok

    state = case["probe"]()
    if any(state.values()):
        print(f"  a previous run was not put away ({json.dumps(state)}); this script sweeps it first")
        safe_clean(case)
        state = case["probe"]()
        if any(state.values()):
            print(f"  FAIL: could not get a clean starting point ({json.dumps(state)})")
            return False

    log = os.path.join(TMP, f"{case['key']}-crash.log")
    proc = start(case["script"], log_path=log)
    state = {}
    deadline = time.time() + case["kill_deadline"]
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            state = case["probe"]()
        except Exception as err:  # the Management API can hiccup; the poll is cheap
            print(f"  (probe failed, still polling: {err})")
        if state and case["ready"](state):
            break
        time.sleep(1)

    if proc.poll() is None and state and case["ready"](state):
        kill_tree(proc)
        print(f"  killed the run on purpose the moment its rows existed (pid {proc.pid})")
    else:
        proc.wait(timeout=30)
        print(f"  FAIL: the check was not caught mid-run (it exited {proc.returncode} first);"
              " nothing was proved")
        print(f"  its last lines:\n{tail(read(log))}")
        safe_clean(case)
        return False

    left = case["probe"]()
    print(f"  what the dead run left behind: {json.dumps(left)}")
    if not any(left.values()):
        print("  FAIL: the probe shows nothing was created, so the kill proves nothing")
        safe_clean(case)
        return False

    rc, out = run_check(case["script"], case["timeout"])
    for line in out.splitlines():
        if "swept before this one started" in line:
            print(f"  the next run: {line.strip()}")
    after = case["probe"]()
    missing = [t for t in case["required_text"] if t not in out]
    if rc == 0 and not missing and not any(after.values()):
        print(f"  PASS: the next run passed end to end, swept the dead run's rows, and left none"
              f" ({json.dumps(after)})")
        return True
    print(f"  FAIL: the next run exited {rc}; missing from its output: {missing};"
          f" its rows after it: {json.dumps(after)}")
    print(f"  its last lines:\n{tail(out, 12)}")
    safe_clean(case)
    print(f"  swept by this script instead: {json.dumps(case['probe']())}")
    return False


# ---------- the browser case needs the app on 8123 ----------

def server_up():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8123/teacher/index.html", timeout=2) as res:
            return res.status == 200
    except Exception:
        return False


def ensure_server():
    if server_up():
        print("a dev server is already answering on 8123; using it and leaving it alone")
        return None
    flags = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
             else {"start_new_session": True})
    proc = subprocess.Popen([sys.executable, "frontend/dev-server.py", "8123"], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
    for _ in range(60):
        if server_up():
            print("started frontend/dev-server.py on 8123 for the browser case")
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    kill_tree(proc)
    raise SystemExit("could not start the dev server on 8123")


def main():
    parser = argparse.ArgumentParser(description="kill each self-cleaning live check and prove the next run sweeps it")
    parser.add_argument("--only", help="comma-separated case keys (default: all)")
    args = parser.parse_args()
    if not ACCESS:
        print("set SUPABASE_ACCESS_TOKEN first: the proof reads the live project through the Management API")
        return 2
    if not os.environ.get("SUPABASE_TEST_EMAIL") or not os.environ.get("SUPABASE_TEST_PASSWORD"):
        print("set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD too: the checks sign in with them")
        return 2

    known = {c["key"]: c for c in cases()}
    selected = list(known)
    if args.only:
        wanted = [k.strip() for k in args.only.split(",") if k.strip()]
        unknown = [k for k in wanted if k not in known]
        if unknown:
            print(f"unknown case(s): {unknown}; known: {list(known)}")
            return 2
        selected = wanted

    # A previous crashed proof (or a check someone killed) may have left its own rows. Every sweep in
    # this script is scoped to one check's own markers, so starting from their zero is exactly what the
    # script promises the project anyway; anything it swept is said out loud.
    for key in selected:
        case = known[key]
        if case.get("clean") and any(case["probe"]().values()):
            print(f"a previous run left {key} rows behind; sweeping them first")
            safe_clean(case)
    before = sql(FINGERPRINT)[0]
    print(f"live project before: {json.dumps(before)}")
    server = ensure_server() if any(known[k].get("needs_server") for k in selected) else None
    results = {}
    try:
        for key in selected:
            try:
                results[key] = run_case(known[key])
            except Exception as err:  # one case's accident must not end the proof
                print(f"  CASE ERROR: {err}")
                results[key] = False
    finally:
        if server is not None:
            kill_tree(server)
            print("stopped the dev server this script started")

    after = sql(FINGERPRINT)[0]
    print(f"live project after:  {json.dumps(after)}")
    same = before == after
    print("the project is exactly as it was" if same
          else f"THE PROJECT CHANGED: {json.dumps(before)} -> {json.dumps(after)}")

    print("\nproof of the crash path:")
    for key in selected:
        print(f"  {'PROVED ' if results[key] else 'FAILED '}{key}")
    print("\nevery writable live check now has a crash case; live_duplicates_check.py and"
          "\nlive_ledger_check.py are read-only by design and are not killed.")

    failed = [k for k in selected if not results[k]]
    print()
    print("ALL LIVE CRASH-RECOVERY CHECKS PASSED" if not failed and same
          else f"{len(failed)} FAILED: {failed}{'' if same else ' (and the project changed)'}")
    return 0 if not failed and same else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
