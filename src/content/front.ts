import { runtime } from "../shared/platform";
import { log } from "../shared/log";
import { normalize, asHtmlElement } from "../shared/text";
import { selectFirst } from "../sites/select";
import { articleKey } from "../sites/resolve";
import type { SiteConfig } from "../sites/schema";
import type {
  BatchResult,
  BridgeMessage,
  RewriteResult,
  TeaserInput,
} from "../shared/messages";
import type { Settings } from "../shared/settings";
import { extract } from "./extract";
import { swap, headlineTextOf } from "./swap";

/**
 * Front-page teaser rewriting.
 *
 * No hiding here, unlike the article path: blanking sixty headlines would make
 * the page look broken for a second. Titles stay visible and each is swapped
 * when its rewrite arrives.
 *
 * Teaser identity is the article id parsed from the anchor's href — not the
 * title text and not a DOM path. That survives re-renders, lazy loading, and
 * the same article appearing in two places on the page.
 */

const LEAD_WAIT_MS = 1200;

/** ids already swapped, so re-renders and scrolling do not re-request them. */
const done = new Set<string>();
let leads: Record<string, string> = {};

interface Teaser {
  id: string;
  title: string;
  elements: HTMLElement[];
}

export function listenForLeads(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as BridgeMessage | undefined;
    if (data?.__debaitify !== "teasers") return;
    const before = Object.keys(leads).length;
    leads = { ...leads, ...data.leads };
    log.debug(
      `bridge (${data.source}): ${Object.keys(leads).length - before} new leads, ` +
        `${Object.keys(leads).length} total`,
    );
  });
}

export async function runFront(site: SiteConfig, settings: Settings): Promise<void> {
  const teasers = collect(site);
  const fresh = teasers.filter((t) => !done.has(t.id));
  if (fresh.length === 0) return;

  // Ask the MAIN-world bridge to re-read page state; new teasers arrive there
  // slightly after they appear in the DOM.
  window.postMessage({ __debaitifyAsk: true }, window.location.origin);
  await waitForLeads(fresh);

  // The full-article strategy does not need leads at all — it goes and reads
  // each story. Handled separately because it is lazy and per-teaser.
  if (settings.strategy === "model-article") {
    await runFromArticles(site, fresh);
    return;
  }

  const items: TeaserInput[] = [];
  for (const t of fresh) {
    const lead = leads[t.id];
    // Without a lead there are no facts to work from, and rewriting a headline
    // from the headline alone is exactly the failure mode we are avoiding.
    if (!lead) continue;
    items.push({ id: t.id, title: t.title, lead });
  }

  // Zero-cost strategy: the publisher already wrote a plain sentence, so use it
  // verbatim and never call a model.
  if (settings.strategy === "lead") {
    let n = 0;
    for (const item of items) {
      const teaser = fresh.find((t) => t.id === item.id);
      if (!teaser || item.lead.length < 15) continue;
      done.add(item.id);
      for (const el of teaser.elements) swap(el, item.lead);
      n++;
    }
    log.debug(`lead substitution: swapped ${n}, no API call`);
    return;
  }
  if (items.length === 0) {
    log.debug(`${fresh.length} new teasers, none with a usable lead yet`);
    return;
  }

  // Mark before awaiting: a MutationObserver tick during the request must not
  // queue the same ids a second time.
  for (const i of items) done.add(i.id);

  log.debug(`requesting ${items.length} teaser rewrites`);
  const result = await runtime.sendMessage<BatchResult>({
    type: "rewriteBatch",
    payload: { siteId: site.id, items },
  });

  if (result.reason) {
    log.debug("batch reported", result.reason);
    // Transient failures must be retryable on the next tick.
    if (result.reason !== "disabled") {
      for (const i of items) if (!result.headlines[i.id]) done.delete(i.id);
    }
  }

  let swapped = 0;
  const byId = new Map(teasers.map((t) => [t.id, t]));
  for (const [id, headline] of Object.entries(result.headlines)) {
    const teaser = byId.get(id);
    if (!teaser) continue;
    for (const el of teaser.elements) {
      if (el.dataset["debaitify"] === "done") continue;
      swap(el, headline);
      swapped++;
    }
  }
  log.debug(
    `swapped ${swapped} (${result.fromCache} cached, ${result.generated} generated)`,
  );
}

/**
 * Walk the teaser anchors and pull out (article id, title element). The anchor
 * is the identity anchor; the title element is wherever the text happens to be.
 */
function collect(site: SiteConfig): Teaser[] {
  const byId = new Map<string, Teaser>();

  for (const node of document.querySelectorAll(
    site.front.teaserLinkSelectors.join(","),
  )) {
    const anchor = asHtmlElement(node) as HTMLAnchorElement | null;
    const href = anchor?.getAttribute("href");
    if (!anchor || !href) continue;

    let id: string | null;
    try {
      const key = articleKey(new URL(href, location.origin).pathname, site);
      id = key ? key.split(":").pop()! : null;
    } catch {
      continue; // malformed href
    }
    if (!id) continue;

    const el = findTitleElement(anchor, site);
    if (!el) continue;

    // Excludes the category sticker, which is a sibling <span>.
    const title = headlineTextOf(el);
    if (title.length < site.front.minTitleChars) continue;

    const existing = byId.get(id);
    if (existing) existing.elements.push(el);
    else byId.set(id, { id, title, elements: [el] });
  }

  return [...byId.values()];
}

function findTitleElement(
  anchor: HTMLElement,
  site: SiteConfig,
): HTMLElement | null {
  const hit = selectFirst(anchor, site.front.titleSelectors);
  const el = hit && asHtmlElement(hit.element);
  if (el && headlineTextOf(el).length >= site.front.minTitleChars) {
    return el;
  }
  // Fall back to the anchor itself only when it holds text directly, so we
  // never overwrite a card that also contains an image caption and a timestamp.
  const own = normalize(anchor.textContent ?? "");
  return own.length >= site.front.minTitleChars && anchor.children.length <= 1
    ? anchor
    : null;
}

/** The bridge posts asynchronously; give it a moment before giving up. */
async function waitForLeads(fresh: Teaser[]): Promise<void> {
  const deadline = Date.now() + LEAD_WAIT_MS;
  while (Date.now() < deadline) {
    if (fresh.some((t) => leads[t.id])) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ------------------------------------------------------------------ *
 * Full-article strategy
 * ------------------------------------------------------------------ */

/** Deliberately small. Each fetch is a whole article page (~400 KB), so this is
 *  the difference between a background trickle and hammering the site. */
const ARTICLE_CONCURRENCY = 3;

/**
 * Rewrite from the article's own text rather than its lead.
 *
 * Fetching happens in the content script, not the service worker, because a
 * worker has no DOM and therefore no DOMParser — and parsing the fetched page
 * here lets us reuse the exact same config-driven extractor the article path
 * already uses.
 *
 * Only teasers that scroll into view are fetched. Doing all ~60 up front would
 * mean ~24 MB of downloads and ~60 model calls for a page you may not read.
 */
async function runFromArticles(site: SiteConfig, teasers: Teaser[]): Promise<void> {
  for (const teaser of teasers) observeForFetch(site, teaser);
}

const observed = new WeakSet<Element>();
let visibilityObserver: IntersectionObserver | null = null;
const pending = new Map<Element, { site: SiteConfig; teaser: Teaser }>();
let active = 0;
const waiting: Array<() => void> = [];

function observeForFetch(site: SiteConfig, teaser: Teaser): void {
  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const job = pending.get(e.target);
        if (!job) continue;
        pending.delete(e.target);
        visibilityObserver?.unobserve(e.target);
        void fetchAndRewrite(job.site, job.teaser);
      }
    },
    { rootMargin: "200px" },
  );

  for (const el of teaser.elements) {
    if (observed.has(el)) continue;
    observed.add(el);
    pending.set(el, { site, teaser });
    visibilityObserver.observe(el);
  }
}

async function fetchAndRewrite(site: SiteConfig, teaser: Teaser): Promise<void> {
  if (done.has(teaser.id)) return;
  done.add(teaser.id);

  await acquire();
  try {
    const href = teaser.elements[0]?.closest("a")?.getAttribute("href");
    if (!href) return;

    const res = await fetch(new URL(href, location.origin).toString(), {
      credentials: "omit",
    });
    if (!res.ok) {
      done.delete(teaser.id);
      return;
    }

    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const extracted = extract(doc, site);
    if (!extracted.ok) {
      log.debug(`article fetch for ${teaser.id}: ${extracted.reason}`);
      return; // stays in `done` — refetching a paywalled stub will not help
    }

    const result = await runtime.sendMessage<RewriteResult>({
      type: "rewrite",
      payload: {
        key: `c:${site.id}:${teaser.id}`,
        siteId: site.id,
        original: teaser.title,
        body: extracted.value.body,
        lead: extracted.value.lead,
        lang: extracted.value.lang,
      },
    });

    if (result.ok) {
      for (const el of teaser.elements) swap(el, result.headline);
      log.debug(`article rewrite (${result.source}) for ${teaser.id}`);
    } else if (result.reason !== "refusal" && result.reason !== "invalid-output") {
      done.delete(teaser.id); // transient — allow a retry
    }
  } catch (err) {
    done.delete(teaser.id);
    log.debug("article fetch failed", err);
  } finally {
    release();
  }
}

function acquire(): Promise<void> {
  if (active < ARTICLE_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    waiting.push(() => {
      active++;
      resolve();
    }),
  );
}

function release(): void {
  active--;
  waiting.shift()?.();
}
