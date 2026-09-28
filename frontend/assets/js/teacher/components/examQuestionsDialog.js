import { h } from "../../shared/dom.js";

/**
 * Put the ticked questions on one exam, or take them off it — the question bank's bulk actions and the exam
 * editor's picker both end here, so the two surfaces cannot drift apart in wording or in what they promise.
 *
 * Two steps, the same shape as `bulkEditDialog`: choose (only when the caller has not already fixed the
 * exam) and then look at exactly what will happen before it happens. A failure is shown inside the dialog,
 * so the choice is not lost, and the dialog stays open with its buttons usable again.
 *
 * `onApply(examId)` is the caller's job — it owns the API call (the bank screen) or the local list change
 * (the editor) and the refresh. `notes` are extra lines the caller already knows (for instance how many of
 * the ticked questions are on the exam already); the dialog does not invent any of its own.
 *
 * Resolves `true` when the change was applied, `false` when the dialog was closed without applying.
 */

const MODE = {
  add: {
    title: (n) => `Add ${n} ${n === 1 ? "question" : "questions"} to an exam`,
    button: "Add to exam",
    line: "Add them to the exam",
    total: (n, title) => `${n} ${n === 1 ? "question" : "questions"} will be added to “${title}”.`,
  },
  remove: {
    title: (n) => `Remove ${n} ${n === 1 ? "question" : "questions"} from an exam`,
    button: "Remove from exam",
    line: "Take them off the exam",
    total: (n, title) => `${n} ${n === 1 ? "question" : "questions"} will be taken off “${title}”.`,
  },
};

/** Why an exam cannot take a change right now — the same refusals the database makes, said in the picker. */
export function examBlocker(exam) {
  if (!exam) return "That exam no longer exists.";
  if (exam.selection_mode && exam.selection_mode !== "manual") return "draws its questions by a filter";
  if (exam.status === "open") return "running right now";
  if (Number(exam.session_count) > 0) return "already has attempts";
  return null;
}

export function examQuestionsDialog({ mode, count, exam = null, exams = [], notes = [], onApply }) {
  const words = MODE[mode];
  const noun = count === 1 ? "question" : "questions";
  return new Promise((resolve) => {
    let chosen = exam;

    const problems = h("div", { class: "notice error", role: "alert", hidden: true });
    const show = (messages) => {
      problems.replaceChildren(...messages.map((m) => h("p", {}, m)));
      problems.hidden = false;
      problems.scrollIntoView({ block: "nearest" });
    };
    const hide = () => { problems.hidden = true; problems.replaceChildren(); };

    // ---------- step 1: which exam (skipped when the caller already knows) ----------
    const picker = h("select", { class: "inp", id: "exq-exam" });
    const pickerNote = h("p", { class: "hint" }, "");
    let usable = 0;

    for (const item of exams) {
      const blocker = examBlocker(item);
      if (blocker) continue;
      usable += 1;
      picker.append(h("option", { value: item.id }, `${item.title} — ${item.question_count} ${Number(item.question_count) === 1 ? "question" : "questions"}`));
    }
    if (usable === 0) {
      const first = exams.find(Boolean);
      picker.append(h("option", { value: "" }, exams.length === 0 ? "No exams yet" : "No exam can take questions right now"));
      pickerNote.textContent = first
        ? "A draft exam that nobody has attempted is the only one whose questions can change. Duplicate an exam to make a new draft."
        : "Create a draft exam first.";
      pickerNote.hidden = false;
    } else {
      pickerNote.textContent = "Questions can be added or removed on a draft exam that nobody has attempted yet.";
    }

    const chooseStep = h(
      "div", { class: "bulk-step" },
      h("p", { class: "hint" }, `You selected ${count} ${noun}. Which exam?`),
      h("div", { class: "field" }, h("label", { class: "lbl", for: "exq-exam" }, "Exam"), picker),
      pickerNote,
    );

    // ---------- step 2: what will happen ----------
    const previewStep = h("div", { class: "bulk-step", hidden: true });

    function describe(target) {
      const title = target && target.title ? target.title : "the exam";
      const rows = [["Exam", `“${title}”`], ["Action", words.line]];
      if (mode === "add") rows.push(["Where", "At the end of the list, each with its own points"]);
      for (const note of notes) rows.push(["Note", note]);
      return rows;
    }

    function renderPreview() {
      const rows = describe(chosen);
      previewStep.replaceChildren(
        h("p", { class: "hint" }, `You selected ${count} ${noun}.`),
        h("dl", { class: "bulk-lines" }, ...rows.flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, text)])),
        h("p", { class: "bulk-total" }, words.total(count, chosen && chosen.title ? chosen.title : "the exam")),
      );
    }

    // ---------- actions ----------
    const cancelBtn = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    const previewBtn = h("button", { class: "btn", type: "button" }, "Preview");
    const backBtn = h("button", { class: "btn ghost", type: "button" }, "Back");
    const applyBtn = h("button", { class: "btn", type: "button" }, words.button);
    const actions = h("div", { class: "dialog-actions" });

    function showStep(name) {
      chooseStep.hidden = name !== "choose";
      previewStep.hidden = name !== "preview";
      actions.replaceChildren(...(name === "preview" ? [backBtn, cancelBtn, applyBtn] : [cancelBtn, previewBtn]));
    }

    previewBtn.addEventListener("click", () => {
      hide();
      if (!exam) {
        const picked = exams.find((item) => item.id === picker.value);
        if (!picked) return show(["There is no exam to change. Create a draft exam first."]);
        const blocker = examBlocker(picked);
        if (blocker) return show([`“${picked.title}” ${blocker}, so its questions cannot change.`]);
        chosen = picked;
      }
      renderPreview();
      showStep("preview");
      applyBtn.focus();
    });

    backBtn.addEventListener("click", () => { hide(); showStep("choose"); previewBtn.focus(); });
    cancelBtn.addEventListener("click", () => dialog.close());

    applyBtn.addEventListener("click", async () => {
      hide();
      [applyBtn, backBtn, cancelBtn, previewBtn].forEach((b) => (b.disabled = true));
      applyBtn.textContent = mode === "add" ? "Adding…" : "Removing…";
      try {
        await onApply(chosen.id);
        resolve(true);
        dialog.close();
      } catch (err) {
        show([err && err.message ? err.message : `Could not change the questions on that exam. Please try again.`]);
        [applyBtn, backBtn, cancelBtn, previewBtn].forEach((b) => (b.disabled = false));
        applyBtn.textContent = words.button;
      }
    });

    const dialog = h(
      "dialog",
      { class: "dialog bulk-dialog exam-questions-dialog", "aria-labelledby": "exq-title" },
      h("h2", { id: "exq-title" }, words.title(count)),
      problems,
      chooseStep,
      previewStep,
      actions,
    );

    dialog.addEventListener("close", () => { dialog.remove(); resolve(false); });
    document.body.append(dialog);
    if (exam) { renderPreview(); showStep("preview"); applyBtn.focus(); }
    else showStep("choose");
    dialog.showModal();
    if (!exam) picker.focus();
  });
}

/** The server's own counts, said plainly — never "success" when part of it did not happen. */
export function examQuestionsResult(mode, result = {}) {
  const updated = Number(result.updated) || 0;
  const unchanged = Number(result.unchanged) || 0;
  const missing = Number(result.missing) || 0;
  const verb = mode === "add" ? "added to" : "taken off";
  if (updated === 0 && missing === 0 && unchanged > 0) {
    return mode === "add"
      ? "Nothing to do — all of those questions are already on the exam."
      : "Nothing to do — none of those questions is on the exam.";
  }
  const parts = [`${updated} ${updated === 1 ? "question" : "questions"} ${verb} the exam`];
  if (unchanged > 0) parts.push(`${unchanged} ${unchanged === 1 ? "was" : "were"} already like that`);
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "is" : "are"} no longer there`);
  return `${parts.join(" · ")}.`;
}
