import { h } from "../../shared/dom.js";
import { richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { toast } from "../../shared/ui.js";
import { TYPE_LABEL } from "./questionView.js";
import { fmtPoints, pointsPicker } from "./resultBits.js";

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const rich = (html, cls, tag = "div") => {
  const el = h(tag, { class: cls });
  el.append(richFragment(html));
  return el;
};

/**
 * One question in a finished session: what the student answered, what was right, the points, and (for a
 * teacher) a control to change that grade by hand — essays and corrections use the same path (BR-07, BR-18).
 * `item` is one review entry from the session report.
 */
export function reviewItem({ item, canGrade, onSave }) {
  const points = Number(item.points) || 0;
  const max = Number(item.max_points) || 0;
  const full = max > 0 && points >= max;
  const verdict = item.type === "essay"
    ? (item.graded ? (full ? "ok" : points > 0 ? "warn" : "bad") : "warn")
    : (item.points > 0 ? "ok" : "bad");

  const head = h("div", { class: "row rev-head" },
    h("span", { class: "bubble" }, String(item.position)),
    h("span", { class: "pill" }, TYPE_LABEL[item.type] || item.type),
    h("span", { class: `pill ${verdict}` }, `${fmtPoints(points)} / ${fmtPoints(max)}`),
    item.manual ? h("span", { class: "pill plain" }, "Graded by hand") : null,
    item.type === "essay" && !item.graded ? h("span", { class: "pill warn" }, "Not graded yet") : null,
    h("span", { class: "hint req-points" }, `${fmtPoints(max)} ${max === 1 ? "point" : "points"}`),
  );

  const parts = [head];
  parts.push(rich(item.body || "", "qtext serif"));

  const chosen = String(item.chosen ?? "");
  const chosenNorm = norm(chosen);

  if (item.type === "multiple_choice" || item.type === "true_false") {
    const options = item.options || [];
    if (options.length > 0) {
      parts.push(h("div", { class: "optlist" }, options.map((o, i) => {
        const isCorrect = item.correct_text && norm(o.body) === norm(item.correct_text);
        const isChosen = chosenNorm !== "" && norm(o.body) === chosenNorm;
        const cls = `opt${isCorrect ? " correct" : ""}${isChosen ? " chosen" : ""}`;
        return h("div", { class: cls, "data-option": i },
          h("span", { class: isCorrect ? "bubble ok" : "bubble" }, isCorrect ? icon("check") : LETTERS[i] || String(i + 1)),
          rich(o.body, "opt-text", "span"),
          isChosen ? h("span", { class: "pill plain" }, "Student's answer") : null,
          isCorrect ? h("span", { class: "pill ok" }, "Correct") : null);
      })));
    }
  } else if (item.type === "short_answer") {
    parts.push(h("div", { class: "answer-box" },
      h("p", { class: "cap2" }, "Accepted answers"),
      h("div", { class: "chips" }, (item.accepted_text || []).map((a) => h("span", { class: "tag" }, a)))));
  } else if (item.guide) {
    parts.push(h("div", { class: "guide" }, h("strong", {}, "Your guide. "), rich(item.guide, "", "span")));
  }

  const answerBox = h("div", { class: "answerbox serif" });
  if (chosen.trim() === "") answerBox.append(h("p", { class: "hint" }, "Left blank."));
  else answerBox.append(document.createTextNode(chosen));
  parts.push(h("div", { class: "answer-box" }, h("p", { class: "cap2" }, "The student's answer"), answerBox));
  if (item.feedback) parts.push(h("p", { class: "hint" }, `Your comment: ${item.feedback}`));

  const wrap = h("div", { class: "card sec rev-item", "data-question": item.question_id }, parts);

  if (canGrade) {
    const picker = pointsPicker({ max, value: item.graded ? points : null, name: `g-${item.question_id}` });
    const comment = h("textarea", { class: "ta", rows: "2", placeholder: "Comment for the student (optional)" });
    if (item.feedback) comment.value = item.feedback;
    const save = h("button", { class: "btn small", type: "button", "data-grade": "" }, item.type === "essay" ? "Save grade" : "Correct grade");
    save.addEventListener("click", async () => {
      const value = picker.get();
      if (value === null || Number.isNaN(value)) { toast("Choose the points first.", "bad"); return; }
      save.disabled = true;
      try {
        await onSave({ questionId: item.question_id, points: value, feedback: comment.value });
      } catch (err) {
        toast(err.message || "The grade could not be saved.", "bad");
      } finally {
        save.disabled = false;
      }
    });
    wrap.append(h("div", { class: "rev-grade" },
      h("span", { class: "lbl" }, item.type === "essay" ? "Your grade" : "Correct this grade"),
      picker.el,
      comment,
      h("div", { class: "row grade-actions" }, save)));
  }

  return wrap;
}
