import type Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "@ct/contracts";
import { HAIKU_MODEL, SONNET_MODEL, type LlmModel } from "./anthropic";

/** USD per million tokens. */
export interface RateCard {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPricing {
  base: RateCard;
  /** A second rate card that bills the whole request when the prompt is longer than `aboveTokens`. */
  long?: { aboveTokens: number; card: RateCard };
}

/**
 * From the claude-api skill's model tables (ported from tools/llm-bench/pricing.ts). Sonnet 5.5:
 * $2 / $10, 5-minute writes $2.50, 1-hour writes $4, reads $0.20. Haiku 5.5: $0.10 / $0.50 up to a
 * 100K-token prompt and $0.50 / $2.50 above it, with reads at 0.1x input, 5-minute writes at 1.25x
 * and 1-hour writes at 2x.
 */
export const PRICING: Readonly<Record<LlmModel, ModelPricing>> = {
  [SONNET_MODEL]: { base: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 } },
  [HAIKU_MODEL]: {
    base: { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
    long: { aboveTokens: 100_000, card: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } },
  },
};

/** The usage fields pricing needs; both the beta and the GA Usage types satisfy it. */
export type UsageLike = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
> & { cache_creation?: Pick<Anthropic.Beta.BetaCacheCreation, "ephemeral_1h_input_tokens"> | null };

export function isPricedModel(model: string): model is LlmModel {
  return model === SONNET_MODEL || model === HAIKU_MODEL;
}

function pricingFor(model: string): ModelPricing {
  if (!isPricedModel(model)) {
    throw new Error(`no price for model ${model}: only ${SONNET_MODEL} and ${HAIKU_MODEL} are allowed (D23)`);
  }
  return PRICING[model];
}

/** Total prompt size. `input_tokens` is only the uncached remainder. */
export function promptTokens(usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function rateCardFor(model: string, prompt: number): RateCard {
  const pricing = pricingFor(model);
  return pricing.long && prompt > pricing.long.aboveTokens ? pricing.long.card : pricing.base;
}

/**
 * USD for one response. Cache writes without a TTL breakdown are billed at the 5-minute rate, the
 * only TTL this project asks for. Throws for any model other than Sonnet 5.5 and Haiku 5.5 (D23).
 */
export function usdFor(model: string, usage: UsageLike): number {
  const card = rateCardFor(model, promptTokens(usage));
  const written = usage.cache_creation_input_tokens ?? 0;
  const written1h = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const read = usage.cache_read_input_tokens ?? 0;
  const micro =
    usage.input_tokens * card.input +
    usage.output_tokens * card.output +
    (written - written1h) * card.cacheWrite5m +
    written1h * card.cacheWrite1h +
    read * card.cacheRead;
  return micro / 1_000_000;
}

/** API usage in the contracts' TokenUsage shape (the `usage` event and the receipt). */
export function tokenUsageOf(usage: UsageLike): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

// Pre-request estimates (the per-run cost guard) ------------------------------------------------------

/**
 * Characters per token for the pre-request estimate. Deliberately low: the Sonnet 5.x and Haiku 5.5
 * tokenizer counts about 30% more tokens than its predecessor, and JSON tool schemas run denser
 * than prose. The bench measured every live response against it without a shortfall.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 2;
/** Prompt tokens the request body does not show, such as the tool-use system prompt. */
export const ESTIMATE_HIDDEN_PROMPT_TOKENS = 1000;

/** The prompt size the estimate assumes for a request body of `promptChars` characters. */
export function estimatePromptTokens(promptChars: number): number {
  return Math.ceil(promptChars / ESTIMATE_CHARS_PER_TOKEN) + ESTIMATE_HIDDEN_PROMPT_TOKENS;
}

/** Worst-case USD for the prompt alone: every token billed as a 5-minute cache write, the dearest input rate used. */
export function estimatePromptUsd(model: string, promptChars: number): number {
  const tokens = estimatePromptTokens(promptChars);
  const card = rateCardFor(model, tokens);
  return (tokens * Math.max(card.input, card.cacheWrite5m)) / 1_000_000;
}

/**
 * An upper bound on one request's cost, as long as the prompt stays within estimatePromptTokens:
 * the worst-case prompt plus the full max_tokens billed as output.
 */
export function estimateRequestUsd(model: string, promptChars: number, maxTokens: number): number {
  const card = rateCardFor(model, estimatePromptTokens(promptChars));
  return estimatePromptUsd(model, promptChars) + (maxTokens * card.output) / 1_000_000;
}

/**
 * The largest max_tokens (at most `cap`) whose worst case fits in `remainingUsd`, or 0 when not even
 * the prompt fits. Used to keep a request under the per-run hard cap instead of refusing it outright.
 */
export function affordableMaxTokens(model: string, promptChars: number, remainingUsd: number, cap: number): number {
  const left = remainingUsd - estimatePromptUsd(model, promptChars);
  if (!(left > 0)) return 0;
  const card = rateCardFor(model, estimatePromptTokens(promptChars));
  return Math.max(0, Math.min(cap, Math.floor((left * 1_000_000) / card.output)));
}
