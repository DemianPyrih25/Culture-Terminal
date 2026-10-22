import { BudgetStop, type BudgetGuard } from "./budget";
import type { AnalystRequest } from "./config";
import { Anthropic } from "./deps";
import { estimatePromptTokens, estimateRequestUsd, promptTokens, usageToUsd } from "./pricing";

/** SPEC §4.2: three retries; the timeout covers the wait for response headers, not the stream. */
export const CLIENT_OPTIONS = { maxRetries: 3, timeout: 120_000 } as const;

/** Credentials come from ANTHROPIC_API_KEY in the environment; this module never reads or prints it. */
export function createClient(): Anthropic {
  return new Anthropic({ ...CLIENT_OPTIONS });
}

export interface StreamHooks {
  /** The first content delta of any kind: time to first token. */
  onFirstDelta?: () => void;
  /** Thinking text as it streams; under display "updates" this is progress-update text. */
  onThinkingDelta?: (delta: string) => void;
}

/** Sends one streamed request and resolves with the final message. Tests pass a scripted fake. */
export type AnalystStreamer = (params: AnalystRequest, hooks: StreamHooks) => Promise<Anthropic.Beta.BetaMessage>;

export function sdkStreamer(client: Anthropic): AnalystStreamer {
  return async (params, hooks) => {
    const stream = client.beta.messages.stream(params);
    let first = true;
    stream.on("streamEvent", (event) => {
      if (first && event.type === "content_block_delta") {
        first = false;
        hooks.onFirstDelta?.();
      }
    });
    stream.on("thinking", (delta) => hooks.onThinkingDelta?.(delta));
    // With eager input streaming, unparseable tool JSON rejects here as a plain AnthropicError.
    return await stream.finalMessage();
  };
}

/** Which work an error makes pointless: the whole bench, the rest of a config, or one run. */
export type ErrorScope = "bench" | "config" | "run";

export interface ErrorInfo {
  kind: string;
  status: number | null;
  message: string;
  scope: ErrorScope;
  /** The request may have produced billed tokens we never saw, so the estimate is charged. */
  maybeBilled: boolean;
  /**
   * A client-side SDK error: tool input JSON it could not parse at all (eager input streaming), or
   * a stream cut mid-SSE, which the SDK wraps the same way. No tool_use block exists to answer, so
   * the documented fix is to re-issue the turn.
   */
  retryTurn: boolean;
}

/** Typed SDK errors, most specific first; never string matching on messages. */
export function describeError(err: unknown): ErrorInfo {
  const info = (kind: string, scope: ErrorScope, maybeBilled: boolean, retryTurn = false): ErrorInfo => ({
    kind,
    status: err instanceof Anthropic.APIError && typeof err.status === "number" ? err.status : null,
    message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    scope,
    maybeBilled,
    retryTurn,
  });
  if (err instanceof Anthropic.AuthenticationError) return info("authentication", "bench", false);
  if (err instanceof Anthropic.PermissionDeniedError) return info("permission_denied", "bench", false);
  if (err instanceof Anthropic.BadRequestError) return info("bad_request", "config", false);
  if (err instanceof Anthropic.NotFoundError) return info("not_found", "config", false);
  if (err instanceof Anthropic.UnprocessableEntityError) return info("unprocessable", "config", false);
  if (err instanceof Anthropic.RateLimitError) return info("rate_limited", "run", false);
  if (err instanceof Anthropic.ConflictError) return info("conflict", "run", false);
  if (err instanceof Anthropic.InternalServerError) return info("server_error", "run", true);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return info("timeout", "run", true);
  if (err instanceof Anthropic.APIConnectionError) return info("connection", "run", true);
  if (err instanceof Anthropic.APIUserAbortError) return info("aborted", "run", true);
  // The SDK has no class for 402, 408 or 413. No 4xx is billed; a 402 stops every config alike.
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 400 && err.status < 500) {
    if (err.status === 402) return info("billing", "bench", false);
    if (err.status === 413) return info("request_too_large", "config", false);
    if (err.status === 408) return info("request_timeout", "run", false);
    return info("client_error", "run", false);
  }
  // No status: an error event mid-stream, after tokens may have been generated.
  if (err instanceof Anthropic.APIError) return info("api_error", "run", true);
  if (err instanceof Anthropic.AnthropicError) return info("sdk_client_error", "run", true, true);
  return info("unexpected", "run", true);
}

/** Thrown by callModel after a failed request; the guard has already been charged. */
export class CallFailed extends Error {
  constructor(
    readonly info: ErrorInfo,
    readonly latencyMs: number,
    readonly chargedUsd: number,
  ) {
    super(`${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message}`);
    this.name = "CallFailed";
  }
}

export interface CallOutcome {
  message: Anthropic.Beta.BetaMessage;
  latencyMs: number;
  firstDeltaMs: number | null;
  thinkingDeltaChars: number;
  usd: number;
  estimateUsd: number;
  /** Prompt tokens beyond what the estimate assumed (0 when it held): a live check on the guard's bound. */
  estimateShortfallTokens: number;
}

/** Characters of the parts that make up the prompt, for the conservative estimate. */
export function promptChars(parts: unknown): number {
  return JSON.stringify(parts).length;
}

/**
 * One guarded request: refuse before sending when the worst case could pass the cap (BudgetStop),
 * then charge the real cost from usage, or the estimate when a failure may have been billed.
 */
export async function callModel(
  streamer: AnalystStreamer,
  params: AnalystRequest,
  guard: BudgetGuard,
  now: () => number,
): Promise<CallOutcome> {
  const chars = promptChars({ system: params.system, tools: params.tools, messages: params.messages });
  const estimateUsd = estimateRequestUsd(params.model, chars, params.max_tokens);
  guard.reserve(estimateUsd);
  const started = now();
  let firstDeltaMs: number | null = null;
  let thinkingDeltaChars = 0;
  try {
    const message = await streamer(params, {
      onFirstDelta: () => {
        firstDeltaMs ??= now() - started;
      },
      onThinkingDelta: (delta) => {
        thinkingDeltaChars += delta.length;
      },
    });
    const latencyMs = now() - started;
    const usd = usageToUsd(params.model, message.usage);
    guard.charge(usd);
    const estimateShortfallTokens = Math.max(0, promptTokens(message.usage) - estimatePromptTokens(chars));
    return { message, latencyMs, firstDeltaMs, thinkingDeltaChars, usd, estimateUsd, estimateShortfallTokens };
  } catch (err) {
    if (err instanceof BudgetStop) throw err;
    const info = describeError(err);
    const charged = info.maybeBilled ? estimateUsd : 0;
    guard.charge(charged);
    throw new CallFailed(info, now() - started, charged);
  }
}
