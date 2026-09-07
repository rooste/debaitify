import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { selectFirst, selectAll } from "../sites/select";
import type { SiteConfig } from "../sites/schema";
import {
  normalize,
  stripLeadingTitle,
  similarity,
  asHtmlElement,
} from "../shared/text";
import { log } from "../shared/log";

export interface Extracted {
  body: string;
  /** The publisher's own summary sentence; "" when absent. */
  lead: string;
  lang: string;
}

export type ExtractFailure = "paywalled" | "too-short" | "no-content";

/**
 * Config-driven extraction first, Readability as fallback.
 *
 * Both target sites have clean body containers, so a direct read is cheaper and
 * more predictable than Readability. Readability exists to survive redesigns and
 * to cover sites the config does not know precisely.
 */
export function extract(
  doc: Document,
  site: SiteConfig,
): { ok: true; value: Extracted } | { ok: false; reason: ExtractFailure } {
  if (isPaywalled(doc, site)) return { ok: false, reason: "paywalled" };

  const body = extractByConfig(doc, site) ?? extractByReadability(doc, site);
  if (body === null) return { ok: false, reason: "no-content" };
  if (body.length < site.minBodyChars) {
    log.debug(`body too short (${body.length} < ${site.minBodyChars})`);
    return { ok: false, reason: "too-short" };
  }

  return {
    ok: true,
    value: {
      body: body.slice(0, site.maxBodyChars),
      lead: readLead(doc, site),
      lang: doc.documentElement.lang || "fi",
    },
  };
}

function extractByConfig(doc: Document, site: SiteConfig): string | null {
  const container = selectFirst(doc, site.body.containers);
  if (!container) return null;

  // Clone: the container is live DOM the reader is looking at, and the strip
  // list would otherwise delete images and related-article blocks from the page.
  const work = container.element.cloneNode(true) as Element;
  for (const sel of site.body.strip) {
    try {
      work.querySelectorAll(sel).forEach((n) => n.remove());
    } catch {
      log.warn("invalid strip selector:", sel);
    }
  }

  const paragraphs = selectAll(work, site.body.paragraphs);
  if (!paragraphs) return null;

  log.debug(
    `extracted via config: ${container.selector} → ${paragraphs.selector} ` +
      `(${paragraphs.elements.length} paragraphs)`,
  );
  return normalize(paragraphs.elements.map((p) => p.textContent ?? "").join(" "));
}

function extractByReadability(doc: Document, site: SiteConfig): string | null {
  // Readability mutates the document it is given.
  const clone = doc.cloneNode(true) as Document;
  for (const sel of site.body.strip) {
    try {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    } catch {
      /* already warned in the config path */
    }
  }

  if (!isProbablyReaderable(clone)) return null;
  const article = new Readability(clone).parse();
  if (!article?.textContent) return null;

  log.debug("extracted via Readability fallback");
  let body = normalize(article.textContent);
  if (article.title) body = stripLeadingTitle(body, article.title);
  return body;
}

function readLead(doc: Document, site: SiteConfig): string {
  const hit = selectFirst(doc, site.lead.selectors);
  return hit ? normalize(hit.element.textContent ?? "") : "";
}

/**
 * Ilta-Sanomat publishes schema.org NewsArticle with isAccessibleForFree, which
 * is a reliable signal. Iltalehti publishes no JSON-LD at all, so it falls
 * through to the selector list and ultimately to the minimum-length gate.
 */
export function isPaywalled(doc: Document, site: SiteConfig): boolean {
  if (site.paywall.useJsonLd && jsonLdSaysPaid(doc)) return true;
  return selectFirst(doc, site.paywall.selectors) !== null;
}

function jsonLdSaysPaid(doc: Document): boolean {
  for (const script of doc.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (
        typeof node === "object" &&
        node !== null &&
        (node as Record<string, unknown>)["@type"] === "NewsArticle" &&
        (node as Record<string, unknown>)["isAccessibleForFree"] === false
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Fallback headline finder, used when every configured selector misses — which
 * is what a site redesign looks like from here. Scores candidate headings
 * against the document title and takes the best match above a threshold.
 */
export function findHeadlineByHeuristic(doc: Document): HTMLElement | null {
  const title = doc.title;
  if (!title) return null;

  let best: { el: HTMLElement; score: number } | null = null;
  for (const node of doc.querySelectorAll("h1, h2")) {
    const el = asHtmlElement(node);
    if (!el) continue;
    const score = similarity(el.textContent ?? "", title);
    if (score > (best?.score ?? 0)) best = { el, score };
  }
  return best && best.score >= 0.6 ? best.el : null;
}
