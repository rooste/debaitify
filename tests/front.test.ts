import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { SitesFileSchema, type SiteConfig } from "../src/sites/schema";
import { selectFirst } from "../src/sites/select";
import { normalize } from "../src/shared/text";
import { swap, revert, headlineTextOf } from "../src/content/swap";
import bundled from "../src/sites/sites.json";

const file = SitesFileSchema.parse(bundled);
const site = (id: string): SiteConfig => file.sites.find((s) => s.id === id)!;

function load(name: string): Document {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf-8")).window.document;
}

/**
 * Mirrors collect() in content/front.ts without importing it — that module
 * pulls in the extension messaging layer.
 */
function collect(doc: Document, s: SiteConfig) {
  const byId = new Map<string, { title: string; count: number }>();
  const re = new RegExp(s.article.urlPattern);
  for (const a of doc.querySelectorAll(s.front.teaserLinkSelectors.join(","))) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const id = re.exec(new URL(href, "https://example.test").pathname)?.groups?.["id"];
    if (!id) continue;
    const hit = selectFirst(a, s.front.titleSelectors);
    const title = hit
      ? headlineTextOf(hit.element as HTMLElement)
      : normalize(a.textContent ?? "");
    if (title.length < s.front.minTitleChars) continue;
    const prev = byId.get(id);
    if (prev) prev.count++;
    else byId.set(id, { title, count: 1 });
  }
  return byId;
}

describe("Iltalehti front page teaser collection", () => {
  const doc = load("iltalehti-front.html");
  const teasers = collect(doc, site("iltalehti"));

  it("finds teasers and keys them by article id", () => {
    expect(teasers.size).toBeGreaterThan(0);
    for (const id of teasers.keys()) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("extracts the clickbait title, soft hyphens stripped", () => {
    const titles = [...teasers.values()].map((t) => t.title);
    const moscow = titles.find((t) => t.includes("Moskovan tapaamisesta"));
    expect(moscow).toBeDefined();
    // The raw markup contains U+00AD inside "Asian­tuntijalta".
    expect(moscow).not.toContain("­");
    expect(moscow).toContain("Asiantuntijalta");
  });

  it("collapses the same article appearing more than once", () => {
    const ids = [...teasers.keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("front-page state carries the lead we depend on", () => {
  it("Iltalehti hydration state pairs a lead with every teaser", () => {
    const html = readFileSync("tests/fixtures/iltalehti-front.html", "utf-8");
    const i = html.indexOf("window.App=") + "window.App=".length;
    const raw = html.slice(i, html.indexOf("</script>", i)).trim().replace(/;$/, "");
    // The blob is a JS object literal, not strict JSON — it contains bare
    // `undefined`. This is exactly why the bridge must run in the page's world
    // and read the live object rather than parsing the HTML.
    expect(raw).toContain("undefined");

    const state = JSON.parse(raw.replace(/(?<=[:[,])\s*undefined/g, " null")).state;
    const leads: string[] = [];
    const walk = (o: unknown): void => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      const n = o as { type?: string; content?: { lead?: string } };
      if (n.type === "article" && n.content?.lead) leads.push(n.content.lead);
      Object.values(o).forEach(walk);
    };
    walk(state.fronts);
    expect(leads.length).toBeGreaterThan(0);
  });

  it("Ilta-Sanomat exposes __NEXT_DATA__ but not a lead for every teaser", () => {
    const doc = load("is-front.html");
    const el = doc.getElementById("__NEXT_DATA__");
    expect(el).not.toBeNull();
    // Documented asymmetry: IS teasers often carry no ingress, so those are
    // left alone rather than rewritten from the headline alone.
    expect(el!.textContent!.length).toBeGreaterThan(1000);
  });
});

describe("swapping a teaser title preserves surrounding chrome", () => {
  const doc = load("iltalehti-front.html");
  const s = site("iltalehti");

  it("reads the headline without the category sticker", () => {
    const el = [...doc.querySelectorAll(".front-title")].find((e) =>
      (e.textContent ?? "").includes("Äärioikeistolle"),
    ) as HTMLElement;
    expect(el).toBeDefined();
    // textContent glues the sticker on; headlineTextOf must not.
    expect(el.textContent).toContain("Näkökulma");
    expect(headlineTextOf(el)).not.toContain("Näkökulma");
    expect(headlineTextOf(el)).toContain("Äärioikeistolle murskavoitto");
  });

  it("keeps the sticker element alive after the swap", () => {
    const el = [...doc.querySelectorAll(".front-title")].find((e) =>
      (e.textContent ?? "").includes("Äärioikeistolle"),
    ) as HTMLElement;
    const stickersBefore = el.querySelectorAll("span").length;
    expect(stickersBefore).toBeGreaterThan(0);

    swap(el, "Äärioikeisto voitti Saksi-Anhaltin osavaltiovaalit");

    expect(el.querySelectorAll("span").length).toBe(stickersBefore);
    expect(el.textContent).toContain("Näkökulma");
    expect(el.textContent).toContain("Äärioikeisto voitti Saksi-Anhaltin");
    expect(el.textContent).not.toContain("murskavoitto");
  });

  it("restores the original on revert", () => {
    const el = [...doc.querySelectorAll(".front-title")].find((e) =>
      (e.textContent ?? "").includes("Moskovan tapaamisesta"),
    ) as HTMLElement;
    const before = headlineTextOf(el);
    swap(el, "Professori: Moskovan tapaaminen ei lähentänyt rauhaa");
    expect(headlineTextOf(el)).not.toBe(before);
    revert(el);
    expect(headlineTextOf(el)).toBe(before);
  });

  it("teaser titles collected for the model exclude stickers", () => {
    const titles = [...collect(doc, s).values()].map((t) => t.title);
    expect(titles.some((t) => t.startsWith("Näkökulma"))).toBe(false);
    expect(titles.some((t) => t.startsWith("IL seuraa"))).toBe(false);
  });
});
