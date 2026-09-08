import { runtime } from "../shared/platform";
import { setDebug, log } from "../shared/log";
import { loadSettings, isSiteEnabled } from "../shared/settings";
import { resolveConfig, findSiteByHost, articleKey } from "../sites/resolve";
import { selectFirst } from "../sites/select";
import { asHtmlElement } from "../shared/text";
import type { SiteConfig } from "../sites/schema";
import type { LookupResult, RewriteResult } from "../shared/messages";
import { arm, disarm } from "./antiflash";
import { extract, findHeadlineByHeuristic } from "./extract";
import { swap, revert, markReverted, currentOriginal } from "./swap";
import type { PageStatus } from "./status";
import { watch, withObserverPaused } from "./navigation";
import { runFront, listenForLeads, injectBridge } from "./front";

/**
 * Content-script lifecycle.
 *
 * The invariant: every exit path from run() either swaps in a headline or calls
 * disarm(). There is no branch that leaves the page with a hidden headline.
 */

/** Monotonic; a response tagged with a stale id belongs to a different article. */
let runId = 0;
let processedKey: string | null = null;

/** Last-known page state, for the popup. */
let headlineEl: HTMLElement | null = null;
let status: PageStatus | null = null;

void main();

async function main(): Promise<void> {
  const settings = await loadSettings();
  setDebug(settings.debug);

  const { file } = await resolveConfig();
  const site = findSiteByHost(file, location.hostname);
  if (!site) return;
  if (!isSiteEnabled(settings, site.id)) {
    log.debug(`site "${site.id}" disabled`);
    return;
  }

  // Two modes. An article page has one headline and we hide it until the
  // rewrite lands; a front page has dozens and we swap them in place, because
  // blanking the whole page would look broken.
  const isArticle = articleKey(location.pathname, site) !== null;
  log.debug(`mode: ${isArticle ? "article" : "front"} on ${location.hostname}`);

  if (isArticle) {
    arm(site.headline.selectors, settings.revealTimeoutMs);
    watch(() => void run(site, settings.revealTimeoutMs));
  } else {
    // Order matters: start listening before the bridge can post.
    listenForLeads();
    injectBridge();
    watch(() => void runFront(site, settings));
  }

  runtime.onMessage(async (raw) => {
    const msg = raw as { type: string };
    if (msg.type === "status") return status;
    const el = headlineEl;
    if (msg.type === "revert" && el) {
      withObserverPaused(() => revert(el));
      if (status) status.swapped = false;
      return { ok: true };
    }
    return null;
  });
}

async function run(site: SiteConfig, revealTimeoutMs: number): Promise<void> {
  const key = articleKey(location.pathname, site);
  if (!key) {
    disarm();
    return;
  }
  if (key === processedKey) return;

  const id = ++runId;
  const stale = () => id !== runId;

  try {
    // Bind to a local: `headlineEl` is module state and TypeScript cannot keep
    // a narrowing across the awaits below.
    const el = findHeadline(site);
    headlineEl = el;
    if (!el) {
      log.debug("no headline element found");
      disarm();
      return;
    }
    if (el.dataset["debaitify"] === "done") return;
    status = { siteId: site.id, swapped: false, original: currentOriginal(el) };

    // Fast path: a cache probe needs only the key, so a re-read costs nothing
    // and resolves before extraction.
    const probe = await runtime.sendMessage<LookupResult>({ type: "lookup", key });
    if (stale()) return;
    if (probe.hit) {
      processedKey = key;
      apply(el, probe.result);
      return;
    }

    // Re-arm: the reveal timeout is measured from the point we know we must call
    // the API, not from document_start.
    arm(site.headline.selectors, revealTimeoutMs);

    const extracted = extract(document, site);
    if (!extracted.ok) {
      log.debug("extraction failed:", extracted.reason);
      disarm();
      return;
    }

    processedKey = key;
    const result = await runtime.sendMessage<RewriteResult>({
      type: "rewrite",
      payload: {
        key,
        siteId: site.id,
        original: currentOriginal(el),
        body: extracted.value.body,
        lead: extracted.value.lead,
        lang: extracted.value.lang,
      },
    });
    if (stale()) return;
    apply(el, result);
  } catch (err) {
    // Includes the case where the service worker died and sendMessage rejected.
    log.warn("pipeline error; showing original", err);
    disarm();
  }
}

function apply(el: HTMLElement, result: RewriteResult): void {
  withObserverPaused(() => {
    if (result.ok) {
      swap(el, result.headline);
      log.debug(`swapped (${result.source})`);
    } else {
      markReverted(el);
      log.debug("reverted:", result.reason);
    }
  });
  if (status) {
    status.swapped = result.ok;
    status.source = result.ok ? result.source : undefined;
    status.reason = result.ok ? undefined : result.reason;
    status.original = currentOriginal(el);
  }
  disarm();
}

function findHeadline(site: SiteConfig): HTMLElement | null {
  const hit = selectFirst(document, site.headline.selectors);
  const el = hit && asHtmlElement(hit.element);
  if (hit && el) {
    log.debug(`headline via ${hit.selector}`);
    return el;
  }
  // Every configured selector missed — this is what a redesign looks like.
  const fallback = findHeadlineByHeuristic(document);
  if (fallback) log.warn("headline found only by heuristic; site config is stale");
  return fallback;
}
