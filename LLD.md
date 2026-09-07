# Debaitify — Low-Level Design

> **Scope note (2026-09-07):** this document describes the original
> article-page-first design. The project has since been refocused on
> **front-page teaser rewriting**, and headline generation now sits behind a
> pluggable provider seam with a user-selectable strategy. See
> [README.md](./README.md) for current behaviour; this file is being rewritten.

**Status:** Draft v1 · **Date:** 2026-09-06 · Companion to [HLD.md](./HLD.md)

This document is written to be implementable without further design work. Where
a value must be verified against a live site or a live API response, it is marked
**⚠ verify**.

---

## 1. Stack and tooling

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, `strict: true` | |
| Bundler | `vite` + `@crxjs/vite-plugin` | HMR for content scripts; emits a valid MV3 bundle |
| Extraction | `@mozilla/readability` | Runs in the content script |
| API client | `@anthropic-ai/sdk` | Official SDK; see §8 for the browser flag |
| Schema | `zod` + `@anthropic-ai/sdk/helpers/zod` | Structured output for the generated headline |
| Test | `vitest` + `jsdom`; `playwright` for the DOM-swap smoke test | |
| Lint/format | `eslint` + `prettier` | |

No remote code, no CDN scripts, no `eval` — MV3 forbids them and a review would
reject them anyway.

## 2. Repository layout

```
debaitify/
├── manifest.config.ts          # manifest as typed source; content_script matches
│                               # are GENERATED from sites.json at build time
├── vite.config.ts
├── src/
│   ├── content/
│   │   ├── content-script.ts   # entry: lifecycle orchestration
│   │   ├── antiflash.ts        # hide/reveal/timeout state machine
│   │   ├── extract.ts          # config-driven extraction, Readability fallback
│   │   ├── swap.ts             # DOM mutation + revert affordance
│   │   └── navigation.ts       # MutationObserver + history hooks
│   ├── background/
│   │   ├── service-worker.ts   # entry: runtime.onMessage router
│   │   ├── provider.ts         # HeadlineProvider interface
│   │   ├── claude.ts           # ClaudeDirectProvider
│   │   ├── prompt.ts           # system prompt (carries PROMPT_VERSION)
│   │   ├── cache.ts            # article-ID keyed store, TTL + LRU + negative
│   │   └── queue.ts            # concurrency cap, in-flight dedupe
│   ├── sites/
│   │   ├── sites.json          # ← ALL per-site knowledge lives here
│   │   ├── schema.ts           # zod schema + SiteConfig types
│   │   └── resolve.ts          # load, validate, merge overrides, host lookup
│   ├── options/                # options page (incl. site-config editor)
│   ├── popup/                  # toolbar popup (status + revert)
│   ├── shared/
│   │   ├── messages.ts         # message contract types
│   │   ├── settings.ts         # settings schema + defaults
│   │   ├── text.ts             # normalization (soft hyphens, whitespace)
│   │   ├── platform.ts         # thin chrome.* wrapper (Firefox seam)
│   │   └── log.ts              # namespaced debug logging, off by default
│   └── styles/antiflash.css
├── tests/
│   └── fixtures/               # saved real article HTML — see §17
├── HLD.md
├── LLD.md
├── PRIVACY.md
└── README.md
```

**The two entry points must not share a basename.** With both named `index.ts`
the bundler emitted colliding chunk names and the service-worker loader imported
the content-script chunk instead; the extension loaded without any error and did
nothing. Hence `service-worker.ts` and `content-script.ts`.

Note the build-time coupling: `manifest.config.ts` reads `sites.json` and emits
one `content_scripts.matches` entry and one `host_permissions` entry per enabled
site. Adding a site is therefore a JSON edit plus a rebuild — see §6.5 for why
user-added hosts cannot be purely runtime in v1.

## 3. Manifest

**Generated, not hand-written.** `manifest.config.ts` reads `src/sites/sites.json`
and emits one `content_scripts.matches` glob and one `host_permissions` entry per
`enabled` site, so a site added to the JSON cannot drift out of sync with the
permissions the extension actually holds. The output for the shipped config:

```jsonc
{
  "manifest_version": 3,
  "name": "Debaitify",
  "version": "0.1.0",
  "description": "Replaces clickbait headlines with accurate ones generated from the article.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://api.anthropic.com/*",
    "https://www.iltalehti.fi/*",
    "https://www.is.fi/*"
  ],
  "background": { "service_worker": "src/background/service-worker.ts", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://www.iltalehti.fi/*", "https://www.is.fi/*"],
      "js": ["src/content/content-script.ts"],
      "css": ["src/styles/antiflash.css"],
      "run_at": "document_start",
      "all_frames": false
    }
  ],
  "options_ui": { "page": "src/options/index.html", "open_in_tab": true },
  "action": { "default_popup": "src/popup/index.html" },
  "icons": { "16": "...", "48": "...", "128": "..." }
}
```

Notes:

- `run_at: "document_start"` is required — the CSS must be in place before the
  headline paints. The script's *work* still waits for DOM readiness (§11).
- No `tabs`, no `activeTab`, no `<all_urls>`. Keeping `host_permissions` to three
  specific origins is what makes an eventual store review tractable.
- `matches` uses `https://www.iltalehti.fi/*` rather than a path-scoped glob: the
  sites are SPAs, so a reader can navigate from the front page into an article
  without a document load. The script must already be running. Whether a given
  page is an *article* is decided by `sites.json` (§4.4), not by the manifest.
- Adding a host at runtime (HLD O1, §6.5) would need `optional_host_permissions`
  plus `chrome.scripting.registerContentScripts` — deliberately not in v1.

## 4. Storage schemas

Three namespaces in `chrome.storage.local`.

### 4.1 Settings — key `settings`

```ts
export interface Settings {
  apiKey: string;                          // "" until configured
  model: "claude-opus-5" | "claude-haiku-4-5";
  siteEnabled: Record<string, boolean>;    // by site id: { iltalehti: true }
  revealTimeoutMs: number;                 // default 1500
  cacheTtlDays: number;                    // default 30
  negativeCacheTtlHours: number;           // default 24
  debug: boolean;                          // default false
}
```

### 4.2 Site config overrides — key `siteOverrides`

A partial, deep-merged over bundled `sites.json` (§6.4). Absent by default.

### 4.3 Cache — one storage key per article

Key format: `c:<siteId>:<articleId>` — e.g. `c:iltalehti:8f7fd0a3-4819-…`.

One key per entry rather than a single map, so a write touches ~200 bytes
instead of rewriting the whole cache. `chrome.storage.local` has no write-rate
limit (unlike `storage.sync`), so per-entry writes are free.

```ts
type CacheStatus = "ok" | "refusal" | "invalid-output";

interface CacheEntry {
  status: CacheStatus;
  headline: string | null;   // null unless status === "ok"
  original: string;
  model: string;             // invalidates on model change
  promptVersion: number;     // invalidates on prompt change
  createdAt: number;
  lastUsedAt: number;
}
```

**Read is a hit only if** the entry exists, `model` matches the current setting,
`promptVersion` matches `PROMPT_VERSION`, and it is inside TTL — 30 days for
`ok`, 24 hours for the two negative statuses. Anything else is a miss.

**Never written:** `rate-limited`, `api-error`, `timeout`, `no-api-key`. Those
are transient and must stay retryable; caching them would let one dropped
connection blank an article for a month.

**Why negative caching exists at all:** a refusal costs tokens. Under BYO-key
(HLD §3) refreshing a refused article five times must not bill five times.

### 4.4 Article ID extraction

```ts
export function articleKey(url: URL, site: SiteConfig): string | null {
  const m = new RegExp(site.article.urlPattern).exec(url.pathname);
  const id = m?.groups?.id;
  return id ? `c:${site.id}:${id}` : null;
}
```

Verified against both sites:

| URL path | Site | Extracted id |
|---|---|---|
| `/ulkomaat/a/8f7fd0a3-4819-45d5-a4cd-21bb02e68602` | iltalehti | `8f7fd0a3-4819-45d5-a4cd-21bb02e68602` |
| `/ulkomaat/art-2000012255625.html` | ilta-sanomat | `2000012255625` |

Because the key is the article ID and not the URL, the front-page link, the
canonical URL, a UTM-decorated share link and a `#comments` anchor all collapse
to the same cache entry. `null` (no ID extractable) means "not an article" and
the pipeline stops there — this is also the article-page test, so there is no
separate `isArticle` call.

Since v1 only ever runs on configured sites, there is no unknown-site key path.
If P2 adds runtime hosts (§6.5), those sites get a config entry too — and a site
config without a working `urlPattern` is simply a site Debaitify does not act on,
which is the correct failure mode.

### 4.5 Eviction

Maintain `cacheCount`. When it exceeds `MAX_ENTRIES = 500`, run a sweep:
`storage.local.get(null)`, drop expired entries, then drop lowest `lastUsedAt`
until at cap. At 500 entries of ~200 bytes the whole cache is ~100 KB against a
10 MB quota, so the sweep is rare and cheap.

## 5. Message contract

`shared/messages.ts` is the single source of truth; both sides import it.

```ts
export type Request =
  | { type: "rewrite"; payload: RewriteRequest }
  | { type: "getStatus" }
  | { type: "purgeCache" };

export interface RewriteRequest {
  key: string;          // "c:<siteId>:<articleId>" from §4.4 — the cache key
  siteId: string;
  original: string;     // the clickbait headline, for the cache entry and revert
  body: string;         // extracted article text, title stripped
  lead: string;         // publisher's own summary; "" if absent (§7.5)
  lang: string;         // BCP-47 from <html lang>, defaults to "fi"
}

export type RewriteResult =
  | { ok: true; headline: string; source: "cache" | "api" }
  | { ok: false; reason: FailureReason; lead: string; detail?: string };

export type FailureReason =
  | "no-api-key"      // options page not filled in        — not cached
  | "disabled"        // site toggled off                  — not cached
  | "refusal"         // stop_reason === "refusal"         — CACHED 24 h
  | "invalid-output"  // failed validation in §8.4         — CACHED 24 h
  | "rate-limited"    // 429 after retries                 — not cached
  | "api-error"       // 4xx/5xx/network                   — not cached
  | "timeout";        //                                   — not cached
```

Note the URL is **not** in `RewriteRequest`. The content script resolves the
article key itself and sends that; the worker never learns which page the user is
on beyond the site id. That is a small privacy win and it makes the worker's
cache logic trivially testable.

Every `FailureReason` maps to exactly one content-script behaviour: **reveal the
original headline unchanged.** The distinction drives two things only — what the
popup shows, and whether the worker writes a negative cache entry (§4.3). The
`lead` is echoed back on failure so the popup can offer the publisher's own
summary when there is no key configured.

## 6. Site configuration (JSON)

All per-site knowledge is data, not code. `src/sites/sites.json` is the single
source; nothing about Iltalehti or IS appears in a `.ts` file.

### 6.1 Schema

```ts
export const SiteConfig = z.object({
  id:      z.string(),                    // stable; used in cache keys
  label:   z.string(),
  enabled: z.boolean(),
  hosts:   z.array(z.string()).min(1),    // exact hostname matches
  article: z.object({
    urlPattern: z.string(),               // RegExp on pathname, named group `id`
  }),
  headline: z.object({ selectors: z.array(z.string()).min(1) }),
  lead:     z.object({ selectors: z.array(z.string()) }),
  body: z.object({
    containers: z.array(z.string()).min(1),
    paragraphs: z.array(z.string()).min(1),
    strip:      z.array(z.string()),
  }),
  paywall: z.object({
    useJsonLd:    z.boolean(),            // read schema.org isAccessibleForFree
    selectors:    z.array(z.string()),    // presence ⇒ paywalled
    minFreeChars: z.number(),
  }),
  minBodyChars: z.number(),
  maxBodyChars: z.number(),
});

export const SitesFile = z.object({
  schemaVersion: z.literal(1),
  promptVersion: z.number(),
  sites: z.array(SiteConfig),
});
```

**Every selector field is an ordered candidate list.** `resolve.ts` returns the
first that matches. Precise selector first, structural fallback last — this is
the whole resilience strategy for IS, whose headline classes are
design-token-generated and will churn (HLD §5.2).

### 6.2 Shipped configuration

The committed `sites.json` was validated against live HTML from both sites on
2026-09-06 — every field below resolved successfully (§17).

```jsonc
{
  "id": "iltalehti",
  "hosts": ["www.iltalehti.fi", "iltalehti.fi", "m.iltalehti.fi"],
  "article": { "urlPattern": "^/[a-z0-9-]+/a/(?<id>[0-9a-f]{8}-…-[0-9a-f]{12})/?$" },
  "headline": { "selectors": ["h1.article-headline", "[itemprop='headline']",
                              "article h1", "h1"] },
  "lead":     { "selectors": [".article-description", "[itemprop='description']"] },
  "body": {
    "containers": [".article-body", "article .article-content"],
    "paragraphs": ["p.paragraph", "p"],
    "strip": ["figure", ".media-caption", ".related-articles-list",
              ".related-article", ".ad-article", "[class*='mainos']",
              "[class*='ad-']", "script", "style", "aside"]
  },
  "paywall": { "useJsonLd": true, "selectors": [".paywall-section", "[class*='paywall']"] }
}
```

Ilta-Sanomat differs in every field — `art-<digits>.html` URLs, `[class*=…]`
selectors throughout, `p` rather than `p.paragraph` — which is exactly the point
of externalizing it. See the committed file for the full entry.

### 6.3 Resolution rules

```ts
function selectFirst(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      log.warn("invalid selector in site config", sel);   // never throw
    }
  }
  return null;
}
```

A malformed selector in a user override must degrade to "try the next one", not
crash the content script. `querySelector` throws `SyntaxError` on invalid CSS,
so the `try` is load-bearing, not defensive noise.

### 6.4 User overrides and the editor

Effective config = bundled `sites.json` deep-merged with `siteOverrides` from
storage, then validated by the zod schema. **On validation failure the override
is discarded entirely** and bundled config is used, with the error surfaced in
Options — a broken override must never brick the extension.

The Options page ships a textarea editor with: live validation, a per-site
"Test against current tab" button that reports which selector matched each
field and how many characters the body extracted to, and "Reset to defaults".
That test button is the debugging tool for the entire project.

### 6.5 The host-permission constraint (honest limitation)

`content_scripts.matches` is static in `manifest.json`. A user who adds a new
site to their override JSON will find the content script never runs there.

v1 therefore scopes overrides to **tuning existing sites** — changing selectors,
strip lists, patterns. Adding a *host* requires `optional_host_permissions` plus
`chrome.scripting.registerContentScripts` at runtime, which is P2. This is
stated in the Options UI rather than left for the user to discover.

## 7. Extraction

Config-driven first (AD-3), Readability as fallback. The config path is used for
the two known sites; Readability covers redesigns and anything unknown.

```ts
export function extract(doc: Document, site: SiteConfig): Extracted | null {
  if (isPaywalled(doc, site)) return null;
  return extractByConfig(doc, site) ?? extractByReadability(doc, site);
}
```

### 7.1 Config path

```ts
function extractByConfig(doc: Document, site: SiteConfig): Extracted | null {
  const container = selectFirst(doc, site.body.containers);
  if (!container) return null;

  const work = container.cloneNode(true) as Element;      // never mutate the live DOM
  for (const sel of site.body.strip) {
    try { work.querySelectorAll(sel).forEach(n => n.remove()); } catch {}
  }

  const psel = site.body.paragraphs.find(s => safeCount(work, s) > 0);
  if (!psel) return null;
  const body = normalize([...work.querySelectorAll(psel)]
    .map(p => p.textContent ?? "").join(" "));

  return gate(body, doc, site);
}
```

`cloneNode` matters: the container is live DOM the reader is looking at, and
`strip` would otherwise delete images and related-article blocks from the page.

Measured against the committed fixtures: Iltalehti yields 11 paragraphs /
1,965 chars; IS yields 14 paragraphs / 1,999 chars.

### 7.2 Readability path

```ts
function extractByReadability(doc: Document, site: SiteConfig): Extracted | null {
  const clone = doc.cloneNode(true) as Document;          // Readability is destructive
  for (const sel of site.body.strip) {
    try { clone.querySelectorAll(sel).forEach(n => n.remove()); } catch {}
  }
  if (!isProbablyReaderable(clone)) return null;
  const article = new Readability(clone).parse();
  if (!article?.textContent) return null;
  let body = normalize(article.textContent);
  if (article.title) body = stripLeadingTitle(body, article.title);
  return gate(body, doc, site);
}
```

`stripLeadingTitle` is the single most important line in the extractor. If
Readability prefixes the title to the text, the model anchors on the clickbait
phrasing it is meant to replace and reliably returns a paraphrase of it.

### 7.3 Normalization and the gate

```ts
export function normalize(s: string): string {
  return s
    .replace(/\u00AD/g, "")        // soft hyphens — present in IL titles (HLD §5.6)
    .replace(/\s+([.,;:!?])/g, "$1")  // inline-element joins leave " ."
    .replace(/\s+/g, " ")
    .trim();
}

function gate(body: string, doc: Document, site: SiteConfig): Extracted | null {
  if (body.length < site.minBodyChars) return null;      // stub / paywall / video page
  return {
    body: body.slice(0, site.maxBodyChars),
    lead: selectFirst(doc, site.lead.selectors)?.textContent?.trim() ?? "",
    lang: doc.documentElement.lang || "fi",
  };
}
```

### 7.4 Paywall detection

```ts
function isPaywalled(doc: Document, site: SiteConfig): boolean {
  if (site.paywall.useJsonLd) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(s.textContent ?? "");
        for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
          if (node?.["@type"] === "NewsArticle" && node.isAccessibleForFree === false)
            return true;
        }
      } catch {}
    }
  }
  return !!selectFirst(doc, site.paywall.selectors);
}
```

IS ships `isAccessibleForFree` and `hasPart.cssSelector: ".paywall-section"` —
this works today. **Iltalehti ships no JSON-LD at all**, so IL falls through to
the selector list and ultimately to `minBodyChars`. Confirming an IL Plus marker
needs a paywalled fixture (HLD O5) — ⚠ open.

### 7.5 The lead as a zero-cost fallback

`gate` captures the publisher's own lead sentence. It is not used in v1's happy
path, but it is carried into `RewriteResult` so the popup can offer it when
there is no API key, and so P3 can evaluate lead-substitution (HLD §6 route 3)
without re-plumbing extraction.

## 8. Headline generation

### 8.1 Client construction

The Anthropic TypeScript SDK **refuses to run in a browser context unless
`dangerouslyAllowBrowser: true` is set** — it disables browser use by default
specifically to avoid shipping secret credentials to a client. In a
bring-your-own-key extension that warning is understood and accepted: the key is
the user's own, entered by them, stored in their own profile, and confined to the
service worker. Set the flag knowingly, and document it in `PRIVACY.md`.

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey,
  dangerouslyAllowBrowser: true,
  maxRetries: 2,          // SDK retries 429/5xx/connection errors with backoff
  timeout: 20_000,        // ms in the TS SDK; default 10 min is far too patient here
});
```

Construct lazily and rebuild whenever the stored key changes; never cache a
client across a key edit.

**Resolved (verified against `@anthropic-ai/sdk` 0.124.0):** no manual header is
needed. The SDK adds `anthropic-dangerous-direct-browser-access: true` to every
request whenever `dangerouslyAllowBrowser` is set — the header is gated on the
*option*, not on runtime browser detection (`client.js:839`). The constructor's
browser check short-circuits on the same option, so `isRunningInBrowser()` is
never called and cannot misfire inside a service worker.

### 8.2 Prompt

```ts
export const SYSTEM_PROMPT = `You rewrite news headlines.

You will be given the body text of a news article. Write one headline that
states what the article is actually about.

Rules:
- Write in the same language as the article. Finnish article, Finnish headline.
- State the subject and the outcome. Never withhold either to create curiosity.
- Maximum 12 words. Shorter is better.
- Use only facts present in the article body. Invent nothing.
- No question marks, no "tama", no "katso", no "nain", no ellipses, no
  ALL CAPS, no emoji.
- Plain declarative sentence. No sensationalism, no editorialising, no
  scare quotes.
- Output the headline only.`;
```

The user message is the body text alone. The original clickbait headline is
**deliberately not sent** — supplying it biases the rewrite toward its framing,
and it is not needed for the task.

### 8.3 Request

```ts
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const HeadlineSchema = z.object({
  headline: z.string().describe("The rewritten headline, in the article's language."),
});

const response = await client.messages.parse({
  model: settings.model,                 // "claude-opus-5"
  max_tokens: 512,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: body }],
  thinking: { type: "adaptive" },
  output_config: {
    effort: "low",                       // simple task; keeps latency and cost down
    format: zodOutputFormat(HeadlineSchema),
  },
});
```

Parameter rationale:

- **`thinking: { type: "adaptive" }` with `effort: "low"`** rather than
  `thinking: { type: "disabled" }`. On Claude Opus 5, disabling thinking has
  known failure modes (leaked internal tags in the visible response); low effort
  achieves the cost and latency goal without them.
- **`max_tokens: 512`**, not 30. The cap counts thinking tokens too; a tight cap
  truncates mid-thought and the request has to be retried. The structured output
  format, not `max_tokens`, is what keeps the headline short.
- **Non-streaming.** The response is one short string; streaming buys nothing and
  complicates the worker.
- **No prompt caching.** Every article is a different prefix and the system
  prompt is well under the ~1024-token minimum cacheable prefix. It would not
  cache even if requested.

**Model-specific branch.** `claude-haiku-4-5` does not accept `output_config.effort`
and does not support adaptive thinking. The Haiku path must omit both `thinking`
and `effort` and send only `format`. Encode this as a per-model config object
rather than an `if` scattered through `claude.ts`:

```ts
const MODEL_CONFIG = {
  "claude-opus-5":    { thinking: { type: "adaptive" as const }, effort: "low" as const },
  "claude-haiku-4-5": {},
} as const;
```

### 8.4 Response handling

```ts
if (response.stop_reason === "refusal") {
  // stop_details is populated only for refusals — guard before reading.
  log.info("refused", response.stop_details?.category);
  return { ok: false, reason: "refusal" };
}
const headline = response.parsed_output?.headline?.trim();   // null if parsing failed
if (!headline || !isAcceptable(headline, extracted)) {
  return { ok: false, reason: "invalid-output" };
}
return { ok: true, headline, source: "api" };
```

Refusals are expected in normal operation — these are tabloids, and crime and
violence coverage is routine. A refusal is a revert, not an error. (Server-side
refusal fallbacks to another model exist, but they add a beta code path to buy
nothing a revert doesn't already give us here; revisit only if refusals turn out
to be common enough to be annoying.)

`isAcceptable` is a cheap output guard, not a quality judge:

```ts
function isAcceptable(h: string, src: Extracted): boolean {
  if (h.length < 15 || h.length > 120) return false;
  if (h.split(/\s+/).length > 14) return false;        // prompt says 12; allow slack
  if (/^["'“]|[?…]|[A-ZÄÖÅ]{5,}/.test(h)) return false;
  if (h.toLowerCase() === src.title.toLowerCase()) return false;
  return true;
}
```

Log `response.usage` (`input_tokens` / `output_tokens`) behind the debug flag so
the HLD §11 cost table can be replaced with measurements.

### 8.5 Error mapping

```ts
try { /* ... */ }
catch (err) {
  if (err instanceof Anthropic.AuthenticationError) return fail("no-api-key");
  if (err instanceof Anthropic.RateLimitError)      return fail("rate-limited");
  if (err instanceof Anthropic.APIConnectionError)  return fail("api-error");
  if (err instanceof Anthropic.APIError)            return fail("api-error", err.message);
  throw err;
}
```

Order matters: check the specific classes before `APIError`, and check
`APIConnectionError` before `APIError` — in the TypeScript SDK it is a subclass.

## 9. Queue

`background/queue.ts`:

- **In-flight dedupe:** `Map<normalizedUrl, Promise<RewriteResult>>`. Two frames
  or a fast double-navigation must not produce two billed calls.
- **Concurrency cap:** 2. v1 handles one visible article at a time; the cap exists
  for the front-page feature and to stay clear of rate limits.
- **Backoff:** the SDK's own retry (2 attempts, exponential) is sufficient. Do not
  layer a second retry loop on top — the effective wall clock is already
  `timeout × (maxRetries + 1)`.

## 10. Anti-flash and DOM swap

### 10.1 CSS (`styles/antiflash.css`, injected at `document_start`)

```css
[data-debaitify="pending"] {
  opacity: 0 !important;
  transition: opacity 120ms ease-in;
}
[data-debaitify="done"], [data-debaitify="reverted"] {
  opacity: 1;
  transition: opacity 120ms ease-in;
}
```

`opacity`, never `display: none` or `visibility: hidden` on a block element — the
headline keeps its box, so there is no layout shift when it resolves. The
attribute is set by script, so a page with no headline found is never affected.

### 10.2 State machine (`content/antiflash.ts`)

```
        ┌──────────┐  headline found   ┌─────────┐
 idle ──┤ locating ├──────────────────►│ pending │
        └────┬─────┘                   └────┬────┘
             │ not found                    │
             ▼                     ┌────────┼────────┐
          (no-op)                  │        │        │
                            ok ────▼  fail ─▼  timeout▼
                              ┌──────┐  ┌──────────┐
                              │ done │  │ reverted │
                              └──────┘  └──────────┘
```

`pending` is entered **only** after the headline element is located and the
site config yields an article key (§4.4) — so a non-article page is never
blanked. A
single `setTimeout(revealOriginal, settings.revealTimeoutMs)` is armed on entry
to `pending` and cleared by whichever terminal state arrives first. `done` and
`reverted` are both terminal and both visible; there is no path to a permanently
hidden headline.

Also guard the pathological case: if the service worker is dead or the message
never resolves, `runtime.sendMessage` may reject — treat rejection as `fail`.

### 10.3 Swap (`content/swap.ts`)

```ts
export function swap(el: HTMLElement, next: string) {
  el.dataset.debaitifyOriginal = el.textContent ?? "";
  el.title = `Alkuperäinen: ${el.dataset.debaitifyOriginal}`;
  el.textContent = next;                      // textContent, never innerHTML
  el.dataset.debaitify = "done";
}
```

`textContent` only — the generated string is model output and must never be
parsed as HTML. The original is preserved on the element for the popup's revert
and for hover disclosure; a reader can always see what the publisher wrote.

## 11. Navigation and SPA handling

Both sites are SPAs (HLD §5.1): article pages are server-rendered, but in-site
navigation swaps content without a document load, and front pages render almost
entirely from JS. The content script must therefore treat load as one trigger
among several, not as the trigger.

`content/navigation.ts` fires the pipeline on:

1. `DOMContentLoaded` (the script itself loads at `document_start`).
2. `history.pushState` / `replaceState` (monkey-patched) and `popstate`.
3. A `MutationObserver` on `document.body` — `childList` + `subtree` — debounced
   at **250 ms**, re-running when the resolved headline element is detached or
   its text changes away from what we wrote.

Guards, all of which matter in practice:

- Keep a `processedKey` (the §4.4 article key, not the URL); ignore triggers
  where it is unchanged. Using the article key rather than the URL means a
  tracking-parameter change does not re-trigger the pipeline.
- **Disconnect the observer before writing, reconnect after.** Otherwise the
  swap re-triggers the observer, which re-triggers the swap, forever.
- Cancel any in-flight rewrite on navigation. Carry a monotonic `runId` and drop
  stale results — a late response must never be applied to a different article.

Because the cache is checked from the URL alone (§10 fast path), an SPA
navigation back to a previously read article resolves without extraction and
without a network call.

## 12. Options page and popup

**Options**

- **API key** — password field, with a "Test key" button issuing a `max_tokens: 1`
  ping so a bad key is caught at setup rather than on the first article.
- **Model** — dropdown, `claude-opus-5` default. Changing it invalidates cached
  headlines by `model` mismatch (§4.3) rather than clearing the cache, so
  switching back re-uses the originals.
- **Per-site toggles** — driven by `sites.json`, one row per configured site.
- **Site config editor** — textarea over `siteOverrides` with live zod
  validation, a **"Test against current tab"** button reporting which selector
  matched each field and how many characters the body extracted to, and "Reset to
  defaults". This is the debugging tool for the whole project (§6.4).
- **Reveal timeout** slider (500–3000 ms), **cache** entry count + "Clear cache",
  **debug logging** checkbox.

**Popup** — for the current tab: which site config matched, whether the headline
came from cache or the API, the failure reason if any, the original headline, and
a **Revert** button restoring `dataset.debaitifyOriginal`. When the failure is
`no-api-key`, offer the publisher's `lead` as a one-click substitute. This is the
entire observability story for v1, and it is enough.

## 13. Testing

| Level | Tool | Covers |
|---|---|---|
| Unit | vitest | `articleKey` extraction, `normalize` (soft hyphens!), cache TTL/LRU/negative rules, `stripLeadingTitle`, model-config branch |
| Schema | vitest | `sites.json` validates; a malformed override is rejected and falls back to bundled |
| Unit (DOM) | vitest + jsdom | Config-driven extraction against the committed fixtures — asserts selector, paragraph count and character count per site |
| Contract | vitest, mocked SDK | Error mapping (§8.5), refusal path, invalid-output path, negative-cache write |
| Integration | playwright | Load unpacked against a locally served fixture; assert never-flashed (screenshot at 200 ms), swap occurs, timeout reveals the original |
| Manual | — | ~20 real articles per site, recording model output beside the original |

**Golden numbers.** The fixture tests assert exact extraction sizes, so a site
redesign fails a test rather than silently degrading:

| Fixture | Headline selector hit | Paragraphs | Chars |
|---|---|---|---|
| `iltalehti-ulkomaat-8f7fd0a3.html` | `h1.article-headline` | 11 | 1965 |
| `is-ulkomaat-2000012255625.html` | `h1[class*='article-title']` | 14 | 1999 |

**No test may call the live API.** Mock the SDK at the module boundary.

## 14. Build and load

```bash
npm install
npm run dev      # vite, HMR; load dist/ as an unpacked extension
npm run build    # production bundle to dist/
npm run test
```

Load: `chrome://extensions` → Developer mode → Load unpacked → `dist/`. Then open
Options and paste an API key from `console.anthropic.com`.

`.gitignore` must cover `dist/`, `node_modules/`, `.env*`. There are no secrets
in the repo — the key lives only in the user's browser profile — and none should
ever be added.

## 15. Firefox seam

`shared/platform.ts` wraps every extension API call (`storage`, `runtime`) behind
a promise-returning function. Chrome MV3 and Firefox MV3 differ mainly in the
background declaration (`service_worker` vs `scripts`) and namespace (`chrome`
vs `browser`). Keeping call sites away from the raw namespace makes the eventual
Firefox build a manifest change plus one file, rather than a port.

## 16. Milestone checklist

**P0 — walking skeleton**
- [x] Iltalehti article URL shape and headline selector confirmed against live HTML
- [x] IS article URL shape, headline selector and paywall signal confirmed
- [x] `sites.json` validated end-to-end against both fixtures
- [ ] Vite + CRXJS scaffold; manifest matches generated from `sites.json`
- [x] Direct-browser-access header: SDK sends it automatically (§8.1)
- [ ] **⚠ verify** an Iltalehti Plus article — is there any paywall marker? (HLD O5)
- [ ] Hardcoded key, one live call, headline swaps on screen

**P1 — v1 complete**
- [ ] Site config loader: bundle + override merge + zod validation + safe fallback
- [ ] Config-driven extraction with Readability fallback and the §7.3 gate
- [ ] Service worker provider, queue, error mapping, refusal path
- [ ] Cache per §4.3–4.5: article-ID keys, TTL, negative caching, LRU, in-flight dedupe
- [ ] Anti-flash state machine with hard reveal timeout
- [ ] Navigation observer with the three guards in §11
- [ ] Options page (key, model, per-site toggles, config editor, "Test against tab", purge)
- [ ] Popup: status, cache hit/miss, failure reason, revert
- [ ] Unit + jsdom + playwright suites green, including the golden numbers
- [ ] `PRIVACY.md` written
- [ ] Real cost per article measured from `usage`; HLD §12 corrected

**P2 — polish**
- [ ] Runtime host addition via `optional_host_permissions` + `registerContentScripts` (§6.5)
- [ ] Prompt iteration against the manual quality set

**P3 — exploration**
- [ ] Front-page lead substitution prototype (HLD §6 route 3) — zero-token debaiting

## 17. Fixtures and provenance

Every selector, URL pattern and golden number in this document was validated on
**2026-09-06** against HTML fetched from the live sites:

| Fixture | Source URL |
|---|---|
| `iltalehti-front.html` | `https://www.iltalehti.fi/` |
| `iltalehti-ulkomaat-8f7fd0a3.html` | `https://www.iltalehti.fi/ulkomaat/a/8f7fd0a3-4819-45d5-a4cd-21bb02e68602` |
| `is-front.html` | `https://www.is.fi/` |
| `is-ulkomaat-2000012255625.html` | `https://www.is.fi/ulkomaat/art-2000012255625.html` |

These are not yet committed — capture them into `tests/fixtures/` as the first
P0 task, because every DOM test depends on them and because they are the only
way to reproduce a site-redesign break offline.

Two fixtures still missing, both of which gate an open question:

- **An Iltalehti Plus (paywalled) article** — needed to close HLD O5.
- **A live-blog and a video-only page from each site** — the most likely sources
  of a false-positive article match, since both have an `<h1>` and little body.

Refresh cadence: re-capture fixtures whenever a golden-number test fails. The
failing test *is* the redesign alarm.
