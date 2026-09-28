import assert from "node:assert/strict";
// Plain JavaScript modules shared with the browser (the writers under test).
// @ts-ignore
import { buildPdf } from "../../assets/js/teacher/export/pdfDoc.js";
// @ts-ignore
import { buildClassSummaryPdf } from "../../assets/js/teacher/export/classSummaryPdf.js";
// @ts-ignore
import { exportFileName } from "../../assets/js/teacher/export/resultsTable.js";

/**
 * A small, dependency-free reader for the writer's own output (the counterpart of the zip reader the xlsx
 * tests use): every text operand of a `Tj` show-text instruction, in document order, with the PDF string
 * escapes undone. Good enough to prove what a page says without pulling in a PDF library for the test suite.
 */
function toBinaryString(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return raw;
}

function shownText(bytes: Uint8Array): string[] {
  const raw = toBinaryString(bytes);
  const strings: string[] = [];
  const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    strings.push(m[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\"));
  }
  return strings;
}

/** Every offset the xref table records must point at the exact byte where that object's "N 0 obj" starts. */
function assertXrefOffsetsAreExact(bytes: Uint8Array) {
  const raw = toBinaryString(bytes);
  const startxref = Number(/startxref\s+(\d+)/.exec(raw)?.[1]);
  assert.ok(Number.isFinite(startxref), "startxref must name a byte offset");
  const afterHeader = /xref\r?\n0 (\d+)\r?\n/.exec(raw.slice(startxref));
  assert.ok(afterHeader, "the xref table must start with a subsection header (object 0..N)");
  const count = Number(afterHeader![1]);
  const entriesStart = startxref + afterHeader!.index! + afterHeader![0].length;
  // Entry 0 is the free-list head; objects 1..count-1 are the real objects.
  for (let n = 1; n < count; n++) {
    const entry = raw.slice(entriesStart + n * 20, entriesStart + n * 20 + 20);
    const offset = Number(entry.slice(0, 10));
    assert.match(raw.slice(offset, offset + 15), new RegExp(`^${n} 0 obj`), `object ${n}'s xref offset must point at "${n} 0 obj"`);
  }
}

// ---------- the low-level writer ----------
Deno.test("pdf writer: starts with the PDF header, ends with %%EOF, and every xref offset is exact", () => {
  const bytes = buildPdf([{ texts: [{ x: 40, y: 800, text: "Hello", font: "regular", size: 10 }], lines: [] }]);
  const raw = toBinaryString(bytes);
  assert.ok(raw.startsWith("%PDF-1.4\n"));
  assert.ok(raw.trimEnd().endsWith("%%EOF"));
  assertXrefOffsetsAreExact(bytes);
  assert.deepEqual(shownText(bytes), ["Hello"]);
});

Deno.test("pdf writer: an empty page list still produces one valid, empty page", () => {
  const bytes = buildPdf([]);
  assertXrefOffsetsAreExact(bytes);
  assert.match(toBinaryString(bytes), /\/Count 1/);
});

Deno.test("pdf writer: parentheses and backslashes are escaped, not left to break the file", () => {
  const bytes = buildPdf([{ texts: [{ x: 40, y: 800, text: 'A (test) with \\ and (nested (parens))', font: "regular", size: 10 }], lines: [] }]);
  assertXrefOffsetsAreExact(bytes);
  assert.deepEqual(shownText(bytes), ["A (test) with \\ and (nested (parens))"]);
});

Deno.test("pdf writer: a character outside Latin-1 becomes '?' instead of corrupting the stream", () => {
  const bytes = buildPdf([{ texts: [{ x: 40, y: 800, text: "Am\u00e9lie \u2014 \u4e2d\u6587", font: "regular", size: 10 }], lines: [] }]);
  assertXrefOffsetsAreExact(bytes);
  // "é" (U+00E9) survives (it fits in one byte / WinAnsiEncoding); the em dash and the CJK characters do not.
  assert.deepEqual(shownText(bytes), ["Am\u00e9lie ? ??"]);
});

// ---------- the class summary report ----------
Deno.test("class summary pdf: header, stats line and rows all appear, in the order the results screen shows them", () => {
  const exam = { title: "Narrative Text & Grammar" };
  const summary = { with_result: 3, average: 78.3, highest: 95, lowest: 60, passed: 2, failed: 1 };
  const rows = [
    { student_name: "Aisyah Putri", class_display: "XII TKJ A", percentage: 95, has_result: true, pass_status: "passed" },
    { student_name: "Budi", class_display: "XII TKJ A", percentage: 60, has_result: true, pass_status: "failed" },
    { student_name: "Citra", class_display: "XII TKJ A", status: "in_progress", has_result: false },
  ];
  const bytes = buildClassSummaryPdf({ exam, summary, rows, schoolName: "SMK Negeri 1 Contoh" });
  assertXrefOffsetsAreExact(bytes);
  const shown = shownText(bytes);
  assert.deepEqual(shown.slice(0, 8), [
    "SMK Negeri 1 Contoh",
    "Narrative Text & Grammar",
    "Class: XII TKJ A",
    "3 results   \u00b7   average 78.3   \u00b7   highest 95   \u00b7   lowest 60   \u00b7   2 of 3 passed (67%)",
    "Name", "Class", "Score", "Status",
  ]);
  assert.deepEqual(shown.slice(8), [
    "Aisyah Putri", "XII TKJ A", "95", "Passed",
    "Budi", "XII TKJ A", "60", "Failed",
    "Citra", "XII TKJ A", "-", "In progress",
  ]);
});

Deno.test("class summary pdf: no school name is simply left out, not written as a blank line", () => {
  const bytes = buildClassSummaryPdf({ exam: { title: "Exam" }, summary: { with_result: 0 }, rows: [], schoolName: "" });
  assert.deepEqual(shownText(bytes).slice(0, 2), ["Exam", "Class: -"]);
});

Deno.test("class summary pdf: nobody has joined yet is said once, not printed as an empty table", () => {
  const bytes = buildClassSummaryPdf({ exam: { title: "Exam" }, summary: { with_result: 0 }, rows: [], schoolName: "" });
  const shown = shownText(bytes);
  assert.ok(shown.includes("Nobody has joined this test yet."));
  assert.deepEqual(shown[2], "0 results", "the stats line matches the screen's own wording for zero results (summaryStrip)");
});

Deno.test("class summary pdf: hostile text is written literally, never as executable markup", () => {
  const rows = [{ student_name: 'Ana & Budi <script>alert("x")</script>', class_display: "B. Jakarta (100%)", percentage: 88.5, has_result: true, pass_status: "passed" }];
  const bytes = buildClassSummaryPdf({ exam: { title: "Exam" }, summary: { with_result: 1, average: 88.5, highest: 88.5, lowest: 88.5, passed: 1, failed: 0 }, rows, schoolName: 'Sekolah "Maju" & Co' });
  assertXrefOffsetsAreExact(bytes);
  const shown = shownText(bytes);
  assert.equal(shown[0], 'Sekolah "Maju" & Co');
  // The name is 38 characters; the column clips to 32 with a trailing "...", so the closing tag never appears.
  assert.ok(shown.some((s) => s.startsWith("Ana & Budi <script>alert(") && s.endsWith("...")));
  assert.ok(!shown.some((s) => s.includes("</script>")));
});

Deno.test("class summary pdf: a long roster is paginated, and every row survives the split", () => {
  const rows = Array.from({ length: 62 }, (_, i) => ({
    student_name: `Student ${String(i + 1).padStart(2, "0")}`,
    class_display: "XII TKJ A",
    percentage: 50 + (i % 50),
    has_result: true,
    pass_status: (50 + (i % 50)) >= 70 ? "passed" : "failed",
  }));
  const bytes = buildClassSummaryPdf({ exam: { title: "Grammar Final" }, summary: { with_result: 62, average: 72.1, highest: 99, lowest: 50, passed: 40, failed: 22 }, rows, schoolName: "" });
  assertXrefOffsetsAreExact(bytes);
  assert.match(toBinaryString(bytes), /\/Count 2/, "62 rows need a second page at 15pt row height on A4");
  const shown = shownText(bytes);
  const names = shown.filter((s) => s.startsWith("Student "));
  assert.equal(names.length, 62, "no row is dropped across the page break");
  assert.ok(shown.includes("Grammar Final (continued)"), "the continuation page repeats the exam title, not the school/class header again");
});

Deno.test("class summary pdf: long names are clipped so the class/score/status columns never overlap them", () => {
  const rows = [{ student_name: "A".repeat(60), class_display: "B".repeat(30), percentage: 100, has_result: true, pass_status: "passed" }];
  const bytes = buildClassSummaryPdf({ exam: { title: "Exam" }, summary: { with_result: 1, average: 100, highest: 100, lowest: 100, passed: 1, failed: 0 }, rows, schoolName: "" });
  const shown = shownText(bytes);
  const name = shown.find((s) => s.startsWith("A"));
  const cls = shown.find((s) => s.startsWith("B"));
  assert.equal(name, `${"A".repeat(29)}...`);
  assert.equal(cls, `${"B".repeat(17)}...`);
});

// ---------- the file name a teacher gets ----------
Deno.test("class summary pdf: reuses the same file-name rule as the other two exports", () => {
  assert.equal(exportFileName({ title: "Narrative Text!" }, "pdf"), "Narrative-Text.pdf");
});
