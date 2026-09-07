import { z } from "zod";
import type { ModelClient } from "../providers/types";
import type { FailureReason, TeaserInput } from "../shared/messages";
import { log } from "../shared/log";
import {
  SYSTEM_PROMPT,
  BATCH_SYSTEM_PROMPT,
  buildBatchMessage,
} from "./prompt";

/**
 * Headline generation, independent of any vendor.
 *
 * Prompts, schemas, output validation and batching live here; the ModelClient
 * only knows how to turn (system, user, schema) into a value. A new provider
 * changes nothing in this file.
 */

const SingleSchema = z.object({
  headline: z
    .string()
    .describe("The rewritten headline, in the same language as the article."),
});

const BatchSchema = z.object({
  headlines: z.array(
    z.object({
      id: z.string(),
      /** null means "leave this one alone" — see BATCH_SYSTEM_PROMPT. */
      headline: z.string().nullable(),
    }),
  ),
});

export async function generateFromArticle(
  client: ModelClient,
  body: string,
  original: string,
): Promise<{ ok: true; headline: string } | { ok: false; reason: FailureReason }> {
  const out = await client.generate({
    system: SYSTEM_PROMPT,
    user: body,
    // Not 30: the cap counts thinking tokens too, and hitting it truncates
    // mid-thought. The schema is what keeps the headline short.
    maxTokens: 512,
    schema: SingleSchema,
    schemaName: "headline",
  });
  if (!out.ok) return { ok: false, reason: out.reason };
  if (out.usage) log.debug("usage", out.usage);

  const headline = out.value.headline?.trim();
  if (!headline || !isAcceptable(headline, original)) {
    log.debug("rejected model output:", headline);
    return { ok: false, reason: "invalid-output" };
  }
  return { ok: true, headline };
}

export async function generateFromTeasers(
  client: ModelClient,
  items: TeaserInput[],
): Promise<
  { ok: true; headlines: Record<string, string> } | { ok: false; reason: FailureReason }
> {
  const out = await client.generate({
    system: BATCH_SYSTEM_PROMPT,
    user: buildBatchMessage(items),
    maxTokens: 8192,
    schema: BatchSchema,
    schemaName: "headlines",
  });
  if (!out.ok) return { ok: false, reason: out.reason };
  if (out.usage) log.debug("batch usage", out.usage);

  const byId = new Map(items.map((i) => [i.id, i]));
  const headlines: Record<string, string> = {};
  for (const row of out.value.headlines) {
    const src = byId.get(row.id);
    const headline = row.headline?.trim();
    // A null headline is the model declining, which is a valid answer.
    if (!src || !headline) continue;
    if (isAcceptable(headline, src.title)) headlines[row.id] = headline;
    else log.debug("rejected batch output for", row.id, headline);
  }
  return { ok: true, headlines };
}

/** A cheap output guard, not a quality judge. Provider-independent. */
export function isAcceptable(headline: string, original: string): boolean {
  if (headline.length < 15 || headline.length > 120) return false;
  if (headline.split(/\s+/).length > 14) return false; // prompt says 12; allow slack
  if (/[?…]/.test(headline)) return false;
  // Finnish opens quotes with ”, not “ — both must be rejected.
  if (/^[“”‘’"'«]/.test(headline)) return false;
  if (/\p{Lu}{5,}/u.test(headline)) return false;
  if (headline.trim().toLowerCase() === original.trim().toLowerCase()) return false;
  return true;
}
