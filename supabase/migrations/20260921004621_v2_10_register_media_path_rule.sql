-- The file extension must fit the kind: images are jpg/png/webp, audio is mp3/m4a.
create or replace function public.register_media(p_path text, p_kind public.media_kind, p_mime text, p_size bigint, p_name text, p_duration integer, p_actor uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if p_path !~ '^(image/[0-9]{4}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)|audio/[0-9]{4}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|m4a))$' then
    raise exception 'The file location is not valid.' using hint = 'validation';
  end if;
  if split_part(p_path, '/', 1) <> p_kind::text then
    raise exception 'The file type does not match its location.' using hint = 'validation';
  end if;
  if p_kind = 'image' and (p_size > 1500000 or p_mime not in ('image/jpeg', 'image/png', 'image/webp')) then
    raise exception 'Images must be JPG, PNG, or WebP and about 1 MB or smaller.' using hint = 'validation';
  end if;
  if p_kind = 'audio' and (p_size > 10485760 or p_mime not in ('audio/mpeg', 'audio/mp4', 'audio/x-m4a')) then
    raise exception 'Audio must be MP3 or M4A and at most 10 MB.' using hint = 'validation';
  end if;
  insert into public.media_files (kind, storage_path, mime_type, size_bytes, uploaded_by, original_name, duration_seconds)
  values (p_kind, p_path, p_mime, p_size, p_actor, nullif(btrim(p_name), ''), p_duration)
  returning id into v_id;
  perform public.write_audit(p_actor, 'media.upload', 'media', v_id::text, jsonb_build_object('kind', p_kind, 'size_bytes', p_size));
  return v_id;
end $$;
revoke execute on function public.register_media(text, public.media_kind, text, bigint, text, integer, uuid) from public, anon, authenticated;
