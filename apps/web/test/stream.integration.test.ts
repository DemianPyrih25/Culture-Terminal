// The Foundation "Done when": a fake run streams to the end, survives a disconnect and resumes
// without gaps or duplicates. Runs against a real Postgres in a throwaway database and skips only
// when no database is reachable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRunEvent, reduceRunEvents, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { appendEvents, countRunsSince, createDb, createRun, getRun, requestCancel, type Db } from "@ct/db";
import { EventBus } from "../server/event-bus";
import { readAllEvents, readEventsAfter, toEventRow } from "../server/event-store";
import { FAKE_HASH_PREFIX, RunManager, runManagerErrorCode, type RunManagerOptions } from "../server/run-manager";
import { runEventStream, type RunStreamDeps, type RunStreamOptions } from "../server/stream";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";
import { parseSseFrames, readBody } from "./support/sse";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HOUR = 3_600_000;
const ORPHAN_STREAM = { tailIntervalMs: 20, statusCheckMs: 20, orphanAfterMs: 1000 } satisfies RunStreamOptions;

/** A run whose server died ten minutes ago after storing three notes; its status is still running. */
async function seedOrphan(db: Db): Promise<string> {
  const runId = randomUUID();
  await createRun(db, { id: runId, question: "Orphan test", questionHash: `fake:${runId}`, status: "running" });
  const old = Date.now() - 10 * 60_000;
  const stored = [1, 2, 3].map((seq) =>
    stampEvent({ type: "note", text: `before the crash ${seq}` }, { seq, ts: new Date(old + seq).toISOString(), runId }),
  );
  await appendEvents(db, runId, stored.map(toEventRow));
  return runId;
}

/** Points the process container the route handlers read at a test manager while `fn` runs. */
async function withContainer<T>(container: object, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __ctContainer?: unknown; __ctMigrationsApplied?: boolean };
  g.__ctContainer = container;
  g.__ctMigrationsApplied = true;
  try {
    return await fn();
  } finally {
    delete g.__ctContainer;
    delete g.__ctMigrationsApplied;
  }
}

function expectGapFree(events: RunEvent[]): void {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
}

function endOf(events: RunEvent[]): Extract<RunEvent, { type: "run.end" }> {
  const last = events.at(-1);
  if (last?.type !== "run.end") throw new Error(`expected run.end last, got ${last?.type}`);
  return last;
}

/** Reads a stream to its end, or aborts it after `stopAfter` events like a dropped connection. */
async function collect(
  deps: RunStreamDeps,
  runId: string,
  afterSeq: number,
  options: { stopAfter?: number; stream?: RunStreamOptions } = {},
): Promise<RunEvent[]> {
  const controller = new AbortController();
  const out: RunEvent[] = [];
  for await (const event of runEventStream(deps, runId, afterSeq, controller.signal, options.stream)) {
    out.push(event);
    if (options.stopAfter !== undefined && out.length >= options.stopAfter) {
      controller.abort();
      break;
    }
  }
  return out;
}

describe.skipIf(!available)("fake run streaming against Postgres", () => {
  let t: TestDatabase | undefined;
  const managers: RunManager[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(managers.map((m) => m.drain(0)));
    await t?.dispose();
  }, 60_000);

  function setup(options: Partial<Omit<RunManagerOptions, "db" | "bus">> = {}) {
    const db = t!.db;
    const bus = new EventBus();
    const runs = new RunManager({ db, bus, cancelPollMs: 100, fakeRunSeconds: 3, ...options });
    managers.push(runs);
    const deps: RunStreamDeps = {
      db,
      bus,
      isLive: (id) => runs.isLive(id),
      finalizeOrphan: (id) => runs.finalizeOrphan(id),
    };
    return { db, bus, runs, deps };
  }

  it("streams a run live, survives a mid-run disconnect and resumes without gaps or duplicates", async () => {
    const { db, bus, runs, deps } = setup({ fakeRunSeconds: 4 });
    const { runId } = await runs.startFakeRun();

    const before = await collect(deps, runId, 0, { stopAfter: 30 });
    expect(bus.subscriberCount(runId)).toBe(0);
    expect(runs.isLive(runId)).toBe(true);
    await sleep(400); // the run carries on while the client is away
    const after = await collect(deps, runId, before.at(-1)!.seq);

    const all = [...before, ...after];
    expectGapFree(all);
    expect(all[0]?.type).toBe("run.created");
    expect(endOf(all).status).toBe("completed");
    for (const event of all) expect(() => parseRunEvent(event)).not.toThrow();
    // What streamed live is exactly what was stored.
    expect(all).toEqual(await readAllEvents(db, runId));
    expect((await getRun(db, runId))?.status).toBe("completed");
  }, 30_000);

  it("hands off from the replay to the live bus: writes during the replay arrive once, in order, without polling", async () => {
    const { db } = setup();
    const bus = new EventBus();
    const runId = randomUUID();
    await createRun(db, { id: runId, question: "Handoff test", questionHash: `fake:${runId}`, status: "running" });
    const at = (seq: number, input: EventInput) => stampEvent(input, { seq, ts: new Date().toISOString(), runId });
    const note = (seq: number) => at(seq, { type: "note", text: `note ${seq}` });
    // What the run manager does: store, then publish.
    const emit = async (event: RunEvent) => {
      await appendEvents(db, runId, [toEventRow(event)]);
      bus.publish(event);
    };
    await appendEvents(db, runId, [1, 2, 3].map(note).map(toEventRow));

    let reads = 0;
    const deps: RunStreamDeps = {
      db,
      bus,
      isLive: () => true,
      readEventsAfter: async (id, after, limit) => {
        reads += 1;
        if (reads > 1) return readEventsAfter(db, id, after, limit);
        // The run writes on while the replay reads: 4 and 5 land in the page and in the buffer,
        // 6 and run.end only in the buffer. Then the producer closes the bus, as it does after run.end.
        await emit(note(4));
        await emit(note(5));
        const page = await readEventsAfter(db, id, after, limit);
        await emit(note(6));
        await emit(at(7, { type: "run.end", status: "completed", elapsedMs: 1000, reason: null }));
        bus.close(runId);
        return page;
      },
    };
    const events = await collect(deps, runId, 0, { stream: { tailIntervalMs: 60_000, statusCheckMs: 60_000 } });
    expectGapFree(events);
    expect(events).toHaveLength(7);
    expect(events).toEqual(await readAllEvents(db, runId));
    // One read for the replay; everything after it came over the bus. A database tail reads again.
    expect(reads).toBe(1);
    expect(bus.subscriberCount(runId)).toBe(0);
  }, 30_000);

  it("replays a finished run from the database, from the start or from a cursor", async () => {
    const { db, runs } = setup({ fakeRunSeconds: 1 });
    const { runId } = await runs.startFakeRun();
    await runs.whenDone(runId);

    const elsewhere: RunStreamDeps = { db, bus: new EventBus(), isLive: () => false };
    const replay = await collect(elsewhere, runId, 0);
    expectGapFree(replay);
    expect(endOf(replay).status).toBe("completed");

    const resumed = await collect(elsewhere, runId, 50);
    expect(resumed[0]?.seq).toBe(51);
    expect(resumed).toEqual(replay.slice(50));
  }, 30_000);

  it("tails the database while another process drives the run", async () => {
    const { db, runs } = setup({ fakeRunSeconds: 2 });
    const { runId } = await runs.startFakeRun();
    // A second server instance: its own bus, and the run is not live there.
    const otherInstance: RunStreamDeps = { db, bus: new EventBus(), isLive: () => false };
    const events = await collect(otherInstance, runId, 0, { stream: { tailIntervalMs: 50 } });
    expectGapFree(events);
    expect(endOf(events).status).toBe("completed");
  }, 30_000);

  it("stops at the database cancel flag", async () => {
    const { db, runs, deps } = setup({ fakeRunSeconds: 60 });
    const { runId } = await runs.startFakeRun();
    await collect(deps, runId, 0, { stopAfter: 3 });
    expect(await requestCancel(db, runId)).toBe(true);
    await runs.whenDone(runId);

    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    expect(endOf(events)).toMatchObject({ status: "cancelled" });
    expect((await getRun(db, runId))?.status).toBe("cancelled");
  }, 30_000);

  it("on shutdown refuses new runs, lets short runs finish and marks the rest incomplete", async () => {
    const { db, runs } = setup();
    const short = await runs.startFakeRun({ seconds: 1 });
    const long = await runs.startFakeRun({ seconds: 60 });

    const drained = runs.drain(3000);
    await expect(runs.startFakeRun()).rejects.toSatisfy((err) => runManagerErrorCode(err) === "not_accepting");
    expect(await drained).toEqual({ finished: 1, stopped: 1 });

    const shortEvents = await readAllEvents(db, short.runId);
    expect(endOf(shortEvents).status).toBe("completed");
    const longEvents = await readAllEvents(db, long.runId);
    expectGapFree(longEvents);
    expect(endOf(longEvents).status).toBe("incomplete");
    expect((await getRun(db, long.runId))?.status).toBe("incomplete");
  }, 30_000);

  it("refuses runs beyond the per-process cap", async () => {
    const { runs } = setup({ fakeRunSeconds: 60, maxActive: 1 });
    await runs.startFakeRun();
    await expect(runs.startFakeRun()).rejects.toSatisfy((err) => runManagerErrorCode(err) === "busy");
    await runs.drain(0);
  }, 30_000);

  it("refuses fake runs beyond the rolling hourly cap, even after they were cancelled", async () => {
    const existing = await countRunsSince(t!.db, { hashPrefix: FAKE_HASH_PREFIX, sinceMs: HOUR });
    const { db, bus, runs } = setup({ fakeRunSeconds: 60, hourlyCap: existing + 2 });
    for (let i = 0; i < 2; i++) {
      const { runId } = await runs.startFakeRun();
      await requestCancel(db, runId);
      await runs.whenDone(runId);
    }
    expect(runs.activeCount()).toBe(0);
    await expect(runs.startFakeRun()).rejects.toSatisfy((err) => runManagerErrorCode(err) === "busy");
    expect(runs.activeCount()).toBe(0);

    const http = await import("../server/http");
    const refused = await withContainer({ db, bus, runs }, () => http.startRun());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ retry: true });
  }, 30_000);

  it("admits concurrent starts one at a time, so they cannot overshoot the hourly cap", async () => {
    const existing = await countRunsSince(t!.db, { hashPrefix: FAKE_HASH_PREFIX, sinceMs: HOUR });
    const { runs } = setup({ fakeRunSeconds: 60, hourlyCap: existing + 3 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => runs.startFakeRun()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results) if (r.status === "rejected") expect(runManagerErrorCode(r.reason)).toBe("busy");
    await runs.drain(0);
  }, 30_000);

  it("purges finished fake runs past the retention, with their events, and keeps the rest", async () => {
    const { db, runs } = setup({ retentionMs: HOUR });
    // Two hours old: past this manager's retention, inside the default one the other managers use.
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    const seed = async (hash: (id: string) => string, status: "completed" | "running", createdAt?: Date) => {
      const id = randomUUID();
      await createRun(db, { id, question: "Retention test", questionHash: hash(id), status, createdAt });
      const event = stampEvent({ type: "note", text: "stored" }, { seq: 1, ts: new Date().toISOString(), runId: id });
      await appendEvents(db, id, [toEventRow(event)]);
      return id;
    };
    const oldFake = await seed((id) => `fake:${id}`, "completed", twoHoursAgo);
    const oldActive = await seed((id) => `fake:${id}`, "running", twoHoursAgo);
    const recentFake = await seed((id) => `fake:${id}`, "completed");
    const oldReal = await seed(() => "h-retention-real", "completed", twoHoursAgo);

    expect(await runs.purgeFakeRuns()).toBe(1);
    expect(await getRun(db, oldFake)).toBeUndefined();
    expect(await readAllEvents(db, oldFake)).toEqual([]);
    for (const id of [oldActive, recentFake, oldReal]) {
      expect(await getRun(db, id)).toBeDefined();
      expect(await readAllEvents(db, id)).toHaveLength(1);
    }
  }, 30_000);

  it("finishes an orphaned run (its server died) with an incomplete run.end", async () => {
    const { db, runs } = setup();
    const runId = await seedOrphan(db);

    const viewer: RunStreamDeps = {
      db,
      bus: new EventBus(),
      isLive: () => false,
      finalizeOrphan: (id) => runs.finalizeOrphan(id),
    };
    const events = await collect(viewer, runId, 0, { stream: ORPHAN_STREAM });
    expectGapFree(events);
    expect(events).toHaveLength(4);
    expect(endOf(events).status).toBe("incomplete");
    expect((await getRun(db, runId))?.status).toBe("incomplete");
    // A second finalizer finds nothing to do.
    expect(await runs.finalizeOrphan(runId)).toBe(false);
  }, 30_000);

  it("lets concurrent finalizers in different processes store exactly one run.end", async () => {
    const { db, runs: a } = setup();
    // A second server instance: its own pool, so its statements really interleave with the first's.
    const otherDb = createDb(t!.url, { max: 4, applicationName: "ct-web-test-other" });
    const b = new RunManager({ db: otherDb, bus: new EventBus() });
    const ids = await Promise.all(Array.from({ length: 30 }, () => seedOrphan(db)));
    let results: boolean[] = [];
    try {
      // After a crash every viewer reconnects at once, so their orphan checks line up: two
      // finalizers per orphan, all in flight together, the second a few ms behind the first.
      results = await Promise.all(
        ids.flatMap((id) => [a.finalizeOrphan(id), sleep(Math.random() * 5).then(() => b.finalizeOrphan(id))]),
      );
    } finally {
      await otherDb.$client.end({ timeout: 5 });
    }
    expect(results.filter(Boolean)).toHaveLength(ids.length);
    for (const id of ids) {
      const events = await readAllEvents(db, id);
      expectGapFree(events);
      expect(events.filter((e) => e.type === "run.end")).toHaveLength(1);
      expect(endOf(events).seq).toBe(4);
      expect((await getRun(db, id))?.status).toBe("incomplete");
    }
  }, 60_000);

  it("repairs the status from an already stored run.end instead of ending the run twice", async () => {
    const { db, runs } = setup();
    const runId = await seedOrphan(db);
    const ts = new Date(Date.now() - 9 * 60_000).toISOString();
    const stored = stampEvent({ type: "run.end", status: "completed", elapsedMs: 4000, reason: null }, { seq: 4, ts, runId });
    await appendEvents(db, runId, [toEventRow(stored)]);

    // A client that already has run.end resumes after it; its tail finds the run still running.
    const viewer: RunStreamDeps = {
      db,
      bus: new EventBus(),
      isLive: () => false,
      finalizeOrphan: (id) => runs.finalizeOrphan(id),
    };
    expect(await collect(viewer, runId, 4, { stream: ORPHAN_STREAM })).toEqual([]);

    const events = await readAllEvents(db, runId);
    expect(events).toHaveLength(4);
    expect(endOf(events).status).toBe("completed");
    expect(await getRun(db, runId)).toMatchObject({ status: "completed", wallMs: 4000, error: null });
    expect(reduceRunEvents(runId, events)).toMatchObject({ lastSeq: 4, status: "completed" });
    expect(await runs.finalizeOrphan(runId)).toBe(false);
  }, 30_000);

  it("stops a stalled driver that lost its next seq to a finalizer, without publishing past the stored run.end", async () => {
    const { db, bus, runs: driver } = setup({ fakeRunSeconds: 60 });
    // Another server instance decides the run is orphaned while its driver is stalled.
    const { runs: elsewhere } = setup();
    const { runId } = await driver.startFakeRun();
    const published: RunEvent[] = [];
    bus.subscribe(runId, { onEvent: (event) => published.push(event) });
    while (published.length < 3) await sleep(50);

    expect(await elsewhere.finalizeOrphan(runId)).toBe(true);
    await driver.whenDone(runId);

    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    expect(events.filter((e) => e.type === "run.end")).toHaveLength(1);
    expect(endOf(events)).toMatchObject({ status: "incomplete" });
    expect((await getRun(db, runId))?.status).toBe("incomplete");
    // Live subscribers saw only stored events, and nothing at or past the finalizer's run.end.
    expect(published).toEqual(events.slice(0, published.length));
    expect(published.every((e) => e.seq < endOf(events).seq)).toBe(true);
  }, 30_000);

  describe("route handlers", () => {
    it("start, stream with Last-Event-ID, snapshot, cancel, 204 after the end and 404", async () => {
      const { db, bus, runs } = setup({ fakeRunSeconds: 2 });
      // Point the process container at the test database and this manager.
      const g = globalThis as { __ctContainer?: unknown; __ctMigrationsApplied?: boolean };
      g.__ctContainer = { db, bus, runs };
      g.__ctMigrationsApplied = true;
      const http = await import("../server/http");

      const started = await http.startRun();
      expect(started.status).toBe(201);
      const { runId } = (await started.json()) as { runId: string };

      const base = `http://test.local/api/runs/${runId}`;
      const res = await http.streamRun(new Request(`${base}/stream`, { headers: { "Last-Event-ID": "10" } }), runId);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      const frames = parseSseFrames(await readBody(res));
      expect(frames[0]?.retry).toBe(2000);
      const events = frames.filter((f) => f.data !== null).map((f) => parseRunEvent(f.data ?? ""));
      expect(events[0]?.seq).toBe(11);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 11));
      expect(frames.filter((f) => f.id !== null).map((f) => Number(f.id))).toEqual(events.map((e) => e.seq));
      const last = endOf(events);

      const fromQuery = await http.streamRun(new Request(`${base}/stream?after=${last.seq - 2}`), runId);
      const tail = parseSseFrames(await readBody(fromQuery)).filter((f) => f.data !== null);
      expect(tail.map((f) => Number(f.id))).toEqual([last.seq - 1, last.seq]);

      const done = await http.streamRun(new Request(`${base}/stream`, { headers: { "Last-Event-ID": String(last.seq) } }), runId);
      expect(done.status).toBe(204);

      const snapshot = await http.runSnapshot(runId);
      expect(snapshot.headers.get("cache-control")).toBe("no-store");
      const body = (await snapshot.json()) as { run: { status: string }; state: { lastSeq: number; status: string } };
      expect(body.run.status).toBe("completed");
      expect(body.state).toMatchObject({ lastSeq: last.seq, status: "completed" });

      expect((await http.cancelRun(runId)).status).toBe(202);
      expect((await http.runSnapshot("no-such-run-0000")).status).toBe(404);
      expect((await http.streamRun(new Request(`${base}/stream`), "../etc")).status).toBe(404);

      const health = await http.health();
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: "live", db: { ok: true }, migrations: true });
      delete g.__ctMigrationsApplied;
      const unmigrated = await http.health();
      expect(unmigrated.status).toBe(503);
      expect(await unmigrated.json()).toMatchObject({ ok: false, db: { ok: true }, migrations: false });

      runs.beginShutdown();
      const refused = await http.startRun();
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ retry: true });
      delete g.__ctContainer;
    }, 30_000);
  });
});
