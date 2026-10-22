import type { Anthropic } from "./deps";

/** The only models this project may call (D23): no Opus. */
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export type BenchModel = typeof SONNET | typeof HAIKU;

/** USD per million tokens. */
export interface RateCard {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

interface ModelPricing {
  base: RateCard;
  /** A second rate card that bills the whole request when the prompt is longer than `aboveTokens`. */
  long?: { aboveTokens: number; card: RateCard };
}

/**
 * From the claude-api skill's model tables. Sonnet 5.5: $2 / $10, 5-minute writes $2.50, 1-hour
 * writes $4, reads $0.20. Haiku 5.5: $0.10 / $0.50 up to a 100K-token prompt and $0.50 / $2.50
 * above it, with reads at 0.1x input, 5-minute writes at 1.25x and 1-hour writes at 2x.
 */
export const PRICING: Readonly<Record<BenchModel, ModelPricing>> = {
  [SONNET]: { base: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 } },
  [HAIKU]: {
    base: { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
    long: { aboveTokens: 100_000, card: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } },
  },
};

/** The usage fields pricing needs; both the beta and the GA Usage types satisfy it. */
export type UsageLike = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
> & { cache_creation?: Anthropic.Beta.BetaCacheCreation | null };

export function isBenchModel(model: string): model is BenchModel {
  return model === SONNET || model === HAIKU;
}

function pricingFor(model: string): ModelPricing {
  if (!isBenchModel(model)) throw new Error(`no price for model ${model}: only ${SONNET} and ${HAIKU} are allowed (D23)`);
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

/** USD for one response. Cache writes without a TTL breakdown are billed at the 5-minute rate. */
export function usageToUsd(model: string, usage: UsageLike): number {
  const card = rateCardFor(model, promptTokens(usage));
  const written = usage.cache_creation_input_tokens ?? 0;
  const written1h = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const written5m = written - written1h;
  const read = usage.cache_read_input_tokens ?? 0;
  const micro =
    usage.input_tokens * card.input +
    usage.output_tokens * card.output +
    written5m * card.cacheWrite5m +
    written1h * card.cacheWrite1h +
    read * card.cacheRead;
  return micro / 1_000_000;
}

/**
 * Characters per token for the pre-request estimate. Deliberately low: the Sonnet 5.x and Haiku 5.5
 * tokenizer counts about 30% more tokens than its predecessor, and JSON tool schemas run denser
 * than prose. This is an assumption, not a proof; callModel records every response whose prompt
 * came out larger than the estimate, so a live run calibrates it for free.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 2;
/** Prompt tokens the request body does not show, such as the tool-use system prompt. */
export const ESTIMATE_HIDDEN_PROMPT_TOKENS = 1000;

/** The prompt size the estimate assumes for a request body of `promptChars` characters. */
export function estimatePromptTokens(promptChars: number): number {
  return Math.ceil(promptChars / ESTIMATE_CHARS_PER_TOKEN) + ESTIMATE_HIDDEN_PROMPT_TOKENS;
}

/**
 * An upper bound on one request's cost, for the budget guard, as long as the prompt stays within
 * estimatePromptTokens: every prompt token billed as a 5-minute cache write (the dearest input
 * rate we use) and the full max_tokens billed as output.
 */
export function estimateRequestUsd(model: string, promptChars: number, maxTokens: number): number {
  const tokens = estimatePromptTokens(promptChars);
  const card = rateCardFor(model, tokens);
  return (tokens * Math.max(card.input, card.cacheWrite5m) + maxTokens * card.output) / 1_000_000;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
