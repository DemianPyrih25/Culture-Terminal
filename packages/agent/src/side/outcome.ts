import type { AiContextBlock, ContextStatus, TokenUsage, WebContextBlock } from "@ct/contracts";
import { emptyTokenUsage } from "../pricing";

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

/** An outcome that cost nothing: off, a cache hit, a stop before any response. */
export function freeOutcome<B>(block: B, model: string | null = null): CallOutcome<B> {
  return { block, usd: 0, usage: emptyTokenUsage(), searches: 0, model };
}
