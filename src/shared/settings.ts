import { storage } from "./platform";

/**
 * How a replacement headline is produced. This is a user choice because the
 * three options trade cost against quality very differently — see the Options
 * page for the per-front-page estimates.
 */
export type Strategy =
  /** Swap in the publisher's own lead sentence. No model, no key, no cost. */
  | "lead"
  /** One batched model call over every teaser's title + lead. */
  | "model-lead"
  /** Fetch each article and rewrite from its full text. Accurate, expensive. */
  | "model-article";

export interface Settings {
  provider: string;
  model: string;
  /** Keyed by provider id, so switching providers does not lose a key. */
  apiKeys: Record<string, string>;
  strategy: Strategy;
  /** Keyed by site id, e.g. { iltalehti: true }. */
  siteEnabled: Record<string, boolean>;
  revealTimeoutMs: number;
  cacheTtlDays: number;
  negativeCacheTtlHours: number;
  debug: boolean;
}

/**
 * These two name a vendor, which nothing else outside src/providers/ does. The
 * alternative — importing the registry here — would drag the provider SDK into
 * the content-script bundle, since settings is loaded on every page. A test
 * asserts these stay in step with the registry instead.
 */
export const DEFAULT_SETTINGS: Settings = {
  provider: "claude",
  model: "claude-opus-5",
  apiKeys: {},
  strategy: "model-lead",
  siteEnabled: {},
  revealTimeoutMs: 1500,
  cacheTtlDays: 30,
  negativeCacheTtlHours: 24,
  debug: false,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await storage.get<Partial<Settings>>(KEY);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await storage.set({ [KEY]: next });
  return next;
}

export function apiKeyFor(settings: Settings): string {
  return settings.apiKeys[settings.provider] ?? "";
}

/** Sites default to enabled: an unconfigured site id is not an opted-out one. */
export function isSiteEnabled(settings: Settings, siteId: string): boolean {
  return settings.siteEnabled[siteId] !== false;
}
