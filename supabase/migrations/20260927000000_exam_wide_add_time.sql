-- TASK-013 leftover + cleanup + one drift fix: more time for a WHOLE exam at once, one read path for
-- the monitor, and the two exam-limit fields the monitor's own status pill reads.
--
-- Two things happen here, both additive:
--
-- 1. `add_exam_time` — the exam-scope twin of BR-11 (`add_session_time`). A class that started late,
--    or a lesson that ran over, needs "everyone still working gets five more minutes" as ONE action:
--    one transaction, one audit row, one `time_added` event per session (meta.scope = 'exam'), and
--    `last_heartbeat_at` refreshed so the teacher's own action cannot make the whole class read as
--    "offline" on the board. It refuses 0 minutes, more than 2 hours, and an exam with nobody working,
--    so a mis-click can never write an audit row that says nothing happened.
--
-- 2. `list_live_sessions` is dropped. It was created directly on the live project by the concurrent
--    session that built its own monitor (it is the pair ISSUE-020 found live and never committed), and
--    it is now redundant: the shipped monitor reads `list_exam_results`, which carries the same facts
--    it needs (`answered_count`, `question_count`, `remaining_seconds`, `last_heartbeat_at`,
--    `tab_switch_count`). Keeping a second answer to "who is taking this test" is exactly the kind of
--    drift that hid a CRITICAL grant bug for a day — one monitor, one read function.
--
-- Live schema this file relies on: `exam_sessions` (status, ends_at, extra_seconds, last_heartbeat_at),
-- `session_events` (session_id, event_type, severity, meta), `exams` (id), `write_audit`.
--
-- Business rules touched: BR-11 (extra time, audited), BR-05/BR-20 (the server clock decides).
-- Applied live on 2026-09-24 via `npx supabase db query --linked --file`.
-- Idempotent: `create or replace` + `drop ... if exists`.

create or replace function public.add_exam_time(p_exam_id uuid, p_seconds int, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.exams%rowtype;
  v_sessions uuid[];
  v_n int;
begin
  if p_seconds is null or p_seconds < 60 or p_seconds > 7200 then
    raise exception 'Time can be added in steps between 1 minute and 2 hours.'
      using hint = 'validation';
  end if;

  select * into e from public.exams where id = p_exam_id;
  if not found then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(array_agg(id), '{}') into v_sessions
    from public.exam_sessions
   where exam_id = p_exam_id and status in ('in_progress', 'reopened');

  v_n := coalesce(array_length(v_sessions, 1), 0);
  if v_n = 0 then
    raise exception 'Nobody is taking this test right now, so there is no one to give time to.'
      using hint = 'validation';
  end if;

  update public.exam_sessions
     set extra_seconds = extra_seconds + p_seconds,
         ends_at = ends_at + make_interval(secs => p_seconds),
         last_heartbeat_at = now()
   where id = any(v_sessions);

  insert into public.session_events (session_id, event_type, severity, meta)
  select id, 'time_added', 'info',
         jsonb_build_object('seconds', p_seconds, 'scope', 'exam', 'exam_id', p_exam_id)
    from public.exam_sessions where id = any(v_sessions);

  perform public.write_audit(p_actor, 'add_time', 'exam', p_exam_id::text,
    jsonb_build_object('seconds', p_seconds, 'sessions', v_n));

  return jsonb_build_object(
    'updated', v_n,
    'added_seconds', p_seconds,
    'remaining_seconds', (select max(greatest(0, floor(extract(epoch from (s.ends_at - now())))::int))
                            from public.exam_sessions s where s.id = any(v_sessions)));
end $$;

-- The default privileges from 20260926000000_security_lockdown_function_execute.sql cover new
-- functions, but say it here too: a function is only ever callable by the service role (DEC-002).
revoke execute on function public.add_exam_time(uuid, integer, uuid) from public, anon, authenticated;

-- One read function for the monitor (see the header).
drop function if exists public.list_live_sessions(uuid);

-- ============ drift fix: the limits the monitor's status pill reads ============
-- `liveStatusPill` (frontend/assets/js/teacher/components/resultBits.js) decides "Left the page" /
-- "Need a look" from `row.tab_switch_warn_limit` and `row.tab_switch_flag_limit`, but the shipped
-- `list_exam_results` never sent them — the mocked server did, so the browser suite could not see it.
-- Against the real backend the pill therefore fell back to the built-in defaults (1 and 3): an exam whose
-- teacher set a different warning or flag limit would be labelled wrongly on the live board. The two
-- fields are added here (nothing else changes), and `frontend/tests/live_monitor_check.py` asserts a
-- non-default limit comes back in the payload.
create or replace function public.list_exam_results(p_exam_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e public.exams%rowtype;
  v_rows jsonb;
  v_summary jsonb;
begin
  select * into e from public.exams where id = p_exam_id;
  if not found then
    raise exception 'That exam was not found.' using hint = 'validation'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', t.id, 'student_name', t.student_name, 'student_class', t.student_class,
      'class_display', coalesce(ca.display_name, t.student_class),
      'attempt_no', t.attempt_no, 'status', t.status,
      'started_at', t.started_at, 'submitted_at', t.submitted_at, 'ends_at', t.ends_at,
      'remaining_seconds', case when t.status in ('in_progress', 'reopened')
        then greatest(0, floor(extract(epoch from (t.ends_at - now())))::int) end,
      'tab_switch_count', t.tab_switch_count,
      -- the exam's own limits, so the board reads a student exactly as this exam defines it
      'tab_switch_warn_limit', e.tab_switch_warn_limit,
      'tab_switch_flag_limit', e.tab_switch_flag_limit,
      'tab_switch_autosubmit_limit', e.tab_switch_autosubmit_limit,
      'last_heartbeat_at', t.last_heartbeat_at,
      'answered_count', t.answered_count,
      'question_count', t.question_count,
      'has_result', r.percentage is not null,
      'percentage', r.percentage, 'total_points', r.total_points, 'max_points', r.max_points,
      'pass_status', r.pass_status, 'result_status', r.status,
      'correct_count', r.correct_count, 'wrong_count', r.wrong_count,
      'time_used_seconds', r.time_used_seconds, 'pending_essays', t.pending_essays,
      'retake_granted', rp.id is not null, 'retake_used', rp.used_at is not null)
      order by coalesce(ca.display_name, t.student_class), t.student_name, t.attempt_no), '[]'::jsonb)
    into v_rows
    from (
      select s.id, s.student_name, s.student_class, s.student_class_normalized,
             s.student_name_normalized, s.attempt_no, s.status, s.started_at, s.submitted_at,
             s.ends_at, s.tab_switch_count, s.last_heartbeat_at,
             (select count(*)::int from public.session_answers a
               where a.session_id = s.id
                 and a.answer is not null
                 and coalesce(a.answer->>'text', '') <> '') as answered_count,
             coalesce(jsonb_array_length(s.questions_snapshot), 0) as question_count,
             case when rr.status = 'pending_review' then (
               select count(*) from jsonb_array_elements(rr.review_snapshot) x
                where x->>'type' = 'essay'
                  and not exists (select 1 from public.answer_grades g
                                   where g.session_id = s.id and g.question_id = (x->>'question_id')::uuid)
             ) else 0 end as pending_essays
        from public.exam_sessions s
        left join public.exam_results rr on rr.session_id = s.id
       where s.exam_id = p_exam_id
    ) t
    left join public.class_aliases ca on ca.alias_normalized = t.student_class_normalized
    left join lateral (
      select rp.id, rp.used_at from public.retake_permissions rp
       where rp.exam_id = p_exam_id
         and rp.student_name_normalized = t.student_name_normalized
         and rp.student_class_normalized = t.student_class_normalized
       order by rp.granted_at desc limit 1
    ) rp on true
    left join public.exam_results r on r.session_id = t.id;

  select jsonb_build_object(
      'with_result', count(*) filter (where (r->>'has_result')::boolean),
      'in_progress', count(*) filter (where r->>'status' in ('in_progress', 'reopened')),
      'average', round(avg((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean), 1),
      'highest', max((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean),
      'lowest', min((r->>'percentage')::numeric) filter (where (r->>'has_result')::boolean),
      'passed', count(*) filter (where r->>'pass_status' = 'passed'),
      'failed', count(*) filter (where r->>'pass_status' = 'failed'),
      'not_final', count(*) filter (where r->>'pass_status' = 'not_final'),
      'pending_essays', coalesce(sum((r->>'pending_essays')::int), 0))
    into v_summary
    from jsonb_array_elements(v_rows) r;

  return jsonb_build_object(
    'exam', jsonb_build_object('id', e.id, 'title', e.title, 'status', e.status,
      'access_code', e.access_code, 'duration_minutes', e.duration_minutes,
      'passing_grade', e.passing_grade, 'result_visibility', e.result_visibility,
      'essay_pending_display', e.essay_pending_display, 'starts_at', e.starts_at, 'ends_at', e.ends_at),
    'summary', v_summary, 'rows', v_rows);
end $$;

revoke all on function public.list_exam_results(uuid) from public, anon, authenticated;
grant execute on function public.list_exam_results(uuid) to service_role;
