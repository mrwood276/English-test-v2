-- TASK-030 / INS-03 / DEC-039 (2026-10-02): only a hidden page counts as a page leave.
--
-- Since the session engine was written, `log_session_event` counted both `tab_hidden` and `blur` toward
-- the exam's warn / flag / auto-submit limits. `blur` fires for a phone notification, the browser's
-- address bar, an incoming call or the keyboard's overflow — events the student cannot prevent — so an
-- honest attempt could be auto-submitted by five of them. The owner chose (D-1) that only a hidden page
-- counts: `tab_hidden` feeds the limits, `blur` keeps its row in `session_events` (info severity) and can
-- no longer submit anything.
--
-- This replaces exactly one function. No table, column or other function changes; the client keeps
-- sending both events. The rule is stated in the exam editor where the limits are set, mirrored by
-- `frontend/tests/mock_server.py`, and asserted in `supabase/tests/session_functions_test.sql`.
--
-- APPLIED LIVE: 2026-10-02, with its `schema_migrations` row (version `20261002000001`, name
-- `leave_count_only_tab_hidden`); the rolled-back SQL test passed afterwards.

create or replace function public.log_session_event(p_id uuid, p_event_type text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions%rowtype;
  e public.exams%rowtype;
  v_sev public.event_severity := 'info';
  v_leave boolean := p_event_type = 'tab_hidden';
  v_autosubmit boolean := false;
begin
  if p_event_type not in ('join', 'tab_hidden', 'blur', 'focus', 'online', 'offline', 'reload', 'submit', 'reopen') then
    raise exception 'That event type is not known.' using hint = 'validation'; end if;
  select * into s from public.exam_sessions where id = p_id;
  if not found then
    raise exception 'This test session was not found. Please join again.' using hint = 'validation'; end if;
  select * into e from public.exams where id = s.exam_id;

  if s.status in ('in_progress', 'reopened') and v_leave then
    s.tab_switch_count := s.tab_switch_count + 1;
    v_sev := case
      when s.tab_switch_count >= e.tab_switch_flag_limit then 'suspicious'
      when s.tab_switch_count >= e.tab_switch_warn_limit then 'warning'
      else 'info' end;
    update public.exam_sessions set tab_switch_count = s.tab_switch_count, last_heartbeat_at = now()
     where id = p_id;
  end if;
  if s.status in ('in_progress', 'reopened') and p_event_type = 'offline' then
    v_sev := 'info';
  end if;

  insert into public.session_events (session_id, event_type, severity, meta)
  values (p_id, p_event_type, v_sev, coalesce(p_meta, '{}'::jsonb));

  if s.status in ('in_progress', 'reopened') and v_leave and s.tab_switch_count >= e.tab_switch_autosubmit_limit then
    perform public._session_grade(s.id, 'auto_submitted');
    v_autosubmit := true;
  end if;

  return jsonb_build_object('status', case when v_autosubmit then 'auto_submitted' else s.status end,
    'tab_switch_count', s.tab_switch_count, 'autosubmit', v_autosubmit,
    'warn_limit', e.tab_switch_warn_limit, 'flag_limit', e.tab_switch_flag_limit,
    'autosubmit_limit', e.tab_switch_autosubmit_limit);
end $$;
