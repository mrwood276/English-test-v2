/**
 * A minimal, dependency-free PDF writer (DEC-007, DEC-025): plain text and straight lines on one or more
 * A4 pages, using a PDF viewer's own built-in Helvetica fonts — no font embedding, no images, no compression.
 * A report is exactly this simple, and the counterpart of the ZIP/xlsx writer next to it: hand-built once,
 * proved by reading the bytes back (see `pdf.test.ts`), not a library pulled in for one screen's exports.
 *
 * Text is written in WinAnsiEncoding, the closest single-byte encoding a browser can produce without a font
 * subset; any character outside it becomes "?" rather than corrupting the file (names in this project are
 * Indonesian names in Latin script, so this covers everything the results screen itself shows).
 */
export const PAGE_WIDTH = 595.28; // A4, points
export const PAGE_HEIGHT = 841.89;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Every character the file's own bytes can hold; anything wider than one byte becomes "?". */
function toLatin1(value) {
  const cleaned = String(value === null || value === undefined ? "" : value)
    .replace(CONTROL, "");
  let out = "";
  for (const ch of cleaned) out += ch.codePointAt(0) <= 255 ? ch : "?";
  return out;
}

/** A PDF literal string: backslash and parentheses are the only characters that must be escaped. */
function pdfString(value) {
  return `(${
    toLatin1(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(
      /\)/g,
      "\\)",
    )
  })`;
}

const FONT_KEY = { regular: "F1", bold: "F2" };

/** One page's drawing instructions turned into a PDF content stream. */
function contentStream(page) {
  const parts = [];
  for (const line of page.lines || []) {
    parts.push(
      `${(line.width || 0.5).toFixed(2)} w ${
        (line.gray === undefined ? 0.6 : line.gray).toFixed(2)
      } G`,
    );
    parts.push(
      `${line.x1.toFixed(2)} ${line.y1.toFixed(2)} m ${line.x2.toFixed(2)} ${
        line.y2.toFixed(2)
      } l S`,
    );
  }
  for (const t of page.texts || []) {
    const font = FONT_KEY[t.font] || FONT_KEY.regular;
    const gray = (t.gray === undefined ? 0 : t.gray).toFixed(2);
    parts.push(
      `BT /${font} ${t.size} Tf ${gray} g 1 0 0 1 ${t.x.toFixed(2)} ${
        t.y.toFixed(2)
      } Tm ${pdfString(t.text)} Tj ET`,
    );
  }
  return parts.join("\n");
}

/**
 * Builds a multi-page PDF from page descriptors and returns its bytes.
 * Each page: { texts: [{ x, y, text, font: "regular"|"bold", size, gray }], lines: [{ x1, y1, x2, y2, width, gray }] }.
 */
export function buildPdf(pages) {
  const list = pages && pages.length ? pages : [{ texts: [], lines: [] }];
  const firstPageObj = 5; // 1 Catalog, 2 Pages, 3 Font regular, 4 Font bold, then a Page+Contents pair per page

  const objects = []; // objects[n] is the body of object n (object 0 does not exist in a PDF file)
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = list.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  list.forEach((page, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = contentStream(page);
    objects[contentObj] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // ---- assemble, tracking byte offsets: every character above is ASCII or Latin-1, one byte each ----
  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"; // the recommended binary-file comment (four bytes above 127)
  const offsets = [];
  const highest = objects.length - 1;
  for (let n = 1; n <= highest; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${highest + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= highest; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${
    highest + 1
  } /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}
