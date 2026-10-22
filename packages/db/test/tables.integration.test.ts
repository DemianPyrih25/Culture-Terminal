// Migration shape and the tables that have no repo yet, against a real Postgres in a throwaway
// database. Same skip rule as repos.integration.test.ts. All values are invented (D29).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, pingDb } from "../src/client";
import {
  createMigrationDb,
  defaultMigrationsFolder,
  MIGRATION_LOCK_KEY,
  migrateUrl,
  runMigrations,
} from "../src/migrate";
import { createRun } from "../src/repos/runs";
import * as schema from "../src/schema";
import {
  datasets,
  evidence,
  findings,
  ipUsage,
  metrics,
  qlooCache,
  qlooCalls,
  runs,
  showcasePins,
  usageDaily,
} from "../src/schema";
import { createTestDatabase, pgCode, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

// UTC day key, as the counters use.
const DAY = new Date().toISOString().slice(0, 10);

const journalEntries = (
  JSON.parse(readFileSync(path.join(defaultMigrationsFolder(), "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

describe.skipIf(!probe.ok)("tables against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  describe("migrations", () => {
    it("create exactly the columns and indexes declared in schema.ts", async () => {
      const columns = await db.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
      );
      const indexes = await db.execute<{ tablename: string; indexname: string }>(
        sql`select tablename, indexname from pg_indexes where schemaname = 'public'`,
      );
      const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
      expect(new Set(columns.map((c) => c.table_name)).size).toBe(tables.length);

      for (const table of tables) {
        const cfg = getTableConfig(table);
        const dbCols = columns.filter((c) => c.table_name === cfg.name).map((c) => c.column_name);
        expect(dbCols.sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort());
        const dbIndexes = indexes.filter((i) => i.tablename === cfg.name).map((i) => i.indexname);
        for (const index of cfg.indexes) expect(dbIndexes, cfg.name).toContain(index.config.name);
      }
    });

    it("are idempotent", async () => {
      await runMigrations(db);
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      expect(row?.n).toBe(journalEntries);
    });

    it("serialise concurrent migrators on a fresh database", async () => {
      const fresh = await createTestDatabase({ migrate: false });
      const second = createDb(fresh.url, { max: 2 });
      try {
        await Promise.all([runMigrations(fresh.db), runMigrations(second)]);
        const [row] = await fresh.db.execute<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        expect(row?.n).toBe(journalEntries);
        expect(await pingDb(fresh.db)).toBe(true);
      } finally {
        await second.$client.end({ timeout: 5 });
        await fresh.dispose();
      }
    }, 60_000);

    it("refuse a single-connection pool, which would deadlock on the lock", async () => {
      const single = createDb(t!.url, { max: 1 });
      try {
        await expect(runMigrations(single)).rejects.toThrow(/at least 2 connections/);
      } finally {
        await single.$client.end({ timeout: 5 });
      }
    });

    it("run on a pool without a statement timeout, so waiting for the lock only delays them", async () => {
      const fresh = await createTestDatabase({ migrate: false });
      const holder = postgres(fresh.url, { max: 1, onnotice: () => {} });
      const timed = createDb(fresh.url, { max: 2, statementTimeoutMs: 500 });
      const migrationDb = createMigrationDb(fresh.url);
      try {
        await holder`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

        // On a pool with a statement timeout, the wait for the lock is itself cancelled.
        const err = await runMigrations(timed).catch((e: unknown) => e);
        expect(pgCode(err)).toBe("57014");

        const [setting] = await migrationDb.execute<{ statement_timeout: string }>(sql`show statement_timeout`);
        expect(setting?.statement_timeout).toBe("0");

        const started = Date.now();
        const release = new Promise((resolve) => setTimeout(resolve, 1500)).then(
          () => holder`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`,
        );
        await Promise.all([migrateUrl(fresh.url), release]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
        const [row] = await fresh.db.execute<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        expect(row?.n).toBe(journalEntries);
      } finally {
        await holder.end({ timeout: 2 });
        await timed.$client.end({ timeout: 5 });
        await migrationDb.$client.end({ timeout: 5 });
        await fresh.dispose();
      }
    }, 60_000);
  });

  describe("qloo_cache", () => {
    it("round-trips a gzip body as bytea and supports pinned rows without expiry", async () => {
      const body = { results: { entities: [{ name: "Aurora Footwear", popularity: 0.5 }] } };
      const gz = gzipSync(JSON.stringify(body));
      const key = createHash("sha256").update("v1|GET|/search?query=Aurora%20Footwear").digest("hex");
      await db.insert(qlooCache).values({
        key,
        path: "/search",
        params: { query: "Aurora Footwear", take: "5", types: "urn:entity:brand" },
        status: 200,
        body: gz,
        requestId: "req-synthetic-1",
        pinned: true,
        originRunId: "run-synthetic",
      });

      const [row] = await db.select().from(qlooCache).where(eq(qlooCache.key, key));
      expect(Buffer.isBuffer(row?.body)).toBe(true);
      expect(row?.body.equals(gz)).toBe(true);
      expect(JSON.parse(gunzipSync(row!.body).toString("utf8"))).toEqual(body);
      expect(row).toMatchObject({ pinned: true, expiresAt: null, hits: 0, params: { take: "5" } });

      await db
        .update(qlooCache)
        .set({ hits: sql`${qlooCache.hits} + 1`, lastHitAt: sql`now()` })
        .where(eq(qlooCache.key, key));
      const [hit] = await db.select({ hits: qlooCache.hits }).from(qlooCache).where(eq(qlooCache.key, key));
      expect(hit?.hits).toBe(1);
    });
  });

  describe("qloo_calls", () => {
    it("assigns an id and stores redacted params as JSON", async () => {
      const [row] = await db
        .insert(qlooCalls)
        .values({
          env: "dev",
          tag: "db-test",
          path: "/v2/insights",
          filterType: "urn:entity:brand",
          params: { "filter.type": "urn:entity:brand", "signal.interests.entities": "R1,R2" },
          cacheStatus: "miss",
          httpStatus: 200,
          ms: 412,
          requestId: "req-synthetic-2",
          monthRemaining: 12345,
        })
        .returning();
      expect(row?.id).toMatch(/\S{8,}/);
      expect(row?.ts).toBeInstanceOf(Date);
      expect(row?.params["filter.type"]).toBe("urn:entity:brand");
    });
  });

  describe("run ledger tables", () => {
    it("store arrays and jsonb, enforce (run_id, id) keys and cascade with the run", async () => {
      const run = await createRun(db, { question: "Where does Juniper Cola win?", questionHash: "h-ledger" });
      await db.insert(evidence).values({
        runId: run.id,
        id: "E1",
        skill: "peerLandscape",
        status: "ok",
        qlooCallIds: ["call-a", "call-b"],
        requestIds: ["req-synthetic-a", "req-synthetic-b"],
        provenance: { requests: [{ method: "GET", path: "/v2/insights", query: "filter.type=urn:entity:brand" }] },
        flags: ["CANDIDATES_UNSCORED"],
      });
      await db.insert(metrics).values({
        runId: run.id,
        id: "M1",
        key: "similarity",
        label: "similarity Aurora Footwear–Juniper Cola",
        subjectRefs: ["R1", "R2"],
        value: 0.42,
        display: "0.42",
        badge: "MEASURED",
        evidenceIds: ["E1"],
        n: 6,
        conf: 0.8,
      });
      await db.insert(datasets).values({ runId: run.id, id: "D1", kind: "Matrix", payload: { rows: [] }, bytes: 12 });
      await db.insert(findings).values({
        runId: run.id,
        id: "F1",
        kind: "TASTE_ISLAND",
        severity: "high",
        text: "Aurora Footwear sits last in most rows.",
        metricIds: ["M1"],
        suggestion: { tool: "cross_domain", args: { seeds: ["R1"] } },
      });

      const [e] = await db.select().from(evidence).where(eq(evidence.runId, run.id));
      expect(e).toMatchObject({ qlooCallIds: ["call-a", "call-b"], flags: ["CANDIDATES_UNSCORED"], cached: false });
      const [m] = await db.select().from(metrics).where(eq(metrics.runId, run.id));
      expect(m).toMatchObject({ value: 0.42, subjectRefs: ["R1", "R2"], evidenceIds: ["E1"] });
      const [f] = await db.select().from(findings).where(eq(findings.runId, run.id));
      expect(f?.metricIds).toEqual(["M1"]);

      const dup = await db
        .insert(metrics)
        .values({ runId: run.id, id: "M1", key: "k", label: "l", badge: "MEASURED" })
        .catch((err: unknown) => err);
      expect(pgCode(dup)).toBe("23505");

      // Empty arrays default to '{}', never null.
      await db.insert(evidence).values({ runId: run.id, id: "E2", skill: "resolve" });
      const [e2] = await db.select().from(evidence).where(eq(evidence.id, "E2"));
      expect(e2).toMatchObject({ qlooCallIds: [], requestIds: [], flags: [] });

      await db.delete(runs).where(eq(runs.id, run.id));
      for (const table of [evidence, metrics, datasets, findings]) {
        expect(await db.select().from(table).where(eq(table.runId, run.id))).toEqual([]);
      }
    });
  });

  describe("counters and pins", () => {
    it("increments usage_daily per (day, metric, lane) with an upsert", async () => {
      const bump = (lane: string, amount: number) =>
        db
          .insert(usageDaily)
          .values({ day: DAY, metric: "qloo_fresh", lane, value: amount })
          .onConflictDoUpdate({
            target: [usageDaily.day, usageDaily.metric, usageDaily.lane],
            set: { value: sql`${usageDaily.value} + excluded.value`, updatedAt: sql`now()` },
          });
      await bump("public", 2);
      await bump("public", 3);
      await bump("judge", 1);
      const rows = await db.select().from(usageDaily).where(eq(usageDaily.metric, "qloo_fresh"));
      expect(Object.fromEntries(rows.map((r) => [r.lane, r.value]))).toEqual({ public: 5, judge: 1 });
      expect(rows[0]?.day).toBe(DAY);

      await db.insert(usageDaily).values({ day: DAY, metric: "llm_usd", value: 0.25 });
      const [global] = await db.select().from(usageDaily).where(eq(usageDaily.metric, "llm_usd"));
      expect(global?.lane).toBe("all");
    });

    it("keys ip_usage by (day, ip_hash)", async () => {
      await db.insert(ipUsage).values({ day: DAY, ipHash: "iphash-synthetic", runs: 1 });
      const dup = await db
        .insert(ipUsage)
        .values({ day: DAY, ipHash: "iphash-synthetic" })
        .catch((err: unknown) => err);
      expect(pgCode(dup)).toBe("23505");
    });

    it("keys showcase_pins by (slug, mention)", async () => {
      const pin = { slug: "aurora-health", mention: "Aurora Footwear", entityId: "synthetic-aurora", name: "Aurora Footwear", type: "urn:entity:brand" };
      await db.insert(showcasePins).values(pin);
      await db.insert(showcasePins).values({ ...pin, mention: "Juniper Cola", entityId: "synthetic-juniper" });
      const dup = await db.insert(showcasePins).values(pin).catch((err: unknown) => err);
      expect(pgCode(dup)).toBe("23505");
      const rows = await db.select().from(showcasePins).where(eq(showcasePins.slug, "aurora-health"));
      expect(rows.map((r) => r.mention).sort()).toEqual(["Aurora Footwear", "Juniper Cola"]);
    });
  });
});
