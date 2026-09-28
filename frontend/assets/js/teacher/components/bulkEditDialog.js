import { h } from "../../shared/dom.js";
import { DIFFICULTY_LABEL } from "./questionView.js";
import { chipsInput } from "./chipsInput.js";

/**
 * Change many questions at once, in two steps: choose what to change, then look at exactly what will
 * happen before it happens. Every field starts on "keep as it is", and a field left alone is not sent at
 * all — so "keep" is never something the database has to interpret.
 *
 * The preview names the questions it will touch ("42 questions will be affected") because the whole point
 * of the step is to stop a teacher changing forty questions by accident. It cannot show what each question
 * holds today (the list only sends the questions on screen), so a line reads "Topic → Tenses" rather than
 * "Grammar → Tenses": it says what will change, not what it was.
 *
 * `onApply(changes)` is the caller's job (it owns the API call and the refresh); it is awaited, and a
 * failure is shown inside the dialog so the teacher can fix it and try again rather than losing the form.
 * Resolves `true` when the change was applied, `false` when the dialog was closed without applying.
 */
const KEEP = "";
const NEW_TOPIC = "__new";
const CLEAR_TOPIC = "__clear";
const LABEL_MODES = [
  ["add", "Add these class labels"],
  ["remove", "Remove these class labels"],
  ["replace", "Replace all class labels with these"],
];

export function bulkEditDialog({ count, topics = [], suggestLabels, onApply }) {
  const noun = count === 1 ? "question" : "questions";
  return new Promise((resolve) => {
    const problems = h("div", { class: "notice error", role: "alert", hidden: true });
    const show = (messages) => {
      problems.replaceChildren(...(messages.length > 1 ? [h("ul", {}, messages.map((m) => h("li", {}, m)))] : [messages[0]]));
      problems.hidden = false;
      problems.scrollIntoView({ block: "nearest" });
    };
    const hide = () => { problems.hidden = true; problems.replaceChildren(); };

    // ---------- what to change ----------
    const topicSelect = h("select", { class: "inp", id: "bulk-topic" }, [
      h("option", { value: KEEP }, "Keep the topic as it is"),
      h("option", { value: CLEAR_TOPIC }, "Remove the topic"),
      ...topics.map((name) => h("option", { value: name }, name)),
      h("option", { value: NEW_TOPIC }, "A new topic…"),
    ]);
    const topicNew = h("input", { class: "inp", id: "bulk-topic-new", type: "text", maxlength: "120", autocomplete: "off", placeholder: "New topic name", hidden: true });
    topicSelect.addEventListener("change", () => { topicNew.hidden = topicSelect.value !== NEW_TOPIC; if (!topicNew.hidden) topicNew.focus(); });

    const difficultySelect = h("select", { class: "inp", id: "bulk-difficulty" }, [
      h("option", { value: KEEP }, "Keep the difficulty as it is"),
      ...Object.entries(DIFFICULTY_LABEL).map(([value, text]) => h("option", { value }, text)),
    ]);

    const weightInput = h("input", { class: "inp", id: "bulk-weight", type: "number", min: "0.01", max: "100", step: "0.5", inputmode: "decimal", placeholder: "Keep each question's own points" });

    const labelsMode = h("select", { class: "inp", id: "bulk-labels-mode" }, [
      h("option", { value: KEEP }, "Keep the class labels as they are"),
      ...LABEL_MODES.map(([value, text]) => h("option", { value }, text)),
    ]);
    const labels = chipsInput({
      id: "bulk-labels", label: "Class label", placeholder: "Type a class, then press Enter",
      suggest: suggestLabels, onChange: () => hide(),
    });
    const labelsBox = h("div", { hidden: true }, labels.el);
    labelsMode.addEventListener("change", () => { labelsBox.hidden = labelsMode.value === KEEP; if (!labelsBox.hidden) labels.input.focus(); });

    const field = (label, forId, control, extra) => h(
      "div", { class: "field" },
      h("label", { class: "lbl", for: forId }, label),
      control,
      extra,
    );

    const editStep = h(
      "div", { class: "bulk-step" },
      h("p", { class: "hint" }, `Everything starts on "keep as it is": leave a field alone and ${noun === "question" ? "it keeps" : "they keep"} what it has.`),
      h("div", { class: "bulk-grid" },
        field("Topic", "bulk-topic", topicSelect, topicNew),
        field("Difficulty", "bulk-difficulty", difficultySelect),
        field("Points", "bulk-weight", weightInput),
        field("Class labels", "bulk-labels-mode", labelsMode, labelsBox)),
    );

    // ---------- what will happen ----------
    const previewStep = h("div", { class: "bulk-step", hidden: true });

    // ---------- actions ----------
    const cancelBtn = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    const previewBtn = h("button", { class: "btn", type: "button" }, "Preview changes");
    const backBtn = h("button", { class: "btn ghost", type: "button" }, "Back");
    const applyBtn = h("button", { class: "btn", type: "button" }, "Apply changes");
    const actions = h("div", { class: "dialog-actions" });

    /** Reads the form into the shape the API wants, collecting anything the person has to fix. */
    function collect() {
      const found = [];
      const changes = {};

      if (topicSelect.value === CLEAR_TOPIC) changes.topic = "";
      else if (topicSelect.value === NEW_TOPIC) {
        const name = topicNew.value.trim();
        if (name) changes.topic = name;
        else found.push("Type the name of the new topic, or choose an existing one.");
      } else if (topicSelect.value !== KEEP) changes.topic = topicSelect.value;

      if (difficultySelect.value !== KEEP) changes.difficulty = difficultySelect.value;

      const points = weightInput.value.trim();
      if (points !== "") {
        const n = Number(points);
        if (!Number.isFinite(n) || n < 0.01 || n > 100) found.push("Points must be more than 0 and at most 100.");
        else changes.weight = n;
      }

      if (labelsMode.value !== KEEP) {
        const list = labels.values;
        if (list.length === 0 && labelsMode.value !== "remove") found.push("Add at least one class label.");
        else if (list.length > 0 || labelsMode.value === "remove") changes.class_labels = { mode: labelsMode.value, labels: list };
      }

      if (Object.keys(changes).length === 0 && found.length === 0) found.push("Choose at least one thing to change.");
      return { changes, found };
    }

    function describe(changes) {
      const rows = [];
      rows.push(["Topic", changes.topic === undefined ? "Keep as it is" : changes.topic === "" ? "Remove the topic" : `Change to "${changes.topic}"`]);
      rows.push(["Difficulty", changes.difficulty === undefined ? "Keep as it is" : DIFFICULTY_LABEL[changes.difficulty] || changes.difficulty]);
      rows.push(["Class labels", changes.class_labels === undefined ? "Keep as they are"
        : changes.class_labels.mode === "add" ? `Add ${changes.class_labels.labels.join(", ")}`
        : changes.class_labels.mode === "remove" ? `Remove ${changes.class_labels.labels.join(", ")}`
        : `Replace with ${changes.class_labels.labels.join(", ") || "none"}`]);
      rows.push(["Points", changes.weight === undefined ? "Keep each question's own points" : String(changes.weight)]);
      return rows;
    }

    /** Which of the two steps is on screen, and the buttons that belong to it. */
    function showStep(name) {
      editStep.hidden = name !== "edit";
      previewStep.hidden = name !== "preview";
      actions.replaceChildren(...(name === "preview" ? [backBtn, cancelBtn, applyBtn] : [cancelBtn, previewBtn]));
    }

    previewBtn.addEventListener("click", () => {
      hide();
      const { changes, found } = collect();
      if (found.length) return show(found);
      previewStep.replaceChildren(
        h("p", { class: "hint" }, `You selected ${count} ${noun}.`),
        h("dl", { class: "bulk-lines" }, ...describe(changes).flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, text)])),
        h("p", { class: "bulk-total" }, `${count} ${noun} will be affected.`),
      );
      showStep("preview");
      applyBtn.focus();
    });

    backBtn.addEventListener("click", () => { hide(); showStep("edit"); previewBtn.focus(); });
    cancelBtn.addEventListener("click", () => dialog.close());

    applyBtn.addEventListener("click", async () => {
      hide();
      const { changes, found } = collect();
      if (found.length) { showStep("edit"); return show(found); }
      [applyBtn, backBtn, cancelBtn, previewBtn].forEach((b) => (b.disabled = true));
      applyBtn.textContent = "Applying…";
      try {
        await onApply(changes);
        resolve(true);
        dialog.close();
      } catch (err) {
        show([err && err.message ? err.message : "Could not change those questions. Please try again."]);
        [applyBtn, backBtn, cancelBtn, previewBtn].forEach((b) => (b.disabled = false));
        applyBtn.textContent = "Apply changes";
      }
    });

    const dialog = h(
      "dialog",
      { class: "dialog bulk-dialog", "aria-labelledby": "bulk-dialog-title" },
      h("h2", { id: "bulk-dialog-title" }, `Edit ${count} ${noun}`),
      problems,
      editStep,
      previewStep,
      actions,
    );

    dialog.addEventListener("close", () => { dialog.remove(); resolve(false); });
    document.body.append(dialog);
    showStep("edit");
    dialog.showModal();
    topicSelect.focus();
  });
}
