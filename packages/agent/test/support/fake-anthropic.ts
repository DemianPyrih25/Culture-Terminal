// A scripted fake of the SDK surface @ct/agent calls (AnthropicLike): beta.messages.stream for the
// ANALYST and messages.create for the CLERK. No test ever touches the network.
import Anthropic from "@anthropic-ai/sdk";
import { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { AnalystRequest, AnalystStream, AnthropicLike, ClerkRequest, LlmRequestOptions } from "../../src/anthropic";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type RawEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

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

// Raw stream events ---------------------------------------------------------------------------------

const halves = (s: string): string[] => [s.slice(0, Math.floor(s.length / 2)), s.slice(Math.floor(s.length / 2))].filter((p) => p !== "");

/**
 * The raw events the API streams for `message`: message_start with the prompt's usage and one output
 * token, each block (thinking in two deltas plus its signature, text, a tool input as JSON in two
 * deltas), then message_delta with the stop reason and the final usage. `rawInputs` sends a tool's
 * input as the given text instead, by tool_use id: JSON the model wrote malformed, say.
 */
export function streamEvents(message: BetaMessage, rawInputs: Readonly<Record<string, string>> = {}): RawEvent[] {
  const { usage } = message;
  const events: RawEvent[] = [
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { ...usage, output_tokens: 1 } },
    },
  ];
  message.content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const part of halves(block.thinking)) {
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part, estimated_tokens: null } });
      }
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      for (const part of halves(rawInputs[block.id] ?? JSON.stringify(block.input))) {
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
      }
    } else {
      throw new Error(`streamEvents: no events for a ${block.type} block`);
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    context_management: null,
    delta: { container: null, stop_details: null, stop_reason: message.stop_reason, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      fallback_credit: null,
      input_tokens: usage.input_tokens,
      iterations: null,
      output_tokens: usage.output_tokens,
      output_tokens_details: null,
      server_tool_use: null,
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

/**
 * The SDK's own BetaMessageStream playing raw events (`body` ends the byte stream, by default after
 * the last event), so accumulation, tool-input parsing and its errors are the SDK's, not a mock's.
 */
export function sdkStream(events: readonly RawEvent[], body: { fail?: unknown } = {}): BetaMessageStream {
  const encoder = new TextEncoder();
  const lines = events.map((e) => encoder.encode(`${JSON.stringify(e)}\n`));
  let next = 0;
  return BetaMessageStream.fromReadableStream(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const line = lines[next++];
        if (line !== undefined) controller.enqueue(line);
        else if (body.fail !== undefined) controller.error(body.fail);
        else controller.close();
      },
    }),
  );
}

// Scripts -------------------------------------------------------------------------------------------

/** One scripted stream: a message, an error, raw SDK events, or a stream that only ends when its request is aborted. */
export interface StreamStep {
  /** Played through the SDK's own BetaMessageStream (sdkStream) instead; the other fields are ignored. */
  events?: RawEvent[];
  message?: BetaMessage;
  /** finalMessage rejects with this instead of resolving. */
  error?: unknown;
  /** The stream's currentMessage: what had streamed when `error` came (from message_start on). */
  partial?: BetaMessage;
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

type ThinkingListener = (delta: string, snapshot: string) => void;
type RawEventListener = (event: RawEvent) => void;

class FakeStream implements AnalystStream {
  readonly #listeners: ThinkingListener[] = [];
  readonly #eventListeners: RawEventListener[] = [];
  readonly #final: Promise<BetaMessage>;
  readonly currentMessage: BetaMessage | undefined;

  constructor(step: StreamStep, signal: AbortSignal | undefined) {
    this.currentMessage = step.partial;
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
    for (const event of streamEvents(step.message)) for (const l of this.#eventListeners) l(event);
    return step.message;
  }

  on(event: "thinking", listener: ThinkingListener): this;
  on(event: "streamEvent" | "thinking", listener: RawEventListener | ThinkingListener): this;
  on(event: "streamEvent" | "thinking", listener: RawEventListener | ThinkingListener): this {
    if (event === "thinking") this.#listeners.push(listener as ThinkingListener);
    else this.#eventListeners.push(listener as RawEventListener);
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
          return step.events ? sdkStream(step.events) : new FakeStream(step, options?.signal);
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
