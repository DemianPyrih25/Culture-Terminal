import type Anthropic from "@anthropic-ai/sdk";

/**
 * The fields refusal handling reads. Both the beta and the GA Message satisfy it, so the CLERK
 * (messages.create) and the ANALYST (beta stream) share one code path.
 */
export interface RefusalSource {
  stop_reason: string | null;
  stop_details: { category: string | null; explanation: string | null } | null;
  content: readonly unknown[];
}

export interface LlmRefusal {
  /** null when the refusal maps to no named category, or stop_details is absent. */
  category: string | null;
  explanation: string | null;
  /** The classifier fired after some output: that partial output is discarded, never used. */
  partialOutput: boolean;
}

/** A refusal card's data, or null. Branches on stop_reason only: stop_details may be null even on a refusal. */
export function toRefusal(message: RefusalSource): LlmRefusal | null {
  if (message.stop_reason !== "refusal") return null;
  return {
    category: message.stop_details?.category ?? null,
    explanation: message.stop_details?.explanation ?? null,
    partialOutput: message.content.length > 0,
  };
}

export type StopOutcome =
  | { kind: "refusal"; refusal: LlmRefusal }
  /** Push the content unchanged and send the conversation again. */
  | { kind: "pause_turn" }
  /** A tool input may be cut off: fail the turn and never run its tools. */
  | { kind: "max_tokens_pending_tool"; pendingTools: string[] }
  /** Everything else, including truncated text with no tool call: read the tool calls, if any. */
  | { kind: "proceed"; stopReason: string | null };

/** Checked before any content is read (PLAN §4.2 guards). */
export function classifyStop(message: Anthropic.Beta.BetaMessage): StopOutcome {
  const refusal = toRefusal(message);
  if (refusal) return { kind: "refusal", refusal };
  if (message.stop_reason === "pause_turn") return { kind: "pause_turn" };
  if (message.stop_reason === "max_tokens") {
    const pendingTools = toolUses(message).map((b) => b.name);
    if (pendingTools.length > 0) return { kind: "max_tokens_pending_tool", pendingTools };
  }
  return { kind: "proceed", stopReason: message.stop_reason };
}

export function toolUses(message: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaToolUseBlock[] {
  return message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
}
