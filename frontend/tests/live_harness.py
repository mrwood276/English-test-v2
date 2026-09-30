"""Crash-proof reporting shared by the live checks (ISSUE-039).

`e2e_harness.py` gave the browser suites this: a run that dies reports *itself* instead of leaving a
bare traceback and an exit code nobody can read. The live checks talk to the real project instead of a
mocked page, and they had the very same hole. An unexpected exception escaped `main()`, Python printed
a traceback on stderr, and the run exited **1** — the code a *failed check* uses — so a check that died
after 30 of 40 checks looked exactly like one that finished and failed. Nothing said how far it got or
which live rows it had already created.

`Run` closes that hole the same way `Suite` does for the browser suites:

  * `check()` prints PASS/FAIL exactly as every live check always has, and remembers where it ran;
  * `finish("<the check's own ALL-PASSED line>")` prints that line (or `N FAILED: [...]`) and returns
    0 or 1 — so `live_crash_recovery_check.py`, which matches those exact strings, still matches;
  * an uncaught exception is reported as a loud `CRASH` block: the checks that ran, the last few of
    them with their source lines, the live rows this check is known to leave behind (`sweep` and any
    `context()` the check registered), and the full traceback — and the run exits **2**, a code no live
    check has ever used, so a crash can never be mistaken for a failed check (1);
  * the same text is written to a git-ignored log under `frontend/tests/.last-live-crash/`.

Usage in a live check:

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import live_harness

    run = live_harness.Run("live_monitor_check",
                           sweep="exam MON001 with its attempts - the next run sweeps the code")
    run.install()
    check = run.check          # drop-in for the check() the file used to define
    ...
    run.context("exam id", exam_id)     # optional: a live row a crash would leave behind
    ...
    return run.finish("ALL LIVE MONITOR CHECKS PASSED")

`python frontend/tests/live_harness.py --self-test` proves all four endings on real subprocesses
(green -> 0, a failed check -> 1, a deliberate `sys.exit(1)` -> 1, an uncaught crash -> 2).
"""

import os
import pathlib
import sys
import time
import traceback

DEFAULT_LOG_DIR = pathlib.Path(__file__).resolve().parent / ".last-live-crash"
KEEP_LOGS = 10          # crash logs kept per directory; older ones are pruned
RECENT_CHECKS = 5       # how many finished checks the crash report names


class Run:
    """One live check's record of its checks, its live rows, and its ways to end."""

    def __init__(self, name, sweep=None, log_dir=None):
        self.name = name
        self.sweep = sweep
        self.log_dir = pathlib.Path(log_dir or os.environ.get("LIVE_CRASH_DIR") or DEFAULT_LOG_DIR)
        self.checks = []        # (name, ok, "file:line") in the order they ran
        self.failures = []      # just the names, for the summary line
        self.contexts = []      # (label, value) live rows a crash would leave behind

    # -- recording -----------------------------------------------------------
    def check(self, name, cond, detail=""):
        """Prints PASS/FAIL exactly as the live checks always have, and remembers where it was called."""
        ok = bool(cond)
        frame = traceback.extract_stack(limit=2)[0]
        self.checks.append((name, ok, f"{os.path.basename(frame.filename)}:{frame.lineno}"))
        if not ok:
            self.failures.append(name)
        print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)
        return ok

    def context(self, label, value):
        """Remembers a live row or id this run created, so a crash can name what is left behind."""
        self.contexts.append((str(label), str(value)))
        return value

    # -- counts, for the ending the check prints itself ----------------------
    @property
    def total(self):
        return len(self.checks)

    @property
    def passed(self):
        return sum(1 for _, ok, _ in self.checks if ok)

    def summary_line(self, passed_text):
        if self.failures:
            return f"{len(self.failures)} FAILED: {self.failures}"
        return passed_text

    # -- the normal ending ---------------------------------------------------
    def finish(self, passed_text):
        """Prints the check's own ALL-PASSED line (or `N FAILED: [...]`) and returns 0 or 1."""
        print(self.summary_line(passed_text), flush=True)
        return 1 if self.failures else 0

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
        lines = [
            "",
            "=" * 72,
            f"CRASH - {self.name} died before it could finish",
            "=" * 72,
            f"checks run : {self.total} ({self.passed} passed, {self.total - self.passed} failed)",
            f"when       : {time.strftime('%Y-%m-%d %H:%M:%S')}",
        ]
        if self.sweep:
            lines.append(f"if it left rows: {self.sweep}")
        lines.append("")
        lines.append("last checks:")
        if self.checks:
            first = self.total - min(RECENT_CHECKS, self.total) + 1
            for i, (name, ok, where) in enumerate(self.checks[-RECENT_CHECKS:], start=first):
                lines.append(f"  {'PASS' if ok else 'FAIL'}  {i:>3}  {name}  ({where})")
        else:
            lines.append("  (none - the run died before its first check)")
        if self.contexts:
            lines.append("")
            lines.append("live rows at risk:")
            for label, text in self.contexts:
                lines.append(f"  {label}: {text}")
        lines.append("")
        lines.append("traceback:")
        lines.append("".join(traceback.format_exception(etype, value, tb)).rstrip("\n"))
        lines.append("")
        lines.append("This is a crash (exit 2), not a failed check (1): the check never reached its summary.")
        lines.append("Re-run it - the next run sweeps its own leftovers - and record what you saw in")
        lines.append(".ai/09_KNOWN_ISSUES.md (ISSUE-039) before changing any check.")
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
    """Proves the endings with real subprocesses: 0 green, 1 failed check, 2 crash, 1 on a plain exit."""
    import subprocess
    import tempfile

    here = pathlib.Path(__file__).resolve().parent
    logs = pathlib.Path(tempfile.mkdtemp(prefix="live-harness-"))

    def script(key, sweep):
        return (
            "import sys\n"
            f"sys.path.insert(0, {str(here)!r})\n"
            "from live_harness import Run\n"
            f"r = Run('self-{key}', sweep={sweep!r}, log_dir={str(logs)!r})\n"
            "r.install()\n"
            "r.check('first check', True)\n"
            "r.context('exam id', 'abc-123')\n"
        )

    cases = {
        "green": (script("green", None) + "r.check('second check', True)\nsys.exit(r.finish('ALL LIVE SELF CHECKS PASSED'))\n",
                  0, ["ALL LIVE SELF CHECKS PASSED"], []),
        "failed": (script("failed", None) + "r.check('second check', False, 'said no')\nsys.exit(r.finish('ALL LIVE SELF CHECKS PASSED'))\n",
                   1, ["FAIL second check  [said no]", "1 FAILED: ['second check']"], ["CRASH"]),
        "plain-exit": (script("plain-exit", None) + "sys.exit(1)\n",
                       1, [], ["CRASH"]),
        "crash": (script("crash", "exam MON999 with its attempts - the next run sweeps the code")
                  + "r.check('second check', True)\nraise RuntimeError('boom from the live self-test')\n",
                  2, ["CRASH - self-crash died before it could finish",
                      "checks run : 2 (2 passed, 0 failed)",
                      "if it left rows: exam MON999 with its attempts",
                      "PASS    1  first check  (self-crash.py:",
                      "live rows at risk:",
                      "exam id: abc-123",
                      "RuntimeError: boom from the live self-test",
                      "This is a crash (exit 2), not a failed check"],
                  []),
    }

    bad = 0
    for name, (code, want_code, wants, must_not) in cases.items():
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
        for banned in must_not:
            if banned in out:
                problems.append(f"unexpected {banned!r}")
        if name == "crash":
            written = list(logs.glob("self-crash-*.log"))
            if len(written) != 1:
                problems.append(f"{len(written)} crash logs written, expected 1")
            elif "boom from the live self-test" not in written[0].read_text(encoding="utf-8"):
                problems.append("crash log does not hold the traceback")
        print(("PASS " if not problems else "FAIL ") + f"self-test: {name} -> exit {want_code}"
              + (f"  [{'; '.join(problems)}]" if problems else ""))
        bad += bool(problems)
        if problems and name == "crash":
            print(out)

    print("\nALL LIVE HARNESS SELF-TESTS PASSED" if not bad else f"\n{bad} LIVE HARNESS SELF-TEST(S) FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--self-test" not in sys.argv:
        raise SystemExit("usage: python frontend/tests/live_harness.py --self-test")
    sys.exit(_self_test())
