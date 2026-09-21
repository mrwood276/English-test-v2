/**
 * Reads questions pasted as text (for example copied from Word). See the on-screen help for the format:
 *
 *   [Reading text: The Lost Wallet]
 *   Dina found a brown wallet ...
 *   [/Reading text]
 *
 *   1. What did Dina do first?
 *   A. She kept the money.
 *   B. She looked around.*
 *   C. She called the police.
 *   Answer: B
 *   Topic: Narrative Text
 *   Level: HOTS
 *   Points: 2
 *   Class: XII TKJ A, XII TKJ B
 *   Reading text: The Lost Wallet
 *   Explanation: The passage says so.
 *
 * Returns { records, passages, problems }. A record has the same fields as a spreadsheet row (see rows.js).
 */
const DEFINITION = /\[(?:reading text|passage|teks bacaan)\s*:\s*([^\]\n]+)\]([\s\S]*?)\[\/(?:reading text|passage|teks bacaan)\]/gi;
const NUMBERED = /^\s*(\d{1,3})\s*[.)]\s+(\S.*)$/;
const OPTION = /^\s*[*\u2713\u2714]?\s*\(?([A-Fa-f])\s*[.):]\s*(.*)$/;
const META = [
  ["correct", /^\s*(?:answers?|key|correct|jawaban|kunci)\s*[:=]\s*(.*)$/i],
  ["topic", /^\s*(?:topic|materi|topik)\s*[:=]\s*(.*)$/i],
  ["difficulty", /^\s*(?:level|difficulty|tingkat|kesulitan)\s*[:=]\s*(.*)$/i],
  ["points", /^\s*(?:points?|score|bobot|skor|poin)\s*[:=]\s*(.*)$/i],
  ["classText", /^\s*(?:class(?:es)?|kelas)\s*[:=]\s*(.*)$/i],
  ["explanation", /^\s*(?:explanation|pembahasan|penjelasan)\s*[:=]\s*(.*)$/i],
  ["type", /^\s*(?:type|jenis|tipe)\s*[:=]\s*(.*)$/i],
  ["guide", /^\s*(?:guide|panduan|rubric|rubrik)\s*[:=]\s*(.*)$/i],
  ["readingTitle", /^\s*(?:reading text|passage|teks bacaan)\s*[:=]\s*(.*)$/i],
];
const CONTINUES = new Set(["explanation", "guide"]);
const CORRECT_MARK = /\s*(?:\*+|✓|✔|\((?:correct|benar)\)|\[(?:correct|benar)\])\s*$/i;

const clean = (s) => String(s).replace(/\u00a0/g, " ").replace(/\t/g, " ").replace(/[\u200b\u200e\u200f]/g, "");

function toParagraphs(body) {
  return body.trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("<br><br>");
}

export function parsePastedText(input) {
  let text = clean(String(input ?? "")).replace(/\r\n?/g, "\n");
  const passages = {};
  text = text.replace(DEFINITION, (_, title, body) => {
    passages[title.trim()] = toParagraphs(body);
    return "\n";
  });

  const lines = text.split("\n");
  const numbered = lines.some((l) => NUMBERED.test(l));

  // Split into blocks: by question numbers when they are used, otherwise by blank lines.
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const startsNumbered = numbered && NUMBERED.test(line);
    if (startsNumbered) {
      current = { lines: [line.replace(NUMBERED, "$2")] };
      blocks.push(current);
    } else if (!line.trim()) {
      if (!numbered) current = null;
    } else {
      if (!current) {
        if (numbered) continue; // text before the first numbered question is ignored
        current = { lines: [] };
        blocks.push(current);
      }
      current.lines.push(line);
    }
  }

  const records = [];
  const problems = [];
  blocks.forEach((block, index) => {
    const record = { row: index + 1, type: "", question: "", options: [], correct: "", guide: "", explanation: "", topic: "", difficulty: "", points: "", classText: "", readingTitle: "", readingBody: "" };
    const stem = [];
    let field = null; // the meta field a continuation line belongs to
    let lastOption = false;
    const marked = [];
    for (const line of block.lines) {
      const meta = META.map(([key, re]) => [key, re.exec(line)]).find(([, m]) => m);
      if (meta) {
        const [key, m] = meta;
        record[key] = key === "explanation" || key === "guide" ? m[1].trim() : m[1].trim();
        field = CONTINUES.has(key) ? key : null;
        lastOption = false;
        continue;
      }
      const opt = stem.length > 0 ? OPTION.exec(line) : null;
      const expected = "ABCDEF"[record.options.length];
      if (opt && opt[1].toUpperCase() === expected) {
        let optionText = opt[2].trim();
        let isMarked = /^\s*[*\u2713\u2714]/.test(line.trim());
        if (CORRECT_MARK.test(optionText)) { optionText = optionText.replace(CORRECT_MARK, "").trim(); isMarked = true; }
        record.options.push(optionText);
        if (isMarked) marked.push(expected);
        field = null;
        lastOption = true;
      } else if (field) {
        record[field] += (record[field] ? " " : "") + line.trim();
      } else if (lastOption && record.options.length) {
        record.options[record.options.length - 1] += " " + line.trim(); // a long answer that continues on the next line
      } else {
        stem.push(line.trim());
      }
    }
    record.question = stem.join("<br>");
    if (!record.correct && marked.length) record.correct = marked.join(",");
    if (record.readingTitle && passages[record.readingTitle]) record.readingBody = passages[record.readingTitle];
    if (record.question || record.options.length || record.correct) records.push(record);
    else problems.push(`Block ${index + 1} has no question text.`);
  });
  return { records, passages, problems };
}

/** Example shown in the "Show an example" button. */
export const EXAMPLE_TEXT = `[Reading text: The Lost Wallet]
Dina found a brown wallet under the bench in front of the library. Inside were some money and a student card.
[/Reading text]

1. What did Dina do first after she found the wallet?
A. She kept the money.
B. She looked around for the owner.*
C. She called the police.
D. She left it under the bench.
Topic: Narrative Text
Level: HOTS
Points: 2
Class: XII TKJ A, XII TKJ B
Reading text: The Lost Wallet
Explanation: The story says she looked around, but nobody was there.

2. Dina found a key.
Answer: False
Topic: Narrative Text

3. The story was told in the ____ tense.
Answer: past | simple past
Level: Easy

4. Explain why the orientation is important in a narrative text.
Type: essay
Guide: One mark for each idea: characters, place, time.
Points: 4
`;
