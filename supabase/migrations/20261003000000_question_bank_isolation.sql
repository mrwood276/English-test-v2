-- TASK-048 (2026-10-03): teacher data isolation — the question bank slice (DEC-041).
--
-- Until now every question-bank function checked the ROLE of the caller (requireStaff in the Edge
-- function) and never the OWNERSHIP of the rows: `created_by` was recorded on questions and passages
-- but never used as a filter, so teacher A could read, edit, archive, bulk-change and delete teacher
-- B's questions, and read B's reading texts. The owner chose the strict model (DEC-041): a teacher
-- sees and changes only their own questions and passages; an admin sees the whole school; students
-- are untouched (they join by exam code and never touch this domain).
--
-- What changes:
--   * new helper `public._is_staff_admin(p_actor)` — true only for an active admin profile, the same
--     rule `_require_active_admin` (accounts, DEC-031) already enforces, as a boolean. The admin
--     bypass lives in SQL, so it holds for any future caller, not just today's Edge function.
--   * every read function gains a required `p_actor` and scopes its rows to
--     `_is_staff_admin(p_actor) or created_by = p_actor`: get_question, list_questions,
--     find_similar_questions, find_similar_batch, find_duplicate_groups, list_topics,
--     list_class_labels, list_passages, get_passage. A null or foreign actor fails closed: an empty
--     result or the same "no longer exists" sentence a missing row gets, so nothing leaks existence.
--   * every write function keeps its signature (they already carry `p_actor`) and gains the same
--     ownership condition on the update/delete path: save_question (update + the passage it points
--     at), remove_question, set_question_archived, save_passage, remove_passage,
--     bulk_update_questions (foreign ids count as missing, like ids a student's cron purged),
--     import_questions (a reading text is matched only against the actor's own).
--   * list_topics and list_class_labels stay a shared taxonomy (one school, one topic list), but
--     their question counts now count only the actor's own questions. list_class_labels also counts
--     only non-archived questions now, matching what list_topics always did.
-- The old signatures are dropped: keeping them would leave unscoped functions behind.
--
-- APPLIED LIVE: 2026-10-03 as ONE Management API request with its ledger row (version
-- `20261003000000`, name `question_bank_isolation`); `supabase/tests/question_bank_isolation_test.sql`
-- passed live against it, and the `question-bank` Edge Function was redeployed immediately after the
-- apply so the deployed handler gained the new `p_actor` arguments. Existing data needed no repair:
-- every row already carried its true `created_by`.

-- ============ who is an admin (the bypass) ============
create or replace function public._is_staff_admin(p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'admin' and p.is_active)
$$;

-- ============ save a question (create when p_id is null, otherwise replace) ============
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
  if v_passage is not null and not exists (
       select 1 from public.passages
        where id = v_passage
          and (public._is_staff_admin(p_actor) or created_by = p_actor)) then
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
     where id = v_id
       and (public._is_staff_admin(p_actor) or created_by = p_actor);
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

-- ============ delete (if never used) or archive (if an exam used it) ============
create or replace function public.remove_question(p_id uuid, p_actor uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_used boolean;
  v_result text;
begin
  perform 1 from public.questions
    where id = p_id
      and (public._is_staff_admin(p_actor) or created_by = p_actor);
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

create or replace function public.set_question_archived(p_id uuid, p_archived boolean, p_actor uuid) returns void
language plpgsql set search_path = '' as $$
begin
  update public.questions set is_archived = p_archived
    where id = p_id
      and (public._is_staff_admin(p_actor) or created_by = p_actor);
  if not found then raise exception 'That question no longer exists.' using hint = 'validation'; end if;
  perform public.write_audit(p_actor, case when p_archived then 'question.archive' else 'question.restore' end, 'question', p_id::text, '{}'::jsonb);
end $$;

-- ============ read one question ============
create or replace function public.get_question(p_id uuid, p_actor uuid) returns jsonb
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
    and (public._is_staff_admin(p_actor) or q.created_by = p_actor)
$$;

-- ============ list with filters and paging ============
create or replace function public.list_questions(p jsonb, p_actor uuid) returns jsonb
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
      and (public._is_staff_admin(p_actor) or q.created_by = p_actor)
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

-- ============ duplicate check: exact copies and questions with very similar text ============
create or replace function public.find_similar_questions(p_body text, p_options text[], p_exclude uuid, p_threshold real, p_actor uuid)
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
    where (public._is_staff_admin(p_actor) or q.created_by = p_actor)
      and (p_exclude is null or q.id <> p_exclude)
      and (q.content_hash = (select hash from h) or extensions.similarity(q.body, p_body) >= p_threshold)
    order by (q.content_hash = (select hash from h)) desc, extensions.similarity(q.body, p_body) desc
    limit 5
  ) s
$$;

-- ============ suggestions ============
create or replace function public.list_topics(p_actor uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
           'question_count', (select count(*) from public.questions q
                               where q.topic_id = t.id and not q.is_archived
                                 and (public._is_staff_admin(p_actor) or q.created_by = p_actor))) order by t.name), '[]'::jsonb)
  from public.topics t
$$;

create or replace function public.list_class_labels(p_prefix text, p_actor uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', s.label, 'question_count', s.n) order by s.n desc, s.label), '[]'::jsonb)
  from (
    select (array_agg(l.label_display order by l.label_display))[1] as label, l.label_normalized, count(*) as n
    from public.question_class_labels l
    join public.questions q on q.id = l.question_id and not q.is_archived
                            and (public._is_staff_admin(p_actor) or q.created_by = p_actor)
    where nullif(public.normalize_text(p_prefix), '') is null or starts_with(l.label_normalized, public.normalize_text(p_prefix))
    group by l.label_normalized
    order by count(*) desc, l.label_normalized
    limit 20
  ) s
$$;

-- ============ reading passages ============
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
    update public.passages set title = v_title, body = v_body
      where id = v_id
        and (public._is_staff_admin(p_actor) or created_by = p_actor);
    if not found then raise exception 'That reading text no longer exists.' using hint = 'validation'; end if;
    perform public.write_audit(p_actor, 'passage.update', 'passage', v_id::text, jsonb_build_object('title', v_title));
  end if;
  return v_id;
end $$;

create or replace function public.get_passage(p_id uuid, p_actor uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'title', p.title, 'body', p.body,
           'question_count', (select count(*) from public.questions q where q.passage_id = p.id),
           'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes, 'position', qm.position) order by qm.position)
                              from public.question_media qm join public.media_files m on m.id = qm.media_id where qm.passage_id = p.id), '[]'::jsonb))
  from public.passages p
  where p.id = p_id
    and (public._is_staff_admin(p_actor) or p.created_by = p_actor)
$$;

create or replace function public.list_passages(p_q text, p_actor uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title,
           'excerpt', left(regexp_replace(p.body, '<[^>]*>', '', 'g'), 140),
           'question_count', (select count(*) from public.questions q where q.passage_id = p.id)) order by p.title), '[]'::jsonb)
  from (
    select * from public.passages
    where (public._is_staff_admin(p_actor) or created_by = p_actor)
      and (nullif(btrim(coalesce(p_q, '')), '') is null or title ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\')
    order by title limit 50
  ) p
$$;

create or replace function public.remove_passage(p_id uuid, p_actor uuid) returns void
language plpgsql set search_path = '' as $$
declare n int;
begin
  perform 1 from public.passages
    where id = p_id
      and (public._is_staff_admin(p_actor) or created_by = p_actor);
  if not found then raise exception 'That reading text no longer exists.' using hint = 'validation'; end if;
  select count(*) into n from public.questions where passage_id = p_id;
  if n > 0 then
    raise exception 'This reading text is used by % question(s). Remove it from them first.', n using hint = 'validation';
  end if;
  delete from public.passages where id = p_id;
  perform public.write_audit(p_actor, 'passage.delete', 'passage', p_id::text, '{}'::jsonb);
end $$;

-- ============ import: same question rules, but a reading text matches only the actor's own ============
create or replace function public.import_questions(p_items jsonb, p_actor uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  n int;
  i int;
  item jsonb;
  payload jsonb;
  v_passage uuid;
  v_title text;
  v_body text;
  qid uuid;
  ids uuid[] := '{}';
  passages_created int := 0;
  row_no text;
  msg text;
  hnt text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The list of questions is not valid.' using hint = 'validation';
  end if;
  n := jsonb_array_length(p_items);
  if n = 0 then raise exception 'There is nothing to import.' using hint = 'validation'; end if;
  if n > 200 then raise exception 'Import at most 200 questions at a time.' using hint = 'validation'; end if;

  for i in 0 .. n - 1 loop
    item := p_items -> i;
    row_no := coalesce(item ->> 'row', (i + 1)::text);
    begin
      payload := (item - 'row') - 'passage';
      if jsonb_typeof(item -> 'passage') = 'object' then
        v_title := btrim(coalesce(item -> 'passage' ->> 'title', ''));
        v_body := btrim(coalesce(item -> 'passage' ->> 'body', ''));
        select id into v_passage from public.passages
         where public.normalize_text(title) = public.normalize_text(v_title)
           and (public._is_staff_admin(p_actor) or created_by = p_actor)
         order by created_at limit 1;
        if v_passage is null then
          if v_body = '' then
            raise exception 'The reading text "%" does not exist yet. Add its text too.', v_title using hint = 'validation';
          end if;
          v_passage := public.save_passage(null, jsonb_build_object('title', v_title, 'body', v_body), p_actor);
          passages_created := passages_created + 1;
        end if;
        payload := payload || jsonb_build_object('passage_id', v_passage);
      end if;
      qid := public.save_question(null, payload, p_actor);
      ids := ids || qid;
    exception when others then
      get stacked diagnostics msg = message_text, hnt = pg_exception_hint;
      if hnt = 'validation' then
        raise exception 'Row %: %', row_no, msg using hint = 'validation';
      end if;
      raise;
    end;
  end loop;

  perform public.write_audit(p_actor, 'question.import', 'question', null, jsonb_build_object('count', n, 'passages_created', passages_created));
  return jsonb_build_object('created', n, 'passages_created', passages_created, 'ids', to_jsonb(ids));
end $$;

create or replace function public.find_similar_batch(p_items jsonb, p_threshold real, p_actor uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  n int;
  i int;
  item jsonb;
  opts text[];
  found jsonb;
  result jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The list of questions is not valid.' using hint = 'validation';
  end if;
  n := jsonb_array_length(p_items);
  if n > 200 then raise exception 'Check at most 200 questions at a time.' using hint = 'validation'; end if;
  for i in 0 .. n - 1 loop
    item := p_items -> i;
    select coalesce(array_agg(o), '{}') into opts from jsonb_array_elements_text(coalesce(item -> 'options', '[]'::jsonb)) as o;
    found := public.find_similar_questions(coalesce(item ->> 'body', ''), opts, null, p_threshold, p_actor);
    if jsonb_array_length(found) > 0 then
      result := result || jsonb_build_array(jsonb_build_object('i', coalesce((item ->> 'i')::int, i), 'matches', found));
    end if;
  end loop;
  return result;
end $$;

-- ============ the whole-bank duplicate scan, scoped to the actor ============
create or replace function public.find_duplicate_groups(p_threshold real, p_limit int, p_actor uuid)
returns jsonb language plpgsql stable set search_path = public, extensions as $$
declare
  v_exact jsonb;
  v_similar jsonb;
  v_question_ids uuid[];
  v_admin boolean := public._is_staff_admin(p_actor);
begin
  if p_threshold < 0 or p_threshold > 1 then
    raise exception 'Threshold must be between 0 and 1.' using hint = 'validation';
  end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;

  with exact_groups as (
    select content_hash, array_agg(id order by created_at) as ids
    from public.questions
    where not is_archived
      and (v_admin or created_by = p_actor)
    group by content_hash
    having count(*) > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'exact',
           'questions', (
             select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body, 'used_in_exams',
                      (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id))
                    order by q.created_at)
             from public.questions q where q.id = any (g.ids)
           ))
         order by array_length(g.ids, 1) desc), '[]'::jsonb)
    into v_exact
    from exact_groups g;

  with similar_pairs as (
    select q1.id as a_id, q1.body as a_body, q2.id as b_id, q2.body as b_body,
           round(extensions.similarity(q1.body, q2.body)::numeric, 2) as sim
    from public.questions q1
    join public.questions q2 on q2.id > q1.id and q2.body % q1.body
    where not q1.is_archived and not q2.is_archived
      and (v_admin or q1.created_by = p_actor) and (v_admin or q2.created_by = p_actor)
      and q1.content_hash <> q2.content_hash
      and extensions.similarity(q1.body, q2.body) >= p_threshold
    order by extensions.similarity(q1.body, q2.body) desc
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'similar',
           'similarity', p.sim,
           'questions', jsonb_build_array(
             jsonb_build_object('id', p.a_id, 'body', p.a_body, 'used_in_exams',
               (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = p.a_id)),
             jsonb_build_object('id', p.b_id, 'body', p.b_body, 'used_in_exams',
               (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = p.b_id))
           ))
         order by p.sim desc), '[]'::jsonb)
    into v_similar
    from similar_pairs p;

  select array_agg(distinct id) into v_question_ids
  from (
    select (jsonb_array_elements(g -> 'questions') ->> 'id')::uuid as id
    from jsonb_array_elements(v_exact) g
    union all
    select (jsonb_array_elements(g -> 'questions') ->> 'id')::uuid as id
    from jsonb_array_elements(v_similar) g
  ) ids;

  return jsonb_build_object(
    'question_count', coalesce(array_length(v_question_ids, 1), 0),
    'exact_groups', v_exact,
    'similar_pairs', v_similar
  );
end $$;

-- ============ bulk change: foreign ids count as missing, exactly like purged ones ============
create or replace function public.bulk_update_questions(p_ids uuid[], p_changes jsonb, p_actor uuid)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v jsonb := coalesce(p_changes, '{}'::jsonb);
  v_ids uuid[] := coalesce(p_ids, '{}'::uuid[]);
  v_selected int;
  v_rows uuid[] := '{}'::uuid[];
  v_matched int := 0;
  v_topic_id uuid;
  v_topic_set boolean := (v ? 'topic');
  v_diff public.difficulty_level;
  v_diff_set boolean := (v ? 'difficulty');
  v_weight numeric;
  v_weight_set boolean := (v ? 'weight');
  v_archived boolean;
  v_archived_set boolean := (v ? 'archived');
  v_mode text;
  v_labels text[] := '{}'::text[];
  v_norms text[] := '{}'::text[];
  v_label text;
  v_norm text;
  v_row uuid;
  v_hit uuid;
  v_hits uuid[];
  v_scalar uuid[] := '{}'::uuid[];
  v_labelled uuid[] := '{}'::uuid[];
  v_flagged uuid[] := '{}'::uuid[];
  v_over uuid[] := '{}'::uuid[];
  v_changed int := 0;
  i int;
begin
  v_selected := coalesce(array_length(v_ids, 1), 0);
  if v_selected = 0 then
    raise exception 'Select at least one question.' using hint = 'validation';
  end if;
  if v_selected > 500 then
    raise exception 'Change at most 500 questions at once.' using hint = 'validation';
  end if;
  if not v_topic_set and not v_diff_set and not v_weight_set and not v_archived_set and not (v ? 'class_labels') then
    raise exception 'Choose at least one thing to change.' using hint = 'validation';
  end if;

  -- Which of the selected questions still exist AND belong to the caller (a foreign id is exactly as
  -- invisible as a purged one). The ones that do not are counted, not fatal.
  select coalesce(array_agg(q.id), '{}'::uuid[]) into v_rows
    from public.questions q
    where q.id = any(v_ids)
      and (public._is_staff_admin(p_actor) or q.created_by = p_actor);
  v_matched := coalesce(array_length(v_rows, 1), 0);
  if v_matched = 0 then
    raise exception 'Those questions no longer exist. Refresh the list and try again.' using hint = 'validation';
  end if;

  -- ---------- the scalar fields ----------
  if v_topic_set then
    v_topic_id := public.upsert_topic(nullif(btrim(coalesce(v ->> 'topic', '')), ''));
  end if;

  if v_diff_set then
    begin
      v_diff := (v ->> 'difficulty')::public.difficulty_level;
    exception when others then
      raise exception 'Choose Easy, Medium, or HOTS.' using hint = 'validation';
    end;
    if v_diff is null then
      raise exception 'Choose Easy, Medium, or HOTS.' using hint = 'validation';
    end if;
  end if;

  if v_weight_set then
    begin
      v_weight := (v ->> 'weight')::numeric;
    exception when others then
      raise exception 'Points must be a number.' using hint = 'validation';
    end;
    if v_weight is null or v_weight <= 0 or v_weight > 100 then
      raise exception 'Points must be more than 0 and at most 100.' using hint = 'validation';
    end if;
  end if;

  -- The update only touches rows that really differ, so `updated` is the truth and a question's
  -- updated_at is not bumped for nothing (the set_updated_at trigger fires on every update).
  with changed as (
    update public.questions q
       set topic_id = case when v_topic_set then v_topic_id else q.topic_id end,
           difficulty = case when v_diff_set then v_diff else q.difficulty end,
           default_weight = case when v_weight_set then v_weight else q.default_weight end
     where q.id = any(v_rows)
       and ((v_topic_set and q.topic_id is distinct from v_topic_id)
         or (v_diff_set and q.difficulty is distinct from v_diff)
         or (v_weight_set and q.default_weight is distinct from v_weight))
    returning q.id
  )
  select coalesce(array_agg(changed.id), '{}'::uuid[]) into v_scalar from changed;

  -- ---------- class labels ----------
  if v ? 'class_labels' then
    v_mode := v -> 'class_labels' ->> 'mode';
    if v_mode is null or v_mode not in ('add', 'remove', 'replace') then
      raise exception 'Choose what to do with the class labels.' using hint = 'validation';
    end if;

    for i in 0 .. coalesce(jsonb_array_length(case when jsonb_typeof(v -> 'class_labels' -> 'labels') = 'array' then v -> 'class_labels' -> 'labels' else '[]'::jsonb end), 0) - 1 loop
      v_label := btrim(regexp_replace(coalesce(v -> 'class_labels' -> 'labels' ->> i, ''), '\s+', ' ', 'g'));
      if v_label = '' then continue; end if;
      if char_length(v_label) > 40 then
        raise exception 'A class label is too long (at most 40 characters).' using hint = 'validation';
      end if;
      v_norm := public.normalize_text(v_label);
      if not (v_norm = any(v_norms)) then
        v_norms := v_norms || v_norm;
        v_labels := v_labels || v_label;
      end if;
    end loop;

    if coalesce(array_length(v_labels, 1), 0) = 0 and v_mode in ('add', 'replace') then
      raise exception 'Add at least one class label.' using hint = 'validation';
    end if;
    if coalesce(array_length(v_labels, 1), 0) > 10 then
      raise exception 'A question can have at most 10 class labels.' using hint = 'validation';
    end if;

    -- Adding must not push anybody past the same ceiling save_question enforces.
    if v_mode = 'add' then
      select coalesce(array_agg(x.id), '{}'::uuid[]) into v_over from (
        select q.id
          from public.questions q
         where q.id = any(v_rows)
         group by q.id
        having (select count(*) from public.question_class_labels l
                 where l.question_id = q.id and not (l.label_normalized = any(v_norms)))
             + coalesce(array_length(v_labels, 1), 0) > 10
      ) x;
      if coalesce(array_length(v_over, 1), 0) > 0 then
        raise exception 'Adding these labels would give some questions more than 10 class labels. Remove one first.' using hint = 'validation';
      end if;
    end if;

    if v_mode = 'remove' then
      with gone as (
        delete from public.question_class_labels l
         where l.question_id = any(v_rows) and l.label_normalized = any(v_norms)
        returning l.question_id
      )
      select coalesce(array_agg(gone.question_id), '{}'::uuid[]) into v_hits from gone;
      v_labelled := coalesce(v_hits, '{}'::uuid[]);
    else
      if v_mode = 'replace' then
        with gone as (
          delete from public.question_class_labels l
           where l.question_id = any(v_rows) and not (l.label_normalized = any(v_norms))
          returning l.question_id
        )
        select coalesce(array_agg(gone.question_id), '{}'::uuid[]) into v_hits from gone;
        v_labelled := coalesce(v_hits, '{}'::uuid[]);
      end if;
      -- Add whatever is missing. `on conflict do nothing` makes adding a label a question already
      -- carries a no-op, so the returned id is exactly the set that gained one.
      for v_row in select unnest(v_rows) loop
        for i in 1 .. coalesce(array_length(v_labels, 1), 0) loop
          v_hit := null;
          insert into public.question_class_labels (question_id, label_display)
          values (v_row, v_labels[i])
          on conflict (question_id, label_normalized) do nothing
          returning question_id into v_hit;
          if v_hit is not null then
            v_labelled := v_labelled || v_hit;
          end if;
        end loop;
      end loop;
    end if;
  end if;

  -- ---------- archive / restore ----------
  if v_archived_set then
    begin
      v_archived := (v ->> 'archived')::boolean;
    exception when others then
      raise exception 'Archive must be true or false.' using hint = 'validation';
    end;
    with changed as (
      update public.questions q set is_archived = v_archived
       where q.id = any(v_rows) and q.is_archived is distinct from v_archived
      returning q.id
    )
    select coalesce(array_agg(changed.id), '{}'::uuid[]) into v_flagged from changed;
  end if;

  -- One audit entry for the whole act, naming how many questions really changed and what was asked for.
  select count(*) into v_changed
    from (select distinct x from unnest(v_scalar || v_labelled || v_flagged) as x) u;

  perform public.write_audit(p_actor, 'question.bulk_update', 'question', null,
    jsonb_build_object(
      'count', v_changed,
      'selected', v_selected,
      'matched', v_matched,
      'missing', v_selected - v_matched,
      'changes', v
    ));

  return jsonb_build_object(
    'matched', v_matched,
    'updated', v_changed,
    'unchanged', v_matched - v_changed,
    'missing', v_selected - v_matched
  );
end $$;

-- ============ the old unscoped signatures must not survive ============
drop function if exists public.get_question(uuid);
drop function if exists public.list_questions(jsonb);
drop function if exists public.find_similar_questions(text, text[], uuid, real);
drop function if exists public.find_similar_batch(jsonb, real);
drop function if exists public.find_duplicate_groups(real, int);
drop function if exists public.list_topics();
drop function if exists public.list_class_labels(text);
drop function if exists public.list_passages(text);
drop function if exists public.get_passage(uuid);

-- ============ only the service role may call these ============
revoke execute on function public._is_staff_admin(uuid) from public, anon, authenticated;
revoke execute on function public.save_question(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.remove_question(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_question_archived(uuid, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.get_question(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.list_questions(jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.find_similar_questions(text, text[], uuid, real, uuid) from public, anon, authenticated;
revoke execute on function public.list_topics(uuid) from public, anon, authenticated;
revoke execute on function public.list_class_labels(text, uuid) from public, anon, authenticated;
revoke execute on function public.save_passage(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.get_passage(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.list_passages(text, uuid) from public, anon, authenticated;
revoke execute on function public.remove_passage(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.import_questions(jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.find_similar_batch(jsonb, real, uuid) from public, anon, authenticated;
revoke execute on function public.find_duplicate_groups(real, int, uuid) from public, anon, authenticated;
revoke execute on function public.bulk_update_questions(uuid[], jsonb, uuid) from public, anon, authenticated;
grant execute on function public._is_staff_admin(uuid) to service_role;
grant execute on function public.save_question(uuid, jsonb, uuid) to service_role;
grant execute on function public.remove_question(uuid, uuid) to service_role;
grant execute on function public.set_question_archived(uuid, boolean, uuid) to service_role;
grant execute on function public.get_question(uuid, uuid) to service_role;
grant execute on function public.list_questions(jsonb, uuid) to service_role;
grant execute on function public.find_similar_questions(text, text[], uuid, real, uuid) to service_role;
grant execute on function public.list_topics(uuid) to service_role;
grant execute on function public.list_class_labels(text, uuid) to service_role;
grant execute on function public.save_passage(uuid, jsonb, uuid) to service_role;
grant execute on function public.get_passage(uuid, uuid) to service_role;
grant execute on function public.list_passages(text, uuid) to service_role;
grant execute on function public.remove_passage(uuid, uuid) to service_role;
grant execute on function public.import_questions(jsonb, uuid) to service_role;
grant execute on function public.find_similar_batch(jsonb, real, uuid) to service_role;
grant execute on function public.find_duplicate_groups(real, int, uuid) to service_role;
grant execute on function public.bulk_update_questions(uuid[], jsonb, uuid) to service_role;
