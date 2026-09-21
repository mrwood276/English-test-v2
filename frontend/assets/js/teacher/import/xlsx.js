import { listZip, readZipEntry } from "./zip.js";

/**
 * Reads the first sheet of an .xlsx file as rows of text. Supports shared strings (including rich text), inline
 * strings, numbers, and yes/no cells. Formulas use their saved result. Dates are not converted.
 * Returns { rows: string[][], numbers: number[] } where numbers[i] is the sheet row number of rows[i].
 */
const parseXml = (bytes) => {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This Excel file could not be read.");
  return doc;
};
const byLocalName = (root, name) => [...root.getElementsByTagNameNS("*", name)];
const text = (el) => byLocalName(el, "t").filter((t) => !t.closest || !t.closest("rPh")).map((t) => t.textContent).join("");

function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || "");
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function numberText(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : v;
}

export async function readXlsxRows(buffer) {
  const entries = listZip(buffer);
  const find = (name) => entries.find((e) => e.name.toLowerCase() === name);
  const read = async (name) => {
    const entry = find(name);
    return entry ? readZipEntry(buffer, entry) : null;
  };

  const workbookBytes = await read("xl/workbook.xml");
  if (!workbookBytes) throw new Error("This is not an Excel workbook.");
  const workbook = parseXml(workbookBytes);
  const firstSheet = byLocalName(workbook, "sheet")[0];
  if (!firstSheet) throw new Error("The workbook has no sheets.");
  const rid = firstSheet.getAttribute("r:id") || firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");

  let sheetPath = "xl/worksheets/sheet1.xml";
  const relsBytes = await read("xl/_rels/workbook.xml.rels");
  if (relsBytes && rid) {
    const rel = byLocalName(parseXml(relsBytes), "Relationship").find((r) => r.getAttribute("Id") === rid);
    if (rel) {
      const target = rel.getAttribute("Target") || "";
      sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    }
  }
  const sheetBytes = await read(sheetPath);
  if (!sheetBytes) throw new Error("The first sheet could not be found.");

  const shared = [];
  const sharedBytes = await read("xl/sharedstrings.xml");
  if (sharedBytes) for (const si of byLocalName(parseXml(sharedBytes), "si")) shared.push(text(si));

  const rows = [];
  const numbers = [];
  for (const rowEl of byLocalName(parseXml(sheetBytes), "row")) {
    const cells = [];
    for (const c of [...rowEl.children].filter((el) => el.localName === "c")) {
      const at = columnIndex(c.getAttribute("r"));
      const idx = at >= 0 ? at : cells.length;
      const type = c.getAttribute("t");
      const v = byLocalName(c, "v")[0];
      let value = "";
      if (type === "s") value = v ? shared[Number(v.textContent)] ?? "" : "";
      else if (type === "inlineStr") value = text(c);
      else if (type === "b") value = v && v.textContent === "1" ? "TRUE" : "FALSE";
      else if (type === "str" || type === "e") value = v ? v.textContent : "";
      else value = v ? numberText(v.textContent) : "";
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    if (cells.some((x) => String(x).trim() !== "")) {
      rows.push(cells);
      numbers.push(Number(rowEl.getAttribute("r")) || rows.length);
    }
  }
  return { rows, numbers };
}
