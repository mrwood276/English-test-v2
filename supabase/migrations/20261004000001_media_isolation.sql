-- TASK-049 (2026-10-04): teacher data isolation — the media slice (DEC-041).
--
-- Media files are uploaded via `register_media`, linked to a question or passage via
-- `link_media`, and their signed view URLs are made via `get_media_paths`. Until now none
-- of these checked ownership: a teacher could link another teacher's uploaded file to their
-- own question, and `get_media_paths` returned signed URLs for any media id. This slice
-- scopes them the same way as questions, exams, and results:
--   * `register_media` already records uploaded_by = p_actor — unchanged.
--   * `link_media` gains p_actor: only media uploaded by that actor (or any media, for an
--     active admin) may be attached, and only to a question/passage the actor owns.
--   * `get_media_paths` gains p_actor: only files uploaded by that actor (or any file,
--     for an active admin) are handed back.
--   * `save_question` / `save_passage` call `link_media` internally and already carry
--     p_actor, so they forward it — no signature change for them.
--   * `get_session_media_ids` is session-scoped (students join by exam code) and stays
--     unchanged; `purge_orphan_media` is a scheduled job and stays unchanged.
--   * NEW `get_session_media_paths(p_session_id)`: the student's door. The `session` Edge Function
--     used to chain `get_session_media_ids` into the unscoped `get_media_paths`; once that function
--     is scoped to a staff actor it returns nothing for a student (who has no actor), so the
--     exam's audio and images would silently vanish. This function returns the same
--     {id, path, kind} rows, but only for files in that session's own snapshot.
--
-- The old unscoped signatures are dropped: keeping them would leave unscoped functions behind.
--
-- APPLY ORDER (the SQL changes signatures, so the two Edge Functions that call it must follow
-- immediately): this migration → redeploy `media` (staff, passes p_actor) → redeploy `session`
-- (student, calls get_session_media_paths). Run `supabase/tests/media_isolation_test.sql` after.
-- STATUS: see `.ai/04_CURRENT_STATE.md` — the live ledger is the authority on whether it is applied.

-- ============ link_media, now with an owner check ============
drop function if exists public.link_media(text, uuid, jsonb);
create or replace function public.link_media(p_owner text, p_id uuid, p_media jsonb, p_actor uuid) returns void
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
    -- the question must belong to the caller (or the caller is an admin)
    if not exists (select 1 from public.questions q where q.id = p_id
                    and (public._is_staff_admin(p_actor) or q.created_by = p_actor)) then
      raise exception 'That question no longer exists.' using hint = 'validation';
    end if;
    delete from public.question_media where question_id = p_id;
  else
    if not exists (select 1 from public.passages p where p.id = p_id
                    and (public._is_staff_admin(p_actor) or p.created_by = p_actor)) then
      raise exception 'That reading text no longer exists.' using hint = 'validation';
    end if;
    delete from public.question_media where passage_id = p_id;
  end if;

  for i in 0 .. n - 1 loop
    begin
      mid := (p_media -> i ->> 'id')::uuid;
    exception when others then
      raise exception 'A file id is not valid.' using hint = 'validation';
    end;
    if mid is null or mid = any (seen) then raise exception 'The same file is attached twice.' using hint = 'validation'; end if;
    -- the file must exist and be owned by the caller (or the caller is an admin)
    if not exists (select 1 from public.media_files m where m.id = mid
                    and (public._is_staff_admin(p_actor) or m.uploaded_by = p_actor)) then
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

-- ============ get_media_paths, now with an owner check ============
drop function if exists public.get_media_paths(uuid[]);
create or replace function public.get_media_paths(p_ids uuid[], p_actor uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'path', m.storage_path, 'kind', m.kind)), '[]'::jsonb)
  from public.media_files m
  where m.id = any (p_ids)
    and (public._is_staff_admin(p_actor) or m.uploaded_by = p_actor)
$$;

-- ============ get_session_media_paths: the student's door (no actor, scoped by the session) ============
-- Built on get_session_media_ids (security definer, reads the session's own snapshot), so a
-- student can only ever be handed the files their own attempt shows. A missing session gives [].
create or replace function public.get_session_media_paths(p_session_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'path', m.storage_path, 'kind', m.kind)), '[]'::jsonb)
  from public.media_files m
  where m.id = any (public.get_session_media_ids(p_session_id))
$$;

-- ============ save_question / save_passage forward p_actor to link_media ============
-- They already carry p_actor; only the link_media call inside them changes. The functions are
-- re-declared so the body is verifiable in this file, not only in the live project.
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

  -- files: only when the caller sends the list (an absent list leaves the current files alone)
  if p ? 'media' then
    perform public.link_media('question', v_id, p -> 'media', p_actor);
  end if;

  perform public.write_audit(p_actor, case when v_is_new then 'question.create' else 'question.update' end, 'question', v_id::text,
    jsonb_build_object('type', v_type, 'difficulty', v_diff, 'topic', p ->> 'topic', 'points', v_weight, 'class_labels', to_jsonb(label_texts),
                       'files', case when p ? 'media' then jsonb_array_length(coalesce(p -> 'media', '[]'::jsonb)) else null end));
  return v_id;
end $$;

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
  if p ? 'media' then
    perform public.link_media('passage', v_id, p -> 'media', p_actor);
  end if;
  return v_id;
end $$;

-- ============ boundary: only the service role executes these ============
revoke execute on function public.link_media(text, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.get_media_paths(uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.get_session_media_paths(uuid) from public, anon, authenticated;
revoke execute on function public.save_question(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.save_passage(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.link_media(text, uuid, jsonb, uuid) to service_role;
grant execute on function public.get_media_paths(uuid[], uuid) to service_role;
grant execute on function public.get_session_media_paths(uuid) to service_role;
grant execute on function public.save_question(uuid, jsonb, uuid) to service_role;
grant execute on function public.save_passage(uuid, jsonb, uuid) to service_role;
