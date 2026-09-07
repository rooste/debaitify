# Debaitify — Privacy

Debaitify reads the article you are looking at and sends its text to Anthropic's
API to generate a replacement headline. That is a real thing to be told before
you install it, so here it is in full.

## What leaves your machine

**The extracted body text of articles you open**, sent to `api.anthropic.com`
using **your own** Anthropic API key. Nothing else. Specifically:

- The **page URL is never sent.** The extension resolves an article id locally
  and sends only body text.
- Your **browsing history is never sent** anywhere, to us or to anyone.
- There is **no Debaitify server.** There is nothing to send data to. The
  extension talks to Anthropic and to nothing else.
- There is **no analytics, no telemetry, no crash reporting.**

Text is sent **once per article, ever.** The result is cached locally, so
re-reading, refreshing, or opening the same article in another tab sends
nothing.

Anthropic's handling of that text is governed by their API terms and retention
policy, not by us.

## What is stored on your machine

In `chrome.storage.local`, readable only by this extension:

| | |
|---|---|
| Your API key | Until you clear it |
| Generated headlines, keyed by article id | 30 days, max 500 articles |
| Your settings and any site-config overrides | Until you change them |

**Your API key is stored unencrypted**, which is what `chrome.storage.local`
offers. Anyone with access to your browser profile can read it. This is the
normal situation for a bring-your-own-key extension and you should decide
whether you are comfortable with it. Use a key scoped to a workspace with a
spend limit if you want a blast radius.

## About `dangerouslyAllowBrowser`

The Anthropic SDK refuses to run in a browser unless you set a flag whose name is
a warning. That warning exists to stop developers shipping *their* key inside an
app handed to strangers. Here the key is yours, entered by you, and used only in
the extension's background worker — never in a page context where site JavaScript
could reach it. The flag is set knowingly for that reason.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and the headline cache |
| `https://api.anthropic.com/*` | To generate headlines |
| `https://www.iltalehti.fi/*`, `https://www.is.fi/*` | To read and rewrite headlines on those sites |

The extension has no access to any other site. It does not request `tabs`,
`activeTab`, or `<all_urls>`.

## Removing everything

Uninstalling the extension deletes all of it — key, cache and settings. "Clear
cache" in Settings removes cached headlines while keeping your key.
