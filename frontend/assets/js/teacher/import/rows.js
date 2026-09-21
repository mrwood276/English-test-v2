import { clean, norm, validateDraft } from "./model.js";
const aliases = { type:["type","jenis"], body:["question","question_text","soal","pertanyaan"], correct:["correct","answer","key","jawaban","kunci"], essay_guidance:["guide","guidance","panduan"], explanation:["explanation","pembahasan"], topic:["topic","materi"], difficulty:["difficulty","level","tingkat"], weight:["points","point","weight","poin"], class_labels:["class","class_label","kelas"], passage_title:["reading_text","reading_text_title","teks_bacaan"], passage_body:["reading_text_body","teks_bacaan_isi"] };
for (const letter of "abcdef") aliases[`option_${letter}`] = [`option_${letter}`, `answer_${letter}`, `pilihan_${letter}`];
const key = (v) => norm(v).replace(/[\s-]+/g, "_");
export function headerMap(headers) { const m = {}; headers.forEach((h, i) => { const k = key(h); for (const [name, list] of Object.entries(aliases)) if (list.includes(k)) m[name] = i; }); return m; }
const at = (row, map, name) => map[name] === undefined ? "" : clean(row[map[name]]);
function inferred(type, opts, correct) { if (type) return type.replace(/[\s-]+/g, "_").toLowerCase(); if (opts.length) return "multiple_choice"; return /^(true|false|benar|salah)$/i.test(correct) ? "true_false" : correct ? "short_answer" : "essay"; }
export function spreadsheetDrafts(rows) {
  if (!rows.length) return [];
  const map = headerMap(rows[0]);
  return rows.slice(1).filter((r) => r.some((v) => clean(v))).map((r, index) => {
    const rawOptions = "abcdef".split("").map((l) => at(r, map, `option_${l}`)).filter(Boolean);
    const correct = at(r, map, "correct"); const type = inferred(at(r, map, "type"), rawOptions, correct);
    let options = rawOptions.map((body, i) => ({ body, is_correct: type === "true_false" ? norm(body) === norm(correct) : String.fromCharCode(65 + i).toLowerCase() === norm(correct) }));
    if (type === "true_false" && !options.length) options = ["True", "False"].map((body) => ({ body, is_correct: norm(body) === norm(correct) }));
    const title = at(r, map, "passage_title"), passageBody = at(r, map, "passage_body");
    const draft = { row:index + 2, type, body:at(r,map,"body"), difficulty:at(r,map,"difficulty"), topic:at(r,map,"topic"), weight:at(r,map,"weight"), options, accepted_answers:type === "short_answer" ? correct.split("|").map(clean).filter(Boolean) : [], essay_guidance:at(r,map,"essay_guidance"), explanation:at(r,map,"explanation"), class_labels:at(r,map,"class_labels").split(/[;,|]/).map(clean).filter(Boolean), ...(title ? { passage:{ title, ...(passageBody ? { body: passageBody } : {}) } } : {}) };
    return validateDraft(draft);
  });
}
