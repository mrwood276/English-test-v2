import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { confirmDialog, toast } from "../../shared/ui.js";
import { backups } from "../api/backups.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
// When the session ended, core/api.js already sent the person back to sign in; nothing more to show here.
const ignorable = (err) => err instanceof SessionExpiredError;

const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtSize = (bytes) =>
  bytes === null || bytes === undefined ? "—"
    : bytes < 1000 ? `${bytes} B`
    : bytes < 1_000_000 ? `${Math.round(bytes / 1000)} kB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** Backups (admin only, TASK-015): the copies that exist, a button to make one, and the files to keep. */
export function renderBackups(container) {
  const state = { items: [], total: 0, busy: false };

  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const table = h(
    "table",
    { class: "qtable" },
    h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Kind"), h("th", {}, "Size"), h("th", {}, "Made by"), h("th", { class: "col-actions", "aria-label": "Actions" }, ""))),
    tbody,
  );
  const status = h("div", { class: "list-status", role: "status" });

  const createLabel = h("span", {}, "Create backup now");
  const createButton = h("button", { class: "btn", type: "button", id: "bk-create" }, icon("cloud"), createLabel);

  mount(
    container,
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Backups"), countText)),
    h(
      "div",
      { class: "toolbar" },
      createButton,
      h(
        "p",
        { class: "cap2" },
        "One file holds every question, exam, attempt, result and audit row, plus the pictures and audio attached to questions. " +
          "A nightly copy is made at 02:41 and the last seven are kept; manual copies stay until you delete them.",
      ),
    ),
    h("div", { class: "card list-card" }, table, status),
  );

  async function load() {
    status.className = "list-status";
    status.replaceChildren(h("span", {}, "Loading…"));
    try {
      const res = await backups.list({ limit: 100 });
      state.items = res.rows;
      state.total = res.total;
      renderList();
    } catch (err) {
      if (ignorable(err)) return;
      renderLoadError(err);
    }
  }

  function renderLoadError(err) {
    tbody.replaceChildren();
    const retry = h("button", { class: "btn small", type: "button" }, "Try again");
    retry.addEventListener("click", load);
    status.className = "list-status error";
    status.replaceChildren(h("span", {}, `Could not load the backups. ${errorText(err)}`), retry);
  }

  function renderList() {
    countText.textContent = state.total === 1 ? "1 backup" : `${state.total} backups`;
    tbody.replaceChildren(...state.items.map(row));
    status.className = "list-status";
    status.replaceChildren(
      state.items.length === 0 ? h("span", {}, "No backups yet. Make one before the next exam.") : h("span", {}),
    );
  }

  function row(b) {
    const manual = b.kind === "manual";
    const download = h("button", { class: "btn small ghost", type: "button", "aria-label": `Download the backup from ${fmtWhen(b.created_at)}` }, icon("download"), "Download");
    const remove = h("button", { class: "btn small danger", type: "button", "aria-label": `Delete the backup from ${fmtWhen(b.created_at)}` }, "Delete");

    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        const { url } = await backups.download(b.id);
        const link = h("a", { href: url, download: "" });
        document.body.append(link);
        link.click();
        link.remove();
      } catch (err) {
        if (!ignorable(err)) toast(errorText(err), "error");
      } finally {
        download.disabled = false;
      }
    });

    remove.addEventListener("click", async () => {
      const agreed = await confirmDialog({
        title: "Delete this backup?",
        message: `The archive made on ${fmtWhen(b.created_at)} will be removed. This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!agreed) return;
      remove.disabled = true;
      try {
        await backups.remove(b.id);
        toast("Backup deleted");
        load();
      } catch (err) {
        remove.disabled = false;
        if (!ignorable(err)) toast(errorText(err), "error");
      }
    });

    return h(
      "tr",
      { "data-id": b.id, "data-kind": b.kind },
      h("td", { title: b.created_at }, fmtWhen(b.created_at)),
      h("td", {}, h("span", { class: manual ? "pill plain" : "pill" }, manual ? "Manual" : "Nightly")),
      h("td", {}, fmtSize(b.size_bytes)),
      h("td", {}, b.created_by_name || "Nightly job"),
      h("td", { class: "col-actions" }, h("div", { class: "row gap" }, download, remove)),
    );
  }

  createButton.addEventListener("click", async () => {
    if (state.busy) return;
    state.busy = true;
    createButton.disabled = true;
    createLabel.textContent = "Making a backup…";
    try {
      const res = await backups.create();
      toast(`Backup created (${fmtSize(res.backup.size_bytes)}, ${res.files} files)`);
      if (res.media_note) toast(res.media_note, "warn");
      if (res.pruned > 0) toast(`${res.pruned} older nightly ${res.pruned === 1 ? "copy was" : "copies were"} removed`, "info");
      await load();
    } catch (err) {
      if (!ignorable(err)) toast(errorText(err), "error");
    } finally {
      state.busy = false;
      createButton.disabled = false;
      createLabel.textContent = "Create backup now";
    }
  });

  load();
}
