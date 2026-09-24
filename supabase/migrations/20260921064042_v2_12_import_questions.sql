-- Fase 2, importing questions from Excel/CSV and pasted text.
-- The browser reads the file and shows a review; these functions do the two server jobs:
-- (1) check a whole list against the bank for duplicates, (2) save the chosen questions all-or-nothing.

create function public.find_similar_batch(p_items jsonb, p_threshold real default 0.55) returns jsonb
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
    found := public.find_similar_questions(coalesce(item ->> 'body', ''), opts, null, p_threshold);
    if jsonb_array_length(found) > 0 then
      result := result || jsonb_build_array(jsonb_build_object('i', coalesce((item ->> 'i')::int, i), 'matches', found));
    end if;
  end loop;
  return result;
end $$;

create function public.import_questions(p_items jsonb, p_actor uuid) returns jsonb
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

revoke execute on function public.find_similar_batch(jsonb, real) from public, anon, authenticated;
revoke execute on function public.import_questions(jsonb, uuid) from public, anon, authenticated;
