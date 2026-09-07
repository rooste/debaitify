import { storage } from "../shared/platform";
import { log } from "../shared/log";
import type { FailureReason, RewriteResult } from "../shared/messages";
import type { Settings } from "../shared/settings";

/**
 * Article cache.
 *
 * Under bring-your-own-key the user pays for every regeneration, so this is a
 * correctness requirement rather than an optimization: a refresh, a revisit or a
 * second tab must cost zero tokens.
 *
 * One storage key per article rather than a single map, so a write touches
 * ~200 bytes instead of rewriting the whole cache. chrome.storage.local has no
 * write-rate limit (unlike storage.sync), so per-entry writes are free.
 */

const MAX_ENTRIES = 500;
const COUNT_KEY = "cacheCount";
const PREFIX = "c:";

export type CacheStatus = "ok" | Extract<FailureReason, "refusal" | "invalid-output">;

/**
 * Where the facts came from. A front-page rewrite is grounded only in the
 * publisher's lead sentence; an article-page rewrite reads the whole body. Both
 * are cached under the same article id, so the article path must be able to
 * refuse the weaker one and regenerate.
 */
export type CacheOrigin = "lead" | "body";

export interface CacheEntry {
  status: CacheStatus;
  origin: CacheOrigin;
  /** null unless status === "ok". */
  headline: string | null;
  original: string;
  /** Provider and model that produced this entry; a change to either is a miss,
   *  which is how switching models invalidates without a purge. */
  provider: string;
  model: string;
  promptVersion: number;
  createdAt: number;
  lastUsedAt: number;
}

interface ReadContext {
  provider: string;
  model: string;
  promptVersion: number;
  settings: Settings;
  /** Which provenances the caller will accept. Article pages pass ["body"]. */
  accept: readonly CacheOrigin[];
}

/**
 * A hit requires the entry to exist, to have been produced by the current model
 * and prompt, and to be inside its TTL. Anything else is a miss — which is how
 * changing the model or editing the prompt invalidates without a purge.
 */
export async function read(
  key: string,
  ctx: ReadContext,
): Promise<RewriteResult | null> {
  const entry = await storage.get<CacheEntry>(key);
  if (!entry) return null;

  if (
    entry.model !== ctx.model ||
    entry.provider !== ctx.provider ||
    entry.promptVersion !== ctx.promptVersion
  ) {
    log.debug("cache miss (provider/model/prompt changed)", key);
    return null;
  }
  // An older entry without `origin` predates provenance tracking; treat it as
  // lead-grade, the weaker of the two.
  if (!ctx.accept.includes(entry.origin ?? "lead")) {
    log.debug("cache miss (weaker provenance than required)", key);
    return null;
  }
  if (age(entry) > ttlMs(entry.status, ctx.settings)) {
    log.debug("cache miss (expired)", key);
    await storage.remove(key);
    return null;
  }

  // Touch for LRU. Deliberately not awaited: a hit must not wait on a write.
  void storage.set({ [key]: { ...entry, lastUsedAt: Date.now() } });

  if (entry.status === "ok") {
    if (entry.headline) {
      return { ok: true, headline: entry.headline, source: "cache" };
    }
    // "ok" with no headline is a corrupt entry. Drop it and re-generate rather
    // than reporting a failure the caller cannot act on.
    log.warn("dropping corrupt cache entry", key);
    await storage.remove(key);
    return null;
  }
  return { ok: false, reason: entry.status, lead: "" };
}

export type TtlSettings = Pick<Settings, "cacheTtlDays" | "negativeCacheTtlHours">;

export async function write(
  key: string,
  entry: Omit<CacheEntry, "createdAt" | "lastUsedAt">,
  ttl: TtlSettings,
): Promise<void> {
  const now = Date.now();
  const existed = (await storage.get<CacheEntry>(key)) !== undefined;
  await storage.set({ [key]: { ...entry, createdAt: now, lastUsedAt: now } });

  if (existed) return;
  const count = ((await storage.get<number>(COUNT_KEY)) ?? 0) + 1;
  await storage.set({ [COUNT_KEY]: count });
  if (count > MAX_ENTRIES) await sweep(ttl);
}

/** TTL sweep, then LRU eviction back down to the cap. Rare and cheap: 500
 *  entries of ~200 bytes is ~100 KB against a 10 MB quota. */
export async function sweep(ttl: TtlSettings): Promise<void> {
  const all = await storage.getMany(null);
  const entries: Array<[string, CacheEntry]> = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PREFIX) && isEntry(v)) entries.push([k, v]);
  }

  const doomed = new Set<string>();
  for (const [k, e] of entries) {
    if (age(e) > ttlMs(e.status, ttl)) doomed.add(k);
  }

  const survivors = entries
    .filter(([k]) => !doomed.has(k))
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const excess = survivors.length - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) doomed.add(survivors[i]![0]);

  if (doomed.size > 0) await storage.remove([...doomed]);
  await storage.set({ [COUNT_KEY]: entries.length - doomed.size });
  log.debug(`cache sweep: removed ${doomed.size}, kept ${entries.length - doomed.size}`);
}

export async function purge(): Promise<number> {
  const all = await storage.getMany(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length > 0) await storage.remove(keys);
  await storage.set({ [COUNT_KEY]: 0 });
  return keys.length;
}

export async function count(): Promise<number> {
  return (await storage.get<number>(COUNT_KEY)) ?? 0;
}

function age(e: CacheEntry): number {
  return Date.now() - e.createdAt;
}

function ttlMs(status: CacheStatus, ttl: TtlSettings): number {
  return status === "ok"
    ? ttl.cacheTtlDays * 24 * 60 * 60 * 1000
    : ttl.negativeCacheTtlHours * 60 * 60 * 1000;
}

function isEntry(v: unknown): v is CacheEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as CacheEntry).createdAt === "number" &&
    typeof (v as CacheEntry).status === "string"
  );
}
