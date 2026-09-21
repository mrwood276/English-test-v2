import { DIFFICULTIES, LIMITS, normalizeText, validateDraft } from "./rules.js";

/**
 * Turns table rows (from CSV or Excel) or pasted text into draft questions.
 *
 * A "record" is one question as written by the person, before it is cleaned:
 *   { row, type, question, options:[text...] (A first), correct, guide, explanation, topic, difficulty, points,
 *     classText, readingTitle, readingBody }
 * A "draft" is the cleaned question in the shape the server expects, plus `problems` (messages) and `notes`.
 */

const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const HEADERS = {
  type: ["type", "questiontype", "jenis", "tipe"],
  question: ["question", "questiontext", "soal", "pertanyaan"],
  correct: ["correct", "correctanswer", "answer", "answers", "answerkey", "key", "kunci", "kuncijawaban", "jawaban", "jawabanbenar"],
  guide: ["guide", "gradingguide", "essayguide", "panduan", "panduanpenilaian", "rubric", "rubrik"],
  explanation: ["explanation", "pembahasan", "penjelasan"],
  topic: ["topic", "materi", "topik"],
  difficulty: ["difficulty", "level", "tingkat", "kesulitan"],
  points: ["points", "point", "score", "weight", "bobot", "skor", "poin", "nilai"],
  classText: ["class", "classes", "classlabel", "classlabels", "kelas"],
  readingTitle: ["readingtext", "readingtexttitle", "passage", "passagetitle", "teksbacaan", "judulteks", "judulbacaan"],
  readingBody: ["readingtextbody", "readingtexttext", "passagetext", "passagebody", "isiteks", "isibacaan"],
};
const OPTION_HEADER = /^(?:option|choice|pilihan|opsi|jawaban)?([a-f])$/;

const TYPE_WORDS = {
  multiple_choice: ["multiplechoice", "multiple", "mc", "mcq", "pilihanganda", "pg"],
  true_false: ["truefalse", "tf", "benarsalah", "bs"],
  short_answer: ["shortanswer", "short", "fillintheblank", "isian", "isiansingkat"],
  essay: ["essay", "esai", "uraian"],
};
const DIFFICULTY_WORDS = { easy: ["easy", "mudah", "e"], medium: ["medium", "sedang", "menengah", "m"], hots: ["hots", "hot", "sulit", "h"] };
const TRUE_WORDS = ["true", "benar", "yes", "ya", "t"];
const FALSE_WORDS = ["false", "salah", "no", "tidak", "f"];

const pick = (table, value) => Object.entries(table).find(([, words]) => words.includes(key(value)))?.[0] ?? null;

/** Header row → column map. Returns { columns, missing } where columns maps a field name to a column number. */
export function mapHeader(headerCells) {
  const columns = { options: [] };
  headerCells.forEach((cell, index) => {
    const k = key(cell);
    if (!k) return;
    const opt = OPTION_HEADER.exec(k);
    // "answer" and "jawaban" alone mean the answer key; "a".."f" (or option_a, pilihan a) mean answer choices
    if (opt && !(["answer", "jawaban"].includes(k))) { columns.options[opt[1].charCodeAt(0) - 97] = index; return; }
    for (const [field, names] of Object.entries(HEADERS)) if (names.includes(k) && columns[field] === undefined) { columns[field] = index; return; }
  });
  return columns;
}

/** Table rows → records. The first row must be the header. Returns { records, problem } (problem = a message or null). */
export function recordsFromRows(rows, numbers = []) {
  if (rows.length === 0) return { records: [], problem: "The file is empty." };
  const columns = mapHeader(rows[0]);
  if (columns.question === undefined) return { records: [], problem: 'The first row must name the columns, and one of them must be "question" (or "soal").' };
  const cell = (r, field) => (columns[field] === undefined ? "" : String(r[columns[field]] ?? "").trim());
  const records = rows.slice(1).map((r, i) => ({
    row: numbers[i + 1] || i + 2,
    type: cell(r, "type"),
    question: cell(r, "question"),
    options: Array.from({ length: LIMITS.options }, (_, i) => (columns.options[i] === undefined ? "" : String(r[columns.options[i]] ?? "").trim())),
    correct: cell(r, "correct"),
    guide: cell(r, "guide"),
    explanation: cell(r, "explanation"),
    topic: cell(r, "topic"),
    difficulty: cell(r, "difficulty"),
    points: cell(r, "points"),
    classText: cell(r, "classText"),
    readingTitle: cell(r, "readingTitle"),
    readingBody: cell(r, "readingBody"),
  }));
  return { records: records.filter((r) => r.question || r.options.some(Boolean) || r.correct), problem: null };
}

const splitLabels = (text) => [...new Set(String(text).split(/[,;|]/).map((s) => s.trim()).filter(Boolean))];
const splitAccepted = (text) => String(text).split(/[|;\n]/).map((s) => s.trim()).filter(Boolean);

/**
 * Cleans one record.
 * defaults: { labels:[text], topic, difficulty, points } used when the row leaves them empty.
 */
export function buildDraft(record, defaults = {}) {
  const problems = [];
  const notes = [];
  let type = pick(TYPE_WORDS, record.type);
  if (record.type && !type) problems.push(`The type "${record.type}" is not known. Use multiple choice, true/false, short answer, or essay.`);

  const filledOptions = record.options.map((o, i) => ({ letter: "ABCDEF"[i], body: String(o ?? "").trim() })).filter((o) => o.body);
  const correct = String(record.correct ?? "").trim();
  const isTrue = TRUE_WORDS.includes(key(correct)) && key(correct) !== "t";
  const isFalse = FALSE_WORDS.includes(key(correct)) && key(correct) !== "f";

  if (!type) {
    if (filledOptions.length > 0) type = "multiple_choice";
    else if (isTrue || isFalse || ["t", "f"].includes(key(correct))) type = "true_false";
    else if (correct) type = "short_answer";
    else if (record.guide) type = "essay";
    else if (!record.type) problems.push("Could not tell the question type. Add answers, a correct answer, or a type.");
  }

  let options = [];
  let accepted = [];
  if (type === "multiple_choice") {
    // The correct answer must be a letter (or several letters, which is refused): "B", "b.", "(B)", "B, D".
    const looksLikeLetters = /^[\s(]*[A-Fa-f](?:[\s,;/&)]+(?:and\s+|dan\s+)?[A-Fa-f])*[\s.)]*$/.test(correct);
    const uniqueLetters = looksLikeLetters ? [...new Set(correct.toUpperCase().match(/[A-F]/g))] : [];
    if (uniqueLetters.length > 1) problems.push("Choose exactly one correct answer.");
    else if (uniqueLetters.length === 0 && filledOptions.length > 0) problems.push(correct ? `The correct answer "${correct}" is not a letter from A to F.` : 'Say which answer is correct (for example "B").');
    const chosen = uniqueLetters[0];
    if (chosen && !filledOptions.some((o) => o.letter === chosen)) problems.push(`The correct answer ${chosen} is empty or missing.`);
    options = filledOptions.map((o) => ({ body: o.body, is_correct: o.letter === chosen }));
  } else if (type === "true_false") {
    const t = TRUE_WORDS.includes(key(correct));
    const f = FALSE_WORDS.includes(key(correct));
    if (!t && !f) problems.push('For true/false, the correct answer must be "True" or "False".');
    options = [{ body: "True", is_correct: t }, { body: "False", is_correct: f && !t }];
  } else if (type === "short_answer") {
    accepted = splitAccepted(correct);
  }

  const difficultyText = String(record.difficulty || "").trim();
  let difficulty = defaults.difficulty || "medium";
  if (difficultyText) {
    difficulty = pick(DIFFICULTY_WORDS, difficultyText);
    if (!difficulty) { problems.push(`The difficulty "${difficultyText}" is not known. Use Easy, Medium, or HOTS.`); difficulty = "medium"; }
  }
  let weight = defaults.points ?? 1;
  const pointsText = String(record.points ?? "").trim();
  if (pointsText) {
    weight = Number(pointsText.replace(",", "."));
    if (!Number.isFinite(weight)) { problems.push(`The points "${pointsText}" is not a number.`); weight = 1; }
  }

  const labels = splitLabels(record.classText);
  const draft = {
    row: record.row,
    type: type || "multiple_choice",
    body: String(record.question ?? "").trim(),
    options,
    accepted_answers: accepted,
    essay_guidance: type === "essay" ? String(record.guide ?? "").trim() : "",
    explanation: String(record.explanation ?? "").trim(),
    topic: String(record.topic ?? "").trim() || defaults.topic || "",
    difficulty,
    weight,
    class_labels: labels.length ? labels : [...(defaults.labels || [])],
    passage: record.readingTitle ? { title: String(record.readingTitle).trim(), body: String(record.readingBody ?? "").trim() || undefined } : null,
    problems,
    notes,
  };
  if (type) draft.problems.push(...validateDraft(draft).filter((m) => !draft.problems.includes(m)));
  return draft;
}

/**
 * Reading texts: rows with the same title share one text. The text may be written once (in any of the rows) or the
 * title may name a reading text that already exists in the question bank.
 */
export function resolvePassages(drafts, existingTitles) {
  const bodies = new Map();
  for (const d of drafts) if (d.passage && d.passage.body && !bodies.has(normalizeText(d.passage.title))) bodies.set(normalizeText(d.passage.title), d.passage.body);
  for (const d of drafts) {
    if (!d.passage) continue;
    const k = normalizeText(d.passage.title);
    if (existingTitles.has(k)) {
      d.passage = { title: d.passage.title };
      d.notes.push("Uses the reading text that already exists.");
    } else if (bodies.has(k)) {
      d.passage = { title: d.passage.title, body: bodies.get(k) };
      d.notes.push("A new reading text will be created.");
    } else {
      d.problems.push(`The reading text "${d.passage.title}" does not exist yet. Add its text (column reading_text_body, or a [Reading text: ...] block).`);
    }
  }
  return drafts;
}

/** Everything at once: records → drafts with reading texts resolved. */
export function buildDrafts(records, { defaults = {}, existingTitles = new Set() } = {}) {
  return resolvePassages(records.map((r) => buildDraft(r, defaults)), existingTitles);
}

export { LIMITS, DIFFICULTIES };
