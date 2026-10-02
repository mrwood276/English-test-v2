import { h, mount } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast } from "../../shared/ui.js";
import { exams } from "../api/exams.js";
import { questionBank } from "../api/questionBank.js";
import { TYPE_LABEL } from "../components/questionView.js";
import { examQuestionsDialog } from "../components/examQuestionsDialog.js";
import { enableReorder } from "../components/reorderList.js";
import { setLeaveGuard, clearLeaveGuard } from "../guard.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Six characters from the same confusion-safe alphabet the backend uses. */
function suggestCode() {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

const localStamp = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Exam editor (mockup 11): details, question selection (manual with a picker, or by filter),
 * availability (manual or scheduled), the test code with a live uniqueness check,
 * the rules panel, and a ready-to-open summary. Saving keeps the exam a draft; opening
 * happens from the list or the summary once the database confirms the rules hold.
 */
export function renderExamEditor(container, ctx, match) {
  const examId = match && match[1] ? match[1].toLowerCase() : null;
  const state = {
    id: examId,
    title: "",
    description: "",
    status: "draft",
    duration_minutes: 45,
    passing_grade: 70,
    availability_mode: "manual",
    starts_at: "",
    ends_at: "",
    late_start_policy: "full_duration",
    access_code: suggestCode(),
    selection_mode: "manual",
    auto_filter: { class_label: "", topic: "", difficulty: "" },
    pool_size: 10,
    draw_per_student: false,
    randomize_questions: false,
    randomize_options: false,
    result_visibility: "score_and_review",
    essay_pending_display: "show_partial",
    tab_switch_warn_limit: 1,
    tab_switch_flag_limit: 3,
    tab_switch_autosubmit_limit: 5,
    is_template: false,
    questions: [], // [{ id, body, type, weight }] in chosen order
    poolCount: null,
    dirty: false,
    loaded: false,
  };

  // ---------- dirty tracking + leave guard ----------
  const markDirty = () => { state.dirty = true; };
  setLeaveGuard(async () => {
    if (!state.dirty) return true;
    return window.confirm("Leave without saving this exam?");
  }, () => state.dirty);

  // ---------- fields ----------
  const title = h("input", { class: "input", id: "ee-title", type: "text", maxlength: "120", placeholder: "Narrative Text, Daily Test 3" });
  const description = h("textarea", { class: "input", id: "ee-desc", rows: "2", maxlength: "2000", placeholder: "Optional note for students" });
  const duration = h("input", { class: "input", type: "number", min: "1", max: "300", value: "45" });
  const passing = h("input", { class: "input", type: "number", min: "0", max: "100", step: "0.5", value: "70" });
  title.addEventListener("input", debounce(() => { state.title = title.value; markDirty(); renderSummary(); }, 250));
  description.addEventListener("input", debounce(() => { state.description = description.value; markDirty(); }, 250));

  const modeSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Availability" },
    h("button", { class: "btn ghost", type: "button", "data-mode": "manual" }, "Open and close by hand"),
    h("button", { class: "btn ghost", type: "button", "data-mode": "scheduled" }, "Scheduled"));
  const startsAt = h("input", { class: "input", type: "datetime-local" });
  const endsAt = h("input", { class: "input", type: "datetime-local" });
  const lateSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Late-start policy" },
    h("button", { class: "btn ghost", type: "button", "data-late": "full_duration" }, "Full duration"),
    h("button", { class: "btn ghost", type: "button", "data-late": "cut_at_end" }, "Stop at closing time"));

  const selSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Selection" },
    h("button", { class: "btn ghost", type: "button", "data-sel": "manual" }, "Pick questions by hand"),
    h("button", { class: "btn ghost", type: "button", "data-sel": "auto" }, "Draw by filter"));

  const filterClass = h("input", { class: "input", type: "text", placeholder: "Any class, e.g. XII TKJ A", maxlength: "40" });
  const filterTopic = h("input", { class: "input", type: "text", placeholder: "Any topic, e.g. Narrative Text", maxlength: "120" });
  const filterDifficulty = h("select", { class: "input" },
    [["", "Any difficulty"], ["easy", "Easy"], ["medium", "Medium"], ["hots", "HOTS"]].map(([v, t]) => h("option", { value: v }, t)));
  const poolSize = h("input", { class: "input", type: "number", min: "1", max: "200", value: "10" });
  const poolCountText = h("p", { class: "sub" }, "");
  const drawToggle = h("input", { type: "checkbox" });

  const codeInput = h("input", { class: "input code-input", type: "text", maxlength: "12", spellcheck: "false", autocomplete: "off" });
  const codeStatus = h("span", { class: "pill", role: "status" }, "checking…");
  const newCodeBtn = h("button", { class: "btn small ghost", type: "button" }, "Make a new one");

  const shuffleQ = h("input", { type: "checkbox" });
  const shuffleO = h("input", { type: "checkbox" });
  const warnLimit = h("input", { class: "input", type: "number", min: "1", max: "50", value: "1" });
  const flagLimit = h("input", { class: "input", type: "number", min: "1", max: "50", value: "3" });
  const submitLimit = h("input", { class: "input", type: "number", min: "1", max: "50", value: "5" });
  const resultSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Result visibility" },
    [["none", "Nothing"], ["score", "Score"], ["score_and_review", "Score and answers"]].map(([v, t]) => h("button", { class: "btn ghost", type: "button", "data-result": v }, t)));
  const essaySeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Essay pending display" },
    [["hide_score", "Hide the score"], ["show_partial", "Show the score so far"]].map(([v, t]) => h("button", { class: "btn ghost", type: "button", "data-essay": v }, t)));

  // ---------- question picker (manual selection) ----------
  // Both halves of the picker are bulk: tick many bank questions and put them on the exam in one act, tick
  // many chosen ones and take them off in one act — each with a "look before you leap" step shared with the
  // question bank (`components/examQuestionsDialog.js`). Nothing reaches the database until Save: the exam
  // list is the editor's own draft, and `save_exam` writes it whole.
  const SELECT_PAGE = 100;   // the list API's own page-size cap, for "select all matching"
  const PICKER_PAGE = 25;    // how many bank questions the picker shows at once
  // The ceiling `parseExamQuestions` and the database both enforce on one exam.
  const EXAM_MAX = 200;

  const pickerSearch = h("input", { class: "input", type: "search", placeholder: "Search the bank…", "aria-label": "Search questions" });
  const pickerList = h("div", { class: "picker-list", role: "listbox", "aria-label": "Questions in the bank" });
  const chosenList = h("div", { class: "picker-list chosen" });
  const chosenSummary = h("p", { class: "sub" }, "No questions selected yet.");
  // Reordering the chosen list is the one way to choose the order the exam asks its questions in: the list
  // IS the order `save_exam` writes, so a reorder is an ordinary edit of this draft and nothing is sent
  // until Save. The grip drags with a pointer or moves with the arrow keys; the note is what a screen reader
  // hears when a question moves.
  const reorderHint = h("p", { class: "sub", id: "ee-reorder-hint", hidden: true },
    "Drag a question by its grip to change the order, or focus the grip and press ↑ ↓ (Home and End jump to the ends). Nothing is saved until you press Save.");
  const reorderNote = h("p", { class: "visually-hidden", id: "ee-reorder-note", role: "status", "aria-live": "polite" });

  // Ticked bank questions (to add) and ticked exam questions (to remove). Kept as explicit ids, the same
  // way the question bank does it, so a change of search does not silently drop a tick.
  const addTicks = new Set();
  const removeTicks = new Set();
  const pickerPage = { items: [], byId: new Map(), total: 0 };
  const onExam = () => new Set(state.questions.map((q) => q.id));

  function bar(id, label) {
    const count = h("span", { class: "bulk-count", role: "status" });
    const note = h("span", { class: "hint bulk-note", role: "status" });
    const actions = h("div", { class: "bulk-actions" });
    const all = h("div", { class: "bulk-all" });
    const el = h("div", { class: "bulkbar", id, role: "region", "aria-label": label, hidden: true },
      h("div", { class: "bulk-summary" }, count, note), actions, all);
    return { el, count, note, actions, all };
  }
  const addBar = bar("ee-add-bar", "Add questions to this exam");
  const removeBar = bar("ee-remove-bar", "Remove questions from this exam");

  function tick(ticks, id, on) {
    if (on) ticks.add(id); else ticks.delete(id);
  }

  function chosenRow(q, index) {
    const body = plainText(q.body);
    const box = h("input", { type: "checkbox", class: "pick", checked: removeTicks.has(q.id), "aria-label": `Select: ${plainText(q.body, 60)}` });
    box.addEventListener("change", () => { tick(removeTicks, q.id, box.checked); updateRemoveBar(); });
    // One grip does both jobs: drag it, or focus it and move the row with ↑ ↓. A list of one has nowhere
    // to move to, so the grip is disabled until there is something to reorder.
    const grip = h("button", { class: "btn small ghost grip", type: "button", draggable: "false",
      disabled: state.questions.length < 2, title: "Drag to reorder, or press ↑ ↓",
      "aria-label": `Reorder ${body}: drag it, or press the arrow keys` }, icon("grip"));
    const up = h("button", { class: "btn small ghost", type: "button", "data-move": "up", "aria-label": `Move ${plainText(q.body)} up` }, "↑");
    const down = h("button", { class: "btn small ghost", type: "button", "data-move": "down", "aria-label": `Move ${plainText(q.body)} down` }, "↓");
    const weight = h("input", { class: "input weight-input", type: "number", min: "0.01", max: "100", step: "0.5", value: String(q.weight ?? 1), "aria-label": `Points for ${plainText(q.body)}` });
    const rm = h("button", { class: "btn small ghost", type: "button", "aria-label": `Remove ${plainText(q.body)}` }, "✕");
    weight.addEventListener("change", () => { q.weight = Number(weight.value) || 1; markDirty(); renderSummary(); });
    rm.addEventListener("click", () => { state.questions.splice(index, 1); removeTicks.delete(q.id); markDirty(); renderChosen(); renderSummary(); });
    return h("div", { class: ["picker-item chosen-item", removeTicks.has(q.id) ? "picked" : ""].filter(Boolean).join(" "), role: "listitem", "data-id": q.id },
      box,
      h("span", { class: "pos" }, String(index + 1)),
      grip,
      h("span", { class: "grow" }, h("b", {}, body.slice(0, 90)), h("small", {}, ` ${TYPE_LABEL[q.type] ?? q.type}`)),
      h("label", { class: "weight" }, "pts", weight), up, down, rm);
  }

  /** The bar for the chosen list: the count, and the two things a teacher can do with a selection. */
  function updateRemoveBar() {
    const n = removeTicks.size;
    removeBar.el.hidden = n === 0;
    removeBar.actions.replaceChildren();
    if (n === 0) { removeBar.count.textContent = ""; removeBar.note.textContent = ""; return; }
    removeBar.count.textContent = `${n} ${n === 1 ? "question" : "questions"} selected`;
    removeBar.note.textContent = `· ${n} of ${state.questions.length} on this exam`;
    const remove = h("button", { class: "btn small", type: "button" }, `Remove ${n} from this exam`);
    remove.addEventListener("click", openRemoveQuestions);
    const clear = h("button", { class: "btn small ghost", type: "button" }, "Clear");
    clear.addEventListener("click", () => { removeTicks.clear(); renderChosen(); });
    removeBar.actions.append(remove, clear);
  }

  // ---------- reorder ----------
  // The order of this list is the order the exam asks its questions in (`save_exam` numbers the list from the
  // payload it is given), so the grip on each row is what chooses it — drag it, or focus it and press the
  // arrow keys. The control itself is shared (`components/reorderList.js`); here it only has to know how a
  // row maps back to a question and that a reorder is an ordinary edit of this draft.
  const questionById = (id) => state.questions.find((q) => q.id === id);
  const reorder = enableReorder(chosenList, {
    note: reorderNote,
    noun: "question",
    describe: (row) => plainText((questionById(row.dataset.id) || {}).body || "", 40),
    onOrder: (rows) => {
      const byId = new Map(state.questions.map((q) => [q.id, q]));
      state.questions = rows.map((el) => byId.get(el.dataset.id)).filter(Boolean);
      markDirty();
      renderChosen();
    },
  });

  function renderChosen() {
    reorder.reset();   // a full rebuild of the rows ends any drag in flight
    paintChosen();
  }

  function paintChosen() {
    chosenList.replaceChildren(...state.questions.map(chosenRow));
    reorderHint.hidden = state.questions.length < 2;
    const total = state.questions.reduce((s, q) => s + (Number(q.weight) || 1), 0);
    chosenSummary.textContent = state.questions.length === 0
      ? "No questions selected yet."
      : `${state.questions.length} question${state.questions.length === 1 ? "" : "s"} · ${total} points in total`;
    updateRemoveBar();
    renderSummary();
  }

  /** The bar for the bank list: the count, "Add N to this exam", and the offer to take the whole result. */
  function updateAddBar() {
    const here = pickerPage.items.map((q) => q.id);
    const onPage = here.filter((id) => addTicks.has(id)).length;
    const n = addTicks.size;
    addBar.el.hidden = n === 0;
    addBar.actions.replaceChildren();
    addBar.all.replaceChildren();
    addBar.all.hidden = true;
    if (n === 0) { addBar.count.textContent = ""; addBar.note.textContent = ""; return; }
    addBar.count.textContent = `${n} ${n === 1 ? "question" : "questions"} selected`;
    const off = n - onPage;
    addBar.note.textContent = off > 0 ? `· ${off} not on this page` : "";
    const add = h("button", { class: "btn small", type: "button" }, `Add ${n} to this exam`);
    add.addEventListener("click", openAddQuestions);
    const clear = h("button", { class: "btn small ghost", type: "button" }, "Clear");
    clear.addEventListener("click", () => { addTicks.clear(); renderPicker(); });
    addBar.actions.append(add, clear);

    if (here.length > 0 && onPage === here.length && n < pickerPage.total) {
      const all = h("button", { class: "link-btn", type: "button" }, `Select all ${pickerPage.total} matching questions`);
      all.addEventListener("click", selectAllMatching);
      addBar.all.append(h("span", {}, `All ${here.length} question${here.length === 1 ? "" : "s"} on this page are selected. `), all);
      addBar.all.hidden = false;
    }
  }

  function renderPicker() {
    const already = onExam();
    pickerList.replaceChildren(...pickerPage.items.map((q) => {
      const on = already.has(q.id);
      const box = h("input", { type: "checkbox", class: "pick", checked: addTicks.has(q.id), disabled: on, "aria-label": `Select: ${plainText(q.body, 60)}` });
      box.addEventListener("change", () => { tick(addTicks, q.id, box.checked); updateAddBar(); });
      return h("div", { class: ["picker-item", on ? "on-exam" : "", addTicks.has(q.id) ? "picked" : ""].filter(Boolean).join(" "), role: "option", "data-id": q.id, "aria-selected": String(addTicks.has(q.id)) },
        box,
        h("span", { class: "grow" }, h("b", {}, plainText(q.body).slice(0, 90)), h("small", {}, ` ${TYPE_LABEL[q.type] ?? q.type} · ${q.topic ?? "no topic"}`)),
        on ? h("small", { class: "hint" }, "On this exam") : null);
    }));
    if (pickerPage.items.length === 0) pickerList.replaceChildren(h("p", { class: "sub" }, "Nothing in the bank matches."));
    updateAddBar();
  }

  async function searchBank() {
    try {
      const res = await questionBank.list({ q: pickerSearch.value || "", page_size: PICKER_PAGE });
      pickerPage.items = res.items;
      pickerPage.total = res.total;
      // Remember every question this editor has seen, so a tick that survives a change of search can still
      // be added with its real body, type and points.
      for (const q of res.items) pickerPage.byId.set(q.id, q);
      renderPicker();
    } catch (err) {
      if (!ignorable(err)) pickerList.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  /**
   * "Select all N matching questions": the ids of the whole search result, not just the page on screen. The
   * list API caps a page at 100, so this walks the pages the way the bank's own select-all does. When the
   * result is wider than the exam's ceiling it says so instead of quietly taking the first ones.
   */
  async function selectAllMatching() {
    const room = EXAM_MAX - state.questions.length;
    if (pickerPage.total > room) {
      addBar.note.textContent = `These filters match ${pickerPage.total} questions and this exam has room for ${room} more (the most it can hold is ${EXAM_MAX}). Narrow the search, or tick the ones you want.`;
      return;
    }
    addBar.note.textContent = "Selecting…";
    try {
      const already = onExam();
      const pages = Math.max(1, Math.ceil(pickerPage.total / SELECT_PAGE));
      for (let page = 1; page <= pages; page++) {
        const res = await questionBank.list({ q: pickerSearch.value || "", page, page_size: SELECT_PAGE });
        for (const q of res.items) {
          pickerPage.byId.set(q.id, q);
          if (!already.has(q.id)) addTicks.add(q.id);
        }
        if (res.items.length < SELECT_PAGE) break;
      }
      addBar.note.textContent = "";
      renderPicker();
    } catch (err) {
      addBar.note.textContent = ignorable(err) ? "" : errorText(err);
    }
  }

  const examTitle = () => state.title.trim() || "this exam";

  /** Add every ticked bank question, after showing exactly what is about to happen. */
  async function openAddQuestions() {
    const ids = [...addTicks];
    if (ids.length === 0) return;
    const already = onExam();
    const duplicate = ids.filter((id) => already.has(id)).length;
    const room = EXAM_MAX - state.questions.length;
    const notes = [];
    if (duplicate > 0) notes.push(`${duplicate} ${duplicate === 1 ? "is" : "are"} already on this exam and will not be added twice.`);
    if (ids.length - duplicate > room) notes.push(`This exam can hold ${EXAM_MAX} questions and has room for ${room} more.`);

    const applied = await examQuestionsDialog({
      mode: "add", count: ids.length, exam: { id: null, title: examTitle() }, notes,
      onApply: async () => {
        if (ids.length - duplicate > room) {
          throw new Error(`An exam can hold at most ${EXAM_MAX} questions. It has room for ${room} more.`);
        }
        for (const id of ids) {
          if (already.has(id)) continue;
          const q = pickerPage.byId.get(id);
          state.questions.push({ id, body: q ? q.body : "Question", type: q ? q.type : "multiple_choice", weight: q ? q.weight ?? 1 : 1 });
        }
        markDirty();
        addTicks.clear();
        renderChosen();
        searchBank();
      },
    });
    if (applied) toast(`${ids.length - duplicate} question${ids.length - duplicate === 1 ? "" : "s"} added to the exam. Save to keep the change.`);
  }

  /** Take every ticked question off the exam, after showing exactly what is about to happen. */
  async function openRemoveQuestions() {
    const ids = [...removeTicks];
    if (ids.length === 0) return;
    const applied = await examQuestionsDialog({
      mode: "remove", count: ids.length, exam: { id: null, title: examTitle() },
      onApply: async () => {
        state.questions = state.questions.filter((q) => !removeTicks.has(q.id));
        removeTicks.clear();
        markDirty();
        renderChosen();
      },
    });
    if (applied) toast(`${ids.length} question${ids.length === 1 ? "" : "s"} taken off the exam. Save to keep the change.`);
  }

  pickerSearch.addEventListener("input", debounce(searchBank, 250));

  // ---------- segmented controls helper ----------
  function seg(containerSel, attr, apply) {
    for (const btn of containerSel.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        for (const other of containerSel.querySelectorAll("button")) other.classList.remove("on");
        btn.classList.add("on");
        apply(btn.dataset[attr]);
        markDirty();
        renderSummary();
      });
    }
  }
  const segOn = (group, attr, value) => { for (const b of group.querySelectorAll("button")) b.classList.toggle("on", b.dataset[attr] === value); };

  seg(modeSeg, "mode", (v) => { state.availability_mode = v; syncSchedule(); });
  seg(lateSeg, "late", (v) => { state.late_start_policy = v; });
  seg(selSeg, "sel", (v) => { state.selection_mode = v; syncSelection(); if (v === "auto") refreshPoolCount(); });
  seg(resultSeg, "result", (v) => { state.result_visibility = v; });
  seg(essaySeg, "essay", (v) => { state.essay_pending_display = v; });

  function syncSchedule() {
    const scheduled = state.availability_mode === "scheduled";
    for (const el of [startsAt, endsAt]) el.disabled = !scheduled;
    for (const btn of lateSeg.querySelectorAll("button")) btn.disabled = !scheduled;
    h("div", {});
    scheduleWrap.hidden = !scheduled;
  }

  function syncSelection() {
    manualWrap.hidden = state.selection_mode !== "manual";
    autoWrap.hidden = state.selection_mode !== "auto";
  }

  // ---------- code checking (BR-17) ----------
  async function checkCode() {
    const code = codeInput.value.trim().toUpperCase();
    state.access_code = code;
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      codeStatus.className = "pill warn";
      codeStatus.textContent = code ? "Use 4–12 letters and digits" : "A code is required";
      return;
    }
    codeStatus.className = "pill";
    codeStatus.textContent = "checking…";
    try {
      const available = await exams.checkCode(code, state.id);
      codeStatus.className = `pill ${available ? "ok" : "bad"}`;
      codeStatus.textContent = available ? "Code is available" : "Already used by an open exam";
    } catch (err) {
      if (!ignorable(err)) { codeStatus.className = "pill warn"; codeStatus.textContent = "Could not check the code"; }
    }
  }
  codeInput.addEventListener("input", debounce(() => { markDirty(); checkCode(); }, 400));
  newCodeBtn.addEventListener("click", () => { codeInput.value = suggestCode(); markDirty(); checkCode(); });

  // ---------- pool count for auto selection ----------
  async function refreshPoolCount() {
    if (state.selection_mode !== "auto") return;
    const f = state.auto_filter;
    if (!f.class_label && !f.topic && !f.difficulty) { poolCountText.textContent = "Choose at least one filter to see how many questions match."; state.poolCount = null; renderSummary(); return; }
    try {
      const res = await questionBank.list({ class_label: f.class_label || "", topic: f.topic || "", difficulty: f.difficulty || "", page_size: 1 });
      state.poolCount = res.total;
      poolCountText.textContent = `${res.total} question${res.total === 1 ? "" : "s"} match this filter`;
    } catch (err) { if (!ignorable(err)) poolCountText.textContent = errorText(err); }
    renderSummary();
  }
  for (const el of [filterClass, filterTopic, filterDifficulty]) {
    el.addEventListener("input", debounce(() => {
      state.auto_filter = { class_label: filterClass.value.trim(), topic: filterTopic.value.trim(), difficulty: filterDifficulty.value };
      markDirty(); refreshPoolCount();
    }, 300));
  }
  drawToggle.addEventListener("change", () => { state.draw_per_student = drawToggle.checked; markDirty(); renderSummary(); });

  // ---------- summary ----------
  const summaryItems = h("div", { class: "summary-list" });
  const saveStatus = h("p", { class: "sub", role: "status" });
  const saveBtn = h("button", { class: "btn", type: "button" }, state.id ? "Save changes" : "Save as draft");
  const saveCloseBtn = h("button", { class: "btn ghost", type: "button" }, "Save and close");

  function renderSummary() {
    const items = [];
    const totalPts = state.questions.reduce((s, q) => s + (Number(q.weight) || 1), 0);
    items.push([state.title.trim() ? "ok" : "warn", state.title.trim() ? "Title and duration" : "Title is missing"]);
    if (state.selection_mode === "manual") {
      items.push([state.questions.length ? "ok" : "warn", state.questions.length ? `${state.questions.length} questions · ${totalPts} points` : "No questions selected"]);
    } else {
      items.push([state.poolCount ? "ok" : "warn", state.poolCount ? `${state.poolCount} questions match the filter` : "No questions match the filter yet"]);
    }
    items.push([/^[A-Z0-9]{4,12}$/.test(state.access_code) ? "ok" : "warn", `Code ${state.access_code || "missing"}`]);
    if (state.availability_mode === "scheduled" && state.starts_at && state.ends_at) items.push(["ok", "Schedule set"]);
    summaryItems.replaceChildren(...items.map(([kind, text]) =>
      h("div", { class: "tgl" }, h("span", { class: "row" }, h("span", { class: `pill ${kind}` }, kind === "ok" ? "✓" : "!"), text))));
  }

  function collect() {
    return {
      id: state.id, title: state.title, description: state.description, status: "draft",
      duration_minutes: Number(duration.value) || 45, passing_grade: Number(passing.value) || 0,
      availability_mode: state.availability_mode,
      starts_at: state.availability_mode === "scheduled" && startsAt.value ? new Date(startsAt.value).toISOString() : null,
      ends_at: state.availability_mode === "scheduled" && endsAt.value ? new Date(endsAt.value).toISOString() : null,
      late_start_policy: state.late_start_policy,
      access_code: state.access_code,
      selection_mode: state.selection_mode,
      auto_filter: state.selection_mode === "auto" ? state.auto_filter : null,
      pool_size: state.selection_mode === "auto" ? Number(poolSize.value) || 1 : null,
      draw_per_student: state.selection_mode === "auto" ? state.draw_per_student : false,
      questions: state.questions.map((q, i) => ({ question_id: q.id, weight: Number(q.weight) || 1, position: i })),
      randomize_questions: shuffleQ.checked, randomize_options: shuffleO.checked,
      result_visibility: state.result_visibility, essay_pending_display: state.essay_pending_display,
      tab_switch_warn_limit: Number(warnLimit.value) || 1,
      tab_switch_flag_limit: Number(flagLimit.value) || 3,
      tab_switch_autosubmit_limit: Number(submitLimit.value) || 5,
      is_template: state.is_template,
    };
  }

  async function save(thenClose) {
    saveStatus.textContent = "Saving…";
    saveBtn.disabled = saveCloseBtn.disabled = true;
    try {
      const id = await exams.save(collect());
      state.id = id; state.dirty = false; state.status = "draft";
      saveStatus.textContent = "Saved.";
      toast(state.is_template ? "Template saved." : "Exam saved as a draft.");
      clearLeaveGuard();
      if (thenClose) location.hash = "#/exams";
      else if (examId === null) location.hash = `#/exams/edit/${id}`; // adopt the new id in the URL
      else renderSummary();
    } catch (err) {
      saveStatus.textContent = "";
      if (!ignorable(err)) toast(errorText(err), "bad");
    } finally {
      saveBtn.disabled = saveCloseBtn.disabled = false;
    }
  }
  saveBtn.addEventListener("click", () => save(false));
  saveCloseBtn.addEventListener("click", () => save(true));

  // ---------- load existing ----------
  function fill() {
    title.value = state.title; description.value = state.description ?? "";
    duration.value = String(state.duration_minutes); passing.value = String(state.passing_grade);
    segOn(modeSeg, "mode", state.availability_mode); segOn(lateSeg, "late", state.late_start_policy);
    segOn(selSeg, "sel", state.selection_mode); segOn(resultSeg, "result", state.result_visibility);
    segOn(essaySeg, "essay", state.essay_pending_display);
    startsAt.value = localStamp(state.starts_at); endsAt.value = localStamp(state.ends_at);
    codeInput.value = state.access_code;
    filterClass.value = state.auto_filter.class_label ?? ""; filterTopic.value = state.auto_filter.topic ?? "";
    filterDifficulty.value = state.auto_filter.difficulty ?? ""; poolSize.value = String(state.pool_size ?? 10);
    drawToggle.checked = state.draw_per_student; shuffleQ.checked = state.randomize_questions; shuffleO.checked = state.randomize_options;
    warnLimit.value = String(state.tab_switch_warn_limit); flagLimit.value = String(state.tab_switch_flag_limit); submitLimit.value = String(state.tab_switch_autosubmit_limit);
    addTicks.clear(); removeTicks.clear();
    syncSchedule(); syncSelection(); renderChosen(); checkCode(); refreshPoolCount();
  }

  // ---------- layout ----------
  const scheduleWrap = h("div", { class: "stack" },
    h("div", { class: "form-row three" }, field("Date opens", startsAt), field("Closes", endsAt)),
    h("div", {}, h("span", { class: "lbl" }, "If a student starts late"), lateSeg));
  const manualWrap = h("div", { class: "stack" },
    h("div", { class: "picker-head row" }, h("span", { class: "lbl" }, "Pick questions"), pickerSearch),
    addBar.el, pickerList, chosenSummary, removeBar.el, chosenList, reorderHint, reorderNote);
  const autoWrap = h("div", { class: "stack", hidden: true },
    h("div", { class: "form-row three" }, field("Class", filterClass), field("Topic", filterTopic), field("Difficulty", filterDifficulty)),
    h("div", { class: "form-row" }, field("How many questions", poolSize), h("div", {}, h("span", { class: "lbl" }, "Filter"), poolCountText)),
    h("label", { class: "check" }, drawToggle, "Draw again for each student", h("small", {}, " — every student gets a different set")));

  mount(
    container,
    h("div", { class: "head" },
      h("div", {}, h("h1", {}, state.id ? "Edit exam" : "New exam"), h("p", { class: "sub" }, state.id ? "Saved exams stay drafts until you open them from the Exams list." : "The exam is saved as a draft first; open it from the list when it is ready.")),
      h("div", { class: "head-actions" }, h("a", { class: "btn ghost", href: "#/exams" }, "Back to exams"))),
    h("div", { class: "exam-editor-grid" },
      h("div", {},
        card("Details", h("div", { class: "stack" }, field("Title", title), field("Description (optional)", description),
          h("div", { class: "form-row" }, field("Duration (minutes)", duration), field("Passing grade", passing)))),
        card("Questions", h("div", { class: "stack" }, selSeg, manualWrap, autoWrap)),
        card("When students can take it", h("div", { class: "stack" }, modeSeg, scheduleWrap)),
        card("Test code", h("div", { class: "row" },
          h("div", { class: "grow" }, field("Students type this code to join", codeInput), h("div", { class: "row gap" }, codeStatus)),
          newCodeBtn)),
        card("Rules and results", h("div", { class: "stack" },
          h("label", { class: "check" }, shuffleQ, "Shuffle question order"),
          h("label", { class: "check" }, shuffleO, "Shuffle answer choices"),
          h("div", {}, h("span", { class: "lbl" }, "When a student leaves the test page"),
            h("small", {}, "Counts only when the page is hidden — the student switched to another app or tab. Notifications, the address bar and calls are recorded but never count."),
            h("div", { class: "form-row three" },
              fieldWithPill("Warn", "warn", warnLimit), fieldWithPill("Flag", "bad", flagLimit), fieldWithPill("Submit", "plain", submitLimit)))),
          h("div", {}, h("span", { class: "lbl" }, "After submitting, the student sees"), resultSeg),
          h("div", {}, h("span", { class: "lbl" }, "If an essay is not graded yet"), essaySeg))),
      h("div", {},
        card("Ready to open?", h("div", { class: "stack" }, summaryItems, saveStatus,
          h("div", { class: "stack" }, saveBtn, saveCloseBtn))),
        card("Template", h("div", { class: "stack" },
          h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { state.is_template = e.target.checked; markDirty(); } }, ), "Save as a template",
            h("small", {}, " — templates appear in the list with a filter and can be duplicated each term"))))),
    ),
  );

  function card(titleText, ...children) { return h("section", { class: "card sec" }, h("h5", {}, titleText), ...children); }
  function field(label, control) { return h("label", { class: "field" }, h("span", { class: "lbl" }, label), control); }
  function fieldWithPill(pillText, pillKind, control) {
    return h("label", { class: "field" }, h("span", { class: "lbl" }, h("span", { class: `pill ${pillKind}` }, pillText)), control);
  }

  // ---------- boot ----------
  if (state.id) {
    exams.get(state.id).then((exam) => {
      Object.assign(state, {
        title: exam.title, description: exam.description, status: exam.status,
        duration_minutes: exam.duration_minutes, passing_grade: Number(exam.passing_grade),
        availability_mode: exam.availability_mode, starts_at: exam.starts_at, ends_at: exam.ends_at,
        late_start_policy: exam.late_start_policy, access_code: exam.access_code,
        selection_mode: exam.selection_mode, auto_filter: exam.auto_filter ?? state.auto_filter,
        pool_size: exam.pool_size, draw_per_student: !!exam.draw_per_student,
        randomize_questions: !!exam.randomize_questions, randomize_options: !!exam.randomize_options,
        result_visibility: exam.result_visibility, essay_pending_display: exam.essay_pending_display,
        tab_switch_warn_limit: exam.tab_switch_warn_limit, tab_switch_flag_limit: exam.tab_switch_flag_limit,
        tab_switch_autosubmit_limit: exam.tab_switch_autosubmit_limit, is_template: !!exam.is_template,
        questions: (exam.questions ?? []).map((q) => ({ id: q.question_id, body: q.body ?? `Question ${q.position + 1}`, type: q.type ?? "multiple_choice", weight: Number(q.weight) || 1 })),
      });
      fill(); searchBank();
    }).catch((err) => {
      if (!ignorable(err)) toast(errorText(err), "bad");
    });
  } else {
    fill(); searchBank();
  }
}
