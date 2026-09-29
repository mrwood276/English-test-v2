-- TASK-015 (notifications): the dashboard bell (DEC-017, the owner's answers of 2026-09-26).
--
-- The owner chose: notices on the dashboard only for now — no email provider until one is chosen
-- (Supabase's built-in sender stays reserved for sign-in links) — and four kinds of notice:
-- essays waiting to be graded, finished exams with suspicious events, the newest backup, and
-- newly created staff accounts. When email comes later it will use the same event set, one
-- summary after each exam ends; nothing here blocks that.
--
-- Design: there is no notifications table to fill and prune. A notification is a *question about
-- data that is already there* — pending essays in `exam_results`, suspicious rows in
-- `session_events`, the newest row in `backups`, `account.create` rows in `audit_logs` — computed
-- at read time inside one function. The only state the system keeps is per person: when they last
-- opened the bell (`notification_reads`). Nothing to schedule, nothing to expire, and the bell can
-- never disagree with the screens it links to.
--
-- Like every staff function since ISSUE-020: only the service role may execute these (the Edge
-- layer calls them with `p_actor` taken from the session, never from the browser), and each
-- function re-checks its actor itself (DEC-004: the rules live in SQL). Every signed-in staff
-- member gets a bell; a teacher's carries the two teacher things (essays, suspicious events) and
-- an admin's adds the two system things (newest backup, newly created accounts).
--
-- APPLIED LIVE (2026-09-26, twenty-third session); to run SQL here: CLI 2.117.0 has no
-- `supabase db query` subcommand — use the Management API query endpoint
-- (POST /v1/projects/<ref>/database/query with {"query": "..."}) or the dashboard SQL editor.

-- ---------- when a person last opened the bell ----------
-- One row per person, created the first time they open the bell. Deleting an account (which the
-- system never does — DEC-031 — but the foreign key still guards) removes the row with it.
create table if not exists public.notification_reads (
  person_id uuid primary key references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- the staff gate (the same idea as _require_active_admin, for every role) ----------
-- Returns the signed-in person's profile row, or refuses the call. Every function below starts
-- here, so a deactivated account cannot read anything through this door either.
create or replace function public._actor_profile(p_actor uuid)
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare
  v_profile public.profiles;
begin
  if p_actor is null then
    raise exception 'Somebody has to be signed in.' using hint = 'validation';
  end if;
  select * into v_profile from public.profiles where id = p_actor;
  if not found then
    raise exception 'Your account no longer has a profile row.' using hint = 'validation';
  end if;
  if not v_profile.is_active then
    raise exception 'This account has been deactivated.' using hint = 'validation';
  end if;
  return v_profile;
end $$;

-- ---------- the reads ----------
-- Counting essays needs the same walk the results screen does: an exam result that is
-- `pending_review` waits for the essay questions in its own snapshot that have no grade yet.
create or replace function public._essay_notifications()
returns jsonb language sql stable security definer set search_path = public as $$
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
$$;

-- An exam is worth a look when a finished attempt raised a suspicious or violation event (the
-- session engine writes those severities on its own, from the exam's tab-switch limits) or when a
-- session crossed the flag limit on its counter. One card per exam, with the number to investigate.
create or replace function public._suspicious_notifications(p_days int)
returns jsonb language sql stable security definer set search_path = public as $$
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
$$;

create or replace function public.list_notifications(p_actor uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
  v_read := coalesce(v_read, to_timestamp(0)); -- never opened: everything counts as unread

  v_essays := public._essay_notifications();
  v_suspicious := public._suspicious_notifications(14);
  -- The backup and the new-account news point at admin screens (design.md 1.2), so only an admin's
  -- bell carries them; a teacher's bell is the two teacher things: essays and suspicious events.
  if v_me.role = 'admin' then
    select jsonb_build_object(
             'kind', b.kind, 'created_at', b.created_at, 'size_bytes', b.size_bytes,
             'created_by_name', p.full_name)
      into v_backup
      from public.backups b left join public.profiles p on p.id = b.created_by
      order by b.created_at desc, b.id desc limit 1;

    -- A created account is news once: within the last 14 days, audited (BR-13), never the password.
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', a.changes->>'email', 'full_name', a.changes->>'full_name',
             'role', a.changes->>'role', 'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
      into v_accounts
      from public.audit_logs a
      where a.action = 'account.create'
        and a.created_at >= now() - interval '14 days';
  end if;

  return jsonb_build_object(
    'kinds', jsonb_build_object(
      'essays', v_essays,
      'suspicious', v_suspicious,
      'backup', v_backup,
      'accounts', v_accounts),
    'essays', coalesce((select sum((x->>'waiting')::int) from jsonb_array_elements(v_essays) x), 0),
    'suspicious', (select count(*) from jsonb_array_elements(v_suspicious)),
    'account', (select count(*) from jsonb_array_elements(v_accounts)),
    'backup', case when v_backup is null then 0 else 1 end,
    'total', (select count(*) from jsonb_array_elements(v_essays))
           + (select count(*) from jsonb_array_elements(v_suspicious))
           + case when v_backup is null then 0 else 1 end
           + (select count(*) from jsonb_array_elements(v_accounts)),
    -- The JSON timestamps are text, so they are cast back before comparing (the live run caught this).
    'unread', (select count(*) from jsonb_array_elements(v_essays) x
                where (x->>'updated_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_suspicious) x
                where (x->>'last_at')::timestamptz > v_read)
            + (select count(*) from jsonb_array_elements(v_accounts) x
                where (x->>'created_at')::timestamptz > v_read)
            + case when v_backup is not null and (v_backup->>'created_at')::timestamptz > v_read then 1 else 0 end,
    'read_at', case when exists (select 1 from public.notification_reads where person_id = v_me.id)
                    then v_read end
  );
end $$;

-- Marks the bell opened: everything on it now counts as read. Returns the same shape as
-- `list_notifications`, so the screen can repaint from one call.
create or replace function public.mark_notifications_read(p_actor uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public._actor_profile(p_actor);
  insert into public.notification_reads (person_id, last_read_at, updated_at)
  values (p_actor, now(), now())
  on conflict (person_id) do update
    set last_read_at = excluded.last_read_at, updated_at = now();
  return public.list_notifications(p_actor, 50);
end $$;

-- ---------- privileges (ISSUE-020: only the service role calls staff functions) ----------
revoke all on function public._actor_profile(uuid) from public, anon, authenticated;
revoke all on function public._essay_notifications() from public, anon, authenticated;
revoke all on function public._suspicious_notifications(integer) from public, anon, authenticated;
revoke all on function public.list_notifications(uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_notifications_read(uuid) from public, anon, authenticated;
grant execute on function public._actor_profile(uuid) to service_role;
grant execute on function public._essay_notifications() to service_role;
grant execute on function public._suspicious_notifications(integer) to service_role;
grant execute on function public.list_notifications(uuid, integer) to service_role;
grant execute on function public.mark_notifications_read(uuid) to service_role;
