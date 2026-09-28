import { callStaffFunction } from "../../core/api.js";

/** Exam calls. Every call is one POST { action, ... } to the exams function. */
const call = (body) => callStaffFunction("exams", { method: "POST", body });

export const exams = {
  list: (filters) => call({ action: "list", ...filters }).then((r) => r.exams),
  get: (id) => call({ action: "get", id }).then((r) => r.exam),
  save: (exam) => call({ action: "save", ...exam }).then((r) => r.id),
  /** `hard` asks to delete the exam together with its attempts; only an admin may (ISSUE-023). */
  remove: (id, hard = false) => call({ action: "remove", id, hard }).then((r) => r.result),
  setStatus: (id, status) => call({ action: "set_status", id, status }),
  regenerateCode: (id) => call({ action: "regenerate_code", id }).then((r) => r.code),
  checkCode: (code, excludeId) => call({ action: "check_code", code, exclude_id: excludeId }).then((r) => r.available),
  duplicate: (id) => call({ action: "duplicate", id }).then((r) => r.id),
  /**
   * Put many questions on one exam, or take many off it, in one request (F-18). `mode` is `add` or
   * `remove`; returns `{ matched, updated, unchanged, missing }` — only what really changed is counted.
   */
  bulkQuestions: (examId, mode, ids) => call({ action: "bulk_questions", exam_id: examId, mode, ids }).then((r) => r.result),
};
