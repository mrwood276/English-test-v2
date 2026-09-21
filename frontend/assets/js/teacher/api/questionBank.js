import { callStaffFunction } from "../../core/api.js";

/** Question bank calls. Every call is one POST { action, ... } to the question-bank function. */
const call = (body) => callStaffFunction("question-bank", { method: "POST", body });

export const questionBank = {
  list: (filters) => call({ action: "list", ...filters }),
  get: (id) => call({ action: "get", id }).then((r) => r.question),
  topics: () => call({ action: "topics" }).then((r) => r.topics),
  classLabels: (prefix) => call({ action: "class_labels", prefix }).then((r) => r.labels),
  remove: (id) => call({ action: "remove", id }).then((r) => r.result),
  archive: (id) => call({ action: "archive", id }),
  restore: (id) => call({ action: "restore", id }),
  save: (question) => call({ action: "save", ...question }).then((r) => r.id),
  checkDuplicates: ({ body, options, excludeId }) => call({ action: "check_duplicates", body, options, exclude_id: excludeId }).then((r) => r.matches),
  importCheck: (items) => call({ action: "import_check", items }).then((r) => r.results),
  import: (items) => call({ action: "import", items }),
  passages: (q) => call({ action: "passages", q }).then((r) => r.passages),
  passage: (id) => call({ action: "passage_get", id }).then((r) => r.passage),
  savePassage: ({ id, title, body, media }) => call({ action: "passage_save", id, title, body, media }).then((r) => r.id),
};
