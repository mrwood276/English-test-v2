import { h } from "./dom.js";

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

let toastRegion;

/** A short message at the bottom of the screen. Read out by screen readers (role="status"). */
export function toast(message, kind = "info") {
  if (!toastRegion || !toastRegion.isConnected) {
    toastRegion = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastRegion);
  }
  const el = h("div", { class: `toast ${kind}` }, message);
  toastRegion.append(el);
  setTimeout(() => el.remove(), 4500);
}

/** Replaces window.confirm: a proper dialog with focus kept inside and Escape to cancel. Resolves to true or false. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const cancel = h("button", { class: "btn ghost", type: "button", value: "cancel" }, cancelLabel);
    const ok = h("button", { class: danger ? "btn danger" : "btn", type: "button", value: "ok" }, confirmLabel);
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" }, h("h2", { id: "dialog-title" }, title), h("p", {}, message), h("div", { class: "dialog-actions" }, cancel, ok));
    let result = false;
    ok.addEventListener("click", () => { result = true; dialog.close(); });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * A row of choices where exactly one is selected (radio buttons styled as a segmented control).
 * `options` is a list of [value, label]. Returns { el, set(value) }.
 */
export function segmented({ label, name, options, value, onChange }) {
  const wrap = h("div", { class: "seg", role: "radiogroup", "aria-label": label });
  const inputs = new Map();
  for (const [val, text] of options) {
    const id = `${name}-${val}`;
    const input = h("input", { type: "radio", name, id, value: val, class: "visually-hidden" });
    input.checked = val === value;
    input.addEventListener("change", () => input.checked && onChange(val));
    inputs.set(val, input);
    wrap.append(input, h("label", { for: id }, text));
  }
  return { el: wrap, set: (val) => { for (const [v, input] of inputs) input.checked = v === val; } };
}

/**
 * Keeps a live screen fresh: reloads every `ms` while the screen is still in the document,
 * and stops (timer + observer) the moment another route replaces it.
 * Shared by the monitor boards and the dashboard; `state.timer` is reused so a second
 * call for the same screen can never stack a second interval.
 */
export function startRefresh(container, state, load, ms) {
  load();
  state.timer = setInterval(() => { if (document.contains(container)) load(); }, ms);
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function cleanup() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    observer.disconnect();
  }
  return cleanup;
}
