import assert from "node:assert/strict";
// Plain JavaScript modules shared with the browser (the writer under test).
// @ts-ignore
import { buildXlsx } from "../../assets/js/teacher/export/xlsx.js";
// @ts-ignore
import { COLUMNS, csvText, exportFileName, resultRows } from "../../assets/js/teacher/export/resultsTable.js";

// The Excel reader that already ships in the repository reads the writer's own files back, and the test DOM
// comes from the same dev-only linkedom shim the import tests use.
import { DOMParser as LinkedomDOMParser } from "npm:linkedom";
(globalThis as { DOMParser?: unknown }).DOMParser = LinkedomDOMParser;
// @ts-ignore
import { listZip, readZipEntry } from "../../assets/js/teacher/import/zip.js";
// @ts-ignore
import { readXlsxRows } from "../../assets/js/teacher/import/xlsx.js";

const SHEET = "xl/worksheets/sheet1.xml";
const decoder = new TextDecoder();

async function part(bytes: Uint8Array, name: string): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const entry = (listZip(bytes) as any[]).find((one) => one.name === name);
  if (!entry) throw new Error(`${name} is missing from the package`);
  return decoder.decode(await readZipEntry(bytes, entry));
}

async function sheetName(bytes: Uint8Array): Promise<string> {
  const workbook = await part(bytes, "xl/workbook.xml");
  const found = /<sheet name="([^"]*)"/.exec(workbook);
  if (!found) throw new Error("the workbook names no sheet");
  return found[1];
}

// ---------- the round trip: the repository's own reader reads what the writer wrote ----------
Deno.test("xlsx export: our own reader reads the written sheet back, cell for cell", async () => {
  const rows = [
    ["Name", "Class", "Score"],
    ["Aisyah Putri", "XII TKJ A", 87.5],
    ['Budi & Sari <"the best">', "XII TKJ B", 60],
  ];
  const back = await readXlsxRows(buildXlsx("Narrative Text", rows));
  assert.deepEqual(back.numbers, [1, 2, 3]);
  assert.deepEqual(back.rows, [
    ["Name", "Class", "Score"],
    ["Aisyah Putri", "XII TKJ A", "87.5"],
    ['Budi & Sari <"the best">', "XII TKJ B", "60"],
  ]);
});

Deno.test("xlsx export: a finished table of one exam matches what its own reader gives back", async () => {
  const table = [
    COLUMNS,
    ...resultRows([
      { student_name: "Aisyah Putri", class_display: "Class XII TKJ A", attempt_no: 1, has_result: true, percentage: 87.5, correct_count: 3, wrong_count: 1, time_used_seconds: 600, tab_switch_count: 2, pass_status: "passed" },
      { student_name: "Bima Saputra", student_class: "XII TKJ A", attempt_no: 1, status: "in_progress", tab_switch_count: 0 },
    ]),
  ];
  const back = await readXlsxRows(buildXlsx("Narrative Text", table));
  assert.deepEqual(back.rows[1], ["Aisyah Putri", "Class XII TKJ A", "1", "87.5", "3", "1", "600", "2", "passed"]);
  assert.deepEqual(back.rows[2], ["Bima Saputra", "XII TKJ A", "1", "", "", "", "", "0", "in_progress"],
    "an attempt that is still running has holes, not zeros");
  const xml = await part(buildXlsx("Narrative Text", table), SHEET);
  assert.match(xml, /<c r="D2"><v>87\.5<\/v><\/c>/, "the score is a number, so Excel can average the column");
  assert.ok(!xml.includes('r="D3"'), "the empty score of a running attempt is left out, not written as zero");
});

Deno.test("xlsx export: hostile text is escaped, illegal characters are dropped, capitals survive", async () => {
  const nasty = 'Ana & Budi <script>alert("x")</script> &#39;';
  const bytes = buildXlsx("Scores", [[nasty, "B. Jakarta"], ["line one\nline two", "Budi\u0007"]]);
  const xml = await part(bytes, SHEET);
  assert.ok(!xml.includes("<script>"), "raw markup never reaches the sheet");
  assert.match(xml, /Ana &amp; Budi &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp;#39;/);
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">B\. Jakarta<\/t>/);
  const back = await readXlsxRows(bytes);
  assert.equal(back.rows[0][0], 'Ana & Budi <script>alert("x")</script> &#39;');
  assert.equal(back.rows[1][1], "Budi", "the control character is dropped, not written raw");
  assert.equal(back.rows[1][0], "line one\nline two", "a line break inside a cell is kept");
});

Deno.test("xlsx export: a zero is a value, an empty cell is nothing", async () => {
  const bytes = buildXlsx("Scores", [[0, "", null, undefined]]);
  const xml = await part(bytes, SHEET);
  assert.match(xml, /<c r="A1"><v>0<\/v><\/c>/);
  assert.ok(!/<c r="B1"/.test(xml), "empty cells are left out of the sheet");
  const back = await readXlsxRows(bytes);
  assert.deepEqual(back.rows, [["0"]]);
});

// ---------- the shape Excel itself expects ----------
Deno.test("xlsx export: the package holds the five parts every reader looks for, stored uncompressed", async () => {
  const bytes = buildXlsx("Scores", [["Name"], ["Ana"]]);
  // deno-lint-ignore no-explicit-any
  const entries = listZip(bytes) as any[];
  assert.deepEqual(entries.map((one) => one.name),
    ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", SHEET]);
  assert.ok(entries.every((one) => one.method === 0), "stored (method 0): every zip tool can read it");
  assert.ok(entries.every((one) => one.compressedSize === one.size && one.size > 0));
  const sheet = await part(bytes, SHEET);
  assert.match(sheet, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
  assert.match(sheet, /<worksheet xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"><sheetData>/);
});

Deno.test("xlsx export: column references keep counting past Z, and the sheet name follows Excel's rules", async () => {
  const wide = [Array.from({ length: 28 }, (_, at) => at + 1)];
  const xml = await part(buildXlsx("Scores", wide), SHEET);
  assert.match(xml, /<c r="Z1"><v>26<\/v><\/c>/);
  assert.match(xml, /<c r="AB1"><v>28<\/v><\/c>/);

  const long = "Results / XII TKJ A [final] and the rest of a very long name";
  const named = await sheetName(buildXlsx(long, [["x"]]));
  assert.ok(named.length <= 31, named);
  assert.ok(!/[\[\]:*?/\\]/.test(named), named);
  assert.equal(await sheetName(buildXlsx("", [["x"]])), "Sheet1");
});

Deno.test("xlsx export: an empty table is still a workbook (no rows, no crash)", async () => {
  const bytes = buildXlsx("Scores", []);
  const back = await readXlsxRows(bytes);
  assert.deepEqual(back.rows, []);
  assert.equal(await part(bytes, SHEET).then((xml) => /<row/.test(xml)), false);
});

// ---------- the CSV export and the shared table ----------
Deno.test("csv export: a byte-order mark, CRLF line ends, and quoting only where it is needed", () => {
  const text = csvText(resultRows([
    { student_name: 'Ana "the cook"', student_class: "XII TKJ A", attempt_no: 1, has_result: true, percentage: 87.5, correct_count: 3, wrong_count: 1, time_used_seconds: 600, tab_switch_count: 2, pass_status: "passed" },
    { student_name: "Budi", class_display: "Class XII TKJ B", attempt_no: 2, status: "in_progress", tab_switch_count: 0 },
  ]));
  assert.ok(text.startsWith("\uFEFFName,Class,Attempt,Score,Right,Wrong,Time used (seconds),Page leaves,Status\r\n"));
  assert.match(text, /"Ana ""the cook""",XII TKJ A,1,87\.5,3,1,600,2,passed\r\n/);
  assert.match(text, /Budi,Class XII TKJ B,2,,,,,0,in_progress\r\n$/);
  assert.equal(text.split("\r\n").length, 4);
});

Deno.test("results table: the merged class name wins, and a result waiting for grading is named", () => {
  const rows = resultRows([
    { student_name: "Sari", student_class: "xii tkj a", class_display: "Class XII TKJ A", attempt_no: 1, has_result: true, percentage: 60, correct_count: 2, wrong_count: 2, time_used_seconds: 300, tab_switch_count: 1, result_status: "pending_review", pass_status: "not_final" },
    { student_name: "Nobody", student_class: "XII TKJ B", attempt_no: 1, status: "auto_submitted", tab_switch_count: 0 },
  ]);
  assert.deepEqual(rows[0], ["Sari", "Class XII TKJ A", 1, 60, 2, 2, 300, 1, "not_final"]);
  assert.deepEqual(rows[1], ["Nobody", "XII TKJ B", 1, "", "", "", "", 0, "auto_submitted"]);
});

Deno.test("exports: the file name a teacher gets is safe and recognizable", () => {
  assert.equal(exportFileName({ title: "Narrative Text!" }, "xlsx"), "Narrative-Text.xlsx");
  assert.equal(exportFileName({ title: "  UTS / Ganjil 2026  " }, "csv"), "UTS-Ganjil-2026.csv");
  assert.equal(exportFileName({}, "csv"), "results.csv");
  assert.equal(exportFileName({ title: "!!!" }, "xlsx"), "results.xlsx");
});
