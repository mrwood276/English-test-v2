-- SQL test for the notification functions (TASK-015, DEC-017).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
-- Passed live on 2026-09-26. Extended 2026-09-29 (DEC-037) with the `notification_reads` RLS
-- assertion below; that assertion has NOT been re-run live (no credential in that session) —
-- TASK-026.
--
-- Read-only in effect: the only table it writes is `notification_reads`, and the transaction aborts
-- at the end, so nothing survives — the error message IS the result:
--   "NOTIFICATION TESTS PASSED (...)"  → every assertion held
--   "ASSERT FAILED: <message>"         → a rule is broken
--
-- What is checked: nobody but the service role can run any of it (ISSUE-020's revoke/grant rule);
-- a call with nobody signed in, an unknown actor and a deactivated account are all refused by the
-- functions themselves (DEC-004: the gate lives in SQL, not only at the Edge); the list answers in
-- the promised shape (four kinds, four counters, total = the sum of its parts) and is scoped by
-- role — a teacher's bell carries the two teacher things and no admin news; marking the bell read
-- really writes the one row, zeroes the unread counter and is reported back as `read_at`; and the
-- essay, suspicious and account cards are honest — a card only names a session that really waits in
-- `exam_results`, events that really carry the suspicious/violation severity within the window, or
-- a real recent `account.create` audit row.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(needle in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (error said: %)', msg, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $notif$
declare
  v_admin uuid;
  v_teacher uuid;
  v_out jsonb;
  v_teacher_out jsonb;
  v_again jsonb;
  v_kinds jsonb;
  v_parts int;
  v_suspicious int := 0;
  v_accounts int := 0;
  v_backup int := 0;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and a teacher to test against');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not exists (
      select 1 from unnest(array[
        'public._actor_profile(uuid)',
        'public._essay_notifications()',
        'public._suspicious_notifications(integer)',
        'public.list_notifications(uuid, integer)',
        'public.mark_notifications_read(uuid)']) sig
      where has_function_privilege('anon', sig::regprocedure, 'execute')
         or has_function_privilege('authenticated', sig::regprocedure, 'execute')),
    'anon and authenticated may execute none of the notification functions');
  -- The table behind the bell is on the same baseline as every other one (DEC-002, DEC-037): RLS on
  -- with no policies. Losing the RLS flag is the drift the live reconciliation recorded; the grant
  -- check above covers the other half of the boundary.
  perform pg_temp.assert_true(
    (select relrowsecurity from pg_class where oid = 'public.notification_reads'::regclass),
    'notification_reads has row level security enabled');

  perform pg_temp.expect_error('select public.list_notifications(null, 50)',
    'Somebody has to be signed in', 'a call with nobody signed in is refused');
  perform pg_temp.expect_error(format('select public.list_notifications(%L::uuid, 50)', gen_random_uuid()),
    'no longer has a profile row', 'a call for an unknown actor is refused');
  perform pg_temp.expect_error(format('select public.list_notifications(%L::uuid, 0)', v_admin),
    'between 1 and 200', 'the limit has bounds');

  -- a deactivated account is stopped by the functions too, not only by the Edge gate
  perform public.update_account(v_teacher, null, null, false, v_admin);
  perform pg_temp.expect_error(format('select public.list_notifications(%L::uuid, 50)', v_teacher),
    'deactivated', 'a deactivated account cannot read the bell');
  perform public.update_account(v_teacher, null, null, true, v_admin);

  -- ---------- the shape of the list ----------
  delete from public.notification_reads where person_id in (v_admin, v_teacher); -- this test's own rows only
  v_out := public.list_notifications(v_admin, 50);
  v_kinds := v_out -> 'kinds';
  perform pg_temp.assert_true(
    v_kinds ? 'essays' and v_kinds ? 'suspicious' and v_kinds ? 'backup' and v_kinds ? 'accounts',
    'the admin list carries the four kinds the owner chose');
  perform pg_temp.assert_true(
    jsonb_typeof(v_kinds -> 'essays') = 'array' and jsonb_typeof(v_kinds -> 'suspicious') = 'array'
      and jsonb_typeof(v_kinds -> 'accounts') = 'array',
    'essay, suspicious and account news are lists');
  perform pg_temp.assert_true((v_out ->> 'essays') ~ '^\d+$' and (v_out ->> 'unread') ~ '^\d+$',
    'the counters are whole numbers');

  -- a teacher's bell is the teacher half: no backup, no account news (absent kinds come back as jsonb null)
  v_teacher_out := public.list_notifications(v_teacher, 50);
  perform pg_temp.assert_true(
    (v_teacher_out -> 'kinds' ->> 'backup') is null
      and (jsonb_typeof(v_teacher_out -> 'kinds' -> 'accounts') <> 'array'
           or jsonb_array_length(v_teacher_out -> 'kinds' -> 'accounts') = 0)
      and (v_teacher_out ->> 'backup')::int = 0 and (v_teacher_out ->> 'account')::int = 0,
    'a teacher''s bell carries no backup or new-account news (they are admin screens)');
  perform pg_temp.assert_true(v_teacher_out ? 'essays' and v_teacher_out ? 'suspicious',
    'a teacher''s bell still carries the two teacher kinds');

  -- total = the sum of its parts (the badge can never disagree with the panel)
  v_suspicious := jsonb_array_length(v_kinds -> 'suspicious');
  v_accounts := jsonb_array_length(v_kinds -> 'accounts');
  -- ->> not ->: a jsonb null member is not SQL null, and the bell's "no backup" must not count as a card
  v_backup := case when (v_kinds ->> 'backup') is null then 0 else 1 end;
  v_parts := (select count(*) from jsonb_array_elements(v_kinds -> 'essays'))
           + v_suspicious + v_accounts + v_backup;
  perform pg_temp.assert_true((v_out ->> 'total')::int = v_parts,
    'the total counts the cards, not more and not less');

  -- ---------- the cards are honest ----------
  perform pg_temp.assert_true(
    not exists (
      select 1 from jsonb_array_elements(v_kinds -> 'essays') x
       where (x ->> 'waiting')::int < 1
          or not exists (select 1 from public.exam_results r
                          where r.session_id = (x ->> 'session_id')::uuid
                            and r.status = 'pending_review')),
    'every essay card names a session that really waits for grading');
  perform pg_temp.assert_true(
    not exists (
      select 1 from jsonb_array_elements(v_kinds -> 'suspicious') x
       where (x ->> 'events')::int < 1
          or not exists (select 1 from public.session_events v
                          join public.exam_sessions s on s.id = v.session_id
                         where s.exam_id = (x ->> 'exam_id')::uuid
                           and v.severity in ('suspicious', 'violation')
                           and v.occurred_at >= now() - interval '14 days')),
    'every suspicious card names an exam with recent suspicious events');
  perform pg_temp.assert_true(
    not exists (
      select 1 from jsonb_array_elements(v_kinds -> 'accounts') x
       where not exists (select 1 from public.audit_logs a
                          where a.action = 'account.create'
                            and a.changes ->> 'email' = x ->> 'email'
                            and a.created_at >= now() - interval '14 days')),
    'every account card comes from a real, recent account.create audit row');

  -- ---------- marking the bell read ----------
  perform pg_temp.assert_true((v_out ->> 'read_at') is null,
    'before the first open, nothing was ever marked read');
  v_out := public.mark_notifications_read(v_admin);
  perform pg_temp.assert_true((v_out ->> 'unread')::int = 0,
    'marking the bell read zeroes the unread counter');
  perform pg_temp.assert_true((v_out ->> 'read_at') is not null,
    'and the answer reports when it was read');
  perform pg_temp.assert_true(exists (select 1 from public.notification_reads where person_id = v_admin),
    'the one read-mark row exists');
  v_again := public.list_notifications(v_admin, 50);
  perform pg_temp.assert_true((v_again ->> 'unread')::int = 0,
    'a fresh list after the mark still counts zero unread');
  perform pg_temp.assert_true(
    coalesce((v_again -> 'kinds' -> 'essays') = (v_out -> 'kinds' -> 'essays'), true),
    'marking did not change what the bell lists');

  -- ---------- the invariant ----------
  raise exception 'NOTIFICATION TESTS PASSED (% essay cards, % suspicious exams, % account news, % backup, total % cards, % unread after the mark — all rolled back)',
    jsonb_array_length(v_kinds -> 'essays'), v_suspicious, v_accounts, v_backup,
    (v_out ->> 'total')::int, (v_again ->> 'unread')::int;
end $notif$;
