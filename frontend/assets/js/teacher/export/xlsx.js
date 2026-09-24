import { zipStore } from "./zip.js";

/**
 * Writes a minimal .xlsx workbook (one sheet, no styling) without libraries — the counterpart of the reader in
 * `../import/xlsx.js`, so a teacher can open an export straight in Excel (DEC-007: no new dependencies).
 * Text cells are inline strings; numbers stay numbers, so Excel can sort and average them; the parts of the
 * package are the five every reader expects ([Content_Types].xml, the two relationship files, the workbook
 * and the sheet).
 */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

// Characters XML 1.0 forbids, plus the five that must be escaped. A student's name or a question body
// may contain anything, so every text cell goes through this.
const ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const escapeXml = (value) => String(value)
  .replace(ILLEGAL, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 0 -> A, 25 -> Z, 26 -> AA (the cell references the reader and Excel both expect). */
function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Excel's own rules for a sheet name: at most 31 characters, no []:*?/\ and never empty. */
function sheetTitle(name) {
  const cleaned = String(name || "").replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 31) || "Sheet1";
}

function cell(reference, value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** Builds one workbook from rows of values and returns its bytes, ready to be saved as .xlsx. */
export function buildXlsx(sheetName, rows) {
  const sheetData = rows
    .map((row, at) => `<row r="${at + 1}">${row.map((value, column) => cell(columnName(column) + (at + 1), value)).join("")}</row>`)
    .join("");
  return zipStore([
    { name: "[Content_Types].xml", text: XML_HEADER + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + "</Types>" },
    { name: "_rels/.rels", text: XML_HEADER + `<Relationships xmlns="${PKG_NS}">`
      + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`
      + "</Relationships>" },
    { name: "xl/workbook.xml", text: XML_HEADER + `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
      + `<sheets><sheet name="${escapeXml(sheetTitle(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: XML_HEADER + `<Relationships xmlns="${PKG_NS}">`
      + `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>`
      + "</Relationships>" },
    { name: "xl/worksheets/sheet1.xml", text: XML_HEADER + `<worksheet xmlns="${MAIN_NS}"><sheetData>${sheetData}</sheetData></worksheet>` },
  ]);
}
