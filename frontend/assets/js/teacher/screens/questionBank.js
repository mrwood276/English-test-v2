import { h, mount } from "../../shared/dom.js";
import { plainText } from "../../shared/rich.js";
import { icon } from "../../shared/icons.js";
import { debounce, toast, confirmDialog } from "../../shared/ui.js";
import { questionBank } from "../api/questionBank.js";
import { exams } from "../api/exams.js";
import { attachMediaUrls } from "../api/media.js";
import { questionView, TYPE_LABEL, DIFFICULTY_LABEL, usedText } from "../components/questionView.js";
import { duplicateGroupsDialog } from "../components/duplicateGroupsDialog.js";
import { bulkEditDialog } from "../components/bulkEditDialog.js";
import { examQuestionsDialog, examQuestionsResult } from "../components/examQuestionsDialog.js";
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
    // The questions ticked for a bulk change. Deliberately kept across pages and filter changes: the ids
    // are explicit, so the teacher can see the count and nothing invisible changes by surprise. The one
    // exception is the archived switch, which flips what the bar's Archive/Restore button would mean.
    selected: new Set(),
    requestId: 0,
  };
  let topicNames = [];

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

  // ---------- selection and the bulk action bar ----------
  const headPick = h("input", { type: "checkbox", class: "pick", id: "qb-pick-all", "aria-label": "Select every question on this page" });
  const bulkCount = h("span", { class: "bulk-count", role: "status" });
  const bulkOff = h("span", { class: "hint" });
  const bulkNote = h("span", { class: "hint bulk-note", role: "status" });
  const bulkActions = h("div", { class: "bulk-actions" });
  const bulkAll = h("div", { class: "bulk-all" });
  const bulkbar = h(
    "div",
    { class: "bulkbar", role: "region", "aria-label": "Bulk actions", hidden: true },
    h("div", { class: "bulk-summary" }, bulkCount, bulkOff, bulkNote),
    bulkActions,
    bulkAll,
  );
  headPick.addEventListener("change", () => setPageSelected(headPick.checked));

  const table = h("table", { class: "qtable" }, h("thead", {}, h("tr", {}, h("th", { class: "col-pick" }, headPick), h("th", {}, "Question"), h("th", { class: "col-class" }, "Class"), h("th", { class: "col-diff" }, "Difficulty"), h("th", { class: "col-media" }, "Media"), h("th", { class: "col-used" }, "Used"))), tbody);
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
    bulkbar,
    h("div", { class: "qb-layout" }, h("div", { class: "card list-card" }, table, status, pager), preview),
  );

  // ---------- loading the list ----------
  /**
   * Placeholders while the first page loads, so an empty table is never
   * mistaken for "no questions". Replaced by the real rows (or the error
   * state) the moment the answer arrives. Later pages keep the old rows.
   */
  function paintSkeleton() {
    const bar = (width) => h("span", { class: "skel", style: `width:${width}` });
    tbody.replaceChildren(...Array.from({ length: 6 }, () =>
      h("tr", { class: "skel-row", "aria-hidden": "true" },
        h("td", { class: "col-pick" }, bar("16px")),
        h("td", {}, bar("72%"), bar("42%")),
        h("td", { class: "col-class" }, bar("55%")),
        h("td", { class: "col-diff" }, bar("45%")),
        h("td", { class: "col-media" }),
        h("td", { class: "col-used" }, bar("55%")),
      )));
  }

  async function load() {
    const id = ++state.requestId; // an older answer must never replace a newer one
    status.className = "list-status";
    status.replaceChildren(h("span", {}, "Loading…"));
    if (state.items.length === 0) paintSkeleton();
    try {
      const res = await questionBank.list(filtersFor(state.page, PAGE_SIZE));
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
    updateSelection();
  }

  function row(q) {
    const link = h("button", { class: "qlink", type: "button", "aria-pressed": String(q.id === state.selectedId) }, plainText(q.body, 150));
    link.addEventListener("click", () => select_(q.id));
    const pick = h("input", { type: "checkbox", class: "pick", checked: state.selected.has(q.id), "aria-label": `Select: ${plainText(q.body, 60)}` });
    pick.addEventListener("change", () => {
      if (pick.checked) state.selected.add(q.id);
      else state.selected.delete(q.id);
      pick.closest("tr").classList.toggle("picked", pick.checked);
      updateSelection();
    });
    const media = h("td", { class: "col-media" }, q.has_audio ? icon("audio", "Has audio") : null, q.has_image ? icon("image", "Has image") : null);
    return h(
      "tr",
      { class: [q.id === state.selectedId ? "sel" : "", state.selected.has(q.id) ? "picked" : ""].filter(Boolean).join(" "), "data-id": q.id },
      h("td", { class: "col-pick" }, pick),
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
  // The archived switch is the one filter that changes what the bar's Archive/Restore button would do, so
  // it clears the selection instead of leaving a tick that could mean the opposite action a moment later.
  archivedBox.addEventListener("change", () => { closePreview(); clearSelection(); setFilter("archived", archivedBox.checked); });

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

  // ---------- bulk actions ----------
  const SELECT_PAGE = 100; // the list API's own page-size cap
  const BULK_MAX = 500; // the most questions one change may touch; the Edge layer and the database enforce it too

  /** The filters exactly as the list API wants them, so the list, the pager and "select all" cannot drift. */
  function filtersFor(page, pageSize) {
    const out = { page, page_size: pageSize };
    for (const [key, value] of Object.entries(state.filters)) if (value !== "" && value !== false) out[key] = value;
    return out;
  }

  function setPageSelected(on) {
    for (const q of state.items) {
      if (on) state.selected.add(q.id);
      else state.selected.delete(q.id);
    }
    syncRows();
  }

  /** Matches the rows to the selection without rebuilding the table, so focus and scroll are not lost. */
  function syncRows() {
    for (const tr of tbody.children) {
      const picked = state.selected.has(tr.dataset.id);
      const box = tr.querySelector(".pick");
      if (box) box.checked = picked;
      tr.classList.toggle("picked", picked);
    }
    updateSelection();
  }

  function clearSelection() {
    if (state.selected.size === 0) return;
    state.selected.clear();
    bulkNote.textContent = "";
    syncRows();
  }

  /** Keeps the header checkbox, the counter, the bar, its buttons and the "select all" offer in step. */
  function updateSelection() {
    const pageIds = state.items.map((q) => q.id);
    const onPage = pageIds.filter((id) => state.selected.has(id)).length;
    const n = state.selected.size;

    headPick.checked = pageIds.length > 0 && onPage === pageIds.length;
    headPick.indeterminate = onPage > 0 && onPage < pageIds.length; // half the page ticked
    headPick.disabled = pageIds.length === 0;

    bulkbar.hidden = n === 0;
    bulkActions.replaceChildren();
    bulkAll.replaceChildren();
    bulkAll.hidden = true;
    if (n === 0) {
      bulkCount.textContent = "";
      bulkOff.textContent = "";
      return;
    }

    bulkCount.textContent = `${n} question${n === 1 ? "" : "s"} selected`;
    const offPage = n - onPage;
    bulkOff.textContent = offPage > 0 ? `· ${offPage} not on this page` : "";

    const edit = h("button", { class: "btn small", type: "button" }, "Edit…");
    edit.addEventListener("click", openBulkEdit);
    const toggle = h("button", { class: "btn small ghost", type: "button" }, state.filters.archived ? "Restore" : "Archive");
    toggle.addEventListener("click", () => bulkSetArchived(!state.filters.archived));
    const toExam = h("button", { class: "btn small ghost", type: "button" }, "Add to exam…");
    toExam.addEventListener("click", () => openExamQuestions("add"));
    const offExam = h("button", { class: "btn small ghost", type: "button" }, "Remove from exam…");
    offExam.addEventListener("click", () => openExamQuestions("remove"));
    const clear = h("button", { class: "btn small ghost", type: "button" }, "Clear");
    clear.addEventListener("click", clearSelection);
    bulkActions.append(edit, toExam, offExam, toggle, clear);

    if (pageIds.length > 0 && onPage === pageIds.length && n < state.total) {
      const all = h("button", { class: "link-btn", type: "button" }, `Select all ${state.total} matching questions`);
      all.addEventListener("click", selectAllMatching);
      bulkAll.append(h("span", {}, `All ${pageIds.length} question${pageIds.length === 1 ? "" : "s"} on this page are selected. `), all);
      bulkAll.hidden = false;
    }
  }

  /**
   * "All N matching questions": the ids of the whole filter result, not just the page on screen. The list API
   * caps a page at 100, so this walks the pages the way the pager does. When the filter matches more than one
   * change may touch it says so instead of quietly selecting the first 500 — a partial bulk change nobody
   * asked for is worse than being told to narrow the filter.
   */
  async function selectAllMatching() {
    const total = state.total;
    if (total > BULK_MAX) {
      bulkNote.textContent = `These filters match ${total} questions; a bulk change works on up to ${BULK_MAX} at a time. Narrow the filters, or tick the ones you want.`;
      return;
    }
    bulkNote.textContent = "Selecting…";
    try {
      const ids = [];
      const pages = Math.max(1, Math.ceil(total / SELECT_PAGE));
      for (let page = 1; page <= pages; page++) {
        const res = await questionBank.list(filtersFor(page, SELECT_PAGE));
        for (const item of res.items) ids.push(item.id);
        if (res.items.length < SELECT_PAGE) break;
      }
      for (const id of ids) state.selected.add(id);
      bulkNote.textContent = "";
      syncRows();
    } catch (err) {
      bulkNote.textContent = ignorable(err) ? "" : errorText(err);
    }
  }

  /** What the server reported, said plainly — never "success" when part of it did not happen. */
  function resultText(res) {
    const updated = res.updated || 0;
    const unchanged = res.unchanged || 0;
    const missing = res.missing || 0;
    if (updated === 0 && missing === 0) return "Nothing changed — those questions already looked like that.";
    const parts = [`${updated} question${updated === 1 ? "" : "s"} updated`];
    if (unchanged > 0) parts.push(`${unchanged} already looked like that`);
    if (missing > 0) parts.push(`${missing} ${missing === 1 ? "is" : "are"} no longer there`);
    return `${parts.join(" · ")}.`;
  }

  /** The one place a bulk change is sent and reported; a failure travels on, to be shown where the form is. */
  async function runBulk(ids, changes) {
    const res = await questionBank.bulkUpdate(ids, changes);
    toast(resultText(res));
    return res;
  }

  async function bulkSetArchived(archived) {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    const noun = ids.length === 1 ? "question" : "questions";
    const ok = await confirmDialog({
      title: archived ? `Archive ${ids.length} ${noun}?` : `Restore ${ids.length} ${noun}?`,
      message: archived
        ? "They stay in the question bank and old results keep working, but they are hidden from the list and cannot be used in a new exam. You can restore them later."
        : "They come back into the question bank and can be used in exams again.",
      confirmLabel: archived ? "Archive" : "Restore",
    });
    if (!ok) return;
    bulkNote.textContent = "Saving…";
    try {
      await runBulk(ids, { archived });
      clearSelection();
      await load();
      loadDuplicates();
    } catch (err) {
      if (ignorable(err)) return;
      bulkNote.textContent = errorText(err);
      toast(errorText(err), "error");
    }
  }

  /**
   * "Add to exam…" / "Remove from exam…": the ticked questions and one exam, in one act. The exam list is
   * only fetched when one of these buttons is used (the bulk bar is not the place to load every exam), and
   * the dialog refuses an exam that cannot take the change before the request is even sent.
   */
  async function openExamQuestions(mode) {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    bulkNote.textContent = "Loading exams…";
    let examList;
    try {
      examList = await exams.list({});
    } catch (err) {
      bulkNote.textContent = "";
      if (ignorable(err)) return;
      bulkNote.textContent = errorText(err);
      toast(errorText(err), "error");
      return;
    }
    bulkNote.textContent = "";
    const applied = await examQuestionsDialog({
      mode,
      count: ids.length,
      exams: examList,
      // A failure travels on, so the dialog shows it where the choice is instead of the toast
      // disappearing before it can be read.
      onApply: async (examId) => { toast(examQuestionsResult(mode, await exams.bulkQuestions(examId, mode, ids))); },
    });
    if (!applied) return; // closed without applying: the ticks are still there
    clearSelection();
    load(); // the Used column changes either way
  }

  function openBulkEdit() {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    bulkNote.textContent = "";
    bulkEditDialog({
      count: ids.length,
      topics: topicNames,
      suggestLabels: (prefix) => questionBank.classLabels(prefix),
      onApply: (changes) => runBulk(ids, changes),
    }).then((applied) => {
      if (!applied) return; // closed without applying: the form is gone, the ticks are still there
      clearSelection();
      load();
    });
  }

  // ---------- start ----------
  load();
  loadDuplicates();
  questionBank.topics().then((topics) => {
    topicNames = topics.map((t) => t.name);
    for (const t of topics) topicSelect.append(h("option", { value: t.name }, `${t.name} (${t.question_count})`));
  }).catch(() => { /* the filters still work without the suggestions */ });
  questionBank.classLabels().then((labels) => {
    for (const l of labels) classSelect.append(h("option", { value: l.label }, l.label));
  }).catch(() => {});
}
