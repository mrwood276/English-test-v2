"""Run the whole live board in one command and say which check died where.

The 13 live checks are each a script you can run on its own, and until now that is exactly how they were
run: one command per check, with the reader remembering where the last run stopped. This is the board:

    python frontend/tests/run_live_checks.py

It runs every `live_*_check.py` in a deliberate order - the two read-only checks first, then the quick
writers, then the bulk importers, then the slow housekeeping run, and `live_backup_check.py` (which
refuses while the owner's real copies exist) last - streams each check's output unchanged as it runs, and
prints one recap line per check at the end:

    PASS    ledger       0:06  (13 checks)
    CRASH   monitor      1:02  died at PASS 3 exam MON001 exists (live_monitor_check.py:120)

It starts `frontend/dev-server.py` on 8123 itself when a selected check needs the local app and nothing
answers there, and stops the one it started; a server someone else already runs is left alone.
`live_crash_recovery_check.py` is not part of the board - it kills checks and re-runs them, a proof
rather than a check - but --with-crash-proof appends it, never retried (it takes up to 90 minutes once).

What the board says, and what it exits with:

    PASS   the check exited 0                    exit 0  every selected check passed or held
    FAIL   the check exited 1 after real FAILs   exit 1  a check failed, or nothing was verified
    CRASH  it exited 2, or was killed on its     exit 2  a check died before its summary
           timeout, or exited with anything else
    HELD   live_backup_check.py refused to touch the owner's copies (exit 1 + "refusing to run") - the
           safe outcome on the live project, not a failure
    SKIP   the environment cannot run it (a missing credential, or ffmpeg for media); it is not run,
           and it is not counted as a failure
    STOPPED  Ctrl-C arrived while it was running; its next run sweeps its own rows (exit 130)

A CRASH is the same contract `live_harness.py` gives a single check (ISSUE-039): the CRASH block names
the last checks that ran with their source lines, the live rows at risk, and the full traceback, and its
log sits in `frontend/tests/.last-live-crash/`. The board's line is the recap.

A CRASH is a death, not an answer, and the connection to `*.supabase.co` can reset in bursts (ISSUE-045),
so the board re-runs a CRASHed check **by itself** up to four times and stops at the first clean pass. A
FAIL is an answer and is never retried, and the backup guard's HELD is the safe outcome and is not
retried either. Every writable check sweeps its previous run's leftovers when it starts (ISSUE-042/043),
so a retry also cleans. The recap says what happened:

    PASS    accounts     0:31  44 checks; crashed first, passed on retry 1/4 (attempt 1 died at live_accounts_check.py:213)
    CRASH   housekeeping 4:02  died at PASS 11 ...; 3 attempts, all crashed                        exit 2

    --retry N    at most N re-runs of a check that crashed (default 4, the bounded cadence ISSUE-045 asks for)
    --retry 0    no automatic retries: every crash is reported exactly as it happens

    python frontend/tests/run_live_checks.py --only ledger,monitor   # a few checks, still in board order
    python frontend/tests/run_live_checks.py --read-only             # nothing is written to the project
    python frontend/tests/run_live_checks.py --api-only              # the bulk checks skip their browser half
    python frontend/tests/run_live_checks.py --retry 0               # report a crash, never re-run it
    python frontend/tests/run_live_checks.py --with-crash-proof      # ... and prove crash recovery too
    python frontend/tests/run_live_checks.py --list                  # what the board is, before running it
    python frontend/tests/run_live_checks.py --self-test             # prove the board on fake checks; no live access

Not part of CI. A full board is a live run: every check creates its own rows in the real project and
sweeps them away when it finishes. It needs SUPABASE_ACCESS_TOKEN (Management token) and
SUPABASE_TEST_EMAIL/SUPABASE_TEST_PASSWORD; the read-only pair needs only the token (duplicates can also
use the password), and checks whose credentials are missing are SKIPped with the name of what is missing.
"""
import argparse
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]                      # frontend/tests -> the repository root
PORT = 8123
APP = f"http://127.0.0.1:{PORT}/teacher/index.html"
TIMEOUTS_FROM = "live_crash_recovery_check.py"      # the timeouts below are the ones it gives the same checks

# A CRASH block lists its last checks as `  PASS    3  the name  (file:line)`; nothing else looks like this.
MARKER = re.compile(r"^\s+(PASS|FAIL)\s+(\d+)\s+(.*?)\s+\((.*)\)\s*$", re.M)


def _check(key, about, **extra):
    """One board entry: script and path derived from the key, plus what the check needs to run."""
    spec = dict(key=key, script=f"live_{key}_check.py", about=about)
    spec.update(extra)
    spec["path"] = HERE / spec["script"]
    return spec


def board():
    """The 13 checks, in the order they run: read-only first, the slow one and the guard last."""
    return [
        _check("ledger", "read-only - the live migration ledger is explained by the git files",
               needs=[("SUPABASE_ACCESS_TOKEN",)], timeout=300),
        _check("duplicates", "read-only - no duplicate question banners in the real project",
               needs=[("SUPABASE_TEST_PASSWORD", "SUPABASE_ACCESS_TOKEN")], server=True, timeout=300),
        _check("monitor", "exam MON001 - the monitor follows real students",
               needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",)], timeout=300),
        _check("browser", "exam MON001 - the same, driven in Chromium against the real project",
               needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",)], server=True, timeout=420),
        _check("results", "exam RLC001 - the results screens against real attempts",
               needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",)], timeout=300),
        _check("notifications", "exam BELL01 - the bell, its read marks and the essay flag",
               needs=[("SUPABASE_ACCESS_TOKEN",)], timeout=300),
        _check("accounts", "the accounts screens, against a throwaway login",
               needs=[("SUPABASE_ACCESS_TOKEN",)], timeout=300),
        _check("exam_delete", "exam DELCHK - the delete rule and the admin's rights",
               needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",),
                      ("SUPABASE_ACCESS_TOKEN", "SUPABASE_ADMIN_PASSWORD")], timeout=300),
        _check("bulk", "the question bulk importer against the real project",
               needs=[("SUPABASE_TEST_PASSWORD", "SUPABASE_ACCESS_TOKEN")],
               server=True, api_only=True, timeout=420),
        _check("exam_bulk", "the exam bulk importer against the real project",
               needs=[("SUPABASE_TEST_PASSWORD", "SUPABASE_ACCESS_TOKEN")],
               server=True, api_only=True, timeout=420),
        _check("media", "a real photo and a real MP3 into the private bucket",
               needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",)],
               tool="ffmpeg", server=True, timeout=480),
        _check("housekeeping", "the nightly jobs run for real and their rows are purged",
               needs=[("SUPABASE_ACCESS_TOKEN",)], timeout=480),
        _check("backup", "the backup slice - it refuses while the owner's real copies exist",
               needs=[("SUPABASE_ACCESS_TOKEN",)], guard=True, timeout=600),
    ]


def crash_proof():
    return dict(key="crash_proof", script="live_crash_recovery_check.py",
                path=HERE / "live_crash_recovery_check.py",
                about="kills each writable check and proves the next run sweeps its rows",
                needs=[("SUPABASE_TEST_EMAIL",), ("SUPABASE_TEST_PASSWORD",),
                       ("SUPABASE_ACCESS_TOKEN",)],
                retry=False, timeout=5400)


# ---------- what a check needs before it is worth starting ----------

def missing(spec):
    """The first thing that stops this check, or None. A group needs one of its names set."""
    for group in spec.get("needs", ()):
        if not any(os.environ.get(name) for name in group):
            return ("one of " + ", ".join(group)) if len(group) > 1 else group[0]
    tool = spec.get("tool")
    if tool and shutil.which(tool) is None:
        return f"{tool} is not on PATH"
    return None


def _needs_text(spec):
    bits = [" or ".join(group) for group in spec.get("needs", ())]
    if spec.get("server"):
        bits.append(f"the app on {PORT}")
    if spec.get("tool"):
        bits.append(spec["tool"])
    return " + ".join(bits) or "nothing"


def credential_line():
    names = ("SUPABASE_ACCESS_TOKEN", "SUPABASE_TEST_EMAIL", "SUPABASE_TEST_PASSWORD",
             "SUPABASE_ADMIN_PASSWORD")
    return "; ".join(f"{name} {'set' if os.environ.get(name) else 'not set'}" for name in names)


# ---------- running one check ----------

def _flags():
    return ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
            else {"start_new_session": True})


def kill_tree(proc):
    """Kills the process and everything it spawned (the same move live_crash_recovery_check.py makes)."""
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


def _last_marker(out):
    """The last check a CRASH block got to, as `PASS 3 the name (file:line)`, or None."""
    hits = MARKER.findall(out)
    return f"{hits[-1][0]} {hits[-1][1]} {hits[-1][2]} ({hits[-1][3]})" if hits else None


def _last_line(out):
    for line in reversed(out.splitlines()):
        if line.strip():
            return line.strip()
    return ""


def _short(text, width=105):
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[:width - 3] + "..."


def _clock(seconds):
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"


def classify(row, timed_out=False):
    """Turns an exit code and an output into one of the board's statuses."""
    spec, out, rc = row["spec"], row["out"], row["rc"]
    if timed_out:
        row["status"] = "CRASH"
        row["note"] = f"still running after {spec['timeout']}s; killed"
    elif rc == 2:
        row["status"] = "CRASH"
    elif rc == 0:
        row["status"] = "PASS"
    elif rc == 1 and spec.get("guard") and "refusing to run" in out:
        row["status"] = "HELD"
        row["note"] = "the guard held: it refused while the owner's copies exist"
    elif rc == 1:
        row["status"] = "FAIL"
        row["note"] = _last_line(out)
    else:
        row["status"] = "CRASH"
        row["note"] = f"exit code {rc}, which no live check uses"
    if row["status"] == "CRASH":
        row["where"] = _last_marker(out) or "before its first check"
    return row


def _emit(line):
    """Prints a child's line; a console that cannot encode a character must not kill the stream."""
    try:
        print(line, end="", flush=True)
    except Exception:
        try:
            sys.stdout.write(line.encode("ascii", "replace").decode("ascii"))
            sys.stdout.flush()
        except Exception:
            pass


def run_one(spec, echo=True, api_only=False, attempt=1):
    """Runs one check to its end (or its timeout) and returns the row the board needs. `attempt` is 1
    for the check's first run and counts up when the board is retrying a CRASH."""
    args = [sys.executable, "-u", str(spec["path"])]
    if api_only and spec.get("api_only"):
        args.append("--api-only")
    if echo:
        suffix = f", attempt {attempt}" if attempt > 1 else ""
        print(f"\n--- {spec['key']}: {spec['about']} ({spec['script']}, up to {spec['timeout']}s{suffix})",
              flush=True)
    row = {"key": spec["key"], "spec": spec, "status": None, "rc": None, "seconds": 0.0,
           "out": "", "note": "", "where": ""}
    started = time.time()
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")      # the pipe is decoded as utf-8 below
    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", bufsize=1, **_flags())
    lines = []

    def stream():
        for line in proc.stdout:
            lines.append(line.rstrip("\n"))
            if echo:
                _emit(line)

    reader = threading.Thread(target=stream, daemon=True)
    reader.start()
    timed_out = False
    try:
        rc = proc.wait(timeout=spec["timeout"])
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc)
        rc = proc.returncode
    except KeyboardInterrupt:               # Ctrl-C: never leave the check running with no reporter
        kill_tree(proc)
        reader.join(timeout=10)
        raise
    reader.join(timeout=10)
    row.update(rc=rc, seconds=time.time() - started, out="\n".join(lines))
    return classify(row, timed_out)


def stopped_row(spec):
    return {"key": spec["key"], "spec": spec, "status": "STOPPED", "rc": None, "seconds": 0.0,
            "out": "", "note": "", "where": ""}


def _needs_the_app(spec, api_only=False):
    """True when this check drives the local app, so a retry is pointless if the app stopped answering."""
    return bool(spec.get("server")) and not (api_only and spec.get("api_only"))


def run_board(specs, echo=True, api_only=False, retries=0):
    """Runs the selected checks in order. Returns (rows, interrupted): a KeyboardInterrupt stops the
    board but not the report - the check it stopped during is named as STOPPED.

    A check that CRASHes is re-run by itself up to `retries` more times, each time from the top, and the
    first clean pass ends the retrying (ISSUE-039/045: a crash is a death, not an answer, and the
    next run also sweeps whatever the crashed one left - ISSUE-042/043). FAIL and HELD are never
    retried: both are the check's own answer."""
    rows = []
    for spec in specs:
        spec_retries = retries if spec.get("retry", True) else 0
        why = missing(spec)
        if why:
            row = {"key": spec["key"], "spec": spec, "status": "SKIP", "rc": None, "seconds": 0.0,
                   "out": "", "note": why, "where": "", "attempts": 0}
            if echo:
                print(f"\n--- {spec['key']}: SKIP ({why})", flush=True)
            rows.append(row)
            continue
        attempt = 0
        first_crash = ""
        while True:
            attempt += 1
            try:
                row = run_one(spec, echo=echo, api_only=api_only, attempt=attempt)
            except KeyboardInterrupt:
                rows.append(stopped_row(spec))
                return rows, True
            row["attempts"] = attempt
            row["retries"] = spec_retries
            if row["status"] == "CRASH":
                first_crash = first_crash or row["where"]
            if row["status"] != "CRASH" or attempt > spec_retries:
                break
            if _needs_the_app(spec, api_only) and not server_up():
                row["note"] = ((row["note"] + "; " if row["note"] else "")
                               + f"the app on {PORT} stopped answering, so it was not retried")
                break
            if echo:
                print(f"--- {spec['key']}: CRASH on attempt {attempt}; re-running it alone"
                      f" (retry {attempt} of {spec_retries})", flush=True)
        row["first_crash"] = first_crash
        rows.append(row)
    return rows, False


# ---------- the dev server ----------

def server_up():
    try:
        with urllib.request.urlopen(APP, timeout=2) as res:
            return res.status == 200
    except Exception:
        return False


def ensure_server():
    """Starts the local app only when a selected check needs it and nothing is answering on 8123."""
    if server_up():
        print(f"a dev server is already answering on {PORT}; using it and leaving it alone")
        return None
    proc = subprocess.Popen([sys.executable, "frontend/dev-server.py", str(PORT)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **_flags())
    for _ in range(60):
        if server_up():
            print(f"started frontend/dev-server.py on {PORT} for the checks that need it")
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    kill_tree(proc)
    raise SystemExit(f"could not start the dev server on {PORT}")


# ---------- the report ----------

def _detail(row):
    status = row["status"]
    attempts = row.get("attempts", 1)
    if status == "PASS":
        n = sum(1 for line in row["out"].splitlines() if line.startswith("PASS "))
        text = f"{n} check{'s' if n != 1 else ''}"
        if attempts > 1:
            where = row.get("first_crash") or ""
            loc = where[where.rfind("(") + 1:-1] if "(" in where else ""
            text += (f"; crashed first, passed on retry {attempts - 1}/{row.get('retries', 0)}"
                     + (f" (attempt 1 died at {loc})" if loc else
                        " (attempt 1 died before its first check)"))
        return _short(text)
    if status == "FAIL":
        return _short(row["note"] or "exit 1 with no summary line")
    if status == "CRASH":
        text = f"died at {row['where']}" + (f"; {row['note']}" if row["note"] else "")
        if attempts > 1:
            text += f"; {attempts} attempts, all crashed"
        return _short(text)
    if status == "HELD":
        return _short(row["note"] or "the guard held")
    if status == "SKIP":
        return _short(f"not run: {row['note']}")
    return "Ctrl-C before its summary; its next run sweeps its own rows"


def print_board(rows, started, interrupted=False):
    counts = {s: sum(1 for r in rows if r["status"] == s)
              for s in ("PASS", "FAIL", "CRASH", "HELD", "SKIP", "STOPPED")}
    print("\n" + "=" * 74)
    print(f"live board - {len(rows)} check(s) in {_clock(time.time() - started)}"
          + ("  (Ctrl-C stopped it)" if interrupted else ""))
    print("-" * 74)
    for row in rows:
        took = _clock(row["seconds"]) if row["status"] != "SKIP" else "  -  "
        print(f"  {row['status']:<8}{row['key']:<13}{took:>6}  {_detail(row)}")
    print("-" * 74)
    summary = (f"  {counts['PASS']} passed, {counts['FAIL']} failed, {counts['CRASH']} crashed,"
               f" {counts['HELD']} held, {counts['SKIP']} skipped")
    if counts["STOPPED"]:
        summary += f", {counts['STOPPED']} stopped"
    print(summary)
    retried = [row for row in rows if row.get("attempts", 0) > 1]
    if retried:
        print("  retried: " + "; ".join(f"{row['key']} {row['attempts']} attempt(s) -> {row['status']}"
                                        for row in retried))


def board_exit(rows, interrupted=False):
    statuses = [row["status"] for row in rows]
    if interrupted or "STOPPED" in statuses:
        return 130
    if "CRASH" in statuses:
        return 2
    if "FAIL" in statuses:
        return 1
    if not any(s in ("PASS", "HELD") for s in statuses):     # every check was skipped: nothing proved
        return 1
    return 0


def guidance(rows, interrupted, retries=0):
    statuses = [row["status"] for row in rows]
    if interrupted or "STOPPED" in statuses:
        return ("exit 130: Ctrl-C; the STOPPED check's next run sweeps its own rows - re-run it to see"
                " the picture it was cut from")
    if "CRASH" in statuses:
        return ("exit 2: a check died before its summary - the CRASH block above says which check it died"
                " in and where, and the log is in frontend/tests/.last-live-crash/"
                + (f"; it was re-run up to {retries} more time(s) and crashed every time" if retries
                   else " (retries are off: --retry 4 re-runs a crashed check by itself)"))
    if "FAIL" in statuses:
        return "exit 1: the FAILED lines above say which check(s), and each printed why"
    if not any(s in ("PASS", "HELD") for s in statuses):
        return ("exit 1: nothing was verified - set SUPABASE_ACCESS_TOKEN and"
                " SUPABASE_TEST_EMAIL/SUPABASE_TEST_PASSWORD and run the board again")
    skipped = statuses.count("SKIP")
    return ("exit 0: every selected check passed or held its guard"
            + (f"; {skipped} skipped (listed above), so not everything was verified" if skipped else ""))


# ---------- self-test: the board machinery on fake checks, no live access ----------

def _self_test():
    """Proves all six endings, the bounded retry, the timeout kill, the skip and the exit codes on fake
    checks."""
    import tempfile

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="live-board-self-"))
    logs = tmp / "logs"

    def fake(key, body, **extra):
        path = tmp / f"live_fake_{key}.py"
        path.write_text(body, encoding="utf-8")
        spec = {"key": key, "script": path.name, "path": path, "about": f"self-test: {key}",
                "needs": (), "timeout": 60}
        spec.update(extra)
        return spec

    green = fake("green", "import sys\nprint('PASS fake green check')\n"
                          "print('ALL FAKE CHECKS PASSED')\nsys.exit(0)\n")
    failed = fake("failed", "import sys\nprint('FAIL second fake check  [said no]')\n"
                            "print(\"3/4 fake checks passed\")\n"
                            "print(\"1 FAILED: ['second fake check']\")\nsys.exit(1)\n")
    crash = fake("crash",
                 "import sys\n"
                 f"sys.path.insert(0, {str(HERE)!r})\n"
                 "from live_harness import Run\n"
                 f"r = Run('live_fake_crash', log_dir={str(logs)!r})\n"
                 "r.install()\n"
                 "r.check('first fake check', True)\n"
                 "r.check('second fake check', True)\n"
                 "raise RuntimeError('boom from the board self-test')\n")
    guard = fake("guard", "import sys\nprint('refusing to run: this project already holds 3 backup(s)')\n"
                          "sys.exit(1)\n", guard=True)
    slow = fake("slow", "import time\ntime.sleep(30)\n", timeout=2)
    skip = fake("skip", "print('THIS SHOULD NOT RUN')\n", needs=[("LIVE_BOARD_SELF_SENTINEL",)])

    def flaky_body(marker, name):
        """A check that dies once (with its CRASH block and log) and then passes on every later run."""
        return ("import pathlib, sys\n"
                f"sys.path.insert(0, {str(HERE)!r})\n"
                f"marker = pathlib.Path({str(marker)!r})\n"
                "if not marker.exists():\n"
                "    marker.write_text('1', encoding='utf-8')\n"
                "    from live_harness import Run\n"
                f"    r = Run('{name}', log_dir={str(logs)!r})\n"
                "    r.install()\n"
                "    r.check('first fake check', True)\n"
                "    raise RuntimeError('boom once from the board self-test')\n"
                "print('PASS fake flaky check')\n"
                "print('ALL FAKE CHECKS PASSED')\n"
                "sys.exit(0)\n")

    flaky = fake("flaky", flaky_body(tmp / "flaky-once.marker", "live_fake_flaky"))
    flaky_no_retry = fake("flaky_no_retry",
                          flaky_body(tmp / "flaky-never-retried.marker", "live_fake_flaky"))

    rows, interrupted = run_board([green, failed, crash, guard, slow, skip, flaky], echo=False,
                                  retries=2)
    by_key = {row["key"]: row for row in rows}
    one_shot, _ = run_board([flaky_no_retry], echo=False, retries=0)

    wants = [
        ("green", "PASS", 0, 1, ""),
        ("failed", "FAIL", 1, 1, "1 FAILED: ['second fake check']"),
        ("crash", "CRASH", 2, 3, "3 attempts, all crashed"),
        ("guard", "HELD", 1, 1, "refusing to run"),
        ("slow", "CRASH", None, 3, "still running after 2s; killed"),
        ("skip", "SKIP", None, 0, "LIVE_BOARD_SELF_SENTINEL"),
        ("flaky", "PASS", 0, 2, "passed on retry 1/2"),
    ]
    bad = 0
    for key, status, want_rc, want_attempts, needle in wants:
        row = by_key.get(key)
        problems = []
        if row is None:
            problems.append("missing from the board")
        else:
            if row["status"] != status:
                problems.append(f"status {row['status']}, expected {status}")
            if want_rc is not None and row["rc"] != want_rc:
                problems.append(f"exit {row['rc']}, expected {want_rc}")
            if row.get("attempts", 0) != want_attempts:
                problems.append(f"{row.get('attempts')} attempt(s), expected {want_attempts}")
            text = " ".join([row["where"], row["note"], _detail(row),
                             " ".join(row["out"].splitlines()[-2:])])
            if needle and needle not in text:
                problems.append(f"missing {needle!r} in {text[:120]!r}")
        if key == "skip" and row is not None and "THIS SHOULD NOT RUN" in row["out"]:
            problems.append("the skipped check was run anyway")
        print(("PASS " if not problems else "FAIL ")
              + f"self-test: {key} -> {status}" + (f"  [{'; '.join(problems)}]" if problems else ""))
        bad += bool(problems)

    row = one_shot[0]
    ok = row["status"] == "CRASH" and row.get("attempts") == 1
    print(("PASS " if ok else "FAIL ")
          + f"self-test: --retry 0 leaves a crash a crash ({row['status']}, {row.get('attempts')} attempt)")
    bad += not ok

    exits = [("all verified", ["green", "guard"], False, 0),
             ("a failure", ["green", "failed"], False, 1),
             ("a crash", ["green", "crash"], False, 2),
             ("a crash that passed on retry", ["flaky"], False, 0),
             ("nothing verified", ["skip"], False, 1),
             ("Ctrl-C", ["green", "guard", "slow"], True, 130)]
    for label, keys, was_interrupted, want in exits:
        got = board_exit([by_key[k] for k in keys], interrupted=was_interrupted)
        ok = got == want
        print(("PASS " if ok else "FAIL ") + f"self-test: exit code for {label} -> {want}")
        bad += not ok

    shutil.rmtree(tmp, ignore_errors=True)
    print("\nALL LIVE BOARD SELF-TESTS PASSED" if not bad
          else f"\n{bad} LIVE BOARD SELF-TEST(S) FAILED")
    return 1 if bad else 0


# ---------- the command ----------

def main():
    if hasattr(sys.stdout, "reconfigure"):    # a child's output must never stop the board mid-run
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(
        description="run the whole live board in one command and say which check died where")
    parser.add_argument("--only", help="comma-separated keys to run, in board order (default: all 13)")
    parser.add_argument("--read-only", action="store_true",
                        help="only the two checks that write nothing (ledger, duplicates)")
    parser.add_argument("--api-only", action="store_true",
                        help="run the two bulk checks without their browser half")
    parser.add_argument("--retry", type=int, default=4, metavar="N",
                        help="re-run a CRASHed check by itself up to N times, stopping at the first clean"
                             " pass (default: 4; 0 disables). A FAIL, a HELD guard or a SKIP is never"
                             " retried")
    parser.add_argument("--with-crash-proof", action="store_true",
                        help="append live_crash_recovery_check.py last (it kills checks and re-runs them)")
    parser.add_argument("--list", action="store_true",
                        help="print the board and what each check needs, then stop")
    parser.add_argument("--self-test", action="store_true",
                        help="prove the board machinery on fake checks; touches no live project")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    retries = max(0, args.retry)
    all_specs = board()
    if args.with_crash_proof:
        all_specs.append(crash_proof())

    if args.read_only and args.only:
        print("--read-only and --only at once would be two selections; pick one")
        return 2
    if args.read_only:
        selected = [s for s in all_specs if s["key"] in ("ledger", "duplicates")]
    elif args.only:
        wanted = [k.strip() for k in args.only.split(",") if k.strip()]
        known = {s["key"]: s for s in all_specs}
        unknown = [k for k in wanted if k not in known]
        if unknown:
            print(f"unknown check(s): {unknown}")
            print(f"the board: {list(known)}")
            return 2
        selected = [known[k] for k in dict.fromkeys(wanted)]
    else:
        selected = all_specs

    if args.list:
        print(f"the live board - {len(selected)} check(s), in the order they run:\n")
        for spec in selected:
            print(f"  {spec['key']:<14}{spec['about']}")
            print(f"  {'':<14}needs: {_needs_text(spec)}"
                  + ("  (it refuses while the owner's copies exist)" if spec.get("guard") else ""))
        return 0

    print(f"live board - {len(selected)} check(s), read-only first, the slow one and the destructive"
          " guard last")
    print(f"retries: a CRASHed check is re-run by itself up to {retries} time(s), stopping at the first"
          " clean pass" if retries else
          "retries: off - a CRASH is reported as it happens (--retry N re-runs it up to N times)")
    print(f"credentials: {credential_line()}")
    print("A read-only run: these checks write nothing to the real project." if args.read_only else
          "A live run: every check creates its own rows in the real project and sweeps them away when it"
          " finishes.")

    need_server = any(s.get("server") and not (args.api_only and s.get("api_only")) for s in selected)
    server = None
    started = time.time()
    try:
        if need_server:
            server = ensure_server()
        elif any(s.get("server") for s in selected):
            print(f"--api-only: the checks that would need the app on {PORT} do not start one")
        rows, interrupted = run_board(selected, api_only=args.api_only, retries=retries)
    except KeyboardInterrupt:
        rows, interrupted = [], True
    finally:
        if server is not None:
            kill_tree(server)
            print(f"stopped the dev server this board started on {PORT}")

    print_board(rows, started, interrupted)
    print("  " + guidance(rows, interrupted, retries))
    return board_exit(rows, interrupted)


if __name__ == "__main__":
    sys.exit(main())
