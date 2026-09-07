# Debaitify

A Chrome extension that replaces clickbait headlines on Finnish tabloid front
pages with accurate, descriptive ones.

> **Published:** "Äärioikeistolle murskavoitto – Saksassa tapahtui jotain, mitä ei ole nähty sitten vuoden 1945"
>
> **What the story is:** the far right won the Saxony-Anhalt state election.

Iltalehti and Ilta-Sanomat write headlines for the curiosity gap rather than for
information — withheld subjects, withheld outcomes, trailing-ellipsis pull
quotes. Debaitify rewrites them in place, on the front page, as you read it.

## How it works

Both sites publish, alongside every clickbait teaser, a plain factual lead
sentence they wrote themselves. That is the key to doing this cheaply:

```
front page loads
  → find every teaser, keyed by the article id in its href
  → read each teaser's lead from the page's own hydration state
  → one batched model call for everything not already cached
  → swap each title in place as its rewrite arrives
```

Titles are never hidden. Each one changes when its rewrite lands, so the page is
usable immediately and never blank.

Results cache by article id, so a refresh, a revisit, or the same story
appearing twice costs nothing. A fresh front page is roughly **$0.001**.

Article pages are supported too: open a story and its headline is rewritten from
the full article text rather than the lead.

## Install

Requires Node 20+ (developed on 26).

```bash
npm install
npm run build
```

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `dist/`
3. The options page opens on install — choose a strategy and paste an API key

`npm run dev` runs Vite with hot reload.

## Configuration

### How headlines are written

| Strategy | Cost per fresh front page | Notes |
|---|---|---|
| **Publisher's lead** | free, no key | Uses the summary they already wrote. Instant, no model. Reads oddly where the lead is a supporting sentence rather than a headline. |
| **Model, title + lead** *(default)* | ~$0.001 | One batched request. Teasers whose lead is boilerplate are left alone. |
| **Model, full article** | ~$0.60 | Fetches and reads each story. Handles teasers the others skip. Only fetches what you scroll to. |

Start with **Publisher's lead** — it needs no API key and proves the extension
is working before you spend anything.

### AI provider

Claude is the only implemented provider. OpenAI, Gemini and Ollama appear in the
list marked *not yet supported*, because the seam exists and they are where this
is going.

Adding one means implementing a single method:

```ts
interface ModelClient {
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}
```

Prompts, schemas, output validation, batching, caching and cost accounting are
all provider-agnostic and live above that line. Register the new client in
`src/providers/registry.ts` and nothing else changes.

API keys are stored per provider, so switching back and forth never loses one.
The cache keys on provider *and* model, so changing either invalidates entries
rather than deleting them — switch back and you re-use what you already paid for.

## Bring your own key

There is no Debaitify server. You supply your own API key, it is stored in your
browser profile, and every request is billed to you. Nothing is sent anywhere
except to the provider you chose. See [PRIVACY.md](./PRIVACY.md).

## Development

```bash
npm run typecheck
npm run test        # 55 tests, including golden numbers against real captured HTML
npm run build
```

Tests never call a live API.

### Fixing a site that broke

Site knowledge is data, not code. Everything about a site lives in
[`src/sites/sites.json`](./src/sites/sites.json): hosts, the article URL
pattern, and ordered candidate selector lists for teasers, headline, lead and
body. Ordered lists are the resilience strategy — precise selector first, a
structural one last.

When a site redesigns, a golden-number test in `tests/` fails. That failing test
*is* the alarm. Re-capture the fixture, find the new selector, add it to the
**front** of the list, and leave the old one as a fallback. No code change.

You can also override the config without rebuilding, from Options → Site
configuration. Overrides are merged over the bundled file and schema-validated;
an invalid one is discarded rather than applied, so a bad edit cannot break the
extension. Adding a *new host* additionally needs a manifest change, since
content-script matches are static.

### Layout

```
src/providers/   the model seam — the only place a vendor is named
src/background/  service worker: cache, queue, prompts, headline generation
src/content/     teaser detection, extraction, DOM swapping, MAIN-world bridge
src/sites/       sites.json + schema + resolution
tests/fixtures/  real captured HTML; the golden numbers are asserted against it
```

Two entry points must not share a basename — when both were `index.ts`, the
bundler emitted colliding chunk names and the service worker silently loaded the
content script instead.

### If npm fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`

Not a proxy or config problem. `registry.npmjs.org` presents GTS Root R4 in its
cross-signed form, anchored to `GlobalSign Root CA` (R1). Node bundles its own CA
store rather than using the macOS keychain, and that store ships GlobalSign
R3/R5/R6/R46/E46 but **not R1** — so Node cannot complete the chain, while curl
and openssl succeed.

Supply the missing root from the system keychain. This adds one well-known root;
it does not disable verification:

```bash
mkdir -p ~/.config/node-certs
security find-certificate -a -c "GlobalSign Root CA" -p \
  /System/Library/Keychains/SystemRootCertificates.keychain \
  > ~/.config/node-certs/globalsign-root-r1.pem

echo 'export NODE_EXTRA_CA_CERTS="$HOME/.config/node-certs/globalsign-root-r1.pem"' >> ~/.zshrc
source ~/.zshrc
```

Do **not** use `npm config set strict-ssl false`, and prefer `NODE_EXTRA_CA_CERTS`
over npm's `cafile` — `cafile` *replaces* the trust store, this *appends* to it.

## Status

Builds clean, 55 tests pass, and it loads as an unpacked extension. **It has not
yet been confirmed against a live page**: the front-page code was written against
pre-hydration HTML with 6 teasers, where the real page renders dozens, and no
live API call has been made from the extension yet.

Design docs are current: [HLD.md](./HLD.md) covers architecture and the
extension points, [LLD.md](./LLD.md) the implementation — including §14, which
is a set of step-by-step recipes for adding a site, a provider, a strategy, a
browser or a page mode.

Known gaps:

- **Ilta-Sanomat is partial.** Only some of its teasers carry an ingress, and
  `__NEXT_DATA__` covers only server-rendered ones. It rewrites what it can and
  skips the rest.
- **Iltalehti paywall detection is unverified** — IL ships no JSON-LD, so there
  is no confirmed signal for a Plus article. The minimum-length gate is the
  interim defence.

## Licence

MIT — see [LICENSE](./LICENSE).
