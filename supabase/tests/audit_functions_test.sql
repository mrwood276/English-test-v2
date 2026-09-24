-- SQL test for the admin audit-log viewer (TASK-015).
-- Run against the v2 project:  npx supabase db query --linked --file supabase/tests/audit_functions_test.sql
--
-- Everything happens inside one transaction that is deliberately rolled back at the end (the same
-- technique as result_functions_test.sql): the block always ends with `raise exception`, so no test
-- row survives. Read the last line of the output:
--   "AUDIT VIEWER TESTS PASSED (all rows rolled back)"  → all assertions held
--   "ASSERT FAILED: <message>"                          → a rule is broken
--
-- Verified here: the seeded rows are counted exactly (total), they come back newest-first, the
-- action / entity-type / days filters narrow them, limit+offset pages through them, an actor's
-- name is resolved from profiles while a null actor stays nameless ("System" on screen), and
-- person-fixable mistakes raise friendly validation errors (hint = 'validation') instead of 500s.
--
-- Seeded rows carry the entity type 'audit_test' so live rows can never disturb the counts.

create or replace function pg_temp.assert_true(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

do $$
declare
  v_actor uuid;
  v_actor_name text;
  v_out jsonb;
  v_caught boolean;
  v_hint text;
begin
  -- a real staff profile so one seeded row can test the name join (live data, only read)
  select p.id, p.full_name into v_actor, v_actor_name
   from public.profiles p where p.is_active order by p.created_at limit 1;
  perform pg_temp.assert_true(v_actor is not null, 'a staff profile exists to resolve actor names');

  -- ---------- fixtures (all rolled back) ----------
  perform public.write_audit(v_actor, 'question.create', 'audit_test', 'q-1',
    jsonb_build_object('body', 'Past simple of go'));
  perform public.write_audit(null, 'grade', 'audit_test', 's-1',
    jsonb_build_object('points', 3));
  perform public.write_audit(v_actor, 'grade', 'audit_test', 's-2', '{}'::jsonb);
  perform public.write_audit(v_actor, 'add_time', 'audit_test', 's-2',
    jsonb_build_object('minutes', 5));
  perform public.write_audit(v_actor, 'passage.update', 'audit_test', 'p-9', '{}'::jsonb);
  perform public.write_audit(v_actor, 'retake_grant', 'audit_test', 's-1', '{}'::jsonb);
  -- one transaction gives every insert the same now(), so spread the rows out by hand
  update public.audit_logs
     set created_at = now() - (case action || ':' || entity_id
       when 'question.create:q-1'  then interval '55 minutes'
       when 'grade:s-1'           then interval '44 minutes'
       when 'grade:s-2'           then interval '33 minutes'
       when 'add_time:s-2'        then interval '22 minutes'
       when 'passage.update:p-9'  then interval '11 minutes'
       else interval '40 days' end)
   where entity_type = 'audit_test';

  -- ---------- the viewer's first page, narrowed to the seeded rows ----------
  v_out := public.list_audit_logs(p_limit => 50, p_offset => 0, p_entity_type => 'audit_test');
  perform pg_temp.assert_true((v_out->>'total')::int = 6, 'the seeded rows are counted');
  perform pg_temp.assert_true(jsonb_array_length(v_out->'rows') = 6, 'the default limit keeps them all');
  perform pg_temp.assert_true(v_out->'rows'->0->>'action' = 'passage.update', 'the newest row comes first');
  perform pg_temp.assert_true(v_out->'rows'->5->>'action' = 'retake_grant', 'the backdated row is last');
  perform pg_temp.assert_true(v_out->'rows'->0->>'actor_name' = v_actor_name, 'an actor is named from profiles');
  perform pg_temp.assert_true(v_out->'rows'->3->>'actor_name' is null, 'a row without an actor has no name');
  perform pg_temp.assert_true((v_out->'rows'->1->'changes'->>'minutes')::int = 5, 'the change details travel along');

  -- ---------- filters ----------
  v_out := public.list_audit_logs(p_action => 'grade', p_entity_type => 'audit_test');
  perform pg_temp.assert_true((v_out->>'total')::int = 2, 'the action filter counts only grades');
  perform pg_temp.assert_true(v_out->'rows'->0->>'entity_id' = 's-2', 'the two grades come back newest first');

  v_out := public.list_audit_logs(p_days => 7, p_entity_type => 'audit_test');
  perform pg_temp.assert_true((v_out->>'total')::int = 5, 'the days filter drops the 40-day-old row');

  v_out := public.list_audit_logs(p_entity_type => 'nothing_matches_this');
  perform pg_temp.assert_true((v_out->>'total')::int = 0, 'an empty filter set is not an error');
  perform pg_temp.assert_true(jsonb_array_length(v_out->'rows') = 0, 'an empty result is [] and not null');

  -- ---------- paging ----------
  v_out := public.list_audit_logs(p_limit => 4, p_offset => 0, p_entity_type => 'audit_test');
  perform pg_temp.assert_true(jsonb_array_length(v_out->'rows') = 4, 'the limit slices the page');
  perform pg_temp.assert_true((v_out->>'total')::int = 6, 'paging still counts everything');
  v_out := public.list_audit_logs(p_limit => 4, p_offset => 4, p_entity_type => 'audit_test');
  perform pg_temp.assert_true(jsonb_array_length(v_out->'rows') = 2, 'the second page has the rest');
  perform pg_temp.assert_true(v_out->'rows'->0->>'action' = 'question.create'
    and v_out->'rows'->1->>'action' = 'retake_grant', 'the second page continues the order');

  -- ---------- person-fixable mistakes raise friendly errors ----------
  v_caught := false;
  begin
    perform public.list_audit_logs(p_limit => 0);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%between 1 and 200%' and v_hint = 'validation',
      'a zero limit is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'the limit is validated');

  v_caught := false;
  begin
    perform public.list_audit_logs(p_offset => -1);
  exception when others then
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%negative%', 'a negative offset is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'the offset is validated');

  v_caught := false;
  begin
    perform public.list_audit_logs(p_days => 0);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_caught := true;
    perform pg_temp.assert_true(sqlerrm like '%between 1 and 3650%' and v_hint = 'validation',
      'a zero window is refused');
  end;
  perform pg_temp.assert_true(v_caught, 'the days filter is validated');

  -- deliberate exception: rolls the whole block back, leaving the live database untouched
  raise exception 'AUDIT VIEWER TESTS PASSED (all rows rolled back)';
end $$;
