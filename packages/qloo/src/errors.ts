import type { ErrorCode } from "@ct/contracts";

/**
 * Typed failures of the Qloo client (PLAN §5.1). Skills and the agent branch on the class: a
 * BudgetError becomes BUDGET_TRUNCATED, a QlooParamError is a bug in the caller, and the rest map to
 * the `error` event codes through {@link qlooErrorCode}.
 */
export class QlooError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The request breaks the frozen allowlist or a value rule. Never sent, never retried. */
export class QlooParamError extends QlooError {
  /** The offending parameter, when one is to blame. */
  readonly param: string | null;

  constructor(message: string, param: string | null = null, code = "qloo_param") {
    super(code, message);
    this.param = param;
  }
}

/** An insights call without any signal: Qloo answers it without affinities (probe G1 control). */
export class NoSignalError extends QlooParamError {
  constructor(message: string) {
    super(message, null, "qloo_no_signal");
  }
}

/** 401 or 403: the key is wrong or revoked. Never retried; three in a row switch to replay-only. */
export class QlooAuthError extends QlooError {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super("qloo_auth", `Qloo rejected the API key (HTTP ${status})`);
    this.status = status;
  }
}

/** A 4xx other than 401, 403 and 429. Cached for a day, so the same request fails without the network. */
export class QlooBadRequestError extends QlooError {
  readonly status: number;
  /** True when this answer came from the cached 4xx, not from the network. */
  readonly cached: boolean;

  constructor(status: number, detail: string | null, cached: boolean) {
    super("qloo_bad_request", `Qloo rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.cached = cached;
  }
}

/** 429, or a 200 whose body carries `error_msg`, still failing after the retries. */
export class QlooRateLimitError extends QlooError {
  /** 429, or 200 for a rate-limit body. */
  readonly status: number;

  constructor(status: number, attempts: number) {
    super("qloo_rate_limited", `Qloo rate limit (HTTP ${status}) after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
    this.status = status;
  }
}

/** A 5xx (or an unexpected non-2xx status) that did not recover within the retries. */
export class QlooServerError extends QlooError {
  readonly status: number;

  constructor(status: number, attempts: number) {
    super("qloo_unavailable", `Qloo answered HTTP ${status} after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
    this.status = status;
  }
}

export type QlooNetworkReason = "network" | "timeout" | "too_large";

/** No usable response: connection failure, timeout, or a body over the size cap. */
export class QlooNetworkError extends QlooError {
  readonly reason: QlooNetworkReason;

  constructor(reason: QlooNetworkReason, message: string, options?: ErrorOptions) {
    super("qloo_unavailable", message, options);
    this.reason = reason;
  }
}

/** A 2xx whose body is not JSON or does not match the contracts response schema for the endpoint. */
export class QlooResponseError extends QlooError {
  constructor(message: string, options?: ErrorOptions) {
    super("qloo_bad_response", message, options);
  }
}

/** The five budget gates, in the order they are checked (D24, SPEC §5.1 step 5). */
export type BudgetGate = "run_cap" | "followup_cap" | "tag_cap" | "daily_lane_cap" | "month_floor";

/** A budget gate refused a network call. Cache hits never reach the gates. */
export class BudgetError extends QlooError {
  readonly gate: BudgetGate;

  constructor(gate: BudgetGate, message: string) {
    super("qloo_budget", message);
    this.gate = gate;
  }
}

/** The `error` event code for a Qloo client failure, or null when the error did not come from the client. */
export function qlooErrorCode(err: unknown): ErrorCode | null {
  if (err instanceof BudgetError) return "qloo_budget";
  if (err instanceof QlooAuthError) return "qloo_auth";
  if (err instanceof QlooRateLimitError) return "qloo_rate_limited";
  if (err instanceof QlooServerError || err instanceof QlooNetworkError) return "qloo_unavailable";
  if (err instanceof QlooParamError) return "invalid_tool_input";
  if (err instanceof QlooError) return "internal";
  return null;
}
