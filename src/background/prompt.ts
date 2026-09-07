/**
 * Bump PROMPT_VERSION whenever SYSTEM_PROMPT changes. Cached headlines carry the
 * version they were generated under, so a bump invalidates them lazily instead
 * of serving headlines written to a prompt that no longer exists.
 */
export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = `You rewrite news headlines.

You will be given the body text of a news article. Write one headline that
states what the article is actually about.

Rules:
- Write in the same language as the article. A Finnish article gets a Finnish
  headline.
- State the subject and the outcome. Never withhold either to create curiosity.
- Maximum 12 words. Shorter is better.
- Use only facts present in the article body. Invent nothing.
- No question marks, no ellipses, no ALL CAPS, no emoji.
- Do not open with a demonstrative tease ("Tama", "Nain", "Katso", "Yllattava").
- Plain declarative sentence. No sensationalism, no editorialising, no scare
  quotes.
- Output the headline only.`;

/**
 * The user message is the body text alone.
 *
 * The original headline is deliberately NOT sent: supplying it biases the
 * rewrite toward the framing we are trying to remove, and it is not needed for
 * the task.
 */
export function buildUserMessage(body: string): string {
  return body;
}

/**
 * Batch prompt for front-page teasers.
 *
 * The input is the clickbait title plus the publisher's own lead. That lead is
 * usually a plain factual sentence, and it is all the grounding we get without
 * fetching each article — which would cost roughly 500x more per front page.
 *
 * Crucially the model must be allowed to decline: some leads are boilerplate
 * ("Iltalehti seuraa Ukrainan sotaa hetki hetkeltä"), and inventing a headline
 * from those would be worse than leaving the clickbait alone.
 */
export const BATCH_SYSTEM_PROMPT = `You rewrite clickbait news teaser headlines.

For each item you are given an id, the published headline, and the publisher's
own lead sentence. Write a replacement headline that says what the story is
actually about.

Rules:
- Write in the same language as the input. Finnish in, Finnish out.
- Use ONLY facts present in that item's headline and lead. Invent nothing.
- State the subject and the outcome. Never withhold either to create curiosity.
- Maximum 12 words. Shorter is better.
- No question marks, no ellipses, no ALL CAPS, no emoji.
- Do not open with a demonstrative tease ("Tama", "Nain", "Katso", "Yllattava").
- Plain declarative sentence. No sensationalism, no scare quotes.

Set headline to null for an item when:
- the lead is generic boilerplate rather than facts about this story (for
  example a live-blog standing description), or
- the headline and lead together do not contain enough to state what happened, or
- the item is an advertisement or a subscription promotion, or
- the existing headline is already plain and descriptive.

Returning null is correct and expected. A wrong headline is worse than a
clickbait one. Return one entry for every id you were given.`;

export function buildBatchMessage(
  items: ReadonlyArray<{ id: string; title: string; lead: string }>,
): string {
  return items
    .map((i) =>
      [`id: ${i.id}`, `headline: ${i.title}`, `lead: ${i.lead || "(none)"}`].join(
        "\n",
      ),
    )
    .join("\n\n");
}
