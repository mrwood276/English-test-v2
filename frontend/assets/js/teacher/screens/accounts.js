import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { confirmDialog, toast } from "../../shared/ui.js";
import { accounts } from "../api/accounts.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
// When the session ended, core/api.js already sent the person back to sign in; nothing more to show here.
const ignorable = (err) => err instanceof SessionExpiredError;

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const roleLabel = (role) => (role === "admin" ? "Admin" : "Teacher");

/** A password the admin can read out loud: 12 characters, no 0/O or 1/l/I, from the browser's own randomness. */
const PASSWORD_LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#%+?";
function suggestPassword(n = 12) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_LETTERS[b % PASSWORD_LETTERS.length]).join("");
}

const field = (label, control, hint) =>
  h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);

function roleSelect(value, id = "ac-role") {
  const select = h("select", { class: "input", id }, h("option", { value: "teacher" }, "Teacher"), h("option", { value: "admin" }, "Admin"));
  select.value = value;
  return select;
}

/** A small dialog with a promise: `build()` returns the body, `onSave` does the work and resolves true to close. */
function dialog({ title, id, build, confirmLabel, danger = false, onSave, afterSave }) {
  return new Promise((resolve) => {
    const error = h("p", { class: "field-error", role: "alert", hidden: true });
    const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
    const save = h("button", { class: `btn${danger ? " danger" : ""}`, type: "button" }, confirmLabel);
    const body = build();
    const el = h("dialog", { class: "dialog", "aria-labelledby": `${id}-title` },
      h("h2", { id: `${id}-title` }, title),
      ...body.nodes,
      error,
      h("div", { class: "dialog-actions" }, cancel, save));

    const showProblem = (message) => {
      error.textContent = message;
      error.hidden = false;
      save.disabled = false;
    };

    save.addEventListener("click", async () => {
      error.hidden = true;
      save.disabled = true;
      try {
        const done = await onSave(body.values());
        if (done === false) return;                    // the screen decided to keep the dialog open
        el.close();                                    // close first: a follow-up panel must not sit on top of this one
        if (afterSave) await afterSave(body.values()); // e.g. show the password to hand over
      } catch (err) {
        if (ignorable(err)) return el.close();
        showProblem(errorText(err));
      }
    });
    cancel.addEventListener("click", () => el.close());
    el.addEventListener("close", () => { el.remove(); resolve(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") save.click(); });
    document.body.append(el);
    el.showModal();
    const first = el.querySelector("input, select");
    if (first) first.focus();
  });
}

/** The password panel: the one moment the admin can read the password, so it stays until they close it. */
function handOverDialog({ name, email, password }) {
  return new Promise((resolve) => {
    const copy = h("button", { class: "btn small ghost", type: "button", id: "ac-copy" }, icon("copy"), "Copy password");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(password);
        toast("Password copied");
      } catch {
        toast("Your browser would not let the page copy it. Please write it down.", "warn");
      }
    });
    const close = h("button", { class: "btn", type: "button" }, "Done");
    const el = h("dialog", { class: "dialog", "aria-labelledby": "ac-handover-title" },
      h("h2", { id: "ac-handover-title" }, "Hand this password over"),
      h("p", {}, `Give ${name} these details. The password is not shown again — if it is lost, set a new one.`),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Email"), h("p", {}, email)),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Temporary password"), h("p", { id: "ac-handover-password" }, password), copy),
      h("p", { class: "hint" }, "They can change it after signing in."),
      h("div", { class: "dialog-actions" }, close));
    close.addEventListener("click", () => el.close());
    el.addEventListener("close", () => { el.remove(); resolve(); });
    document.body.append(el);
    el.showModal();
    close.focus();
  });
}

/** Accounts (admin only): create a teacher or another admin, rename, change role, deactivate, reset a password. */
export function renderAccounts(container, ctx = {}) {
  const meId = ctx?.user?.id ?? null;
  const state = { items: [], total: 0, busy: false };

  const countText = h("p", { class: "sub" }, "Loading…");
  const tbody = h("tbody");
  const table = h(
    "table",
    { class: "qtable" },
    h("thead", {}, h(
      "tr",
      {},
      h("th", {}, "Name"),
      h("th", {}, "Email"),
      h("th", {}, "Role"),
      h("th", {}, "Status"),
      h("th", {}, "Last signed in"),
      h("th", { class: "col-actions", "aria-label": "Actions" }, ""),
    )),
    tbody,
  );
  const status = h("div", { class: "list-status", role: "status" });
  const createButton = h("button", { class: "btn", type: "button", id: "ac-create" }, icon("plus"), h("span", {}, "New account"));

  mount(
    container,
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Accounts"), countText)),
    h(
      "div",
      { class: "toolbar" },
      createButton,
      h(
        "p",
        { class: "cap2" },
        "Teachers sign in with the email address and the temporary password you set here. An account is deactivated, never deleted, " +
          "so the audit log keeps pointing at it; the last admin cannot be removed.",
      ),
    ),
    h("div", { class: "card list-card" }, table, status),
  );

  async function load() {
    status.className = "list-status";
    status.replaceChildren(h("span", {}, "Loading…"));
    try {
      const res = await accounts.list();
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
    status.replaceChildren(h("span", {}, `Could not load the accounts. ${errorText(err)}`), retry);
  }

  function renderList() {
    countText.textContent = state.total === 1 ? "1 account" : `${state.total} accounts`;
    tbody.replaceChildren(...state.items.map(row));
    status.className = "list-status";
    status.replaceChildren(
      state.items.length === 0
        ? h("span", {}, "No accounts yet. Make one for the teacher first.")
        : h("span", {}),
    );
  }

  function row(a) {
    const mine = a.id === meId;
    const edit = h("button", { class: "btn small ghost", type: "button", "aria-label": `Edit ${a.full_name}` }, "Edit");
    const passwordButton = h("button", { class: "btn small ghost", type: "button", "aria-label": `Set a new password for ${a.full_name}`, id: `ac-password-${a.id}` }, "New password");
    const toggle = mine
      ? h("span", { class: "hint" }, "This is you")
      : h(
        "button",
        { class: "btn small ghost", type: "button", "aria-label": `${a.is_active ? "Deactivate" : "Reactivate"} ${a.full_name}`, id: `ac-toggle-${a.id}` },
        a.is_active ? "Deactivate" : "Reactivate",
      );

    edit.addEventListener("click", async () => {
      const name = h("input", { class: "input", type: "text", id: "ac-edit-name", value: a.full_name, autocomplete: "off" });
      const role = roleSelect(a.role, "ac-edit-role");
      if (mine) {
        role.disabled = true;
      }
      await dialog({
        title: `Edit ${a.full_name}`,
        id: "ac-edit",
        confirmLabel: "Save",
        build: () => ({
          nodes: [
            field("Full name", name),
            field("Role", role, mine ? "You cannot change your own role — another admin has to." : "An admin can do everything a teacher can, plus accounts, backups and the audit log."),
          ],
          values: () => ({ id: a.id, full_name: name.value.trim(), role: mine ? null : role.value }),
        }),
        onSave: async (v) => {
          await accounts.update(a.id, v.role ? { full_name: v.full_name, role: v.role } : { full_name: v.full_name });
          toast(`${v.full_name} saved`);
          await load();
        },
      });
    });

    passwordButton.addEventListener("click", async () => {
      const password = h("input", { class: "input", type: "text", id: "ac-new-password", autocomplete: "off", spellcheck: "false" });
      password.value = suggestPassword();
      const generate = h("button", { class: "btn small ghost", type: "button" }, "Generate another");
      generate.addEventListener("click", () => { password.value = suggestPassword(); });
      await dialog({
        title: `New password for ${a.full_name}`,
        id: "ac-password",
        confirmLabel: "Set the password",
        build: () => ({
          nodes: [
            h("p", {}, "The password they use now stops working immediately. Nothing else about the account changes."),
            field("Temporary password", password, h("span", {}, "At least 8 characters. ", generate)),
          ],
          values: () => ({ password: password.value }),
        }),
        onSave: async (v) => {
          if (v.password.length < accounts.minPassword) throw new Error(`A password needs at least ${accounts.minPassword} characters.`);
          await accounts.setPassword(a.id, v.password);
          return true;
        },
        afterSave: async (v) => handOverDialog({ name: a.full_name, email: a.email, password: v.password }),
      });
    });

    if (!mine) {
      toggle.addEventListener("click", async () => {
        if (!a.is_active) {
          try {
            await accounts.update(a.id, { is_active: true });
            toast(`${a.full_name} can sign in again`);
            load();
          } catch (err) {
            if (!ignorable(err)) toast(errorText(err), "error");
          }
          return;
        }
        const agreed = await confirmDialog({
          title: "Deactivate this account?",
          message: `${a.full_name} will not be able to sign in until you reactivate it. Their questions, exams and results stay.`,
          confirmLabel: "Deactivate",
          danger: true,
        });
        if (!agreed) return;
        try {
          await accounts.update(a.id, { is_active: false });
          toast(`${a.full_name} deactivated`);
          load();
        } catch (err) {
          if (!ignorable(err)) toast(errorText(err), "error");
        }
      });
    }

    return h(
      "tr",
      { "data-id": a.id, "data-role": a.role, "data-active": String(a.is_active) },
      h("td", {}, a.full_name, mine ? h("span", { class: "hint" }, " (you)") : null),
      h("td", {}, a.email),
      h("td", {}, h("span", { class: a.role === "admin" ? "pill" : "pill plain" }, roleLabel(a.role))),
      h("td", {}, h("span", { class: a.is_active ? "pill ok" : "pill bad" }, a.is_active ? "Active" : "Inactive")),
      h("td", {}, fmtWhen(a.last_sign_in_at)),
      h("td", { class: "col-actions" }, h("div", { class: "row gap" }, edit, passwordButton, toggle)),
    );
  }

  createButton.addEventListener("click", async () => {
    if (state.busy) return;
    const email = h("input", { class: "input", type: "email", id: "ac-email", autocomplete: "off", spellcheck: "false", placeholder: "name@example.com" });
    const name = h("input", { class: "input", type: "text", id: "ac-name", autocomplete: "off", placeholder: "The name students see" });
    const role = roleSelect("teacher");
    const password = h("input", { class: "input", type: "text", id: "ac-password", autocomplete: "off", spellcheck: "false" });
    password.value = suggestPassword();
    const generate = h("button", { class: "btn small ghost", type: "button" }, "Generate another");
    generate.addEventListener("click", () => { password.value = suggestPassword(); });

    await dialog({
      title: "New account",
      id: "ac-create",
      confirmLabel: "Create account",
      build: () => ({
        nodes: [
          field("Email", email, "This is what they sign in with."),
          field("Full name", name, "Shown wherever the app says who did something."),
          field("Role", role),
          field("Temporary password", password, h("span", {}, "Hand it over after creating the account; they can change it later. ", generate)),
        ],
        values: () => ({ email: email.value.trim(), fullName: name.value.trim(), role: role.value, password: password.value }),
      }),
      onSave: async (v) => {
        if (!v.email.includes("@")) throw new Error("That does not look like an email address.");
        if (!v.fullName) throw new Error("The full name is required.");
        if (v.password.length < accounts.minPassword) throw new Error(`A password needs at least ${accounts.minPassword} characters.`);
        state.busy = true;
        try {
          await accounts.create(v);
        } finally {
          state.busy = false;
        }
        toast(`${v.fullName} can sign in now`);
        await load();
      },
      afterSave: (v) => handOverDialog({ name: v.fullName, email: v.email, password: v.password }),
    });
  });

  load();
}
