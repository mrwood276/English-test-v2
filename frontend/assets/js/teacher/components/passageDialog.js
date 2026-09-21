import { h } from "../../shared/dom.js";
import { questionBank } from "../api/questionBank.js";
import { richTextarea } from "./richTextarea.js";
import { mediaPicker } from "./mediaPicker.js";
import { attachMediaUrls } from "../api/media.js";

/**
 * Create or edit a reading text in a dialog. Resolves to the saved passage id, or null when cancelled.
 * `passage` is { id, title, body, question_count } when editing.
 */
export function passageDialog({ passage = null } = {}) {
  return new Promise((resolve) => {
    const title = h("input", { class: "inp", id: "passage-title", type: "text", maxlength: "200", autocomplete: "off" });
    title.value = passage ? passage.title : "";
    const body = richTextarea({ id: "passage-body", label: "reading text", rows: 9, value: passage ? passage.body : "" });
    const error = h("div", { class: "notice error", role: "alert", hidden: true });
    const passageMedia = passage && passage.media ? passage.media : [];
    attachMediaUrls({ media: passageMedia }).then(() => picker.set(passageMedia));
    const picker = mediaPicker({ items: passageMedia, id: "passage-media" });
    const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    const save = h("button", { class: "btn", type: "button" }, "Save reading text");
    const shared = passage && passage.question_count > 0
      ? h("div", { class: "notice info" }, `This text is used by ${passage.question_count} ${passage.question_count === 1 ? "question" : "questions"}. Changing it changes it for all of them. Tests that already started are not affected.`)
      : null;

    const dialog = h(
      "dialog",
      { class: "dialog wide", "aria-labelledby": "passage-dialog-title" },
      h("h2", { id: "passage-dialog-title" }, passage ? "Edit reading text" : "New reading text"),
      shared, error,
      h("div", { class: "field" }, h("label", { for: "passage-title" }, "Title"), title),
      h("div", { class: "field" }, h("label", { for: "passage-body" }, "Text"), body.el),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Images and audio (optional)"), picker.el),
      h("div", { class: "dialog-actions" }, cancel, save),
    );

    let result = null;
    cancel.addEventListener("click", () => dialog.close());
    save.addEventListener("click", async () => {
      error.hidden = true;
      if (!title.value.trim()) { error.textContent = "The reading text needs a title."; error.hidden = false; title.focus(); return; }
      if (!body.textarea.value.trim()) { error.textContent = "The reading text is empty."; error.hidden = false; body.textarea.focus(); return; }
      if (picker.busy) { error.textContent = "Wait for the files to finish uploading."; error.hidden = false; return; }
      save.disabled = cancel.disabled = true;
      save.textContent = "Saving…";
      try {
        result = await questionBank.savePassage({ id: passage ? passage.id : undefined, title: title.value, body: body.textarea.value, media: picker.items.map((m) => ({ id: m.id })) });
        dialog.close();
      } catch (err) {
        if (err.name === "SessionExpiredError") { dialog.close(); return; }
        error.textContent = err.message || "Could not save the reading text.";
        error.hidden = false;
        save.disabled = cancel.disabled = false;
        save.textContent = "Save reading text";
      }
    });
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    title.focus();
  });
}
