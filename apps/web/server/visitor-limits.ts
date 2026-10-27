import "server-only";
import { countRunsSince, RUN_AGES_MAX, runAgesSince, type CountRunsSinceOptions, type Queryable } from "@ct/db";
import { QUESTION_HASH_PREFIX } from "./question-hash";

/**
 * SPEC §10.4's public lane, per visitor: one live run at a time, 3 an hour and 8 a day, keyed by the
 * visitor's salted address hash (client-ip.ts), which every run records in runs.ip_hash. The hour and
 * the day are counted in the database, so a restart forgets none of them while IP_HASH_SALT stays the
 * same (without it the keys, and so the counts, start over on a restart). Runs at once are counted by
 * the run manager in the process that holds them, which is the whole deploy. Past the day a hash
 * counts toward nothing, and the run manager clears it (VISITOR_HASH_RETENTION_MS).
 */
export interface VisitorLimits {
  /** Live runs one visitor holds at once. */
  maxActive: number;
  /** Live runs one visitor may start per rolling hour. */
  perHour: number;
  /** Live runs one visitor may start per rolling 24 hours. */
  perDay: number;
}

export const DEFAULT_VISITOR_LIMITS: VisitorLimits = { maxActive: 1, perHour: 3, perDay: 8 };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Runs keep the visitor's hash this long: the day window, and an hour to spare. */
export const VISITOR_HASH_RETENTION_MS = DAY_MS + HOUR_MS;

/** A limit a visitor reached, and the seconds until a start drops out of its window. */
export interface VisitorWait {
  window: "hour" | "day";
  retryAfterS: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** The runs that count against a visitor: its public-lane agent runs (judge runs are the lane's to limit). */
const visitorScope = (visitor: string): Omit<CountRunsSinceOptions, "sinceMs"> => ({
  hashPrefix: QUESTION_HASH_PREFIX,
  ipHash: visitor,
  lane: "public",
});

/** Null while the window has room for a start; else when the start that frees one leaves the window. */
async function windowWait(
  db: Queryable,
  scope: Omit<CountRunsSinceOptions, "sinceMs">,
  window: VisitorWait["window"],
  ms: number,
  limit: number,
): Promise<VisitorWait | null> {
  if ((await countRunsSince(db, { ...scope, sinceMs: ms })) < limit) return null;
  // A limit no start fits under (0), or past what one read returns: wait the whole window.
  if (limit < 1 || limit > RUN_AGES_MAX) return { window, retryAfterS: seconds(ms) };
  // With n starts and a limit of k, the k-th newest start leaving the window frees one. Fewer than k
  // now: one left between the two reads.
  const kth = (await runAgesSince(db, { ...scope, sinceMs: ms, limit }))[limit - 1];
  return { window, retryAfterS: seconds(kth === undefined ? 0 : ms - kth) };
}

/**
 * Null while the visitor may start a public live run; else the limit that holds it longest and when
 * a start leaves that window, both read from the runs table on the database clock. Both windows are
 * read: a full day can free a start minutes before a full hour does, and the visitor waits for both.
 */
export async function visitorWait(
  db: Queryable,
  visitor: string,
  limits: VisitorLimits = DEFAULT_VISITOR_LIMITS,
): Promise<VisitorWait | null> {
  const scope = visitorScope(visitor);
  const day = await windowWait(db, scope, "day", DAY_MS, limits.perDay);
  const hour = await windowWait(db, scope, "hour", HOUR_MS, limits.perHour);
  if (day === null || hour === null) return day ?? hour;
  return hour.retryAfterS > day.retryAfterS ? hour : day;
}

/** "6 minutes", "about 14 hours": a refused visitor's wait, rounded up below the hour. */
export function waitWords(retryAfterS: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterS / 60));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** What a refused visitor reads: the limit reached and when to try again (the Retry-After, in words). */
export function visitorWaitMessage(wait: VisitorWait, limits: VisitorLimits = DEFAULT_VISITOR_LIMITS): string {
  const n = wait.window === "hour" ? limits.perHour : limits.perDay;
  return `You have started ${n} live ${n === 1 ? "question" : "questions"} in the last ${wait.window}. Try again in ${waitWords(wait.retryAfterS)}; answers you already have still open.`;
}
