import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * Exam monitor hub (#/monitor or #/monitor/:examId).
 * Shows open exams that have in-progress sessions, or a single exam's live view.
 * Mockup frame 12: teacher can watch who is working, progress, time left, page leaves.
 */
export function renderExamMonitor(container, ctx, { examId } = {}) {
  const state = { exams: [], requestId: 0, autoRefresh: null };

  const title = h("h1", {}, "Monitor");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const actions = h("div", { class: "head-actions" });
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: "#/exams" }, icon("left"), "Exams"),
        title, subtitle),
      actions),
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Exam"),
            h("th", { class: "col-code" }, "Code"),
            h("th", {}, "Sessions"),
            h("th", {}, "Active now"),
            h("th", {}, "Average"),
            h("th", {}, "Time left"),
            h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
          tbody)),
      status),
  );

  function row(exam) {
    const activeNow = exam.in_progress;
    const avg = exam.average != null ? Math.round(exam.average) : null;
    const timeLeft = avg != null && activeNow > 0 ? `${Math.round(exam.remaining_seconds / 60)} min` : "—";

    const details = h("a", { class: "link-btn", href: `#/monitor/${exam.exam_id}` }, "Watch");
    const results = h("a", { class: "link-btn", href: `#/results/${exam.exam_id}` }, "Results");

    return h("tr", { "data-exam": exam.exam_id },
      h("td", {},
        h("a", { class: "row-title", href: `#/monitor/${exam.exam_id}` }, exam.title),
        h("div", { class: "row-sub" },
          `${exam.sessions} ${exam.sessions === 1 ? "session" : "sessions"}`,
          exam.is_template ? " · template" : "",
          exam.pending_essays > 0 ? h("span", { class: "pill warn" }, ` ${exam.pending_essays} essay`) : null)),
      h("td", { class: "col-code" }, h("code", { class: "exam-code" }, exam.access_code)),
      h("td", {}, `${exam.finished} of ${exam.sessions}`),
      h("td", {},
        activeNow > 0
          ? h("span", { class: "pill ok" }, String(activeNow))
          : h("span", { class: "hint" }, "—")),
      h("td", {}, avg != null ? h("b", {}, `${avg}%`) : h("span", { class: "hint" }, "—")),
      h("td", {}, timeLeft),
      h("td", { class: "col-actions" }, details, results));
  }

  async function load() {
    const id = ++state.requestId;
    status.replaceChildren(h("p", { class: "sub" }, "Loading…"));
    try {
      const all = await results.activity();
      if (id !== state.requestId) return;
      state.exams = examId
        ? all.filter((e) => e.exam_id === examId)
        : all.filter((e) => e.in_progress > 0);
      subtitle.textContent = examId
        ? `Watching “${state.exams[0]?.title || "exam"}”`
        : (state.exams.length === 1
            ? "1 exam has students working right now"
            : `${state.exams.length} exams have students working right now`);
      tbody.replaceChildren(...state.exams.map(row));
      if (state.exams.length === 0) {
        status.replaceChildren(h("p", { class: "sub" },
          examId
            ? "This exam has no active sessions."
            : "No exam has students working right now. Share the code and come back."));
      } else {
        status.replaceChildren();
      }
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  function startAutoRefresh() {
    if (state.autoRefresh) return;
    state.autoRefresh = setInterval(() => { if (document.contains(container)) load(); }, 30_000);
  }

  function stopAutoRefresh() {
    if (state.autoRefresh) {
      clearInterval(state.autoRefresh);
      state.autoRefresh = null;
    }
  }

  load();
  startAutoRefresh();

  // Stop refreshing when the container leaves the DOM (route change)
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) stopAutoRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Cleanup on unmount (router calls replaceChildren which removes old content)
  return () => {
    stopAutoRefresh();
    observer.disconnect();
  };
}
