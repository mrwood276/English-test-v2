/**
 * Dependency-free one-page class-summary PDF for mockup 14.
 * Standard Helvetica only: no third-party PDF library or new dependency.
 */

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 34;
const DARK = "0.10 0.13 0.18";
const MUTED = "0.36 0.40 0.47";
const LINE = "0.82 0.84 0.88";
const TINT = "0.95 0.96 0.98";

const clean = (value, max = 90) => String(value ?? "")
  .replace(/[\r\n\t]+/g, " ")
  .replace(/[\\()]/g, (m) => "\\" + m)
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
  .slice(0, max);

const fmt = (value) => value === null || value === undefined || value === "" ? "—" : String(value);
const pct = (value) => value === null || value === undefined ? "—" : Number(value).toFixed(1) + "%";

function classGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const name = row.class_display || row.student_class || "Unknown class";
    const group = groups.get(name) || { name, students: 0, finished: 0, scores: [], passed: 0, notFinal: 0 };
    group.students += 1;
    if (row.has_result && row.percentage !== null && row.percentage !== undefined) {
      group.finished += 1;
      group.scores.push(Number(row.percentage));
    }
    if (row.pass_status === "passed") group.passed += 1;
    if (row.pass_status === "not_final") group.notFinal += 1;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function average(values) {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
}

function textOp(font, size, x, y, value) {
  return "BT /F" + font + " " + size + " Tf " + x.toFixed(2) + " " + y.toFixed(2) +
    " Td (" + clean(value) + ") Tj ET";
}

function lineOp(x1, y1, x2, y2, color = LINE, width = 0.7) {
  return color + " RG " + width + " w " + x1.toFixed(2) + " " + y1.toFixed(2) +
    " m " + x2.toFixed(2) + " " + y2.toFixed(2) + " l S";
}

function fillRect(x, y, w, h, color = TINT) {
  return color + " rg " + x.toFixed(2) + " " + y.toFixed(2) + " " +
    w.toFixed(2) + " " + h.toFixed(2) + " re f";
}

function makePdf(stream) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H +
      "] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += (i + 1) + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer << /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return new TextEncoder().encode(pdf);
}

/** Build a single-page A4 landscape class summary from results.overview(). */
export function buildClassSummaryPdf(exam, summary, rows) {
  const groups = classGroups(rows);
  const top = PAGE_H - MARGIN;
  const commands = [];

  commands.push(textOp(2, 20, MARGIN, top - 2, "English Daily Test"));
  commands.push(textOp(1, 11, MARGIN, top - 22, "Class summary"));
  commands.push(textOp(2, 15, MARGIN, top - 52, exam.title));
  commands.push(textOp(1, 8.5, MARGIN, top - 69,
    "Code " + (exam.access_code || "—") + " · Passing grade " + fmt(exam.passing_grade) +
    " · Duration " + fmt(exam.duration_minutes) + " min"));

  const cards = [
    ["Students", rows.length],
    ["Finished", summary.with_result],
    ["Average", pct(summary.average)],
    ["Passed", summary.passed],
    ["Failed", summary.failed],
    ["Not final", summary.not_final],
  ];
  const cardGap = 8;
  const cardW = (PAGE_W - MARGIN * 2 - cardGap * (cards.length - 1)) / cards.length;
  let cardX = MARGIN;
  for (const [label, value] of cards) {
    commands.push(fillRect(cardX, top - 123, cardW, 38));
    commands.push(textOp(1, 7.5, cardX + 8, top - 100, label));
    commands.push(textOp(2, 13, cardX + 8, top - 116, fmt(value)));
    cardX += cardW + cardGap;
  }

  const tableTop = top - 145;
  commands.push(textOp(2, 10, MARGIN, tableTop, "Performance by class"));
  const headerY = tableTop - 17;
  const cols = [
    ["Class", MARGIN],
    ["Students", 289],
    ["Finished", 365],
    ["Average", 441],
    ["Passed", 517],
    ["Not final", 583],
    ["Range", 661],
  ];
  commands.push(fillRect(MARGIN, headerY - 10, PAGE_W - MARGIN * 2, 22, TINT));
  for (const [label, x] of cols) commands.push(textOp(2, 7.5, x, headerY, label));

  const available = headerY - MARGIN - 12;
  const rowH = groups.length ? Math.max(11, Math.min(20, available / groups.length)) : 20;
  const font = Math.max(6.5, Math.min(8.5, rowH * 0.43));
  groups.forEach((group, index) => {
    const y = headerY - 25 - index * rowH;
    if (index % 2 === 0) {
      commands.push(fillRect(MARGIN, y - rowH + 3, PAGE_W - MARGIN * 2, rowH, "0.985 0.985 0.99"));
    }
    const avg = average(group.scores);
    const range = group.scores.length
      ? Number(Math.min(...group.scores)).toFixed(1) + "–" + Number(Math.max(...group.scores)).toFixed(1) + "%"
      : "—";
    commands.push(textOp(1, font, cols[0][1], y, group.name));
    commands.push(textOp(1, font, cols[1][1], y, group.students));
    commands.push(textOp(1, font, cols[2][1], y, group.finished));
    commands.push(textOp(1, font, cols[3][1], y, pct(avg)));
    commands.push(textOp(1, font, cols[4][1], y, group.passed));
    commands.push(textOp(1, font, cols[5][1], y, group.notFinal));
    commands.push(textOp(1, font, cols[6][1], y, range));
    commands.push(lineOp(MARGIN, y - rowH + 1, PAGE_W - MARGIN, y - rowH + 1));
  });

  commands.push(textOp(1, 7, MARGIN, 17,
    "Average " + pct(summary.average) + " · Highest " + pct(summary.highest) +
    " · Lowest " + pct(summary.lowest) + " · " + (summary.pending_essays || 0) +
    " essay(s) awaiting grading"));
  commands.push(textOp(1, 7, PAGE_W - MARGIN - 145, 17, "Generated from Results"));

  return makePdf(commands.join("\n"));
}
