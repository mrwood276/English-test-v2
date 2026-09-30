"""LIVE check: the live migration ledger against `supabase/migrations/` (ISSUE-036).

    SUPABASE_ACCESS_TOKEN='...' python frontend/tests/live_ledger_check.py

Read-only. It answers one question the repository could not answer before 2026-09-30: **can the live
database be explained by the files in git?** It reads `supabase_migrations.schema_migrations` and, for
every live public function, the newest migration file (by version) that defines it, then compares the
two bodies ignoring comments and whitespace — so a file and a live object count as the same SQL when
only their comments or formatting differ.

What it proves:
  1. every live ledger row has a file in the repository (a row with no file is drift: nothing in git
     explains what ran);
  2. every live public function is defined by some file, and the **newest** file that defines it
     matches the live body (the older files are history — e.g. `list_exam_results` is defined by four
     files and the last one wins);
  3. the files in git with no live ledger row are listed, with the reason they are not drift (applied
     by hand, or tracked under another version name).

It does NOT apply anything, and it does not judge which version names are "right" — the live ledger
keeps the names history gave it. Contract and mapping: `docs/migration-ledger-reconciliation.md`.
"""
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

PROJECT = "lbhnadqmokloyfarrzfv"
ACCESS = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "migrations"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_harness

harness = live_harness.Run("live_ledger_check",
                           sweep="nothing - this check only reads the live ledger")
harness.install()
check = harness.check


def sql(query):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
                                 data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {ACCESS}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"database said: {err.read().decode('utf-8', 'replace')[:400]}") from None


def norm(text):
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in t.split("\n")).strip()


def skeleton(text):
    """The SQL minus comments and formatting: two bodies that differ only in those are the same SQL."""
    t = (text or "").replace("\r\n", "\n")
    t = "\n".join(re.sub(r"--.*$", "", line) for line in t.split("\n"))
    return re.sub(r"\s+", " ", t).strip().lower().rstrip(";")


BODY = re.compile(r"as\s+\$(\w*)\$(.*?)\$\1\$", re.I | re.S)


def function_bodies(text):
    """{name: [body skeleton, ...]} for every `create [or replace] function [public.]name(` in a file."""
    out = {}
    for m in re.finditer(r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(", text, re.I):
        name = m.group(1).lower()
        rest = text[m.end():]
        body = BODY.search(text, m.end())
        if not body:
            continue
        # only accept a body that belongs to this function: the next "create ... function" must not
        # come first
        nxt = re.search(r"create\s+(?:or\s+replace\s+)?function\s+", rest, re.I)
        if nxt and body.start() > m.end() + nxt.start():
            continue
        out.setdefault(name, []).append(skeleton(body.group(2)))
    return out


def main():
    if not ACCESS:
        print("set SUPABASE_ACCESS_TOKEN first: this check reads the live ledger")
        return 1

    files = sorted(MIGRATIONS.glob("*.sql"))
    print(f"git migration files: {len(files)}")
    by_key, by_name = {}, {}
    for path in files:
        m = re.match(r"^(\d+)_(.*)\.sql$", path.name)
        text = path.read_text(encoding="utf-8", errors="replace")
        if m:
            by_key[(m.group(1), m.group(2))] = text
        by_name[path.name] = text

    rows = sql("select version, name, statements[1] as stmt from supabase_migrations.schema_migrations order by version")
    print(f"live ledger rows: {len(rows)}")

    # ---------- 1. every live row has a file, or is carried by a differently named one ----------
    print("\n-- live ledger row -> file in git")
    missing = []
    for r in rows:
        text = by_key.get((r["version"], r["name"]))
        if text is not None:
            print(f"   ok      {r['version']}  {r['name']}  ->  {r['version']}_{r['name']}.sql")
            continue
        other = OTHER_NAMED.get((r["version"], r["name"]))
        if other is None:
            missing.append(f"{r['version']}_{r['name']}")
            print(f"   NO FILE: {r['version']}  {r['name']}")
            continue
        # The row's SQL lives in a file with another version name. That is only acceptable when the
        # two carry the very same SQL — compared on the bodies, comments and layout ignored.
        same = function_bodies(r["stmt"] or "") == function_bodies(by_name.get(other, ""))
        print(f"   ok      {r['version']}  {r['name']}  ->  {other}" + ("  (same SQL)" if same else "  (BODIES DIFFER)"))
        if not same:
            missing.append(f"{r['version']}_{r['name']} does not match {other}")
    check("every live ledger row has a file in supabase/migrations/, or is the same SQL as a differently named one",
          not missing, ", ".join(missing))

    # ---------- 2. every live function is defined, and the newest definition matches ----------
    print("\n-- live public function -> newest file that defines it")
    live = sql("""select p.proname as name, pg_get_functiondef(p.oid) as def
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' order by p.proname""")
    live_bodies = {}
    for f in live:
        m = BODY.search(f["def"])
        if m:
            live_bodies.setdefault(f["name"].lower(), set()).add(skeleton(m.group(2)))
    file_functions = {}          # name -> [(file name, [bodies])] in version order
    for name in sorted(by_name):
        for fn, bodies in function_bodies(by_name[name]).items():
            file_functions.setdefault(fn, []).append((name, bodies))
    print(f"   live public functions: {len(live)}  (distinct names: {len(live_bodies)})")
    unexplainable = []
    for name, bodies in sorted(live_bodies.items()):
        defining = file_functions.get(name)
        if not defining:
            unexplainable.append(f"{name} (no file defines it)")
            print(f"   NO FILE: {name}")
            continue
        newest_file, newest_bodies = defining[-1]
        if not bodies <= set(newest_bodies):
            unexplainable.append(f"{name} ({newest_file} differs)")
            print(f"   DIFFERS: {name}  newest file {newest_file}")
        else:
            print(f"   ok      {name}  <- {newest_file}" + (f"  (+{len(defining) - 1} older file(s))" if len(defining) > 1 else ""))
    check("every live public function is defined by a file, and the newest definition matches live",
          not unexplainable, "; ".join(unexplainable))

    # ---------- 3. files with no live ledger row, named and explained ----------
    print("\n-- files in git with no live ledger row (each must be applied-by-hand or tracked under another name)")
    orphans = [name for name in sorted(by_name)
               if (re.match(r"^(\d+)_(.*)\.sql$", name).group(1), re.match(r"^(\d+)_(.*)\.sql$", name).group(2))
               not in {(r["version"], r["name"]) for r in rows}]
    for name in orphans:
        print(f"   {name}")
    check("the files with no ledger row are the known hand-applied set from the reconciliation",
          orphans == HAND_APPLIED, f"unexpected: {sorted(set(orphans) ^ set(HAND_APPLIED))}")

    print()
    return harness.finish("ALL LIVE LEDGER CHECKS PASSED")


# Live ledger rows whose SQL is committed under another version name (measured 2026-09-30): the row
# is the historical apply, the file is the same statement text. Mapping: docs/migration-ledger-reconciliation.md.
OTHER_NAMED = {
    ("20260923112142", "v2_15_monitor_overview_fields"): "20260925000000_monitor_overview_fields.sql",
    ("20260924063427", "dashboard_activity_fields"): "20260928000000_dashboard_activity_fields.sql",
    ("20260925001719", "v2_16_audit_functions"): "20260929000000_audit_functions.sql",
}

HAND_APPLIED = [
    "20260922000000_exams_functions.sql",
    "20260923000000_session_functions.sql",
    "20260924000000_result_functions.sql",
    "20260925000000_monitor_overview_fields.sql",
    "20260926000000_security_lockdown_function_execute.sql",
    "20260927000000_exam_wide_add_time.sql",
    "20260928000000_dashboard_activity_fields.sql",
    "20260929000000_audit_functions.sql",
    "20260930000000_exam_delete_with_attempts.sql",
]

if __name__ == "__main__":
    sys.exit(main())
