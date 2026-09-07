/** Single source of truth for the content-script ⇄ service-worker protocol. */

export interface RewriteRequest {
  /** "c:<siteId>:<articleId>" — the cache key, resolved by the content script. */
  key: string;
  siteId: string;
  /** The clickbait headline, kept for the cache entry and for revert. */
  original: string;
  /** Extracted article text, title stripped. */
  body: string;
  /** The publisher's own summary sentence; "" if absent. */
  lead: string;
  /** BCP-47 from <html lang>, defaults to "fi". */
  lang: string;
}

export type Message =
  /** Fast path: cache-only probe. Needs no DOM, so it runs at document_start. */
  | { type: "lookup"; key: string }
  | { type: "rewrite"; payload: RewriteRequest }
  | { type: "rewriteBatch"; payload: BatchRequest }
  | { type: "stats" }
  | { type: "purgeCache" };

export type FailureReason =
  | "no-api-key" // options page not filled in         — not cached
  | "disabled" // site toggled off                     — not cached
  | "refusal" // stop_reason === "refusal"             — cached 24 h
  | "invalid-output" // failed the §8.4 output guard   — cached 24 h
  | "rate-limited" // 429 after SDK retries            — not cached
  | "api-error" // 4xx / 5xx / network                 — not cached
  | "timeout"; //                                      — not cached

/**
 * A reason is cached only when regenerating would cost tokens and produce the
 * same answer. Transient failures must stay retryable — caching a dropped
 * connection would blank an article for the full TTL.
 */
export const CACHEABLE_FAILURES: ReadonlySet<FailureReason> = new Set([
  "refusal",
  "invalid-output",
]);

export type RewriteResult =
  | { ok: true; headline: string; source: "cache" | "api" }
  | { ok: false; reason: FailureReason; lead: string; detail?: string };

export type LookupResult =
  | { hit: true; result: RewriteResult }
  | { hit: false };

export interface Stats {
  entries: number;
  hasApiKey: boolean;
  provider: string;
  model: string;
  strategy: string;
}

/* ------------------------------------------------------------------ *
 * Front-page (teaser) rewriting
 * ------------------------------------------------------------------ */

export interface TeaserInput {
  /** Article id parsed from the teaser's href — the cache key and the join key. */
  id: string;
  /** The clickbait title as rendered. */
  title: string;
  /** The publisher's own lead sentence. "" when the page state has none. */
  lead: string;
}

export interface BatchRequest {
  siteId: string;
  items: TeaserInput[];
}

export interface BatchResult {
  /** id → rewritten headline. Ids absent from the map were left alone, either
   *  because the lead carried no usable facts or because the call failed. */
  headlines: Record<string, string>;
  fromCache: number;
  generated: number;
  reason?: FailureReason;
}

/** Posted from the MAIN-world bridge to the isolated content script. */
export interface BridgeMessage {
  __debaitify: "teasers";
  /** id → lead */
  leads: Record<string, string>;
  source: string;
}
