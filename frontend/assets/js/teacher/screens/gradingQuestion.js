import { h, mount, initials } from "../../shared/dom.js";
import { richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { toast } from "../../shared/ui.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { fmtPoints, pointsPicker } from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * Grade essays (mockup 13): one question for every student, in order, with the guide above the answer
 * and the points as answer-sheet bubbles. "Save and next student" moves to the next ungraded answer.
 */
export function renderGradingQuestion(container, ctx, { examId }) {
  const state = { questions: [], questionId: null, queue: null, selected: null, requestId: 0, saving: false };

  const title = h("h1", {}, "Grade essays");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const progressText = h("span", { class: "hint" }, "");
  const pickerRow = h("div", { class: "grade-questions" });
  const studentList = h("div", { class: "picker-list" });
  const sideCard = h("div", { class: "card sec grade-side" },
    h("h2", {}, "Students"), studentList);
  const panel = h("div", { class: "grade-main" });
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: "#/grading" }, icon("left"), "Grading"),
        title, subtitle),
      h("div", { class: "head-actions" }, progressText,
        h("a", { class: "btn ghost", href: `#/results/${examId}` }, icon("chart"), "Results"))),
    pickerRow,
    h("div", { class: "grade-layout" }, sideCard, panel),
    status,
  );

  function renderPicker() {
    if (state.questions.length <= 1) {
      pickerRow.replaceChildren();
      return;
    }
    pickerRow.replaceChildren(...state.questions.map((q) => {
      const btn = h("button", { class: `btn small ghost${q.question_id === state.questionId ? " on" : ""}`, type: "button" },
        `Q${q.position}`, h("span", { class: "hint" }, `${q.waiting} waiting · ${q.graded} of ${q.taken} graded`));
      btn.addEventListener("click", () => selectQuestion(q.question_id));
      return btn;
    }));
  }

  function renderProgress() {
    const q = state.questions.find((x) => x.question_id === state.questionId);
    if (!q) { progressText.textContent = ""; return; }
    progressText.textContent = `${q.graded} of ${q.taken} graded`;
  }

  function studentRow(student) {
    const waiting = !student.graded;
    const row = h("button", {
      class: `picker-item grade-student${student.session_id === state.selected ? " on" : ""}`,
      type: "button",
      "data-session": student.session_id,
    },
      h("span", { class: "avatar" }, initials(student.student_name)),
      h("span", { class: "grow" },
        h("b", {}, student.student_name),
        h("small", {}, `${student.student_class}${student.attempt_no > 1 ? ` · attempt ${student.attempt_no}` : ""}`)),
      student.graded
        ? h("span", { class: "pill ok" }, `${fmtPoints(student.points)} / ${fmtPoints(student.max_points)}`)
        : h("span", { class: "pill warn" }, student.is_blank ? "Blank" : "Waiting"));
    row.addEventListener("click", () => { state.selected = student.session_id; renderSide(); renderPanel(); });
    return row;
  }

  function renderSide() {
    const q = state.questions.find((x) => x.question_id === state.questionId);
    sideCard.querySelector("h2").textContent = q ? `Students · ${q.waiting} waiting` : "Students";
    const students = (state.queue && state.queue.students) || [];
    if (students.length === 0) {
      studentList.replaceChildren(h("div", { class: "picker-item" }, h("span", { class: "hint" }, "Nobody answered this question yet.")));
      return;
    }
    studentList.replaceChildren(...students.map(studentRow));
  }

  function nextWaiting(after) {
    const students = (state.queue && state.queue.students) || [];
    const waiting = students.filter((x) => !x.graded);
    if (waiting.length === 0) return null;
    const map = new Map(students.map((x, i) => [x.session_id, i]));
    const start = after && map.has(after) ? map.get(after) + 1 : 0;
    for (let i = 0; i < students.length; i++) {
      const s = students[(start + i) % students.length];
      if (!s.graded) return s.session_id;
    }
    return waiting[0].session_id;
  }

  function renderPanel() {
    const students = (state.queue && state.queue.students) || [];
    const student = students.find((x) => x.session_id === state.selected) || students[0];
    if (!student) {
      panel.replaceChildren(h("div", { class: "card sec" }, h("p", { class: "hint" }, "Choose a student to grade.")));
      return;
    }
    state.selected = student.session_id;

    const q = state.queue.question;
    const body = h("div", { class: "qtext serif" });
    body.append(richFragment(q.body || ""));
    const guide = q.guide
      ? h("div", { class: "guide" }, h("strong", {}, "Your guide. "), richFragment(q.guide))
      : h("p", { class: "hint" }, "This question has no grading guide. Add one in the question bank if it helps.");

    const answer = h("div", { class: "answerbox serif" });
    if (student.is_blank) {
      answer.append(h("p", { class: "hint" }, "Left blank. Zero points unless you decide otherwise."));
    } else {
      answer.append(document.createTextNode(student.answer));
    }

    const picker = pointsPicker({
      max: student.max_points,
      value: student.graded ? student.points : (student.is_blank ? 0 : null),
      name: "grade",
    });
    const comment = h("textarea", { class: "ta", rows: "2", id: "grade-comment", placeholder: "Comment for the student (optional)" });
    if (student.feedback) comment.value = student.feedback;

    const saveBtn = h("button", { class: "btn", type: "button", "data-save": "" }, "Save and next student");
    const skipBtn = h("button", { class: "btn small ghost", type: "button" }, "Skip for now");

    async function save() {
      if (state.saving) return;
      const points = picker.get();
      if (points === null || Number.isNaN(points)) {
        toast("Choose the points first.", "bad");
        return;
      }
      state.saving = true;
      saveBtn.disabled = true;
      try {
        const res = await results.grade({
          sessionId: student.session_id,
          questionId: state.questionId,
          points,
          feedback: comment.value,
        });
        toast(res.final ? "Saved. That was the last essay waiting — the result is final now." : "Saved.");
        window.dispatchEvent(new CustomEvent("staff:results-changed"));
        await refreshQueue({ after: student.session_id });
      } catch (err) {
        if (!ignorable(err)) toast(errorText(err), "bad");
      } finally {
        state.saving = false;
        saveBtn.disabled = false;
      }
    }

    saveBtn.addEventListener("click", save);
    skipBtn.addEventListener("click", () => {
      const next = nextWaiting(student.session_id);
      state.selected = next && next !== student.session_id ? next : student.session_id;
      renderSide();
      renderPanel();
    });

    panel.replaceChildren(
      h("div", { class: "card sec" },
        h("h2", {}, `Q${(state.questions.find((x) => x.question_id === state.questionId) || {}).position || ""} · ${fmtPoints(student.max_points)} points`),
        body, guide),
      h("div", { class: "card sec" },
        h("h2", {}, `${student.student_name}'s answer`),
        answer),
      h("div", { class: "card sec" },
        h("h2", {}, "Your grade"),
        picker.el,
        h("label", { class: "lbl spaced", for: "grade-comment" }, "Comment for the student (optional)"),
        comment,
        h("div", { class: "row grade-actions" }, skipBtn, saveBtn)),
    );
    comment.focus();
  }

  async function refreshQueue({ after = null } = {}) {
    const id = state.requestId;
    const queue = await results.queue(examId, state.questionId);
    if (id !== state.requestId) return;
    state.queue = queue;
    const q = state.questions.find((x) => x.question_id === state.questionId);
    if (q) { q.graded = queue.question.graded; q.waiting = queue.question.waiting; }
    renderProgress();
    renderPicker();
    const next = nextWaiting(after);
    if (next) state.selected = next;
    renderSide();
    renderPanel();
  }

  async function selectQuestion(questionId) {
    state.questionId = questionId;
    state.requestId++;
    const id = state.requestId;
    status.replaceChildren(h("p", { class: "sub" }, "Loading…"));
    try {
      const queue = await results.queue(examId, questionId);
      if (id !== state.requestId) return;
      state.queue = queue;
      state.selected = nextWaiting(null) || (queue.students[0] && queue.students[0].session_id) || null;
      status.replaceChildren();
      renderPicker();
      renderProgress();
      renderSide();
      renderPanel();
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  async function load() {
    state.requestId++;
    const id = state.requestId;
    try {
      const questions = await results.gradingQuestions(examId);
      if (id !== state.requestId) return;
      state.questions = questions;
      subtitle.textContent = questions.length === 0
        ? "This exam has no essay questions, so there is nothing to grade by hand."
        : `${questions.reduce((n, q) => n + q.waiting, 0)} answers are waiting for you.`;
      if (questions.length === 0) {
        pickerRow.replaceChildren();
        sideCard.hidden = true;
        panel.replaceChildren(h("div", { class: "card sec" },
          h("p", { class: "sub" }, "Every question in this exam is graded automatically."),
          h("a", { class: "btn", href: `#/results/${examId}` }, "See the results")));
        status.replaceChildren();
        return;
      }
      const first = questions.find((q) => q.waiting > 0) || questions[0];
      await selectQuestion(first.question_id);
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  load();
}
