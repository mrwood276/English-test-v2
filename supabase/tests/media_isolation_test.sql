-- SQL test for teacher data isolation in media (DEC-041, the media slice — mirrors TASK-048).
-- Run against the v2 project as ONE request (one request = one session), rolled back:
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--
-- Creates its own media rows (marked TASK-MED) and lets the transaction abort at the end,
-- so nothing it writes survives — the ERROR MESSAGE is the result:
--   "MEDIA ISOLATION TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"          → a rule is broken
--
-- The matrix (DEC-041): a teacher sees and changes only their own media; a foreign id is
-- exactly as invisible as a missing one; an active admin sees the whole school; a null actor
-- fails closed.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

create or replace function pg_temp.expect_error(sql text, needle text, msg text)
returns void language plpgsql as $$
declare v_hint text;
begin
  begin
    execute sql;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if position(needle in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % (error said: %)', msg, sqlerrm;
    end if;
    if v_hint is distinct from 'validation' then
      raise exception 'ASSERT FAILED: % (the hint was %, not validation — the teacher would see a 500)', msg, coalesce(v_hint, '<none>');
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % (it was allowed)', msg;
end $$;

do $med_isolation$
declare
  v_admin uuid;
  v_teacher uuid;
  v_mt uuid;    -- teacher's media
  v_ma uuid;    -- admin's media
  v_q uuid;     -- teacher's question (for linking)
  v_res jsonb;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and an active teacher to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.link_media(text, uuid, jsonb, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.link_media(text, uuid, jsonb, uuid)', 'execute'),
    'anon and authenticated cannot execute link_media');
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.get_media_paths(uuid[], uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_media_paths(uuid[], uuid)', 'execute'),
    'anon and authenticated cannot execute get_media_paths');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.link_media(text, uuid, jsonb, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_media_paths(uuid[], uuid)', 'execute'),
    'service_role can execute the isolated functions');

  -- ---------- two media files, one per owner ----------
  insert into public.media_files (kind, storage_path, mime_type, size_bytes, uploaded_by, original_name)
  values ('image', 'image/2026/11111111-1111-1111-1111-111111111111.jpg', 'image/jpeg', 100000, v_teacher, 'TASK-MED teacher')
  returning id into v_mt;
  insert into public.media_files (kind, storage_path, mime_type, size_bytes, uploaded_by, original_name)
  values ('image', 'image/2026/22222222-2222-2222-2222-222222222222.jpg', 'image/jpeg', 100000, v_admin, 'TASK-MED admin')
  returning id into v_ma;

  -- ---------- get_media_paths is scoped ----------
  -- Use jsonb_array_length to check how many rows come back.
  perform pg_temp.assert_true(
    jsonb_array_length(public.get_media_paths(array[v_mt, v_ma], v_teacher)) = 1,
    'a teacher gets paths for only their own media');
  perform pg_temp.assert_true(
    jsonb_array_length(public.get_media_paths(array[v_mt, v_ma], v_admin)) = 2,
    'the admin gets paths for both media files');
  perform pg_temp.assert_true(
    jsonb_array_length(public.get_media_paths(array[v_mt, v_ma], null)) = 0,
    'a null actor fails closed');

  -- ---------- link_media refuses foreign files ----------
  v_q := public.save_question(null, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-MED test',
    'body', 'TASK-MED isolation question', 'class_labels', jsonb_build_array('TASK-MED A'),
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_teacher);
  perform pg_temp.expect_error(format(
    'select public.link_media(''question'', %L::uuid, ''[{"id":%L}]''::jsonb, %L::uuid)',
    v_q, v_ma, v_teacher),
    'A file no longer exists.', 'a teacher cannot link the admin media to their question');
  perform pg_temp.expect_error(format(
    'select public.link_media(''question'', %L::uuid, ''[{"id":%L}]''::jsonb, %L::uuid)',
    v_q, v_ma, null),
    'A file no longer exists.', 'a null actor cannot link media');

  -- ---------- link_media attaches own files fine ----------
  perform public.link_media('question', v_q, jsonb_build_array(jsonb_build_object('id', v_mt)), v_teacher);
  perform pg_temp.assert_true(
    exists (select 1 from public.question_media where question_id = v_q and media_id = v_mt),
    'a teacher links their own media to their own question');

  -- ---------- save_question forwards p_actor to link_media ----------
  perform public.save_question(v_q, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-MED test',
    'body', 'TASK-MED isolation question (edited by the admin)',
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false)),
    'media', jsonb_build_array(jsonb_build_object('id', v_ma))), v_admin);
  perform pg_temp.assert_true(
    exists (select 1 from public.question_media where question_id = v_q and media_id = v_ma),
    'the admin links their media to the teacher question (admin bypass)');

  raise exception 'MEDIA ISOLATION TESTS PASSED (a teacher sees and changes only their own media; a foreign id is the missing-row sentence; the admin sees the whole school; all rolled back)';
end
$med_isolation$;
