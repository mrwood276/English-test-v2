-- Locations of uploaded files, for making short-lived viewing links.
create function public.get_media_paths(p_ids uuid[]) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'path', m.storage_path, 'kind', m.kind)), '[]'::jsonb)
  from public.media_files m where m.id = any (p_ids)
$$;
revoke execute on function public.get_media_paths(uuid[]) from public, anon, authenticated;
