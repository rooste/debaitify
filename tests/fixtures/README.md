# Fixtures

Captured 2026-09-06 from the live sites. Every selector, URL pattern and golden
number in `LLD.md` was validated against these files.

| File | Source |
|---|---|
| `iltalehti-front.html` | `https://www.iltalehti.fi/` |
| `iltalehti-ulkomaat-8f7fd0a3.html` | `https://www.iltalehti.fi/ulkomaat/a/8f7fd0a3-4819-45d5-a4cd-21bb02e68602` |
| `is-front.html` | `https://www.is.fi/` |
| `is-ulkomaat-2000012255625.html` | `https://www.is.fi/ulkomaat/art-2000012255625.html` |

The extraction tests assert exact paragraph and character counts. **A failing
golden number is the site-redesign alarm** — when one fails, re-capture the
fixture, confirm the new markup, and update the constants deliberately.

Still missing, each gating an open question:

- An **Iltalehti Plus (paywalled)** article — needed to close HLD O5. IL ships no
  JSON-LD, so we have no confirmed paywall signal for it.
- A **live blog** and a **video-only page** from each site — the likeliest source
  of a false-positive article match, since both have an `<h1>` and little body.
