# Debaitify — High-Level Design

> **Scope note (2026-09-07):** this document describes the original
> article-page-first design. The project has since been refocused on
> **front-page teaser rewriting**, and headline generation now sits behind a
> pluggable provider seam with a user-selectable strategy. See
> [README.md](./README.md) for current behaviour; this file is being rewritten.

**Status:** Draft v2 · **Date:** 2026-09-06 · **Owner:** @rooste

> v2 changes: API-key model settled (§3); site configuration moved to JSON (AD-11);
> caching promoted to a first-class requirement and re-keyed on article ID (AD-12);
> §5 added from live inspection of both target sites; cost table corrected against
> real article sizes.

---

## 1. Problem

Finnish tabloids — primarily **Iltalehti** (`iltalehti.fi`) and **Ilta-Sanomat**
(`is.fi`) — routinely publish headlines engineered for curiosity gap rather than
information: withheld subjects, withheld outcomes, trailing-ellipsis pull quotes.
The article body usually contains the actual news in its first two paragraphs.

A real specimen, captured 2026-09-06:

| | |
|---|---|
| **Published headline** | "Asiantuntijalta todella karu arvio Moskovan tapaamisesta: ”Ei tässä ole tapahtunut mitään sellaista…”" |
| **What the article says** | A Tampere University professor assesses that the Witkoff–Kushner Moscow visit did not move Russia off its terms |

**Debaitify** is a browser extension that reads the article the reader is already
looking at and replaces the clickbait headline in-place with an accurate,
descriptive one generated from the article body.

## 2. Goals and non-goals

### Goals (v1)

| # | Goal |
|---|---|
| G1 | On an Iltalehti or Ilta-Sanomat article page, replace the `<h1>` with an accurate generated headline, in Finnish, before the reader reads the original |
| G2 | Never leave the page worse than without the extension — any failure reverts to the original headline |
| G3 | **Generate each article's headline at most once, ever.** A page refresh, a revisit, or a second tab must cost zero tokens |
| G4 | Run on the user's own Claude API key, entered in an options page |
| G5 | Site knowledge lives in editable JSON, not in compiled code |
| G6 | Installable by a handful of people via unpacked sideload, with no backend |

### Non-goals (v1)

- Rewriting headlines on **front pages / link lists** (see §6 — this is now better understood and still deferred)
- Firefox / Safari packaging (kept *possible* by API discipline, not shipped)
- Chrome Web Store listing
- A hosted proxy that holds the API key
- Detecting *whether* a headline is clickbait — v1 rewrites every matched article
- Any telemetry, analytics, or server-side logging

## 3. Decision: API key model (settled)

**Every user supplies their own Anthropic API key.** This is now fixed, and it is
the decision the rest of the architecture hangs off. Consequences, stated
explicitly so they are not re-litigated later:

| Consequence | Effect on design |
|---|---|
| No backend exists | No hosting cost, no uptime obligation, no abuse surface, no DPA. The extension is a client and nothing else |
| The key lives in the user's browser | It must never enter a content script (§7 AD-2). It is stored in `chrome.storage.local`, which is unencrypted-at-rest — acceptable for a user's own key, and stated plainly in `PRIVACY.md` |
| Cost is borne per-user | Caching stops being an optimization and becomes a **product requirement** (G3). A user watching their own bill will not tolerate paying twice for one article |
| Rate limits are per-user | No global quota to manage; a single reader will never approach a tier-1 limit. No server-side rate limiting to build |
| Distribution is sideload | No store review, no privacy-policy gate, no host-permission scrutiny in v1. Onboarding cost is "paste a key", paid once |
| The SDK must run in a browser context | Requires `dangerouslyAllowBrowser: true`, which exists precisely to stop people shipping *someone else's* key to a client. Here the key is the user's own — the flag is set knowingly and documented |

The one thing this model must not do is calcify. Tier 3 (a hosted proxy) stays
reachable through the `HeadlineProvider` seam in §9.

## 4. Users

1. **Setup (once):** install unpacked, open Options, paste a key, close it.
2. **Reading (constant):** click an iltapaska link, land on the article, see a
   headline that describes the article.

No account, no sign-in, no server-side identity.

## 5. What we are actually working with

Findings from fetching and parsing both sites on 2026-09-06. These are measured,
not assumed, and several of them changed the design.

### 5.1 Article pages are server-rendered; front pages are not

The Iltalehti front page ships a 350 KB document whose `<body>` is
`<div id="app">` plus header/nav chrome and **six** teaser titles. The actual
article grid hydrates client-side from a 268 KB `window.App = {…}` blob. The IS
front page behaves the same way (670 KB, eight article links in the shell).

**Article** pages, by contrast, are fully server-rendered — the `<h1>` is present
in the initial HTML on both sites. This is what makes the anti-flash approach
viable: there is something to hide at `document_start`.

### 5.2 The two sites are structurally opposite

| | Iltalehti | Ilta-Sanomat |
|---|---|---|
| Article URL | `/<category>/a/<uuid>` | `/<category>/art-<digits>.html` |
| Headline | `h1.article-headline[itemprop="headline"]` — semantic, stable | `h1.nof-component-article-title-m-mobile text-nof-foreground-primary sm:…` — design-token utility classes, **will churn** |
| Lead | `.article-description[itemprop="description"]` | `[class*="article-ingress"]` |
| Body | `.article-body` → `p.paragraph` | `.article-body` → `p` |
| JSON-LD | **none** | `NewsArticle` with `isAccessibleForFree` + `hasPart.cssSelector` |
| Headline text | plain | wrapped in a `<span>` |

Two consequences. First, **selectors must be an ordered candidate list**, not a
single string — the precise selector first, a structural one last. Second, both
sites have **exactly one `<h1>` on an article page**, which makes bare `h1` a
genuinely reliable last resort and is the reason a site redesign should degrade
rather than break.

### 5.3 Ilta-Sanomat's paywall is machine-readable; Iltalehti's is not

IS publishes JSON-LD carrying `isAccessibleForFree` and
`hasPart: {cssSelector: ".paywall-section"}`. That is a reliable paywall
detector and it **resolves open question O4** — IS stays a v1 target.

Iltalehti ships no JSON-LD at all, and the free article we sampled contains no
paywall marker of any kind. Detecting IL Plus articles needs a paywalled fixture
we do not yet have; until then the minimum-body-length gate is the defence.

### 5.4 Articles are short — cheaper than estimated

| Site | Words | Characters |
|---|---|---|
| Iltalehti sample | 225 | 1,965 |
| Ilta-Sanomat sample | 233 | 1,999 |

The v1 HLD assumed ~600-word articles. Tabloid articles are a third of that,
which roughly halves the per-article cost (§12).

### 5.5 Both sites already publish an honest summary next to the clickbait

Every article carries a one-sentence lead that is not clickbait:

> **Headline:** "Asiantuntijalta todella karu arvio Moskovan tapaamisesta: ”Ei tässä ole tapahtunut mitään sellaista…”"
> **Lead:** "Asiantuntijan mukaan Yhdysvallat keskittyy taloudellisiin intresseihin."

The front-page hydration state carries the same field as `lead` for every teaser.
Two uses: a **zero-cost fallback** when the API is unavailable or the key is
missing, and a cheap input for eventual front-page work. It is also decent
evidence that the clickbait framing is a deliberate editorial choice rather than
an accident of headline-writing — the honest sentence already exists.

### 5.6 Text needs normalizing before comparison

Front-page titles contain soft hyphens (U+00AD): `Asian­tuntijalta`. Any
title-similarity matching (the fallback headline finder) must strip U+00AD and
normalize whitespace, or it will fail to match a headline against itself.

## 6. Deferred, with new information: front-page rewriting

Now better understood. Three viable routes, none in v1:

1. **DOM observation** of teaser elements as they render. Works from the isolated
   world, no extra permissions. Most likely choice.
2. **Reading `window.App`** for the full teaser list including `lead`. Requires a
   `world: "MAIN"` content script — the blob is a JS object literal containing
   bare `undefined`, so it is not parseable as JSON from outside anyway. More
   power, more attack surface.
3. **Lead substitution** — replace teaser titles with the publisher's own `lead`
   field. Costs nothing, needs no API call, and is available for every teaser.

Route 3 is interesting enough to prototype before route 1: it may deliver most of
the value of front-page debaiting for zero tokens. Deliberately out of v1 scope.

## 7. Components

| Component | Runs in | Responsibility |
|---|---|---|
| **Content script** | Page (isolated world), per matched tab | Locate the headline node, extract article text per site config, request a rewrite, perform the DOM swap, own the anti-flash lifecycle, observe navigation |
| **Site config** | JSON, bundled + user overrides | All per-site knowledge: hosts, article URL pattern and ID extraction, selector candidate lists, strip lists, paywall signals |
| **Extractor** | Content script | Config-driven extraction first, Mozilla `Readability` as fallback, plus a quality gate |
| **Service worker** | Extension background | Sole owner of the API key and the Claude client; cache read/write; in-flight de-duplication; concurrency and error mapping |
| **Cache** | `chrome.storage.local` | Article-ID-keyed store with TTL, LRU, and negative caching |
| **Options page** | Extension page | API key, model, per-site toggles, site-config editor, cache inspector/purge |

**Key boundary:** the API key never enters a content script, and therefore never
shares an execution context with page-controlled code. The content script sends
text out and receives a string back; that is the whole of its privilege.

## 8. Architectural decisions

| ID | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| **AD-1** | Manifest V3, Chrome-first | MV2 is dead; the service worker is the natural home for a privileged network client | — |
| **AD-2** | API call in the **service worker** | Keeps the key out of the tab process; extension-origin fetches with `host_permissions` sidestep the page's CORS context | Calling from the content script |
| **AD-3** | **Config-driven extraction, Readability as fallback** | §5.2 shows both sites have clean body containers; a direct `.article-body → p` read is cleaner, cheaper and more predictable than Readability. Readability still covers unknown sites and redesigns | Readability-only (loses precision), config-only (no graceful degradation) |
| **AD-4** | Selectors are **ordered candidate lists** | IS's utility classes will churn; IL's semantic ones will not. One list expresses both without branching | Single selector per field |
| **AD-5** | **Tier 1 distribution**, BYO key — settled in §3 | Zero operating cost, zero review latency, zero abuse surface | Tier 2 store listing, Tier 3 backend |
| **AD-6** | Default model **`claude-opus-5`**, user-selectable | Best headline quality; `effort: "low"` keeps latency and cost down. A bad headline is worse than no headline, and it is the only thing the product does | Hard-coding a cheap model |
| **AD-7** | **Hide-then-reveal** with a hard timeout, never `display: none` | Prevents the flash without layout shift, and guarantees the headline becomes visible even if everything fails | Pre-fetch on hover, swap-after-paint |
| **AD-8** | **`MutationObserver` + history hooks**, not a one-shot run | Both sites are SPAs that mutate in place (§5.1) | One-shot content script |
| **AD-9** | *(superseded by AD-12)* | | |
| **AD-10** | **Revert on refusal** | Crime coverage is routine on these sites and will occasionally trip a classifier; the graceful product behaviour is already correct | Server-side model fallbacks |
| **AD-11** | **Site configuration in JSON** (`src/sites/sites.json`), bundled defaults merged with user overrides in storage | Selectors are data with a short half-life; treating them as code means a rebuild for a CSS change. JSON lets a user fix a broken site themselves, and lets us ship a fix as a one-line diff. Schema-validated on load, with fallback to bundled config on invalid override | TypeScript adapter modules (v1 design) — precise but requires a build to change a selector |
| **AD-12** | **Cache keyed by `siteId:articleId`**, extracted from the URL by the site config's named regex group | Supersedes AD-9's normalized-URL key. The same article is reachable via tracking-decorated URLs, front-page links, AMP-ish variants and the canonical URL; an ID key collapses all of them to one entry. Falls back to a normalized-URL hash for unknown sites | Normalized URL (misses variants), content hash (requires extraction before the cache check, defeating the fast path) |
| **AD-13** | **Negative caching** of refusals and invalid output; **never** cache transient failures | A refusal costs tokens. Refreshing a refused article five times must not bill five times. Network errors and 429s are transient and must stay retryable | Cache nothing (violates G3), cache everything (a network blip poisons an article for 30 days) |

## 9. The extensibility seam

Everything the content script knows about headline generation is:

```ts
interface HeadlineProvider {
  rewrite(req: RewriteRequest): Promise<RewriteResult>;
}
```

v1 ships one implementation, `ClaudeDirectProvider`, in the service worker. A
future Tier 3 build swaps in `ProxyProvider` — same interface, pointed at a
Debaitify backend — and the content script, site config, cache and DOM logic are
untouched. This is what lets §3 be settled now without foreclosing it.

## 10. Caching (G3)

Elevated from an optimization to a requirement, because under BYO-key the user
pays for every regeneration.

| Property | Design |
|---|---|
| Key | `<siteId>:<articleId>` (AD-12) |
| Store | `chrome.storage.local`, one entry per key, persistent across restarts |
| Survives | Page refresh, tab close, browser restart, URL tracking-parameter churn, front-page link vs canonical URL |
| Positive TTL | 30 days |
| Negative TTL | 24 hours, for `refusal` and `invalid-output` only |
| Never cached | `rate-limited`, `api-error`, `timeout`, `no-api-key` — all retryable |
| Invalidation | Entry carries `promptVersion` and `model`; a mismatch is a miss, so changing the prompt does not serve stale headlines |
| In-flight dedupe | A refresh during generation joins the existing promise rather than starting a second billed call |
| Eviction | 500-entry cap, TTL sweep then LRU |

The fast path — cache hit — must complete before extraction begins. Checking the
cache requires only the URL, which is available at `document_start`.

## 11. Data and privacy

| Data | Where it goes | Retention |
|---|---|---|
| Article body text | `api.anthropic.com`, once per article ever | Per Anthropic's API retention policy |
| Anthropic API key | `chrome.storage.local` only | Until the user clears it |
| Generated headlines | `chrome.storage.local` | 30-day TTL, LRU-capped |
| Browsing history | Nowhere | — |

Debaitify never sends the page URL to the API — only extracted body text. No
analytics. `PRIVACY.md` ships with the extension, because "this reads the page
and sends it to a third party" is a claim a user is entitled to see in writing
before sideloading.

## 12. Cost model (corrected)

Measured article bodies are ~2,000 characters (§5.4). Finnish tokenizes at
roughly 2.5–3 characters per token, so budget ~750 input tokens for the body plus
a ~200-token system prompt, and ~200 output tokens (headline plus low-effort
thinking).

| Model | $/1M in | $/1M out | ≈ cost / article | Articles per $1 |
|---|---|---|---|---|
| `claude-opus-5` (default) | $5.00 | $25.00 | ~$0.010 | ~100 |
| `claude-haiku-4-5` (opt-in) | $1.00 | $5.00 | ~$0.002 | ~500 |

At 20 *new* articles a day: Opus 5 ≈ **$6/month**, Haiku ≈ **$1.20/month**.
Re-reads are free by construction (G3). Still estimates — P1 logs real `usage`
and this table gets corrected from data.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| IS design-token classes churn | IS silently stops working | Ordered candidate selectors ending in bare `h1` (§5.2); JSON config means the fix is a data edit, not a release |
| Site redesign breaks extraction | Extension does nothing | Readability fallback (AD-3) + saved fixtures reproduce the break offline |
| Latency makes the hidden headline feel broken | Bad UX on every article | Hard 1.5 s reveal timeout, non-negotiable |
| Model produces a subtly wrong headline | Misinforms the reader — the one unacceptable failure | Prompt constraints, structured output, length validation, original always on hover and one-click revert |
| IL Plus articles extract to a stub | Headline generated from a teaser | Minimum-length gate; IL paywall detection is an open ⚠ item |
| API key exfiltration | Financial | Key confined to the service worker; no `eval`; no remote code; three specific `host_permissions` |
| A bad user config override | Extension breaks on a site | Schema validation on load, fallback to bundled config, "reset to defaults" in Options |

## 14. Phasing

| Phase | Scope | Estimate |
|---|---|---|
| **P0 — Walking skeleton** | One site, hardcoded key, no cache, headline swap works | ~4 h |
| **P1 — v1 complete** | Both sites via JSON config, config-driven extraction + Readability fallback, cache per §10, anti-flash, navigation observer, options page | ~6 h |
| **P2 — Polish** | Revert toggle, hover-original, per-site toggles, config editor UI, model picker, popup diagnostics | ~1 week of evenings |
| **P3 — Optional** | Front-page lead substitution (§6 route 3), Chrome Web Store, Firefox build | +1–2 days each |

## 15. Open questions

| # | Question | Status |
|---|---|---|
| O1 | Beyond Iltalehti and IS, any v1 domains? | **Closed — no.** Adding a host needs a manifest match, so user-added sites require optional permissions and runtime script registration; that is P2 |
| O2 | Firefox now or later? | **Closed — later.** Avoid Chrome-only APIs so it stays a packaging exercise |
| O3 | Visible toggle in v1 or fire-and-forget? | **Closed — fire-and-forget** on the page, plus a toolbar popup with status and revert |
| O4 | Is IS partial-paywall content extractable? | **Closed — yes**, and paywalled articles are detectable via JSON-LD `isAccessibleForFree` (§5.3) |
| O5 | How do we detect an Iltalehti Plus article? | **Open.** Needs a paywalled IL fixture. Min-length gate is the interim defence |
| O6 | Is the publisher's `lead` good enough to skip the API on front pages? | **Open, worth a P3 prototype** (§6 route 3) |

---

*Implementation detail lives in [LLD.md](./LLD.md). Site data lives in
[`src/sites/sites.json`](./src/sites/sites.json).*
