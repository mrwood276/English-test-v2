import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { toast, confirmDialog } from "../../shared/ui.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { fmtDuration, liveStatusPill, minutesSelect } from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * Live monitor (mockup 12).
 * `#/monitor` — exams that currently have students working.
 * `#/monitor/:examId` — every student in that exam (progress, time left, page leaves).
 */
export function renderExamMonitor(container, ctx, { examId } = {}) {
  if (examId) return renderExamSessions(container, examId);
  return renderActiveExams(container);
}

function renderActiveExams(container) {
  const state = { requestId: 0, timer: null };
  const title = h("h1", {}, "Monitor");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {}, title, subtitle)),
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Exam"),
            h("th", { class: "col-code" }, "Code"),
            h("th", {}, "Working"),
            h("th", {}, "Finished"),
            h("th", {}, "Waiting essays"),
            h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
          tbody)),
      status),
  );

  function row(exam) {
    return h("tr", { "data-exam": exam.exam_id },
      h("td", {},
        h("a", { class: "row-title", href: `#/monitor/${exam.exam_id}` }, exam.title),
        h("div", { class: "row-sub" }, `${exam.sessions} joined`)),
      h("td", { class: "col-code" }, h("code", { class: "exam-code" }, exam.access_code)),
      h("td", {}, h("span", { class: "pill ok" }, String(exam.in_progress))),
      h("td", {}, String(exam.finished)),
      h("td", {}, exam.pending_essays > 0
        ? h("span", { class: "pill warn" }, String(exam.pending_essays))
        : h("span", { class: "hint" }, "—")),
      h("td", { class: "col-actions" },
        h("a", { class: "link-btn", href: `#/monitor/${exam.exam_id}` }, "Watch"),
        h("a", { class: "link-btn", href: `#/results/${exam.exam_id}` }, "Results")));
  }

  async function load() {
    const id = ++state.requestId;
    try {
      const all = await results.activity();
      if (id !== state.requestId) return;
      const exams = all.filter((e) => e.in_progress > 0);
      subtitle.textContent = exams.length === 1
        ? "1 exam has students working right now"
        : `${exams.length} exams have students working right now`;
      tbody.replaceChildren(...exams.map(row));
      status.replaceChildren(exams.length === 0
        ? h("p", { class: "sub" }, "No exam has students working right now. Share the code and come back.")
        : null);
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  return startRefresh(container, state, load, 30_000);
}

function renderExamSessions(container, examId) {
  const state = { requestId: 0, timer: null };
  const title = h("h1", {}, "Monitor");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const actions = h("div", { class: "head-actions" });
  // Built once and re-appended on every load, so the minutes a teacher picked survive the refresh.
  // The exam-wide twin of BR-11: a class that started late gets five more minutes in one action.
  const addAllMinutes = minutesSelect({ id: "monitor-add-all", value: 5 });
  const addAllBtn = h("button", { class: "btn small", type: "button", "data-add-all": "" }, "Add time to everyone");
  const addAll = h("div", { class: "row add-all" }, addAllMinutes, addAllBtn);
  const strip = h("div", { class: "strip" });
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: "#/monitor" }, icon("left"), "Monitor"),
        title, subtitle),
      actions),
    strip,
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Student"),
            h("th", {}, "Class"),
            h("th", {}, "Progress"),
            h("th", {}, "Time left"),
            h("th", {}, "Exits"),
            h("th", {}, "Status"),
            h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
          tbody)),
      status),
  );

  function progressCell(r, questionCount) {
    const answered = r.answered_count;
    const total = r.question_count ?? questionCount;
    if (answered == null || total == null || total <= 0) {
      if (r.has_result) return h("span", {}, "Done");
      return h("span", { class: "hint" }, "—");
    }
    const pct = Math.round((answered / total) * 100);
    return h("span", { class: "prog", "aria-label": `${answered} of ${total}` },
      h("span", { class: "prog-track" }, h("i", { style: `width:${Math.min(100, Math.max(0, pct))}%` })),
      ` ${answered}/${total}`);
  }

  function row(r, questionCount) {
    const working = r.status === "in_progress" || r.status === "reopened";
    return h("tr", { "data-session": r.session_id },
      h("td", {},
        h("a", { class: "row-title", href: `#/monitor/${examId}/session/${r.session_id}` }, r.student_name),
        r.attempt_no > 1 ? h("div", { class: "row-sub" }, `Attempt ${r.attempt_no}`) : null),
      h("td", {}, r.class_display || r.student_class),
      h("td", {}, progressCell(r, questionCount)),
      h("td", {}, working
        ? (r.remaining_seconds != null ? fmtDuration(r.remaining_seconds) : "—")
        : "Done"),
      h("td", {}, r.tab_switch_count > 0
        ? h("b", { class: "exit-warn" }, String(r.tab_switch_count))
        : "0"),
      h("td", {}, liveStatusPill(r)),
      h("td", { class: "col-actions" },
        h("a", { class: "link-btn", href: `#/monitor/${examId}/session/${r.session_id}` }, "Open")));
  }

  async function load() {
    const id = ++state.requestId;
    try {
      const overview = await results.overview(examId);
      if (id !== state.requestId) return;
      const { exam, summary, rows } = overview;
      const questionCount = rows.find((r) => r.question_count != null)?.question_count ?? null;
      title.textContent = exam.title;
      subtitle.textContent = `Code ${exam.access_code}${exam.ends_at ? ` · closes ${new Date(exam.ends_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`;
      actions.replaceChildren(
        h("a", { class: "btn ghost", href: `#/results/${examId}` }, icon("chart"), "Results"),
        h("a", { class: "btn ghost", href: `#/exams/edit/${examId}` }, icon("doc"), "Open the exam"),
        addAll);
      // Nobody working means nothing to give time to; the button says why instead of failing.
      const working = summary.in_progress || 0;
      addAllBtn.disabled = working === 0;
      addAllMinutes.disabled = working === 0;
      addAll.title = working === 0
        ? "Nobody is working on this test right now."
        : `Every student still working gets ${addAllMinutes.value} more minutes.`;
      strip.replaceChildren(
        h("span", {}, h("b", {}, String(summary.in_progress || 0)), " working"),
        h("span", {}, h("b", {}, String(summary.with_result || 0)), " submitted"),
        h("span", {}, h("b", {}, String(rows.length)), " joined so far"),
        summary.pending_essays > 0
          ? h("span", { class: "pill warn" }, `${summary.pending_essays} essay`)
          : null);
      const ordered = [...rows].sort((a, b) => {
        const aw = a.status === "in_progress" || a.status === "reopened" ? 0 : 1;
        const bw = b.status === "in_progress" || b.status === "reopened" ? 0 : 1;
        if (aw !== bw) return aw - bw;
        return (a.student_name || "").localeCompare(b.student_name || "");
      });
      tbody.replaceChildren(...ordered.map((r) => row(r, questionCount)));
      status.replaceChildren(rows.length === 0
        ? h("p", { class: "sub" }, "Nobody has joined this test yet. Share the code with the class.")
        : null);
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  addAllBtn.addEventListener("click", async () => {
    const minutes = Number(addAllMinutes.value);
    const ok = await confirmDialog({
      title: "Add time to everyone still working?",
      message: `${minutes} more minutes for every student still on this test. Students who already sent theirs in are not touched.`,
      confirmLabel: "Add time",
    });
    if (!ok) return;
    addAllBtn.disabled = true;
    try {
      const res = await results.addExamTime(examId, minutes);
      toast(`Time added for ${res.updated} ${res.updated === 1 ? "student" : "students"}.`);
      await load();
    } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
    finally { addAllBtn.disabled = false; }
  });

  return startRefresh(container, state, load, 15_000);
}

function startRefresh(container, state, load, ms) {
  load();
  state.timer = setInterval(() => { if (document.contains(container)) load(); }, ms);
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function cleanup() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    observer.disconnect();
  }
  return cleanup;
}
