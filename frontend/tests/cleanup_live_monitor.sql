-- Removes everything frontend/tests/live_monitor_check.py created on the live project.
-- Run it after that script:  npx supabase db query --linked --file frontend/tests/cleanup_live_monitor.sql
-- NOTE: unlike supabase/tests/*.sql, this block must NOT end with a deliberate exception — that would
-- roll the deletes back. It stays silent; check the counts afterwards with a select.
--
-- It keeps the questions the check used: the monitor check builds its exam from the live bank and never
-- creates a question of its own, so only the exam and its four attempts are removed.
do $$
declare
  v_exam uuid;
  v_sessions uuid[];
begin
  select id into v_exam from public.exams where access_code = 'MON001';
  if v_exam is null then raise exception 'nothing to clean: the monitor test exam is already gone'; end if;
  select coalesce(array_agg(id), '{}') into v_sessions from public.exam_sessions where exam_id = v_exam;

  delete from public.session_events where session_id = any(v_sessions);
  delete from public.session_answers where session_id = any(v_sessions);
  delete from public.answer_grades where session_id = any(v_sessions);
  delete from public.exam_results where session_id = any(v_sessions);
  delete from public.exam_sessions where id = any(v_sessions);
  delete from public.retake_permissions where exam_id = v_exam;
  delete from public.audit_logs where entity_id = v_exam::text or entity_id = any(v_sessions::text[]);
  delete from public.exam_questions where exam_id = v_exam;
  delete from public.exams where id = v_exam;
  -- the rate-limit buckets the student endpoints fill (session_join, session_save, session_submit,
  -- session_event, session_media)
  delete from public.rate_limits where bucket like 'session\_%'
    and window_start > now() - interval '2 hours';

  raise notice 'cleanup: % sessions in the monitor test exam', array_length(v_sessions, 1);
end $$;
