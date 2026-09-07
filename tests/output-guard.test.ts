import { describe, it, expect } from "vitest";
import { isAcceptable } from "../src/background/headlines";

const ORIGINAL =
  "Asiantuntijalta todella karu arvio Moskovan tapaamisesta: ”Ei tässä ole tapahtunut mitään sellaista...”";

describe("isAcceptable", () => {
  it("accepts a plain declarative Finnish headline", () => {
    expect(
      isAcceptable("Professori: Moskovan tapaaminen ei lähentänyt rauhaa", ORIGINAL),
    ).toBe(true);
  });

  it("rejects clickbait punctuation", () => {
    expect(isAcceptable("Mitä Moskovassa oikein tapahtui?", ORIGINAL)).toBe(false);
    expect(isAcceptable("Moskovan tapaaminen tuotti yllätyksen…", ORIGINAL)).toBe(false);
  });

  it("rejects a leading quote and shouting", () => {
    expect(isAcceptable("”Ei mitään uutta” sanoo professori Forsberg", ORIGINAL)).toBe(false);
    expect(isAcceptable("MOSKOVAN tapaaminen ei tuottanut tulosta", ORIGINAL)).toBe(false);
  });

  it("rejects output that is too short, too long, or just the original", () => {
    expect(isAcceptable("Lyhyt", ORIGINAL)).toBe(false);
    expect(isAcceptable("sana ".repeat(20).trim(), ORIGINAL)).toBe(false);
    expect(isAcceptable(ORIGINAL, ORIGINAL)).toBe(false);
  });
});
