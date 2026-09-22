import { callStaffFunction } from "../../core/api.js";

/** Exam calls. Every call is one POST { action, ... } to the exams function. */
const call = (body) => callStaffFunction("exams", { method: "POST", body });

export const exams = {
  list: (filters) => call({ action: "list", ...filters }).then((r) => r.exams),
  get: (id) => call({ action: "get", id }).then((r) => r.exam),
  save: (exam) => call({ action: "save", ...exam }).then((r) => r.id),
  remove: (id) => call({ action: "remove", id }).then((r) => r.result),
  setStatus: (id, status) => call({ action: "set_status", id, status }),
  regenerateCode: (id) => call({ action: "regenerate_code", id }).then((r) => r.code),
  checkCode: (code, excludeId) => call({ action: "check_code", code, exclude_id: excludeId }).then((r) => r.available),
  duplicate: (id) => call({ action: "duplicate", id }).then((r) => r.id),
};
