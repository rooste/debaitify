# Debaitify — High-Level Design

**Status:** v3 (current) · **Date:** 2026-09-07 · **Owner:** @rooste

Implementation detail: [LLD.md](./LLD.md). User-facing docs: [README.md](./README.md).

---

## 1. Problem

Iltalehti and Ilta-Sanomat write front-page teasers for the curiosity gap rather
than for information: withheld subjects, withheld outcomes, trailing-ellipsis
pull quotes. The reader scanning a front page cannot tell which stories matter
without clicking, which is the point.

**Debaitify rewrites those teaser headlines in place, on the front page, into
accurate descriptive ones.**

A captured example:

| | |
|---|---|
| **Published** | "Äärioikeistolle murskavoitto – Saksassa tapahtui jotain, mitä ei ole nähty sitten vuoden 1945" |
| **The story** | The far right won the Saxony-Anhalt state election |

## 2. The insight the design rests on

Both sites publish, alongside every clickbait teaser, **a plain factual lead
sentence they wrote themselves**. It sits in the page's hydration state next to
the title.

That single fact sets the economics. Grounding a rewrite in the lead costs one
batched model call per front page (~$0.001). Grounding it in the article text
would mean sixty page fetches and sixty calls (~$0.60). Same product, 500x apart.

The lead is not always usable — live blogs carry boilerplate — so the design must
let the model decline rather than invent. A fabricated headline is worse than a
clickbait one.

## 3. Scope

### In scope

| | |
|---|---|
| **Primary** | Front-page and section-page teaser rewriting on Iltalehti and Ilta-Sanomat |
| **Secondary** | Article-page headline rewriting, grounded in the full body |
| **Model** | Bring-your-own API key. No backend, ever |
| **Distribution** | Unpacked sideload |

### Out of scope (v1)

- Chrome Web Store listing
- Firefox packaging (kept *reachable*, §5.4, not shipped)
- A hosted proxy holding a shared key
- Detecting *whether* a headline is clickbait — every teaser is a candidate
- Telemetry of any kind

## 4. Architecture

```
┌─────────────────────── page (iltalehti.fi) ───────────────────────┐
│                                                                   │
│  MAIN world              │  ISOLATED world                        │
│  ┌────────────────────┐  │  ┌──────────────────────────────────┐  │
│  │ bridge-main.ts     │  │  │ content-script.ts                │  │
│  │ reads window.App   │──┼─▶│  ├─ front.ts   (teasers)         │  │
│  │ posts id→lead map  │  │  │  ├─ extract.ts (article bodies)  │  │
│  └────────────────────┘  │  │  ├─ swap.ts    (DOM writes)      │  │
│                          │  │  └─ antiflash.ts                 │  │
└──────────────────────────┼──┴───────────────┬──────────────────┴──┘
                           │                  │ runtime messages
                           │  ┌───────────────▼──────────────────┐
                           │  │ service worker                   │
                           │  │  ├─ cache.ts   (article-id keyed)│
                           │  │  ├─ queue.ts   (dedupe + limit)  │
                           │  │  └─ headlines.ts (prompts,       │
                           │  │        schemas, output guard)    │
                           │  └───────────────┬──────────────────┘
                           │                  │ ModelClient.generate()
                           │  ┌───────────────▼──────────────────┐
                           │  │ providers/ — the only vendor code│
                           │  └───────────────┬──────────────────┘
                           │                  │ HTTPS
                           │            ┌─────▼─────┐
                           │            │ Claude API│
                           │            └───────────┘
```

**The security boundary is the service worker.** The API key exists there and
nowhere else. A content script sends text out and receives strings back; that is
the whole of its privilege. The MAIN-world bridge is more exposed still — it
shares a global scope with the page — so it reads only and holds nothing.

## 5. Extension points

The project is organized so that the four things most likely to change are each
isolated behind one seam. Adding to any of them should touch one place.

### 5.1 Sites — data, not code

Everything about a site lives in `src/sites/sites.json`: hosts, the article URL
pattern (whose named `id` group becomes the cache key), and **ordered candidate
selector lists** for teasers, headline, lead and body.

Ordered lists are the resilience strategy. Iltalehti's markup is semantic and
stable (`h1.article-headline`); Ilta-Sanomat's is design-token generated
(`nof-component-article-title-m-mobile …`) and will churn. Precise selector
first, structural one last, and a redesign degrades instead of breaking.

Consequences worth stating plainly:

- Fixing a broken site is a **data edit**, not a release.
- Users can override the config from the Options page without rebuilding. An
  invalid override is discarded wholesale rather than applied.
- Adding a **new host** additionally needs a rebuild, because content-script
  matches are static in the manifest. The manifest is generated *from*
  `sites.json`, so the two cannot drift.

### 5.2 Providers — one method

```ts
interface ModelClient {
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}
```

Everything Debaitify needs from an LLM is: given a system prompt, a user message
and a schema, return a value matching that schema. Prompts, batching, output
validation, caching, cost accounting and failure classification all live *above*
that line and are vendor-neutral.

Claude is implemented. OpenAI, Gemini and Ollama are **declared and marked
unavailable** — they appear in the Options dropdown greyed out, because a
disabled option that says "not yet supported" is more honest than hiding the
direction of travel.

A test asserts no vendor name appears outside `src/providers/`, with one
documented exception (§5.5).

### 5.3 Strategies — a user-visible cost/quality dial

| Strategy | Cost / fresh front page | Grounding |
|---|---|---|
| `lead` | free, no key | The publisher's own sentence, verbatim |
| `model-lead` *(default)* | ~$0.001 | Title + lead, one batched call |
| `model-article` | ~$0.60 | Full article text, fetched lazily on scroll |

This is a setting rather than a decision because the options differ by 500x —
that is the user's money, and the right answer depends on how much they read.

Adding a strategy means extending the `Strategy` union and adding a branch in
`front.ts`. The cache, providers and site config are unaffected.

### 5.4 Platform — the Firefox seam

Every extension API call goes through `src/shared/platform.ts`. Chrome MV3 and
Firefox MV3 differ mainly in the background declaration and the namespace
(`chrome` vs `browser`). Keeping call sites away from the raw namespace makes a
Firefox build a manifest change plus one file rather than a port.

### 5.5 The one deliberate coupling

`shared/settings.ts` names `claude` and `claude-opus-5` as defaults. Importing
the provider registry there would drag the vendor SDK into the **content-script
bundle**, since settings load on every page — a real cost for a cosmetic win.
Three tests assert those literals stay in step with the registry.

## 6. How a page is processed

The content script picks one of two modes by asking the site config whether the
current path yields an article id. That single question is the article test;
there is no separate heuristic.

### 6.1 Front pages (primary)

```
teaser anchors found in DOM        →  id parsed from href
MAIN-world bridge supplies leads   →  id → lead
cache consulted per id             →  hits returned free
remainder sent as ONE batch        →  id → headline
titles swapped in place            →  no hiding, no layout shift
```

Titles are **never hidden** on a front page. Blanking sixty headlines for a
second would make the site look broken; the reader is scanning, so a brief
glimpse of the original is the better trade.

### 6.2 Article pages (secondary)

One headline, grounded in the full body. Here hiding *is* right — there is a
single thing to read and a flash of clickbait defeats the purpose — so the
headline is hidden at `document_start` and revealed when the rewrite lands.

Two independent guarantees stop that ever going wrong: a JS reveal timeout, and
a CSS animation failsafe that fires even if the script throws. No code path can
leave a headline permanently invisible.

## 7. Caching

Under bring-your-own-key the user pays for every regeneration, so caching is a
correctness requirement, not an optimization.

| | |
|---|---|
| **Key** | `c:<siteId>:<articleId>` — the id from the URL, not the URL |
| **Why** | The same story appears as a front-page link, a canonical URL and a UTM-decorated share link. An id key collapses all of them |
| **Positive TTL** | 30 days |
| **Negative TTL** | 24 hours, for `refusal` and `invalid-output` only |
| **Never cached** | `rate-limited`, `api-error`, `timeout`, `no-api-key` — transient, must stay retryable |
| **Invalidation** | Entries carry `provider`, `model` and `promptVersion`; a mismatch is a miss, so switching model invalidates rather than deletes |
| **Provenance** | Entries are tagged `lead` or `body`. The article path refuses lead-grade entries and regenerates |

**Negative caching matters more than it looks.** A model declining costs tokens.
Without it, every refresh re-pays to be told the same teaser is unusable.

## 8. Cost

Measured: teaser leads are one sentence; article bodies run ~2,000 characters
(~230 words). Finnish tokenizes at roughly 2.5–3 characters per token.

| | Input | Output | Per front page |
|---|---|---|---|
| `model-lead`, Opus 5 | ~2,500 tok | ~800 tok | **~$0.03** first load, ~0 after cache |
| `model-lead`, Haiku 4.5 | same | same | **~$0.006** |
| `model-article`, Opus 5 | ~60 × 1,000 tok | ~60 × 200 tok | **~$0.60** |

Estimates. The implementation logs real `usage`; this table should be replaced
with measurements once it has run against a live page.

## 9. Privacy and security

| Data | Destination | Retention |
|---|---|---|
| Teaser titles + lead sentences | The configured provider | Provider's policy |
| Article body text (`model-article` only) | Same | Same |
| API keys | `chrome.storage.local` | Until cleared |
| Generated headlines | `chrome.storage.local` | 30 days, 500 entries |
| Page URLs, browsing history | **Nowhere** | — |

No analytics, no telemetry, no Debaitify server. Keys are stored unencrypted,
which is what `chrome.storage.local` offers — stated plainly in
[PRIVACY.md](./PRIVACY.md) rather than glossed.

Host permissions are three specific origins. No `tabs`, no `activeTab`, no
`<all_urls>`.

## 10. Decisions

| ID | Decision | Rationale |
|---|---|---|
| **AD-1** | Manifest V3, Chrome-first | MV2 is dead; the service worker is the natural home for a privileged network client |
| **AD-2** | API key confined to the service worker | Never shares an execution context with page-controlled code |
| **AD-3** | MAIN-world bridge for lead text | The lead exists only in `window.App`, invisible to an isolated content script. Read-only, no credentials, posts only strings the page already rendered |
| **AD-4** | Teaser identity = article id from href | Survives re-renders, lazy loading, and the same story appearing twice. Text or DOM paths would not |
| **AD-5** | Batch the whole front page into one call | ~60 separate calls would be slower, pricier and rate-limit-prone |
| **AD-6** | The model may return null | Boilerplate leads exist. Declining is a valid answer and is cached |
| **AD-7** | Swap in place on front pages; hide on article pages | Different reading modes deserve different trade-offs (§6) |
| **AD-8** | Site knowledge as JSON | Selectors have a short half-life; treating them as code means a rebuild for a CSS change |
| **AD-9** | Ordered candidate selectors | One list expresses both a stable site and a churning one without branching |
| **AD-10** | Cache on article id, with provenance and negative entries | §7 |
| **AD-11** | Provider seam at `generate()` | The narrowest interface that still lets prompts and validation stay shared |
| **AD-12** | Strategy as a setting | A 500x cost range is the user's call, not ours |
| **AD-13** | Manifest generated from `sites.json` | Permissions cannot drift from configured hosts |
| **AD-14** | Entry points must not share a basename | Both were `index.ts`; the bundler collided their chunk names and the service worker silently loaded the content script. The extension ran and did nothing |

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| IS design-token classes churn | IS stops working | Ordered selectors ending in structural fallbacks; fix is a data edit |
| `window.App` shape changes | No leads → nothing rewritten | Bridge is try/caught and reports its source; `lead` strategy degrades to nothing rather than breaking the page |
| Model writes a subtly wrong headline | **Misinforms the reader — the one unacceptable failure** | Grounded prompt, structured output, output guard, permission to decline, original preserved on hover and one-click revert |
| Provider rate limits on a big batch | Partial page | Chunked at 40, SDK retry, uncached on transient failure |
| A bad user config override | Extension breaks on a site | Schema-validated; invalid overrides discarded wholesale |
| Key exfiltration | Financial | Service-worker-only, no `eval`, no remote code, three host permissions |

## 12. Where this expands

Roughly in order of value:

1. **Confirm against a live page.** Nothing here has met the real hydrated DOM.
2. **More sites.** HS, Yle, MTV — a `sites.json` entry plus a rebuild each.
3. **A second provider.** Proves the seam; Ollama would also make the extension
   free to run.
4. **Quality feedback.** The popup already shows the original; a thumbs-down
   that pins a bad rewrite would build an eval set.
5. **Firefox.** §5.4.
6. **Chrome Web Store.** Needs icons, a privacy policy, and review of the
   host-permission footprint.

## 13. Open questions

| # | Question | Status |
|---|---|---|
| O1 | Does `window.App` carry leads for lazy-loaded teasers? | **Open** — the one assumption never tested live |
| O2 | Is the lead sufficient for good headlines in practice? | **Open** — needs a manual quality pass |
| O3 | How do we detect an Iltalehti Plus article? | **Open** — IL ships no JSON-LD; needs a paywalled fixture |
| O4 | Where does IS keep runtime teaser data? | **Open** — `__NEXT_DATA__` covers only SSR'd teasers |
| O5 | Should fixtures stay in-repo? | **Open** — 2 MB of third-party HTML; tests depend on it |
