import { h, mount } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast } from "../../shared/ui.js";
import { exams } from "../api/exams.js";
import { questionBank } from "../api/questionBank.js";
import { TYPE_LABEL } from "../components/questionView.js";
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
  });

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
  const pickerSearch = h("input", { class: "input", type: "search", placeholder: "Search the bank…", "aria-label": "Search questions" });
  const pickerList = h("div", { class: "picker-list", role: "listbox", "aria-label": "Questions in the bank" });
  const chosenList = h("div", { class: "picker-list chosen" });
  const chosenSummary = h("p", { class: "sub" }, "No questions selected yet.");

  function chosenRow(q, index) {
    const up = h("button", { class: "btn small ghost", type: "button", "aria-label": `Move ${plainText(q.body)} up` }, "↑");
    const down = h("button", { class: "btn small ghost", type: "button", "aria-label": `Move ${plainText(q.body)} down` }, "↓");
    const weight = h("input", { class: "input weight-input", type: "number", min: "0.01", max: "100", step: "0.5", value: String(q.weight ?? 1), "aria-label": `Points for ${plainText(q.body)}` });
    const rm = h("button", { class: "btn small ghost", type: "button", "aria-label": `Remove ${plainText(q.body)}` }, "✕");
    up.addEventListener("click", () => { if (index > 0) { [state.questions[index - 1], state.questions[index]] = [state.questions[index], state.questions[index - 1]]; markDirty(); renderChosen(); } });
    down.addEventListener("click", () => { if (index < state.questions.length - 1) { [state.questions[index + 1], state.questions[index]] = [state.questions[index], state.questions[index + 1]]; markDirty(); renderChosen(); } });
    weight.addEventListener("change", () => { q.weight = Number(weight.value) || 1; markDirty(); renderSummary(); });
    rm.addEventListener("click", () => { state.questions.splice(index, 1); markDirty(); renderChosen(); renderSummary(); });
    return h("div", { class: "picker-item chosen-item", role: "listitem" },
      h("span", { class: "grow" }, h("b", {}, plainText(q.body).slice(0, 90)), h("small", {}, ` ${TYPE_LABEL[q.type] ?? q.type}`)),
      h("label", { class: "weight" }, "pts", weight), up, down, rm);
  }

  function renderChosen() {
    chosenList.replaceChildren(...state.questions.map(chosenRow));
    const total = state.questions.reduce((s, q) => s + (Number(q.weight) || 1), 0);
    chosenSummary.textContent = state.questions.length === 0
      ? "No questions selected yet."
      : `${state.questions.length} question${state.questions.length === 1 ? "" : "s"} · ${total} points in total`;
    renderSummary();
  }

  async function searchBank() {
    try {
      const res = await questionBank.list({ q: pickerSearch.value || "", page_size: 8 });
      const chosenIds = new Set(state.questions.map((q) => q.id));
      pickerList.replaceChildren(...res.items.map((q) => {
        const picked = chosenIds.has(q.id);
        const add = h("button", { class: "btn small ghost", type: "button", disabled: picked }, picked ? "Added" : "Add");
        add.addEventListener("click", () => {
          state.questions.push({ id: q.id, body: q.body, type: q.type, weight: q.weight ?? 1 });
          markDirty(); renderChosen(); searchBank();
        });
        return h("div", { class: "picker-item", role: "option", "aria-selected": String(picked) },
          h("span", { class: "grow" }, h("b", {}, plainText(q.body).slice(0, 90)), h("small", {}, ` ${TYPE_LABEL[q.type] ?? q.type} · ${q.topic ?? "no topic"}`)),
          add);
      }));
      if (res.items.length === 0) pickerList.replaceChildren(h("p", { class: "sub" }, "Nothing in the bank matches."));
    } catch (err) { if (!ignorable(err)) pickerList.replaceChildren(h("p", { class: "sub" }, errorText(err))); }
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
    syncSchedule(); syncSelection(); renderChosen(); checkCode(); refreshPoolCount();
  }

  // ---------- layout ----------
  const scheduleWrap = h("div", { class: "stack" },
    h("div", { class: "form-row three" }, field("Date opens", startsAt), field("Closes", endsAt)),
    h("div", {}, h("span", { class: "lbl" }, "If a student starts late"), lateSeg));
  const manualWrap = h("div", { class: "stack" },
    h("div", { class: "picker-head row" }, h("span", { class: "lbl" }, "Pick questions"), pickerSearch),
    pickerList, chosenSummary, chosenList);
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
