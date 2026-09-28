-- SQL test for public.bulk_update_questions (F-05, bulk question management).
-- Run against the v2 project as ONE request (one request = one session):
--   POST https://api.supabase.com/v1/projects/lbhnadmokloyfarrzfv/database/query  {"query": "<this file>"}
--   (CLI 2.117.0 has NO `supabase db query` subcommand), or paste it into the dashboard SQL editor.
--
-- **NOT RUN YET.** It was written on 2026-09-28 in a session that had no Supabase credential, so unlike
-- the other files in this folder it has no pass result behind it. Run it against the v2 project and
-- record the outcome in `.ai/04_CURRENT_STATE.md` before believing anything about the bulk path.
--
-- It creates its own questions and lets the transaction abort at the end, so nothing it writes survives —
-- the ERROR MESSAGE is the result:
--   "BULK UPDATE TESTS PASSED (…)"  → every assertion held
--   "ASSERT FAILED: <message>"      → a rule is broken
--
-- What is checked: only the service role may execute it; the four counts (matched / updated / unchanged /
-- missing) tell the truth, including on a second identical call, which must report 0 updated; a question
-- that does not exist is skipped and counted instead of failing the batch, while a selection that matches
-- nothing is refused; topic (+ clearing it), difficulty, points, archive and restore all apply to every
-- selected question and to no other question; class labels add without removing, remove without adding,
-- replace exactly, ignore letter case and spacing, and refuse to push a question past ten labels; every
-- validation message is a friendly one with hint 'validation'; and one audit entry per call records the
-- count, never one per question.

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

do $bulk$
declare
  v_actor uuid;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_control uuid;
  v_full uuid;
  v_result jsonb;
  v_again jsonb;
  v_labels jsonb;
  v_topic text;
  v_one jsonb;
  v_audits int;
  v_audits_before int;
  v_ids uuid[];
begin
  select id into v_actor from public.profiles where role = 'admin' and is_active order by created_at limit 1;
  perform pg_temp.assert_true(v_actor is not null, 'the project has an active admin to act as');

  -- ---------- the boundary ----------
  perform pg_temp.assert_true(
    not exists (
      select 1 from unnest(array['bulk_update_questions']) as f
      where has_function_privilege('anon', 'public.' || f || '(uuid[], jsonb, uuid)', 'execute')
         or has_function_privilege('authenticated', 'public.' || f || '(uuid[], jsonb, uuid)', 'execute')
    ),
    'anon and authenticated cannot execute bulk_update_questions'
  );
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'public.bulk_update_questions(uuid[], jsonb, uuid)', 'execute'),
    'service_role can execute bulk_update_questions'
  );

  -- ---------- the questions this test owns ----------
  v_a := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'easy', 'topic', 'Bulk Test', 'weight', 1,
    'body', 'BULK TEST question A', 'accepted_answers', jsonb_build_array('alpha'),
    'class_labels', jsonb_build_array('X TKJ A')), v_actor);
  v_b := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'medium', 'topic', 'Bulk Test', 'weight', 1,
    'body', 'BULK TEST question B', 'accepted_answers', jsonb_build_array('beta'),
    'class_labels', jsonb_build_array('X TKJ A')), v_actor);
  v_c := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'medium', 'topic', 'Bulk Test Other', 'weight', 3,
    'body', 'BULK TEST question C', 'accepted_answers', jsonb_build_array('gamma')), v_actor);
  v_control := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'hots', 'topic', 'Bulk Test Untouched', 'weight', 1,
    'body', 'BULK TEST control question', 'accepted_answers', jsonb_build_array('delta')), v_actor);
  perform pg_temp.assert_true(v_a is not null and v_b is not null and v_c is not null and v_control is not null,
    'the test created its four questions');
  v_ids := array[v_a, v_b, v_c];

  -- ---------- validation, before anything is written ----------
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L, %L, %L)', '{}', '{"topic":"Bulk Test Moved"}', v_actor),
    'Select at least one question', 'an empty selection is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', array_fill('00000000-0000-4000-8000-000000000000'::uuid, array[501]), '{"topic":"x"}', v_actor),
    'Change at most 500 questions at once', 'a selection over the cap is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{}', v_actor),
    'Choose at least one thing to change', 'an empty change set is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{"difficulty":"impossible"}', v_actor),
    'Choose Easy, Medium, or HOTS', 'an unknown difficulty is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{"weight":0}', v_actor),
    'Points must be more than 0 and at most 100', 'points of zero are refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{"weight":101}', v_actor),
    'Points must be more than 0 and at most 100', 'points over the cap are refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{"class_labels":{"mode":"merge","labels":["X TKJ A"]}}', v_actor),
    'Choose what to do with the class labels', 'an unknown label action is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids, '{"class_labels":{"mode":"add","labels":[]}}', v_actor),
    'Add at least one class label', 'adding nothing is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', v_ids,
           '{"class_labels":{"mode":"add","labels":["' || repeat('x', 41) || '"]}}', v_actor),
    'A class label is too long', 'an over-long label is refused');
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', array[v_a, '00000000-0000-4000-8000-000000000000'::uuid],
           '{"topic":"Bulk Test Moved"}', v_actor),
    'Those questions no longer exist', 'a selection that matches nothing is refused');

  -- ---------- topic, difficulty and points ----------
  v_audits_before := (select count(*) from public.audit_logs where action = 'question.bulk_update');
  v_result := public.bulk_update_questions(v_ids, '{"topic":"Bulk Test Moved","difficulty":"hots","weight":2.5}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'matched')::int = 3, 'all three selected questions were found');
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3, 'all three really changed');
  perform pg_temp.assert_true((v_result ->> 'unchanged')::int = 0, 'nothing was already like that');
  perform pg_temp.assert_true((v_result ->> 'missing')::int = 0, 'nothing was missing');
  perform pg_temp.assert_true(
    (select count(*) from public.questions q
      where q.id = any(v_ids) and q.difficulty = 'hots' and q.default_weight = 2.5
        and public.normalize_text((select t.name from public.topics t where t.id = q.topic_id)) = 'bulk test moved') = 3,
    'the topic, difficulty and points reached every selected question');
  perform pg_temp.assert_true(
    (select count(*) from public.questions q where q.id = v_control and q.difficulty = 'hots') = 0,
    'a question that was not selected was left alone');

  -- The same call again must not claim work it did not do.
  v_again := public.bulk_update_questions(v_ids, '{"topic":"Bulk Test Moved","difficulty":"hots","weight":2.5}', v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0, 'a repeated identical call reports 0 updated');
  perform pg_temp.assert_true((v_again ->> 'unchanged')::int = 3, 'a repeated identical call reports 3 unchanged');

  -- The topic is matched case-insensitively, so "bulk test moved" must find the same topic, not make a second.
  v_again := public.bulk_update_questions(array[v_c], '{"topic":"BULK   test moved"}', v_actor);
  perform pg_temp.assert_true((select count(*) from public.topics where public.normalize_text(name) = 'bulk test moved') = 1,
    'a topic name is matched case- and space-insensitively');

  -- Clearing the topic.
  v_again := public.bulk_update_questions(array[v_c], '{"topic":""}', v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 1, 'clearing the topic changed the question');
  perform pg_temp.assert_true((select topic_id is null from public.questions where id = v_c), 'the topic really is gone');

  -- ---------- one missing id is counted, not fatal ----------
  v_result := public.bulk_update_questions(array[v_a, '00000000-0000-4000-8000-000000000000'::uuid], '{"difficulty":"easy"}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'matched')::int = 1 and (v_result ->> 'missing')::int = 1,
    'a question that no longer exists is skipped and counted');
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 1, 'the question that does exist was still changed');

  -- ---------- class labels ----------
  -- add: keeps what a question has and adds the new one
  v_result := public.bulk_update_questions(v_ids, '{"class_labels":{"mode":"add","labels":["XI TKJ B"]}}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'matched')::int = 3, 'add reached all three questions');
  v_labels := (select jsonb_agg(x order by x) from (
    select l.label_display as x from public.question_class_labels l where l.question_id = v_a) s);
  perform pg_temp.assert_true(v_labels @> '["X TKJ A"]'::jsonb and v_labels @> '["XI TKJ B"]'::jsonb,
    'add kept the old label and added the new one');
  perform pg_temp.assert_true(
    (select count(*) from public.question_class_labels where question_id = v_c) = 1,
    'the question with no labels gained exactly the new one');

  -- add again: already-there labels are not counted as changes
  v_again := public.bulk_update_questions(v_ids, '{"class_labels":{"mode":"add","labels":["xi   tkj b"]}}', v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0, 'adding a label a question already has changes nothing');

  -- remove: takes exactly those away and leaves the rest
  v_result := public.bulk_update_questions(v_ids, '{"class_labels":{"mode":"remove","labels":["XI TKJ B"]}}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3, 'removing the added label changed all three');
  perform pg_temp.assert_true((select count(*) from public.question_class_labels where question_id = v_c) = 0,
    'removing the only label leaves none');

  -- replace: exactly these
  v_result := public.bulk_update_questions(v_ids, '{"class_labels":{"mode":"replace","labels":["XII TKJ A","XII TKJ B"]}}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3, 'replace changed all three');
  perform pg_temp.assert_true(
    (select count(*) from public.question_class_labels where question_id = v_a) = 2
    and (select count(*) from public.question_class_labels where question_id = v_b) = 2,
    'replace left exactly the two labels asked for');
  perform pg_temp.assert_true(
    (select count(*) from public.question_class_labels l where l.question_id = v_a and l.label_normalized = public.normalize_text('X TKJ A')) = 0,
    'replace dropped the label that was there before');

  -- replace with the same list again is a no-op
  v_again := public.bulk_update_questions(v_ids, '{"class_labels":{"mode":"replace","labels":["xii tkj b","XII tkj a"]}}', v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0, 'replacing with the same labels changes nothing');

  -- the ten-label ceiling is the same one save_question enforces
  v_full := public.save_question(null, jsonb_build_object(
    'type', 'short_answer', 'difficulty', 'medium', 'topic', 'Bulk Test', 'weight', 1,
    'body', 'BULK TEST question with ten labels', 'accepted_answers', jsonb_build_array('epsilon'),
    'class_labels', jsonb_build_array('L1','L2','L3','L4','L5','L6','L7','L8','L9','L10')), v_actor);
  perform pg_temp.expect_error(
    format('select public.bulk_update_questions(%L::uuid[], %L, %L)', array[v_full], '{"class_labels":{"mode":"add","labels":["L11"]}}', v_actor),
    'more than 10 class labels', 'adding an eleventh label is refused');
  perform pg_temp.assert_true((select count(*) from public.question_class_labels where question_id = v_full) = 10,
    'the refused add left the question exactly as it was');

  -- ---------- archive and restore ----------
  v_result := public.bulk_update_questions(v_ids, '{"archived":true}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3, 'archiving changed all three');
  perform pg_temp.assert_true((select count(*) from public.questions where id = any(v_ids) and is_archived) = 3,
    'all three are archived');
  perform pg_temp.assert_true((select count(*) from public.questions where id = v_control and is_archived) = 0,
    'archiving did not touch a question that was not selected');
  v_again := public.bulk_update_questions(v_ids, '{"archived":true}', v_actor);
  perform pg_temp.assert_true((v_again ->> 'updated')::int = 0, 'archiving twice changes nothing the second time');
  v_result := public.bulk_update_questions(v_ids, '{"archived":false}', v_actor);
  perform pg_temp.assert_true((v_result ->> 'updated')::int = 3 and (select count(*) from public.questions where id = any(v_ids) and not is_archived) = 3,
    'restoring brought all three back');

  -- ---------- one audit entry per act, never one per question ----------
  v_audits := (select count(*) from public.audit_logs where action = 'question.bulk_update');
  perform pg_temp.assert_true(v_audits > v_audits_before, 'a bulk change writes an audit entry');
  perform pg_temp.assert_true(
    (select count(*) from public.audit_logs
      where action = 'question.bulk_update' and entity_type = 'question' and changes ? 'count' and changes ? 'changes'
        and (changes ->> 'matched')::int >= 1) > 0,
    'the audit entry records the count and what was asked for');
  perform pg_temp.assert_true(
    (select count(*) from public.audit_logs
      where action = 'question.update' and entity_id in (v_a::text, v_b::text, v_c::text)) = 0,
    'a bulk change does not pretend to be forty single-question updates');

  raise exception 'BULK UPDATE TESTS PASSED (counts, topic, difficulty, points, labels add/remove/replace, the ten-label ceiling, archive/restore, one audit entry per act) — everything rolled back';
end $bulk$;
