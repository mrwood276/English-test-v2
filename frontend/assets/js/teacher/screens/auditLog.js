import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { debounce } from "../../shared/ui.js";
import { audit } from "../api/audit.js";
import { SessionExpiredError } from "../../core/auth.js";

const PAGE_SIZE = 25;
const errorText = (err) => err.message || "Something went wrong. Please try again.";
// When the session ended, core/api.js already sent the person back to sign in; nothing more to show here.
const ignorable = (err) => err instanceof SessionExpiredError;

// The clock column reads like the rest of the app (the same format as the exam screens).
const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Audit log (admin only): every recorded staff action, newest first, with the filters an investigation needs. */
export function renderAuditLog(container) {
  const state = { action: "", entityType: "", days: "", page: 1, total: 0, items: [], requestId: 0 };

  // ---------- filter controls ----------
  const actionSearch = h("input", { class: "input", type: "search", id: "al-action", placeholder: "Filter by action", autocomplete: "off", "aria-label": "Filter by action" });
  const entitySearch = h("input", { class: "input", type: "search", id: "al-entity", placeholder: "Filter by entity type", autocomplete: "off", "aria-label": "Filter by entity type" });
  const daysSelect = h("select", { class: "chip-select", id: "al-days", "aria-label": "Time window" },
    h("option", { value: "" }, "All time"),
    h("option", { value: "7" }, "Last 7 days"),
    h("option", { value: "30" }, "Last 30 days"),
    h("option", { value: "90" }, "Last 90 days"));
  const clearButton = h("button", { class: "btn small ghost", type: "button" }, "Clear");

  // ---------- list ----------
  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const table = h("table", { class: "qtable" },
    h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "Action"), h("th", {}, "Entity"), h("th", {}, "Details"))), tbody);
  const status = h("div", { class: "list-status", role: "status" });
  const pager = h("div", { class: "pager" });

  mount(
    container,
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Audit log"), countText)),
    h("div", { class: "toolbar" },
      h("label", { class: "search", for: "al-action" }, icon("search"), actionSearch),
      h("label", { class: "search", for: "al-entity" }, icon("search"), entitySearch),
      daysSelect, clearButton),
    h("div", { class: "card list-card" }, table, status, pager),
  );

  // ---------- loading the list ----------
  async function load() {
    const id = ++state.requestId; // an older answer must never replace a newer one
    status.className = "list-status";
    status.replaceChildren(h("span", {}, "Loading…"));
    try {
      const res = await audit.list({
        limit: PAGE_SIZE,
        offset: (state.page - 1) * PAGE_SIZE,
        filterAction: state.action || null,
        entityType: state.entityType || null,
        days: state.days ? Number(state.days) : null,
      });
      if (id !== state.requestId) return;
      state.items = res.rows;
      state.total = res.total;
      // A filter that shrank the list can leave an empty page: step back to the last real one.
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
    status.replaceChildren(h("span", {}, `Could not load the audit log. ${errorText(err)}`), retry);
  }

  function renderList() {
    const filtered = state.action !== "" || state.entityType !== "" || state.days !== "";
    countText.textContent = state.total === 1 ? "1 event" : `${state.total} events`;

    tbody.replaceChildren(...state.items.map(row));
    status.className = "list-status";
    if (state.items.length === 0) {
      const clear = filtered ? h("button", { class: "btn small ghost", type: "button" }, "Clear filters") : null;
      if (clear) clear.addEventListener("click", clearFilters);
      status.replaceChildren(h("span", {}, filtered ? "Nothing matches these filters." : "Nothing recorded yet."), clear);
    } else {
      status.replaceChildren();
    }
    renderPager();
  }

  function row(l) {
    const details = JSON.stringify(l.changes ?? {});
    const entity = l.entity_id ? `${l.entity_type} ${clip(l.entity_id, 9)}` : l.entity_type;
    return h(
      "tr",
      { "data-id": l.id },
      h("td", {}, fmt(l.created_at)),
      h("td", {}, l.actor_name || "System"),
      h("td", {}, l.action),
      h("td", { title: l.entity_id || "" }, entity),
      h("td", { title: details }, clip(details, 60)),
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

  // ---------- filters ----------
  function setFilter(patch) {
    Object.assign(state, patch);
    state.page = 1;
    load();
  }
  actionSearch.addEventListener("input", debounce(() => setFilter({ action: actionSearch.value.trim() }), 300));
  entitySearch.addEventListener("input", debounce(() => setFilter({ entityType: entitySearch.value.trim() }), 300));
  daysSelect.addEventListener("change", () => setFilter({ days: daysSelect.value }));
  clearButton.addEventListener("click", clearFilters);

  function clearFilters() {
    state.action = ""; state.entityType = ""; state.days = ""; state.page = 1;
    actionSearch.value = ""; entitySearch.value = ""; daysSelect.value = "";
    load();
  }

  // ---------- start ----------
  load();
}
