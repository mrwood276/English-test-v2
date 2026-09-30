"""Crash-proof reporting shared by the browser suites (ISSUE-039).

Every suite prints PASS/FAIL lines and ends with a summary, but an *unexpected*
exception used to escape the `with sync_playwright()` block: Python printed a
traceback on stderr and exited 1 with no summary and no word on how far the run
had got. That is exactly what ISSUE-039 records — `notifications_e2e.py` exited 1
with **no checks printed at all**, and `exams_e2e.py` exited 1 after 73 of its 82
checks, each green on every re-run since. The reason neither was ever explained
is that the failing run left no evidence behind.

`Suite` gives every suite one place to count its checks, to keep the page it is
driving, and to report an uncaught exception as a loud `CRASH` block: the checks
that ran, the last few of them with their source lines, the exception and its
full traceback, the page it was on, the console errors it had collected, and the
path of a log file holding the same text. A crash exits **2**, so it can never be
mistaken for a failed check (1) — and a run that dies at check 40 of 82 now says
so on stdout even when the runner keeps only stdout.

Usage in a suite:

    from e2e_harness import Suite

    suite = Suite("exams_e2e", base=BASE)
    suite.install()          # an uncaught exception reports itself from here on
    check = suite.check      # drop-in for the suite's own check()
    ...
    suite.watch(page, errors)   # so a crash can name the page and its errors
    ...
    suite.finish()           # prints the summary and exits 0 or 1

`python frontend/tests/e2e_harness.py --self-test` proves all three endings
(green → 0, a failed check → 1, a crash → 2) on real subprocesses.
"""

import os
import pathlib
import sys
import time
import traceback

DEFAULT_LOG_DIR = pathlib.Path(__file__).resolve().parent / ".last-crash"
KEEP_LOGS = 10          # crash logs kept per directory; older ones are pruned
RECENT_CHECKS = 5       # how many finished checks the crash report names


class Suite:
    """One browser suite's check log, its pages, and its three ways to end."""

    def __init__(self, name, base=None, log_dir=None):
        self.name = name
        self.base = base
        self.log_dir = pathlib.Path(log_dir or os.environ.get("E2E_CRASH_DIR") or DEFAULT_LOG_DIR)
        self.checks = []        # (name, ok, "file:line") in the order they ran
        self.failures = []      # just the names, for suites that still print them
        self.pages = []         # (page, errors list) pairs worth naming in a crash

    # -- recording -----------------------------------------------------------
    def check(self, name, cond, detail=""):
        """Prints PASS/FAIL exactly as the suites always have, and remembers where it was called."""
        ok = bool(cond)
        frame = traceback.extract_stack(limit=2)[0]
        self.checks.append((name, ok, f"{os.path.basename(frame.filename)}:{frame.lineno}"))
        if not ok:
            self.failures.append(name)
        print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)
        return ok

    def watch(self, page, errors=None):
        """Remembers a page (and the console/page errors collected for it) for the crash report."""
        self.pages.append((page, errors if errors is not None else []))
        return page

    # -- the normal ending ---------------------------------------------------
    def summary_line(self):
        n = len(self.checks)
        if self.failures:
            return f"FAILED ({n} checks): " + "; ".join(self.failures)
        return f"ALL CHECKS PASSED ({n} checks)"

    def finish(self):
        """Prints the summary and exits 0 (all green) or 1 (a check failed)."""
        print("\n" + self.summary_line(), flush=True)
        sys.exit(1 if self.failures else 0)

    # -- the unexpected ending ----------------------------------------------
    def install(self):
        """Routes an uncaught exception through `crash_report` instead of a bare stderr traceback."""
        sys.excepthook = self._uncaught
        return self

    def _uncaught(self, etype, value, tb):
        try:
            report = self.crash_report(etype, value, tb)
        except Exception:                     # never let the reporter hide the real error
            traceback.print_exception(etype, value, tb)
            sys.exit(2)
        print(report, flush=True)
        try:
            print(f"crash log: {self._write_log(report)}", flush=True)
        except OSError as exc:
            print(f"crash log: could not be written ({exc})", flush=True)
        sys.exit(2)

    def crash_report(self, etype, value, tb):
        passed = sum(1 for _, ok, _ in self.checks if ok)
        lines = [
            "",
            "=" * 72,
            f"CRASH - {self.name} died before it could finish",
            "=" * 72,
            f"checks run : {len(self.checks)} ({passed} passed, {len(self.checks) - passed} failed)",
        ]
        if self.base:
            lines.append(f"base url   : {self.base}")
        lines.append(f"when       : {time.strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append("")
        lines.append("last checks:")
        if self.checks:
            first = len(self.checks) - min(RECENT_CHECKS, len(self.checks)) + 1
            for i, (name, ok, where) in enumerate(self.checks[-RECENT_CHECKS:], start=first):
                lines.append(f"  {'PASS' if ok else 'FAIL'}  {i:>3}  {name}  ({where})")
        else:
            lines.append("  (none - the run died before its first check)")
        for page, errors in self.pages:
            try:
                url = page.url
            except Exception:
                url = "(the browser is already gone)"
            lines.append(f"page       : {url}")
            if errors:
                lines.append(f"console    : {len(errors)} collected (some may be expected)")
                for e in errors[-5:]:
                    lines.append(f"  - {str(e).splitlines()[0][:200]}")
        lines.append("")
        lines.append("traceback:")
        lines.append("".join(traceback.format_exception(etype, value, tb)).rstrip("\n"))
        lines.append("")
        lines.append("This is a crash (exit 2), not a failed check: the suite never reached its summary.")
        lines.append("Record it in .ai/09_KNOWN_ISSUES.md (ISSUE-039) before changing any test.")
        lines.append("=" * 72)
        return "\n".join(lines)

    def _write_log(self, text):
        self.log_dir.mkdir(parents=True, exist_ok=True)
        path = self.log_dir / f"{self.name}-{time.strftime('%Y%m%d-%H%M%S')}.log"
        path.write_text(text + "\n", encoding="utf-8")
        logs = sorted(self.log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in logs[KEEP_LOGS:]:
            try:
                old.unlink()
            except OSError:
                pass
        return path


# ---------------------------------------------------------------------------

def _self_test():
    """Proves the three endings with real subprocesses: 0 green, 1 failed check, 2 crash."""
    import subprocess
    import tempfile

    here = pathlib.Path(__file__).resolve().parent
    logs = pathlib.Path(tempfile.mkdtemp(prefix="e2e-harness-"))

    def script(body):
        return (
            "import sys\n"
            f"sys.path.insert(0, {str(here)!r})\n"
            "from e2e_harness import Suite\n"
            f"s = Suite('self-{body}', base='http://127.0.0.1:1/', log_dir={str(logs)!r})\n"
            "s.install()\n"
            "s.check('first check', True)\n"
        )

    cases = {
        "green": (script("green") + "s.check('second check', True)\ns.finish()\n", 0,
                  ["ALL CHECKS PASSED (2 checks)"]),
        "failed": (script("failed") + "s.check('second check', False, 'said no')\ns.finish()\n", 1,
                   ["FAIL second check  [said no]", "FAILED (2 checks): second check"]),
        "crash": (script("crash") + "s.check('second check', True)\nraise RuntimeError('boom from the self-test')\n", 2,
                  ["CRASH - self-crash died before it could finish",
                   "checks run : 2 (2 passed, 0 failed)",
                   "PASS    1  first check  (self-crash.py:",
                   "RuntimeError: boom from the self-test",
                   "This is a crash (exit 2), not a failed check"]),
    }

    bad = 0
    for name, (code, want_code, wants) in cases.items():
        path = logs / f"self-{name}.py"
        path.write_text(code, encoding="utf-8")
        proc = subprocess.run([sys.executable, str(path)], capture_output=True, text=True, cwd=str(here))
        out = proc.stdout
        problems = []
        if proc.returncode != want_code:
            problems.append(f"exit {proc.returncode}, expected {want_code}")
        for want in wants:
            if want not in out and want not in proc.stderr:
                problems.append(f"missing {want!r}")
        if name == "crash":
            written = list(logs.glob("self-crash-*.log"))
            if len(written) != 1:
                problems.append(f"{len(written)} crash logs written, expected 1")
            elif "boom from the self-test" not in written[0].read_text(encoding="utf-8"):
                problems.append("crash log does not hold the traceback")
        print(("PASS " if not problems else "FAIL ") + f"self-test: {name} -> exit {want_code}"
              + (f"  [{'; '.join(problems)}]" if problems else ""))
        bad += bool(problems)
        if problems and name == "crash":
            print(out)

    print("\nALL HARNESS SELF-TESTS PASSED" if not bad else f"\n{bad} HARNESS SELF-TEST(S) FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--self-test" not in sys.argv:
        raise SystemExit("usage: python frontend/tests/e2e_harness.py --self-test")
    sys.exit(_self_test())
