-- Fix: collapse all whitespace first, then trim, so "abc\n" and "abc" normalize to the same text
-- (the previous version trimmed first and could leave a trailing space).
create or replace function public.normalize_text(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')))
$$;

-- Make option ordering independent of the database locale ("C" = byte order), so the app can reproduce the same hash.
create or replace function public.question_content_hash(p_body text, p_options text[]) returns text
language sql immutable set search_path = '' as $$
  select encode(
    sha256(convert_to(
      public.normalize_text(p_body) || E'\n' ||
      coalesce((select string_agg(public.normalize_text(o), E'\n' order by public.normalize_text(o) collate "C") from unnest(p_options) as o), ''),
      'UTF8')),
    'hex')
$$;

-- Recompute the hashes of the migrated questions with the final rule.
update public.questions q
set content_hash = public.question_content_hash(
  q.body,
  (select array_agg(o.body order by o.position) from public.question_options o where o.question_id = q.id)
);
reindex index public.topics_name_unique;

-- Atomic counter used to limit join attempts and exam-code guesses.
create function public.rate_limit_hit(p_bucket text, p_key text, p_window_seconds integer) returns integer
language plpgsql set search_path = '' as $$
declare
  w timestamptz;
  h integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'window must be positive';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (bucket, key, window_start, hits)
  values (p_bucket, p_key, w, 1)
  on conflict (bucket, key, window_start) do update set hits = r.hits + 1
  returning r.hits into h;
  return h;
end $$;

create function public.purge_rate_limits(p_older_than interval default interval '1 day') returns integer
language plpgsql set search_path = '' as $$
declare n integer;
begin
  delete from public.rate_limits where window_start < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.normalize_text(text) from public, anon, authenticated;
revoke execute on function public.question_content_hash(text, text[]) from public, anon, authenticated;
revoke execute on function public.rate_limit_hit(text, text, integer) from public, anon, authenticated;
revoke execute on function public.purge_rate_limits(interval) from public, anon, authenticated;
