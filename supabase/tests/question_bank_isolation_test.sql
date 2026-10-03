-- SQL test for teacher data isolation in the question bank (TASK-048, DEC-041).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadqmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
--
-- It creates its own questions and reading texts (marked TASK-048) and lets the transaction abort at
-- the end, so nothing it writes survives — the ERROR MESSAGE is the result:
--   "QUESTION BANK ISOLATION TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"                  → a rule is broken
--
-- NOT YET RUN LIVE (written 2026-10-03, TASK-048): no Management credential was available in the
-- session that wrote it. The live session applies `20261003000000_question_bank_isolation.sql` with
-- its `schema_migrations` row, redeploys the `question-bank` Edge Function, then runs this file; the
-- result belongs in the migration's header and in `.ai/`.
--
-- The red proof for the fix: on the pre-fix functions every teacher-actor assertion below fails —
-- `get_question` returns the admin's question instead of null, `save_question`/`set_question_archived`
--/`remove_question` on a foreign id succeed instead of raising, the bulk change matches both ids,
-- the duplicate scan reports the cross-owner group, and the import matches the admin's reading text
-- by title, so the expected "does not exist yet" refusal never happens.
--
-- The matrix (DEC-041, the strict model): a teacher sees and changes only their own questions and
-- reading texts; a foreign id is exactly as invisible as a missing one (the same sentence, the same
-- `hint = 'validation'`, so the Edge function answers a friendly 400 and nothing leaks existence);
-- an active admin sees and changes the whole school. A null actor fails closed. The two actors are
-- the project's own live profiles — the admin and the teacher the accounts test also uses — because
-- `profiles` cannot exist without its `auth.users` row, which a test cannot mint. The owner-vs-admin
-- denial below IS a real cross-owner denial; the filter it exercises is the same one that separates
-- two teachers.
--
-- What is checked: the boundary (only the service role may execute the functions); `_is_staff_admin`
-- is true for the admin, false for the teacher and for null; a teacher's list/get/save/archive/
-- remove/bulk change never reach an admin-owned row (read → null, writes → the missing-row sentence);
-- a question cannot point at another person's reading text and an import cannot match it by title
-- (the actor's own missing passage is the error instead); topics stay a shared taxonomy but their
-- question counts, and the class-label list, count the actor's own questions only; the duplicate
-- check and the whole-bank scan never report a cross-owner pair; and the admin sees and changes
-- everything.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

-- The denials must carry `hint = 'validation'` so the Edge function answers a friendly 400 instead of
-- a hidden 500 — the same demand the other SQL tests make.
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

do $qb_isolation$
declare
  v_admin uuid;
  v_teacher uuid;
  v_qt uuid;      -- the teacher's own question
  v_qa uuid;      -- the admin's question (identical body: the cross-owner duplicate pair)
  v_pt uuid;      -- the teacher's own reading text
  v_pa uuid;      -- the admin's reading text
  v_res jsonb;
begin
  select id into v_admin from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  select id into v_teacher from public.profiles where role = 'teacher' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_admin is not null and v_teacher is not null,
    'the project has an active admin and an active teacher to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.get_question(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_question(uuid, uuid)', 'execute'),
    'anon and authenticated cannot execute get_question');
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public.list_questions(jsonb, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_questions(jsonb, uuid)', 'execute'),
    'anon and authenticated cannot execute list_questions');
  perform pg_temp.assert_true(
    not has_function_privilege('anon', 'public._is_staff_admin(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._is_staff_admin(uuid)', 'execute'),
    'anon and authenticated cannot execute _is_staff_admin');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.get_question(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.list_questions(jsonb, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.find_duplicate_groups(real, int, uuid)', 'execute')
    and has_function_privilege('service_role', 'public._is_staff_admin(uuid)', 'execute'),
    'service_role can execute the isolated functions');
  perform pg_temp.assert_true(
    public._is_staff_admin(v_admin) and not public._is_staff_admin(v_teacher) and not public._is_staff_admin(null),
    '_is_staff_admin is true for the admin, false for a teacher and for null');

  -- ---------- the two owners' questions: same body, same topic, different labels ----------
  v_qt := public.save_question(null, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-048 test',
    'body', 'TASK-048 isolation question', 'class_labels', jsonb_build_array('TASK-048 A'),
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_teacher);
  v_qa := public.save_question(null, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-048 test',
    'body', 'TASK-048 isolation question', 'class_labels', jsonb_build_array('TASK-048 B'),
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_admin);
  perform pg_temp.assert_true(v_qt is distinct from v_qa, 'the two owners hold separate questions');

  -- ---------- the list is scoped ----------
  perform pg_temp.assert_true(
    (public.list_questions(jsonb_build_object('topic', 'TASK-048 test'), v_teacher) ->> 'total')::int = 1,
    'a teacher lists only their own question on the shared topic');
  perform pg_temp.assert_true(
    (public.list_questions(jsonb_build_object('topic', 'TASK-048 test'), v_admin) ->> 'total')::int = 2,
    'the admin lists the whole school (both questions)');
  perform pg_temp.assert_true(
    not exists (select 1 from jsonb_array_elements((public.list_questions(jsonb_build_object('topic', 'TASK-048 test'), v_teacher) -> 'items')) x
                 where (x ->> 'id')::uuid = v_qa),
    'the admin question is not in the teacher list');

  -- ---------- reading one foreign id is reading a missing one ----------
  perform pg_temp.assert_true(public.get_question(v_qt, v_teacher) is not null, 'a teacher reads their own question');
  perform pg_temp.assert_true(public.get_question(v_qa, v_teacher) is null,
    'a teacher reading the admin question gets exactly what a missing id gets: null');
  perform pg_temp.assert_true(public.get_question(v_qa, v_admin) is not null, 'the admin reads the teacher question too');
  perform pg_temp.assert_true(public.get_question(v_qt, v_admin) is not null, 'the admin reads their own question');
  perform pg_temp.assert_true(public.get_question(v_qt, null) is null, 'a null actor fails closed');

  -- ---------- writing a foreign id is the missing-row sentence (friendly 400, no existence leak) ----------
  perform pg_temp.expect_error(format(
    'select public.save_question(%L::uuid, ''{"type":"multiple_choice","difficulty":"medium","topic":"TASK-048 test","body":"hijack","options":[{"body":"A","is_correct":true},{"body":"B","is_correct":false}]}''::jsonb, %L::uuid)',
    v_qa, v_teacher),
    'That question no longer exists.', 'a teacher cannot edit the admin question');
  perform pg_temp.expect_error(format('select public.set_question_archived(%L::uuid, true, %L::uuid)', v_qa, v_teacher),
    'That question no longer exists.', 'a teacher cannot archive the admin question');
  perform pg_temp.expect_error(format('select public.remove_question(%L::uuid, %L::uuid)', v_qa, v_teacher),
    'That question no longer exists.', 'a teacher cannot delete the admin question');
  perform pg_temp.expect_error(format(
    'select public.bulk_update_questions(array[%L::uuid]::uuid[], ''{"difficulty":"easy"}''::jsonb, %L::uuid)', v_qa, v_teacher),
    'Those questions no longer exist.', 'a bulk change on only foreign ids is refused for a teacher');
  v_res := public.bulk_update_questions(array[v_qt, v_qa], jsonb_build_object('difficulty', 'easy'), v_teacher);
  perform pg_temp.assert_true((v_res ->> 'matched')::int = 1 and (v_res ->> 'missing')::int = 1,
    'a mixed bulk change silently counts the foreign id as missing');

  -- ---------- reading texts ----------
  v_pt := public.save_passage(null, jsonb_build_object('title', 'TASK-048 teacher text', 'body', 'A teacher reading text.'), v_teacher);
  v_pa := public.save_passage(null, jsonb_build_object('title', 'TASK-048 admin text', 'body', 'An admin reading text.'), v_admin);
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(public.list_passages(null, v_teacher)) x where (x ->> 'id')::uuid = v_pt)
    and not exists (select 1 from jsonb_array_elements(public.list_passages(null, v_teacher)) x where (x ->> 'id')::uuid = v_pa),
    'a teacher lists only their own reading texts');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(public.list_passages(null, v_admin)) x where (x ->> 'id')::uuid = v_pt),
    'the admin lists the whole school');
  perform pg_temp.assert_true(public.get_passage(v_pt, v_teacher) is not null, 'a teacher reads their own reading text');
  perform pg_temp.assert_true(public.get_passage(v_pa, v_teacher) is null,
    'a teacher reading the admin reading text gets what a missing id gets');
  perform pg_temp.expect_error(format(
    'select public.save_passage(%L::uuid, ''{"title":"hijacked","body":"nope"}''::jsonb, %L::uuid)', v_pa, v_teacher),
    'That reading text no longer exists.', 'a teacher cannot edit the admin reading text');
  perform pg_temp.expect_error(format('select public.remove_passage(%L::uuid, %L::uuid)', v_pa, v_teacher),
    'That reading text no longer exists.', 'a teacher cannot delete the admin reading text');
  perform pg_temp.expect_error(format(
    'select public.save_question(null, %L::jsonb, %L::uuid)',
    jsonb_build_object('type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-048 test',
      'body', 'TASK-048 points at the admin text', 'passage_id', v_pa,
      'options', jsonb_build_array(jsonb_build_object('body', 'A', 'is_correct', true),
                                   jsonb_build_object('body', 'B', 'is_correct', false)))::text, v_teacher),
    'That reading text no longer exists.', 'a question cannot point at another person reading text');

  -- ---------- shared taxonomy, own counts ----------
  perform pg_temp.assert_true(
    (select (x ->> 'question_count')::int from jsonb_array_elements(public.list_topics(v_teacher)) x
      where x ->> 'name' = 'TASK-048 test') = 1,
    'the topic count is the teacher own');
  perform pg_temp.assert_true(
    (select (x ->> 'question_count')::int from jsonb_array_elements(public.list_topics(v_admin)) x
      where x ->> 'name' = 'TASK-048 test') = 2,
    'the topic count is the whole school for the admin');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(public.list_class_labels(null, v_teacher)) x
             where x ->> 'label' = 'TASK-048 A' and (x ->> 'question_count')::int = 1)
    and not exists (select 1 from jsonb_array_elements(public.list_class_labels(null, v_teacher)) x
                     where x ->> 'label' = 'TASK-048 B'),
    'the class labels are the teacher own');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(public.list_class_labels(null, v_admin)) x where x ->> 'label' = 'TASK-048 A')
    and exists (select 1 from jsonb_array_elements(public.list_class_labels(null, v_admin)) x where x ->> 'label' = 'TASK-048 B'),
    'the admin sees both owners class labels');

  -- ---------- the duplicate check and the whole-bank scan ----------
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public.find_similar_questions('TASK-048 isolation question', array['Yes', 'No'], null, 0.55, v_teacher)) x
      where (x ->> 'id')::uuid = v_qa) = 0
    and exists (select 1 from jsonb_array_elements(public.find_similar_questions('TASK-048 isolation question', array['Yes', 'No'], null, 0.55, v_teacher)) x
                 where (x ->> 'id')::uuid = v_qt),
    'the duplicate check matches only the teacher own question');
  perform pg_temp.assert_true(
    (select count(*) from jsonb_array_elements(public.find_similar_questions('TASK-048 isolation question', array['Yes', 'No'], null, 0.55, v_admin)) x
      where (x ->> 'id')::uuid in (v_qa, v_qt)) = 2,
    'the admin duplicate check sees both');
  perform pg_temp.assert_true(
    not exists (select 1 from jsonb_array_elements(coalesce((public.find_duplicate_groups(0.55, 200, v_teacher) -> 'exact_groups'), '[]'::jsonb)) g
                 where (g -> 'questions') @> jsonb_build_array(jsonb_build_object('id', v_qa::text))),
    'the teacher whole-bank scan never reports a group holding the admin question');
  perform pg_temp.assert_true(
    exists (select 1 from jsonb_array_elements(coalesce((public.find_duplicate_groups(0.55, 200, v_admin) -> 'exact_groups'), '[]'::jsonb)) g
             where (g -> 'questions') @> jsonb_build_array(jsonb_build_object('id', v_qa::text))),
    'the admin whole-bank scan sees the cross-owner exact group');
  perform pg_temp.assert_true(
    not exists (
      select 1
        from jsonb_array_elements(public.find_similar_batch(
               jsonb_build_array(jsonb_build_object('i', 0, 'body', 'TASK-048 isolation question', 'options', jsonb_build_array('Yes', 'No'))),
               0.55, v_teacher)) r
        cross join lateral jsonb_array_elements(coalesce(r -> 'matches', '[]'::jsonb)) x
       where (x ->> 'id')::uuid = v_qa),
    'the import pre-check does not match against the admin questions');

  -- ---------- import: a reading text matches only the actor own ----------
  perform pg_temp.expect_error(format('select public.import_questions(%L::jsonb, %L::uuid)',
    jsonb_build_array(jsonb_build_object(
      'row', 1, 'type', 'multiple_choice', 'topic', 'TASK-048 test',
      'body', 'TASK-048 import question',
      'options', jsonb_build_array(jsonb_build_object('body', 'A', 'is_correct', true),
                                   jsonb_build_object('body', 'B', 'is_correct', false)),
      'passage', jsonb_build_object('title', 'TASK-048 admin text')))::text, v_teacher),
    'does not exist yet', 'an import does not match the admin reading text by title');
  v_res := public.import_questions(jsonb_build_array(jsonb_build_object(
    'row', 1, 'type', 'multiple_choice', 'topic', 'TASK-048 test',
    'body', 'TASK-048 import question',
    'options', jsonb_build_array(jsonb_build_object('body', 'A', 'is_correct', true),
                                 jsonb_build_object('body', 'B', 'is_correct', false)),
    'passage', jsonb_build_object('title', 'TASK-048 admin text', 'body', 'A fresh own copy.'))), v_teacher);
  perform pg_temp.assert_true((v_res ->> 'passages_created')::int = 1
    and (select passage_id from public.questions where id = ((v_res -> 'ids' ->> 0)::uuid)) is distinct from v_pa,
    'the import creates the teacher own reading text instead');

  -- ---------- the admin bypass is the whole school ----------
  -- save_question returns a uuid; v_res is jsonb, so read the admin path back directly.
  perform public.save_question(v_qt, jsonb_build_object(
    'type', 'multiple_choice', 'difficulty', 'medium', 'topic', 'TASK-048 test',
    'body', 'TASK-048 isolation question (edited by the admin)',
    'options', jsonb_build_array(
      jsonb_build_object('body', 'Yes', 'is_correct', true),
      jsonb_build_object('body', 'No', 'is_correct', false))), v_admin);
  perform pg_temp.assert_true((public.get_question(v_qt, v_admin) ->> 'body') = 'TASK-048 isolation question (edited by the admin)', 'the admin edits the teacher question');
  v_res := public.bulk_update_questions(array[v_qt], jsonb_build_object('difficulty', 'easy'), v_admin);
  perform pg_temp.assert_true((v_res ->> 'matched')::int = 1, 'the admin bulk change reaches the teacher question');

  raise exception 'QUESTION BANK ISOLATION TESTS PASSED (a teacher sees and changes only their own questions and reading texts; a foreign id is the missing-row sentence; the admin sees the whole school; all rolled back)';
end
$qb_isolation$;
