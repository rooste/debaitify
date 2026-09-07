import { log } from "../shared/log";

/**
 * Hide-then-reveal, with two independent guarantees that the headline becomes
 * visible: a JS timeout, and a pure-CSS animation failsafe that fires even if
 * this script throws.
 *
 * Arming happens at document_start, before the <h1> exists — so we cannot mark
 * the element. Instead we inject a stylesheet keyed on the site's headline
 * selectors, which takes effect the moment the element parses in.
 */
const ARM_ATTR = "data-debaitify-armed";
const STYLE_ID = "debaitify-arm";
const FAILSAFE_MS = 2500;

let disarmTimer: ReturnType<typeof setTimeout> | undefined;

export function arm(selectors: readonly string[], revealTimeoutMs: number): void {
  const usable = selectors.filter(isSafeSelector);
  if (usable.length === 0) {
    log.warn("no usable headline selectors; not arming anti-flash");
    return;
  }

  const rules = usable
    .map((sel) => `html[${ARM_ATTR}] ${sel}:not([data-debaitify])`)
    .join(",\n");

  // arm() runs twice per article: once at document_start, then again once we
  // know a live API call is needed. Reuse the sheet rather than stacking them.
  const style =
    (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ??
    document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${rules} {
  opacity: 0 !important;
  animation: debaitify-failsafe-reveal 0s linear ${FAILSAFE_MS}ms forwards;
}`;
  if (!style.isConnected) {
    (document.head ?? document.documentElement).appendChild(style);
  }
  document.documentElement.setAttribute(ARM_ATTR, "");

  // The JS guarantee. Fires regardless of what the pipeline is doing.
  clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => {
    log.debug("reveal timeout elapsed; showing original");
    disarm();
  }, revealTimeoutMs);
}

export function disarm(): void {
  if (disarmTimer !== undefined) {
    clearTimeout(disarmTimer);
    disarmTimer = undefined;
  }
  document.documentElement.removeAttribute(ARM_ATTR);
}

export function isArmed(): boolean {
  return document.documentElement.hasAttribute(ARM_ATTR);
}

/**
 * Site config is user-editable, so a selector could contain characters that
 * would terminate the CSS rule early. Reject those, and reject anything the
 * engine cannot parse.
 */
function isSafeSelector(sel: string): boolean {
  if (/[{}<>@;]/.test(sel)) return false;
  try {
    document.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}
