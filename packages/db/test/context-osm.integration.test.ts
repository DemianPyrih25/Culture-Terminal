// Part 11 tables and columns (migration 0004) against a real Postgres in a throwaway database: the context
// cache, feature uses, runs.started_at with its backfill, follows.pending_run_id and the kv counter. Skips
// only when no database is reachable. Invented values only.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { defaultMigrationsFolder, runMigrations } from "../src/migrate";
import { getContext, pruneContext, putContext } from "../src/repos/contextCache";
import { featureUseMedians, recordFeatureUse } from "../src/repos/featureUses";
import { addFollow, listFollows, setPending } from "../src/repos/follows";
import { getKv, incrementKvCounter } from "../src/repos/kv";
import { countRunsSince, createRun, getRun, markStarted } from "../src/repos/runs";
import { appendEvents } from "../src/repos/runEvents";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

describe.skipIf(!probe.ok)("Part 11 tables against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  describe("context_cache", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const later = new Date("2026-10-31T12:00:00Z");

    it("serves a live entry, hides an expired one and replaces on put", async () => {
      const body = { status: "ok", items: [{ topic: "Ownership", text: "Independently owned.", kind: "deal" }] };
      await putContext(db, { key: "ctx-a", kind: "ai", model: "claude-haiku-5-5", body, usd: 0.004, expiresAt: later });
      const hit = await getContext(db, "ctx-a", now);
      expect(hit).toMatchObject({ key: "ctx-a", kind: "ai", model: "claude-haiku-5-5", body, usd: 0.004 });
      expect(await getContext(db, "ctx-a", new Date("2026-11-01T00:00:00Z"))).toBeUndefined();
      await putContext(db, { key: "ctx-a", kind: "ai", model: "claude-sonnet-5-5", body: { status: "empty", items: [] }, usd: 0, expiresAt: later });
      expect((await getContext(db, "ctx-a", now))?.model).toBe("claude-sonnet-5-5");
    });

    it("refuses an unknown kind, a negative cost and a null body", async () => {
      await expect(
        db.execute(sql`insert into context_cache (key, kind, model, body, expires_at) values ('ctx-x', 'ghost', 'm', '{}'::jsonb, now())`),
      ).rejects.toThrow();
      await expect(putContext(db, { key: "ctx-y", kind: "web", model: "m", body: {}, usd: -1, expiresAt: later })).rejects.toThrow(RangeError);
      await expect(putContext(db, { key: "ctx-y", kind: "web", model: "m", body: null, usd: 0, expiresAt: later })).rejects.toThrow(TypeError);
    });

    it("prunes expired entries only", async () => {
      await putContext(db, { key: "ctx-old", kind: "web", model: "m", body: { status: "ok" }, usd: 0.03, expiresAt: now });
      await putContext(db, { key: "ctx-new", kind: "web", model: "m", body: { status: "ok" }, usd: 0.03, expiresAt: later });
      expect(await pruneContext(db, now)).toBeGreaterThanOrEqual(1);
      expect(await getContext(db, "ctx-new", now)).toBeDefined();
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from context_cache where key = 'ctx-old'`);
      expect(row?.n).toBe(0);
    });
  });

  describe("feature_uses", () => {
    it("records uses and reports per-feature medians inside the window", async () => {
      for (const [net, ms] of [
        [5, 900],
        [7, 1_100],
        [0, 120],
      ] as const) {
        await recordFeatureUse(db, { feature: "screener", qlooNetwork: net, qlooCached: 9 - net, ms });
      }
      await recordFeatureUse(db, { feature: "des_profile", qlooNetwork: 8, qlooCached: 0, ms: 2_000 });
      await recordFeatureUse(db, { feature: "des_profile", qlooNetwork: 2, qlooCached: 6, ms: 400, ts: new Date("2020-01-01T00:00:00Z") });
      const medians = await featureUseMedians(db, { sinceMs: 30 * 24 * 3_600_000 });
      expect(medians.map((m) => m.feature)).toEqual(["des_profile", "screener"]);
      expect(medians[1]).toEqual({ feature: "screener", n: 3, qlooNetworkMedian: 5, qlooCachedMedian: 4, llmUsdMedian: 0, msMedian: 900 });
      expect(medians[0]).toMatchObject({ n: 1, qlooNetworkMedian: 8 });
    });

    it("refuses negative or fractional counts", async () => {
      await expect(recordFeatureUse(db, { feature: "screener", qlooNetwork: -1, qlooCached: 0, ms: 1 })).rejects.toThrow(RangeError);
      await expect(recordFeatureUse(db, { feature: "screener", qlooNetwork: 1.5, qlooCached: 0, ms: 1 })).rejects.toThrow(RangeError);
      await expect(recordFeatureUse(db, { feature: " ", qlooNetwork: 1, qlooCached: 0, ms: 1 })).rejects.toThrow(RangeError);
    });
  });

  describe("runs.started_at", () => {
    it("stamps the first start only and counts started runs on request", async () => {
      const started = await createRun(db, { question: "Is Juniper Cola a taste island?", questionHash: "p11:started", ipHash: "visitor-s" });
      await createRun(db, { question: "Is Juniper Cola a taste island?", questionHash: "p11:unstarted", ipHash: "visitor-s" });
      const first = new Date("2026-10-30T10:00:00Z");
      expect(await markStarted(db, started.id, first)).toBe(true);
      expect(await markStarted(db, started.id, new Date("2026-10-30T11:00:00Z"))).toBe(true);
      expect((await getRun(db, started.id))?.startedAt?.toISOString()).toBe(first.toISOString());
      expect(await markStarted(db, "no-such-run", first)).toBe(false);
      const base = { hashPrefix: "p11:", sinceMs: 3_600_000, ipHash: "visitor-s" };
      expect(await countRunsSince(db, base)).toBe(2);
      expect(await countRunsSince(db, { ...base, startedOnly: true })).toBe(1);
    });
  });

  describe("follows.pending_run_id", () => {
    it("marks and clears a pending re-run, and clears it when the run is deleted", async () => {
      const added = await addFollow(db, {
        visitorKey: "visitor-p",
        kind: "brand",
        subjectKey: "brand:aurora footwear",
        label: "Aurora Footwear",
        question: "How healthy is Aurora Footwear's audience taste?",
        job: "brand_health",
        metro: null,
        latestRunId: null,
      });
      if (!added.ok) throw new Error("expected the follow to be added");
      const run = await createRun(db, { question: "How healthy is Aurora Footwear's audience taste?", questionHash: "p11:pending" });
      expect(await setPending(db, added.follow.id, run.id)).toBe(true);
      expect((await listFollows(db, "visitor-p"))[0]?.pendingRunId).toBe(run.id);
      expect(await setPending(db, added.follow.id, null)).toBe(true);
      expect((await listFollows(db, "visitor-p"))[0]?.pendingRunId).toBeNull();
      await setPending(db, added.follow.id, run.id);
      await db.execute(sql`delete from runs where id = ${run.id}`);
      expect((await listFollows(db, "visitor-p"))[0]?.pendingRunId).toBeNull();
      expect(await setPending(db, "no-such-follow", null)).toBe(false);
    });
  });

  describe("kv counters", () => {
    it("adds atomically from zero and reads a non-number as zero", async () => {
      expect(await incrementKvCounter(db, "screener.count.2026-10-30")).toBe(1);
      expect(await incrementKvCounter(db, "screener.count.2026-10-30", 2)).toBe(3);
      await Promise.all(Array.from({ length: 10 }, () => incrementKvCounter(db, "osm.count.2026-10-30")));
      expect(await getKv(db, "osm.count.2026-10-30")).toBe(10);
      await db.execute(sql`insert into kv (key, value) values ('odd.counter', '"text"'::jsonb)`);
      expect(await incrementKvCounter(db, "odd.counter")).toBe(1);
    });
  });
});

describe.skipIf(!probe.ok)("migration 0004 backfill", () => {
  let t: TestDatabase | undefined;
  let upTo3: string | undefined;

  afterAll(async () => {
    await t?.dispose();
    if (upTo3) await rm(upTo3, { recursive: true, force: true });
  }, 30_000);

  it("marks old runs started except the ones that never left the queue", async () => {
    // A copy of the migrations folder that stops at 0003, so the runs are written before 0004 adds started_at.
    upTo3 = await mkdtemp(path.join(os.tmpdir(), "ct-mig-"));
    const src = defaultMigrationsFolder();
    await mkdir(path.join(upTo3, "meta"));
    for (const f of await readdir(src)) if (/^000[0-3]_.*\.sql$/.test(f)) await copyFile(path.join(src, f), path.join(upTo3, f));
    const journal = JSON.parse(await readFile(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= 3);
    await writeFile(path.join(upTo3, "meta", "_journal.json"), JSON.stringify(journal));

    t = await createTestDatabase({ migrate: false });
    const db = t.db;
    await runMigrations(db, upTo3);
    const insert = async (id: string, status: string) =>
      db.execute(sql`insert into runs (id, question, question_hash, status) values (${id}, 'q', ${`bf:${id}`}, ${status})`);
    await insert("done", "completed");
    await insert("waiting", "queued");
    await insert("timedout", "failed");
    await insert("shutdown", "failed");
    await insert("crashed", "failed");
    const ev = (seq: number, type: string, payload: unknown) => ({ seq, type, payload });
    await appendEvents(db, "done", [ev(1, "run.created", {}), ev(2, "clerk", {}), ev(3, "run.end", {})]);
    await appendEvents(db, "timedout", [
      ev(1, "run.created", {}),
      ev(2, "run.queued", { position: 1 }),
      ev(3, "error", { code: "queue_timeout", message: "busy" }),
      ev(4, "run.end", {}),
    ]);
    await appendEvents(db, "shutdown", [ev(1, "run.created", {}), ev(2, "run.queued", { position: 2 }), ev(3, "run.end", {})]);
    // Started (the agent's own run.created), then failed before any other event: it counts as started.
    await appendEvents(db, "crashed", [
      ev(1, "run.created", {}),
      ev(2, "run.queued", { position: 1 }),
      ev(3, "run.created", {}),
      ev(4, "error", { code: "llm_error", message: "x" }),
      ev(5, "run.end", {}),
    ]);

    await runMigrations(db);
    const rows = await db.execute<{ id: string; started: boolean }>(
      sql`select id, started_at is not null as started from runs order by id`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.started]))).toEqual({
      crashed: true,
      done: true,
      shutdown: false,
      timedout: false,
      waiting: false,
    });
  }, 60_000);
});
