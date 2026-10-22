import Anthropic from "@anthropic-ai/sdk";

export interface LlmErrorInfo {
  kind: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  message: string;
  /** Worth retrying later (the SDK has already retried 429, 5xx and connection errors three times). */
  retryable: boolean;
  /** The request may have produced billed tokens we never saw, so the cost guard charges the estimate. */
  maybeBilled: boolean;
  /**
   * A client-side SDK error: tool input JSON it could not parse at all (eager input streaming), or a
   * stream cut mid-SSE, which the SDK wraps the same way. No tool_use block exists to answer, so the
   * documented fix is to re-issue the turn.
   */
  retryTurn: boolean;
}

/** Typed SDK errors, most specific first; never string matching on messages (ported from tools/llm-bench). */
export function describeLlmError(err: unknown): LlmErrorInfo {
  const info = (kind: string, retryable: boolean, maybeBilled: boolean, retryTurn = false): LlmErrorInfo => ({
    kind,
    status: err instanceof Anthropic.APIError && typeof err.status === "number" ? err.status : null,
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    retryable,
    maybeBilled,
    retryTurn,
  });
  if (err instanceof Anthropic.AuthenticationError) return info("authentication", false, false);
  if (err instanceof Anthropic.PermissionDeniedError) return info("permission_denied", false, false);
  if (err instanceof Anthropic.BadRequestError) return info("bad_request", false, false);
  if (err instanceof Anthropic.NotFoundError) return info("not_found", false, false);
  if (err instanceof Anthropic.UnprocessableEntityError) return info("unprocessable", false, false);
  if (err instanceof Anthropic.RateLimitError) return info("rate_limited", true, false);
  if (err instanceof Anthropic.ConflictError) return info("conflict", true, false);
  // The SDK raises this only for an HTTP 5xx (529 included) answered before any stream opened, so
  // no tokens were generated. An error mid-stream has no status and is api_error below.
  if (err instanceof Anthropic.InternalServerError) return info("server_error", true, false);
  if (err instanceof Anthropic.APIUserAbortError) return info("aborted", false, true);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return info("timeout", true, true);
  if (err instanceof Anthropic.APIConnectionError) return info("connection", true, true);
  // The SDK has no class for 402, 408 or 413. No 4xx is billed.
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 400 && err.status < 500) {
    if (err.status === 402) return info("billing", false, false);
    if (err.status === 413) return info("request_too_large", false, false);
    return info("client_error", err.status === 408, false);
  }
  // No status: an error event mid-stream, after tokens may have been generated.
  if (err instanceof Anthropic.APIError) return info("api_error", true, true);
  if (err instanceof Anthropic.AnthropicError) return info("sdk_client_error", true, true, true);
  return info("unexpected", false, true);
}
