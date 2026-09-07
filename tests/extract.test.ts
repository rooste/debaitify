import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { extract, isPaywalled, findHeadlineByHeuristic } from "../src/content/extract";
import { selectFirst } from "../src/sites/select";
import { SitesFileSchema, type SiteConfig } from "../src/sites/schema";
import bundled from "../src/sites/sites.json";

const file = SitesFileSchema.parse(bundled);
const site = (id: string): SiteConfig => file.sites.find((s) => s.id === id)!;

function load(name: string): Document {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf-8")).window.document;
}

/**
 * Golden numbers. A failure here is the site-redesign alarm — re-capture the
 * fixture, confirm the new markup, then update these deliberately.
 *
 * Paragraph counts are exact (verified against the fixtures). Character counts
 * are banded until the suite has run once against the real normalize(); pin them
 * to the observed value at that point.
 */
const GOLDEN = {
  iltalehti: {
    fixture: "iltalehti-ulkomaat-8f7fd0a3.html",
    headlineSelector: "h1.article-headline",
    headline: "Asiantuntijalta todella karu arvio Moskovan tapaamisesta:",
    lead: "Asiantuntijan mukaan Yhdysvallat keskittyy taloudellisiin intresseihin.",
    paragraphs: 11,
    chars: [1850, 2100] as const,
  },
  "ilta-sanomat": {
    fixture: "is-ulkomaat-2000012255625.html",
    headlineSelector: "h1[class*='article-title']",
    headline: "Valtava poliisioperaatio Saksassa",
    lead: "Miestä epäillään useista sabotaasiyrityksistä.",
    paragraphs: 14,
    chars: [1880, 2150] as const,
  },
} as const;

describe.each(Object.entries(GOLDEN))("%s article extraction", (id, g) => {
  let doc: Document;
  beforeAll(() => {
    doc = load(g.fixture);
  });

  it("finds the headline via the first configured selector", () => {
    const hit = selectFirst(doc, site(id).headline.selectors);
    expect(hit?.selector).toBe(g.headlineSelector);
    expect(hit?.element.textContent).toContain(g.headline);
  });

  it("extracts the body within the expected size band", () => {
    const out = extract(doc, site(id));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.body.length).toBeGreaterThan(g.chars[0]);
    expect(out.value.body.length).toBeLessThan(g.chars[1]);
    expect(out.value.lang).toBe("fi");
  });

  it("captures the publisher's own lead", () => {
    const out = extract(doc, site(id));
    expect(out.ok && out.value.lead).toContain(g.lead);
  });

  it("does not mutate the live document", () => {
    const before = doc.querySelectorAll("figure").length;
    extract(doc, site(id));
    expect(doc.querySelectorAll("figure").length).toBe(before);
  });

  it("finds the same headline by heuristic when the config misses", () => {
    // Simulates a redesign: every configured selector stops matching.
    const found = findHeadlineByHeuristic(doc);
    expect(found?.textContent).toContain(g.headline);
  });
});

describe("paragraph counts", () => {
  it.each([
    ["iltalehti", "iltalehti-ulkomaat-8f7fd0a3.html", 11, "p.paragraph"],
    ["ilta-sanomat", "is-ulkomaat-2000012255625.html", 14, "p"],
  ])("%s yields %i paragraphs", (id, fixture, count, selector) => {
    const doc = load(fixture);
    const container = selectFirst(doc, site(id).body.containers)!;
    expect(container.element.querySelectorAll(selector).length).toBe(count);
  });
});

describe("paywall detection", () => {
  it("treats the free Ilta-Sanomat article as free", () => {
    // JSON-LD says isAccessibleForFree: true.
    expect(isPaywalled(load(GOLDEN["ilta-sanomat"].fixture), site("ilta-sanomat"))).toBe(false);
  });

  it("detects a paid article from JSON-LD", () => {
    const doc = load(GOLDEN["ilta-sanomat"].fixture);
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      const parsed = JSON.parse(s.textContent ?? "{}");
      if (parsed["@type"] === "NewsArticle") {
        parsed.isAccessibleForFree = false;
        s.textContent = JSON.stringify(parsed);
      }
    }
    expect(isPaywalled(doc, site("ilta-sanomat"))).toBe(true);
  });

  it("Iltalehti has no JSON-LD, so it relies on the length gate — HLD O5", () => {
    const doc = load(GOLDEN.iltalehti.fixture);
    expect(doc.querySelectorAll('script[type="application/ld+json"]').length).toBe(0);
    expect(isPaywalled(doc, site("iltalehti"))).toBe(false);
  });
});

describe("front pages are not treated as articles", () => {
  /**
   * The URL pattern is the article gate, and the only one — see LLD §4.4.
   * extract() is never reached for a non-article, which matters because the
   * Readability fallback will happily extract a front page if you let it. These
   * assertions pin the gate that actually protects us, plus the fact that the
   * config path finds no article body on either front page.
   */
  it.each([
    ["iltalehti", "iltalehti-front.html"],
    ["ilta-sanomat", "is-front.html"],
  ])("%s front page is rejected by the URL gate", (id, fixture) => {
    const s = site(id);
    const re = new RegExp(s.article.urlPattern);
    for (const path of ["/", "/tuoreimmat", "/uutiset/", "/viihde"]) {
      expect(re.exec(path)?.groups?.["id"]).toBeUndefined();
    }
    // And there is no article body for the config path to latch onto.
    expect(selectFirst(load(fixture), s.body.containers)).toBeNull();
  });

  it("Readability alone would NOT reject a front page — hence the URL gate", () => {
    // Documents the reason the gate exists rather than asserting a guarantee
    // extract() does not make.
    const out = extract(load("is-front.html"), site("ilta-sanomat"));
    expect(out.ok).toBe(true);
  });
});
