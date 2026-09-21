/**
 * Reads CSV text (as saved by Excel or Google Sheets). Handles a byte order mark, quoted cells with commas or line
 * breaks inside, doubled quotes, and the delimiter used in your region: comma, semicolon, or tab (detected).
 * Returns { rows: string[][], numbers: number[], delimiter } where numbers[i] is the line number of rows[i] in the file.
 */
function detectDelimiter(text) {
  let inQuotes = false;
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
}

export function parseCsv(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows = [];
  const numbers = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;

  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell.trim() !== "")) { rows.push(row); numbers.push(rowStart); }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowStart = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, numbers, delimiter };
}
