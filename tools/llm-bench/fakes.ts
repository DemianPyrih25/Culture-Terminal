// Fake SDK responses and a scripted streamer: the unit tests and the smoke test's offline refusal
// check use these, so no test ever touches the network.
import type { AnalystStreamer } from "./client";
import type { AnalystRequest } from "./config";
import type { Anthropic } from "./deps";
import { HAIKU, SONNET } from "./pricing";

export function fakeUsage(partial: Partial<Anthropic.Beta.BetaUsage> = {}): Anthropic.Beta.BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 1000,
    iterations: null,
    output_tokens: 200,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
    ...partial,
  };
}

export function fakeMessage(partial: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_fake",
    container: null,
    content: [],
    context_management: null,
    diagnostics: null,
    model: SONNET,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: fakeUsage(),
    ...partial,
  };
}

/** A GA (non-beta) Message, as the CLERK's messages.create returns it. */
export function fakeGaMessage(partial: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_fake",
    container: null,
    content: [],
    diagnostics: null,
    model: HAIKU,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 900,
      output_tokens: 150,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
    ...partial,
  };
}

export function fakeRefusalDetails(
  partial: Partial<Anthropic.Beta.BetaRefusalStopDetails> = {},
): Anthropic.Beta.BetaRefusalStopDetails {
  return {
    type: "refusal",
    category: "cyber",
    explanation: "Synthetic refusal for an offline check.",
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
    ...partial,
  };
}

export const toolUse = (id: string, name: string, input: unknown): Anthropic.Beta.BetaToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

export const thinking = (text: string): Anthropic.Beta.BetaThinkingBlock => ({ type: "thinking", thinking: text, signature: "sig_fake" });

export const text = (value: string): Anthropic.Beta.BetaTextBlock => ({ type: "text", text: value, citations: null });

export type ScriptStep = Anthropic.Beta.BetaMessage | Error | ((request: AnalystRequest) => Anthropic.Beta.BetaMessage | Error);

export interface ScriptedStreamer {
  streamer: AnalystStreamer;
  /** The request objects as sent (their messages arrays hold the history's own elements). */
  requests: AnalystRequest[];
  /** JSON copies taken at send time, to prove nothing sent was edited later. */
  snapshots: string[];
}

/** Replays scripted responses in order; fires the stream hooks the real streamer would. */
export function scriptedStreamer(steps: readonly ScriptStep[]): ScriptedStreamer {
  const requests: AnalystRequest[] = [];
  const snapshots: string[] = [];
  const streamer: AnalystStreamer = async (params, hooks) => {
    requests.push(params);
    snapshots.push(JSON.stringify(params.messages));
    const step = steps[requests.length - 1];
    if (step === undefined) throw new Error(`scripted streamer has no response #${requests.length}`);
    const result = typeof step === "function" ? step(params) : step;
    if (result instanceof Error) throw result;
    if (result.content.length > 0) hooks.onFirstDelta?.();
    for (const block of result.content) if (block.type === "thinking" && block.thinking) hooks.onThinkingDelta?.(block.thinking);
    return result;
  };
  return { streamer, requests, snapshots };
}

/** A clock that advances by `stepMs` on every read. */
export function fakeClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}
