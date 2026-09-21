/** RFC-4180-style CSV/TSV parser. Returns rows of cells without interpreting headers. */
export function detectDelimiter(text) {
  const first = String(text).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const counts = { ",": 0, ";": 0, "\t": 0 }; let quoted = false;
  for (let i = 0; i < first.length; i++) {
    if (first[i] === '"') { if (quoted && first[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && first[i] in counts) counts[first[i]]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(source, delimiter = detectDelimiter(source)) {
  const text = String(source).replace(/^\uFEFF/, "");
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted cell.");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
