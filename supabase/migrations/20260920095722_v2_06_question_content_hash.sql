-- One rule for exact-duplicate detection, shared by the migration and the app:
-- ignore letter case, extra spaces, and the order of the answer options.
create function public.question_content_hash(p_body text, p_options text[]) returns text
language sql immutable set search_path = '' as $$
  select encode(
    sha256(convert_to(
      public.normalize_text(p_body) || E'\n' ||
      coalesce((select string_agg(public.normalize_text(o), E'\n' order by public.normalize_text(o)) from unnest(p_options) as o), ''),
      'UTF8')),
    'hex')
$$;

revoke execute on function public.question_content_hash(text, text[]) from public, anon, authenticated;
