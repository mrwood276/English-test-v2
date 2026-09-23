-- Removes everything frontend/tests/live_results_check.py created on the live project.
-- Run it after that script:  npx supabase db query --linked --file frontend/tests/cleanup_live_results.sql
-- NOTE: unlike supabase/tests/*.sql, this block must NOT end with a deliberate exception — that would
-- roll the deletes back. It stays silent; check the counts afterwards with a select.
do $$
declare
  v_exam uuid;
  v_sessions uuid[];
  v_questions uuid[];
begin
  select id into v_exam from public.exams where access_code = 'RLC001';
  if v_exam is null then raise exception 'nothing to clean: the test exam is already gone'; end if;
  select coalesce(array_agg(id), '{}') into v_sessions from public.exam_sessions where exam_id = v_exam;
  select coalesce(array_agg(question_id), '{}') into v_questions from public.exam_questions where exam_id = v_exam;

  delete from public.session_events where session_id = any(v_sessions);
  delete from public.session_answers where session_id = any(v_sessions);
  delete from public.answer_grades where session_id = any(v_sessions);
  delete from public.exam_results where session_id = any(v_sessions);
  delete from public.exam_sessions where id = any(v_sessions);
  delete from public.retake_permissions where exam_id = v_exam;
  delete from public.audit_logs where entity_id = v_exam::text
     or entity_id = any(v_sessions::text[])
     or entity_id = any(v_questions::text[]);
  delete from public.exam_questions where exam_id = v_exam;
  delete from public.exams where id = v_exam;
  delete from public.questions where id = any(v_questions) and body like '%(live results check)';
  -- the rate-limit buckets the student endpoints fill (names verified live): session_join, session_save,
  -- session_submit, session_event, session_media
  delete from public.rate_limits where bucket like 'session\_%'
    and window_start > now() - interval '2 hours';

  raise notice 'cleanup: % sessions, % questions in the test exam', array_length(v_sessions, 1), array_length(v_questions, 1);
end $$;
