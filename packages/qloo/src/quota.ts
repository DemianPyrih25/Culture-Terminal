import { z } from "zod";
import type { Now } from "./limiter";
import type { QlooLogger } from "./logger";
import type { QlooStore } from "./store";
import type { QlooHeaders } from "./transport-types";

/**
 * The quota snapshot (PLAN §5.1 step 5, SPEC §10.3 health): the monthly numbers from the last
 * response headers, auth health and today's network calls. It lives in memory, is persisted to kv
 * at most every few seconds (a change inside the interval is written when it ends, and flush writes
 * at once), and is loaded before the first network call so the month floor and the auth streak hold
 * across restarts.
 */

/** kv key of the live snapshot. Mock mode keeps its own, so synthetic headers never overwrite real ones. */
export const QUOTA_KV_KEY = "qloo.quota";
export const MOCK_QUOTA_KV_KEY = "qloo.quota.mock";

const PERSIST_INTERVAL_MS = 5_000;

export const QuotaSnapshot = z.object({
  monthLimit: z.number().nullable(),
  monthRemaining: z.number().nullable(),
  /** When the monthly window resets (ISO), computed from x-month-ratelimit-reset at capture; cleared with monthRemaining once it passes. */
  monthReset: z.string().nullable(),
  /** When the month numbers were captured (ISO). */
  capturedAt: z.string().nullable(),
  /** Last 2xx data response (ISO). */
  lastSuccessAt: z.string().nullable(),
  consecutiveAuthErrors: z.int().nonnegative(),
  /** UTC day (YYYY-MM-DD) that todayNetwork counts. */
  day: z.string(),
  /** Network calls today (UTC) as this process counts them, seeded from the snapshot it loaded. */
  todayNetwork: z.int().nonnegative(),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface QuotaTrackerOptions {
  store: QlooStore;
  kvKey: string;
  now: Now;
  logger: QlooLogger;
  /** Registers a background write so the client's flush() can await it. */
  track: (write: Promise<unknown>) => void;
}

export class QuotaTracker {
  private state: QuotaSnapshot;
  private loading: Promise<void> | null = null;
  private dirty = false;
  private lastPersistAt = Number.NEGATIVE_INFINITY;
  /** The write owed for changes made inside the throttle interval. */
  private trailing: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: QuotaTrackerOptions) {
    this.state = {
      monthLimit: null,
      monthRemaining: null,
      monthReset: null,
      capturedAt: null,
      lastSuccessAt: null,
      consecutiveAuthErrors: 0,
      day: utcDay(options.now()),
      todayNetwork: 0,
    };
  }

  /** Loads the persisted snapshot once. A missing or unreadable one leaves the defaults. */
  load(): Promise<void> {
    this.loading ??= this.options.store.getKv(this.options.kvKey).then(
      (raw) => {
        if (raw === undefined) return;
        const parsed = QuotaSnapshot.safeParse(raw);
        if (parsed.success) this.state = parsed.data;
        else this.options.logger.warn({ key: this.options.kvKey }, "qloo quota snapshot in kv is malformed; ignoring it");
      },
      (err: unknown) => {
        this.options.logger.warn({ err: String(err) }, "qloo quota snapshot could not be loaded");
      },
    );
    return this.loading;
  }

  snapshot(): QuotaSnapshot {
    this.rollDay();
    this.rollMonth();
    return { ...this.state };
  }

  /** Takes the monthly numbers from a response; headers that are absent leave the last known values. */
  observe(headers: QlooHeaders): void {
    if (headers.monthRemaining === null && headers.monthLimit === null && headers.monthReset === null) return;
    const now = this.options.now();
    this.state.monthRemaining = headers.monthRemaining ?? this.state.monthRemaining;
    this.state.monthLimit = headers.monthLimit ?? this.state.monthLimit;
    if (headers.monthReset !== null) this.state.monthReset = new Date(now + headers.monthReset * 1000).toISOString();
    this.state.capturedAt = new Date(now).toISOString();
    this.changed();
  }

  recordSuccess(): void {
    this.state.lastSuccessAt = new Date(this.options.now()).toISOString();
    this.state.consecutiveAuthErrors = 0;
    this.changed();
  }

  /** A response that proves the key works without being data (e.g. 400, 429) ends an auth streak. */
  recordKeyAccepted(): void {
    if (this.state.consecutiveAuthErrors === 0) return;
    this.state.consecutiveAuthErrors = 0;
    this.changed();
  }

  /** Returns the length of the current 401/403 streak. */
  recordAuthError(): number {
    this.state.consecutiveAuthErrors += 1;
    this.changed();
    return this.state.consecutiveAuthErrors;
  }

  recordNetwork(): void {
    this.rollDay();
    this.state.todayNetwork += 1;
    this.changed();
  }

  /** Writes the snapshot now when anything changed since the last write. */
  persistNow(): void {
    if (this.trailing !== null) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.lastPersistAt = this.options.now();
    const { store, kvKey, logger } = this.options;
    // Writes are chained so an older snapshot never lands after a newer one.
    this.writes = this.writes.then(() =>
      store.setKv(kvKey, this.snapshot()).catch((err: unknown) => {
        this.dirty = true;
        logger.warn({ err: String(err) }, "qloo quota snapshot could not be saved");
      }),
    );
    this.options.track(this.writes);
  }

  /**
   * Persists at once, or once the throttle interval is over, so the last change always lands even
   * when no later change or flush() follows. The timer is unref'd and never holds the process open.
   */
  private changed(): void {
    this.dirty = true;
    const wait = PERSIST_INTERVAL_MS - (this.options.now() - this.lastPersistAt);
    if (wait <= 0) this.persistNow();
    else this.trailing ??= setTimeout(() => this.persistNow(), wait).unref();
  }

  private rollDay(): void {
    const today = utcDay(this.options.now());
    if (this.state.day === today) return;
    this.state.day = today;
    this.state.todayNetwork = 0;
    this.dirty = true;
  }

  /**
   * Once the monthly window has reset, the remaining count belongs to the old month: it becomes
   * unknown, so the month floor lets the next call through and its headers bring the new count. A
   * reset no later than the capture (a header of 0) is ignored, so a missing window never lifts the floor.
   */
  private rollMonth(): void {
    const { monthReset, capturedAt } = this.state;
    if (monthReset === null) return;
    const reset = Date.parse(monthReset);
    if (Number.isNaN(reset) || reset > this.options.now()) return;
    if (capturedAt !== null && reset <= Date.parse(capturedAt)) return;
    this.state.monthRemaining = null;
    this.state.monthReset = null;
    this.dirty = true;
  }
}
