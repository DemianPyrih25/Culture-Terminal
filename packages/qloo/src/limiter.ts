import { setTimeout as delay } from "node:timers/promises";
import pLimit, { type LimitFunction } from "p-limit";

/**
 * Pacing (PLAN §5.1 step 6): a global token bucket at QLOO_RPS (prod 7, dev agents 1.5) with burst
 * max(1, floor(rps)), and a global cap of 6 requests in flight. Each attempt, retries included, takes
 * one token. The clock and sleep are injectable so tests run without real time.
 */

export type Now = () => number;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realNow: Now = () => Date.now();

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export const realSleep: Sleep = async (ms, signal) => {
  await delay(ms, undefined, signal ? { signal } : undefined);
};

/** Global requests in flight (D24). */
export const GLOBAL_CONCURRENCY = 6;
/** Requests in flight per run (PLAN §5.1 step 6). */
export const RUN_CONCURRENCY = 4;

export const burstFor = (rps: number): number => Math.max(1, Math.floor(rps));

// Refill arithmetic in floating point lands a hair under a whole token after an exact wait.
const EPSILON = 1e-9;

export interface TokenBucketOptions {
  rps: number;
  burst?: number;
  now: Now;
  sleep: Sleep;
}

/** A FIFO token bucket: callers get tokens in the order they asked, starting with a full burst. */
export class TokenBucket {
  readonly rps: number;
  readonly burst: number;
  private tokens: number;
  private last: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly now: Now;
  private readonly sleep: Sleep;

  constructor(options: TokenBucketOptions) {
    if (!(options.rps > 0) || !Number.isFinite(options.rps)) throw new RangeError(`rps must be positive, got ${options.rps}`);
    this.rps = options.rps;
    this.burst = options.burst ?? burstFor(options.rps);
    this.tokens = this.burst;
    this.now = options.now;
    this.sleep = options.sleep;
    this.last = options.now();
  }

  /** Waits for one token. An aborted waiter leaves the queue without taking a token. */
  take(signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(() => this.acquire(signal));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= 1 - EPSILON) {
        this.tokens = Math.max(0, this.tokens - 1);
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rps) * 1000), signal);
    }
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, t - this.last) / 1000) * this.rps);
    this.last = t;
  }
}

export interface RequestLimiterOptions {
  rps: number;
  concurrency?: number;
  now: Now;
  sleep: Sleep;
}

/** The process-wide limiter every attempt passes through: a concurrency slot, then a token. */
export class RequestLimiter {
  private readonly slots: LimitFunction;
  private readonly bucket: TokenBucket;

  constructor(options: RequestLimiterOptions) {
    this.slots = pLimit(options.concurrency ?? GLOBAL_CONCURRENCY);
    this.bucket = new TokenBucket({ rps: options.rps, now: options.now, sleep: options.sleep });
  }

  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.slots(async () => {
      signal?.throwIfAborted();
      await this.bucket.take(signal);
      signal?.throwIfAborted();
      return fn();
    });
  }
}
