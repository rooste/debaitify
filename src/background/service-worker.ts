import { runtime, onInstalled, openOptionsPage } from "../shared/platform";
import { log, setDebug } from "../shared/log";
import { loadSettings, isSiteEnabled, apiKeyFor } from "../shared/settings";
import type { Settings } from "../shared/settings";
import type {
  BatchRequest,
  BatchResult,
  LookupResult,
  Message,
  RewriteRequest,
  RewriteResult,
  Stats,
} from "../shared/messages";
import { CACHEABLE_FAILURES } from "../shared/messages";
import { createClient, getProvider } from "../providers/registry";
import type { ModelClient } from "../providers/types";
import { generateFromArticle, generateFromTeasers } from "./headlines";
import { PROMPT_VERSION } from "./prompt";
import * as cache from "./cache";
import { run } from "./queue";

/**
 * The service worker is the only place an API key exists. Content scripts send
 * text out and receive strings back; that is the whole of their privilege.
 */

// Without a key the extension silently does nothing, which is indistinguishable
// from being broken. Send the user straight to the one field that matters.
onInstalled((details) => {
  if (details.reason === "install") openOptionsPage();
});

runtime.onMessage(async (raw): Promise<unknown> => {
  const msg = raw as Message;
  const settings = await loadSettings();
  setDebug(settings.debug);

  switch (msg.type) {
    case "lookup":
      return lookup(msg.key, settings);
    case "rewrite":
      return rewrite(msg.payload, settings);
    case "rewriteBatch":
      return rewriteBatch(msg.payload, settings);
    case "stats":
      return {
        entries: await cache.count(),
        hasApiKey: apiKeyFor(settings).length > 0,
        provider: getProvider(settings.provider)?.meta.label ?? settings.provider,
        model: settings.model,
        strategy: settings.strategy,
      } satisfies Stats;
    case "purgeCache":
      return { purged: await cache.purge() };
    default:
      return { ok: false, reason: "api-error", lead: "", detail: "unknown message" };
  }
});

function ctx(settings: Settings, accept: readonly cache.CacheOrigin[]) {
  return {
    provider: settings.provider,
    model: settings.model,
    promptVersion: PROMPT_VERSION,
    settings,
    accept,
  };
}

/** Cache-only probe. Needs no DOM, so it can run at document_start. */
async function lookup(key: string, settings: Settings): Promise<LookupResult> {
  const hit = await cache.read(key, ctx(settings, ["body"]));
  return hit ? { hit: true, result: hit } : { hit: false };
}

/** Resolves the configured provider, or explains why it cannot. */
function client(
  settings: Settings,
): { client: ModelClient } | { reason: "no-api-key" } {
  const key = apiKeyFor(settings);
  if (!key) return { reason: "no-api-key" };
  const resolved = createClient(settings.provider, settings.model, key);
  return resolved ? { client: resolved.client } : { reason: "no-api-key" };
}

/* ---------------------------------------------------------------- *
 * Article pages — grounded in the full article body
 * ---------------------------------------------------------------- */

async function rewrite(
  req: RewriteRequest,
  settings: Settings,
): Promise<RewriteResult> {
  if (!isSiteEnabled(settings, req.siteId)) {
    return { ok: false, reason: "disabled", lead: req.lead };
  }

  const cached = await cache.read(req.key, ctx(settings, ["body"]));
  if (cached) return cached;

  const resolved = client(settings);
  if ("reason" in resolved) {
    return { ok: false, reason: resolved.reason, lead: req.lead };
  }

  return run(req.key, async () => {
    // A request that queued behind another may already have been satisfied.
    const late = await cache.read(req.key, ctx(settings, ["body"]));
    if (late) return late;

    const out = await generateFromArticle(resolved.client, req.body, req.original);

    if (out.ok) {
      await store(req.key, settings, {
        status: "ok",
        origin: "body",
        headline: out.headline,
        original: req.original,
      });
      return { ok: true, headline: out.headline, source: "api" as const };
    }

    if (CACHEABLE_FAILURES.has(out.reason)) {
      await store(req.key, settings, {
        status: out.reason as "refusal" | "invalid-output",
        origin: "body",
        headline: null,
        original: req.original,
      });
    }
    return { ok: false, reason: out.reason, lead: req.lead };
  });
}

/* ---------------------------------------------------------------- *
 * Front pages — one request for every teaser we do not already have
 * ---------------------------------------------------------------- */

const BATCH_SIZE = 40;

async function rewriteBatch(
  req: BatchRequest,
  settings: Settings,
): Promise<BatchResult> {
  const headlines: Record<string, string> = {};
  let fromCache = 0;

  if (!isSiteEnabled(settings, req.siteId)) {
    return { headlines, fromCache: 0, generated: 0, reason: "disabled" };
  }

  const misses: BatchRequest["items"] = [];
  for (const item of req.items) {
    // A body-derived headline is strictly better than a lead-derived one, so
    // take either here.
    const hit = await cache.read(
      `c:${req.siteId}:${item.id}`,
      ctx(settings, ["lead", "body"]),
    );
    if (hit === null) misses.push(item);
    else if (hit.ok) {
      headlines[item.id] = hit.headline;
      fromCache++;
    }
    // A cached decline falls through: that teaser is deliberately left alone.
  }

  if (misses.length === 0) return { headlines, fromCache, generated: 0 };

  const resolved = client(settings);
  if ("reason" in resolved) {
    return { headlines, fromCache, generated: 0, reason: resolved.reason };
  }

  let generated = 0;
  let reason: BatchResult["reason"];

  for (let i = 0; i < misses.length; i += BATCH_SIZE) {
    const chunk = misses.slice(i, i + BATCH_SIZE);
    const ids = chunk.map((c) => c.id).sort().join(",");
    const out = await run(`batch:${req.siteId}:${ids}`, () =>
      generateFromTeasers(resolved.client, chunk),
    );

    if (!out.ok) {
      reason = out.reason;
      break; // transient — leave the rest uncached so they retry later
    }

    for (const item of chunk) {
      const headline = out.headlines[item.id];
      const key = `c:${req.siteId}:${item.id}`;
      if (headline) {
        headlines[item.id] = headline;
        generated++;
        await store(key, settings, {
          status: "ok",
          origin: "lead",
          headline,
          original: item.title,
        });
      } else {
        // The model declined, or the output failed the guard. Remember that, so
        // a refresh does not pay to be told the same thing again.
        await store(key, settings, {
          status: "invalid-output",
          origin: "lead",
          headline: null,
          original: item.title,
        });
      }
    }
  }

  log.debug(`batch: ${fromCache} cached, ${generated} generated`);
  return { headlines, fromCache, generated, ...(reason ? { reason } : {}) };
}

function store(
  key: string,
  settings: Settings,
  entry: {
    status: cache.CacheStatus;
    origin: cache.CacheOrigin;
    headline: string | null;
    original: string;
  },
): Promise<void> {
  return cache.write(
    key,
    {
      ...entry,
      provider: settings.provider,
      model: settings.model,
      promptVersion: PROMPT_VERSION,
    },
    settings,
  );
}
