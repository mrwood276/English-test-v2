-- Fase 2, question bank. Every write is one database function = one transaction (question, answers, labels, audit).
-- Functions are only callable by the service role (Edge Functions). Problems the person can fix raise an
-- exception with hint 'validation'; the Edge Function shows that message as-is.

create extension if not exists pg_trgm with schema extensions;
create index questions_body_trgm_idx on public.questions using gin (body extensions.gin_trgm_ops);

-- ---------- audit helper ----------
create function public.write_audit(p_actor uuid, p_action text, p_entity_type text, p_entity_id text, p_changes jsonb default '{}'::jsonb)
returns void language sql set search_path = '' as $$
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_changes, '{}'::jsonb));
$$;

-- ---------- topics ----------
create function public.upsert_topic(p_name text) returns uuid
language plpgsql set search_path = '' as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v uuid;
begin
  if n = '' then return null; end if;
  if char_length(n) > 120 then
    raise exception 'The topic name is too long (at most 120 characters).' using hint = 'validation';
  end if;
  select id into v from public.topics where public.normalize_text(name) = public.normalize_text(n);
  if v is null then
    insert into public.topics (name) values (n)
    on conflict ((public.normalize_text(name))) do nothing
    returning id into v;
    if v is null then
      select id into v from public.topics where public.normalize_text(name) = public.normalize_text(n);
    end if;
  end if;
  return v;
end $$;

-- ---------- save a question (create when p_id is null, otherwise replace) ----------
create function public.save_question(p_id uuid, p jsonb, p_actor uuid) returns uuid
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

  -- answers, by question type
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

  perform public.write_audit(p_actor, case when v_is_new then 'question.create' else 'question.update' end, 'question', v_id::text,
    jsonb_build_object('type', v_type, 'difficulty', v_diff, 'topic', p ->> 'topic', 'points', v_weight, 'class_labels', to_jsonb(label_texts)));
  return v_id;
end $$;

-- ---------- delete (if never used) or archive (if an exam used it) ----------
create function public.remove_question(p_id uuid, p_actor uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_used boolean;
  v_result text;
begin
  perform 1 from public.questions where id = p_id;
  if not found then raise exception 'That question no longer exists.' using hint = 'validation'; end if;
  v_used := exists (select 1 from public.exam_questions where question_id = p_id)
         or exists (select 1 from public.session_answers where question_id = p_id)
         or exists (select 1 from public.answer_grades where question_id = p_id);
  if v_used then
    update public.questions set is_archived = true where id = p_id;
    v_result := 'archived';
  else
    delete from public.questions where id = p_id;
    v_result := 'deleted';
  end if;
  perform public.write_audit(p_actor, 'question.' || v_result, 'question', p_id::text, '{}'::jsonb);
  return v_result;
end $$;

create function public.set_question_archived(p_id uuid, p_archived boolean, p_actor uuid) returns void
language plpgsql set search_path = '' as $$
begin
  update public.questions set is_archived = p_archived where id = p_id;
  if not found then raise exception 'That question no longer exists.' using hint = 'validation'; end if;
  perform public.write_audit(p_actor, case when p_archived then 'question.archive' else 'question.restore' end, 'question', p_id::text, '{}'::jsonb);
end $$;

-- ---------- read one question ----------
create function public.get_question(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', q.id,
    'type', q.type,
    'topic', t.name,
    'difficulty', q.difficulty,
    'passage', case when p.id is null then null else jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body) end,
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
                                                          'source', case when qm.question_id is not null then 'question' else 'passage' end, 'position', qm.position)
                                        order by qm.position)
                       from public.question_media qm join public.media_files m on m.id = qm.media_id
                       where qm.question_id = q.id or (qm.passage_id is not null and qm.passage_id = q.passage_id)), '[]'::jsonb),
    'used_in_exams', (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id),
    'created_at', q.created_at,
    'updated_at', q.updated_at
  )
  from public.questions q
  left join public.topics t on t.id = q.topic_id
  left join public.passages p on p.id = q.passage_id
  where q.id = p_id
$$;

-- ---------- list with filters and paging ----------
create function public.list_questions(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_q text := nullif(btrim(coalesce(p ->> 'q', '')), '');
  v_like text;
  v_topic text := nullif(public.normalize_text(p ->> 'topic'), '');
  v_diff text := nullif(p ->> 'difficulty', '');
  v_type text := nullif(p ->> 'type', '');
  v_label text := nullif(public.normalize_text(p ->> 'class_label'), '');
  v_archived boolean := coalesce((p ->> 'archived')::boolean, false);
  v_used text := coalesce(nullif(p ->> 'used', ''), 'any');
  v_page int := greatest(coalesce((p ->> 'page')::int, 1), 1);
  v_size int := least(greatest(coalesce((p ->> 'page_size')::int, 25), 1), 100);
  v_sort text := coalesce(nullif(p ->> 'sort', ''), 'newest');
  v_total int;
  v_items jsonb;
begin
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with filtered as (
    select q.*, t.name as topic_name,
           (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id) as used_in_exams
    from public.questions q
    left join public.topics t on t.id = q.topic_id
    where q.is_archived = v_archived
      and (v_like is null or q.body ilike v_like escape '\')
      and (v_topic is null or public.normalize_text(t.name) = v_topic)
      and (v_diff is null or q.difficulty::text = v_diff)
      and (v_type is null or q.type::text = v_type)
      and (v_label is null or exists (select 1 from public.question_class_labels l where l.question_id = q.id and l.label_normalized = v_label))
  ), usage_filtered as (
    select * from filtered
    where v_used = 'any' or (v_used = 'unused' and used_in_exams = 0) or (v_used = 'used' and used_in_exams > 0)
  ), page as (
    select f.*, row_number() over (
      order by case when v_sort = 'oldest' then f.created_at end asc,
               case when v_sort = 'difficulty' then array_position(array['easy', 'medium', 'hots'], f.difficulty::text) end asc,
               case when v_sort = 'body' then f.body end asc,
               f.created_at desc) as rn
    from usage_filtered f
    order by rn
    limit v_size offset (v_page - 1) * v_size
  )
  select (select count(*) from usage_filtered),
         coalesce((select jsonb_agg(jsonb_build_object(
             'id', pg.id, 'type', pg.type, 'body', pg.body, 'topic', pg.topic_name, 'difficulty', pg.difficulty,
             'weight', pg.default_weight,
             'class_labels', coalesce((select jsonb_agg(l.label_display order by l.label_normalized) from public.question_class_labels l where l.question_id = pg.id), '[]'::jsonb),
             'has_audio', exists (select 1 from public.question_media qm join public.media_files m on m.id = qm.media_id
                                  where m.kind = 'audio' and (qm.question_id = pg.id or (qm.passage_id is not null and qm.passage_id = pg.passage_id))),
             'has_image', exists (select 1 from public.question_media qm join public.media_files m on m.id = qm.media_id
                                  where m.kind = 'image' and (qm.question_id = pg.id or (qm.passage_id is not null and qm.passage_id = pg.passage_id))),
             'has_passage', pg.passage_id is not null,
             'used_in_exams', pg.used_in_exams, 'is_archived', pg.is_archived, 'updated_at', pg.updated_at) order by pg.rn) from page pg), '[]'::jsonb)
  into v_total, v_items;

  return jsonb_build_object('items', v_items, 'total', v_total, 'page', v_page, 'page_size', v_size);
end $$;

-- ---------- duplicate check: exact copies and questions with very similar text ----------
create function public.find_similar_questions(p_body text, p_options text[], p_exclude uuid default null, p_threshold real default 0.55)
returns jsonb language sql stable set search_path = '' as $$
  with h as (select public.question_content_hash(p_body, coalesce(p_options, '{}'::text[])) as hash)
  select coalesce(jsonb_agg(s.r order by (s.r ->> 'exact')::boolean desc, (s.r ->> 'similarity')::numeric desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'id', q.id, 'body', q.body,
             'similarity', round(extensions.similarity(q.body, p_body)::numeric, 2),
             'exact', q.content_hash = (select hash from h),
             'is_archived', q.is_archived,
             'used_in_exams', (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id)) as r
    from public.questions q
    where (p_exclude is null or q.id <> p_exclude)
      and (q.content_hash = (select hash from h) or extensions.similarity(q.body, p_body) >= p_threshold)
    order by (q.content_hash = (select hash from h)) desc, extensions.similarity(q.body, p_body) desc
    limit 5
  ) s
$$;

-- ---------- suggestions ----------
create function public.list_topics() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
           'question_count', (select count(*) from public.questions q where q.topic_id = t.id and not q.is_archived)) order by t.name), '[]'::jsonb)
  from public.topics t
$$;

create function public.list_class_labels(p_prefix text default null) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', s.label, 'question_count', s.n) order by s.n desc, s.label), '[]'::jsonb)
  from (
    select (array_agg(l.label_display order by l.label_display))[1] as label, l.label_normalized, count(*) as n
    from public.question_class_labels l
    where nullif(public.normalize_text(p_prefix), '') is null or starts_with(l.label_normalized, public.normalize_text(p_prefix))
    group by l.label_normalized
    order by count(*) desc, l.label_normalized
    limit 20
  ) s
$$;

-- ---------- reading passages ----------
create function public.save_passage(p_id uuid, p jsonb, p_actor uuid) returns uuid
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
  return v_id;
end $$;

create function public.get_passage(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body,
           'question_count', (select count(*) from public.questions q where q.passage_id = p.id),
           'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes, 'position', qm.position) order by qm.position)
                              from public.question_media qm join public.media_files m on m.id = qm.media_id where qm.passage_id = p.id), '[]'::jsonb))
  from public.passages p where p.id = p_id
$$;

create function public.list_passages(p_q text default null) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title,
           'excerpt', left(regexp_replace(p.body, '<[^>]*>', '', 'g'), 140),
           'question_count', (select count(*) from public.questions q where q.passage_id = p.id)) order by p.title), '[]'::jsonb)
  from (
    select * from public.passages
    where nullif(btrim(coalesce(p_q, '')), '') is null or title ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    order by title limit 50
  ) p
$$;

create function public.remove_passage(p_id uuid, p_actor uuid) returns void
language plpgsql set search_path = '' as $$
declare n int;
begin
  perform 1 from public.passages where id = p_id;
  if not found then raise exception 'That reading text no longer exists.' using hint = 'validation'; end if;
  select count(*) into n from public.questions where passage_id = p_id;
  if n > 0 then
    raise exception 'This reading text is used by % question(s). Remove it from them first.', n using hint = 'validation';
  end if;
  delete from public.passages where id = p_id;
  perform public.write_audit(p_actor, 'passage.delete', 'passage', p_id::text, '{}'::jsonb);
end $$;

-- ---------- only the service role may call these ----------
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
