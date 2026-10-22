// A scripted fake of the SDK surface @ct/agent calls (AnthropicLike): beta.messages.stream for the
// ANALYST and messages.create for the CLERK. No test ever touches the network.
import Anthropic from "@anthropic-ai/sdk";
import type { AnalystRequest, AnalystStream, AnthropicLike, ClerkRequest, LlmRequestOptions } from "../../src/anthropic";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

// Builders ------------------------------------------------------------------------------------------

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

export function fakeMessage(partial: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: "msg_fake",
    container: null,
    content: [],
    context_management: null,
    diagnostics: null,
    model: "claude-sonnet-5-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: fakeUsage(),
    ...partial,
  };
}

/** A scripted ANALYST response. */
export function respond(
  content: BetaContentBlock[],
  stopReason: Anthropic.Beta.BetaStopReason = "tool_use",
  usage: Partial<Anthropic.Beta.BetaUsage> = {},
): BetaMessage {
  return fakeMessage({ content, stop_reason: stopReason, usage: fakeUsage(usage) });
}

/** A GA (non-beta) Message, as the CLERK's messages.create returns it. */
export function fakeGaMessage(partial: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_fake",
    container: null,
    content: [],
    diagnostics: null,
    model: "claude-haiku-5-5",
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
    explanation: "Synthetic refusal for an offline test.",
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

// Scripts -------------------------------------------------------------------------------------------

/** One scripted stream: a message, an error, or a stream that only ends when its request is aborted. */
export interface StreamStep {
  message?: BetaMessage;
  /** finalMessage rejects with this instead of resolving. */
  error?: unknown;
  /** Never settles until the request's signal aborts. */
  hang?: boolean;
  /** Waits this long first (setTimeout, so vitest fake timers control it). */
  delayMs?: number;
  /** Runs when the request is sent, e.g. to advance a fake clock. */
  onSend?: (request: AnalystRequest) => void;
}

export type StreamScript = BetaMessage | StreamStep | ((request: AnalystRequest, index: number) => BetaMessage | StreamStep);

export type CreateScript = Anthropic.Message | { error: unknown } | ((request: ClerkRequest) => Anthropic.Message | { error: unknown });

const isMessage = (value: object): value is BetaMessage => "type" in value && value.type === "message";

function abortError(): Error {
  return new Anthropic.APIUserAbortError();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/** Thinking deltas the way the SDK emits them: each non-empty block in two pieces, with its snapshot so far. */
function thinkingDeltas(message: BetaMessage): Array<[string, string]> {
  const deltas: Array<[string, string]> = [];
  for (const block of message.content) {
    if (block.type !== "thinking" || block.thinking === "") continue;
    const cut = Math.max(1, Math.floor(block.thinking.length / 2));
    deltas.push([block.thinking.slice(0, cut), block.thinking.slice(0, cut)]);
    if (cut < block.thinking.length) deltas.push([block.thinking.slice(cut), block.thinking]);
  }
  return deltas;
}

class FakeStream implements AnalystStream {
  readonly #listeners: Array<(delta: string, snapshot: string) => void> = [];
  readonly #final: Promise<BetaMessage>;

  constructor(step: StreamStep, signal: AbortSignal | undefined) {
    this.#final = this.#play(step, signal);
    // The loop may stop waiting first (a race with its stop signal); a late rejection is expected.
    this.#final.catch(() => {});
  }

  async #play(step: StreamStep, signal: AbortSignal | undefined): Promise<BetaMessage> {
    await null; // listeners attach synchronously after stream() returns
    if (signal?.aborted) throw abortError();
    if (step.delayMs !== undefined) await sleep(step.delayMs, signal);
    if (step.hang) await untilAborted(signal);
    if (step.error !== undefined) throw step.error;
    if (!step.message) throw new Error("fake stream step has neither a message nor an error");
    for (const [delta, snapshot] of thinkingDeltas(step.message)) for (const l of this.#listeners) l(delta, snapshot);
    return step.message;
  }

  on(event: "thinking", listener: (delta: string, snapshot: string) => void): this {
    if (event === "thinking") this.#listeners.push(listener);
    return this;
  }

  finalMessage(): Promise<BetaMessage> {
    return this.#final;
  }
}

/**
 * Replays scripted responses in order and records every request: the request objects as sent (their
 * messages arrays hold the history's own elements) and JSON snapshots taken at send time, to prove
 * nothing already sent was edited later.
 */
export class FakeAnthropic implements AnthropicLike {
  readonly streamRequests: AnalystRequest[] = [];
  readonly streamSnapshots: string[] = [];
  readonly streamSignals: Array<AbortSignal | undefined> = [];
  readonly createRequests: ClerkRequest[] = [];
  readonly createSignals: Array<AbortSignal | undefined> = [];

  readonly beta: AnthropicLike["beta"];
  readonly messages: AnthropicLike["messages"];

  constructor(script: { stream?: readonly StreamScript[]; create?: readonly CreateScript[] }) {
    const streams = script.stream ?? [];
    const creates = script.create ?? [];
    this.beta = {
      messages: {
        stream: (body: AnalystRequest, options?: LlmRequestOptions): AnalystStream => {
          const index = this.streamRequests.length;
          this.streamRequests.push(body);
          this.streamSnapshots.push(JSON.stringify(body));
          this.streamSignals.push(options?.signal);
          const entry = streams[index];
          if (entry === undefined) throw new Error(`fake Anthropic has no stream response #${index + 1}`);
          const resolved = typeof entry === "function" ? entry(body, index) : entry;
          const step: StreamStep = isMessage(resolved) ? { message: resolved } : resolved;
          step.onSend?.(body);
          return new FakeStream(step, options?.signal);
        },
      },
    };
    this.messages = {
      create: async (body: ClerkRequest, options?: LlmRequestOptions): Promise<Anthropic.Message> => {
        const index = this.createRequests.length;
        this.createRequests.push(body);
        this.createSignals.push(options?.signal);
        const entry = creates[index];
        if (entry === undefined) throw new Error(`fake Anthropic has no create response #${index + 1}`);
        const resolved = typeof entry === "function" ? entry(body) : entry;
        if ("error" in resolved) throw resolved.error;
        return resolved;
      },
    };
  }
}

/** A manual clock for wall-clock tests: time moves only when a test moves it. */
export class ManualClock {
  ms = 0;
  readonly now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}
