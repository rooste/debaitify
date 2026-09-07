import bundled from "./sites.json" with { type: "json" };
import { SitesFileSchema, type SiteConfig, type SitesFile } from "./schema";
import { storage } from "../shared/platform";
import { log } from "../shared/log";

export { selectFirst, selectAll } from "./select";

const OVERRIDE_KEY = "siteOverrides";

/** The bundled config is validated once at module load. If this throws, the
 *  build is broken and that should be loud, not silently degraded. */
const BUNDLED: SitesFile = SitesFileSchema.parse(bundled);

export interface ResolvedConfig {
  file: SitesFile;
  /** Present when a stored override existed but failed validation. Surfaced in
   *  Options so the user can see why their edit did not take effect. */
  overrideError?: string;
}

/**
 * Effective config = bundled, deep-merged with the user's override, validated.
 * A malformed override is discarded wholesale — a broken edit must never brick
 * the extension on every news site the user visits.
 */
export async function resolveConfig(): Promise<ResolvedConfig> {
  const raw = await storage.get<unknown>(OVERRIDE_KEY);
  if (raw === undefined) return { file: BUNDLED };

  const merged = mergeSites(BUNDLED, raw);
  const parsed = SitesFileSchema.safeParse(merged);
  if (!parsed.success) {
    const overrideError = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    log.warn("site override rejected, using bundled config:", overrideError);
    return { file: BUNDLED, overrideError };
  }
  return { file: parsed.data };
}

export function findSiteByHost(
  file: SitesFile,
  hostname: string,
): SiteConfig | null {
  return (
    file.sites.find((s) => s.enabled && s.hosts.includes(hostname)) ?? null
  );
}

/**
 * The cache key, and simultaneously the article test: a path that yields no id
 * is not an article, so there is no separate isArticle() call.
 *
 * Returns null rather than throwing on a malformed user-supplied pattern.
 */
export function articleKey(pathname: string, site: SiteConfig): string | null {
  let re: RegExp;
  try {
    re = new RegExp(site.article.urlPattern);
  } catch (err) {
    log.warn(`invalid urlPattern for site "${site.id}"`, err);
    return null;
  }
  const id = re.exec(pathname)?.groups?.["id"];
  return id ? `c:${site.id}:${id}` : null;
}

/** Shallow-by-site, deep-by-field merge. Sites are matched on `id`. */
function mergeSites(base: SitesFile, override: unknown): unknown {
  if (typeof override !== "object" || override === null) return base;
  const ov = override as Partial<SitesFile>;
  if (!Array.isArray(ov.sites)) return { ...base, ...ov };

  const byId = new Map(ov.sites.map((s) => [(s as SiteConfig).id, s]));
  const sites = base.sites.map((s) => {
    const patch = byId.get(s.id);
    if (!patch) return s;
    byId.delete(s.id);
    return deepMerge(s, patch);
  });
  return { ...base, ...ov, sites: [...sites, ...byId.values()] };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return (patch ?? base) as T;
  }
  const out = { ...(base as object) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] =
      typeof cur === "object" && cur !== null && !Array.isArray(cur)
        ? deepMerge(cur, v)
        : v;
  }
  return out as T;
}
