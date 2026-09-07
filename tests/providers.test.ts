import { describe, it, expect } from "vitest";
import {
  providerMetas,
  getProvider,
  createClient,
  DEFAULT_PROVIDER,
} from "../src/providers/registry";
import { DEFAULT_SETTINGS, apiKeyFor } from "../src/shared/settings";

describe("provider registry", () => {
  it("exposes Claude as the only implemented provider", () => {
    const available = providerMetas().filter((m) => m.available);
    expect(available.map((m) => m.id)).toEqual(["claude"]);
  });

  it("declares the providers we intend to add, marked unavailable", () => {
    const declared = providerMetas().filter((m) => !m.available);
    expect(declared.map((m) => m.id)).toEqual(["openai", "gemini", "ollama"]);
    // A declared provider must not pretend to have models to pick from.
    for (const m of declared) expect(m.models).toEqual([]);
  });

  it("refuses to build a client for an unimplemented provider", () => {
    expect(createClient("openai", "gpt-x", "key")).toBeNull();
    expect(() => getProvider("openai")!.create({ apiKey: "k", model: "m" })).toThrow(
      /not implemented/,
    );
  });

  it("falls back to the default provider when the stored one is unknown", () => {
    const out = createClient("some-removed-provider", "whatever", "key");
    expect(out?.providerId).toBe(DEFAULT_PROVIDER);
  });

  it("falls back to the provider's default model when the stored one is unknown", () => {
    const out = createClient("claude", "claude-does-not-exist", "key");
    expect(out?.model).toBe(getProvider("claude")!.meta.defaultModel);
  });

  it("every model carries pricing for the Options estimate", () => {
    for (const m of getProvider("claude")!.meta.models) {
      expect(m.inputPer1M).toBeGreaterThan(0);
      expect(m.outputPer1M).toBeGreaterThan(0);
    }
  });
});

describe("settings", () => {
  it("defaults to Claude with the batched lead strategy", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("claude");
    expect(DEFAULT_SETTINGS.strategy).toBe("model-lead");
  });

  it("keeps keys per provider so switching does not lose them", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      apiKeys: { claude: "sk-a", openai: "sk-b" },
    };
    expect(apiKeyFor(s)).toBe("sk-a");
    expect(apiKeyFor({ ...s, provider: "openai" })).toBe("sk-b");
    expect(apiKeyFor({ ...s, provider: "gemini" })).toBe("");
  });
});

describe("default settings stay in step with the registry", () => {
  /**
   * settings.ts names a vendor deliberately (importing the registry there would
   * pull a provider SDK into the content-script bundle). These assertions are
   * what stop that literal from drifting.
   */
  it("the default provider exists and is implemented", () => {
    const entry = getProvider(DEFAULT_SETTINGS.provider);
    expect(entry).not.toBeNull();
    expect(entry!.meta.available).toBe(true);
  });

  it("the default model is offered by the default provider", () => {
    const entry = getProvider(DEFAULT_SETTINGS.provider)!;
    expect(entry.meta.models.map((m) => m.id)).toContain(DEFAULT_SETTINGS.model);
    expect(entry.meta.defaultModel).toBe(DEFAULT_SETTINGS.model);
  });

  it("every provider can answer a key test without throwing", async () => {
    for (const meta of providerMetas().filter((m) => !m.available)) {
      const out = await getProvider(meta.id)!.testKey("irrelevant");
      expect(out.ok).toBe(false);
    }
  });
});
