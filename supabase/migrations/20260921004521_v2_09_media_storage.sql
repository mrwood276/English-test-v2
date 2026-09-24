-- Fase 2, images and audio for questions and reading texts.
-- Files live in a private Storage bucket. The browser uploads through a short-lived signed upload URL made by an
-- Edge Function; nothing is public and no table or storage policy is opened to the browser.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-media', 'question-media', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'])
on conflict (id) do nothing;

alter table public.media_files
  add column original_name text check (original_name is null or char_length(original_name) <= 200),
  add column duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 7200);

-- ---------- register an uploaded file ----------
create function public.register_media(p_path text, p_kind public.media_kind, p_mime text, p_size bigint, p_name text, p_duration integer, p_actor uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if p_path !~ '^(image|audio)/[0-9]{4}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp3|m4a)$' then
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

-- ---------- attach files to a question or a reading text (replaces the current list) ----------
create function public.link_media(p_owner text, p_id uuid, p_media jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  n int;
  i int;
  mid uuid;
  seen uuid[] := '{}';
begin
  if p_owner not in ('question', 'passage') then raise exception 'unknown owner type'; end if;
  if p_media is null or jsonb_typeof(p_media) = 'null' then p_media := '[]'::jsonb; end if;
  if jsonb_typeof(p_media) <> 'array' then raise exception 'The files must be a list.' using hint = 'validation'; end if;
  n := jsonb_array_length(p_media);
  if n > 4 then raise exception 'You can attach at most 4 files.' using hint = 'validation'; end if;

  if p_owner = 'question' then
    delete from public.question_media where question_id = p_id;
  else
    delete from public.question_media where passage_id = p_id;
  end if;

  for i in 0 .. n - 1 loop
    begin
      mid := (p_media -> i ->> 'id')::uuid;
    exception when others then
      raise exception 'A file id is not valid.' using hint = 'validation';
    end;
    if mid is null or mid = any (seen) then raise exception 'The same file is attached twice.' using hint = 'validation'; end if;
    if not exists (select 1 from public.media_files where id = mid) then
      raise exception 'A file no longer exists. Please upload it again.' using hint = 'validation';
    end if;
    seen := seen || mid;
    if p_owner = 'question' then
      insert into public.question_media (media_id, question_id, position) values (mid, p_id, i);
    else
      insert into public.question_media (media_id, passage_id, position) values (mid, p_id, i);
    end if;
  end loop;
end $$;

-- ---------- files nobody uses any more (uploaded but never saved, or removed) ----------
create function public.purge_orphan_media(p_older_than interval default interval '1 day') returns text[]
language plpgsql set search_path = '' as $$
declare paths text[];
begin
  with gone as (
    delete from public.media_files m
    where m.created_at < now() - p_older_than
      and not exists (select 1 from public.question_media qm where qm.media_id = m.id)
    returning m.storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into paths from gone;
  return paths;
end $$;

-- ---------- save_question, now with media ----------
create or replace function public.save_question(p_id uuid, p jsonb, p_actor uuid) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_id uuid := p_id;
  v_is_new boolean := (p_id is null);
  v_type public.question_type;
  v_diff public.difficulty_level;
  v_body text;
  v_explanation text;
  v_guidance text;
  v_weight numeric;
  v_passage uuid;
  v_topic uuid;
  v_opts jsonb := coalesce(p -> 'options', '[]'::jsonb);
  v_acc jsonb := coalesce(p -> 'accepted_answers', '[]'::jsonb);
  v_labels jsonb := coalesce(p -> 'class_labels', '[]'::jsonb);
  n_opts int;
  n_correct int := 0;
  opt_texts text[] := '{}';
  acc_texts text[] := '{}';
  label_texts text[] := '{}';
  t text;
  i int;
  v_hash text;
begin
  if jsonb_typeof(v_opts) <> 'array' or jsonb_typeof(v_acc) <> 'array' or jsonb_typeof(v_labels) <> 'array' then
    raise exception 'Answers, accepted answers, and class labels must be lists.' using hint = 'validation';
  end if;

  begin
    v_type := (p ->> 'type')::public.question_type;
  exception when others then
    raise exception 'Choose a valid question type.' using hint = 'validation';
  end;
  if v_type is null then
    raise exception 'Choose a valid question type.' using hint = 'validation';
  end if;
  begin
    v_diff := coalesce(nullif(p ->> 'difficulty', ''), 'medium')::public.difficulty_level;
  exception when others then
    raise exception 'Choose Easy, Medium, or HOTS.' using hint = 'validation';
  end;

  v_body := btrim(coalesce(p ->> 'body', ''));
  if v_body = '' then raise exception 'The question text is required.' using hint = 'validation'; end if;
  if char_length(v_body) > 5000 then raise exception 'The question text is too long (at most 5000 characters).' using hint = 'validation'; end if;
  v_explanation := nullif(btrim(coalesce(p ->> 'explanation', '')), '');
  if char_length(coalesce(v_explanation, '')) > 5000 then raise exception 'The explanation is too long (at most 5000 characters).' using hint = 'validation'; end if;
  v_guidance := case when v_type = 'essay' then nullif(btrim(coalesce(p ->> 'essay_guidance', '')), '') else null end;
  if char_length(coalesce(v_guidance, '')) > 5000 then raise exception 'The grading guide is too long (at most 5000 characters).' using hint = 'validation'; end if;

  begin
    v_weight := coalesce(nullif(p ->> 'weight', '')::numeric, 1);
  exception when others then
    raise exception 'Points must be a number.' using hint = 'validation';
  end;
  if v_weight <= 0 or v_weight > 100 then raise exception 'Points must be more than 0 and at most 100.' using hint = 'validation'; end if;

  begin
    v_passage := nullif(p ->> 'passage_id', '')::uuid;
  exception when others then
    raise exception 'The reading text is not valid.' using hint = 'validation';
  end;
  if v_passage is not null and not exists (select 1 from public.passages where id = v_passage) then
    raise exception 'That reading text no longer exists.' using hint = 'validation';
  end if;

  n_opts := jsonb_array_length(v_opts);
  if v_type = 'multiple_choice' and (n_opts < 2 or n_opts > 6) then
    raise exception 'Multiple choice needs between 2 and 6 answers.' using hint = 'validation';
  elsif v_type = 'true_false' and n_opts <> 2 then
    raise exception 'True or false needs exactly 2 answers.' using hint = 'validation';
  elsif v_type in ('short_answer', 'essay') and n_opts <> 0 then
    raise exception 'This question type does not have answer choices.' using hint = 'validation';
  end if;

  for i in 0 .. n_opts - 1 loop
    t := btrim(coalesce(v_opts -> i ->> 'body', ''));
    if t = '' then raise exception 'Every answer needs text.' using hint = 'validation'; end if;
    if char_length(t) > 1000 then raise exception 'An answer is too long (at most 1000 characters).' using hint = 'validation'; end if;
    if coalesce((v_opts -> i ->> 'is_correct')::boolean, false) then n_correct := n_correct + 1; end if;
    opt_texts := opt_texts || t;
  end loop;
  if n_opts > 0 and n_correct <> 1 then raise exception 'Choose exactly one correct answer.' using hint = 'validation'; end if;
  if n_opts > 0 and (select count(distinct public.normalize_text(x)) from unnest(opt_texts) as x) <> n_opts then
    raise exception 'Two answers are the same. Each answer must be different.' using hint = 'validation';
  end if;

  if v_type = 'short_answer' then
    if jsonb_array_length(v_acc) < 1 or jsonb_array_length(v_acc) > 10 then
      raise exception 'Add between 1 and 10 accepted answers.' using hint = 'validation';
    end if;
    for i in 0 .. jsonb_array_length(v_acc) - 1 loop
      t := btrim(coalesce(v_acc ->> i, ''));
      if t = '' then raise exception 'An accepted answer is empty.' using hint = 'validation'; end if;
      if char_length(t) > 300 then raise exception 'An accepted answer is too long (at most 300 characters).' using hint = 'validation'; end if;
      acc_texts := acc_texts || t;
    end loop;
    if (select count(distinct public.normalize_text(x)) from unnest(acc_texts) as x) <> array_length(acc_texts, 1) then
      raise exception 'Two accepted answers are the same.' using hint = 'validation';
    end if;
  elsif jsonb_array_length(v_acc) <> 0 then
    raise exception 'Accepted answers are only for short answer questions.' using hint = 'validation';
  end if;

  if jsonb_array_length(v_labels) > 10 then raise exception 'A question can have at most 10 class labels.' using hint = 'validation'; end if;
  for i in 0 .. jsonb_array_length(v_labels) - 1 loop
    t := btrim(regexp_replace(coalesce(v_labels ->> i, ''), '\s+', ' ', 'g'));
    if t = '' then continue; end if;
    if char_length(t) > 40 then raise exception 'A class label is too long (at most 40 characters).' using hint = 'validation'; end if;
    label_texts := label_texts || t;
  end loop;

  v_topic := public.upsert_topic(p ->> 'topic');
  v_hash := public.question_content_hash(v_body, case when v_type = 'short_answer' then acc_texts else opt_texts end);

  if v_is_new then
    insert into public.questions (type, topic_id, difficulty, passage_id, body, explanation, default_weight, essay_guidance, content_hash, created_by)
    values (v_type, v_topic, v_diff, v_passage, v_body, v_explanation, v_weight, v_guidance, v_hash, p_actor)
    returning id into v_id;
  else
    update public.questions
       set type = v_type, topic_id = v_topic, difficulty = v_diff, passage_id = v_passage, body = v_body,
           explanation = v_explanation, default_weight = v_weight, essay_guidance = v_guidance, content_hash = v_hash
     where id = v_id;
    if not found then raise exception 'That question no longer exists.' using hint = 'validation'; end if;
    delete from public.question_options where question_id = v_id;
    delete from public.accepted_answers where question_id = v_id;
    delete from public.question_class_labels where question_id = v_id;
  end if;

  for i in 1 .. n_opts loop
    insert into public.question_options (question_id, position, body, is_correct)
    values (v_id, i, opt_texts[i], coalesce((v_opts -> (i - 1) ->> 'is_correct')::boolean, false));
  end loop;
  foreach t in array acc_texts loop
    insert into public.accepted_answers (question_id, answer_text) values (v_id, t);
  end loop;
  foreach t in array label_texts loop
    insert into public.question_class_labels (question_id, label_display) values (v_id, t) on conflict do nothing;
  end loop;

  -- files: only when the caller sends the list (an absent list leaves the current files alone)
  if p ? 'media' then
    perform public.link_media('question', v_id, p -> 'media');
  end if;

  perform public.write_audit(p_actor, case when v_is_new then 'question.create' else 'question.update' end, 'question', v_id::text,
    jsonb_build_object('type', v_type, 'difficulty', v_diff, 'topic', p ->> 'topic', 'points', v_weight, 'class_labels', to_jsonb(label_texts),
                       'files', case when p ? 'media' then jsonb_array_length(coalesce(p -> 'media', '[]'::jsonb)) else null end));
  return v_id;
end $$;

-- ---------- save_passage, now with media ----------
create or replace function public.save_passage(p_id uuid, p jsonb, p_actor uuid) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_id uuid := p_id;
  v_title text := btrim(coalesce(p ->> 'title', ''));
  v_body text := btrim(coalesce(p ->> 'body', ''));
begin
  if v_title = '' then raise exception 'The reading text needs a title.' using hint = 'validation'; end if;
  if char_length(v_title) > 200 then raise exception 'The title is too long (at most 200 characters).' using hint = 'validation'; end if;
  if v_body = '' then raise exception 'The reading text is empty.' using hint = 'validation'; end if;
  if char_length(v_body) > 20000 then raise exception 'The reading text is too long (at most 20000 characters).' using hint = 'validation'; end if;
  if v_id is null then
    insert into public.passages (title, body, created_by) values (v_title, v_body, p_actor) returning id into v_id;
    perform public.write_audit(p_actor, 'passage.create', 'passage', v_id::text, jsonb_build_object('title', v_title));
  else
    update public.passages set title = v_title, body = v_body where id = v_id;
    if not found then raise exception 'That reading text no longer exists.' using hint = 'validation'; end if;
    perform public.write_audit(p_actor, 'passage.update', 'passage', v_id::text, jsonb_build_object('title', v_title));
  end if;
  if p ? 'media' then
    perform public.link_media('passage', v_id, p -> 'media');
  end if;
  return v_id;
end $$;

-- ---------- reads now return file names and lengths ----------
create or replace function public.get_passage(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body,
           'question_count', (select count(*) from public.questions q where q.passage_id = p.id),
           'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
                                                                  'name', m.original_name, 'duration_seconds', m.duration_seconds, 'position', qm.position) order by qm.position)
                              from public.question_media qm join public.media_files m on m.id = qm.media_id where qm.passage_id = p.id), '[]'::jsonb))
  from public.passages p where p.id = p_id
$$;

create or replace function public.get_question(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', q.id,
    'type', q.type,
    'topic', t.name,
    'difficulty', q.difficulty,
    'passage', case when p.id is null then null else jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body,
      'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
                                                              'name', m.original_name, 'duration_seconds', m.duration_seconds, 'position', pm.position) order by pm.position)
                         from public.question_media pm join public.media_files m on m.id = pm.media_id where pm.passage_id = p.id), '[]'::jsonb)) end,
    'body', q.body,
    'explanation', q.explanation,
    'weight', q.default_weight,
    'essay_guidance', q.essay_guidance,
    'is_archived', q.is_archived,
    'options', coalesce((select jsonb_agg(jsonb_build_object('position', o.position, 'body', o.body, 'is_correct', o.is_correct) order by o.position)
                         from public.question_options o where o.question_id = q.id), '[]'::jsonb),
    'accepted_answers', coalesce((select jsonb_agg(a.answer_text order by a.answer_text) from public.accepted_answers a where a.question_id = q.id), '[]'::jsonb),
    'class_labels', coalesce((select jsonb_agg(l.label_display order by l.label_normalized) from public.question_class_labels l where l.question_id = q.id), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
                                                          'name', m.original_name, 'duration_seconds', m.duration_seconds, 'position', qm.position)
                                        order by qm.position)
                       from public.question_media qm join public.media_files m on m.id = qm.media_id
                       where qm.question_id = q.id), '[]'::jsonb),
    'used_in_exams', (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id),
    'created_at', q.created_at,
    'updated_at', q.updated_at
  )
  from public.questions q
  left join public.topics t on t.id = q.topic_id
  left join public.passages p on p.id = q.passage_id
  where q.id = p_id
$$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute 'revoke execute on function ' || r.sig || ' from public, anon, authenticated';
  end loop;
end $$;
