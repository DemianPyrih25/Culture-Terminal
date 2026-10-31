// A small in-memory sliding-window limiter for the auth endpoints (per process). It slows password
// guessing and sign-up floods from one address; it is not shared between instances.

export interface AuthLimits {
  /** Attempts per window per key. */
  max: number;
  windowMs: number;
}

export const LOGIN_LIMITS: AuthLimits = { max: 20, windowMs: 10 * 60_000 };
export const SIGNUP_LIMITS: AuthLimits = { max: 10, windowMs: 60 * 60_000 };

const MAX_KEYS = 50_000;

export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limits: AuthLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns 0 when allowed, else the seconds until the next attempt is. */
  hit(key: string): number {
    const t = this.now();
    const from = t - this.limits.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (list.length >= this.limits.max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil(((list[0] ?? t) + this.limits.windowMs - t) / 1000));
    }
    list.push(t);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return 0;
  }
}

type LimiterGlobal = typeof globalThis & { __ctAuthLimitersV2?: { login: AttemptLimiter; signup: AttemptLimiter } };

export function authLimiters(): { login: AttemptLimiter; signup: AttemptLimiter } {
  const g = globalThis as LimiterGlobal;
  return (g.__ctAuthLimitersV2 ??= { login: new AttemptLimiter(LOGIN_LIMITS), signup: new AttemptLimiter(SIGNUP_LIMITS) });
}
