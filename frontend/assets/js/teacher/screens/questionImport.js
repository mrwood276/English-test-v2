import { h, mount } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { toast, confirmDialog } from "../../shared/ui.js";
import { questionBank } from "../api/questionBank.js";
import { TYPE_LABEL } from "../components/questionView.js";
import { setLeaveGuard, clearLeaveGuard } from "../guard.js";
import { parseCsv } from "../import/csv.js";
import { readXlsxRows } from "../import/xlsx.js";
import { parsePastedText, EXAMPLE_TEXT } from "../import/text.js";
import { buildDrafts, recordsFromRows, LIMITS } from "../import/rows.js";
import { dupKey } from "../import/rules.js";
import { SessionExpiredError } from "../../core/auth.js";

const MAX_FILE_BYTES = 2_000_000;
const errorText = (err) => err.message || "Something went wrong. Please try again.";
// When the session ended, core/api.js already sent the person back to sign in; nothing more to show here.
const ignorable = (err) => err instanceof SessionExpiredError;

/** Reads the chosen file into table rows (CSV or .xlsx), or { problem } when it cannot be read. */
async function rowsFromFile(file) {
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  if (!isCsv && !/\.xlsx$/i.test(file.name)) return { problem: "Please choose a .xlsx or .csv file." };
  if (file.size > MAX_FILE_BYTES) return { problem: "That file is too large (at most 2 MB)." };
  const bytes = await file.arrayBuffer();
  if (isCsv) {
    const { rows, numbers } = parseCsv(new TextDecoder().decode(bytes));
    return { rows, numbers };
  }
  try {
    return await readXlsxRows(bytes);
  } catch (err) {
    return { problem: errorText(err) };
  }
}

const statusPill = (s) => {
  if (s.fix) return h("span", { class: "pill bad" }, "Fix");
  if (s.exact) return h("span", { class: "pill warn" }, "Duplicate in bank");
  if (s.dupInFile) return h("span", { class: "pill warn" }, "Duplicate in file");
  if (s.similar) return h("span", { class: "pill warn" }, "Similar");
  return h("span", { class: "pill ok" }, "Ready");
};

/**
 * Import questions from a spreadsheet (Excel/CSV) or pasted text.
 * Nothing is saved before the review is confirmed; the server saves everything in one transaction.
 */
export function renderQuestionImport(container) {
  const state = { drafts: [], existingTitles: new Set(), checked: new Set(), duplicates: new Map(), source: null };

  // ---------- controls ----------
  const fileInput = h("input", { type: "file", id: "imp-file", class: "visually-hidden", accept: ".xlsx,.csv" });
  const pasteArea = h("textarea", { class: "ta", id: "imp-paste", rows: "10", placeholder: "Paste questions here. Press \"Show an example\" to see the format." });
  const defaultsLabels = h("input", { class: "input", id: "imp-default-class", placeholder: "for example XII TKJ A" });
  const defaultsTopic = h("input", { class: "input", id: "imp-default-topic", list: "imp-topic-list", placeholder: "used when a row has none" });
  const topicList = h("datalist", { id: "imp-topic-list" });
  const defaultsDifficulty = h("select", { class: "chip-select", id: "imp-default-difficulty" }, [["", "Medium (default)"], ["easy", "Easy"], ["medium", "Medium"], ["hots", "HOTS"]].map(([v, t]) => h("option", { value: v }, t)));
  const defaultsPoints = h("input", { class: "input", id: "imp-default-points", type: "number", min: "0.5", max: "100", step: "0.5", placeholder: "1" });

  const pickCard = h("section", { class: "card sec" },
    h("h2", {}, "1. Where are the questions?"),
    h("div", { class: "import-pick" },
      h("div", { class: "import-pick-item" }, icon("sheet"), h("strong", {}, "Excel or CSV file"), h("p", { class: "hint" }, "One question per row, with a header row."), h("label", { class: "btn small", for: "imp-file" }, "Choose a file"), fileInput),
      h("div", { class: "import-pick-item" }, icon("pencil"), h("strong", {}, "Pasted text"), h("p", { class: "hint" }, "Copy from Word, number the questions."), pasteArea),
    ),
    h("div", { class: "form-row" },
      h("button", { class: "btn", type: "button", id: "imp-review" }, "Review questions"),
      h("button", { class: "btn ghost", type: "button", id: "imp-example" }, "Show an example"),
      h("button", { class: "btn ghost", type: "button", id: "imp-reset", hidden: true }, "Start over"),
      h("a", { class: "btn ghost", href: "../assets/templates/import-template.xlsx", download: true }, "Excel template"),
      h("a", { class: "btn ghost", href: "../assets/templates/import-template.csv", download: true }, "CSV template"),
    ),
    h("p", { class: "list-status", id: "imp-error", role: "alert", hidden: true }),
    h("details", { class: "import-help" },
      h("summary", {}, "How the text format works"),
      h("div", { class: "hint" },
        h("p", {}, "Questions are separated by numbering (\"1.\" or \"1)\") or blank lines. Options are lines \"A.\" to \"F.\"; mark the correct one with * (before or after the option) or an \"Answer: B\" line (Kunci:, Jawaban: also work)."),
        h("p", {}, "Meta lines: Topic:, Level:, Points:, Class:, Explanation:, Type:, Guide:. A reading text is \"Reading text: Title\", or a [Reading text: Title] ... [/Reading text] block that several questions share."),
        h("p", {}, "No options + Answer: True/False makes a true/false question; no options + another answer makes a short-answer question (several accepted answers separated by |). At most 200 questions per import."),
      ),
    ),
  );

  const defaultsCard = h("section", { class: "card sec", hidden: true },
    h("h2", {}, "2. Fill in what is missing"),
    h("p", { class: "hint" }, "Used for rows that leave these empty."),
    h("div", { class: "import-defaults" },
      h("label", { class: "lbl", for: "imp-default-class" }, "Class labels (separate with commas)"), defaultsLabels,
      h("label", { class: "lbl", for: "imp-default-topic" }, "Topic"), defaultsTopic, topicList,
      h("label", { class: "lbl", for: "imp-default-difficulty" }, "Difficulty"), defaultsDifficulty,
      h("label", { class: "lbl", for: "imp-default-points" }, "Points"), defaultsPoints,
    ),
    h("p", { class: "list-status", id: "imp-status", role: "status" }),
  );

  const reviewCard = h("section", { class: "card sec", hidden: true },
    h("div", { class: "head" }, h("h2", {}, "3. Review"), h("button", { class: "btn", type: "button", id: "imp-save", disabled: true }, "Import questions")),
    h("div", { class: "table-wrap" }, h("table", { class: "qtable import-table" },
      h("thead", {}, h("tr", {},
        h("th", { class: "col-check" }, h("input", { type: "checkbox", id: "imp-check-all", "aria-label": "Select all rows that can be imported" })),
        h("th", {}, "Question"), h("th", { class: "col-diff" }, "Type"), h("th", {}, "Status"))),
      h("tbody", { id: "imp-tbody" })),
    ),
    h("p", { class: "hint" }, "Rows with problems cannot be imported. Duplicates already in the bank start unchecked; similar ones are checked with a warning."),
  );

  mount(container, pickCard, defaultsCard, reviewCard);

  // ---------- reading the source ----------
  async function readSource() {
    const hasFile = fileInput.files && fileInput.files[0];
    const pasted = pasteArea.value.trim();
    if (!hasFile && !pasted) return { problem: "Choose a file or paste some questions first." };
    if (hasFile && pasted) return { problem: "Choose a file or paste text, not both." };
    if (hasFile) {
      const res = await rowsFromFile(fileInput.files[0]);
      if (res.problem) return res;
      const { records, problem } = recordsFromRows(res.rows, res.numbers);
      if (problem) return { problem };
      return { records, source: `file “${fileInput.files[0].name}”` };
    }
    const { records, passages, problems } = parsePastedText(pasted);
    // Pasted [Reading text: ...] blocks carry their body inside the text.
    for (const r of records) if (r.readingTitle && !r.readingBody && passages[r.readingTitle]) r.readingBody = passages[r.readingTitle];
    if (problems.length) return { problem: problems.join(" ") };
    return { records, source: "pasted text" };
  }

  async function buildReview() {
    const error = container.querySelector("#imp-error");
    error.hidden = true;
    const res = await readSource();
    if (res.problem) {
      error.textContent = res.problem;
      error.hidden = false;
      return;
    }
    if (res.records.length === 0) {
      error.textContent = "No questions were found in that source.";
      error.hidden = false;
      return;
    }
    if (res.records.length > LIMITS.batch) {
      error.textContent = `That is ${res.records.length} questions. Import at most ${LIMITS.batch} at a time.`;
      error.hidden = false;
      return;
    }
    state.source = res.source;
    defaultsCard.hidden = false;
    reviewCard.hidden = false;
    container.querySelector("#imp-reset").hidden = false;
    container.querySelector("#imp-status").textContent = `Reading ${res.records.length} questions…`;
    container.querySelector("#imp-status").scrollIntoView({ block: "nearest" });
    await renderDrafts(res.records);
  }

  const defaults = () => ({
    labels: defaultsLabels.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
    topic: defaultsTopic.value.trim(),
    difficulty: defaultsDifficulty.value || "medium",
    points: Number(defaultsPoints.value) || 1,
  });

  async function renderDrafts(records) {
    const status = container.querySelector("#imp-status");
    let titles = new Set();
    try {
      const passages = await questionBank.passages();
      titles = new Set(passages.map((p) => (p.title || "").replace(/\s+/g, " ").trim().toLowerCase()));
    } catch (err) { if (!ignorable(err)) toast(`Could not load reading texts: ${errorText(err)}`, "error"); }

    const drafts = buildDrafts(records, { defaults: defaults(), existingTitles: titles });
    state.existingTitles = titles;
    state.drafts = drafts;

    // In-file duplicates: same text and answers as an earlier row.
    const seen = new Map();
    for (const d of drafts) {
      const k = dupKey(d.body, [...d.options.map((o) => o.body), ...d.accepted_answers]);
      const first = seen.get(k);
      if (first !== undefined) { d.dupInFile = true; d.notes.push(`Same as row ${first}.`); }
      else seen.set(k, d.row);
    }

    // Server duplicate check (rows without problems only; the server needs at least the question text).
    state.duplicates = new Map();
    const checkable = drafts.filter((d) => d.body && !d.problems.length);
    if (checkable.length) {
      status.textContent = `Checking ${checkable.length} questions for duplicates…`;
      try {
        // importCheck already unwraps the response: this is the results list itself.
        const results = await questionBank.importCheck(checkable.map((d) => ({ i: d.row, body: d.body, options: d.options.map((o) => o.body) })));
        for (const r of results || []) if (r.matches && r.matches.length) state.duplicates.set(r.i, r.matches);
      } catch (err) {
        if (!ignorable(err)) toast(`Could not check for duplicates: ${errorText(err)}`, "error");
      }
    }
    for (const d of drafts) {
      const matches = state.duplicates.get(d.row);
      if (matches) {
        const exact = matches.find((m) => m.exact);
        d.exact = Boolean(exact);
        d.similar = Boolean(matches.find((m) => !m.exact));
        const m = exact || matches[0];
        d.notes.unshift(exact ? `Already in the bank: “${plainText(m.body, 120)}”.` : `Looks like “${plainText(m.body, 120)}”.`);
      }
    }

    // Rows start checked: everything that can be imported, except duplicates (of the bank or of an earlier row).
    state.checked = new Set(drafts.filter((d) => d.problems.length === 0 && !d.exact && !d.dupInFile).map((d) => d.row));
    renderReview();
  }

  // ---------- review table ----------
  function draftView(d) {
    const type = TYPE_LABEL[d.type] || d.type;
    const answer = d.type === "multiple_choice" || d.type === "true_false"
      ? d.options.map((o, i) => (o.is_correct ? String.fromCharCode(65 + i) : null)).filter(Boolean).join(", ")
      : d.type === "short_answer" ? d.accepted_answers.join(" | ") : "";
    return { type, answer: answer ? `Answer: ${answer}` : "" };
  }

  function renderReview() {
    const tbody = container.querySelector("#imp-tbody");
    const drafts = state.drafts;
    const rows = drafts.map((d) => {
      const view = draftView(d);
      const canImport = d.problems.length === 0;
      const checked = state.checked.has(d.row);
      const box = h("input", { type: "checkbox", "aria-label": canImport ? `Import row ${d.row}` : `Row ${d.row} has problems`, disabled: !canImport });
      box.checked = checked;
      box.addEventListener("change", () => { if (box.checked) state.checked.add(d.row); else state.checked.delete(d.row); updateCount(); });
      return h("tr", { class: canImport ? (d.exact || d.dupInFile ? "warn-row" : "") : "bad-row" },
        h("td", { class: "col-check" }, box),
        h("td", { class: "qcell" },
          h("span", { class: "imp-row" }, `Row ${d.row}`),
          h("div", { class: "imp-body" }, plainText(d.body, 160) || "(no question text)"),
          h("small", {}, [view.answer, d.topic].filter(Boolean).join(" · ")),
          d.notes.length ? h("div", { class: "hint" }, d.notes.join(" ")) : null,
          h("div", { class: "imp-problems", role: "list" }, d.problems.map((p) => h("span", { class: "imp-problem", role: "listitem" }, p)))),
        h("td", { class: "col-diff" }, view.type),
        h("td", {}, statusPill({ fix: !canImport, exact: d.exact, dupInFile: d.dupInFile, similar: d.similar })),
      );
    });
    tbody.replaceChildren(...rows);
    const allBox = container.querySelector("#imp-check-all");
    allBox.checked = state.checked.size > 0 && state.checked.size === drafts.filter((d) => d.problems.length === 0).length;
    updateCount();
  }

  function updateCount() {
    const saveBtn = container.querySelector("#imp-save");
    const drafts = state.drafts;
    const fixable = drafts.filter((d) => d.problems.length > 0).length;
    const n = state.checked.size;
    saveBtn.disabled = n === 0;
    saveBtn.textContent = `Import ${n} question${n === 1 ? "" : "s"}`;
    const bits = [`${n} of ${drafts.length} selected`];
    if (fixable) bits.push(`${fixable} need fixing`);
    container.querySelector("#imp-status").textContent = `${drafts.length} read from ${state.source}. ${bits.join(" · ")}.`;
  }

  function isDirty() {
    return state.drafts.length > 0;
  }

  // ---------- import ----------
  async function doImport() {
    const chosen = state.drafts.filter((d) => state.checked.has(d.row));
    if (chosen.length === 0) return;
    const items = chosen.map((d) => ({
      row: d.row,
      type: d.type,
      body: d.body,
      difficulty: d.difficulty,
      topic: d.topic || null,
      weight: d.weight,
      options: d.options,
      accepted_answers: d.accepted_answers,
      essay_guidance: d.essay_guidance || null,
      explanation: d.explanation || null,
      class_labels: d.class_labels,
      passage: d.passage,
    }));
    const saveBtn = container.querySelector("#imp-save");
    saveBtn.disabled = true;
    try {
      const res = await questionBank.import(items);
      clearLeaveGuard();
      toast(`Imported ${res.created} question${res.created === 1 ? "" : "s"}${res.passages_created ? ` and created ${res.passages_created} reading text${res.passages_created === 1 ? "" : "s"}` : ""}.`);
      location.hash = "#/questions";
    } catch (err) {
      if (!ignorable(err)) {
        saveBtn.disabled = false;
        const status = container.querySelector("#imp-status");
        status.className = "list-status error";
        status.textContent = err.status === 400 && /^Row \d+:/.test(err.message)
          ? `${err.message} Nothing was saved. Fix the row, then import again.`
          : `Nothing was saved. ${errorText(err)}`;
        status.scrollIntoView({ block: "nearest" });
      }
    }
  }

  // ---------- events ----------
  container.querySelector("#imp-review").addEventListener("click", buildReview);
  container.querySelector("#imp-example").addEventListener("click", () => { pasteArea.value = EXAMPLE_TEXT; pasteArea.focus(); });
  container.querySelector("#imp-save").addEventListener("click", doImport);
  container.querySelector("#imp-reset").addEventListener("click", () => {
    state.drafts = []; state.checked = new Set(); state.duplicates = new Map(); state.source = null;
    pasteArea.value = "";
    fileInput.value = "";
    defaultsCard.hidden = true;
    reviewCard.hidden = true;
    const error = container.querySelector("#imp-error");
    error.hidden = true;
    error.textContent = "";
    container.querySelector("#imp-tbody").replaceChildren();
    container.querySelector("#imp-save").disabled = true;
    container.querySelector("#imp-status").textContent = "";
  });
  fileInput.addEventListener("change", () => { pasteArea.value = ""; });
  pasteArea.addEventListener("input", () => { if (fileInput.value) fileInput.value = ""; });
  const checkAll = container.querySelector("#imp-check-all");
  // Select-all covers every row that can be imported, duplicates included: the first click fills the gaps
  // (for example the exact duplicate that starts unchecked), the second clears everything.
  checkAll.addEventListener("change", () => {
    const chooseable = state.drafts.filter((d) => d.problems.length === 0);
    if (checkAll.checked) for (const d of chooseable) state.checked.add(d.row);
    else for (const d of chooseable) state.checked.delete(d.row);
    renderReview();
  });

  // Ask before leaving with an unsaved review.
  setLeaveGuard(async () => {
    if (!isDirty()) return true;
    return confirmDialog({ title: "Leave without importing?", message: "You have questions that are ready to import. If you leave now, nothing is saved.", confirmLabel: "Leave", cancelLabel: "Keep reviewing", danger: true });
  }, isDirty);

  // Topic suggestions for the defaults panel.
  questionBank.topics().then((topics) => {
    for (const t of topics) topicList.append(h("option", { value: t.name }));
  }).catch(() => { /* the defaults still work without suggestions */ });
}
