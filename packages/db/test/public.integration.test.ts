// The public-data repos against a real Postgres in a throwaway database. Skips when no database is
// reachable. Bodies, references and ids are invented (D29).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import {
  getPublicCacheEntry,
  insertPublicCalls,
  lastPublicSuccess,
  pinPublicCacheEntry,
  type PublicCacheEntryInput,
  type PublicCallInput,
  putPublicCacheEntry,
  recordPublicCacheHit,
} from "../src/repos/public";
import { countQlooNetworkCalls } from "../src/repos/qloo";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const DAY = 86_400_000;
const T0 = new Date("2026-10-22T12:00:00.000Z");

describe.skipIf(!probe.ok)("public-data repos against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const entry = (key: string, over: Partial<PublicCacheEntryInput> = {}): PublicCacheEntryInput => ({
    key,
    source: "sec",
    path: "/api/xbrl/companyfacts/CIK0000000001.json",
    params: {},
    status: 200,
    body: Buffer.from([0x1f, 0x8b, 1, 2, 3]),
    reference: "CIK0000000001",
    fetchedAt: T0,
    expiresAt: new Date(T0.getTime() + 7 * DAY),
    pinned: false,
    originRunId: "run-alpha",
    ...over,
  });

  const call = (id: string, over: Partial<PublicCallInput> = {}): PublicCallInput => ({
    id,
    ts: T0,
    env: "dev",
    tag: "test-agent",
    runId: "run-alpha",
    source: "sec",
    path: "/api/xbrl/companyfacts/CIK0000000001.json",
    params: {},
    cacheKey: "key-alpha",
    cacheStatus: "miss",
    httpStatus: 200,
    ms: 40,
    reference: "CIK0000000001",
    error: null,
    ...over,
  });

  it("round-trips, refreshes and pins cache entries like the Qloo cache", async () => {
    await putPublicCacheEntry(db, entry("pd-roundtrip"));
    expect(await getPublicCacheEntry(db, "pd-roundtrip")).toMatchObject({ source: "sec", reference: "CIK0000000001", hits: 0, pinned: false });
    expect(await getPublicCacheEntry(db, "pd-missing")).toBeUndefined();

    await recordPublicCacheHit(db, "pd-roundtrip");
    const later = new Date(T0.getTime() + DAY);
    await putPublicCacheEntry(db, entry("pd-roundtrip", { fetchedAt: later, reference: "CIK0000000002" }));
    await putPublicCacheEntry(db, entry("pd-roundtrip", { reference: "CIK-older" }));
    expect(await getPublicCacheEntry(db, "pd-roundtrip")).toMatchObject({ reference: "CIK0000000002", hits: 1 });

    const census = { source: "census" as const, path: "/data/2023/acs/acs5", params: { for: "zip code tabulation area:00001" } };
    await putPublicCacheEntry(db, entry("pd-census", census));
    expect(await pinPublicCacheEntry(db, "pd-census")).toBe(true);
    expect(await pinPublicCacheEntry(db, "pd-nowhere")).toBe(false);
    await putPublicCacheEntry(db, entry("pd-census", { ...census, fetchedAt: later, status: 400 }));
    expect(await getPublicCacheEntry(db, "pd-census")).toMatchObject({ status: 200, pinned: true, expiresAt: null });
  });

  it("logs calls once, apart from the Qloo call log, and reports each source's last success", async () => {
    const rows = [
      call("pc-sec-ok"),
      call("pc-sec-later", { ts: new Date(T0.getTime() + DAY) }),
      call("pc-sec-failed", { ts: new Date(T0.getTime() + 2 * DAY), httpStatus: 503, error: "unavailable" }),
      call("pc-sec-hit", { ts: new Date(T0.getTime() + 3 * DAY), cacheStatus: "hit", httpStatus: null }),
      call("pc-census-mock", { env: "mock", source: "census", path: "/data/2023/acs/acs5" }),
    ];
    expect(await insertPublicCalls(db, rows)).toBe(rows.length);
    expect(await insertPublicCalls(db, [call("pc-sec-ok")])).toBe(0);
    expect((await lastPublicSuccess(db, { env: "dev", source: "sec" }))?.toISOString()).toBe(new Date(T0.getTime() + DAY).toISOString());
    expect(await lastPublicSuccess(db, { env: "dev", source: "census" })).toBeNull();
    expect(await lastPublicSuccess(db, { env: "mock", source: "census" })).toBeInstanceOf(Date);
    // Public calls never spend the Qloo per-tag cap.
    expect(await countQlooNetworkCalls(db, { env: "dev", tag: "test-agent" })).toBe(0);
  });
});
