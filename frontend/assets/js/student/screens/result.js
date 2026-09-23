import { h, mount } from "../../shared/dom.js";
import { richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import * as store from "../store.js";

const rich = (html, cls, tag = "div") => {
  const el = h(tag, { class: cls });
  el.append(richFragment(html));
  return el;
};

const timeText = (seconds) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(s / 60);
  return `${minutes}m ${two(s % 60)}s`;
};
const two = (n) => String(n).padStart(2, "0");

const PASS_LABEL = { passed: "Passed", failed: "Not passed", not_final: "Not final" };
const REASON_NOTE = {
  time_up: "Time was up, so your test was sent automatically.",
  tab_switch_limit: "You left the test page too many times, so your test was sent automatically.",
  already_submitted: "This test was already sent.",
};

/** One question of the review the teacher allowed the student to see (BR-08). */
function reviewItem(item) {
  const parts = [
    h("div", { class: "review-head" },
      h("span", {}, `Question ${item.position}`),
      item.is_correct === true ? h("span", { class: "pill ok" }, "Correct")
        : item.is_correct === false ? h("span", { class: "pill bad" }, "Wrong")
          : h("span", { class: "pill warn" }, "Waiting for your teacher"),
      h("span", { class: "hint" }, `${item.points} / ${item.max_points} points`)),
  ];

  parts.push(rich(item.body || "", item.type === "multiple_choice" || item.type === "true_false" ? "qtext serif" : "qtext serif"));
  if (item.type === "multiple_choice" || item.type === "true_false") {
    for (const option of item.options || []) {
      const chosen = option.body === item.chosen;
      const correct = option.body === item.correct_text;
      parts.push(h("div", { class: `opt${correct ? " correct" : chosen ? " sel" : ""}` },
        h("span", { class: `bubble${correct ? " ok" : chosen ? " fill" : ""}` }, correct ? icon("check") : ""),
        rich(option.body, "opt-text", "span")));
    }
  } else {
    parts.push(h("div", { class: "chosen" },
      h("span", {}, icon("pencil")),
      h("span", {}, item.chosen ? item.chosen : h("i", {}, "No answer"))));
    if (item.type === "short_answer" && (item.accepted_text || []).length > 0) {
      parts.push(h("p", { class: "hint" }, `Accepted answers: ${item.accepted_text.join(", ")}`));
    }
  }
  return h("div", { class: "review-item" }, parts);
}

/**
 * What the student sees after sending (BR-08): nothing, the score, or the score plus a review.
 * The server already decided which of those applies, so this screen only draws the answer.
 *
 * @param ctx { onDone() }
 */
export function renderResult(root, result, ctx, { reason } = {}) {
  const session = store.state.session || {};
  const exam = session.exam || {};
  const parts = [];

  parts.push(
    h("div", { class: "brand-row", style: "margin-bottom:22px" },
      h("span", { class: "bubble fill" }, icon("check")),
      h("b", {}, "Test submitted")),
    h("p", { class: "who" }, `${session.student_name || ""}${session.student_class ? `, ${session.student_class}` : ""}`));

  const note = REASON_NOTE[reason];
  if (note) parts.push(h("div", { class: "note" }, icon("alert"), h("span", {}, note)));

  const score = result.score;
  const pct = score ? Number(score.percentage) : null;
  const passLabel = (score && score.pass_status) || result.pass_status;

  if (pct !== null) {
    parts.push(
      h("div", { style: "display:flex;align-items:flex-end;gap:12px;margin:10px 0 4px" },
        h("span", { class: `score ${passLabel === "passed" ? "pass" : passLabel === "failed" ? "fail" : ""}` }, String(Math.round(pct * 10) / 10)),
        h("span", { class: `pill ${result.pending_review ? "warn" : passLabel === "passed" ? "ok" : "bad"}`, style: "margin-bottom:14px" },
          result.pending_review ? "Not final" : (PASS_LABEL[passLabel] || "")),
        h("span", { class: "hint", style: "margin-bottom:14px" }, "out of 100")),
      h("p", { class: "who", style: "margin-bottom:14px" },
        result.pending_review
          ? `Score so far. The passing grade is ${result.passing_grade}.`
          : `The passing grade is ${result.passing_grade}.`));
  } else if (result.pending_review) {
    parts.push(
      h("p", { class: "who", style: "margin:8px 0 14px" }, "Your written answers are with your teacher."),
      h("h2", { style: "font-size:22px;margin-bottom:4px" }, "Waiting for your teacher"));
  } else {
    parts.push(h("h2", { style: "font-size:22px;margin:8px 0 4px" }, "Your answers were sent"),
      h("p", { class: "who", style: "margin-bottom:14px" }, "Your teacher will tell you the score."));
  }

  const waiting = Math.max(0, Number(result.pending_essays || 0));
  if (result.pending_review && waiting > 0) {
    parts.push(h("div", { class: "note" }, icon("info"),
      h("span", {}, `${waiting} ${waiting === 1 ? "written answer is" : "written answers are"} waiting for your teacher. Your final score can go up or down.`)));
  }

  if (score) {
    parts.push(h("div", { class: "card" },
      h("div", { class: "kv" }, h("span", {}, "Automatic questions"), h("b", {}, `${score.correct_count} correct, ${score.wrong_count} wrong`)),
      waiting > 0 ? h("div", { class: "kv" }, h("span", {}, "Written answers"), h("b", {}, "Waiting")) : null,
      h("div", { class: "kv" }, h("span", {}, "Points"), h("b", {}, `${Number(score.total_points)} of ${Number(score.max_points)}`)),
      h("div", { class: "kv" }, h("span", {}, "Time used"), h("b", {}, timeText(score.time_used_seconds)))));
  }

  if (result.review && result.review.length > 0) {
    parts.push(h("h2", { style: "font-size:18px;margin:22px 0 6px" }, "Your answers"),
      h("div", { class: "card" }, result.review.map(reviewItem)));
  }

  const done = h("button", { class: "btn block", type: "button", style: "margin-top:22px" }, "Done");
  done.addEventListener("click", () => {
    store.reset();
    ctx.onDone();
  });
  parts.push(done, h("p", { class: "fine", style: "text-align:center" }, "You can close this page now."));

  mount(root, h("main", { class: "phone result" }, h("div", { class: "pad" }, parts.filter(Boolean))));
}
