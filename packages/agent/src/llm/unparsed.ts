import Anthropic from "@anthropic-ai/sdk";

/**
 * A tool input the SDK could not parse. Every ANALYST tool streams its input eagerly
 * (eager_input_streaming), so the API no longer validates it and the client owns that check.
 * BetaMessageStream (SDK 0.131.0) parses each tool_use input with its tolerant partial-JSON parser at
 * the block's content_block_stop; JSON cut short by max_tokens or a refusal still parses, as a
 * partial object, so only JSON the model wrote malformed fails. Then the stream sets the input to {},
 * rejects finalMessage with a plain AnthropicError ("Unable to parse tool parameter JSON from model
 * ...") and drops every later event, so its snapshot (currentMessage) ends at that block, with no
 * stop_reason and only the usage message_start carried.
 */

type BetaMessage = Anthropic.Beta.BetaMessage;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type RawEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

/** At most this many characters of an unparsed input go back in its INVALID_JSON answer. */
export const RECEIVED_INPUT_MAX = 2000;

/**
 * What a stream showed, read from its raw events: the characters of every text, thinking and
 * tool-input delta (the cost estimate of a stream that never reported its final usage) and each
 * tool input's text as the model wrote it, by block index (the INVALID_JSON answer). The SDK keeps
 * that text only in a private field and in its error message.
 */
export class StreamTap {
  #chars = 0;
  readonly #inputs = new Map<number, string>();

  add(event: RawEvent): void {
    if (event.type !== "content_block_delta") return;
    const { delta } = event;
    if (delta.type === "input_json_delta") {
      this.#inputs.set(event.index, (this.#inputs.get(event.index) ?? "") + delta.partial_json);
      this.#chars += delta.partial_json.length;
    } else if (delta.type === "text_delta") {
      this.#chars += delta.text.length;
    } else if (delta.type === "thinking_delta") {
      this.#chars += delta.thinking.length;
    }
  }

  get chars(): number {
    return this.#chars;
  }

  /** The input text the tool_use block at `index` streamed, or "" when none arrived. */
  inputText(index: number): string {
    return this.#inputs.get(index) ?? "";
  }
}

/**
 * The issue line that shows the model the unparsed input it sent: JSON-encoded so its quotes are
 * escaped, angle brackets escaped so it can never open or close a tag, at most RECEIVED_INPUT_MAX
 * characters. Null when no input text was seen.
 */
export function receivedLine(raw: string): string | null {
  if (raw === "") return null;
  const cut = raw.length > RECEIVED_INPUT_MAX;
  const json = JSON.stringify(cut ? raw.slice(0, RECEIVED_INPUT_MAX) : raw)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return cut ? `received (the first ${RECEIVED_INPUT_MAX} of ${raw.length} characters): ${json}` : `received: ${json}`;
}

/**
 * The tool_use the SDK could not parse when `err` is that error, judged by the error's class and the
 * snapshot the stream left (`partial`), never by its message. Null for anything else: every typed
 * API error, and a dropped stream, which the SDK wraps in the same class with the transport error as
 * its `cause` and which can also stop at an empty tool_use.
 */
export function unparsedToolUse(err: unknown, partial: BetaMessage): ToolUseBlock | null {
  if (!(err instanceof Anthropic.AnthropicError) || err instanceof Anthropic.APIError || err.cause !== undefined) return null;
  const last = partial.content.at(-1);
  if (partial.stop_reason !== null || last?.type !== "tool_use") return null;
  const input: unknown = last.input;
  const empty = typeof input === "object" && input !== null && !Array.isArray(input) && Object.keys(input).length === 0;
  return empty ? last : null;
}

/**
 * The response as it streamed up to the unparsed tool_use, to go back in the history with that call
 * answered by INVALID_JSON, or null when it cannot be sent back: a thinking block whose signature
 * never arrived. The stop reason never arrived either and is set to tool_use: a max_tokens cut or a
 * refusal could only have come after the unparsed call, the last block kept, so the calls before it
 * are complete as the model wrote them.
 */
export function responseUpTo(partial: BetaMessage): BetaMessage | null {
  const signed = partial.content.every((b) => b.type !== "thinking" || b.signature !== "");
  return signed ? { ...partial, content: [...partial.content], stop_reason: "tool_use" } : null;
}
