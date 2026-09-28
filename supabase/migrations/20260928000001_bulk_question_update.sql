-- Fase 2, bulk question management (F-17). Changing many questions is ONE transaction, so a teacher
--
-- APPLIED LIVE: 2026-09-28, against project lbhnadqmokloyfarrzfv, with its own `schema_migrations` row
-- (`20260928000001` / `bulk_question_update`) written in the same session — applying through the Management
-- API or the dashboard leaves no tracking row, so that row is what stops a later `supabase db push` from
-- re-running it (the pattern docs/sql-jobs.md describes). The rolled-back test
-- `supabase/tests/bulk_update_test.sql` passed live the same day — two faults in the test file itself were
-- found and fixed first (`BULK UPDATE TESTS PASSED (…)`) — and `frontend/tests/live_bulk_check.py` passed
-- **65/65** against the deployed function: `ALL LIVE BULK CHECKS PASSED`. Both Supabase advisors (security
-- and performance) came back with **0 findings** afterwards. Record: docs/sql-bulk-update.md.
-- who ticks 40 questions and changes their topic gets 40 changes or none, and the audit trail records
-- one act instead of forty (DEC-004: business rules are database functions, one transaction per act).
-- Doing it per question from the Edge layer would also be 40 round trips and 40 transactions.
--
-- This file only adds a function. It touches no table, changes no column, and leaves save_question and
-- set_question_archived exactly as they are, so the single-question paths behave as before. The archive
-- half of a bulk change is the same `update public.questions set is_archived = ...` that
-- set_question_archived runs — once for the whole selection instead of once per question.
--
-- p_changes keys (all optional; at least one is required):
--   topic        text     — create it if it is new, or find it case-insensitively ('' or null clears it)
--   difficulty   enum     — easy | medium | hots
--   weight       number   — default_weight, more than 0 and at most 100
--   archived     boolean  — archive or restore
--   class_labels object   — { mode: 'add' | 'remove' | 'replace', labels: [text, ...] }
--                           add     keeps the labels a question has and adds these,
--                           remove  takes exactly these away,
--                           replace ends with exactly these.
--                           Labels match case- and space-insensitively, the same way save_question and
--                           the class filter do (public.normalize_text).
--
-- Returns { matched, updated, unchanged, missing }: how many of the selected questions were found, how
-- many actually changed, how many already looked the way they were asked to, and how many ids no longer
-- exist. A question deleted in another tab is skipped and counted, never a reason to fail a whole batch
-- — but nothing is ever half-applied to a single question, because all of this is one transaction.
--
-- Validation problems raise with hint = 'validation', which the Edge layer turns into a friendly 400.
-- Every limit here (10 class labels, 40 characters each, 120 for a topic, points 0.01..100) is the same
-- limit save_question enforces, so the two paths cannot drift.

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

  -- Which of the selected questions still exist. The ones that do not are counted, not fatal.
  select coalesce(array_agg(q.id), '{}'::uuid[]) into v_rows
    from public.questions q where q.id = any(v_ids);
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

-- Only the service role (every Edge Function) may call it, like every other function in this schema.
revoke execute on function public.bulk_update_questions(uuid[], jsonb, uuid) from public, anon, authenticated;
grant execute on function public.bulk_update_questions(uuid[], jsonb, uuid) to service_role;
