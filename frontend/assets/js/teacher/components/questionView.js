import { h } from "../../shared/dom.js";
import { richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";

export const TYPE_LABEL = { multiple_choice: "Multiple choice", true_false: "True or false", short_answer: "Short answer", essay: "Essay" };
export const DIFFICULTY_LABEL = { easy: "Easy", medium: "Medium", hots: "HOTS" };
const LETTERS = ["A", "B", "C", "D", "E", "F"];

export const usedText = (n) => (n === 0 ? "Not used" : n === 1 ? "1 exam" : `${n} exams`);

const rich = (html, cls, tag = "div") => {
  const el = h(tag, { class: cls });
  el.append(richFragment(html));
  return el;
};

/**
 * A question as students will see it (plus the teacher's notes: correct answer, guide, explanation).
 * Used by the list preview and by the editor preview, so both always look the same.
 * `q` fields: type, difficulty, weight, passage {title, body}, body, options [{body, is_correct}], accepted_answers,
 * essay_guidance, explanation, topic, class_labels, media [{kind}], used_in_exams, is_archived.
 */
export function questionView(q) {
  const parts = [];
  const weight = Number(q.weight);
  parts.push(
    h("div", { class: "preview-head" },
      h("span", { class: "pill" }, TYPE_LABEL[q.type] || q.type),
      h("span", { class: "pill plain" }, DIFFICULTY_LABEL[q.difficulty] || q.difficulty),
      h("span", { class: "pill plain" }, `${weight} ${weight === 1 ? "point" : "points"}`),
      q.is_archived ? h("span", { class: "pill warn" }, "Archived") : null),
    h("p", { class: "cap2" }, "What students will see"),
  );

  if (q.media && q.media.length > 0) {
    parts.push(h("div", { class: "media-note" }, q.media.map((m) => h("span", { class: "tag" }, icon(m.kind === "audio" ? "audio" : "image"), m.kind === "audio" ? " Audio" : " Image"))));
  }
  if (q.passage) {
    parts.push(h("div", { class: "passage" }, h("strong", { class: "passage-title" }, q.passage.title), rich(q.passage.body, "passage-body serif")));
  }
  parts.push(rich(q.body || "", "qtext serif"));

  if (q.type === "multiple_choice" || q.type === "true_false") {
    parts.push(...q.options.map((o, i) =>
      h("div", { class: o.is_correct ? "opt correct" : "opt" },
        h("span", { class: o.is_correct ? "bubble ok" : "bubble" }, o.is_correct ? icon("check") : LETTERS[i] || String(i + 1)),
        rich(o.body, "opt-text", "span"),
        o.is_correct ? h("span", { class: "pill ok" }, "Correct") : null)));
  } else if (q.type === "short_answer") {
    parts.push(h("div", { class: "answer-box" }, h("p", { class: "cap2" }, "Students type their answer. Accepted answers:"), h("div", { class: "chips" }, q.accepted_answers.map((a) => h("span", { class: "tag" }, a)))));
  } else {
    parts.push(h("div", { class: "answer-box" }, h("p", { class: "cap2" }, "Students write a longer answer. You grade it."), q.essay_guidance ? h("div", { class: "guide" }, h("strong", {}, "Your guide. "), rich(q.essay_guidance, "", "span")) : null));
  }

  if (q.explanation) parts.push(h("div", { class: "explain" }, h("strong", {}, "Explanation. "), rich(q.explanation, "", "span")));

  parts.push(
    h("div", { class: "meta" },
      q.topic ? h("div", {}, h("span", { class: "hint" }, "Topic "), q.topic) : null,
      q.class_labels && q.class_labels.length ? h("div", {}, h("span", { class: "hint" }, "Classes "), q.class_labels.map((l) => h("span", { class: "tag" }, l))) : null,
      q.used_in_exams !== undefined ? h("div", {}, h("span", { class: "hint" }, "Used in "), usedText(q.used_in_exams)) : null),
  );
  return parts.filter(Boolean);
}
