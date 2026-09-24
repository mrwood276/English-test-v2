-- TASK-014 (dashboard, mockup 5): `list_exam_activity` gains the two counts the "Recent exams"
-- card needs — how many students passed and how many failed — so the dashboard can show its
-- "N% passed" meter from the same single read the Grading and Results hubs already use.
-- Additive only: the function keeps its shape and every existing field; the Edge Function needs
-- no change because it passes the SQL function's JSON through untouched.
--
-- Business rules touched: none (a read function; the pass/fail split is already decided by
-- `_session_result_write`). Privileges stay as ISSUE-020 left them: only the service role may call it.
-- Idempotent: `create or replace` + explicit revoke/grant.

create or replace function public.list_exam_activity(p_include_templates boolean default false)
returns jsonb language sql stable security definer set search_path = public as $$
  with agg as (
    select s.exam_id,
           count(*) as sessions,
           count(*) filter (where s.status in ('submitted', 'auto_submitted', 'timed_out')) as finished,
           count(*) filter (where s.status in ('in_progress', 'reopened')) as in_progress,
           count(*) filter (where r.pass_status = 'passed') as passed,
           count(*) filter (where r.pass_status = 'failed') as failed,
           max(s.submitted_at) as last_submitted_at,
           round(avg(r.percentage), 1) as average,
           coalesce(sum(case when r.status = 'pending_review' then (
             select count(*) from jsonb_array_elements(r.review_snapshot) x
              where x->>'type' = 'essay'
                and not exists (select 1 from public.answer_grades g
                                 where g.session_id = s.id and g.question_id = (x->>'question_id')::uuid)
           ) else 0 end), 0)::int as pending_essays
      from public.exam_sessions s
      left join public.exam_results r on r.session_id = s.id
     group by s.exam_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'exam_id', e.id, 'title', e.title, 'access_code', e.access_code, 'status', e.status,
      'is_template', e.is_template, 'passing_grade', e.passing_grade,
      'essay_questions', (select count(*) from public.exam_questions w
                            join public.questions q on q.id = w.question_id
                           where w.exam_id = e.id and q.type = 'essay'),
      'sessions', a.sessions, 'finished', a.finished, 'in_progress', a.in_progress,
      'passed', a.passed, 'failed', a.failed,
      'pending_essays', a.pending_essays, 'average', a.average, 'last_submitted_at', a.last_submitted_at)
    order by a.pending_essays desc, a.last_submitted_at desc nulls last), '[]'::jsonb)
    from public.exams e
    join agg a on a.exam_id = e.id
   where p_include_templates or not e.is_template
$$;

revoke all on function public.list_exam_activity(boolean) from public, anon, authenticated;
grant execute on function public.list_exam_activity(boolean) to service_role;
