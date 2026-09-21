/**
 * Text rules shared with the database (public.normalize_text and public.question_content_hash).
 * If you change a rule here, change it in a migration too, and the other way around.
 */

/** Ignore letter case and extra spaces: "  Budi   SANTOSO " and "budi santoso" are the same. */
export function normalizeText(t: string | null | undefined): string {
  return (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function compareBytes(a: string, b: string): number {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}

/** Same result as public.question_content_hash: ignores case, extra spaces, and the order of options. */
export async function contentHash(body: string, options: string[]): Promise<string> {
  const text = normalizeText(body) + "\n" + options.map(normalizeText).sort(compareBytes).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "br", "sub", "sup"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"]);
const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link", "source", "embed"]);

/**
 * Keeps only simple formatting (bold, italic, underline, line break, sub/superscript) from teacher-written text.
 * Every attribute is removed, every other tag is removed but its text stays, and script-like blocks are removed
 * with their content. A stray "<" is turned into "&lt;", so the result can never contain active markup.
 */
export function sanitizeInlineHtml(input: string): string {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*>/y;
  let out = "";
  let i = 0;
  let skipUntil: string | null = null;

  while (i < input.length) {
    const j = input.indexOf("<", i);
    if (j === -1) {
      if (!skipUntil) out += input.slice(i);
      break;
    }
    if (!skipUntil) out += input.slice(i, j);

    if (input.startsWith("<!--", j)) {
      const end = input.indexOf("-->", j + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }

    tagRe.lastIndex = j;
    const m = tagRe.exec(input);
    if (!m) {
      if (!skipUntil) out += "&lt;";
      i = j + 1;
      continue;
    }

    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    i = tagRe.lastIndex;

    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !VOID_TAGS.has(name) && !m[0].endsWith("/>")) skipUntil = name;
      continue;
    }
    if (ALLOWED_TAGS.has(name)) {
      out += name === "br" ? "<br>" : closing ? `</${name}>` : `<${name}>`;
    }
  }
  return out;
}
