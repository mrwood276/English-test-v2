import { h } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { debounce } from "../../shared/ui.js";

const norm = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A list of short labels (for example class labels): type and press Enter or comma, or pick a suggestion.
 * Labels that differ only by letter case or extra spaces count as the same.
 * `suggest(prefix)` returns a promise of [{ label, question_count }].
 */
export function chipsInput({ id, label, values = [], max = 10, maxLength = 40, placeholder = "", suggest, onChange }) {
  let items = [...values];
  let options = [];
  let active = -1;

  const chips = h("div", { class: "chips-row" });
  const input = h("input", { class: "inp", id, type: "text", autocomplete: "off", maxlength: String(maxLength), placeholder, role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": `${id}-list` });
  const list = h("div", { class: "suggest", id: `${id}-list`, role: "listbox", "aria-label": `${label} suggestions`, hidden: true });
  const note = h("div", { class: "hint", role: "status" });
  const el = h("div", { class: "chips-input" }, chips, input, list, note);

  function renderChips() {
    chips.replaceChildren(
      ...items.map((text) => {
        const remove = h("button", { class: "chip-x", type: "button", "aria-label": `Remove ${text}` }, icon("plus"));
        remove.addEventListener("click", () => { items = items.filter((x) => x !== text); renderChips(); onChange([...items]); input.focus(); });
        return h("span", { class: "chipx" }, text, remove);
      }),
    );
  }

  function closeList() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function renderList() {
    if (options.length === 0) return closeList();
    list.replaceChildren(
      ...options.map((o, i) => {
        const item = h("div", { class: i === active ? "s-item h" : "s-item", role: "option", id: `${id}-opt-${i}`, "aria-selected": String(i === active) }, o.label, h("span", { class: "hint" }, ` ${o.question_count}`));
        item.addEventListener("mousedown", (event) => { event.preventDefault(); add(o.label); }); // mousedown: before the input loses focus
        return item;
      }),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `${id}-opt-${active}`);
  }

  function add(text) {
    const t = text.replace(/\s+/g, " ").trim();
    input.value = "";
    closeList();
    if (!t) return;
    if (items.some((x) => norm(x) === norm(t))) { note.textContent = `"${t}" is already added.`; return; }
    if (items.length >= max) { note.textContent = `You can add at most ${max}.`; return; }
    note.textContent = "";
    items.push(t);
    renderChips();
    onChange([...items]);
  }

  const lookup = debounce(async () => {
    if (!suggest) return;
    try {
      const found = await suggest(input.value);
      options = found.filter((o) => !items.some((x) => norm(x) === norm(o.label))).slice(0, 8);
      active = -1;
      if (document.activeElement === input) renderList();
    } catch { closeList(); }
  }, 200);

  input.addEventListener("input", () => {
    note.textContent = "";
    if (input.value.includes(",")) {
      const parts = input.value.split(",");
      parts.slice(0, -1).forEach(add);
      input.value = parts[parts.length - 1];
    }
    lookup();
  });
  input.addEventListener("focus", lookup);
  input.addEventListener("blur", () => { if (input.value.trim()) add(input.value); closeList(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && options.length) { event.preventDefault(); active = (active + 1) % options.length; renderList(); }
    else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); active = (active - 1 + options.length) % options.length; renderList(); }
    else if (event.key === "Enter") { event.preventDefault(); add(active >= 0 ? options[active].label : input.value); }
    else if (event.key === "Escape") { closeList(); }
    else if (event.key === "Backspace" && !input.value && items.length) { items.pop(); renderChips(); onChange([...items]); }
  });

  renderChips();
  return { el, input, get values() { return [...items]; } };
}
