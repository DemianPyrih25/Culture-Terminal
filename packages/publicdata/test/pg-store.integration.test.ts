// The client on the Postgres store, in a throwaway database. Skips when no database is reachable.
import { lastPublicSuccess } from "@ct/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../db/test/support/testDb";
import type { PublicStore } from "../src/api";
import { publicCacheKey } from "../src/canonical";
import { censusRequest } from "../src/census";
import { createPublicDataClient } from "../src/client";
import { createPgPublicStore } from "../src/store";
import { FakeClock, type FakeTransport, fakeTransport, FIXTURE_CIK } from "./support/fakes";

const probe = await probeTestDatabase();

describe.skipIf(!probe.ok)("createPgPublicStore", () => {
  let t: TestDatabase | undefined;
  let store: PublicStore;

  beforeAll(async () => {
    t = await createTestDatabase();
    store = createPgPublicStore(t.db);
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const newProcess = (transport: FakeTransport = fakeTransport()) => {
    const clock = new FakeClock();
    const client = createPublicDataClient({
      transport,
      env: "dev",
      tag: "test-agent",
      secUserAgent: "Culture Terminal test@culture-terminal.dev",
      rps: { sec: 100, census: 100 },
      store,
      now: clock.now,
      sleep: clock.sleep,
    });
    return { client, transport };
  };

  it("caches, pins, logs and serves another process from Postgres", async () => {
    const a = newProcess();
    const run = a.client.forRun({ runId: "run-alpha" }).forTool("tool-a");
    const facts = await run.secCompanyFacts("42");
    const acs = await run.censusAcs({ kind: "zcta", zctas: ["00501", "00502"] });
    await a.client.flush();

    const stored = await store.getEntry(publicCacheKey(censusRequest(acs.data.vintage, { kind: "zcta", zctas: ["00501", "00502"] }), "pd-v1"));
    expect(stored).toMatchObject({ source: "census", pinned: true, expiresAt: null, status: 200 });
    expect(stored?.reference).toBe(acs.meta.reference);
    expect(stored?.body.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));

    // A second process on the same database: served from L2 as reused, no request.
    const b = newProcess(fakeTransport(() => ({ status: 500 })));
    const again = await b.client.forRun({ runId: "run-bravo" }).forTool("tool-b").secCompanyFacts("0000000042");
    expect(again.data.cik).toBe(FIXTURE_CIK);
    expect(again.meta).toMatchObject({ cache: "reused", originRunId: "run-alpha", fetchedAt: facts.meta.fetchedAt });
    expect(b.transport.requests).toHaveLength(0);
    await b.client.flush();

    const db = t?.db;
    if (!db) throw new Error("no database");
    expect(await lastPublicSuccess(db, { env: "dev", source: "sec" })).not.toBeNull();
    expect(await lastPublicSuccess(db, { env: "dev", source: "census" })).not.toBeNull();
    expect(await lastPublicSuccess(db, { env: "mock", source: "sec" })).toBeNull();
  });
});
