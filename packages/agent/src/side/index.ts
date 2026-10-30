import type Anthropic from "@anthropic-ai/sdk";
import type { AiContextBlock, EventInput, Intent, MarketId, TokenUsage, WebContextBlock } from "@ct/contracts";
import type { AnalystMode } from "../anthropic";
import { addTokenUsage } from "../pricing";
import { resetAiLatch, runAiContext } from "./ai";
import { aiBlock, freeOutcome, SIDE_NOTES, webBlock, type CallOutcome } from "./outcome";
import { resetWebLatch, runWebContext, WEB_SEARCH_FEE_USD } from "./web";

/**
 * The side context calls (R4, R5, D45; PLAN §4.6): "What AI knows (not verified)" and "From the web". They
 * run in parallel with the gate, the scan and ANALYST turn 1, never feed a measured claim, and only the
 * validated presence market ids ever reach the ANALYST. Web text is untrusted data: it is only displayed,
 * escaped, with its link.
 *
 * Each block emits its `context.*` event once, as soon as it settles (a cache hit and an `off` block
 * included), so the live page fills in early. A call that outlives its own timeout or the caller's
 * `settled` deadline is aborted and settles as `timed_out`; the run's abort settles both without an event.
 */

export interface SideConfig {
  aiEnabled: boolean;
  webEnabled: boolean;
  /** Searches per answer, clamped 1..5 (WEB_SEARCH_MAX_USES). */
  webMaxUses: number;
  /** 25_000 (SIDE_TIMEOUTS.aiMs). */
  aiTimeoutMs: number;
  /** 45_000 (SIDE_TIMEOUTS.webMs). */
  webTimeoutMs: number;
}

/** The context cache as the side calls see it (the server backs it with @ct/db repos/contextCache). */
export interface ContextCache {
  get(key: string): Promise<{ body: unknown; createdAt: string } | null>;
  put(row: { key: string; kind: "ai" | "web"; model: string; body: unknown; usd: number; ttlMs: number }): Promise<void>;
}

/** The Anthropic client as the side calls see it (injected, so tests script it). */
export interface SideClient {
  create(
    req: Anthropic.MessageCreateParamsNonStreaming,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<Anthropic.Message>;
}

export interface SideContextOptions {
  runId: string;
  /** The sanitised question. */
  question: string;
  intent: Intent;
  mode: AnalystMode;
  subjectName: string | null;
  /** "Austin, TX" or null. */
  placeLabel: string | null;
  client: SideClient;
  cache: ContextCache | null;
  config: SideConfig;
  signal: AbortSignal;
  emit: (e: EventInput) => void;
  now?: () => number;
}

export interface SideContextResult {
  ai: AiContextBlock;
  web: WebContextBlock;
  usd: number;
  usage: TokenUsage;
  webSearches: number;
  models: { ai: string | null; web: string | null };
}

export interface SideContextHandle {
  /** Validated presence markets, or null when unknown or not ready within waitMs. Never rejects. */
  presence(waitMs: number): Promise<MarketId[] | null>;
  /** Settles both blocks within waitMs (an unfinished call is aborted → timed_out). Never rejects. */
  settled(waitMs: number): Promise<SideContextResult>;
}

export const SIDE_TIMEOUTS = { aiMs: 25_000, webMs: 45_000 } as const;
export const WEB_SEARCH_USD_PER_SEARCH = WEB_SEARCH_FEE_USD;

export { numberProblems, unbackedNumbers } from "./numbers";
export { contextCacheKey, CONTEXT_TTL_MS } from "./cache";
export { SIDE_NOTES } from "./outcome";

/** Tests only: forget the process-wide latches (web search not enabled, between_tools fallback). */
export function resetSideLatches(): void {
  resetAiLatch();
  resetWebLatch();
}

interface Call<B> {
  promise: Promise<CallOutcome<B>>;
  /** The outcome once settled, else null. */
  current(): CallOutcome<B> | null;
  /** Aborts an unfinished call and settles it as timed_out. */
  expire(): void;
}

interface CallSpec<B> {
  run: (signal: AbortSignal) => Promise<CallOutcome<B>>;
  timeoutMs: number;
  timedOut: () => B;
  failed: () => B;
  stopped: () => B;
  /** Emits the block's event; not called when the run's abort settled it. */
  emit: (outcome: CallOutcome<B>) => void;
  runSignal: AbortSignal;
}

function startCall<B>(spec: CallSpec<B>): Call<B> {
  const controller = new AbortController();
  let done: CallOutcome<B> | null = null;
  let resolve: (outcome: CallOutcome<B>) => void = () => {};
  const promise = new Promise<CallOutcome<B>>((r) => {
    resolve = r;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    controller.abort();
    finish(freeOutcome(spec.stopped()), false);
  };
  function finish(outcome: CallOutcome<B>, announce = true): void {
    if (done !== null) return;
    done = outcome;
    if (timer !== undefined) clearTimeout(timer);
    spec.runSignal.removeEventListener("abort", onAbort);
    if (announce) spec.emit(outcome);
    resolve(outcome);
  }
  const expire = () => {
    if (done !== null) return;
    controller.abort();
    finish(freeOutcome(spec.timedOut()));
  };

  if (spec.runSignal.aborted) {
    onAbort();
  } else {
    spec.runSignal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(expire, Math.max(0, spec.timeoutMs));
    // A run that ends without settling must not keep a CLI process alive for the rest of the timeout.
    (timer as { unref?: () => void }).unref?.();
    spec.run(controller.signal).then(
      (outcome) => finish(outcome),
      () => finish(freeOutcome(spec.failed())),
    );
  }
  return { promise, current: () => done, expire };
}

/** Resolves after `ms` (at once for 0 or less); the timer never keeps the process alive. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((r) => {
    timer = setTimeout(r, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Starts both side calls. Never throws; the returned handle never rejects. */
export function startSideContext(o: SideContextOptions): SideContextHandle {
  const now = o.now ?? Date.now;
  const startedAt = now();
  const emit = (e: EventInput) => {
    try {
      o.emit(e);
    } catch {
      // The run log may already be closed; the block still reaches the report through settled().
    }
  };
  const input = {
    question: o.question,
    intent: o.intent,
    mode: o.mode,
    subjectName: o.subjectName,
    placeLabel: o.placeLabel,
    client: o.client,
    cache: o.cache,
    config: o.config,
    now,
  };

  const ai = startCall<AiContextBlock>({
    run: (signal) => runAiContext({ ...input, signal }),
    timeoutMs: o.config.aiTimeoutMs,
    timedOut: () => aiBlock("timed_out", SIDE_NOTES.aiTimedOut),
    failed: () => aiBlock("failed", SIDE_NOTES.aiFailed),
    stopped: () => aiBlock("failed", SIDE_NOTES.stopped),
    emit: (out) => emit({ type: "context.ai", block: out.block, usd: out.usd, ms: Math.max(0, now() - startedAt) }),
    runSignal: o.signal,
  });
  const web = startCall<WebContextBlock>({
    run: (signal) => runWebContext({ ...input, signal }),
    timeoutMs: o.config.webTimeoutMs,
    timedOut: () => webBlock("timed_out", SIDE_NOTES.webTimedOut),
    failed: () => webBlock("failed", SIDE_NOTES.webFailed),
    stopped: () => webBlock("failed", SIDE_NOTES.stopped),
    emit: (out) => emit({ type: "context.web", block: out.block, usd: out.usd, ms: Math.max(0, now() - startedAt) }),
    runSignal: o.signal,
  });

  const presenceOf = (out: CallOutcome<AiContextBlock> | null): MarketId[] | null => {
    if (out === null) return null;
    const { status, presenceMarkets } = out.block;
    return status === "ok" || status === "empty" ? [...presenceMarkets] : null;
  };

  const result = (a: CallOutcome<AiContextBlock>, w: CallOutcome<WebContextBlock>): SideContextResult => ({
    ai: a.block,
    web: w.block,
    usd: a.usd + w.usd,
    usage: addTokenUsage(a.usage, w.usage),
    webSearches: w.searches,
    models: { ai: a.model, web: w.model },
  });

  return {
    async presence(waitMs) {
      const ready = ai.current();
      if (ready !== null || waitMs <= 0) return presenceOf(ready);
      const wait = delay(waitMs);
      const out = await Promise.race([ai.promise, wait.promise.then(() => null)]);
      wait.cancel();
      return presenceOf(out);
    },
    async settled(waitMs) {
      if (ai.current() === null || web.current() === null) {
        const wait = delay(waitMs);
        await Promise.race([Promise.all([ai.promise, web.promise]), wait.promise]);
        wait.cancel();
        ai.expire();
        web.expire();
      }
      const [a, w] = await Promise.all([ai.promise, web.promise]);
      return result(a, w);
    },
  };
}
