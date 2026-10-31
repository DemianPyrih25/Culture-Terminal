import type Anthropic from "@anthropic-ai/sdk";
import type { AiContextBlock, ContextStatus, TokenUsage, WebContextBlock } from "@ct/contracts";
import { describeLlmError } from "../llm/errors";
import { addTokenUsage, emptyTokenUsage, estimateRequestUsd, tokenUsageOf, usdFor } from "../pricing";

/** What one side call settles to: its block and what it cost. */
export interface CallOutcome<B> {
  block: B;
  /** Tokens plus, for the web call, search fees. */
  usd: number;
  usage: TokenUsage;
  /** Billed web searches (always 0 for the AI call). */
  searches: number;
  /** The model that answered, or null when no model ran (off, cache-free failure before a response). */
  model: string | null;
}

/** Reader words for every block that is not `ok` (DESIGN §2.2, §2.3). */
export const SIDE_NOTES = {
  aiOff: "AI context is off on this server.",
  aiEmpty: "The AI had nothing well-known to add.",
  aiFailed: "The AI context step failed, so this answer has no AI background.",
  aiRefused: "The AI declined to add background for this question.",
  aiTimedOut: "The AI context step took too long and was skipped.",
  webOff: "Web search is off on this server.",
  webEconomy: "Web search is paused while the server runs in economy mode.",
  webNotEnabled: "Web search is turned off for this API account.",
  webEmpty: "The web search found nothing citable.",
  webRefused: "The web search step declined this question.",
  webBusy: "Web search was busy.",
  webUnavailable: "Web search was unavailable.",
  webFailed: "Web search failed.",
  webTimedOut: "The web search took too long and was skipped.",
  stopped: "Stopped with the run.",
} as const;

export function aiBlock(status: ContextStatus, note: string | null, partial: Partial<AiContextBlock> = {}): AiContextBlock {
  return {
    status,
    items: [],
    presenceMarkets: [],
    model: null,
    generatedAt: null,
    cached: false,
    note,
    droppedForNumbers: 0,
    ...partial,
  };
}

export function webBlock(status: ContextStatus, note: string | null, partial: Partial<WebContextBlock> = {}): WebContextBlock {
  return {
    status,
    items: [],
    model: null,
    searches: 0,
    retrievedAt: null,
    cached: false,
    note,
    droppedForNumbers: 0,
    ...partial,
  };
}

/** An outcome that cost nothing: off, a cache hit, or a call stopped before any request left. */
export function freeOutcome<B>(block: B, model: string | null = null): CallOutcome<B> {
  return { block, usd: 0, usage: emptyTokenUsage(), searches: 0, model };
}

/** USD per billed web search ($10 per 1,000). web.ts and index.ts re-export it. */
export const WEB_SEARCH_FEE_USD = 0.01;

/**
 * The worst case of one side request whose usage never came back: the conservative pre-request estimate
 * the ANALYST's cost guard uses (prompt at ESTIMATE_CHARS_PER_TOKEN plus the full max_tokens as output),
 * and every search the request allows billed.
 */
export function sideRequestEstimateUsd(model: string, request: Anthropic.MessageCreateParamsNonStreaming, maxSearches = 0): number {
  const chars = JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages }).length;
  return estimateRequestUsd(model, chars, request.max_tokens) + maxSearches * WEB_SEARCH_FEE_USD;
}

/**
 * What one side call has cost so far, whatever way it ends. A response is charged its reported usage. A
 * request still in flight counts at its worst case (sideRequestEstimateUsd), so a call the handle aborts at
 * its timeout, at the run's stop or after an unexpected throw is still charged to the run's meter and the
 * daily spend. A request that failed is charged the worst case when it may have been billed (llm/errors:
 * no response arrived, or it broke mid-way) and nothing when the API refused it with an HTTP status.
 * Estimates add USD only, never tokens: the receipt's tokens stay the reported ones, like the ANALYST's.
 */
export class SideSpend {
  #usd = 0;
  #usage: TokenUsage = emptyTokenUsage();
  #searches = 0;
  #model: string | null = null;
  #pendingUsd: number | null = null;

  /** Billed web searches the responses reported. */
  get searches(): number {
    return this.#searches;
  }

  /** A request is about to leave; until it settles it counts at its worst case. */
  sent(model: string, request: Anthropic.MessageCreateParamsNonStreaming, maxSearches = 0): void {
    this.#pendingUsd = sideRequestEstimateUsd(model, request, maxSearches);
  }

  /** The response came: its reported usage replaces the estimate. */
  answered(model: string, message: Anthropic.Message): void {
    const usd = usdFor(model, message.usage);
    const usage = tokenUsageOf(message.usage);
    const searches = message.usage.server_tool_use?.web_search_requests ?? 0;
    this.#usd += usd;
    this.#usage = addTokenUsage(this.#usage, usage);
    this.#searches += searches;
    this.#model = model;
    this.#pendingUsd = null;
  }

  /** The request failed without a response: its estimate is kept when it may have been billed. */
  failed(err: unknown): void {
    if (this.#pendingUsd !== null && describeLlmError(err).maybeBilled) this.#usd += this.#pendingUsd;
    this.#pendingUsd = null;
  }

  /** The block with everything charged so far, a request still in flight at its worst case. */
  outcome<B>(block: B): CallOutcome<B> {
    return {
      block,
      usd: this.#usd + (this.#pendingUsd ?? 0) + this.#searches * WEB_SEARCH_FEE_USD,
      usage: { ...this.#usage },
      searches: this.#searches,
      model: this.#model,
    };
  }
}
