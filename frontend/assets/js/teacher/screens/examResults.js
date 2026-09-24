import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { buildXlsx } from "../export/xlsx.js";
import { COLUMNS, csvText, exportFileName, resultRows } from "../export/resultsTable.js";
import { fmtDuration, fmtScore, statusPill, summaryStrip } from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/** Hands a built file to the browser (a download, not a new tab). */
function saveFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadCsv(exam, rows) {
  saveFile(new Blob([csvText(resultRows(rows))], { type: "text/csv;charset=utf-8" }), exportFileName(exam, "csv"));
}

function downloadXlsx(exam, rows) {
  const bytes = buildXlsx(exam.title, [COLUMNS, ...resultRows(rows)]);
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  saveFile(new Blob([bytes], { type }), exportFileName(exam, "xlsx"));
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

// A written answer counts as right when the teacher gave it every point (the server leaves is_correct
// null for essays: they are a judgement, not a key).
const isCorrect = (item) => item.is_correct === true
  || (item.type === "essay" && Number(item.points) >= Number(item.max_points));

/** Questions from hardest to easiest, counting only the attempts the reports came from. */
function questionStats(reports) {
  const groups = new Map();
  for (const report of reports) {
    for (const item of report.review || []) {
      const group = groups.get(item.question_id) || {
        id: item.question_id, position: item.position, body: item.body, type: item.type,
        answered: 0, correct: 0, choices: new Map(),
      };
      const chosen = String(item.chosen || "").trim();
      if (chosen) {
        group.answered += 1;
        if (isCorrect(item)) group.correct += 1;
        // Case-insensitively, but the first spelling seen is the one shown (options keep their capitals).
        const key = chosen.toLowerCase();
        const seen = group.choices.get(key) || { text: chosen, count: 0 };
        seen.count += 1;
        group.choices.set(key, seen);
      }
      groups.set(item.question_id, group);
    }
  }
  return [...groups.values()].sort((a, b) => {
    const left = a.answered ? a.correct / a.answered : 0;
    const right = b.answered ? b.correct / b.answered : 0;
    return left - right || a.position - b.position;
  });
}

const clip = (text, limit = 40) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/**
 * What most students picked. Only closed questions have "a" most-chosen answer: an essay's answer is a whole
 * paragraph, so listing it here would say nothing (its point count is in the accuracy column already).
 */
function mostChosen(group) {
  if (group.type === "essay") return "—";
  const best = [...group.choices.values()].sort((a, b) => b.count - a.count)[0];
  return best ? `${clip(best.text)} (${best.count})` : "—";
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
  const questionsTab = h("button", { class: "results-tab", type: "button", role: "tab", "aria-selected": "false" }, "Questions");
  const classesPanel = h("div", { class: "card list-card results-stats", hidden: true });
  const questionsPanel = h("div", { class: "card list-card results-stats", hidden: true });
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
    questionsPanel,
  );

  tabs.append(scoresTab, classesTab, questionsTab);
  function showTab(tab) {
    const scores = tab === "scores";
    const classes = tab === "classes";
    scoresTab.classList.toggle("on", scores);
    classesTab.classList.toggle("on", classes);
    questionsTab.classList.toggle("on", !scores && !classes);
    scoresTab.setAttribute("aria-selected", String(scores));
    classesTab.setAttribute("aria-selected", String(classes));
    questionsTab.setAttribute("aria-selected", String(!scores && !classes));
    tbody.closest(".list-card").hidden = !scores;
    classesPanel.hidden = !classes;
    questionsPanel.hidden = scores || classes;
  }
  scoresTab.addEventListener("click", () => showTab("scores"));
  classesTab.addEventListener("click", () => showTab("classes"));
  questionsTab.addEventListener("click", async () => {
    showTab("questions");
    if (questionsPanel.dataset.loaded) return;
    const finished = (state.overview?.rows || []).filter((row) => row.has_result);
    if (finished.length === 0) {
      questionsPanel.replaceChildren(h("p", { class: "sub" }, "Question statistics appear once students have finished the test."));
      return;
    }
    questionsPanel.replaceChildren(h("p", { class: "sub" }, "Loading question statistics…"));
    // One report per finished attempt (the report is the only place a graded answer is read from). One failing
    // report must not throw away the other students' numbers.
    const settled = await Promise.allSettled(finished.map((row) => results.report(row.session_id)));
    const reports = settled.filter((one) => one.status === "fulfilled").map((one) => one.value);
    if (reports.length === 0) {
      const first = settled.find((one) => one.status === "rejected");
      questionsPanel.replaceChildren(h("p", { class: "sub" }, first ? errorText(first.reason) : "No reports could be loaded."));
      return;
    }
    const attempts = `${reports.length} finished ${reports.length === 1 ? "attempt" : "attempts"}`;
    const missing = settled.length - reports.length;
    const note = h("div", { class: "stats-note" }, h("p", { class: "sub" },
      missing ? `From ${attempts} · ${missing} report${missing === 1 ? "" : "s"} could not be loaded · hardest question first`
        : `From ${attempts} · hardest question first`));

    questionsPanel.replaceChildren(
      note,
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {}, h("th", {}, "Question"), h("th", {}, "Type"), h("th", {}, "Answered"), h("th", {}, "Accuracy"), h("th", {}, "Most chosen"))),
          h("tbody", {}, questionStats(reports).map((group) => {
            const body = String(group.body || "").replace(/<[^>]*>/g, "");
            return h("tr", {},
              h("td", {}, h("b", { title: body }, `${group.position}. ${clip(body, 80)}`)),
              h("td", {}, group.type),
              h("td", {}, String(group.answered)),
              h("td", {}, group.answered ? `${Math.round(group.correct / group.answered * 100)}%` : "—"),
              h("td", {}, mostChosen(group)));
          })))),
    );
    questionsPanel.dataset.loaded = "true";
  });

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
      const excel = h("button", { class: "btn ghost", type: "button", "data-export-xlsx": "true" }, icon("download"), "Export Excel");
      excel.addEventListener("click", () => downloadXlsx(exam, overview.rows));
      const csv = h("button", { class: "btn ghost", type: "button", "data-export-csv": "true" }, icon("sheet"), "Export CSV");
      csv.addEventListener("click", () => downloadCsv(exam, overview.rows));
      actions.append(excel, csv);
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
