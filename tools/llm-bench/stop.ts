import type { Anthropic } from "./deps";

/**
 * The fields refusal handling reads. Both the beta and the GA Message satisfy it, so the CLERK
 * (messages.parse) and the ANALYST (beta stream) share one code path.
 */
export interface RefusalSource {
  stop_reason: string | null;
  stop_details: Pick<Anthropic.Beta.BetaRefusalStopDetails, "category" | "explanation"> | null;
  content: readonly unknown[];
}

export interface RefusalResult {
  kind: "refusal";
  /** null when the refusal maps to no named category, or stop_details is absent. */
  category: Anthropic.Beta.BetaRefusalStopDetails["category"];
  explanation: string | null;
  /** The classifier fired after some output: that partial output is discarded, never used. */
  partialOutput: boolean;
}

/**
 * A refusal card's data, or null when the response is not a refusal. Branches on stop_reason only:
 * stop_details is informational and may be null even on a refusal.
 */
export function toRefusal(message: RefusalSource): RefusalResult | null {
  if (message.stop_reason !== "refusal") return null;
  return {
    kind: "refusal",
    category: message.stop_details?.category ?? null,
    explanation: message.stop_details?.explanation ?? null,
    partialOutput: message.content.length > 0,
  };
}

export type StopOutcome =
  | { kind: "refusal"; refusal: RefusalResult }
  /** Push the content unchanged and send the conversation again. */
  | { kind: "pause_turn" }
  /** A tool input may be cut off: fail the turn and never run its tools. */
  | { kind: "max_tokens_pending_tool"; pendingTools: string[] }
  /** Truncated text with no tool call: the turn simply ended without one. */
  | { kind: "max_tokens" }
  | { kind: "tool_use" }
  | { kind: "end_turn" }
  | { kind: "other"; stopReason: string | null };

/** Checked before any content is read (PLAN §4.2 guards). */
export function classifyStop(message: Anthropic.Beta.BetaMessage): StopOutcome {
  const refusal = toRefusal(message);
  if (refusal) return { kind: "refusal", refusal };
  switch (message.stop_reason) {
    case "pause_turn":
      return { kind: "pause_turn" };
    case "max_tokens": {
      const pendingTools = message.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : []));
      return pendingTools.length > 0 ? { kind: "max_tokens_pending_tool", pendingTools } : { kind: "max_tokens" };
    }
    case "tool_use":
      return { kind: "tool_use" };
    case "end_turn":
      return { kind: "end_turn" };
    default:
      return { kind: "other", stopReason: message.stop_reason };
  }
}

export function toolUses(message: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaToolUseBlock[] {
  return message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
}

export interface ThinkingSummary {
  /** Thinking blocks in the response, including empty ones. */
  blocks: number;
  /** Blocks with text: under display "updates" these are progress updates. */
  nonEmpty: number;
  texts: string[];
}

export function thinkingSummary(message: Anthropic.Beta.BetaMessage): ThinkingSummary {
  const texts: string[] = [];
  let blocks = 0;
  for (const block of message.content) {
    if (block.type !== "thinking") continue;
    blocks++;
    if (block.thinking.trim().length > 0) texts.push(block.thinking);
  }
  return { blocks, nonEmpty: texts.length, texts };
}
