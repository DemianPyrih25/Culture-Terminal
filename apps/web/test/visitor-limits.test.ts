// The public lane's per-visitor limits (visitor-limits.ts) and the agent slots per lane (run-manager
// laneSlots), SPEC §10.4. visitorWait reads the runs table through @ct/db's countRunsSince and
// runAgesSince; here they answer from an in-memory list of starts on a clock the tests move, so the
// window arithmetic and the filter are checked without a database. The run manager's use of both,
// across a restart, is tested against Postgres in lanes.integration.test.ts. Invented visitor keys only.
import type { CountRunsSinceOptions, RunAgesSinceOptions } from "@ct/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

interface Start {
  hash: string;
  ipHash: string | null;
  lane: "public" | "judge";
  at: number;
  /** False for a run that never left the queue (started_at null). */
  started?: boolean;
}

const store = { now: 0, starts: [] as Start[] };

function matching(options: CountRunsSinceOptions): Start[] {
  return store.starts.filter(
    (s) =>
      s.hash.startsWith(options.hashPrefix) &&
      s.at > store.now - options.sinceMs &&
      (options.ipHash === undefined || s.ipHash === options.ipHash) &&
      (options.lane === undefined || s.lane === options.lane) &&
      (options.startedOnly !== true || s.started !== false),
  );
}

vi.mock("@ct/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ct/db")>()),
  countRunsSince: vi.fn(async (_db: unknown, options: CountRunsSinceOptions) => matching(options).length),
  runAgesSince: vi.fn(async (_db: unknown, options: RunAgesSinceOptions) =>
    matching(options)
      .map((s) => store.now - s.at)
      .sort((a, b) => a - b)
      .slice(0, options.limit),
  ),
}));

const { DEFAULT_VISITOR_LIMITS, VISITOR_HASH_RETENTION_MS, visitorWait, visitorWaitMessage, waitWords } = await import(
  "../server/visitor-limits"
);
const { laneSlots } = await import("../server/run-manager");

const MIN = 60_000;
const HOUR = 60 * MIN;
const db = {} as Parameters<typeof visitorWait>[0];
/** The window arithmetic below was written against small limits; D24's defaults are checked on their own. */
const SMALL = { maxActive: 1, perHour: 3, perDay: 8 };

/** A public live run the visitor starts now. */
const start = (ipHash: string | null, over: Partial<Start> = {}) =>
  store.starts.push({ hash: "q1:invented", ipHash, lane: "public", at: store.now, ...over });

beforeEach(() => {
  store.now = Date.parse("2026-10-22T10:00:00.000Z");
  store.starts = [];
});

describe("visitorWait", () => {
  it("defaults to D24: 2 at once, 10 an hour, 30 a day", () => {
    expect(DEFAULT_VISITOR_LIMITS).toEqual({ maxActive: 2, perHour: 10, perDay: 30 });
  });

  it("allows 3 starts an hour, then says when the oldest leaves the hour", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
      start("visitor-a");
      store.now += 10 * MIN;
    }
    // 30 min after the first start: it leaves the hour in 30 min.
    expect(await visitorWait(db, "visitor-a", SMALL)).toEqual({ window: "hour", retryAfterS: 30 * 60 });
    // Another visitor is counted apart.
    expect(await visitorWait(db, "visitor-b", SMALL)).toBeNull();
    store.now += 30 * MIN;
    expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
  });

  it("allows 8 starts a day, then says when the oldest leaves the day", async () => {
    for (let i = 0; i < 8; i++) {
      expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
      start("visitor-a");
      store.now += 2 * 60 * MIN;
    }
    expect(await visitorWait(db, "visitor-a", SMALL)).toEqual({ window: "day", retryAfterS: 8 * 3600 });
    store.now += 8 * HOUR;
    expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
  });

  it("says the longer wait when both windows are full: a day that frees a start soon still waits for the hour", async () => {
    // 8 starts in the day, the oldest 23.9 h ago, 3 of them in the last 5 minutes.
    for (const agoMin of [23.9 * 60, 20 * 60, 15 * 60, 10 * 60, 5 * 60, 5, 3, 1]) start("visitor-a", { at: store.now - agoMin * MIN });
    // The day frees a start in 6 min; the hour, when the 5-minute-old start leaves it, in 55.
    const wait = await visitorWait(db, "visitor-a", SMALL);
    expect(wait).toEqual({ window: "hour", retryAfterS: 55 * 60 });
    // Waiting that long is enough: both windows have room again.
    store.now += (wait?.retryAfterS ?? 0) * 1000;
    expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
    // A day that holds longer than the hour is still the day's: with 5 a day, the 5th newest (10 h old) frees one in 14 h.
    store.now -= (wait?.retryAfterS ?? 0) * 1000;
    expect(await visitorWait(db, "visitor-a", { maxActive: 1, perHour: 3, perDay: 5 })).toEqual({ window: "day", retryAfterS: 14 * 3600 });
  });

  it("frees a start when the k-th newest leaves the window, however many came before", async () => {
    // Four starts in the hour against a limit of 3 (a limit lowered meanwhile): the 3rd newest, 40 min
    // old, frees one when it leaves the hour in 20 min; the oldest leaving (in 10 min) frees none.
    for (const agoMin of [50, 40, 20, 5]) start("visitor-a", { at: store.now - agoMin * MIN });
    expect(await visitorWait(db, "visitor-a", SMALL)).toEqual({ window: "hour", retryAfterS: 20 * 60 });
    expect(await visitorWait(db, "visitor-a", { maxActive: 1, perHour: 10, perDay: 0 })).toEqual({ window: "day", retryAfterS: 24 * 3600 });
  });

  it("counts only the visitor's public live runs: not judge runs, test runs or other visitors'", async () => {
    start("visitor-a", { lane: "judge" });
    start("visitor-a", { lane: "judge" });
    start("visitor-a", { hash: "fake:invented" });
    start("visitor-b");
    start(null);
    start("visitor-a");
    start("visitor-a");
    expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
    start("visitor-a");
    expect(await visitorWait(db, "visitor-a", SMALL)).toMatchObject({ window: "hour" });
  });

  it("counts no run that never left the queue (queue timeout, cancel or shutdown while queued)", async () => {
    for (let i = 0; i < 5; i++) start("visitor-a", { started: false });
    start("visitor-a");
    start("visitor-a");
    expect(await visitorWait(db, "visitor-a", SMALL)).toBeNull();
    start("visitor-a");
    expect(await visitorWait(db, "visitor-a", SMALL)).toMatchObject({ window: "hour" });
  });

  it("keeps a hash only past the day window, never shorter", () => {
    expect(VISITOR_HASH_RETENTION_MS).toBeGreaterThan(24 * HOUR);
  });
});

describe("visitorWaitMessage", () => {
  it("names the limit reached and the wait in words, never 'tomorrow' for a short one", () => {
    expect(visitorWaitMessage({ window: "hour", retryAfterS: 55 * 60 }, SMALL)).toBe(
      "You have started 3 live questions in the last hour. Try again in 55 minutes; answers you already have still open.",
    );
    expect(visitorWaitMessage({ window: "day", retryAfterS: 360 }, SMALL)).toBe(
      "You have started 8 live questions in the last day. Try again in 6 minutes; answers you already have still open.",
    );
    expect(visitorWaitMessage({ window: "day", retryAfterS: 14 * 3600 - 30 }, { maxActive: 1, perHour: 1, perDay: 1 })).toBe(
      "You have started 1 live question in the last day. Try again in about 14 hours; answers you already have still open.",
    );
    expect(visitorWaitMessage({ window: "hour", retryAfterS: 60 })).toBe(
      "You have started 10 live questions in the last hour. Try again in 1 minute; answers you already have still open.",
    );
  });

  it("rounds a wait up below the hour and to the nearest hour above it", () => {
    expect(waitWords(1)).toBe("1 minute");
    expect(waitWords(61)).toBe("2 minutes");
    expect(waitWords(59 * 60 + 1)).toBe("about 1 hour");
    expect(waitWords(90 * 60)).toBe("about 2 hours");
  });
});

describe("laneSlots", () => {
  it("holds the judge lane's slot inside the global 3, and none while the lane is closed", () => {
    expect(laneSlots(3, 1)).toEqual({ public: 2, judge: 1 });
    expect(laneSlots(3, 0)).toEqual({ public: 3, judge: 0 });
    expect(laneSlots(5, 2)).toEqual({ public: 3, judge: 2 });
  });

  it("never holds every slot for judges: the public lane keeps one", () => {
    expect(laneSlots(1, 1)).toEqual({ public: 1, judge: 1 });
    expect(laneSlots(2, 5)).toEqual({ public: 1, judge: 2 });
  });
});
