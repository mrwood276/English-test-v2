import { clean, norm, validateDraft } from "./model.js";
const META = /^(topic|level|difficulty|points|class|explanation|type|guide|reading text)\s*:\s*(.*)$/i;
const ANSWER = /^(answer|key|jawaban|kunci)\s*:\s*(.*)$/i;
const OPTION = /^\s*(?:\(?([A-F])\)?[.)])\s*(\*?)(.*)$/i;

export function pastedDrafts(source) {
  const passages = new Map();
  const withoutPassages = String(source).replace(/\r/g, "").replace(/^\s*\[reading text:\s*([^\]]+)\]\s*\n?([\s\S]*?)^\s*\[\/reading text\]\s*\n?/gim, (_, title, body) => { passages.set(norm(title), { title: clean(title), body: body.trim() }); return ""; });
  const lines = withoutPassages.split("\n"); const drafts = []; let current = null;
  const finish = () => { if (current) { current.body = current.body.join("\n").trim(); current.options = current.options.map((o) => ({ body:o.body, is_correct:o.marked || norm(current.answer) === o.letter.toLowerCase() || norm(current.answer) === norm(o.body) })); if (!current.type) current.type = current.options.length ? "multiple_choice" : /^(true|false|benar|salah)$/i.test(current.answer || "") ? "true_false" : current.answer ? "short_answer" : "essay"; if (current.type === "true_false" && !current.options.length) current.options = ["True", "False"].map((body) => ({ body, is_correct:norm(body) === norm(current.answer) })); current.accepted_answers = current.type === "short_answer" ? (current.answer || "").split("|").map(clean).filter(Boolean) : []; delete current.answer; current.options.forEach((o) => { delete o.letter; delete o.marked; }); drafts.push(validateDraft(current)); } current = null; };
  for (let n = 0; n < lines.length; n++) { const line = lines[n]; const start = /^\s*(\d+)\s*[.)]\s*(.*)$/.exec(line); if (start) { finish(); current = { row:Number(start[1]), body:[start[2]], options:[], class_labels:[] }; continue; } if (!current) continue;
    const option = OPTION.exec(line); const answer = ANSWER.exec(line); const meta = META.exec(line);
    if (option) current.options.push({ letter:option[1].toLowerCase(), marked:option[2] === "*", body:option[3].trim() });
    else if (answer) current.answer = answer[2].trim();
    else if (meta) { const k = meta[1].toLowerCase(); const v = meta[2].trim(); if (k === "class") current.class_labels = v.split(/[;,|]/).map(clean).filter(Boolean); else if (k === "level") current.difficulty = v; else if (k === "guide") current.essay_guidance = v; else if (k === "reading text") current.passage = passages.get(norm(v)) || { title: v }; else current[k] = v; }
    else if (line.trim()) current.body.push(line.trim());
  } finish(); return drafts;
}
