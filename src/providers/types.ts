import type { z } from "zod";
import type { FailureReason } from "../shared/messages";

/**
 * The provider seam.
 *
 * Everything Debaitify needs from an LLM is: given a system prompt, a user
 * message, and a schema, return a value matching that schema. Prompts, output
 * validation, batching, caching and cost accounting all live above this line
 * and are provider-agnostic.
 *
 * Adding a provider means implementing generate() and adding a registry entry.
 * Nothing else in the codebase should ever mention a vendor.
 */
export interface GenerateRequest<T> {
  system: string;
  user: string;
  maxTokens: number;
  schema: z.ZodType<T>;
  /** Some providers require a name for the response schema. */
  schemaName: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export type GenerateResult<T> =
  | { ok: true; value: T; usage?: TokenUsage }
  | { ok: false; reason: FailureReason; detail?: string };

export interface ModelClient {
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export interface ModelOption {
  id: string;
  label: string;
  /** USD per million tokens, for the cost estimate shown in Options. */
  inputPer1M: number;
  outputPer1M: number;
}

export interface ProviderMeta {
  id: string;
  label: string;
  models: ModelOption[];
  defaultModel: string;
  apiKeyLabel: string;
  apiKeyUrl: string;
  /** False for providers that are declared but not yet implemented. They are
   *  listed in Options as unavailable rather than hidden, so the extension
   *  points at where it is going. */
  available: boolean;
}

export interface ProviderEntry {
  meta: ProviderMeta;
  create(opts: { apiKey: string; model: string }): ModelClient;
  /** Cheapest possible round-trip that proves a key works. Lives here so the
   *  Options page never has to know a vendor's endpoint or header names. */
  testKey(apiKey: string): Promise<{ ok: boolean; detail: string }>;
}
