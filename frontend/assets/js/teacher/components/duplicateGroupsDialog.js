import { h } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";

/**
 * Review the duplicate-overview scan (the question-list banner): questions with exactly the same text
 * (one group each) and pairs that read alike (a similarity percentage), grouped the way the server
 * reported them. Every question links to its editor, so a teacher can look and decide.
 *
 * `groups` is what `question-bank`'s `duplicate_groups` returns:
 * { question_count, exact_groups: [{ questions: [{ id, body, used_in_exams }] }], similar_pairs: [{ similarity, questions: [...] }] }
 *
 * Resolves when the dialog closes. It closes itself when the address changes, so following a link
 * inside it never leaves a dialog on top of the editor.
 */
export function duplicateGroupsDialog(groups) {
  return new Promise((resolve) => {
    const item = (q) =>
      h(
        "li",
        {},
        h("a", { class: "qlink", href: `#/questions/edit/${q.id}` }, plainText(q.body, 120)),
        h("span", { class: "hint" }, q.used_in_exams > 0 ? `used in ${q.used_in_exams} ${q.used_in_exams === 1 ? "exam" : "exams"}` : "not used yet"),
      );
    const exact = (groups.exact_groups || []).map((g) =>
      h("section", { class: "dup-group" }, h("h3", {}, `Same text (${g.questions.length} questions)`), h("ul", {}, ...g.questions.map(item))));
    const similar = (groups.similar_pairs || []).map((p) =>
      h("section", { class: "dup-group" }, h("h3", {}, `${Math.round(p.similarity * 100)}% alike`), h("ul", {}, ...p.questions.map(item))));
    const close = h("button", { class: "btn", type: "button" }, "Close");

    const dialog = h(
      "dialog",
      { class: "dialog wide dup-dialog", "aria-labelledby": "dup-dialog-title" },
      h("h2", { id: "dup-dialog-title" }, "Questions that look alike"),
      h("p", {}, "Two questions that read the same usually mean one of them is a copy. Open one to change it, or archive the one you do not want."),
      exact.length || similar.length ? [...exact, ...similar] : h("p", { class: "hint" }, "Nothing looks duplicated any more."),
      h("div", { class: "dialog-actions" }, close),
    );

    const onHashChange = () => dialog.close();
    close.addEventListener("click", () => dialog.close());
    window.addEventListener("hashchange", onHashChange);
    dialog.addEventListener("close", () => {
      window.removeEventListener("hashchange", onHashChange);
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  });
}
