/**
 * Teacher-written text may contain simple formatting (bold, italic, underline, line breaks, sub/superscript).
 * The server already cleans it; this second check runs in the browser before anything is shown, so a mistake in
 * one place cannot become a script running on the page. The text is parsed in an inert document (nothing runs and
 * nothing loads), then only allowed tags are copied, without any attributes.
 */
const ALLOWED = new Set(["B", "STRONG", "I", "EM", "U", "BR", "SUB", "SUP"]);
const DROP_WITH_CONTENT = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH"]);

function copyInto(from, to) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      to.append(document.createTextNode(node.nodeValue));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toUpperCase();
      if (DROP_WITH_CONTENT.has(tag)) continue;
      if (ALLOWED.has(tag)) {
        const el = document.createElement(tag.toLowerCase());
        copyInto(node, el);
        to.append(el);
      } else {
        copyInto(node, to); // unknown tag: keep its text, drop the tag
      }
    }
  }
}

export function richFragment(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html ?? "")}</body>`, "text/html");
  const out = document.createDocumentFragment();
  copyInto(doc.body, out);
  return out;
}

/** Plain text of a rich text, shortened for lists. */
export function plainText(html, max = 140) {
  const text = richFragment(html).textContent.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}
