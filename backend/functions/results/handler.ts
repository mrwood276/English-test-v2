import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed, notFound } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asBool, asEnum, asObject, asUuid } from "../_shared/validate.ts";
import { asFeedback, asPoints, asSeconds } from "./parse.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "activity",          // every exam that has sessions, with its counts (the Grading and Results hubs)
  "pending",           // how many essays still wait (the menu badge)
  "overview",          // the results table of one exam
  "report",            // one session: answers, grades, events, and what can be done with it
  "grading_questions", // the essay questions of an exam and how far the grading is
  "queue",             // one essay question against every student who took it
  "grade",             // grade one answer by hand (BR-07, BR-18)
  "add_time",          // BR-11: more time while the test runs
  "reopen",            // BR-11: let a collected student continue
  "grant_retake",      // BR-02: the teacher allows one more attempt
  "revoke_retake",     // take an unused permission back
] as const;

/**
 * Grading and results for teachers and admins. One endpoint, POST { action, ... }.
 * The work itself happens in the database functions (one transaction each, audit inside), DEC-004.
 * Nothing here ever returns an answer key to the browser: the reports are for staff, and the review a
 * report carries is the graded one the student may also see (BR-09, BR-08).
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const me = await requireStaff(req, db);
    const b = asObject(await readJson(req, 20_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "activity": {
        const includeTemplates = b.include_templates === undefined ? false : asBool(b.include_templates, "Templates");
        return { exams: await callRpc(db, "list_exam_activity", { p_include_templates: includeTemplates }) };
      }

      case "pending":
        return { pending: await callRpc<number>(db, "count_pending_grading") };

      case "overview": {
        const overview = await callRpc<Record<string, unknown> | null>(db, "list_exam_results", {
          p_exam_id: asUuid(b.exam_id, "Exam"),
        });
        if (!overview) throw notFound("That exam no longer exists.");
        return { overview };
      }

      case "report":
        return { report: await callRpc(db, "get_session_report", { p_session_id: asUuid(b.session_id, "Session") }) };

      case "grading_questions":
        return { questions: await callRpc(db, "list_grading_questions", { p_exam_id: asUuid(b.exam_id, "Exam") }) };

      case "queue":
        return {
          queue: await callRpc(db, "get_grading_queue", {
            p_exam_id: asUuid(b.exam_id, "Exam"),
            p_question_id: asUuid(b.question_id, "Question"),
          }),
        };

      case "grade":
        return {
          grade: await callRpc(db, "save_answer_grade", {
            p_session_id: asUuid(b.session_id, "Session"),
            p_question_id: asUuid(b.question_id, "Question"),
            p_points: asPoints(b.points, "Points"),
            p_feedback: asFeedback(b.feedback),
            p_actor: me.userId,
          }),
        };

      case "add_time":
        return {
          session: await callRpc(db, "add_session_time", {
            p_session_id: asUuid(b.session_id, "Session"),
            p_seconds: asSeconds(b.minutes, "Minutes"),
            p_actor: me.userId,
          }),
        };

      case "reopen":
        return {
          session: await callRpc(db, "reopen_session", {
            p_session_id: asUuid(b.session_id, "Session"),
            p_seconds: asSeconds(b.minutes, "Minutes"),
            p_actor: me.userId,
          }),
        };

      case "grant_retake":
        return { retake: await callRpc(db, "grant_retake", { p_session_id: asUuid(b.session_id, "Session"), p_actor: me.userId }) };

      case "revoke_retake":
        return { retake: await callRpc(db, "revoke_retake", { p_session_id: asUuid(b.session_id, "Session"), p_actor: me.userId }) };
    }
  });
}
