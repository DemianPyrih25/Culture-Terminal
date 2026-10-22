import Anthropic from "@anthropic-ai/sdk";
import type { Mode } from "@ct/contracts";

/**
 * The Anthropic client and model settings (PLAN §4.2, D22, D23). The request shapes were verified
 * live on SDK 0.131.0 by tools/llm-bench; docs/LLM_BENCH.md records the decision.
 */

/** The only models this project may call (D23): no Opus. */
export const SONNET_MODEL = "claude-sonnet-5-5";
export const HAIKU_MODEL = "claude-haiku-5-5";
export type LlmModel = typeof SONNET_MODEL | typeof HAIKU_MODEL;

/** CLERK: Haiku 5.5, thinking disabled, effort low, structured output (PLAN §4.1 step A). */
export const CLERK_MODEL = HAIKU_MODEL;
export const CLERK_MAX_TOKENS = 1500;

/** The ANALYST runs live (Sonnet) or, once the daily breaker trips, in economy mode (Haiku). */
export type AnalystMode = Exclude<Mode, "replay_only">;
export const ANALYST_MODELS = { live: SONNET_MODEL, economy: HAIKU_MODEL } as const satisfies Record<AnalystMode, LlmModel>;

/** The only beta P0 sends (D22): no fallbacks, no task_budget, no per-message effort. */
export const THINKING_UPDATES_BETA = "thinking-display-updates-2026-08-18";
export const ANALYST_MAX_TOKENS = 32_000;

export interface AnalystModelConfig {
  model: LlmModel;
  effort: "low" | "medium";
  /** Sonnet 5.5 streams progress updates; Haiku 5.5 has no "updates" display, so it summarizes. */
  thinkingDisplay: "updates" | "summarized";
  betas: readonly Anthropic.Beta.AnthropicBeta[];
}

export const ANALYST_CONFIGS: Readonly<Record<AnalystMode, AnalystModelConfig>> = {
  live: { model: ANALYST_MODELS.live, effort: "medium", thinkingDisplay: "updates", betas: [THINKING_UPDATES_BETA] },
  // Without the beta the API rejects display "updates", and Haiku 5.5 does not offer it anyway.
  economy: { model: ANALYST_MODELS.economy, effort: "medium", thinkingDisplay: "summarized", betas: [] },
};

/** SPEC §4.2: three retries; the timeout covers the wait for response headers, not the whole stream. */
export const ANTHROPIC_CLIENT_OPTIONS = { maxRetries: 3, timeout: 120_000 } as const;

/** The server passes the key from its environment; this module never reads or logs it. */
export function createAnthropic(apiKey: string): Anthropic {
  if (apiKey.trim() === "") throw new Error("createAnthropic: the Anthropic API key is empty");
  return new Anthropic({ apiKey, ...ANTHROPIC_CLIENT_OPTIONS });
}

// The client surface the agent uses ------------------------------------------------------------------

/** One ANALYST request body; `client.beta.messages.stream` sets `stream` itself. */
export type AnalystRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
/** One CLERK request body. */
export type ClerkRequest = Anthropic.MessageCreateParamsNonStreaming;

export interface LlmRequestOptions {
  /** Aborting it cancels the request or stream; the SDK then rejects with APIUserAbortError. */
  signal?: AbortSignal;
}

/** The part of the SDK's BetaMessageStream the ANALYST loop reads. */
export interface AnalystStream {
  on(event: "thinking", listener: (delta: string, snapshot: string) => void): unknown;
  /** Rejects on API errors, on aborts, and when eager tool-input JSON cannot be parsed at all. */
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

/**
 * The part of the SDK client the agent calls. The real client from createAnthropic satisfies it
 * structurally, and tests pass a scripted fake (packages/agent/test/support/fake-anthropic.ts).
 */
export interface AnthropicLike {
  beta: { messages: { stream(body: AnalystRequest, options?: LlmRequestOptions): AnalystStream } };
  messages: { create(body: ClerkRequest, options?: LlmRequestOptions): PromiseLike<Anthropic.Message> };
}
