/**
 * The "PDF class summary" DEC-025 left unbuilt, now built per the owner's content decision (2026-09-26,
 * DEC-033): one exam's class results, name + score + pass/fail per student, class stats (average / highest /
 * lowest / pass rate), and a header of school name + class + exam title only — no teacher name, no generated
 * date, no logo. Built from the same `overview` payload (`exam`, `summary`, `rows`) the results screen already
 * fetched from `list_exam_results`, so this can never disagree with the screen it was made from (DEC-025).
 */
import { buildPdf, PAGE_HEIGHT } from "./pdfDoc.js";

const MARGIN = 40;
const ROW_HEIGHT = 15;
const COLS = { name: MARGIN, class: 270, score: 410, status: 465 };

function clipText(text, maxChars) {
  const s = String(text === null || text === undefined ? "" : text);
  return s.length > maxChars ? `${s.slice(0, Math.max(0, maxChars - 3))}...` : s;
}

/** The same rounding `resultBits.js`'s `fmtScore` uses, kept local so this module has no DOM dependency. */
function fmtScore(value) {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

const PASS_LABEL = { passed: "Passed", failed: "Failed", not_final: "Not final" };

function statusLabel(row) {
  if (row.has_result) return PASS_LABEL[row.pass_status] || row.pass_status || "-";
  return row.status === "in_progress" || row.status === "reopened" ? "In progress" : (row.status || "-");
}

/** One class name if every row shares it, a short joined list, or a count — never the full roster. */
function classLabel(rows) {
  const names = [...new Set(rows.map((r) => r.class_display || r.student_class || "").filter(Boolean))];
  if (names.length === 0) return "-";
  if (names.length <= 3) return names.join(", ");
  return `${names.length} classes`;
}

/** Title block + the one stats line, in the same order `summaryStrip` shows them on screen. */
function titleTexts({ schoolName, exam, rows, summary }, top) {
  const texts = [];
  let y = top;
  if (schoolName) {
    texts.push({ x: MARGIN, y, text: schoolName, font: "bold", size: 14 });
    y -= 18;
  }
  texts.push({ x: MARGIN, y, text: (exam && exam.title) || "Exam results", font: "bold", size: 16 });
  y -= 16;
  texts.push({ x: MARGIN, y, text: `Class: ${classLabel(rows)}`, font: "regular", size: 10 });
  y -= 20;

  const passed = (summary && summary.passed) || 0;
  const decided = passed + ((summary && summary.failed) || 0);
  const pct = decided > 0 ? Math.round((passed / decided) * 100) : null;
  const withResult = (summary && summary.with_result) || 0;
  const stats = [
    `${withResult} result${withResult === 1 ? "" : "s"}`,
    summary && summary.average !== null && summary.average !== undefined ? `average ${fmtScore(summary.average)}` : null,
    summary && summary.highest !== null && summary.highest !== undefined ? `highest ${fmtScore(summary.highest)}` : null,
    summary && summary.lowest !== null && summary.lowest !== undefined ? `lowest ${fmtScore(summary.lowest)}` : null,
    pct !== null ? `${passed} of ${decided} passed (${pct}%)` : null,
  ].filter(Boolean).join("   \u00b7   ");
  texts.push({ x: MARGIN, y, text: stats, font: "regular", size: 10 });
  y -= 18;
  return { texts, nextY: y };
}

function tableHeader(y, pageWidth) {
  return {
    texts: [
      { x: COLS.name, y, text: "Name", font: "bold", size: 10 },
      { x: COLS.class, y, text: "Class", font: "bold", size: 10 },
      { x: COLS.score, y, text: "Score", font: "bold", size: 10 },
      { x: COLS.status, y, text: "Status", font: "bold", size: 10 },
    ],
    lines: [{ x1: MARGIN, y1: y - 4, x2: pageWidth - MARGIN, y2: y - 4 }],
  };
}

/** Builds the class-summary PDF for one exam's `overview` payload and returns its bytes. */
export function buildClassSummaryPdf({ exam, summary, rows, schoolName, pageWidth = 595.28 }) {
  const allRows = rows || [];
  const sorted = [...allRows].sort((a, b) => {
    const classCompare = (a.class_display || a.student_class || "").localeCompare(b.class_display || b.student_class || "");
    return classCompare || (a.student_name || "").localeCompare(b.student_name || "");
  });

  const pages = [];
  let page = { texts: [], lines: [] };
  const { texts: header, nextY } = titleTexts({ schoolName, exam, rows: allRows, summary }, PAGE_HEIGHT - MARGIN);
  page.texts.push(...header);
  const firstTh = tableHeader(nextY, pageWidth);
  page.texts.push(...firstTh.texts);
  page.lines.push(...firstTh.lines);
  let y = nextY - ROW_HEIGHT;
  const bottom = MARGIN + ROW_HEIGHT;

  for (const row of sorted) {
    if (y < bottom) {
      pages.push(page);
      page = { texts: [], lines: [] };
      let cy = PAGE_HEIGHT - MARGIN;
      page.texts.push({ x: MARGIN, y: cy, text: `${(exam && exam.title) || "Exam results"} (continued)`, font: "bold", size: 12 });
      cy -= 24;
      const cont = tableHeader(cy, pageWidth);
      page.texts.push(...cont.texts);
      page.lines.push(...cont.lines);
      y = cy - ROW_HEIGHT;
    }
    page.texts.push(
      { x: COLS.name, y, text: clipText(row.student_name, 32), font: "regular", size: 9 },
      { x: COLS.class, y, text: clipText(row.class_display || row.student_class, 20), font: "regular", size: 9 },
      { x: COLS.score, y, text: row.has_result ? fmtScore(row.percentage) : "-", font: "regular", size: 9 },
      { x: COLS.status, y, text: statusLabel(row), font: "regular", size: 9 },
    );
    y -= ROW_HEIGHT;
  }
  if (sorted.length === 0) {
    page.texts.push({ x: MARGIN, y, text: "Nobody has joined this test yet.", font: "regular", size: 10 });
  }
  pages.push(page);
  return buildPdf(pages);
}
