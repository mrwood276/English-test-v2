-- Recovered from the live Supabase project on 2026-09-28.
-- The original migration text was not available through the management connector.
-- This is a reconstructed source representation, not a claim of byte-for-byte historical SQL.

create table if not exists public.notification_reads (
  person_id uuid primary key references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public._essay_notifications()
returns jsonb language sql stable security definer set search_path = 'public'
as $function$
  with waiting as (
    select r.session_id, s.exam_id, s.student_name, s.student_class, r.updated_at,
           (select count(*) from jsonb_array_elements(r.review_snapshot) x
             where x->>'type' = 'essay'
               and not exists (select 1 from public.answer_grades g
                                where g.session_id = r.session_id
                                  and g.question_id = (x->>'question_id')::uuid))::int as waiting
      from public.exam_results r
      join public.exam_sessions s on s.id = r.session_id
     where r.status = 'pending_review'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'exam_id', t.exam_id, 'title', e.title, 'access_code', e.access_code,
           'waiting', t.waiting, 'student_name', t.student_name, 'student_class', t.student_class,
           'session_id', t.session_id, 'updated_at', t.updated_at) order by t.updated_at desc), '[]'::jsonb)
    from waiting t
    join public.exams e on e.id = t.exam_id
$function$;

create or replace function public._suspicious_notifications(p_days integer)
returns jsonb language sql stable security definer set search_path = 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'exam_id', e.id, 'title', e.title, 'access_code', e.access_code,
           'events', t.events, 'sessions', t.sessions, 'last_at', t.last_at) order by t.last_at desc), '[]'::jsonb)
    from (
      select s.exam_id,
             count(*)::int as events,
             count(distinct s.id)::int as sessions,
             max(v.occurred_at) as last_at
        from public.session_events v
        join public.exam_sessions s on s.id = v.session_id
       where v.severity in ('suspicious', 'violation')
         and v.occurred_at >= now() - make_interval(days => p_days)
       group by s.exam_id
    ) t
    join public.exams e on e.id = t.exam_id
$function$;

create or replace function public.list_notifications(p_actor uuid, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = 'public'
as $function$
declare
  v_me public.profiles;
  v_limit int := coalesce(p_limit, 50);
  v_read timestamptz;
  v_essays jsonb;
  v_suspicious jsonb;
  v_backup jsonb;
  v_accounts jsonb;
begin
  if v_limit < 1 or v_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;
  v_me := public._actor_profile(p_actor);
  select last_read_at into v_read from public.notification_reads where person_id = v_me.id;
  v_read := coalesce(v_read, to_timestamp(0));
  v_essays := public._essay_notifications();
  v_suspicious := public._suspicious_notifications(14);
  if v_me.role = 'admin' then
    select jsonb_build_object('kind', b.kind, 'created_at', b.created_at, 'size_bytes', b.size_bytes,
             'created_by_name', p.full_name)
      into v_backup
      from public.backups b left join public.profiles p on p.id = b.created_by
      order by b.created_at desc, b.id desc limit 1;
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', a.changes->>'email', 'full_name', a.changes->>'full_name',
             'role', a.changes->>'role', 'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
      into v_accounts
      from public.audit_logs a
      where a.action = 'account.create'
        and a.created_at >= now() - interval '14 days';
  end if;
  return jsonb_build_object(
    'kinds', jsonb_build_object('essays', v_essays, 'suspicious', v_suspicious,
      'backup', v_backup, 'accounts', v_accounts),
    'essays', coalesce((select sum((x->>'waiting')::int) from jsonb_array_elements(v_essays) x), 0),
    'suspicious', (select count(*) from jsonb_array_elements(v_suspicious)),
    'account', (select count(*) from jsonb_array_elements(v_accounts)),
    'backup', case when v_backup is null then 0 else 1 end,
    'total', (select count(*) from jsonb_array_elements(v_essays))
           + (select count(*) from jsonb_array_elements(v_suspicious))
           + case when v_backup is null then 0 else 1 end
           + (select count(*) from jsonb_array_elements(v_accounts)),
    'unread', (select count(*) from jsonb_array_elements(v_essays) x where (x->>'updated_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_suspicious) x where (x->>'last_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_accounts) x where (x->>'created_at')::timestamptz > v_read)
            + case when v_backup is not null and (v_backup->>'created_at')::timestamptz > v_read then 1 else 0 end,
    'read_at', case when exists (select 1 from public.notification_reads where person_id = v_me.id) then v_read end
  );
end $function$;

create or replace function public.mark_notifications_read(p_actor uuid)
returns jsonb language plpgsql security definer set search_path = 'public'
as $function$
begin
  perform public._actor_profile(p_actor);
  insert into public.notification_reads (person_id, last_read_at, updated_at)
  values (p_actor, now(), now())
  on conflict (person_id) do update set last_read_at = excluded.last_read_at, updated_at = now();
  return public.list_notifications(p_actor, 50);
end $function$;

revoke execute on function public._essay_notifications() from public, anon, authenticated;
revoke execute on function public._suspicious_notifications(integer) from public, anon, authenticated;
revoke execute on function public.list_notifications(uuid, integer) from public, anon, authenticated;
revoke execute on function public.mark_notifications_read(uuid) from public, anon, authenticated;
grant execute on function public._essay_notifications() to service_role;
grant execute on function public._suspicious_notifications(integer) to service_role;
grant execute on function public.list_notifications(uuid, integer) to service_role;
grant execute on function public.mark_notifications_read(uuid) to service_role;
