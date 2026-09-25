-- TASK-020 (duplicate overview): the scan behind the question-list banner. It reports the questions
-- that are exact duplicates of each other (`content_hash` groups, added in v2_06) and the pairs that
-- look alike (`pg_trgm` similarity at or above a threshold), so the list can say "N questions look
-- like duplicates of each other" and offer a review. Read-only: no table changes.
--
-- APPLIED LIVE (2026-09-25 06:06 UTC) by an earlier session, as the tracked migration
-- `20260925060607` / `v2_17_duplicate_overview`. **This file is that live statement, committed
-- verbatim** on the owner's instruction (DEC-028, from ISSUE-024): the text below was copied out of
-- `supabase_migrations.schema_migrations.statements`, not rewritten, so the live row and this file
-- agree. It was NOT re-applied — the live function already exists. The follow-up
-- `20260925060638_v2_17_duplicate_overview_fix_search_path.sql` replaces this version of the
-- function (it adds `extensions` to `search_path`, which the trigram operators need).
--
-- Service-role only, like every other staff function (DEC-002): execute is revoked from
-- public/anon/authenticated, and the `question-bank` Edge Function (`duplicate_groups`) is the only
-- caller. Contract: `docs/sql-duplicates.md`.
--
-- To run SQL against the live project: CLI 2.117.0 has no `supabase db query` subcommand — use the
-- Management API query endpoint (POST /v1/projects/<ref>/database/query with {"query": "..."}) or
-- the dashboard SQL editor.

create or replace function public.find_duplicate_groups(p_threshold real default 0.55, p_limit int default 50)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_exact jsonb;
  v_similar jsonb;
  v_question_ids uuid[];
begin
  if p_threshold < 0 or p_threshold > 1 then
    raise exception 'Threshold must be between 0 and 1.' using hint = 'validation';
  end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'Limit must be between 1 and 200.' using hint = 'validation';
  end if;

  with exact_groups as (
    select content_hash, array_agg(id order by created_at) as ids
    from public.questions
    where not is_archived
    group by content_hash
    having count(*) > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'exact',
           'questions', (
             select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body, 'used_in_exams',
                      (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = q.id))
                    order by q.created_at)
             from public.questions q where q.id = any (g.ids)
           ))
         order by array_length(g.ids, 1) desc), '[]'::jsonb)
    into v_exact
    from exact_groups g;

  with similar_pairs as (
    select q1.id as a_id, q1.body as a_body, q2.id as b_id, q2.body as b_body,
           round(extensions.similarity(q1.body, q2.body)::numeric, 2) as sim
    from public.questions q1
    join public.questions q2 on q2.id > q1.id and q2.body % q1.body
    where not q1.is_archived and not q2.is_archived
      and q1.content_hash <> q2.content_hash
      and extensions.similarity(q1.body, q2.body) >= p_threshold
    order by extensions.similarity(q1.body, q2.body) desc
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'similar',
           'similarity', p.sim,
           'questions', jsonb_build_array(
             jsonb_build_object('id', p.a_id, 'body', p.a_body, 'used_in_exams',
               (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = p.a_id)),
             jsonb_build_object('id', p.b_id, 'body', p.b_body, 'used_in_exams',
               (select count(distinct eq.exam_id) from public.exam_questions eq where eq.question_id = p.b_id))
           ))
         order by p.sim desc), '[]'::jsonb)
    into v_similar
    from similar_pairs p;

  select array_agg(distinct id) into v_question_ids
  from (
    select (jsonb_array_elements(g -> 'questions') ->> 'id')::uuid as id
    from jsonb_array_elements(v_exact) g
    union all
    select (jsonb_array_elements(g -> 'questions') ->> 'id')::uuid as id
    from jsonb_array_elements(v_similar) g
  ) ids;

  return jsonb_build_object(
    'question_count', coalesce(array_length(v_question_ids, 1), 0),
    'exact_groups', v_exact,
    'similar_pairs', v_similar
  );
end $$;

revoke execute on function public.find_duplicate_groups(real, int) from public, anon, authenticated;
