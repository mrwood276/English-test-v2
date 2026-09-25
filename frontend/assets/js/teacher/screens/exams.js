import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast, confirmDialog } from "../../shared/ui.js";
import { exams } from "../api/exams.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

const STATUS_LABEL = { draft: "Draft", open: "Open", closed: "Closed" };
const STATUS_PILL = { draft: "plain", open: "ok", closed: "warn" };

function fmtWhen(exam) {
  if (exam.availability_mode !== "scheduled" || !exam.starts_at) return "Open and closed by hand";
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `Scheduled · ${fmt(exam.starts_at)} → ${fmt(exam.ends_at)}`;
}

/** Exams: list with filters, status, code, and the open/close/duplicate actions. */
export function renderExams(container, ctx) {
  // Deleting an exam that has attempts destroys their answers, grades and results, so only the admin
  // may do it; a teacher can still close such an exam (BR-10 / DEC-012, ISSUE-023).
  const isAdmin = Boolean(ctx && ctx.user && ctx.user.role === "admin");
  const state = { filters: { q: "", status: "", sort: "newest", template_only: false }, items: [], requestId: 0, loaded: false };

  const search = h("input", { class: "input", type: "search", id: "ex-search", placeholder: "Search exams", autocomplete: "off", "aria-label": "Search exams" });
  const statusSelect = h(
    "select", { class: "chip-select", id: "ex-status", "aria-label": "Status" },
    [["", "All statuses"], ["draft", "Drafts"], ["open", "Open"], ["closed", "Closed"]].map(([v, t]) => h("option", { value: v }, t)),
  );
  const sortSelect = h(
    "select", { class: "chip-select", id: "ex-sort", "aria-label": "Sort" },
    [["newest", "Newest first"], ["oldest", "Oldest first"], ["status", "By status"], ["title", "A to Z"]].map(([v, t]) => h("option", { value: v }, t)),
  );
  const templateBox = h("input", { type: "checkbox", id: "ex-templates" });

  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const table = h(
    "table", { class: "qtable" },
    h("thead", {}, h("tr", {}, h("th", {}, "Exam"), h("th", { class: "col-code" }, "Code"), h("th", { class: "col-status" }, "Status"), h("th", { class: "col-count" }, "Questions"), h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
    tbody,
  );
  const status = h("div", { class: "list-status", role: "status" });

  const newButton = h("a", { class: "btn", href: "#/exams/new" }, icon("plus"), "New exam");

  mount(
    container,
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Exams"), countText), h("div", { class: "head-actions" }, newButton)),
    h(
      "div", { class: "toolbar" },
      h("label", { class: "search", for: "ex-search" }, icon("search"), search),
      statusSelect, sortSelect,
      h("label", { class: "check", for: "ex-templates" }, templateBox, "Templates only"),
    ),
    h("div", { class: "qb-layout exams-layout" }, h("div", { class: "card list-card" }, table, status)),
  );

  function examRow(exam) {
    const attempts = Number(exam.session_count) || 0;
    const attemptText = `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
    const pill = h("span", { class: `pill ${STATUS_PILL[exam.status] ?? "plain"}` }, STATUS_LABEL[exam.status] ?? exam.status);
    const openClose = h(
      "button",
      { class: "btn small ghost", type: "button" },
      exam.status === "open" ? "Close" : "Open",
    );
    openClose.addEventListener("click", async () => {
      const closing = exam.status === "open";
      if (closing) {
        const ok = await confirmDialog({ title: "Close this exam?", message: `Students can no longer join “${exam.title}”. Sessions in progress keep their time.`, confirmLabel: "Close exam", danger: false });
        if (!ok) return;
      }
      try {
        await exams.setStatus(exam.id, closing ? "closed" : "open");
        toast(closing ? "Exam closed." : "Exam is open. Students can join with the code.");
        load();
      } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
    });

    const duplicateBtn = h("button", { class: "btn small ghost", type: "button" }, "Duplicate");
    duplicateBtn.addEventListener("click", async () => {
      try {
        const id = await exams.duplicate(exam.id);
        toast("Copy created as a draft.");
        location.hash = `#/exams/edit/${id}`;
      } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
    });

    // An exam with attempts cannot be deleted by a teacher - the screen says so instead of offering a
    // Delete button that only closes the exam (which is what made the owner click five times).
    const kept = attempts > 0 && !isAdmin
      ? h("span", { class: "hint kept", "data-attempts": attempts, title: `Attempts and their results are never deleted. Close the exam instead.` }, `${attemptText} — kept for the results`)
      : null;

    const removeBtn = attempts > 0 && !isAdmin ? null : h("button", { class: "btn small danger", type: "button", "aria-label": `Delete ${exam.title}` }, "Delete");
    if (removeBtn) removeBtn.addEventListener("click", async () => {
      const permanent = attempts > 0; // only reachable as an admin: the attempt count decides the wording
      const ok = await confirmDialog({
        title: permanent ? "Delete this exam and its attempts?" : "Delete this exam?",
        message: permanent
          ? `“${exam.title}” has ${attemptText}. Deleting it also deletes their answers, grades and results. This cannot be undone.`
          : (exam.question_count > 0 ? `“${exam.title}” will be removed. The questions themselves stay in the bank.` : `“${exam.title}” will be removed.`),
        confirmLabel: permanent ? "Delete permanently" : "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        const result = await exams.remove(exam.id, permanent);
        toast(permanent
          ? `“${exam.title}” and ${attemptText} were deleted.`
          : (result === "closed" ? "This exam already has sessions, so it was closed instead of deleted." : "Exam deleted."));
        load();
      } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
    });

    return h(
      "tr", { "data-id": exam.id },
      h(
        "td", {},
        h("a", { class: "row-title", href: `#/exams/edit/${exam.id}` }, exam.title),
        h("div", { class: "row-sub" }, `${exam.duration_minutes} min · passing ${Number(exam.passing_grade) || 0}`, exam.is_template ? " · template" : "", attempts > 0 ? ` · ${attemptText}` : "", h("div", { class: "row-when" }, fmtWhen(exam))),
      ),
      h("td", { class: "col-code" }, h("code", { class: "exam-code" }, exam.access_code)),
      h("td", { class: "col-status" }, pill),
      h("td", { class: "col-count" }, `${exam.question_count} · ${exam.total_points} pts`),
      h("td", { class: "col-actions" }, h("div", { class: "row gap" }, openClose, duplicateBtn, removeBtn, kept)),
    );
  }

  function renderList() {
    countText.textContent = state.items.length === 1 ? "1 exam" : `${state.items.length} exams`;
    tbody.replaceChildren(...state.items.map(examRow));
    if (state.items.length === 0) {
      const filtered = Object.keys(state.filters).some((k) => k !== "sort" && state.filters[k]);
      status.replaceChildren(h("p", { class: "sub" }, filtered ? "No exams match these filters." : "No exams yet. Create the first one."));
    } else {
      status.replaceChildren();
    }
  }

  async function load() {
    const id = ++state.requestId;
    status.className = "list-status";
    try {
      const filters = { ...Object.fromEntries(Object.entries(state.filters).filter(([, v]) => v !== "" && v !== false)) };
      const items = await exams.list(filters);
      if (id !== state.requestId) return;
      state.items = items;
      state.loaded = true;
      renderList();
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  search.addEventListener("input", debounce(() => { state.filters.q = search.value; load(); }, 250));
  statusSelect.addEventListener("change", () => { state.filters.status = statusSelect.value; load(); });
  sortSelect.addEventListener("change", () => { state.filters.sort = sortSelect.value; load(); });
  templateBox.addEventListener("change", () => { state.filters.template_only = templateBox.checked; load(); });

  load();
}
