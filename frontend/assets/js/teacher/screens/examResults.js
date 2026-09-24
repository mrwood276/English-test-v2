import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { fmtDuration, fmtScore, statusPill, summaryStrip } from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(exam, rows) {
  const columns = ["Name", "Class", "Attempt", "Score", "Right", "Wrong", "Time used (seconds)", "Page leaves", "Status"];
  const lines = [columns, ...rows.map((r) => [
    r.student_name,
    r.class_display || r.student_class,
    r.attempt_no,
    r.has_result ? r.percentage : "",
    r.has_result ? r.correct_count : "",
    r.has_result ? r.wrong_count : "",
    r.has_result ? r.time_used_seconds : "",
    r.tab_switch_count,
    r.has_result ? (r.pass_status || r.result_status) : r.status,
  ])].map((line) => line.map(csvCell).join(","));
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `${(exam.title || "results").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "results"}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function classStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const name = row.class_display || row.student_class || "Unknown class";
    const group = groups.get(name) || { name, students: 0, scores: [], passed: 0, notFinal: 0 };
    group.students += 1;
    if (row.has_result && row.percentage !== null && row.percentage !== undefined) group.scores.push(Number(row.percentage));
    if (row.pass_status === "passed") group.passed += 1;
    if (row.pass_status === "not_final") group.notFinal += 1;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The results of one exam (mockup 14): summary line, then one row per student who joined. */
export function renderExamResults(container, ctx, { examId }) {
  const state = { overview: null, requestId: 0 };

  const title = h("h1", {}, "Results");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const actions = h("div", { class: "head-actions" });
  const strip = h("div", { class: "strip" });
  const tabs = h("div", { class: "results-tabs", role: "tablist", "aria-label": "Results views" });
  const scoresTab = h("button", { class: "results-tab on", type: "button", role: "tab", "aria-selected": "true" }, "Scores");
  const classesTab = h("button", { class: "results-tab", type: "button", role: "tab", "aria-selected": "false" }, "Classes");
  const classesPanel = h("div", { class: "card list-card results-stats", hidden: true });
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: "#/results" }, icon("left"), "Results"),
        title, subtitle),
      actions),
    strip,
    tabs,
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Name"),
            h("th", {}, "Class"),
            h("th", {}, "Score"),
            h("th", {}, "Right / wrong"),
            h("th", {}, "Time"),
            h("th", {}, "Exits"),
            h("th", {}, "Status"),
            h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
          tbody)),
      status),
    classesPanel,
  );

  tabs.append(scoresTab, classesTab);
  function showTab(tab) {
    const scores = tab === "scores";
    scoresTab.classList.toggle("on", scores);
    classesTab.classList.toggle("on", !scores);
    scoresTab.setAttribute("aria-selected", String(scores));
    classesTab.setAttribute("aria-selected", String(!scores));
    tbody.closest(".list-card").hidden = !scores;
    classesPanel.hidden = scores;
  }
  scoresTab.addEventListener("click", () => showTab("scores"));
  classesTab.addEventListener("click", () => showTab("classes"));

  function row(r) {
    const details = h("a", { class: "link-btn", href: `#/results/${examId}/session/${r.session_id}` }, "Details");
    return h("tr", { "data-session": r.session_id },
      h("td", {},
        h("b", {}, r.student_name),
        r.attempt_no > 1 ? h("div", { class: "row-sub" }, `Attempt ${r.attempt_no}`) : null,
        r.retake_granted ? h("div", { class: "row-sub" }, r.retake_used ? "Retake used" : "Retake allowed") : null),
      h("td", {}, r.class_display || r.student_class),
      h("td", {}, r.has_result ? h("b", {}, fmtScore(r.percentage)) : h("span", { class: "hint" }, "—")),
      h("td", {}, r.has_result ? `${r.correct_count} / ${r.wrong_count}` : h("span", { class: "hint" }, "—")),
      h("td", {}, r.status === "in_progress" || r.status === "reopened"
        ? h("span", { class: "hint" }, `${fmtDuration(r.remaining_seconds)} left`)
        : fmtDuration(r.time_used_seconds)),
      h("td", {}, r.tab_switch_count > 0
        ? h("b", { style: "color:var(--warn-ink, #8a6a00)" }, String(r.tab_switch_count))
        : "0"),
      h("td", {}, statusPill(r),
        r.pending_essays > 0 ? h("span", { class: "pill warn" }, `${r.pending_essays} essay`) : null),
      h("td", { class: "col-actions" }, details));
  }

  async function load() {
    const id = ++state.requestId;
    try {
      const overview = await results.overview(examId);
      if (id !== state.requestId) return;
      state.overview = overview;
      const { exam, summary } = overview;
      title.textContent = exam.title;
      subtitle.textContent = `${summary.with_result} of ${overview.rows.length} sessions have a result · code ${exam.access_code} · passing ${fmtScore(exam.passing_grade)}`;
      strip.replaceChildren(...summaryStrip(summary, exam.passing_grade).children);

      actions.replaceChildren();
      actions.append(h("button", { class: "btn ghost", type: "button", "data-export-csv": "true" }, icon("sheet"), "Export CSV"));
      actions.querySelector("[data-export-csv]").addEventListener("click", () => downloadCsv(exam, overview.rows));
      if (summary.pending_essays > 0) {
        actions.append(h("a", { class: "btn", href: `#/grading/${examId}` }, icon("pencil"), `Grade ${summary.pending_essays} ${summary.pending_essays === 1 ? "essay" : "essays"}`));
      }
      actions.append(h("a", { class: "btn ghost", href: `#/exams/edit/${examId}` }, icon("doc"), "Open the exam"));

      tbody.replaceChildren(...overview.rows.map(row));
      const classRows = classStats(overview.rows).map((group) => h("tr", {},
        h("td", {}, h("b", {}, group.name)),
        h("td", {}, String(group.students)),
        h("td", {}, group.scores.length ? fmtScore(group.scores.reduce((sum, score) => sum + score, 0) / group.scores.length) : "—"),
        h("td", {}, String(group.passed)),
        h("td", {}, String(group.notFinal))));
      const classTable = h("table", { class: "qtable" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Class"), h("th", {}, "Students"), h("th", {}, "Average"),
          h("th", {}, "Passed"), h("th", {}, "Not final"))),
        h("tbody", {}, classRows));
      classesPanel.replaceChildren(h("div", { class: "table-wrap" }, classTable));
      if (overview.rows.length === 0) {
        status.replaceChildren(h("p", { class: "sub" }, "Nobody has joined this test yet. Share the code with the class."));
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
