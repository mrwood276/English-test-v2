#!/usr/bin/env python3
"""Mirrors backend/functions into supabase/functions for CLI deploys.

The repository keeps the Edge Function sources under backend/functions/<name>/ plus the
shared library backend/functions/_shared/. The Supabase CLI, however, expects the layout
supabase/functions/<name>/ (entrypoint supabase/functions/<name>/index.ts). Run this
script, then deploy, for example:

    python backend/sync_functions.py
    npx supabase functions deploy exams --no-verify-jwt --use-api

supabase/functions/ is gitignored — it is a deploy artifact, backend/functions is the
source of truth. Delete the folder any time; the next sync recreates it.
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend" / "functions"
DST = ROOT / "supabase" / "functions"

if DST.exists():
    shutil.rmtree(DST)
DST.mkdir(parents=True)
for item in SRC.iterdir():
    if item.is_dir():
        shutil.copytree(item, DST / item.name)
print(f"synced {', '.join(sorted(p.name for p in DST.iterdir()))} -> {DST}")
