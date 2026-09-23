import { h } from "../../shared/dom.js";
import { richFragment } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

const rich = (html, cls, tag = "div") => {
  const el = h(tag, { class: cls });
  el.append(richFragment(html));
  return el;
};

/**
 * Images and audio for a question or a reading text. `urls` maps a media id to a short-lived link
 * from the `media` action; a file whose link is missing is shown as a small label instead of a broken player.
 */
export function mediaBlock(files, urls) {
  if (!files || files.length === 0) return null;
  return h("div", { class: "media-block" }, files.map((file) => {
    const url = urls[file.id];
    if (file.kind === "image") {
      return url
        ? h("img", { class: "q-image", src: url, alt: "", loading: "lazy" })
        : h("span", { class: "tag" }, icon("image"), " Image");
    }
    return url
      ? h("audio", { controls: true, preload: "none", src: url })
      : h("span", { class: "tag" }, icon("audio"), " Audio");
  }));
}

/**
 * One question as the student answers it. The element is built once and then updated in place, so a
 * text box never loses focus or the cursor while the student types.
 *
 * @param question  one entry of the session snapshot
 * @param urls      media id → signed url
 * @param handlers  { value(id), onAnswer(id, text), onFlag(id) }
 * @returns { el, sync() } — `sync()` refreshes the visuals from the store (used after a resume)
 */
export function questionBlock(question, urls, handlers) {
  const id = question.question_id;
  const parts = [];

  if (question.passage) {
    parts.push(h("div", { class: "passage" },
      h("strong", { class: "passage-title" }, question.passage.title),
      mediaBlock(question.passage.media, urls),
      rich(question.passage.body, "passage-body serif")));
  }
  const ownMedia = mediaBlock(question.media, urls);
  if (ownMedia) parts.push(ownMedia);
  parts.push(rich(question.body || "", "qtext serif"));

  let sync = () => {};

  if (question.type === "multiple_choice" || question.type === "true_false") {
    const options = question.options || [];
    const buttons = options.map((option, index) => {
      const button = h("button", { class: "opt", type: "button" },
        h("span", { class: "bubble" }, question.type === "multiple_choice" ? (LETTERS[index] || String(index + 1)) : (option.body || "").slice(0, 1)),
        rich(option.body, "opt-text", "span"));
      button.addEventListener("click", () => {
        handlers.onAnswer(id, option.body);
        paint(option.body);
      });
      return button;
    });
    const paint = (value) => {
      buttons.forEach((button, index) => {
        button.classList.toggle("sel", options[index].body === value);
      });
    };
    sync = () => paint(handlers.value(id));
    parts.push(...buttons);
    sync();
  } else if (question.type === "short_answer") {
    const input = h("input", {
      class: "input", type: "text", autocomplete: "off", autocapitalize: "sentences",
      spellcheck: "false", value: handlers.value(id) || "", placeholder: "Type your answer",
    });
    input.addEventListener("input", () => handlers.onAnswer(id, input.value));
    sync = () => { input.value = handlers.value(id) || ""; };
    parts.push(h("div", { class: "answer-area" },
      h("p", { class: "hint" }, "Spelling matters. Write your answer in the box."), input));
  } else {
    const area = h("textarea", { spellcheck: "true", placeholder: "Write your answer" });
    area.value = handlers.value(id) || "";
    area.addEventListener("input", () => handlers.onAnswer(id, area.value));
    sync = () => { area.value = handlers.value(id) || ""; };
    parts.push(h("div", { class: "answer-area" },
      h("p", { class: "hint" }, "Your teacher reads this answer and gives the points."), area));
  }

  return { el: h("div", { class: "question" }, parts.filter(Boolean)), sync };
}
