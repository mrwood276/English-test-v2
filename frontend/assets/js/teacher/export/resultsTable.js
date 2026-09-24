/**
 * The table behind the export buttons on one exam's results (mockup 14): the columns the screen shows, as
 * values a spreadsheet can use — a finished attempt carries its numbers, an attempt still running or waiting
 * for grading stays blank instead of pretending to be a zero. Both exports (CSV and Excel) are built from
 * these rows, so the two files cannot drift apart.
 */
export const COLUMNS = ["Name", "Class", "Attempt", "Score", "Right", "Wrong", "Time used (seconds)", "Page leaves", "Status"];

const asNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
};

/** One row per attempt, in the order the screen shows them. */
export function resultRows(rows) {
  return rows.map((row) => {
    const finished = row.has_result === true;
    return [
      row.student_name || "",
      row.class_display || row.student_class || "",
      asNumber(row.attempt_no) || 1,
      finished ? asNumber(row.percentage) : "",
      finished ? asNumber(row.correct_count) : "",
      finished ? asNumber(row.wrong_count) : "",
      finished ? asNumber(row.time_used_seconds) : "",
      asNumber(row.tab_switch_count),
      finished ? row.pass_status || row.result_status || "" : row.status || "",
    ];
  });
}

/** Excel opens UTF-8 CSV correctly only with a byte-order mark; the separators are the CSV standard. */
export function csvText(rows, columns = COLUMNS) {
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[columns, ...rows].map((line) => line.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** A file name a teacher recognizes, without characters Windows refuses. */
export function exportFileName(exam, extension) {
  const base = String((exam && exam.title) || "results").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${base || "results"}.${extension}`;
}
