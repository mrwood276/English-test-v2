import { callStaffFunction } from "../../core/api.js";

/** Grading and results calls. Every call is one POST { action, ... } to the results function. */
const call = (body) => callStaffFunction("results", { method: "POST", body });

export const results = {
  /** Every exam that has sessions, with its counts (the Grading and Results hubs). */
  activity: (includeTemplates = false) => call({ action: "activity", include_templates: includeTemplates }).then((r) => r.exams),
  /** How many essays still wait, for the menu badge. */
  pending: () => call({ action: "pending" }).then((r) => r.pending),
  /** The results table of one exam: exam, summary, rows. */
  overview: (examId) => call({ action: "overview", exam_id: examId }).then((r) => r.overview),
  /** One session: answers, grades, events, and what can be done with it. */
  report: (sessionId) => call({ action: "report", session_id: sessionId }).then((r) => r.report),
  /** The essay questions of an exam with their progress. */
  gradingQuestions: (examId) => call({ action: "grading_questions", exam_id: examId }).then((r) => r.questions),
  /** One essay question against every student who took it. */
  queue: (examId, questionId) => call({ action: "queue", exam_id: examId, question_id: questionId }).then((r) => r.queue),
  /** Save one grade (essay or a correction of an automatic one). */
  grade: ({ sessionId, questionId, points, feedback }) =>
    call({ action: "grade", session_id: sessionId, question_id: questionId, points, feedback }).then((r) => r.grade),
  addTime: (sessionId, minutes) => call({ action: "add_time", session_id: sessionId, minutes }).then((r) => r.session),
  reopen: (sessionId, minutes) => call({ action: "reopen", session_id: sessionId, minutes }).then((r) => r.session),
  grantRetake: (sessionId) => call({ action: "grant_retake", session_id: sessionId }).then((r) => r.retake),
  revokeRetake: (sessionId) => call({ action: "revoke_retake", session_id: sessionId }).then((r) => r.retake),
  /** Exams that are currently open and have in-progress sessions (for the monitor hub). */
  activeExams: () => call({ action: "activity", include_templates: false }).then((r) => r.exams.filter((e) => e.in_progress > 0)),
  /** Full report for one session including events and actions (used by the monitor). */
  sessionReport: (sessionId) => call({ action: "report", session_id: sessionId }).then((r) => r.report),
};
