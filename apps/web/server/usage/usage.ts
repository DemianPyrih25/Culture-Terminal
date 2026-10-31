import "server-only";
import type { Lane } from "@ct/contracts";
import { countRunsSince, RUN_AGES_MAX, runAgesSince, type CountRunsSinceOptions, type Queryable } from "@ct/db";
import { QUESTION_HASH_PREFIX } from "../question-hash";
import { countLaneRunsSince } from "../run-counts";
import type { VisitorLimits } from "../visitor-limits";

/**
 * What Settings > Plan & usage shows, read only: the limits a visitor can reach and how much of each
 * is used, counted the way admission counts them. The public lane's answers are this visitor's own
 * (runs.ip_hash, the rolling hour and 24 hours, runs held here); the review lane's are the whole
 * lane's, as its caps are. Screens are this visitor's, from the screener's limiter in this process.
 * A part that cannot be read is left out, never guessed.
 */

/** A rolling window: starts counted, its limit, and the seconds until the start that frees a place leaves it. */
export interface UsageWindow {
  used: number;
  limit: number;
  /** Null when nothing is in the window, or the start that frees one is past what one read returns. */
  nextFreeS: number | null;
}

export interface UsageSlots {
  used: number;
  limit: number;
}

export interface AccessUsage {
  /** "visitor": this visitor's own counts; "lane": the review lane's, shared by every review pass. */
  scope: "visitor" | "lane";
  answers?: { hour: UsageWindow; day: UsageWindow; active?: UsageSlots };
  screener?: { hour: UsageWindow; minute: UsageSlots };
}

export interface UsageSources {
  db: Queryable;
  lane: Lane;
  /** The salted address hash (client-ip.ts); null without an address, where no per-visitor limit applies. */
  visitor: string | null;
  visitorLimits: VisitorLimits;
  judge: { slots: number; perHour: number; perDay: number };
  /** Runs held here: this visitor's public runs, or the lane's runs on its slots. */
  heldBy: (visitor: string) => number;
  laneHeld: (lane: Lane) => number;
  screener: ((visitor: string) => { minute: number; hour: number; hourFreeS: number | null; perMinute: number; perHour: number }) | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/**
 * The window's count, and when a place frees: below the limit the oldest start leaving it, at or past
 * the limit the limit-th newest (as visitor-limits.ts reads a wait). Ages come newest first.
 */
async function windowOf(
  db: Queryable,
  count: () => Promise<number>,
  scope: Omit<CountRunsSinceOptions, "sinceMs">,
  ms: number,
  limit: number,
): Promise<UsageWindow> {
  const used = await count();
  const index = used >= limit ? limit - 1 : used - 1;
  if (used === 0 || index < 0 || index >= RUN_AGES_MAX) return { used, limit, nextFreeS: null };
  const ages = await runAgesSince(db, { ...scope, sinceMs: ms, limit: index + 1 });
  const age = ages[index] ?? ages.at(-1);
  return { used, limit, nextFreeS: age === undefined ? null : seconds(ms - age) };
}

/** The runs held here, or nothing when the run manager cannot say (the row is then left out). */
function held(read: () => UsageSlots): { active?: UsageSlots } {
  try {
    return { active: read() };
  } catch {
    return {};
  }
}

async function answersOf(s: UsageSources): Promise<AccessUsage["answers"]> {
  if (s.lane === "judge") {
    // The lane's caps, counted as admission counts them (run-counts.ts).
    const scope = { hashPrefix: QUESTION_HASH_PREFIX, lane: "judge", startedOnly: true } as const;
    const hour = await windowOf(s.db, () => countLaneRunsSince(s.db, "judge", HOUR_MS), scope, HOUR_MS, s.judge.perHour);
    const day = await windowOf(s.db, () => countLaneRunsSince(s.db, "judge", DAY_MS), scope, DAY_MS, s.judge.perDay);
    return { hour, day, ...held(() => ({ used: s.laneHeld("judge"), limit: s.judge.slots })) };
  }
  if (s.visitor === null) return undefined;
  // The scope visitor-limits.ts counts: this visitor's public agent runs that started.
  const scope = { hashPrefix: QUESTION_HASH_PREFIX, ipHash: s.visitor, lane: "public", startedOnly: true } as const;
  const { perHour, perDay, maxActive } = s.visitorLimits;
  const hour = await windowOf(s.db, () => countRunsSince(s.db, { ...scope, sinceMs: HOUR_MS }), scope, HOUR_MS, perHour);
  const day = await windowOf(s.db, () => countRunsSince(s.db, { ...scope, sinceMs: DAY_MS }), scope, DAY_MS, perDay);
  const visitor = s.visitor;
  return { hour, day, ...held(() => ({ used: s.heldBy(visitor), limit: maxActive })) };
}

function screenerOf(s: UsageSources): AccessUsage["screener"] {
  if (s.visitor === null || s.screener === null) return undefined;
  const u = s.screener(s.visitor);
  return { hour: { used: u.hour, limit: u.perHour, nextFreeS: u.hourFreeS }, minute: { used: u.minute, limit: u.perMinute } };
}

/** The visitor's usage; null when nothing of it can be read (no address on the public lane, or every read failed). */
export async function readUsage(s: UsageSources, onError: (err: unknown, part: string) => void = () => {}): Promise<AccessUsage | null> {
  const usage: AccessUsage = { scope: s.lane === "judge" ? "lane" : "visitor" };
  try {
    const answers = await answersOf(s);
    if (answers) usage.answers = answers;
  } catch (err) {
    onError(err, "answers");
  }
  try {
    const screener = screenerOf(s);
    if (screener) usage.screener = screener;
  } catch (err) {
    onError(err, "screener");
  }
  return usage.answers || usage.screener ? usage : null;
}
