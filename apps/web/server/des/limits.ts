import "server-only";

/**
 * The tearsheet's own guards, beside the Qloo client's caps (D24): a tearsheet costs no LLM, but each
 * new one can cost up to DES_RUN_QLOO_CAP fresh Qloo calls, so lookups are limited per visitor (the
 * salted address hash, client-ip.ts), per hour for the whole process, and in fresh Qloo calls per UTC
 * day, which leaves the day's lane caps to the briefs. A tearsheet served from the answer cache costs
 * nothing and counts toward none of them. A lookup reserves its whole Qloo cap when it starts and
 * gives back what it did not use when it ends, so lookups that run together cannot pass the day's
 * allowance between them. The counters live in this process (one web service).
 */

export interface DesLimits {
  /** New tearsheets one visitor may ask for per rolling minute. */
  visitorPerMinute: number;
  /** New tearsheets one visitor may ask for per rolling hour. */
  visitorPerHour: number;
  /** New tearsheets the process computes per rolling hour, for all visitors together. */
  globalPerHour: number;
  /** Fresh (network) Qloo calls tearsheets may make per UTC day. */
  dailyNetworkCalls: number;
}

export const DEFAULT_DES_LIMITS: DesLimits = { visitorPerMinute: 6, visitorPerHour: 30, globalPerHour: 240, dailyNetworkCalls: 400 };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Visitors whose windows are kept at once; the least recently seen go first. */
export const DES_VISITORS_MAX = 5_000;

/** A limit reached, and the seconds until the oldest lookup in its window leaves it. */
export interface DesWait {
  scope: "visitor" | "global" | "daily";
  retryAfterS: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** The next 00:00 UTC after `now`, in ms. */
export function nextUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Drops the times that left a window of `ms` before `now`, oldest first. */
function prune(times: number[], now: number, ms: number): void {
  while (times.length > 0 && (times[0] ?? now) <= now - ms) times.shift();
}

/**
 * Sliding windows over lookup start times. take() checks every window and, when all have room,
 * records the lookup in the same tick, so a burst cannot pass the checks together.
 */
export class DesLimiter {
  /** Start times per visitor key over the last hour, oldest first; the map is in least-recent order. */
  private readonly visitors = new Map<string, number[]>();
  /** Start times over the last hour, for all visitors. */
  private readonly global: number[] = [];
  private day = "";
  private network = 0;

  constructor(
    readonly limits: DesLimits = DEFAULT_DES_LIMITS,
    private readonly maxVisitors: number = DES_VISITORS_MAX,
  ) {}

  /**
   * Null when the lookup may start: it is recorded, and `reserve` fresh Qloo calls (its cap) are held
   * for it until settle(); otherwise the limit that holds it.
   */
  take(visitor: string | null, now: number, reserve = 0): DesWait | null {
    this.rollDay(now);
    const held = Math.max(0, Math.round(reserve));
    if (this.network + Math.max(1, held) > this.limits.dailyNetworkCalls) return { scope: "daily", retryAfterS: seconds(nextUtcMidnight(now) - now) };
    prune(this.global, now, HOUR_MS);
    const oldestGlobal = this.global[0];
    if (this.global.length >= this.limits.globalPerHour && oldestGlobal !== undefined) {
      return { scope: "global", retryAfterS: seconds(oldestGlobal + HOUR_MS - now) };
    }
    // Without an address (local dev, tests) no per-visitor limit applies, as for live runs.
    const times = visitor === null ? null : (this.visitors.get(visitor) ?? []);
    if (times !== null) {
      prune(times, now, HOUR_MS);
      const wait = this.visitorWait(times, now);
      if (wait !== null) return wait;
    }
    this.global.push(now);
    this.network += held;
    if (visitor !== null && times !== null) {
      times.push(now);
      this.visitors.delete(visitor);
      this.visitors.set(visitor, times);
      for (const key of this.visitors.keys()) {
        if (this.visitors.size <= this.maxVisitors) break;
        this.visitors.delete(key);
      }
    }
    return null;
  }

  /**
   * A finished lookup's fresh Qloo calls in place of what it reserved at take(). A reservation made
   * before 00:00 UTC went with that day's count, so only the calls are counted then.
   */
  settle(reserved: number, used: number, startedAt: number, now: number): void {
    this.rollDay(now);
    const calls = Math.max(0, Math.round(used));
    const held = utcDay(startedAt) === this.day ? Math.max(0, Math.round(reserved)) : 0;
    this.network = Math.max(0, this.network + calls - held);
  }

  /** Fresh Qloo calls tearsheets made today (UTC), with what the lookups in flight still hold. */
  networkToday(now: number): number {
    this.rollDay(now);
    return this.network;
  }

  private visitorWait(times: readonly number[], now: number): DesWait | null {
    const { visitorPerMinute, visitorPerHour } = this.limits;
    const inMinute = times.filter((t) => t > now - MINUTE_MS);
    const waits: number[] = [];
    // With n starts and a limit of k, the k-th newest start leaving the window frees one.
    if (inMinute.length >= visitorPerMinute) waits.push((inMinute[inMinute.length - visitorPerMinute] ?? now) + MINUTE_MS - now);
    if (times.length >= visitorPerHour) waits.push((times[times.length - visitorPerHour] ?? now) + HOUR_MS - now);
    return waits.length === 0 ? null : { scope: "visitor", retryAfterS: seconds(Math.max(...waits)) };
  }

  private rollDay(now: number): void {
    const day = utcDay(now);
    if (day === this.day) return;
    this.day = day;
    this.network = 0;
  }
}
