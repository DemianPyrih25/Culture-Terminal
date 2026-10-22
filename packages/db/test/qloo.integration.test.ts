// The Qloo repos against a real Postgres in a throwaway database. Skips when no database is reachable.
// Bodies and ids are invented (D29).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import {
  countQlooNetworkCalls,
  getQlooCacheEntry,
  getQlooUsage,
  incrementQlooUsage,
  insertQlooCalls,
  pinQlooCacheEntry,
  putQlooCacheEntry,
  type QlooCacheEntryInput,
  type QlooCallInput,
  recordQlooCacheHit,
} from "../src/repos/qloo";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const DAY = 86_400_000;
const T0 = new Date("2026-10-22T12:00:00.000Z");

describe.skipIf(!probe.ok)("qloo repos against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const entry = (key: string, over: Partial<QlooCacheEntryInput> = {}): QlooCacheEntryInput => ({
    key,
    path: "/search",
    params: { query: "Brand Alpha" },
    status: 200,
    body: Buffer.from([0x1f, 0x8b, 1, 2, 3]),
    requestId: "req-alpha",
    fetchedAt: T0,
    expiresAt: new Date(T0.getTime() + 30 * DAY),
    pinned: false,
    originRunId: "run-alpha",
    ...over,
  });

  const call = (id: string, over: Partial<QlooCallInput> = {}): QlooCallInput => ({
    id,
    env: "dev",
    tag: "test-agent",
    runId: "run-alpha",
    path: "/search",
    filterType: null,
    params: { query: "Brand Alpha" },
    cacheKey: "key-alpha",
    cacheStatus: "miss",
    httpStatus: 200,
    ms: 12,
    requestId: "req-alpha",
    monthRemaining: 45_000,
    error: null,
    ...over,
  });

  describe("qloo_cache", () => {
    it("round-trips an entry with its bytea body", async () => {
      await putQlooCacheEntry(db, entry("key-roundtrip"));
      const row = await getQlooCacheEntry(db, "key-roundtrip");
      expect(row).toMatchObject({
        key: "key-roundtrip",
        path: "/search",
        params: { query: "Brand Alpha" },
        status: 200,
        requestId: "req-alpha",
        pinned: false,
        hits: 0,
        originRunId: "run-alpha",
      });
      expect(Buffer.compare(row?.body ?? Buffer.alloc(0), Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toBe(0);
      expect(row?.fetchedAt.toISOString()).toBe(T0.toISOString());
      expect(await getQlooCacheEntry(db, "key-missing")).toBeUndefined();
    });

    it("refreshes with a newer fetch, ignores an older one and keeps the hit count", async () => {
      await putQlooCacheEntry(db, entry("key-refresh"));
      await recordQlooCacheHit(db, "key-refresh");
      await recordQlooCacheHit(db, "key-refresh");
      const later = new Date(T0.getTime() + DAY);
      await putQlooCacheEntry(db, entry("key-refresh", { fetchedAt: later, requestId: "req-bravo", status: 400 }));
      await putQlooCacheEntry(db, entry("key-refresh", { requestId: "req-older" }));
      const row = await getQlooCacheEntry(db, "key-refresh");
      expect(row).toMatchObject({ requestId: "req-bravo", status: 400, hits: 2 });
      expect(row?.fetchedAt.toISOString()).toBe(later.toISOString());
      expect(row?.lastHitAt).toBeInstanceOf(Date);
    });

    it("keeps a pinned entry pinned with no expiry", async () => {
      await putQlooCacheEntry(db, entry("key-pin"));
      expect(await pinQlooCacheEntry(db, "key-pin")).toBe(true);
      expect(await pinQlooCacheEntry(db, "key-nowhere")).toBe(false);
      await putQlooCacheEntry(db, entry("key-pin", { fetchedAt: new Date(T0.getTime() + DAY) }));
      expect(await getQlooCacheEntry(db, "key-pin")).toMatchObject({ pinned: true, expiresAt: null });

      await putQlooCacheEntry(db, entry("key-born-pinned", { pinned: true, expiresAt: new Date(T0.getTime() + DAY) }));
      expect(await getQlooCacheEntry(db, "key-born-pinned")).toMatchObject({ pinned: true, expiresAt: null });
    });
  });

  describe("qloo_cache pins", () => {
    it("never lets a non-2xx answer replace a pinned row", async () => {
      await putQlooCacheEntry(db, entry("key-pin-guard", { pinned: true }));
      await putQlooCacheEntry(db, entry("key-pin-guard", { fetchedAt: new Date(T0.getTime() + DAY), status: 400, requestId: "req-error" }));
      expect(await getQlooCacheEntry(db, "key-pin-guard")).toMatchObject({ status: 200, requestId: "req-alpha", pinned: true, expiresAt: null });

      await putQlooCacheEntry(db, entry("key-pin-guard", { fetchedAt: new Date(T0.getTime() + 2 * DAY), requestId: "req-newer" }));
      expect(await getQlooCacheEntry(db, "key-pin-guard")).toMatchObject({ status: 200, requestId: "req-newer", pinned: true, expiresAt: null });
    });
  });

  describe("qloo_calls", () => {
    it("inserts rows once and counts network calls per env and tag", async () => {
      const rows = [
        call("c-miss-1"),
        call("c-miss-2"),
        call("c-stale", { cacheStatus: "stale", httpStatus: 503 }),
        call("c-hit", { cacheStatus: "hit", httpStatus: null }),
        call("c-reused", { cacheStatus: "reused", httpStatus: null }),
        call("c-coalesced", { cacheStatus: "coalesced", httpStatus: null }),
        call("c-other-tag", { tag: "other-agent" }),
        call("c-mock", { env: "mock" }),
      ];
      expect(await insertQlooCalls(db, rows)).toBe(rows.length);
      expect(await insertQlooCalls(db, [call("c-miss-1")])).toBe(0);
      expect(await countQlooNetworkCalls(db, { env: "dev", tag: "test-agent" })).toBe(3);
      expect(await countQlooNetworkCalls(db, { env: "dev", tag: "other-agent" })).toBe(1);
      expect(await countQlooNetworkCalls(db, { env: "mock", tag: "test-agent" })).toBe(1);
      expect(await countQlooNetworkCalls(db, { env: "prod", tag: "test-agent" })).toBe(0);
    });
  });

  describe("usage_daily", () => {
    it("adds fresh calls per lane and reads zero for untouched counters", async () => {
      await incrementQlooUsage(db, { day: "2026-10-22", lanes: ["judge", "all"] });
      await incrementQlooUsage(db, { day: "2026-10-22", lanes: ["public", "all"], by: 2 });
      await incrementQlooUsage(db, { day: "2026-10-22", lanes: [] });
      expect(await getQlooUsage(db, { day: "2026-10-22", lane: "judge" })).toBe(1);
      expect(await getQlooUsage(db, { day: "2026-10-22", lane: "public" })).toBe(2);
      expect(await getQlooUsage(db, { day: "2026-10-22", lane: "all" })).toBe(3);
      expect(await getQlooUsage(db, { day: "2026-10-23", lane: "all" })).toBe(0);
      expect(await getQlooUsage(db, { day: "2026-10-22", lane: "all", metric: "llm_usd" })).toBe(0);
    });
  });
});
