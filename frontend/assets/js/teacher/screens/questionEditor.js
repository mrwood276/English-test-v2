import { h, mount } from "../../shared/dom.js";
import { plainText, richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast, confirmDialog, segmented } from "../../shared/ui.js";
import { questionBank } from "../api/questionBank.js";
import { questionView, TYPE_LABEL } from "../components/questionView.js";
import { richTextarea } from "../components/richTextarea.js";
import { chipsInput } from "../components/chipsInput.js";
import { passageDialog } from "../components/passageDialog.js";
import { setLeaveGuard, clearLeaveGuard } from "../guard.js";
import { SessionExpiredError } from "../../core/auth.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const MIN_MC = 2;
const MAX_MC = 6;
const MAX_ACCEPTED = 10;
const norm = (t) => String(t).replace(/\s+/g, " ").trim().toLowerCase();
const ignorable = (err) => err instanceof SessionExpiredError;

const blankMc = () => ["", "", "", ""].map((body) => ({ body, correct: false }));

/**
 * Add or edit a question. `id` is set when editing; `carry` keeps labels, topic, difficulty, and reading text
 * when the teacher chooses "Save and add another".
 */
export async function renderQuestionEditor(container, ctx, { id, carry = {} } = {}) {
  const myRender = container.dataset.render;
  const stale = () => container.dataset.render !== myRender;
  const isEdit = Boolean(id);

  mount(container, h("p", { class: "hint" }, "Loading…"));

  // ---------- load what the form needs ----------
  let loaded = null;
  let topics = [];
  let passages = [];
  try {
    [loaded, topics, passages] = await Promise.all([
      isEdit ? questionBank.get(id) : Promise.resolve(null),
      questionBank.topics().catch(() => []),
      questionBank.passages().catch(() => []),
    ]);
  } catch (err) {
    if (stale() || ignorable(err)) return;
    mount(container, h("div", { class: "notice error", role: "alert" }, err.message || "Could not load this question."), h("a", { class: "btn ghost", href: "#/questions" }, "Back to the question bank"));
    return;
  }
  if (stale()) return;

  // ---------- state ----------
  const state = {
    type: loaded ? loaded.type : "multiple_choice",
    difficulty: loaded ? loaded.difficulty : carry.difficulty || "medium",
    topic: loaded ? loaded.topic || "" : carry.topic || "",
    weight: loaded ? String(Number(loaded.weight)) : "1",
    body: loaded ? loaded.body : "",
    explanation: loaded ? loaded.explanation || "" : "",
    guidance: loaded ? loaded.essay_guidance || "" : "",
    labels: loaded ? [...loaded.class_labels] : [...(carry.labels || [])],
    passage: loaded ? loaded.passage : carry.passage || null,
    mc: blankMc(),
    tf: null, // 0 = True is correct, 1 = False is correct
    accepted: [""],
  };
  if (loaded && loaded.type === "multiple_choice") state.mc = loaded.options.map((o) => ({ body: o.body, correct: o.is_correct }));
  if (loaded && loaded.type === "true_false") state.tf = loaded.options.findIndex((o) => o.is_correct);
  if (loaded && loaded.type === "short_answer") state.accepted = loaded.accepted_answers.length ? [...loaded.accepted_answers] : [""];
  while (state.mc.length < MIN_MC) state.mc.push({ body: "", correct: false });

  const filled = (list) => list.map((s) => s.trim()).filter(Boolean);

  function draft() {
    const q = {
      type: state.type,
      difficulty: state.difficulty,
      topic: state.topic.trim(),
      weight: state.weight,
      body: state.body.trim(),
      explanation: state.explanation.trim(),
      essay_guidance: state.type === "essay" ? state.guidance.trim() : "",
      passage_id: state.passage ? state.passage.id : null,
      class_labels: state.labels,
      options: [],
      accepted_answers: [],
    };
    if (state.type === "multiple_choice") q.options = state.mc.filter((o) => o.body.trim()).map((o) => ({ body: o.body.trim(), is_correct: o.correct }));
    if (state.type === "true_false") q.options = [{ body: "True", is_correct: state.tf === 0 }, { body: "False", is_correct: state.tf === 1 }];
    if (state.type === "short_answer") q.accepted_answers = filled(state.accepted);
    return q;
  }

  let baseline = "";
  const snapshot = () => JSON.stringify([draft(), state.mc, state.accepted, state.guidance]);
  const isDirty = () => snapshot() !== baseline;

  // ---------- controls ----------
  const errors = {};
  const errorBox = (field) => h("div", { class: "field-error", id: `err-${field}`, role: "alert", hidden: true });
  const errEls = { body: errorBox("body"), answers: errorBox("answers"), weight: errorBox("weight") };
  function setError(field, message) {
    errors[field] = message;
    const el = errEls[field];
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  const typeSeg = segmented({ label: "Question type", name: "qtype", options: Object.entries(TYPE_LABEL), value: state.type, onChange: (v) => { state.type = v; setError("answers", ""); renderAnswers(); scheduleDup(); } });

  const bodyField = richTextarea({ id: "q-body", label: "the question", rows: 3, value: state.body, describedBy: "err-body" });
  bodyField.textarea.addEventListener("input", () => { state.body = bodyField.textarea.value; setError("body", ""); scheduleDup(); });
  const explanationField = richTextarea({ id: "q-explanation", label: "the explanation", rows: 2, value: state.explanation });
  explanationField.textarea.addEventListener("input", () => { state.explanation = explanationField.textarea.value; });

  const answersBox = h("div", { class: "answers" });

  // passage
  const passageSelect = h("select", { class: "inp", id: "q-passage", "aria-label": "Reading text" });
  const passageShown = h("div", { class: "passage-shown" });
  const passageOptions = () => {
    const known = passages.some((p) => state.passage && p.id === state.passage.id);
    const list = state.passage && !known ? [...passages, { id: state.passage.id, title: state.passage.title, question_count: 0 }] : passages;
    passageSelect.replaceChildren(
      h("option", { value: "" }, "No reading text"),
      ...list.map((p) => h("option", { value: p.id }, p.title)),
      h("option", { value: "__new" }, "New reading text…"),
    );
    passageSelect.value = state.passage ? state.passage.id : "";
  };
  async function showPassage() {
    passageShown.replaceChildren();
    if (!state.passage) return;
    const edit = h("button", { class: "btn small ghost", type: "button" }, "Edit text");
    edit.addEventListener("click", async () => {
      let full;
      try { full = await questionBank.passage(state.passage.id); } catch (err) { if (!ignorable(err)) toast(err.message, "error"); return; }
      const savedId = await passageDialog({ passage: full });
      if (savedId) await refreshPassages(savedId);
    });
    const body = h("div", { class: "passage" }, h("strong", { class: "passage-title" }, state.passage.title), h("div", { class: "passage-body serif", "data-passage-body": "" }));
    body.querySelector("[data-passage-body]").append(richFragment(state.passage.body));
    passageShown.append(body, edit, h("span", { class: "hint" }, "  Shared by every question that uses it."));
  }
  async function refreshPassages(selectId) {
    try { passages = await questionBank.passages(); } catch { /* keep the old list */ }
    if (selectId) {
      try { state.passage = await questionBank.passage(selectId); } catch { /* ignore */ }
    }
    passageOptions();
    showPassage();
    scheduleDup();
  }
  passageSelect.addEventListener("change", async () => {
    const value = passageSelect.value;
    if (value === "__new") {
      const savedId = await passageDialog();
      if (savedId) await refreshPassages(savedId);
      else passageOptions(); // cancelled: back to what was selected
      return;
    }
    if (!value) { state.passage = null; showPassage(); return; }
    try { state.passage = await questionBank.passage(value); showPassage(); } catch (err) { if (!ignorable(err)) toast(err.message, "error"); passageOptions(); }
  });

  // side controls
  const labels = chipsInput({
    id: "q-labels", label: "Class label", values: state.labels, placeholder: "Type a class, then press Enter",
    suggest: (prefix) => questionBank.classLabels(prefix),
    onChange: (values) => { state.labels = values; },
  });
  const topicInput = h("input", { class: "inp", id: "q-topic", type: "text", list: "q-topics", maxlength: "120", autocomplete: "off" });
  topicInput.value = state.topic;
  topicInput.addEventListener("input", () => { state.topic = topicInput.value; });
  const topicList = h("datalist", { id: "q-topics" }, topics.map((t) => h("option", { value: t.name })));
  const difficultySeg = segmented({ label: "Difficulty", name: "qdiff", options: [["easy", "Easy"], ["medium", "Medium"], ["hots", "HOTS"]], value: state.difficulty, onChange: (v) => { state.difficulty = v; } });
  const weightInput = h("input", { class: "inp narrow", id: "q-weight", type: "number", min: "0.01", max: "100", step: "0.5", inputmode: "decimal", "aria-describedby": "err-weight" });
  weightInput.value = state.weight;
  weightInput.addEventListener("input", () => { state.weight = weightInput.value; setError("weight", ""); });

  // duplicate check
  const dupBox = h("div", { class: "dup", hidden: true, "aria-live": "polite" });
  const dismissed = new Set();
  let dupSeq = 0;
  let lastMatches = [];
  function renderDup() {
    const shown = lastMatches.filter((m) => !dismissed.has(m.id)).slice(0, 3);
    if (shown.length === 0) { dupBox.hidden = true; dupBox.replaceChildren(); return; }
    const exact = shown.some((m) => m.exact);
    dupBox.className = exact ? "dup exact" : "dup";
    dupBox.hidden = false;
    dupBox.replaceChildren(
      h("div", { class: "row-flex" }, icon("alert"), h("strong", {}, exact ? "This exact question already exists" : "Looks similar to another question")),
      ...shown.map((m) => {
        const open = h("a", { href: `#/questions/edit/${m.id}`, target: "_blank", rel: "noopener" }, "Open it");
        const different = h("button", { class: "link-btn", type: "button" }, "It is different");
        different.addEventListener("click", () => { dismissed.add(m.id); renderDup(); });
        return h("div", { class: "dup-item" }, h("p", {}, `“${plainText(m.body, 110)}”`), h("p", { class: "hint" }, `${m.exact ? "Same question" : `${Math.round(m.similarity * 100)}% similar`}${m.is_archived ? ", archived" : ""}${m.used_in_exams ? `, used in ${m.used_in_exams} ${m.used_in_exams === 1 ? "exam" : "exams"}` : ""}`), h("div", { class: "row-flex" }, open, different));
      }),
    );
  }
  const runDup = async () => {
    const q = draft();
    if (plainText(q.body, 500).length < 8) { lastMatches = []; return renderDup(); }
    const seq = ++dupSeq;
    const options = state.type === "short_answer" ? q.accepted_answers : q.options.map((o) => o.body);
    try {
      const matches = await questionBank.checkDuplicates({ body: q.body, options, excludeId: id });
      if (seq !== dupSeq || stale()) return;
      lastMatches = matches;
      renderDup();
    } catch { /* the check is a help, not a requirement */ }
  };
  const scheduleDup = debounce(runDup, 700);

  // ---------- answers area ----------
  function bubbleButton(letter, correct, label, onClick) {
    const btn = h("button", { class: correct ? "bubble ok as-btn" : "bubble as-btn", type: "button", "aria-pressed": String(correct), "aria-label": label }, correct ? icon("check") : letter);
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderAnswers() {
    answersBox.replaceChildren();
    if (state.type === "multiple_choice") {
      state.mc.forEach((o, i) => {
        const input = h("input", { class: o.correct ? "inp correct" : "inp", type: "text", maxlength: "1000", "aria-label": `Answer ${LETTERS[i]}`, autocomplete: "off" });
        input.value = o.body;
        input.addEventListener("input", () => { o.body = input.value; setError("answers", ""); scheduleDup(); });
        const remove = h("button", { class: "icon-btn", type: "button", "aria-label": `Remove answer ${LETTERS[i]}`, disabled: state.mc.length <= MIN_MC }, icon("plus"));
        remove.addEventListener("click", () => { state.mc.splice(i, 1); renderAnswers(); scheduleDup(); });
        answersBox.append(h("div", { class: "optrow" }, bubbleButton(LETTERS[i], o.correct, `Mark answer ${LETTERS[i]} as the correct one`, () => { state.mc.forEach((x, j) => (x.correct = j === i)); setError("answers", ""); renderAnswers(); }), input, remove));
      });
      const add = h("button", { class: "btn small ghost", type: "button", disabled: state.mc.length >= MAX_MC }, icon("plus"), "Add an answer");
      add.addEventListener("click", () => { state.mc.push({ body: "", correct: false }); renderAnswers(); answersBox.querySelectorAll("input")[state.mc.length - 1].focus(); });
      answersBox.append(add, h("p", { class: "hint" }, "Select the bubble of the correct answer."));
    } else if (state.type === "true_false") {
      ["True", "False"].forEach((text, i) => {
        answersBox.append(h("div", { class: "optrow" }, bubbleButton(text[0], state.tf === i, `Mark ${text} as the correct answer`, () => { state.tf = i; setError("answers", ""); renderAnswers(); }), h("div", { class: state.tf === i ? "inp static correct" : "inp static" }, text)));
      });
      answersBox.append(h("p", { class: "hint" }, "Select the bubble of the right answer to your statement."));
    } else if (state.type === "short_answer") {
      state.accepted.forEach((text, i) => {
        const input = h("input", { class: "inp", type: "text", maxlength: "300", "aria-label": `Accepted answer ${i + 1}`, autocomplete: "off" });
        input.value = text;
        input.addEventListener("input", () => { state.accepted[i] = input.value; setError("answers", ""); scheduleDup(); });
        const remove = h("button", { class: "icon-btn", type: "button", "aria-label": `Remove accepted answer ${i + 1}`, disabled: state.accepted.length <= 1 }, icon("plus"));
        remove.addEventListener("click", () => { state.accepted.splice(i, 1); renderAnswers(); scheduleDup(); });
        answersBox.append(h("div", { class: "optrow" }, input, remove));
      });
      const add = h("button", { class: "btn small ghost", type: "button", disabled: state.accepted.length >= MAX_ACCEPTED }, icon("plus"), "Add another accepted answer");
      add.addEventListener("click", () => { state.accepted.push(""); renderAnswers(); answersBox.querySelectorAll("input")[state.accepted.length - 1].focus(); });
      answersBox.append(add, h("p", { class: "hint" }, "Letter case and extra spaces are ignored when checking. Add every spelling you accept."));
    } else {
      const guide = richTextarea({ id: "q-guidance", label: "the grading guide", rows: 3, value: state.guidance });
      guide.textarea.addEventListener("input", () => { state.guidance = guide.textarea.value; });
      answersBox.append(h("label", { class: "lbl", for: "q-guidance" }, "Grading guide (only you see this)"), guide.el, h("p", { class: "hint" }, "Students write a longer answer. You grade it later, so the result stays “not final” until then."));
    }
  }

  // ---------- validation ----------
  function validate() {
    const found = [];
    const add = (field, message, focus) => found.push({ field, message, focus });
    if (!plainText(state.body, 20).length) add("body", "Write the question.", "#q-body");
    if (state.type === "multiple_choice") {
      const withText = state.mc.filter((o) => o.body.trim());
      const correct = state.mc.find((o) => o.correct);
      if (withText.length < MIN_MC) add("answers", "Add at least 2 answers.", ".answers input");
      else if (new Set(withText.map((o) => norm(o.body))).size !== withText.length) add("answers", "Two answers are the same. Each answer must be different.", ".answers input");
      else if (!correct) add("answers", "Select the bubble of the correct answer.", ".answers .bubble");
      else if (!correct.body.trim()) add("answers", "The answer marked as correct is empty.", ".answers input");
    } else if (state.type === "true_false") {
      if (state.tf === null) add("answers", "Choose whether the statement is True or False.", ".answers .bubble");
    } else if (state.type === "short_answer") {
      const list = filled(state.accepted);
      if (list.length === 0) add("answers", "Add at least one accepted answer.", ".answers input");
      else if (new Set(list.map(norm)).size !== list.length) add("answers", "Two accepted answers are the same.", ".answers input");
    }
    const weight = Number(state.weight);
    if (state.weight === "" || !Number.isFinite(weight) || weight <= 0 || weight > 100) add("weight", "Points must be more than 0 and at most 100.", "#q-weight");
    return found;
  }

  // ---------- header, summary, buttons ----------
  const summary = h("div", { class: "notice error", role: "alert", hidden: true });
  const saveBtn = h("button", { class: "btn", type: "button" }, "Save question");
  const saveMoreBtn = isEdit ? null : h("button", { class: "btn ghost", type: "button" }, "Save and add another");
  const previewBtn = h("button", { class: "btn ghost", type: "button" }, "Preview");

  function showSummary(messages) {
    summary.replaceChildren(...(messages.length > 1 ? [h("strong", {}, "Please fix these first:"), h("ul", {}, messages.map((m) => h("li", {}, m)))] : [messages[0]]));
    summary.hidden = false;
  }

  async function save(addAnother) {
    summary.hidden = true;
    ["body", "answers", "weight"].forEach((f) => setError(f, ""));
    const problems = validate();
    if (problems.length) {
      problems.forEach((p) => setError(p.field, p.message));
      showSummary(problems.map((p) => p.message));
      const target = container.querySelector(problems[0].focus);
      if (target) target.focus();
      return;
    }
    const buttons = [saveBtn, saveMoreBtn, previewBtn].filter(Boolean);
    buttons.forEach((b) => (b.disabled = true));
    saveBtn.textContent = "Saving…";
    try {
      const payload = { ...draft(), weight: Number(state.weight), topic: state.topic.trim() || null, explanation: state.explanation.trim() || null, essay_guidance: state.type === "essay" ? state.guidance.trim() || null : null };
      await questionBank.save({ id: isEdit ? id : undefined, ...payload });
      baseline = snapshot();
      clearLeaveGuard();
      toast("Question saved.");
      if (addAnother) {
        const keep = { labels: state.labels, topic: state.topic, difficulty: state.difficulty, passage: state.passage };
        if (location.hash === "#/questions/new") renderQuestionEditor(container, ctx, { carry: keep });
        else location.hash = "#/questions/new";
      } else {
        location.hash = "#/questions";
      }
    } catch (err) {
      if (ignorable(err)) return;
      showSummary([err.message || "Could not save the question. Please try again."]);
      summary.scrollIntoView({ block: "nearest" });
      buttons.forEach((b) => (b.disabled = false));
      saveBtn.textContent = "Save question";
    }
  }
  saveBtn.addEventListener("click", () => save(false));
  if (saveMoreBtn) saveMoreBtn.addEventListener("click", () => save(true));

  previewBtn.addEventListener("click", () => {
    const q = draft();
    const view = { ...q, weight: Number(q.weight) || 1, essay_guidance: q.essay_guidance || null, explanation: q.explanation || null, passage: state.passage, media: [], topic: q.topic || null, is_archived: loaded ? loaded.is_archived : false };
    const close = h("button", { class: "btn", type: "button" }, "Close");
    const dialog = h("dialog", { class: "dialog wide", "aria-labelledby": "preview-title" }, h("h2", { id: "preview-title" }, "Preview"), h("div", { class: "preview-body" }, ...questionView(view)), h("div", { class: "dialog-actions" }, close));
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });

  // ---------- page ----------
  const notes = [];
  if (loaded && loaded.is_archived) notes.push(h("div", { class: "notice info" }, "This question is archived, so it is hidden from the question bank. You can restore it from the list."));
  if (loaded && loaded.used_in_exams > 0) notes.push(h("div", { class: "notice info" }, `Used in ${loaded.used_in_exams} ${loaded.used_in_exams === 1 ? "exam" : "exams"}. Changes do not affect tests that already started.`));

  mount(
    container,
    h("div", { class: "editor" },
      h("div", { class: "head" },
        h("div", {}, h("a", { class: "back", href: "#/questions" }, icon("left"), "Question bank"), h("h1", {}, isEdit ? "Edit question" : "Add question")),
        h("div", { class: "row-flex" }, previewBtn, saveMoreBtn, saveBtn)),
      ...notes, summary,
      h("div", { class: "editor-grid" },
        h("div", { class: "editor-main" },
          h("section", { class: "card sec", "aria-labelledby": "h-type" }, h("h2", { id: "h-type" }, "Type"), typeSeg.el),
          h("section", { class: "card sec", "aria-labelledby": "h-passage" },
            h("h2", { id: "h-passage" }, "Reading text and media"),
            h("label", { class: "lbl", for: "q-passage" }, "Reading text (optional)"), passageSelect, passageShown,
            h("div", { class: "drop", "aria-disabled": "true" }, icon("image"), h("span", {}, "Images and audio can be added in the next step."))),
          h("section", { class: "card sec", "aria-labelledby": "h-question" },
            h("h2", { id: "h-question" }, "Question and answers"),
            h("label", { class: "lbl", for: "q-body" }, "Question"), bodyField.el, errEls.body,
            h("div", { class: "lbl spaced" }, "Answers"), answersBox, errEls.answers,
            h("label", { class: "lbl spaced", for: "q-explanation" }, "Explanation (shown after the test only if you allow it)"), explanationField.el)),
        h("div", { class: "editor-side" },
          h("section", { class: "card sec", "aria-labelledby": "h-labels" }, h("h2", { id: "h-labels" }, "Class labels"), labels.el),
          h("section", { class: "card sec", "aria-labelledby": "h-details" },
            h("h2", { id: "h-details" }, "Details"),
            h("label", { class: "lbl", for: "q-topic" }, "Topic"), topicInput, topicList,
            h("div", { class: "lbl spaced" }, "Difficulty"), difficultySeg.el,
            h("label", { class: "lbl spaced", for: "q-weight" }, "Points"), weightInput, errEls.weight),
          dupBox)),
    ),
  );

  passageOptions();
  showPassage();
  renderAnswers();
  baseline = snapshot();

  // Ask before leaving with unsaved changes.
  setLeaveGuard(async () => {
    if (!isDirty()) return true;
    return confirmDialog({ title: "Leave without saving?", message: "You have changes that are not saved yet. If you leave now, they are lost.", confirmLabel: "Leave", cancelLabel: "Keep editing", danger: true });
  });
  if (isEdit) runDup();
}
