import { describe, it, expect } from "vitest";
import { SitesFileSchema } from "../src/sites/schema";
import bundled from "../src/sites/sites.json";

const file = SitesFileSchema.parse(bundled);

/** Mirrors articleKey() without the storage-dependent module. */
function idFor(pathname: string, siteId: string): string | null {
  const site = file.sites.find((s) => s.id === siteId)!;
  return new RegExp(site.article.urlPattern).exec(pathname)?.groups?.["id"] ?? null;
}

describe("bundled sites.json", () => {
  it("validates against the schema", () => {
    expect(file.sites.map((s) => s.id)).toEqual(["iltalehti", "ilta-sanomat"]);
  });

  it("has only parseable selectors", () => {
    for (const site of file.sites) {
      const all = [
        ...site.headline.selectors,
        ...site.lead.selectors,
        ...site.body.containers,
        ...site.body.paragraphs,
        ...site.body.strip,
        ...site.paywall.selectors,
      ];
      for (const sel of all) {
        expect(() => document.createDocumentFragment().querySelector(sel)).not.toThrow();
      }
    }
  });
});

describe("article id extraction", () => {
  it("pulls the uuid out of an Iltalehti path", () => {
    expect(idFor("/ulkomaat/a/8f7fd0a3-4819-45d5-a4cd-21bb02e68602", "iltalehti")).toBe(
      "8f7fd0a3-4819-45d5-a4cd-21bb02e68602",
    );
  });

  it("pulls the digits out of an Ilta-Sanomat path", () => {
    expect(idFor("/ulkomaat/art-2000012255625.html", "ilta-sanomat")).toBe(
      "2000012255625",
    );
  });

  it("rejects non-article paths — this is also the article test", () => {
    expect(idFor("/", "iltalehti")).toBeNull();
    expect(idFor("/tuoreimmat", "iltalehti")).toBeNull();
    expect(idFor("/uutiset/", "ilta-sanomat")).toBeNull();
  });

  it("is unaffected by query strings and fragments (they are not in pathname)", () => {
    const url = new URL(
      "https://www.iltalehti.fi/ulkomaat/a/8f7fd0a3-4819-45d5-a4cd-21bb02e68602?utm_source=x#kommentit",
    );
    expect(idFor(url.pathname, "iltalehti")).toBe("8f7fd0a3-4819-45d5-a4cd-21bb02e68602");
  });
});
