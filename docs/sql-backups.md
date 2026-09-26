# SQL and Storage for backups (TASK-015)

Phase 7 asks for "Backup manual (unduh file) dan backup otomatis terjadwal" (design.md 1.4/2.5, module
"Backup/Recovery"): an admin must be able to take a copy by hand and download it, and the project must keep
taking copies on its own. The `backups` table has existed since `v2_01_foundation` and had never been used.
The free plan has **no platform backups and no point-in-time recovery** (`GET
/v1/projects/<ref>/database/backups` → `walg_enabled` true, `pitr_enabled` false, `backups: []`), so this is
an application-level backup or none at all.

The statements live in **`supabase/migrations/20260926010636_backup_functions.sql`** and are **applied live
(2026-09-26)** — recorded in `supabase_migrations.schema_migrations` as `20260926010636` /
`backup_functions` (11,535 characters, written in the same session that applied it, so no ISSUE-001 drift).
The Edge layer is **`backend/functions/backups/`**, deployed live.

Running SQL against this project: CLI 2.117.0 has **no `supabase db query` subcommand** — use the Management
API query endpoint (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{"query": "…"}`;
one request is one session) or the dashboard SQL editor. Applying a migration that way leaves no tracking
row, so the session that did it also inserted one (the pattern `docs/sql-jobs.md` describes).

## What a backup contains (the owner's decision, DEC-030)

| Kept | How |
|---|---|
| **Every table** | `public.backup_tables()` is the allowlist: 22 tables, in one place, asserted against the real catalogue by `supabase/tests/backup_functions_test.sql` (a new table fails the test until it is added on purpose). |
| **Every row**, as `data.json` | `public.build_backup_payload()` returns the whole database as one jsonb document (`{format, format_version, generated_at, migrations, tables, media}`), read through `_backup_table_rows(name)` — a dynamic read guarded by the allowlist. |
| **The media bytes** | Every file that is really attached to a question or a reading text (`media_files` joined by `question_media`), copied into the archive as `media/<path>`. An upload nobody attached is the nightly purge's business (`purge-orphan-media`), not something to archive forever. |
| **Which schema this was** | `migrations` lists every version in `supabase_migrations.schema_migrations` at the moment of the copy, so an archive can be matched to the code that produced it. |

The archive is **one file per copy**: a store-only ZIP holding `data.json` plus the media entries, stored in
the **private `backups` bucket** (50 MB limit, no public URL, reachable only through a short-lived signed
link). Name: `20260926T034100Z_manual_1a2b3c4d.zip` — sortable, says what it is, and cannot collide.
The row in `public.backups` (`kind`, `storage_path`, `size_bytes`, `created_by`, `created_at`) is the index;
if recording a row fails, the function deletes the file it just uploaded, so **a file nobody points at is
never left behind**.

Media that cannot be included is **named, not hidden**: files missing from Storage or over the 45 MB the
archive may hold are marked `included: false` with a `reason`, `media_note` says so in one sentence, and the
admin screen shows that note as a warning (`media_note` in the create response).

## Why the split is database + function

The same split as DEC-029, for the same reason: **the database can read itself, but only the Storage API can
touch bytes.** So `build_backup_payload` / `record_backup` / `list_backups` / `get_backup` / `delete_backup`
and the retention sweep are SQL, while zipping, uploading, signing and deleting files are the Edge function's
`create` / `list` / `download` / `delete` actions. The Edge function validates and calls; nothing about the
copy's contents is decided in JavaScript.

## Retention (DEC-030)

Inside `record_backup`, after the row is inserted:

```sql
with doomed as (
  select b.id, b.storage_path from public.backups b
  where b.kind = 'automatic'
  order by b.created_at desc, b.id desc offset 7
), gone as (delete from public.backups b using doomed d where b.id = d.id returning b.storage_path)
```

* The **newest 7 automatic** copies are kept — a week of nights, the owner's choice.
* **Manual copies are never swept**: they stay until an admin deletes one. They are the ones taken before an
  exam or a risky change; deleting those automatically would be the worst possible surprise.
* The rows fall out in SQL; their **files** are returned as `pruned_paths` and deleted by the Edge function,
  which is the only part that can. Pruning is audited (`backup.prune`, with the count).

## The nightly job

`cron.schedule('nightly-backup', '41 19 * * *', …)` — 02:41 Jakarta, after the two purge jobs (19:19 and
19:29 UTC), so the archive is taken from a tidied database. It is the fourth job and it reuses the
**housekeeping key** from Vault (DEC-029) over `pg_net`, so there is still exactly one machine credential:

```sql
select net.http_post(
  url := 'https://lbhnadqmokloyfarrzfv.supabase.co/functions/v1/backups',
  headers := jsonb_build_object('Content-Type','application/json',
                                'x-housekeeping-key', (select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key')),
  body := '{"action": "create", "kind": "automatic"}'::jsonb);
```

That key opens **`create` and nothing else**: the handler returns before `requireStaff`, writes
`kind = automatic` with `created_by = null`, and a wrong key, the key on `list`, or a tokenless call are all
401 (a teacher is 403 — backups are an admin job, design.md 1.2). Rotating the key is the same two-step
operation as in `docs/sql-jobs.md` (Vault + the function secret); no backup code changes.

## The admin screen

`#/backups` (menu item "Backups", admin only) lists the copies newest first with kind pill, size and who
made them, and offers **Create backup now**, **Download** (a signed link, opened as
`english-test-v2_<file>.zip`) and **Delete** (behind a confirm dialog; removes the row *and* the file). The
screen never claims a kind: the server decides `manual` (signed-in admin) or `automatic` (the job).

## How it was verified (2026-09-26)

**In git, no live project needed**

* `deno test --allow-env backend/` → **130 passed** (`backend/tests/backups.test.ts` covers the store-only
  ZIP reader/writer and CRC, a manual create with media bytes, missing media tolerated, oversized media
  skipped, pruned files deleted, the stored file removed when recording fails, the scheduled door allowing
  `create` only, admin/teacher/401 rules, and GET → 405).
* `python frontend/tests/backups_e2e.py` → **42 checks** against the mock server: menu link and
  `aria-current`, heading and counts, both kinds and both size units, the exact timestamp on each row,
  download asking the server and then opening the signed link, delete cancel/confirm, create (toast, list
  refresh, size + file count), the media-note and pruned toasts as warnings, a failed create, the empty
  state, and a teacher who is neither offered the menu item nor allowed to make a copy. CI runs it as the
  twelfth browser suite (`frontend-tests.yml`); the menu-count assertions in `teacher_e2e.py` /
  `monitor_e2e.py` went 7 → 8.

**Live**

* `supabase/tests/scheduled_jobs_test.sql` → `SCHEDULED JOBS TESTS PASSED (4 jobs active, key 64 chars,
  nothing written)`.
* `supabase/tests/backup_functions_test.sql` → `BACKUP TESTS PASSED (7 functions, 22 tables, 0 stored
  copies, nothing written)` — bucket private with the 50 MB cap, the allowlist complete against the
  catalogue and free of strangers, the payload well formed with its migration list, `list_backups` /
  `get_backup` refusing bad input, a table outside the allowlist unreadable, RLS on with **no policies**,
  and anon/authenticated unable to execute a single function or touch the table.
* `frontend/tests/live_backup_check.py` → **63/63**, `ALL LIVE BACKUP CHECKS PASSED`. In order: the job's
  configuration and the door's rules (wrong key 401, key-on-`list` 401, tokenless 401, teacher 403 on list /
  create / delete); a real 1×1 PNG uploaded through `media` and attached to a throwaway question; a manual
  copy whose **archive was downloaded through the signed link and opened with Python's `zipfile`** — exactly
  `data.json` + `media/<path>`, the picture byte-for-byte identical, every table's `counts` equal to the
  live counts taken a moment before the copy, the migration list equal to `schema_migrations`, and **the
  owner's real exam (`4KHU2A`) and its attempt inside**; eight automatic copies through the key, with the
  eighth pruning exactly one row **and its file** (Storage listed through the Storage API) while the manual
  copy survived; the job pointed at the next minute, `cron.job_run_details` **succeeded**, `net._http_response`
  **200** with a real automatic row behind it, and the schedule put back; a delete that removed row, file and
  wrote the audit entry, with deleting it twice refused; then everything deleted and the counts compared with
  the starting ones (the owner's data was never touched: 1 exam, 1 attempt, 40 questions before and after).

Live facts worth remembering: the job is id **4**; the bucket holds one file per copy and nothing else; a
copy of this database is ~91 kB before media (questions 23 kB, question_options 29 kB), so even a media-heavy
year fits in the 50 MB the bucket allows per file.

## Restoring from an archive

There is no restore button yet, and pretending otherwise would be worse than saying so. What an archive
gives you today:

1. **The data**: `data.json` → `tables` holds every table's rows exactly as Postgres returned them
   (`to_jsonb`), and `migrations` says which schema they came from. Restoring is `insert` in dependency
   order (`topics`, `passages`, `questions`, `question_options`, …) — the legacy tables are a flat structure,
   so this is a script, not an adventure.
2. **The files**: `media/<path>` entries are the exact bytes, and the manifest carries `mime_type`,
   `size_bytes` and `original_name`, so they can be uploaded back to `question-media` at the same paths.
3. **What to check first**: `format_version` (currently 1) — a future archive may be newer than the code
   reading it; and `counts`, which lets a restore verify every table came back complete.

Do the restore against a scratch project first, never straight into a live one: the archive has no
transaction log, so a half-restored database is exactly the state this feature exists to avoid.

## What is deliberately not here

* **Off-site copies.** Everything lives in the same Supabase project (and therefore the same failure domain)
  as the data it protects. A copy that leaves the project needs somewhere to go, and that is a hosting
  decision (TASK-017), not a SQL one.
* **Encryption.** The bucket is private and every read goes through a signed link, but the archive itself is
  not encrypted: the database's own RLS and the admin-only gate are the protection, exactly as for the
  tables.
* **Point-in-time recovery.** The free plan does not offer it (`pitr_enabled: false`); see DEC-030 for why a
  daily application-level copy is what this project can do.
* **A restore UI.** Restoring is a deliberate, rare, careful operation; a button that overwrites a live
  database is a feature to design with the owner, not to bolt on.
