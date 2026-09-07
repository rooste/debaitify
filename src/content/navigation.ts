import { log } from "../shared/log";

/**
 * Both target sites are SPAs: article pages are server-rendered, but in-site
 * navigation swaps content without a document load. Load is therefore one
 * trigger among several, not the trigger.
 */
const DEBOUNCE_MS = 250;

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function watch(onChange: () => void): void {
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onChange, { once: true });
  } else {
    queueMicrotask(onChange);
  }

  patchHistory(fire);
  window.addEventListener("popstate", fire);

  observer = new MutationObserver(fire);
  connect();
}

/**
 * Writing the new headline mutates the DOM, which would re-trigger the observer,
 * which would re-trigger the swap, forever. Every write must be wrapped.
 */
export function withObserverPaused<T>(fn: () => T): T {
  disconnect();
  try {
    return fn();
  } finally {
    connect();
  }
}

function connect(): void {
  observer?.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function disconnect(): void {
  observer?.disconnect();
}

function patchHistory(fire: () => void): void {
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function patched(
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      const out = original.apply(this, args);
      log.debug(`history.${name}`);
      fire();
      return out;
    } as History[typeof name];
  }
}
