import assert from "node:assert/strict";
// @ts-ignore: plain JavaScript modules shared with the browser
import { parseCsv } from "../../assets/js/teacher/import/csv.js";
// @ts-ignore
import { parsePastedText, EXAMPLE_TEXT } from "../../assets/js/teacher/import/text.js";
// @ts-ignore
import { recordsFromRows, buildDraft, buildDrafts, mapHeader } from "../../assets/js/teacher/import/rows.js";
// @ts-ignore
import { validateDraft, normalizeText, dupKey } from "../../assets/js/teacher/import/rules.js";

// ---------- CSV ----------
Deno.test("csv: commas, quotes, line breaks inside cells, and line numbers", () => {
  const { rows, numbers, delimiter } = parseCsv('question,option_a,option_b\r\n"Who said ""hi"", loudly?","Ana, the cook",Budi\r\n\r\n"Line one\nline two",x,y\n');
  assert.equal(delimiter, ",");
  assert.deepEqual(rows, [["question", "option_a", "option_b"], ['Who said "hi", loudly?', "Ana, the cook", "Budi"], ["Line one\nline two", "x", "y"]]);
  assert.deepEqual(numbers, [1, 2, 4], "the third row starts on line 4 of the file");
});

Deno.test("csv: semicolon and tab delimiters, BOM, trailing delimiters", () => {
  assert.equal(parseCsv("\uFEFFquestion;correct\nWho?;B\n").delimiter, ";");
  assert.deepEqual(parseCsv("\uFEFFquestion;correct\nWho?;B\n").rows[0], ["question", "correct"]);
  assert.equal(parseCsv("question\tcorrect\nWho?\tB").delimiter, "\t");
  assert.deepEqual(parseCsv('a,b,c\n1,2,\n').rows[1], ["1", "2", ""]);
  assert.deepEqual(parseCsv("").rows, []);
  assert.deepEqual(parseCsv('"only, one cell"').rows, [["only, one cell"]]);
});

// ---------- header mapping and rows ----------
Deno.test("headers: English and Indonesian names, spacing and case ignored", () => {
  // deno-lint-ignore no-explicit-any
  const c: any = mapHeader(["No", "Soal", "Pilihan A", "Option B", "C", "d", "Kunci", "Materi", "Tingkat", "Bobot", "Kelas", "Reading Text", "Reading text body", "Pembahasan"]);
  assert.equal(c.question, 1);
  assert.deepEqual(c.options.slice(0, 4), [2, 3, 4, 5]);
  assert.equal(c.correct, 6); assert.equal(c.topic, 7); assert.equal(c.difficulty, 8); assert.equal(c.points, 9);
  assert.equal(c.classText, 10); assert.equal(c.readingTitle, 11); assert.equal(c.readingBody, 12); assert.equal(c.explanation, 13);
  assert.equal(mapHeader(["question", "answer"]).correct, 1, '"answer" alone is the answer key, not option A');
});

Deno.test("rows: a header with a question column is required", () => {
  assert.match(recordsFromRows([]).problem, /empty/);
  assert.match(recordsFromRows([["a", "b"], ["1", "2"]]).problem, /question/);
  const { records, problem } = recordsFromRows([["question", "a", "b", "correct"], ["Who?", "Ana", "Budi", "B"], ["", "", "", ""]], [1, 2, 3]);
  assert.equal(problem, null);
  assert.equal(records.length, 1, "empty rows are ignored");
  assert.equal(records[0].row, 2);
  assert.deepEqual(records[0].options.slice(0, 2), ["Ana", "Budi"]);
});

const rec = (over: Record<string, unknown> = {}) => ({ row: 2, type: "", question: "Who found it?", options: ["Dina", "Budi", "", "", "", ""], correct: "A", guide: "", explanation: "", topic: "", difficulty: "", points: "", classText: "", readingTitle: "", readingBody: "", ...over });

Deno.test("draft: multiple choice is inferred and checked", () => {
  const d = buildDraft(rec());
  assert.equal(d.type, "multiple_choice");
  assert.deepEqual(d.options, [{ body: "Dina", is_correct: true }, { body: "Budi", is_correct: false }]);
  assert.deepEqual(d.problems, []);
  assert.equal(d.difficulty, "medium"); assert.equal(d.weight, 1);
  assert.match(buildDraft(rec({ correct: "" })).problems[0], /Say which answer/);
  assert.match(buildDraft(rec({ correct: "C" })).problems.join(" "), /C is empty or missing/);
  assert.match(buildDraft(rec({ correct: "A, B" })).problems.join(" "), /exactly one/);
  assert.match(buildDraft(rec({ correct: "Bandung" })).problems.join(" "), /not a letter/);
  assert.match(buildDraft(rec({ options: ["Dina", "", "", "", "", ""] })).problems.join(" "), /between 2 and 6/);
  assert.match(buildDraft(rec({ options: ["Dina", "dina ", "", "", "", ""] })).problems.join(" "), /same/);
  assert.match(buildDraft(rec({ question: "  " })).problems.join(" "), /empty/);
  assert.equal(buildDraft(rec({ correct: "b." })).options[1].is_correct, true, "letters may have punctuation and any case");
  assert.equal(buildDraft(rec({ correct: "(a)" })).options[0].is_correct, true);
});

Deno.test("draft: options may skip a letter without shifting the correct answer", () => {
  const d = buildDraft(rec({ options: ["One", "", "Three", "", "", ""], correct: "C" }));
  assert.deepEqual(d.options, [{ body: "One", is_correct: false }, { body: "Three", is_correct: true }]);
});

Deno.test("draft: true/false, short answer, and essay", () => {
  const tf = buildDraft(rec({ options: [], correct: "False" }));
  assert.equal(tf.type, "true_false");
  assert.deepEqual(tf.options, [{ body: "True", is_correct: false }, { body: "False", is_correct: true }]);
  assert.equal(buildDraft(rec({ options: [], correct: "benar" })).options[0].is_correct, true);
  assert.match(buildDraft(rec({ type: "true/false", options: [], correct: "maybe" })).problems.join(" "), /True" or "False/);
  const sa = buildDraft(rec({ options: [], correct: "past | Simple Past;past simple" }));
  assert.equal(sa.type, "short_answer");
  assert.deepEqual(sa.accepted_answers, ["past", "Simple Past", "past simple"]);
  assert.match(buildDraft(rec({ type: "isian singkat", options: [], correct: "" })).problems.join(" "), /accepted answer/);
  assert.match(buildDraft(rec({ type: "short answer", options: [], correct: "a|A" })).problems.join(" "), /same/);
  const essay = buildDraft(rec({ type: "esai", options: [], correct: "", guide: "One mark per idea." }));
  assert.equal(essay.type, "essay"); assert.equal(essay.essay_guidance, "One mark per idea."); assert.deepEqual(essay.problems, []);
  assert.equal(buildDraft(rec({ options: [], correct: "", guide: "Grade on ideas." })).type, "essay");
  assert.match(buildDraft(rec({ options: [], correct: "" })).problems[0], /Could not tell/);
  assert.match(buildDraft(rec({ type: "matching" })).problems[0], /not known/);
});

Deno.test("draft: difficulty, points, labels, topic, and defaults", () => {
  const d = buildDraft(rec({ difficulty: "Sulit", points: "1,5", classText: "XII TKJ A; xii tkj a | XII TKJ B", topic: "Narrative" }));
  assert.equal(d.difficulty, "hots"); assert.equal(d.weight, 1.5);
  assert.deepEqual(d.class_labels, ["XII TKJ A", "xii tkj a", "XII TKJ B"], "the server merges labels that differ only by case");
  assert.equal(d.topic, "Narrative");
  assert.match(buildDraft(rec({ difficulty: "hard" })).problems.join(" "), /difficulty "hard"/);
  assert.match(buildDraft(rec({ points: "lots" })).problems.join(" "), /not a number/);
  assert.match(buildDraft(rec({ points: "0" })).problems.join(" "), /more than 0/);
  const defaults = { labels: ["XII TKJ A"], topic: "Grammar", difficulty: "easy", points: 2 };
  const withDefaults = buildDraft(rec(), defaults);
  assert.deepEqual(withDefaults.class_labels, ["XII TKJ A"]); assert.equal(withDefaults.topic, "Grammar"); assert.equal(withDefaults.difficulty, "easy"); assert.equal(withDefaults.weight, 2);
  const own = buildDraft(rec({ classText: "XI TKJ B", topic: "Own", difficulty: "hots", points: "3" }), defaults);
  assert.deepEqual(own.class_labels, ["XI TKJ B"]); assert.equal(own.topic, "Own"); assert.equal(own.difficulty, "hots"); assert.equal(own.weight, 3);
});

Deno.test("reading texts: shared by title, existing ones reused, missing ones reported", () => {
  const drafts = buildDrafts([
    rec({ row: 2, readingTitle: "The Lost Wallet", readingBody: "Dina found a wallet." }),
    rec({ row: 3, readingTitle: "the  lost wallet" }),
    rec({ row: 4, readingTitle: "Old Story" }),
    rec({ row: 5, readingTitle: "Nobody Knows" }),
  ], { existingTitles: new Set(["old story"]) });
  assert.deepEqual(drafts[0].passage, { title: "The Lost Wallet", body: "Dina found a wallet." });
  assert.deepEqual(drafts[1].passage, { title: "the  lost wallet", body: "Dina found a wallet." }, "a later row with the same title shares the text");
  assert.deepEqual(drafts[2].passage, { title: "Old Story" });
  assert.match(drafts[3].problems.join(" "), /does not exist yet/);
});

// ---------- rules ----------
Deno.test("rules: normalization and duplicate keys", () => {
  assert.equal(normalizeText("  Budi   SANTOSO "), "budi santoso");
  assert.equal(dupKey("Who?", ["B", "A"]), dupKey("  who? ", ["a", " b"]));
  assert.notEqual(dupKey("Who?", ["A", "B"]), dupKey("Who?", ["A", "C"]));
  assert.deepEqual(validateDraft({ type: "essay", body: "Explain.", difficulty: "hots", weight: 2, class_labels: [] }), []);
  assert.match(validateDraft({ type: "essay", body: "x", difficulty: "hard", weight: 1 }).join(" "), /Difficulty/);
  assert.match(validateDraft({ type: "essay", body: "x", difficulty: "easy", weight: 101 }).join(" "), /Points/);
  assert.match(validateDraft({ type: "essay", body: "x", difficulty: "easy", weight: 1, class_labels: new Array(11).fill("a") }).join(" "), /at most 10 class labels/);
});

// ---------- pasted text ----------
Deno.test("text: the built-in example is read completely", () => {
  const { records, passages, problems } = parsePastedText(EXAMPLE_TEXT);
  assert.deepEqual(problems, []);
  assert.equal(records.length, 4);
  assert.deepEqual(Object.keys(passages), ["The Lost Wallet"]);
  const [q1, q2, q3, q4] = records;
  assert.equal(q1.question, "What did Dina do first after she found the wallet?");
  assert.deepEqual(q1.options, ["She kept the money.", "She looked around for the owner.", "She called the police.", "She left it under the bench."]);
  assert.equal(q1.correct, "B"); assert.equal(q1.topic, "Narrative Text"); assert.equal(q1.difficulty, "HOTS"); assert.equal(q1.points, "2");
  assert.equal(q1.classText, "XII TKJ A, XII TKJ B"); assert.equal(q1.readingTitle, "The Lost Wallet");
  assert.match(q1.readingBody, /^Dina found a brown wallet/); assert.match(q1.explanation, /looked around/);
  assert.equal(q2.correct, "False"); assert.deepEqual(q2.options, []);
  assert.equal(q3.correct, "past | simple past");
  assert.equal(q4.type, "essay"); assert.match(q4.guide, /One mark/);
  const drafts = buildDrafts(records, { existingTitles: new Set() });
  assert.deepEqual(drafts.map((d: { type: string }) => d.type), ["multiple_choice", "true_false", "short_answer", "essay"]);
  assert.deepEqual(drafts.flatMap((d: { problems: string[] }) => d.problems), []);
  assert.equal(drafts[0].passage.body.startsWith("Dina found"), true);
});

Deno.test("text: blank-line separated questions, option styles, and markers", () => {
  const { records } = parsePastedText(`Who found the wallet?
(a) Dina
(b) Budi *
c) Sita

Where was it?
A) Library
*B) Canteen
Kunci: A`);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].options, ["Dina", "Budi", "Sita"]); assert.equal(records[0].correct, "B");
  assert.deepEqual(records[1].options, ["Library", "Canteen"]); assert.equal(records[1].correct, "A", "an explicit answer line wins over a marker");
});

Deno.test("text: word artifacts, long answers, multi-line stems and explanations", () => {
  const { records } = parsePastedText("1.\u00a0Read the sentence:\nShe ___ to school.\nA.\tgo\nB. goes\nand then some more words\nC. going\nAnswer:\tB\nExplanation: Third person\nsingular takes -s.\n2) Next question?\nAnswer: True");
  assert.equal(records.length, 2);
  assert.equal(records[0].question, "Read the sentence:<br>She ___ to school.");
  assert.deepEqual(records[0].options, ["go", "goes and then some more words", "going"]);
  assert.equal(records[0].correct, "B");
  assert.equal(records[0].explanation, "Third person singular takes -s.");
  assert.equal(records[1].question, "Next question?");
});

Deno.test("text: a stem that contains an option-like line does not break the question", () => {
  const { records } = parsePastedText("1. Choose the best sentence.\nB. This line is part of the stem.\nA. First\nB. Second\nAnswer: B");
  assert.equal(records[0].question, "Choose the best sentence.<br>B. This line is part of the stem.");
  assert.deepEqual(records[0].options, ["First", "Second"]);
});

Deno.test("text: reading text blocks become paragraphs and are attached by title", () => {
  const { records, passages } = parsePastedText("[Teks bacaan: Cerita]\nParagraf satu\nlanjut.\n\nParagraf dua.\n[/Teks bacaan]\n1. Siapa?\nA. Ani\nB. Budi\nJawaban: A\nReading text: Cerita");
  assert.equal(passages["Cerita"], "Paragraf satu lanjut.<br><br>Paragraf dua.");
  assert.equal(records[0].readingBody, passages["Cerita"]);
});

Deno.test("text: empty input and text before the first number", () => {
  assert.deepEqual(parsePastedText("").records, []);
  assert.equal(parsePastedText("Some title line\n\n1. First?\nA. x\nB. y\nAnswer: A").records.length, 1);
});
