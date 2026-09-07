/**
 * Bump PROMPT_VERSION whenever a prompt changes. Cached headlines carry the
 * version they were generated under, so a bump invalidates them lazily instead
 * of serving headlines written to a prompt that no longer exists.
 *
 * v2: reframed around resolving the withheld fact rather than "summarise
 *     accurately". Added the named clickbait patterns and worked examples.
 */
export const PROMPT_VERSION = 2;

/**
 * The core of debaiting, shared by both prompts.
 *
 * The insight this encodes: a clickbait headline is not merely vague, it is
 * vague *in a specific place*. "Joutui heti tositoimiin" withholds what the
 * fence did. Naming that mechanism — find the withholding phrase, then supply
 * what it hides — produces far better rewrites than asking for an accurate
 * summary, which tends to return a bland restatement of the topic.
 */
const METHOD = `A clickbait headline withholds the one thing that would make the story
informative, and dares you to click for it. Your job is to find what is being
withheld and put it back.

Work in three steps:
1. Identify the phrase in the headline that withholds information.
2. Find the specific fact in the source text that resolves it.
3. Write a headline that states that fact plainly.

Withholding patterns, and what each needs:

- Vague outcome — "joutui heti tositoimiin", "yllätti", "tapahtui jotain",
  "kävi köpelösti", "sai yllättävän käänteen".
  Say what actually happened.
- Withheld subject — "tämä suomalainen tähti", "48-vuotias mies", "eräs kunta".
  Name them, if the source text names them.
- Teaser quote, usually with an ellipsis — "Ei tässä ole tapahtunut mitään...".
  Replace it with the substance of the claim.
- Instructional tease — "katso kuvat", "näin se tehtiin", "tästä on kyse".
  State the finding instead.
- Withheld number or scale — "hurja summa", "valtava määrä".
  Give the figure.

Prefer the concrete resolving fact over a general description of the topic. A
headline that says what happened beats one that says what the article is about.`;

const STYLE = `Style:
- Write in the same language as the source. Finnish in, Finnish out.
- Maximum 12 words. Shorter is better.
- Plain declarative sentence. No sensationalism, no scare quotes.
- No question marks, no ellipses, no ALL CAPS, no emoji.
- Do not open with a demonstrative tease ("Tämä", "Näin", "Katso", "Yllättävä").
- Use only facts present in the source text. Invent nothing, and never guess at
  what the withheld fact might be.`;

/** Worked examples. The third is the case that motivated v2. */
const EXAMPLES = `Examples.

Headline: "Asiantuntijalta todella karu arvio Moskovan tapaamisesta: ”Ei tässä ole tapahtunut mitään sellaista...”"
Withheld: what the assessment actually was.
Source says: a professor judges the meeting did not move Russia off its terms.
Rewrite: "Professori: Moskovan tapaaminen ei lähentänyt rauhaa"

Headline: "Äärioikeistolle murskavoitto – Saksassa tapahtui jotain, mitä ei ole nähty sitten vuoden 1945"
Withheld: what happened, and where.
Source says: the far right won the Saxony-Anhalt state election.
Rewrite: "Äärioikeisto voitti Saksi-Anhaltin osavaltiovaalit"

Headline: "Itärajan uusi aita joutui heti tositoimiin"
Withheld: what the fence was used for.
Source says: its game gates are closed to stop wild boar crossing and African
swine fever spreading.
Rewrite: "Itärajan aidan riistaportit suljettu sikaruton leviämisen estämiseksi"

Note the third example: the resolving fact was one sentence late in the article,
not its main topic. The withheld fact is what the reader was promised, so it is
what the headline should deliver.`;

export const SYSTEM_PROMPT = `You rewrite clickbait news headlines.

${METHOD}

${STYLE}

${EXAMPLES}

You will be given the body text of one article. Output the headline only.

If the article genuinely contains no withheld fact — the original headline was
already plain and descriptive — write a headline that states the article's main
point instead.`;

export function buildUserMessage(body: string): string {
  return body;
}

/**
 * Batch prompt for front-page teasers.
 *
 * Grounding is the clickbait title plus the publisher's own lead sentence. That
 * lead is usually plain and factual, and it is all we get without fetching each
 * article — which costs roughly 500x more per front page.
 *
 * The model must therefore be allowed to decline. Sometimes the lead simply does
 * not contain the resolving fact (it may be boilerplate, or about a different
 * aspect of the story entirely), and guessing at what the headline is hiding is
 * the worst thing this extension could do.
 */
export const BATCH_SYSTEM_PROMPT = `You rewrite clickbait news teaser headlines.

${METHOD}

${STYLE}

${EXAMPLES}

You will be given several items. Each has an id, the published headline, and the
publisher's own lead sentence. Return one entry per id.

Set headline to null when:
- the lead does not contain the fact the headline is withholding — it may be
  boilerplate, or about a different aspect of the story than the headline
  teases;
- the item is an advertisement or a subscription promotion;
- the existing headline is already plain and descriptive.

Returning null is correct and expected, and is much better than guessing. You
are working from a single sentence, so you will often not have the resolving
fact. A wrong headline is worse than a clickbait one.`;

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
