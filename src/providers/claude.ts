import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type {
  GenerateRequest,
  GenerateResult,
  ModelClient,
  ProviderEntry,
} from "./types";
import type { FailureReason } from "../shared/messages";
import { log } from "../shared/log";

/**
 * Per-model request shape.
 *
 * Claude Haiku 4.5 rejects output_config.effort and does not support adaptive
 * thinking, so its entry is deliberately empty rather than branching at the
 * call site. Opus 5 uses adaptive thinking at low effort: disabling thinking
 * outright on Opus 5 can leak internal tags into the visible response, and low
 * effort reaches the same cost and latency goal without that failure mode.
 */
const MODEL_TUNING: Record<
  string,
  { thinking?: { type: "adaptive" }; effort?: "low" }
> = {
  "claude-opus-5": { thinking: { type: "adaptive" }, effort: "low" },
  "claude-haiku-4-5": {},
};

class ClaudeClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({
      apiKey,
      // The SDK disables browser use by default to stop developers shipping
      // their own key inside an app handed to strangers. Here the key is the
      // user's own, entered by them, and confined to the service worker. The
      // SDK also adds `anthropic-dangerous-direct-browser-access: true` for us
      // whenever this flag is set.
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      timeout: 30_000, // ms; the 10-minute default is far too patient here
    });
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const tuning = MODEL_TUNING[this.model] ?? {};
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
        output_config: {
          ...(tuning.effort ? { effort: tuning.effort } : {}),
          // This SDK derives the schema name itself; req.schemaName is
          // carried for providers that require one explicitly.
          format: zodOutputFormat(req.schema),
        },
      });

      if (response.stop_reason === "refusal") {
        // stop_details is populated only for refusals — guard before reading.
        log.debug("model refused:", response.stop_details?.category);
        return { ok: false, reason: "refusal" };
      }

      const value = response.parsed_output;
      if (value == null) return { ok: false, reason: "invalid-output" };

      return {
        ok: true,
        value,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  }
}

/**
 * Most specific first. APIConnectionError must be checked before APIError: in
 * the TypeScript SDK it is a subclass, unlike Python where they are siblings.
 */
function classify(err: unknown): { reason: FailureReason; detail?: string } {
  if (err instanceof Anthropic.AuthenticationError) return { reason: "no-api-key" };
  if (err instanceof Anthropic.RateLimitError) return { reason: "rate-limited" };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { reason: "timeout" };
  if (err instanceof Anthropic.APIConnectionError)
    return { reason: "api-error", detail: "connection" };
  if (err instanceof Anthropic.APIError)
    return { reason: "api-error", detail: err.message };
  return { reason: "api-error", detail: String(err) };
}

export const claudeProvider: ProviderEntry = {
  meta: {
    id: "claude",
    label: "Claude (Anthropic)",
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5 — best quality",
        inputPer1M: 5,
        outputPer1M: 25,
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5 — cheapest",
        inputPer1M: 1,
        outputPer1M: 5,
      },
    ],
    defaultModel: "claude-opus-5",
    apiKeyLabel: "Anthropic API key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    available: true,
  },
  create: ({ apiKey, model }) => new ClaudeClient(apiKey, model),

  /** One token on the cheapest model. Worth a fraction of a cent to catch a bad
   *  key at setup rather than mid-read on a live page. Raw fetch rather than the
   *  SDK, so a key test cannot be derailed by client construction. */
  async testKey(apiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      return res.ok
        ? { ok: true, detail: "Key works." }
        : { ok: false, detail: `Rejected (HTTP ${res.status}).` };
    } catch (err) {
      return { ok: false, detail: `Could not reach the API: ${String(err)}` };
    }
  },
};
