import type { ModelClient, ProviderEntry, ProviderMeta } from "./types";
import { claudeProvider } from "./claude";

/**
 * Every provider Debaitify knows about.
 *
 * Only Claude is implemented today. The others are listed with
 * `available: false` so the Options page can show where this is going without
 * pretending they work — a disabled option is more honest than a hidden one.
 */
const ENTRIES: ProviderEntry[] = [
  claudeProvider,
  declared({
    id: "openai",
    label: "OpenAI",
    apiKeyLabel: "OpenAI API key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
  }),
  declared({
    id: "gemini",
    label: "Google Gemini",
    apiKeyLabel: "Google AI Studio key",
    apiKeyUrl: "https://aistudio.google.com/apikey",
  }),
  declared({
    id: "ollama",
    label: "Ollama (local)",
    apiKeyLabel: "Not required",
    apiKeyUrl: "https://ollama.com",
  }),
];

export const PROVIDERS: ReadonlyMap<string, ProviderEntry> = new Map(
  ENTRIES.map((e) => [e.meta.id, e]),
);

export const DEFAULT_PROVIDER = "claude";

export function providerMetas(): ProviderMeta[] {
  return ENTRIES.map((e) => e.meta);
}

export function getProvider(id: string): ProviderEntry | null {
  return PROVIDERS.get(id) ?? null;
}

/** Resolves a provider/model pair, falling back to the default when a stored
 *  setting names something unknown or not yet implemented. */
export function createClient(
  providerId: string,
  model: string,
  apiKey: string,
): { client: ModelClient; providerId: string; model: string } | null {
  const entry = getProvider(providerId) ?? getProvider(DEFAULT_PROVIDER);
  if (!entry?.meta.available) return null;
  const chosen = entry.meta.models.some((m) => m.id === model)
    ? model
    : entry.meta.defaultModel;
  return {
    client: entry.create({ apiKey, model: chosen }),
    providerId: entry.meta.id,
    model: chosen,
  };
}

/** A provider we intend to support but have not written yet. */
function declared(meta: Omit<ProviderMeta, "models" | "defaultModel" | "available">): ProviderEntry {
  return {
    meta: { ...meta, models: [], defaultModel: "", available: false },
    create: () => {
      throw new Error(`provider "${meta.id}" is not implemented yet`);
    },
    testKey: async () => ({
      ok: false,
      detail: `${meta.label} is not supported yet.`,
    }),
  };
}
