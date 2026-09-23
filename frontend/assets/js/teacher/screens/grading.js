import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { fmtScore, fmtWhen } from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

const examLink = (id) => `#/results/${id}`;
const gradeLink = (id) => `#/grading/${id}`;

/**
 * The two hubs behind the "Grading" and "Results" menu items.
 * `mode = "grading"` shows what still needs a teacher; `mode = "results"` shows every exam that has
 * been taken, with its numbers. Both come from one call (list_exam_activity).
 */
export function renderGradingHub(container, ctx, mode = "grading") {
  const wantsGrading = mode === "grading";
  const state = { items: [], requestId: 0 };

  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {}, h("h1", {}, wantsGrading ? "Grading" : "Results"), countText),
      h("div", { class: "head-actions" },
        h("a", { class: "btn ghost", href: "#/exams" }, icon("doc"), "All exams"))),
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Exam"),
            h("th", { class: "col-code" }, "Code"),
            h("th", {}, "Sessions"),
            h("th", {}, "Waiting"),
            h("th", {}, "Average"),
            h("th", {}, "Last finished"),
            h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
          tbody)),
      status),
  );

  function row(exam) {
    const waiting = exam.pending_essays > 0;
    const actions = h("div", { class: "row gap" });
    if (exam.essay_questions > 0) {
      actions.append(h("a", { class: "btn small ghost", href: gradeLink(exam.exam_id) }, icon("pencil"), "Grade essays"));
    }
    actions.append(h("a", { class: "btn small", href: examLink(exam.exam_id) }, "Results"));

    return h("tr", { "data-exam": exam.exam_id },
      h("td", {},
        h("a", { class: "row-title", href: examLink(exam.exam_id) }, exam.title),
        h("div", { class: "row-sub" },
          `${exam.essay_questions} essay ${exam.essay_questions === 1 ? "question" : "questions"}`,
          exam.is_template ? " · template" : "",
          exam.in_progress > 0 ? h("span", { class: "row-when" }, `${exam.in_progress} still taking it`) : null)),
      h("td", { class: "col-code" }, h("code", { class: "exam-code" }, exam.access_code)),
      h("td", {}, `${exam.finished} of ${exam.sessions}`),
      h("td", {}, waiting ? h("span", { class: "pill warn" }, String(exam.pending_essays)) : h("span", { class: "hint" }, "—")),
      h("td", {}, fmtScore(exam.average)),
      h("td", {}, fmtWhen(exam.last_submitted_at)),
      h("td", { class: "col-actions" }, actions));
  }

  async function load() {
    const id = ++state.requestId;
    status.replaceChildren(h("p", { class: "sub" }, "Loading…"));
    try {
      const all = await results.activity();
      if (id !== state.requestId) return;
      state.items = wantsGrading ? all.filter((e) => e.pending_essays > 0) : all;
      countText.textContent = wantsGrading
        ? (state.items.length === 1 ? "1 exam needs grading" : `${state.items.length} exams need grading`)
        : (state.items.length === 1 ? "1 exam has been taken" : `${state.items.length} exams have been taken`);
      tbody.replaceChildren(...state.items.map(row));
      if (state.items.length === 0) {
        status.replaceChildren(h("p", { class: "sub" }, wantsGrading
          ? "Nothing to grade right now. Results of finished exams are under Results."
          : "No exam has been taken yet."));
      } else {
        status.replaceChildren();
      }
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  load();
}
