import { normalize, ownText } from "../shared/text";

/**
 * DOM mutation and the revert affordance.
 *
 * textContent only — the generated string is model output and must never be
 * parsed as HTML.
 */
const ORIGINAL_ATTR = "debaitifyOriginal";

export function swap(el: HTMLElement, next: string): void {
  if (!el.dataset[ORIGINAL_ATTR]) el.dataset[ORIGINAL_ATTR] = headlineTextOf(el);
  el.title = `Alkuperäinen otsikko: ${el.dataset[ORIGINAL_ATTR]}`;
  writeHeadline(el, next);
  el.dataset["debaitify"] = "done";
}

/** The headline text, excluding sibling chrome such as a category sticker. */
export function headlineTextOf(el: HTMLElement): string {
  const own = ownText(el);
  return own || normalize(textHost(el).textContent ?? "");
}

/**
 * Replace the headline while preserving element children.
 *
 * A teaser title is often mixed content — <span>Nakokulma</span> then the
 * headline as a bare text node. Setting textContent would delete the sticker,
 * so when element children are present we rewrite only the text nodes.
 */
function writeHeadline(el: HTMLElement, next: string): void {
  const host = textHost(el);
  const textNodes = [...host.childNodes].filter(
    (n) => n.nodeType === 3 && (n.nodeValue ?? "").trim() !== "",
  );

  if (host.children.length > 0 && textNodes.length > 0) {
    textNodes.forEach((n, i) => {
      n.nodeValue = i === 0 ? next : "";
    });
    return;
  }
  host.textContent = next;
}

export function revert(el: HTMLElement): void {
  const original = el.dataset[ORIGINAL_ATTR];
  if (original === undefined) return;
  writeHeadline(el, original);
  el.dataset["debaitify"] = "reverted";
}

export function markReverted(el: HTMLElement): void {
  el.dataset["debaitify"] = "reverted";
}

export function currentOriginal(el: HTMLElement): string {
  return el.dataset[ORIGINAL_ATTR] ?? headlineTextOf(el);
}

/**
 * Ilta-Sanomat wraps its headline text in a <span> inside the <h1>. Writing
 * textContent on the <h1> would delete that span and any styling hung off it,
 * so descend to the innermost element that solely holds the text.
 */
function textHost(el: HTMLElement): HTMLElement {
  let node = el;
  for (;;) {
    const children = [...node.children];
    if (children.length !== 1) return node;
    const only = children[0];
    if (!(only instanceof HTMLElement)) return node;
    // Bail out if the wrapper is not the sole carrier of the text.
    if (normalize(only.textContent ?? "") !== normalize(node.textContent ?? "")) {
      return node;
    }
    node = only;
  }
}
