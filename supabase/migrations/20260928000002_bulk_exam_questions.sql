-- F-18: putting many questions on one exam, or taking many off it, in one act.
--
-- APPLIED LIVE: 2026-09-28 to project lbhnadqmokloyfarrzfv (run twice — the second run is the renumber
-- fix below; the function is idempotent, so re-running is the update path). Nothing here is destructive to
-- any existing object (one new function; no table, no column, no existing function touched), so running it
-- late is safe. Step-by-step live instructions and the rolled-back test are in docs/sql-exam-questions.md.
--
-- Why this exists beside `save_exam`: the exam editor owns the whole exam — it sends every field and every
-- question row, and `save_exam` rewrites the list from that payload. The question bank holds no exam at
-- all; there a teacher has ticked some questions and wants them on one. Reaching for `save_exam` from there
-- would mean rebuilding the exam in the browser from a payload that does not carry the rules panel, and
-- calling it once per question would rewrite the list from an increasingly stale snapshot. So this is the
-- "change one thing about an exam" path, shaped exactly like `bulk_update_questions` (DEC-035 / DEC-004):
-- one transaction, one audit entry, honest counts.
--
-- Add and remove are one function with a `p_mode`, not two: they are the same act on the same table behind
-- the same guards, and two functions would be two places for those guards to drift apart.
--
-- What it refuses, and why (every one of them is `hint = 'validation'`, so the Edge layer answers 400):
--   * a selection with no mode, nothing in it, or more than 500 ids — the same ceiling the question bank's
--     own bulk path uses;
--   * an exam that draws its questions by a filter: it has no fixed list to add to;
--   * a running exam: the questions on it are what the students taking it are answering right now;
--   * an exam that already has attempts: its results are tied to the questions that were asked, so the set
--     stays as it was — duplicate the exam instead (BR-10 / DEC-012: attempts are never rewritten);
--   * adding an archived question: archiving is how a question is retired, and `save_question`'s own rule is
--     that an archived question cannot be used by a new exam;
--   * growing an exam past 200 questions, the same ceiling `parseExamQuestions` already enforces at the Edge
--     layer, so the two paths cannot drift;
--   * a selection that matches no question at all.
--
-- Returns { matched, updated, unchanged, missing }:
--   add    — matched: ids that exist in the bank; updated: really added; unchanged: already on the exam;
--            missing: ids that no longer exist.
--   remove — matched: ids found on the exam; updated: really removed; unchanged: exist but are not on the
--            exam; missing: ids that no longer exist.
-- Only what really changed is counted, so `updated` is the truth and the same act twice reports 0 updated.
-- Adding puts the questions at the end of the list, in the order they were given, each carrying its own
-- default points — the editor's reorder and points controls are where an order and a weight are chosen
-- deliberately.
--
-- An exam's list is always 1..n with no gaps, whichever way it was changed. Adding numbers on from the
-- current end; removing closes the gap the removed rows left behind, keeping the survivors' relative order
-- and their own points. Gaps would be visible: the editor prints `position + 1` as the question's number,
-- so a hole would read as "Question 1, Question 2, Question 4". `save_exam` already rewrites the list as a
-- contiguous run, and the timestamp order `created_at` the list falls back to is not the order the exam
-- asks its questions in — so the position is the only truth and it is kept dense.
--
-- One audit entry per act: `exam.questions`, entity `exam`, with the mode, the exam's title and the real
-- count. Never one entry per question.

create or replace function public.bulk_exam_questions(p_exam_id uuid, p_mode text, p_ids uuid[], p_actor uuid)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_mode text := lower(btrim(coalesce(p_mode, '')));
  v_ids uuid[] := coalesce(p_ids, '{}'::uuid[]);
  v_selected int;
  v_title text;
  v_status text;
  v_selection text;
  v_sessions int;
  v_found int := 0;
  v_on int := 0;
  v_archived int := 0;
  v_exam_count int := 0;
  v_next int := 0;
  v_updated int := 0;
begin
  v_selected := coalesce(array_length(v_ids, 1), 0);

  -- ---------- the selection itself ----------
  if v_mode not in ('add', 'remove') then
    raise exception 'Choose whether to add or remove questions.' using hint = 'validation';
  end if;
  if v_selected = 0 then
    raise exception 'Select at least one question.' using hint = 'validation';
  end if;
  if v_selected > 500 then
    raise exception 'Change at most 500 questions at once.' using hint = 'validation';
  end if;

  -- ---------- the exam, and whether its set may move at all ----------
  select e.title, e.status::text, e.selection_mode::text
    into v_title, v_status, v_selection
    from public.exams e
   where e.id = p_exam_id;
  if not found then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;
  if v_selection <> 'manual' then
    raise exception 'This exam draws its questions by a filter, so it has no fixed question list.' using hint = 'validation';
  end if;
  if v_status = 'open' then
    raise exception 'Close the exam before changing its questions.' using hint = 'validation';
  end if;
  select count(*) into v_sessions from public.exam_sessions s where s.exam_id = p_exam_id;
  if v_sessions > 0 then
    raise exception 'This exam already has attempts, so its questions stay as they were. Duplicate the exam to change them.' using hint = 'validation';
  end if;

  -- ---------- what is really there ----------
  select count(*) into v_found from public.questions q where q.id = any(v_ids);
  if v_found = 0 then
    raise exception 'Those questions no longer exist. Refresh the list and try again.' using hint = 'validation';
  end if;
  select count(*) into v_on from public.exam_questions eq
   where eq.exam_id = p_exam_id and eq.question_id = any(v_ids);

  if v_mode = 'add' then
    select count(*) into v_archived from public.questions q where q.id = any(v_ids) and q.is_archived;
    if v_archived > 0 then
      raise exception 'Some of those questions are archived. Restore them first, or leave them out.' using hint = 'validation';
    end if;

    select count(*) into v_exam_count from public.exam_questions eq where eq.exam_id = p_exam_id;
    if v_exam_count + (v_found - v_on) > 200 then
      raise exception 'An exam can hold at most 200 questions.' using hint = 'validation';
    end if;

    select coalesce(max(eq.position), 0) into v_next from public.exam_questions eq where eq.exam_id = p_exam_id;

    -- In the order they were given, skipping what is already on the exam, numbered so the positions stay
    -- contiguous even when some ids were skipped.
    with wanted as (
      select ord.id, ord.rn
        from unnest(v_ids) with ordinality as ord(id, rn)
       where not exists (
         select 1 from public.exam_questions eq
          where eq.exam_id = p_exam_id and eq.question_id = ord.id
       )
         and exists (select 1 from public.questions q where q.id = ord.id)
    ), numbered as (
      select w.id, row_number() over (order by w.rn) as rn from wanted w
    ), added as (
      insert into public.exam_questions (exam_id, question_id, position, weight)
      select p_exam_id, n.id, v_next + n.rn, q.default_weight
        from numbered n
        join public.questions q on q.id = n.id
      returning 1 as one
    )
    select count(*) into v_updated from added;
  else
    with gone as (
      delete from public.exam_questions eq
       where eq.exam_id = p_exam_id and eq.question_id = any(v_ids)
      returning 1 as one
    )
    select count(*) into v_updated from gone;

    -- Close the gap the removal left, in a statement of its own so it sees the rows that just went. The
    -- survivors keep their relative order and their points; only the numbering moves. `unique (exam_id,
    -- position)` is `deferrable initially deferred` (v2_03), so rewriting the numbers in one pass cannot
    -- trip over a number that is briefly held by two rows — the check happens at commit, on the final set.
    update public.exam_questions eq
       set position = numbered.rn
      from (
        select eq2.question_id, row_number() over (order by eq2.position) as rn
          from public.exam_questions eq2
         where eq2.exam_id = p_exam_id
      ) numbered
     where eq.exam_id = p_exam_id and eq.question_id = numbered.question_id
       and eq.position <> numbered.rn;
  end if;

  perform public.write_audit(p_actor, 'exam.questions', 'exam', p_exam_id::text,
    jsonb_build_object(
      'mode', v_mode,
      'title', v_title,
      'count', v_updated,
      'selected', v_selected,
      'matched', case when v_mode = 'add' then v_found else v_on end,
      'unchanged', case when v_mode = 'add' then v_on else (v_found - v_on) end,
      'missing', v_selected - v_found
    ));

  return jsonb_build_object(
    'matched', case when v_mode = 'add' then v_found else v_on end,
    'updated', v_updated,
    'unchanged', case when v_mode = 'add' then v_on else (v_found - v_on) end,
    'missing', v_selected - v_found
  );
end $$;

-- Only the service role (every Edge Function) may call it, like every other function in this schema.
revoke execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.bulk_exam_questions(uuid, text, uuid[], uuid) to service_role;
