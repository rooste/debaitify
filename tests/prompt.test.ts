import { describe, it, expect } from "vitest";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  BATCH_SYSTEM_PROMPT,
  buildBatchMessage,
} from "../src/background/prompt";
import { isAcceptable } from "../src/background/headlines";

/** Every "Rewrite: ..." line in the worked examples. */
function exampleRewrites(prompt: string): string[] {
  return [...prompt.matchAll(/^Rewrite: "(.+)"$/gm)].map((m) => m[1]!);
}

/** The headline each example is rewriting away from. */
function exampleOriginals(prompt: string): string[] {
  return [...prompt.matchAll(/^Headline: "(.+)"$/gm)].map((m) => m[1]!);
}

describe("prompt examples practise what they preach", () => {
  const rewrites = exampleRewrites(SYSTEM_PROMPT);

  it("ships worked examples in both prompts", () => {
    expect(rewrites.length).toBeGreaterThanOrEqual(3);
    expect(exampleRewrites(BATCH_SYSTEM_PROMPT)).toEqual(rewrites);
  });

  it("every example rewrite passes our own output guard", () => {
    // If an example we teach would be rejected at runtime, the prompt is
    // teaching the model to produce output we throw away.
    const originals = exampleOriginals(SYSTEM_PROMPT);
    rewrites.forEach((rewrite, i) => {
      expect(isAcceptable(rewrite, originals[i] ?? ""), rewrite).toBe(true);
    });
  });

  it("rejects a teaser-quote original, in either ellipsis form", () => {
    // isAcceptable is a FORMAT guard, not a clickbait detector — most of these
    // originals are well-formed sentences and pass it. What it must catch is
    // the trailing tease, and sites write "..." far more often than "…".
    const teaser = exampleOriginals(SYSTEM_PROMPT).find((o) => o.includes("..."));
    expect(teaser).toBeDefined();
    expect(isAcceptable(teaser!, "")).toBe(false);
    expect(isAcceptable("Jotain tapahtui ja se oli yllättävää…", "")).toBe(false);
  });
});

describe("prompt content", () => {
  it("names the withholding patterns rather than asking for a summary", () => {
    for (const p of [SYSTEM_PROMPT, BATCH_SYSTEM_PROMPT]) {
      expect(p).toContain("withhold");
      expect(p).toContain("joutui heti tositoimiin");
      // The distinction that motivated v2.
      expect(p).toContain("says what happened");
    }
  });

  it("permits the batch model to decline, and says why", () => {
    expect(BATCH_SYSTEM_PROMPT).toContain("null");
    expect(BATCH_SYSTEM_PROMPT).toContain("A wrong headline is worse");
  });

  it("does not send the original headline on the article path", () => {
    // Supplying it biases the rewrite toward the framing being removed.
    expect(SYSTEM_PROMPT).toContain("body text of one article");
  });
});

describe("batch message format", () => {
  it("emits one labelled block per item", () => {
    const out = buildBatchMessage([
      { id: "abc", title: "Itärajan uusi aita joutui heti tositoimiin", lead: "L1" },
      { id: "def", title: "Toinen otsikko", lead: "" },
    ]);
    expect(out).toContain("id: abc");
    expect(out).toContain("headline: Itärajan uusi aita joutui heti tositoimiin");
    expect(out).toContain("lead: L1");
    // A missing lead must be explicit, not an empty line the model may misread.
    expect(out).toContain("lead: (none)");
  });
});

describe("prompt versioning", () => {
  it("is at v2", () => {
    // Bump this and PROMPT_VERSION together: cached headlines carry the version
    // they were written under, so a bump is what invalidates them.
    expect(PROMPT_VERSION).toBe(2);
  });
});
