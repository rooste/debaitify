import { log } from "../shared/log";

/**
 * Pure DOM selector helpers.
 *
 * Deliberately separate from resolve.ts: these are used by the extractor and by
 * tests, and neither should have to pull in the extension storage API to run.
 */

/**
 * Returns the first selector in the list that matches, with the element it
 * matched. An invalid selector is skipped, not thrown: querySelector raises
 * SyntaxError on bad CSS, and one typo in a user override must not take out the
 * whole content script.
 */
export function selectFirst(
  root: ParentNode,
  selectors: readonly string[],
): { selector: string; element: Element } | null {
  for (const selector of selectors) {
    try {
      const element = root.querySelector(selector);
      if (element) return { selector, element };
    } catch {
      log.warn("invalid selector in site config:", selector);
    }
  }
  return null;
}

export function selectAll(
  root: ParentNode,
  selectors: readonly string[],
): { selector: string; elements: Element[] } | null {
  for (const selector of selectors) {
    try {
      const elements = [...root.querySelectorAll(selector)];
      if (elements.length > 0) return { selector, elements };
    } catch {
      log.warn("invalid selector in site config:", selector);
    }
  }
  return null;
}
