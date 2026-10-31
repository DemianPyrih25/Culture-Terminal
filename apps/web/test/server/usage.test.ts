// readUsage (server/usage/usage.ts): this visitor's use of each limit, counted as admission counts it,
// and the screener limiter's read-only visitorUsage. @ct/db's counts are stubbed; nothing here is real data.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const counts = { hour: 0, day: 0 };
const ages: number[] = [];
vi.mock("@ct/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RUN_AGES_MAX: 100,
  countRunsSince: vi.fn(async (_db: unknown, o: { sinceMs: number }) => (o.sinceMs === 3_600_000 ? counts.hour : counts.day)),
  runAgesSince: vi.fn(async (_db: unknown, o: { limit: number }) => ages.slice(0, o.limit)),
}));

const { readUsage } = await import("../../server/usage/usage");
const { DesLimiter } = await import("../../server/des/limits");

const HOUR = 3_600_000;

function sources(over: Partial<Parameters<typeof readUsage>[0]> = {}): Parameters<typeof readUsage>[0] {
  return {
    db: {} as never,
    lane: "public",
    visitor: "visitor-hash-0001",
    visitorLimits: { maxActive: 2, perHour: 10, perDay: 30 },
    judge: { slots: 2, perHour: 30, perDay: 120 },
    heldBy: () => 1,
    laneHeld: () => 0,
    screener: () => ({ minute: 1, hour: 3, hourFreeS: 600, perMinute: 4, perHour: 20 }),
    ...over,
  };
}

describe("readUsage", () => {
  it("counts the visitor's answers, what it holds, and when the oldest start frees a place", async () => {
    counts.hour = 2;
    counts.day = 5;
    ages.splice(0, ages.length, 60_000, 20 * 60_000, 2 * HOUR, 3 * HOUR, 5 * HOUR);
    const usage = await readUsage(sources());
    expect(usage).toEqual({
      scope: "visitor",
      answers: {
        hour: { used: 2, limit: 10, nextFreeS: 40 * 60 },
        day: { used: 5, limit: 30, nextFreeS: 19 * 3600 },
        active: { used: 1, limit: 2 },
      },
      screener: { hour: { used: 3, limit: 20, nextFreeS: 600 }, minute: { used: 1, limit: 4 } },
    });
  });

  it("at the limit, times the start that brings it back under", async () => {
    counts.hour = 3;
    counts.day = 3;
    ages.splice(0, ages.length, 10 * 60_000, 30 * 60_000, 50 * 60_000);
    const usage = await readUsage(sources({ visitorLimits: { maxActive: 2, perHour: 2, perDay: 30 } }));
    expect(usage?.answers?.hour).toEqual({ used: 3, limit: 2, nextFreeS: 30 * 60 });
  });

  it("leaves out a part it cannot read, and returns null when nothing can be", async () => {
    const failing = sources({ heldBy: () => { throw new Error("gone"); } });
    expect((await readUsage(failing))?.answers).toEqual({ hour: expect.any(Object), day: expect.any(Object) });
    expect(await readUsage(sources({ screener: () => { throw new Error("gone"); } }))).not.toHaveProperty("screener");
    expect(await readUsage(sources({ visitor: null, screener: null }))).toBeNull();
  });
});

describe("DesLimiter.visitorUsage", () => {
  it("reads a visitor's minute and hour without changing a window", () => {
    const limiter = new DesLimiter({ visitorPerMinute: 4, visitorPerHour: 3, globalPerHour: 100, dailyNetworkCalls: 100 });
    const t0 = 1_000_000_000;
    for (const at of [t0, t0 + 10 * 60_000, t0 + 50 * 60_000]) expect(limiter.take("v1", at)).toBeNull();
    const now = t0 + 50 * 60_000 + 30_000;
    expect(limiter.visitorUsage("v1", now)).toEqual({ minute: 1, hour: 3, hourFreeS: 10 * 60 - 30 });
    expect(limiter.visitorUsage("v1", now)).toEqual({ minute: 1, hour: 3, hourFreeS: 10 * 60 - 30 });
    expect(limiter.take("v1", now)).not.toBeNull();
    expect(limiter.visitorUsage("v2", now)).toEqual({ minute: 0, hour: 0, hourFreeS: null });
  });
});
