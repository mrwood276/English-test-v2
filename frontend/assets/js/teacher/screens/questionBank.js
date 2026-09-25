import { h, mount } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast, confirmDialog } from "../../shared/ui.js";
import { questionBank } from "../api/questionBank.js";
import { attachMediaUrls } from "../api/media.js";
import { questionView, TYPE_LABEL, DIFFICULTY_LABEL, usedText } from "../components/questionView.js";
import { duplicateGroupsDialog } from "../components/duplicateGroupsDialog.js";
import { SessionExpiredError } from "../../core/auth.js";

const PAGE_SIZE = 25;
const errorText = (err) => err.message || "Something went wrong. Please try again.";
// When the session ended, core/api.js already sent the person back to sign in; nothing more to show here.
const ignorable = (err) => err instanceof SessionExpiredError;

/** Question bank: list with filters, and a preview of the selected question as students will see it. */
export function renderQuestionBank(container) {
  const state = {
    filters: { q: "", topic: "", difficulty: "", type: "", class_label: "", used: "", sort: "newest", archived: false },
    page: 1,
    total: 0,
    items: [],
    selectedId: null,
    requestId: 0,
  };

  // ---------- filter controls ----------
  const search = h("input", { class: "input", type: "search", id: "qb-search", placeholder: "Search questions", autocomplete: "off", "aria-label": "Search questions" });
  const select = (id, label, options) =>
    h("select", { class: "chip-select", id, "aria-label": label }, options.map(([value, text]) => h("option", { value }, text)));
  const classSelect = select("qb-class", "Class label", [["", "All classes"]]);
  const topicSelect = select("qb-topic", "Topic", [["", "All topics"]]);
  const difficultySelect = select("qb-difficulty", "Difficulty", [["", "Any difficulty"], ["easy", "Easy"], ["medium", "Medium"], ["hots", "HOTS"]]);
  const typeSelect = select("qb-type", "Question type", [["", "All types"], ...Object.entries(TYPE_LABEL)]);
  const usedSelect = select("qb-used", "Use in exams", [["", "Used or not"], ["used", "Used in exams"], ["unused", "Not used yet"]]);
  const sortSelect = select("qb-sort", "Sort", [["newest", "Newest first"], ["oldest", "Oldest first"], ["difficulty", "Easy to HOTS"], ["body", "A to Z"]]);
  const archivedBox = h("input", { type: "checkbox", id: "qb-archived" });

  // ---------- list ----------
  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const table = h("table", { class: "qtable" }, h("thead", {}, h("tr", {}, h("th", {}, "Question"), h("th", { class: "col-class" }, "Class"), h("th", { class: "col-diff" }, "Difficulty"), h("th", { class: "col-media" }, "Media"), h("th", { class: "col-used" }, "Used"))), tbody);
  const status = h("div", { class: "list-status", role: "status" });
  const pager = h("div", { class: "pager" });
  const preview = h("aside", { class: "card preview", "aria-label": "Question preview", hidden: true });

  // ---------- the duplicate notice (mockup 6) ----------
  const banner = h("div", { class: "banner", role: "status", hidden: true });

  const addButton = h("a", { class: "btn", href: "#/questions/new" }, icon("plus"), "Add question");
  const importButton = h("a", { class: "btn ghost", href: "#/questions/import" }, "Import");

  mount(
    container,
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Question bank"), countText), h("div", { class: "head-actions" }, importButton, addButton)),
    h(
      "div",
      { class: "toolbar" },
      h("label", { class: "search", for: "qb-search" }, icon("search"), search),
      classSelect, topicSelect, difficultySelect, typeSelect, usedSelect, sortSelect,
      h("label", { class: "check", for: "qb-archived" }, archivedBox, "Show archived"),
    ),
    banner,
    h("div", { class: "qb-layout" }, h("div", { class: "card list-card" }, table, status, pager), preview),
  );

  // ---------- loading the list ----------
  async function load() {
    const id = ++state.requestId; // an older answer must never replace a newer one
    status.className = "list-status";
    status.replaceChildren(h("span", {}, "Loading…"));
    try {
      const filters = { page: state.page, page_size: PAGE_SIZE, ...Object.fromEntries(Object.entries(state.filters).filter(([, v]) => v !== "" && v !== false)) };
      if (state.filters.archived) filters.archived = true;
      const res = await questionBank.list(filters);
      if (id !== state.requestId) return;
      state.items = res.items;
      state.total = res.total;
      // The page shrank (for example after deleting the last question on it): go back one page.
      if (state.items.length === 0 && state.total > 0 && state.page > 1) {
        state.page = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
        return load();
      }
      renderList();
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      renderLoadError(err);
    }
  }

  function renderLoadError(err) {
    tbody.replaceChildren();
    pager.replaceChildren();
    const retry = h("button", { class: "btn small", type: "button" }, "Try again");
    retry.addEventListener("click", load);
    status.className = "list-status error";
    status.replaceChildren(h("span", {}, `Could not load questions. ${errorText(err)}`), retry);
  }

  function renderList() {
    const filtered = Object.entries(state.filters).some(([k, v]) => k !== "sort" && v !== "" && v !== false);
    const n = state.total;
    const noun = filtered ? (n === 1 ? "question matches" : "questions match") : n === 1 ? "question" : "questions";
    countText.textContent = `${n} ${noun}${state.filters.archived ? " (archived)" : ""}`;

    tbody.replaceChildren(...state.items.map(row));
    status.className = "list-status";
    if (state.items.length === 0) {
      const clear = filtered ? h("button", { class: "btn small ghost", type: "button" }, "Clear filters") : null;
      if (clear) clear.addEventListener("click", clearFilters);
      status.replaceChildren(h("span", {}, filtered ? "No questions match these filters." : state.filters.archived ? "No archived questions." : "No questions yet."), clear);
    } else {
      status.replaceChildren();
    }
    renderPager();
  }

  function row(q) {
    const link = h("button", { class: "qlink", type: "button", "aria-pressed": String(q.id === state.selectedId) }, plainText(q.body, 150));
    link.addEventListener("click", () => select_(q.id));
    const media = h("td", { class: "col-media" }, q.has_audio ? icon("audio", "Has audio") : null, q.has_image ? icon("image", "Has image") : null);
    return h(
      "tr",
      { class: q.id === state.selectedId ? "sel" : "", "data-id": q.id },
      h("td", { class: "qcell" }, link, h("small", {}, [TYPE_LABEL[q.type] || q.type, q.topic, q.has_passage ? "reading text" : null].filter(Boolean).join(", "))),
      h("td", { class: "col-class" }, q.class_labels.map((l) => h("span", { class: "tag" }, l))),
      h("td", { class: "col-diff" }, DIFFICULTY_LABEL[q.difficulty] || q.difficulty),
      media,
      h("td", { class: "col-used" }, usedText(q.used_in_exams)),
    );
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.total === 0) return pager.replaceChildren();
    const from = (state.page - 1) * PAGE_SIZE + 1;
    const to = Math.min(state.page * PAGE_SIZE, state.total);
    const prev = h("button", { class: "btn small ghost", type: "button", disabled: state.page <= 1, "aria-label": "Previous page" }, icon("left"), "Previous");
    const next = h("button", { class: "btn small ghost", type: "button", disabled: state.page >= pages, "aria-label": "Next page" }, "Next", icon("right"));
    prev.addEventListener("click", () => { state.page--; load(); });
    next.addEventListener("click", () => { state.page++; load(); });
    pager.replaceChildren(h("span", { class: "hint" }, `Showing ${from} to ${to} of ${state.total}`), h("span", { class: "pager-buttons" }, prev, next));
  }

  // ---------- the duplicate scan (one whole-bank lookup, not one per filter change) ----------
  async function loadDuplicates() {
    try {
      const groups = await questionBank.duplicateGroups();
      const count = groups.question_count || 0;
      if (count === 0) return hideBanner();
      const review = h("button", { class: "banner-action", type: "button" }, "Review");
      review.addEventListener("click", () => duplicateGroupsDialog(groups));
      banner.replaceChildren(
        h(
          "span",
          { class: "row" },
          icon("alert"),
          count === 1 ? "1 question looks like a duplicate of another." : `${count} questions look like duplicates of each other.`,
        ),
        review,
      );
      banner.hidden = false;
    } catch (err) {
      // The list matters more than the notice, so a scan that fails only hides the banner. The editor
      // still warns while a question is written, and check_duplicates still works.
      if (!ignorable(err)) console.warn("the duplicate scan failed", err);
      hideBanner();
    }
  }
  function hideBanner() {
    banner.hidden = true;
    banner.replaceChildren();
  }

  // ---------- filters ----------
  function setFilter(key, value) {
    state.filters[key] = value;
    state.page = 1;
    load();
  }
  const searchLater = debounce(() => setFilter("q", search.value.trim()), 300);
  search.addEventListener("input", searchLater);
  classSelect.addEventListener("change", () => setFilter("class_label", classSelect.value));
  topicSelect.addEventListener("change", () => setFilter("topic", topicSelect.value));
  difficultySelect.addEventListener("change", () => setFilter("difficulty", difficultySelect.value));
  typeSelect.addEventListener("change", () => setFilter("type", typeSelect.value));
  usedSelect.addEventListener("change", () => setFilter("used", usedSelect.value));
  sortSelect.addEventListener("change", () => setFilter("sort", sortSelect.value));
  archivedBox.addEventListener("change", () => { closePreview(); setFilter("archived", archivedBox.checked); });

  function clearFilters() {
    Object.assign(state.filters, { q: "", topic: "", difficulty: "", type: "", class_label: "", used: "" });
    search.value = ""; classSelect.value = ""; topicSelect.value = ""; difficultySelect.value = ""; typeSelect.value = ""; usedSelect.value = "";
    state.page = 1;
    load();
  }

  // ---------- preview ----------
  function select_(id) {
    state.selectedId = id;
    for (const tr of tbody.children) {
      const on = tr.dataset.id === id;
      tr.classList.toggle("sel", on);
      tr.querySelector(".qlink").setAttribute("aria-pressed", String(on));
    }
    loadPreview(id);
  }

  function closePreview() {
    state.selectedId = null;
    preview.hidden = true;
    preview.replaceChildren();
  }

  async function loadPreview(id) {
    preview.hidden = false;
    preview.replaceChildren(h("p", { class: "hint" }, "Loading…"));
    if (matchMedia("(max-width: 900px)").matches) preview.scrollIntoView({ block: "nearest" });
    try {
      const q = await questionBank.get(id).then(attachMediaUrls);
      if (state.selectedId !== id) return;
      renderPreview(q);
    } catch (err) {
      if (state.selectedId !== id || ignorable(err)) return;
      const retry = h("button", { class: "btn small", type: "button" }, "Try again");
      retry.addEventListener("click", () => loadPreview(id));
      preview.replaceChildren(h("div", { class: "notice error", role: "alert" }, errorText(err)), retry);
    }
  }

  function renderPreview(q) {
    const edit = h("a", { class: "btn small", href: `#/questions/edit/${q.id}` }, "Edit");
    const toggle = h("button", { class: "btn small ghost", type: "button" }, q.is_archived ? "Restore" : "Archive");
    const del = h("button", { class: "btn small danger", type: "button" }, "Delete");
    toggle.addEventListener("click", () => (q.is_archived ? restoreQuestion(q) : archiveQuestion(q)));
    del.addEventListener("click", () => deleteQuestion(q));
    preview.replaceChildren(...questionView(q), h("div", { class: "preview-actions" }, edit, toggle, del));
  }

  // ---------- actions ----------
  async function archiveQuestion(q) {
    try { await questionBank.archive(q.id); toast("Question archived. Show archived questions to restore it."); closePreview(); load(); loadDuplicates(); }
    catch (err) { if (!ignorable(err)) toast(errorText(err), "error"); }
  }
  async function restoreQuestion(q) {
    try { await questionBank.restore(q.id); toast("Question restored."); closePreview(); load(); loadDuplicates(); }
    catch (err) { if (!ignorable(err)) toast(errorText(err), "error"); }
  }
  async function deleteQuestion(q) {
    const used = q.used_in_exams > 0;
    const ok = await confirmDialog({
      title: used ? "Archive this question?" : "Delete this question?",
      message: used
        ? `This question is used in ${usedText(q.used_in_exams)}, so it will be archived instead of deleted. Old results stay correct, and you can restore it later.`
        : "This permanently deletes the question. This cannot be undone.",
      confirmLabel: used ? "Archive" : "Delete",
      danger: !used,
    });
    if (!ok) return;
    try {
      const result = await questionBank.remove(q.id);
      toast(result === "deleted" ? "Question deleted." : "Question archived because exams use it.");
      closePreview();
      load();
      loadDuplicates();
    } catch (err) { if (!ignorable(err)) toast(errorText(err), "error"); }
  }

  // ---------- start ----------
  load();
  loadDuplicates();
  questionBank.topics().then((topics) => {
    for (const t of topics) topicSelect.append(h("option", { value: t.name }, `${t.name} (${t.question_count})`));
  }).catch(() => { /* the filters still work without the suggestions */ });
  questionBank.classLabels().then((labels) => {
    for (const l of labels) classSelect.append(h("option", { value: l.label }, l.label));
  }).catch(() => {});
}
