import { h } from "../../shared/dom.js";

const TOOLS = [
  { tag: "b", text: "B", label: "Bold", key: "b" },
  { tag: "i", text: "I", label: "Italic", key: "i" },
  { tag: "u", text: "U", label: "Underline", key: "u" },
];

/** Wraps the selected text in <tag>…</tag>. Only these simple tags are kept when the question is saved. */
function wrapSelection(textarea, tag) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const chosen = value.slice(start, end) || "text";
  textarea.setRangeText(`<${tag}>${chosen}</${tag}>`, start, end, "select");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

/** A textarea with Bold, Italic, and Underline buttons (also Ctrl/Cmd + B, I, U). */
export function richTextarea({ id, label, rows = 4, value = "", placeholder = "", describedBy }) {
  const textarea = h("textarea", { class: "ta", id, rows: String(rows), placeholder, "aria-describedby": describedBy });
  textarea.value = value;
  const toolbar = h(
    "div",
    { class: "format-bar", role: "toolbar", "aria-label": `Formatting for ${label}` },
    TOOLS.map((t) => {
      const btn = h("button", { class: "fmt", type: "button", title: `${t.label} (Ctrl+${t.key.toUpperCase()})`, "aria-label": t.label }, h(t.tag, {}, t.text));
      btn.addEventListener("click", () => wrapSelection(textarea, t.tag));
      return btn;
    }),
  );
  textarea.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const tool = TOOLS.find((t) => t.key === event.key.toLowerCase());
    if (tool) {
      event.preventDefault();
      wrapSelection(textarea, tool.tag);
    }
  });
  return { el: h("div", { class: "rich-field" }, toolbar, textarea), textarea };
}
