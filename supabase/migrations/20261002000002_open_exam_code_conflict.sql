-- TASK-031 / INS-04 / ISSUE-049 (2026-10-02): opening an exam whose code an open exam already uses
-- is refused in words instead of dying on the partial unique index as a hidden 500.
--
-- `save_exam` has always refused a code held by an open exam, and `exams_open_code_unique` allows only
-- one open exam per code — but neither stops two drafts from being prepared with the same code (a
-- copy/paste, or a code reused from the board). Opening the second could only hit the index: Supabase
-- answered `23505` with no `hint`, `callRpc` rethrew it, and the teacher saw "Something went wrong.
-- Please try again." while `check_code` had said the code was free.
--
-- This replaces `set_exam_status` (adding the check, raised with `hint = 'validation'` so the Edge
-- function answers 400 with the sentence) and adds `exam_code_used_by`, which `check_code` now calls:
-- it names the holder — 'open', 'draft', or null (free) — so the editor can say "another draft uses
-- this code" before Open, when the conflict can still be avoided cheaply. No table, column or index
-- changes. `save_exam` and `exam_code_available` keep their rules (regeneration still avoids only
-- open exams; a closed exam does not hold its code).
--
-- APPLIED LIVE: pending — written 2026-10-02 without a Management credential. Apply it as one
-- Management API request with its ledger row (version `20261002000002`, name `open_exam_code_conflict`),
-- run `supabase/tests/exam_status_test.sql`, then redeploy the `exams` Edge Function (its handler now
-- calls `exam_code_used_by`, so the SQL must land first), and record the result here and in `.ai/`.

-- ============ the refusal at Open ============
create or replace function public.set_exam_status(p_id uuid, p_status text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_mode text; v_ends timestamptz; v_code text;
begin
  if p_status not in ('draft','open','closed') then
    raise exception 'Status must be draft, open, or closed.' using hint = 'validation'; end if;
  select status, availability_mode, ends_at, access_code into v_status, v_mode, v_ends, v_code
    from public.exams where id = p_id;
  if not found then raise exception 'That exam no longer exists.' using hint = 'validation'; end if;
  if p_status = 'open' then
    if v_mode = 'manual' then
      if not exists (select 1 from public.exam_questions where exam_id = p_id) then
        raise exception 'Add questions before opening the exam.' using hint = 'validation';
      end if;
    end if;
    if v_mode = 'scheduled' and v_ends is null then
      raise exception 'A scheduled exam needs a closing time.' using hint = 'validation'; end if;
    -- The rule save_exam applies, said at the moment that used to be a 500. `_exam_is_open` covers a
    -- scheduled exam inside its window even while its status column is not yet 'open'.
    if exists (
      select 1 from public.exams x
      where x.access_code = v_code and x.id <> p_id
        and (x.status = 'open' or public._exam_is_open(x))
    ) then
      raise exception 'The test code % is already used by an open exam. Close that exam or give this one a different code.', v_code
        using hint = 'validation';
    end if;
  end if;
  update public.exams set status = p_status::public.exam_status, updated_at = now() where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (p_actor, 'exam.status', 'exam', p_id, jsonb_build_object('from', v_status, 'to', p_status));
end $$;

-- ============ who holds this code? ============
-- 'open'  — an exam students can join now: no other exam may open on this code (set_exam_status refuses).
-- 'draft' — saved, not opened: two drafts may share a code, but only one of them can open.
-- null    — free (no exam holds it, or only closed exams do), or it is the excluded exam's own code.
create or replace function public.exam_code_used_by(p_code text, p_exclude uuid default null)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (
      select 1 from public.exams x
      where upper(regexp_replace(p_code, '\s', '', 'g')) = x.access_code
        and x.id is distinct from p_exclude
        and (x.status = 'open' or public._exam_is_open(x))
    ) then 'open'
    when exists (
      select 1 from public.exams x
      where upper(regexp_replace(p_code, '\s', '', 'g')) = x.access_code
        and x.id is distinct from p_exclude
        and x.status = 'draft'
    ) then 'draft'
    else null
  end;
$$;
