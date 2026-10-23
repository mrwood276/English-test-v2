import { h } from "../../shared/dom.js";

/**
 * Dialog to move selected questions into an existing or new folder.
 * Resolves with the folder name (string), "" to remove from folder, or null if cancelled.
 */
export function folderDialog({ count, folders = [] }) {
  return new Promise((resolve) => {
    let resolved = false;
    const dialog = h("dialog", { class: "dialog" });
    const selectEl = h("select", { class: "inp", id: "fd-folder-select" }, [
      h("option", { value: "" }, "Select a folder…"),
      ...folders.map((f) => h("option", { value: f }, `📁 ${f}`)),
      h("option", { value: "__new__" }, "➕ New folder…"),
      h(
        "option",
        { value: "__clear__" },
        "🚫 Remove from folder (uncategorized)",
      ),
    ]);

    const newFolderInput = h("input", {
      class: "inp",
      id: "fd-folder-new",
      type: "text",
      maxlength: "120",
      placeholder: "New folder name (e.g. Chapter 1, Tenses)",
      hidden: true,
    });

    const errorMsg = h("p", { class: "field-error", hidden: true });

    selectEl.addEventListener("change", () => {
      newFolderInput.hidden = selectEl.value !== "__new__";
      if (!newFolderInput.hidden) newFolderInput.focus();
      errorMsg.hidden = true;
    });

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try {
        dialog.close();
      } catch (_) {
        // already closed
      }
      dialog.remove();
      resolve(result);
    };

    const cancelBtn = h(
      "button",
      { class: "btn ghost", type: "button" },
      "Cancel",
    );
    cancelBtn.addEventListener("click", () => finish(null));

    const applyBtn = h(
      "button",
      { class: "btn", type: "button", id: "fd-apply" },
      "Move",
    );
    applyBtn.addEventListener("click", () => {
      const val = selectEl.value;
      if (!val) {
        errorMsg.textContent = "Please select a folder or create a new one.";
        errorMsg.hidden = false;
        return;
      }
      if (val === "__clear__") {
        finish("");
        return;
      }
      if (val === "__new__") {
        const name = newFolderInput.value.trim();
        if (!name) {
          errorMsg.textContent = "Please type a name for the new folder.";
          errorMsg.hidden = false;
          newFolderInput.focus();
          return;
        }
        finish(name);
        return;
      }
      finish(val);
    });

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });

    dialog.append(
      h("h2", {}, "Move to folder"),
      h(
        "p",
        {},
        `Move ${count} question${
          count === 1 ? "" : "s"
        } into a folder to keep your question bank organized.`,
      ),
      h(
        "div",
        {
          class: "stack",
          style: "display: grid; gap: 10px; margin-bottom: 18px;",
        },
        selectEl,
        newFolderInput,
        errorMsg,
      ),
      h("div", { class: "dialog-actions" }, cancelBtn, applyBtn),
    );

    document.body.append(dialog);
    dialog.showModal();
    selectEl.focus();
  });
}
