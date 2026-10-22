// Rolling counts, retention purges and the run row lock, against a real Postgres in a throwaway
// database. Skips only when no database is reachable; in CI with DATABASE_URL set it never skips.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { appendEvents, listEvents } from "../src/repos/runEvents";
import { countRunsSince, createRun, getRun, lockRun, purgeRuns, setStatus } from "../src/repos/runs";
import { type NewRun, type RunStatus, runs } from "../src/schema";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const HOUR = 3600 * 1000;

describe.skipIf(!probe.ok)("run retention against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  let n = 0;
  /** A run with two events, created `ageHours` ago by the database clock. */
  async function seed(hash: string, status: RunStatus, ageHours: number, over: Partial<NewRun> = {}) {
    n += 1;
    const run = await createRun(db, { question: "Does Aurora Footwear travel?", questionHash: hash, status, ...over });
    await appendEvents(db, run.id, [
      { seq: 1, type: "note", payload: { text: `seed ${n}` } },
      { seq: 2, type: "note", payload: { text: `seed ${n} again` } },
    ]);
    await db
      .update(runs)
      .set({ createdAt: sql`now() - make_interval(secs => ${ageHours * 3600})` })
      .where(eq(runs.id, run.id));
    return run.id;
  }

  it("counts runs by hash prefix inside a rolling window, whatever their status", async () => {
    await seed("count:a", "completed", 0);
    await seed("count:b", "cancelled", 0.5);
    await seed("count:c", "running", 0);
    await seed("count:old", "completed", 2);
    await seed("other:a", "completed", 0);
    expect(await countRunsSince(db, { hashPrefix: "count:", sinceMs: HOUR })).toBe(4 - 1);
    expect(await countRunsSince(db, { hashPrefix: "count:", sinceMs: 3 * HOUR })).toBe(4);
    expect(await countRunsSince(db, { hashPrefix: "nothing:", sinceMs: HOUR })).toBe(0);
  });

  it("matches the prefix literally, not as a LIKE pattern", async () => {
    await seed("lit_x:1", "completed", 0);
    await seed("litAx:1", "completed", 0);
    await seed("pct%:1", "completed", 0);
    await seed("pctZ:1", "completed", 0);
    expect(await countRunsSince(db, { hashPrefix: "lit_x:", sinceMs: HOUR })).toBe(1);
    expect(await countRunsSince(db, { hashPrefix: "pct%:", sinceMs: HOUR })).toBe(1);
  });

  it("purges old runs with the prefix and their events, and keeps the rest", async () => {
    const oldDone = await seed("purge:1", "completed", 7);
    const oldCancelled = await seed("purge:2", "cancelled", 7);
    const oldRunning = await seed("purge:3", "running", 7);
    const recent = await seed("purge:4", "completed", 1);
    const otherHash = await seed("keep:1", "completed", 7);
    const child = await seed("keep:2", "completed", 0, { parentRunId: oldDone });

    const purged = await purgeRuns(db, { hashPrefix: "purge:", olderThanMs: 6 * HOUR, keepStatuses: ["queued", "running"] });
    expect(purged).toBe(2);
    for (const id of [oldDone, oldCancelled]) {
      expect(await getRun(db, id)).toBeUndefined();
      expect(await listEvents(db, id)).toEqual([]);
    }
    for (const id of [oldRunning, recent, otherHash, child]) {
      expect(await getRun(db, id)).toBeDefined();
      expect(await listEvents(db, id)).toHaveLength(2);
    }
    expect((await getRun(db, child))?.parentRunId).toBeNull();
    // Nothing left to purge.
    expect(await purgeRuns(db, { hashPrefix: "purge:", olderThanMs: 6 * HOUR, keepStatuses: ["queued", "running"] })).toBe(0);
  });

  it("refuses an empty prefix and a bad window before touching the database", async () => {
    await expect(purgeRuns(db, { hashPrefix: "", olderThanMs: HOUR })).rejects.toThrow(RangeError);
    await expect(purgeRuns(db, { hashPrefix: "x:", olderThanMs: 0 })).rejects.toThrow(RangeError);
    await expect(countRunsSince(db, { hashPrefix: "x:", sinceMs: Number.NaN })).rejects.toThrow(RangeError);
  });

  it("makes a second locker wait until the first transaction ends", async () => {
    const id = await seed("lock:1", "running", 0);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => (firstLocked = resolve));

    const first = db.transaction(async (tx) => {
      expect((await lockRun(tx, id))?.status).toBe("running");
      firstLocked();
      await firstHolds;
      await setStatus(tx, id, "incomplete", { from: ["running"] });
      order.push("first");
    });
    await locked;
    const second = db.transaction(async (tx) => {
      const run = await lockRun(tx, id);
      order.push(`second saw ${run?.status}`);
    });
    // run_events inserts are not blocked by the lock.
    await appendEvents(db, id, [{ seq: 3, type: "note", payload: { text: "while locked" } }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second saw incomplete"]);
    expect(await lockRun(db, "no-such-run")).toBeUndefined();
  });
});
