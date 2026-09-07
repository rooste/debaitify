import { describe, it, expect } from "vitest";
import { normalize, fold, stripLeadingTitle, similarity } from "../src/shared/text";

describe("normalize", () => {
  it("strips soft hyphens", () => {
    // Iltalehti embeds U+00AD inside headline words. Without this, a headline
    // does not match itself.
    expect(normalize("Asian­tuntijalta")).toBe("Asiantuntijalta");
  });

  it("collapses non-breaking space and repairs inline-join punctuation", () => {
    expect(normalize("sabotaasiyrityksiä . Nyt")).toBe("sabotaasiyrityksiä. Nyt");
    expect(normalize("a b")).toBe("a b");
  });
});

describe("fold", () => {
  it("ignores typographic quotes and dashes", () => {
    expect(fold("”Ei tässä” – Forsberg")).toBe("ei tässä forsberg");
  });
});

describe("stripLeadingTitle", () => {
  it("removes a title Readability prefixed to the body", () => {
    const title = "Valtava poliisioperaatio Saksassa";
    const body = `${title} Saksassa on tapahtunut useita sabotaasiyrityksiä.`;
    expect(stripLeadingTitle(body, title)).toBe(
      "Saksassa on tapahtunut useita sabotaasiyrityksiä.",
    );
  });

  it("leaves the body alone when it does not start with the title", () => {
    const body = "Saksassa on tapahtunut useita sabotaasiyrityksiä.";
    expect(stripLeadingTitle(body, "Aivan eri otsikko")).toBe(body);
  });
});

describe("similarity", () => {
  it("scores an identical string at 1 and unrelated text near 0", () => {
    expect(similarity("Valtava poliisioperaatio", "Valtava poliisioperaatio")).toBe(1);
    expect(similarity("Valtava poliisioperaatio", "Sään ennuste")).toBeLessThan(0.3);
  });

  it("matches across soft hyphens", () => {
    expect(similarity("Asian­tuntijalta arvio", "Asiantuntijalta arvio")).toBe(1);
  });
});
