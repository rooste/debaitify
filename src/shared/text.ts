/**
 * Text normalization.
 *
 * Soft hyphens are not cosmetic here: Iltalehti embeds U+00AD inside headline
 * words ("Asian­tuntijalta"), so a headline compared against itself without
 * stripping them will not match.
 */
export function normalize(s: string): string {
  return s
    .replace(/\u00AD/g, "")   // soft hyphen
    .replace(/\u00A0/g, " ")  // non-breaking space
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Aggressive form used only for similarity comparison, never for display. */
export function fold(s: string): string {
  return normalize(s)
    .toLowerCase()
    .replace(/[\u201C\u201D\u2018\u2019"'\u2013\u2014-]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Readability sometimes prefixes the article title to its extracted text. Left
 * in place, the model anchors on the clickbait phrasing it is meant to replace
 * and returns a paraphrase of it.
 */
export function stripLeadingTitle(body: string, title: string): string {
  const t = fold(title);
  if (!t) return body;
  const head = fold(body.slice(0, title.length + 40));
  if (!head.startsWith(t)) return body;

  // Drop the same number of VISIBLE characters from the unfolded string.
  // Comparing against title.length would overshoot by one char per space in
  // the title, eating the first word of the actual body.
  const visible = title.replace(/\s/g, "").length;
  let seen = 0;
  let i = 0;
  for (; i < body.length && seen < visible; i++) {
    if (!/\s/.test(body[i]!)) seen++;
  }
  return body.slice(i).replace(/^[\s:\u2013\u2014-]+/, "");
}

/** Dice coefficient over character bigrams. Cheap, and good enough to match a
 *  headline against a page title. */
export function similarity(a: string, b: string): number {
  const A = bigrams(fold(a));
  const B = bigrams(fold(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * `instanceof HTMLElement` compares against the constructor of the *current*
 * realm. A document from another realm (an <iframe>, or a JSDOM instance in a
 * test) fails the check even though it is a perfectly good element. Check the
 * node type instead.
 */
export function asHtmlElement(node: unknown): HTMLElement | null {
  return node !== null &&
    typeof node === "object" &&
    (node as Node).nodeType === 1
    ? (node as HTMLElement)
    : null;
}

/**
 * Text belonging directly to an element, ignoring text inside child elements.
 *
 * Iltalehti teaser titles are mixed content: a <span> category sticker
 * ("Nakokulma", "IL seuraa Ukrainan sotaa") followed by the actual headline as
 * a bare text node. textContent would glue the sticker onto the headline, which
 * both pollutes the model input and makes the swap overwrite the sticker.
 */
export function ownText(el: Element): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.nodeValue ?? "";
  }
  return normalize(out);
}
