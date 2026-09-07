import { z } from "zod";

const Selectors = z.array(z.string());

export const SiteConfigSchema = z.object({
  /** Stable — it appears in cache keys, so renaming it orphans cached entries. */
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  /** Exact hostnames, not globs. */
  hosts: z.array(z.string().min(1)).min(1),
  article: z.object({
    /** RegExp source, matched against location.pathname. Must expose a named
     *  capture group `id` — that group becomes the cache key. */
    urlPattern: z.string().min(1),
  }),
  headline: z.object({ selectors: Selectors.min(1) }),
  lead: z.object({ selectors: Selectors }),
  body: z.object({
    containers: Selectors.min(1),
    paragraphs: Selectors.min(1),
    strip: Selectors,
  }),
  /** Front-page (teaser list) configuration. */
  front: z.object({
    /** Anchors that wrap a teaser. The article id is parsed from the href, so
     *  this is the identity anchor — not the title element. */
    teaserLinkSelectors: Selectors.min(1),
    /** Where the clickbait text lives inside that anchor, best guess first. */
    titleSelectors: Selectors.min(1),
    /** Which page-state reader can supply lead text for this site. */
    stateSource: z.enum(["iltalehti", "next-data", "none"]),
    minTitleChars: z.number().int().positive(),
  }),
  paywall: z.object({
    useJsonLd: z.boolean(),
    selectors: Selectors,
    minFreeChars: z.number().int().positive(),
  }),
  minBodyChars: z.number().int().positive(),
  maxBodyChars: z.number().int().positive(),
});

export const SitesFileSchema = z.object({
  schemaVersion: z.literal(1),
  sites: z.array(SiteConfigSchema),
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;
export type SitesFile = z.infer<typeof SitesFileSchema>;
