"""Taking back what a live check created, in one place (ISSUE-041).

Three live checks — `live_monitor_check.py`, `live_browser_check.py` and `live_results_check.py` —
build a real exam with real attempts and used to print the ids and leave the rows for a human with a
SQL file (`cleanup_live_monitor.sql`, or a block in `docs/sql-results.md`). Nothing in them asserted
the rows were gone, so each run could leave a test exam behind and still print ALL CHECKS PASSED. That
is the ISSUE-040 family: the bell's check archived its own question, unnoticed, for months, because
its assertion compared only counters that did not include questions.

This module is the one implementation of "put it back", shared by those three checks. The checks that
already own their rows tightly (`live_housekeeping_check.py`, `live_notifications_check.py`,
`live_media_check.py`, the two bulk checks, `live_accounts_check.py`, `live_exam_delete_check.py`)
keep their own cleanup — theirs is narrower and already asserts its whole footprint.

Everything here needs the Management API `sql(query)` from `management_sql()`. A check run without
`SUPABASE_ACCESS_TOKEN` cannot clean up by SQL: it says so plainly and keeps printing the ids, so the
old by-hand path still works. `cleanup_live_monitor.sql` stays as the recovery path for a run that
died mid-way.
"""
import json
import urllib.error
import urllib.request

PROJECT = "lbhnadqmokloyfarrzfv"


def management_sql(access_token):
    """The `sql(query)` helper the live checks use, or None when there is no token."""
    if not access_token:
        return None

    def sql(query):
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
            data=json.dumps({"query": query}).encode(), method="POST",
            headers={"Authorization": f"Bearer {access_token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode() or "null")
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"database said: {err.read().decode('utf-8', 'replace')[:400]}") from None

    return sql


def wipe_exam(sql, exam_id):
    """Removes one exam, its attempts and everything hanging off them — nothing else.

    The same deletes `cleanup_live_monitor.sql` runs, scoped to one id so two checks can never reach
    each other's rows. The audit rows for the exam and its attempts go too: they are this run's own
    history, the way every other check removes its own (the two bulk checks keep their audit rows on
    purpose and say so — that is different, they are the feature's record).
    """
    sql(f"""do $$
      declare v_sessions uuid[];
      begin
        select coalesce(array_agg(id), '{{}}') into v_sessions from public.exam_sessions where exam_id = '{exam_id}';
        delete from public.session_events where session_id = any(v_sessions);
        delete from public.session_answers where session_id = any(v_sessions);
        delete from public.answer_grades where session_id = any(v_sessions);
        delete from public.exam_results where session_id = any(v_sessions);
        delete from public.exam_sessions where id = any(v_sessions);
        delete from public.retake_permissions where exam_id = '{exam_id}';
        delete from public.audit_logs where entity_id = '{exam_id}' or entity_id = any(v_sessions::text[]);
        delete from public.exam_questions where exam_id = '{exam_id}';
        delete from public.exams where id = '{exam_id}';
      end $$;""")


def wipe_question(sql, question_id, keep_audit=False):
    """Child rows first, then the question. Same order `live_notifications_check.py` uses (ISSUE-040).

    `keep_audit=True` leaves the question's audit entries alone, for the checks whose own cleanup never
    deletes them and whose promise is that that history stays (the two bulk checks, the media check).
    """
    if not keep_audit:
        sql(f"delete from public.audit_logs where entity_id = '{question_id}'")
    sql(f"""delete from public.question_options where question_id = '{question_id}';
            delete from public.question_class_labels where question_id = '{question_id}';
            delete from public.question_media where question_id = '{question_id}';
            delete from public.accepted_answers where question_id = '{question_id}';
            delete from public.questions where id = '{question_id}';""")


def sweep_rate_limits(sql):
    """The student endpoints fill rate-limit buckets; the checks document them away after a run."""
    sql("delete from public.rate_limits where bucket like 'session\\_%' "
        "and window_start > now() - interval '2 hours'")


def footprint(sql, exam_id, question_ids=()):
    """What a check's own acts leave: counts, every one expected to be 0 after cleanup."""
    ids = ",".join(f"'{q}'" for q in question_ids) if question_ids else "null"
    return sql(f"""select
        (select count(*)::int from public.exams where id = '{exam_id}') as exams,
        (select count(*)::int from public.exam_questions where exam_id = '{exam_id}') as exam_questions,
        (select count(*)::int from public.exam_sessions where exam_id = '{exam_id}') as sessions,
        (select count(*)::int from public.session_answers a join public.exam_sessions s on s.id = a.session_id
          where s.exam_id = '{exam_id}') as answers,
        (select count(*)::int from public.session_events e join public.exam_sessions s on s.id = e.session_id
          where s.exam_id = '{exam_id}') as events,
        (select count(*)::int from public.answer_grades g join public.exam_sessions s on s.id = g.session_id
          where s.exam_id = '{exam_id}') as grades,
        (select count(*)::int from public.exam_results r join public.exam_sessions s on s.id = r.session_id
          where s.exam_id = '{exam_id}') as results,
        (select count(*)::int from public.retake_permissions where exam_id = '{exam_id}') as retakes,
        (select count(*)::int from public.questions where id in ({ids})) as questions""")[0]


def wipe_leftover_exam(sql, access_code):
    """A run that died mid-way must not block the next one: its leftovers are this check's own."""
    removed = 0
    for row in sql(f"select id from public.exams where access_code = '{access_code}'"):
        wipe_exam(sql, row["id"])
        removed += 1
    return removed


def wipe_leftover_questions(sql, body_like, keep_audit=False):
    """The other half of a dead run: `wipe_leftover_exam` removes the exam, not the questions.

    The results check makes two questions of its own each run. Killing it mid-run proved (2026-09-30)
    that the exam sweep alone left them behind — the next run passed and printed *everything this run
    created is gone again* while the dead run's two questions stayed live (the ISSUE-040 class one
    level down). They carry a marker in their body, so only that check's own questions go. The bulk
    and media checks pass `keep_audit=True`: their history is the feature, so only the rows go.
    """
    removed = 0
    for row in sql(f"select id from public.questions where body like '{body_like}'"):
        wipe_question(sql, row["id"], keep_audit=keep_audit)
        removed += 1
    return removed
