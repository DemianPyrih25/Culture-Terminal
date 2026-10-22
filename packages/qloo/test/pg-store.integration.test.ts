// The client on the Postgres store, in a throwaway database. Skips when no database is reachable.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../db/test/support/testDb";
import { canonicalize } from "../src/canonical";
import { createQlooClient } from "../src/client";
import { BudgetError } from "../src/errors";
import { createPgQlooStore } from "../src/pg-store";
import { QUOTA_KV_KEY, utcDay } from "../src/quota";
import type { QlooStore } from "../src/store";
import { FakeClock, type FakeTransport, fakeTransport, runScope, SEARCH_PARAMS, START } from "./support/fakes";

const probe = await probeTestDatabase();

describe.skipIf(!probe.ok)("createPgQlooStore", () => {
  let t: TestDatabase | undefined;
  let store: QlooStore;

  beforeAll(async () => {
    t = await createTestDatabase();
    store = createPgQlooStore(t.db);
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const newProcess = (transport: FakeTransport = fakeTransport()) => {
    const clock = new FakeClock();
    const client = createQlooClient({
      transport,
      env: "dev",
      baseUrl: "https://hackathon.api.qloo.com",
      tag: "test-agent",
      tagCap: 2,
      rps: 100,
      store,
      now: clock.now,
      sleep: clock.sleep,
    });
    return { client, transport };
  };

  it("caches, logs, counts and persists through Postgres", async () => {
    const a = newProcess(fakeTransport(() => ({ headers: { monthRemaining: 44_000 } })));
    const run = a.client.forRun(runScope({ runId: "run-alpha" })).forTool("tool-a");
    const first = await run.search(SEARCH_PARAMS);
    await run.search({ query: "Brand Beta" });
    await a.client.flush();

    const key = canonicalize("/search", SEARCH_PARAMS).key;
    const stored = await store.getEntry(key);
    expect(stored).toMatchObject({ key, path: "/search", status: 200, originRunId: "run-alpha", pinned: false });
    expect(stored?.body.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(await store.countNetworkCalls({ env: "dev", tag: "test-agent" })).toBe(2);
    expect(await store.freshCalls({ day: utcDay(START), lane: "public" })).toBe(2);
    expect(await store.getKv(QUOTA_KV_KEY)).toMatchObject({ monthRemaining: 44_000, todayNetwork: 2 });

    // A second process on the same database: served from L2, and the tag cap carries over.
    const b = newProcess();
    const reused = await b.client.forRun(runScope({ runId: "run-bravo" })).forTool(null).search(SEARCH_PARAMS);
    expect(reused.meta).toMatchObject({ cache: "reused", originRunId: "run-alpha", requestId: first.meta.requestId });
    await expect(b.client.standalone().forTool(null).search({ query: "Brand Gamma" })).rejects.toBeInstanceOf(BudgetError);
    expect(b.transport.requests).toHaveLength(0);

    await b.client.pin("/search", SEARCH_PARAMS);
    await b.client.flush();
    expect(await store.getEntry(key)).toMatchObject({ pinned: true, expiresAt: null });
  });
});
