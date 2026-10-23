-- Fix: set_exam_status should check selection_mode ('manual' vs 'auto'), not availability_mode ('manual' vs 'scheduled')
-- Previously, line 216 in 20261004000000_exam_isolation.sql checked `v_mode = 'manual'` where `v_mode` was
-- availability_mode, which blocked auto-selection exams from being opened manually.

create or replace function public.set_exam_status(p_id uuid, p_status text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_avail_mode text;
  v_selection_mode text;
  v_ends timestamptz;
  v_code text;
  v_template boolean;
begin
  if p_status not in ('draft','open','closed') then
    raise exception 'Status must be draft, open, or closed.' using hint = 'validation';
  end if;

  select status, availability_mode::text, selection_mode::text, ends_at, access_code, is_template
    into v_status, v_avail_mode, v_selection_mode, v_ends, v_code, v_template
    from public.exams where id = p_id;

  if not found then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;

  if p_actor is null or not (public._is_staff_admin(p_actor) or (select created_by from public.exams where id = p_id) = p_actor) then
    raise exception 'That exam no longer exists.' using hint = 'validation';
  end if;

  if p_status = 'open' then
    if v_template then
      raise exception 'A template cannot be opened. Duplicate it and open the copy.' using hint = 'validation';
    end if;

    -- Only manual-selection exams require pre-added questions in exam_questions;
    -- auto exams draw questions from the question bank filter when students join.
    if v_selection_mode = 'manual' then
      if not exists (select 1 from public.exam_questions where exam_id = p_id) then
        raise exception 'Add questions before opening the exam.' using hint = 'validation';
      end if;
    end if;

    if v_avail_mode = 'scheduled' and v_ends is null then
      raise exception 'A scheduled exam needs a closing time.' using hint = 'validation';
    end if;

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

revoke execute on function public.set_exam_status(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.set_exam_status(uuid, text, uuid) to service_role;
