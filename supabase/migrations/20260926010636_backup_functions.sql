-- TASK-015 (backups): the data half of "Backup manual (unduh file) dan backup otomatis terjadwal"
-- (design.md 1.4, 2.1). The `backups` table has existed since v2_01 and had never been used.
--
-- Division of labour (the same split as the media archive, DEC-029): the database *reads itself* — this
-- file builds the payload and keeps the `backups` table honest (who, when, how big, retention) — while the
-- Edge layer is the only part that touches Storage, because bytes need the Storage API:
--   * public.build_backup_payload() — the whole database as one jsonb document (every table + the media
--     manifest), read-only;
--   * public.record_backup(...)     — inserts the row, writes the audit entry, prunes automatic copies
--     beyond the newest 7, and returns their storage paths for the Edge layer to delete;
--   * public.list_backups(...)      — the admin screen's list;
--   * public.get_backup(id)         — one row, so a download can find its file;
--   * public.delete_backup(...)     — removes one row and returns its path.
-- The Edge function `backups` zips the payload plus the attached picture/audio bytes and stores ONE file
-- per backup in the new private `backups` bucket — one row, one file, matching `backups.storage_path`.
-- A signed-in admin creates manual copies; the nightly job below creates automatic ones (housekeeping key).
--
-- APPLIED LIVE (2026-09-26); the live migration-tracking row is `20260926010636` / `backup_functions`.
-- To run SQL here: CLI 2.117.0 has no `supabase db query` subcommand — use the Management API query
-- endpoint (POST /v1/projects/<ref>/database/query with {"query": "..."}) or the dashboard SQL editor.

insert into storage.buckets (id, name, public, file_size_limit)
values ('backups', 'backups', false, 52428800)
on conflict (id) do nothing;

-- ---------- what a backup contains ----------
-- The allowlist is the contract: a backup that suddenly contains a new table (or loses one) is a decision,
-- not an accident, and it is the same list `_backup_table_rows` will read through.
create or replace function public.backup_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'app_settings', 'class_aliases', 'topics', 'passages', 'questions', 'question_options',
    'accepted_answers', 'question_class_labels', 'media_files', 'question_media', 'exams',
    'exam_questions', 'exam_sessions', 'session_answers', 'answer_grades', 'exam_results',
    'session_events', 'retake_permissions', 'profiles', 'audit_logs', 'backups', 'rate_limits'
  ]::text[]
$$;

create or replace function public._backup_table_rows(p_table text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb;
begin
  -- %I quotes the name and the allowlist makes it impossible to read anything else, so the dynamic read
  -- is safe by construction (and lets the list above stay the single definition of a backup's contents).
  if not (p_table = any (public.backup_tables())) then
    raise exception 'There is no table named % in a backup.', p_table using hint = 'validation';
  end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', p_table) into v_rows;
  return v_rows;
end $$;

create or replace function public.build_backup_payload() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tables jsonb := '{}'::jsonb;
  v_name text;
begin
  foreach v_name in array public.backup_tables() loop
    v_tables := v_tables || jsonb_build_object(v_name, public._backup_table_rows(v_name));
  end loop;

  return jsonb_build_object(
    'format', 'english-test-v2.backup',
    'format_version', 1,
    'generated_at', now(),
    -- The schema itself comes from the migrations in git; recording which ones were applied makes it
    -- possible to tell, later, which database this archive came out of.
    'migrations', (
      select coalesce(jsonb_agg(m.version order by m.version), '[]'::jsonb)
      from supabase_migrations.schema_migrations m
    ),
    'tables', v_tables,
    -- Only files that are really attached to a question or a reading text: an upload nobody attached is
    -- the nightly purge's business (`purge-orphan-media`), not something to archive forever.
    'media', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', f.id, 'path', f.storage_path, 'kind', f.kind, 'mime_type', f.mime_type,
               'size_bytes', f.size_bytes, 'original_name', f.original_name,
               'duration_seconds', f.duration_seconds) order by f.created_at), '[]'::jsonb)
      from public.media_files f
      where exists (select 1 from public.question_media qm where qm.media_id = f.id)
    )
  );
end $$;

-- ---------- recording one backup, and retention ----------
create or replace function public.record_backup(
  p_kind public.backup_kind,
  p_storage_path text,
  p_size_bytes bigint,
  p_actor uuid default null,
  p_summary jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_created timestamptz;
  v_pruned text[];
begin
  if p_kind is null then
    raise exception 'A backup needs a kind (manual or automatic).' using hint = 'validation';
  end if;
  if p_storage_path is null or length(btrim(p_storage_path)) = 0 then
    raise exception 'A backup needs the path of the file that was stored.' using hint = 'validation';
  end if;
  if p_size_bytes is not null and p_size_bytes < 0 then
    raise exception 'A backup size cannot be negative.' using hint = 'validation';
  end if;
  if p_actor is not null and not exists (select 1 from public.profiles where id = p_actor) then
    raise exception 'That account no longer exists.' using hint = 'validation';
  end if;

  insert into public.backups (kind, storage_path, size_bytes, created_by)
  values (p_kind, p_storage_path, p_size_bytes, p_actor)
  returning id, created_at into v_id, v_created;

  perform public.write_audit(
    p_actor, 'backup.create', 'backup', v_id::text,
    jsonb_build_object('kind', p_kind, 'size_bytes', p_size_bytes, 'storage_path', p_storage_path)
      || coalesce(p_summary, '{}'::jsonb)
  );

  -- Retention (owner's decision, DEC-030): the newest 7 automatic copies are kept and every manual one
  -- until an admin deletes it. The rows go here; the Edge layer deletes the files with the paths below,
  -- because only the Storage API can remove bytes.
  with doomed as (
    select b.id, b.storage_path
    from public.backups b
    where b.kind = 'automatic'
    order by b.created_at desc, b.id desc
    offset 7
  ), gone as (
    delete from public.backups b using doomed d
    where b.id = d.id
    returning b.storage_path
  )
  select coalesce(array_agg(g.storage_path), '{}'::text[]) into v_pruned from gone g;

  if coalesce(array_length(v_pruned, 1), 0) > 0 then
    perform public.write_audit(
      p_actor, 'backup.prune', 'backup', v_id::text,
      jsonb_build_object('removed', array_length(v_pruned, 1))
    );
  end if;

  return jsonb_build_object(
    'id', v_id,
    'kind', p_kind,
    'created_at', v_created,
    'storage_path', p_storage_path,
    'size_bytes', p_size_bytes,
    'pruned_paths', v_pruned
  );
end $$;

-- ---------- the admin screen's reads and its delete ----------
create or replace function public.list_backups(p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int := coalesce(p_limit, 50);
  v_offset int := coalesce(p_offset, 0);
begin
  if v_limit < 1 or v_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;
  if v_offset < 0 then
    raise exception 'Offset cannot be negative.' using hint = 'validation';
  end if;

  return jsonb_build_object(
    'total', (select count(*) from public.backups),
    'rows', coalesce((
      select jsonb_agg(page.row_json order by page.created_at desc, page.id desc)
      from (
        select jsonb_build_object(
                 'id', b.id,
                 'kind', b.kind,
                 'storage_path', b.storage_path,
                 'size_bytes', b.size_bytes,
                 'created_by', b.created_by,
                 'created_by_name', p.full_name,
                 'created_at', b.created_at
               ) as row_json,
               b.created_at, b.id
        from public.backups b
        left join public.profiles p on p.id = b.created_by
        order by b.created_at desc, b.id desc
        limit v_limit offset v_offset
      ) page), '[]'::jsonb)
  );
end $$;

create or replace function public.get_backup(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_row jsonb;
begin
  if p_id is null then
    raise exception 'A backup id is required.' using hint = 'validation';
  end if;
  select jsonb_build_object(
           'id', b.id, 'kind', b.kind, 'storage_path', b.storage_path, 'size_bytes', b.size_bytes,
           'created_by', b.created_by, 'created_at', b.created_at)
    into v_row
  from public.backups b
  where b.id = p_id;

  if v_row is null then
    raise exception 'That backup no longer exists.' using hint = 'validation';
  end if;
  return v_row;
end $$;

create or replace function public.delete_backup(p_id uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  if p_id is null then
    raise exception 'A backup id is required.' using hint = 'validation';
  end if;

  delete from public.backups b where b.id = p_id returning b.storage_path into v_path;
  if v_path is null then
    raise exception 'That backup no longer exists.' using hint = 'validation';
  end if;

  perform public.write_audit(p_actor, 'backup.delete', 'backup', p_id::text,
    jsonb_build_object('storage_path', v_path));
  return jsonb_build_object('id', p_id, 'storage_path', v_path);
end $$;

revoke execute on function public.backup_tables() from public, anon, authenticated;
revoke execute on function public._backup_table_rows(text) from public, anon, authenticated;
revoke execute on function public.build_backup_payload() from public, anon, authenticated;
revoke execute on function public.record_backup(public.backup_kind, text, bigint, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.list_backups(int, int) from public, anon, authenticated;
revoke execute on function public.get_backup(uuid) from public, anon, authenticated;
revoke execute on function public.delete_backup(uuid, uuid) from public, anon, authenticated;

-- ---------- the nightly copy ----------
-- 02:41 Jakarta, after the two purge jobs (19:19 and 19:29 UTC), so the archive is taken from a tidied
-- database. It calls the deployed function with the same housekeeping key the media sweep uses (DEC-029);
-- that key may create automatic copies and nothing else.
select cron.schedule(
  'nightly-backup',
  '41 19 * * *',
  $job$
  select net.http_post(
    url := 'https://lbhnadqmokloyfarrzfv.supabase.co/functions/v1/backups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-housekeeping-key', (select decrypted_secret from vault.decrypted_secrets where name = 'housekeeping_key')
    ),
    body := '{"action": "create", "kind": "automatic"}'::jsonb
  );
  $job$
)
where not exists (select 1 from cron.job where jobname = 'nightly-backup');
