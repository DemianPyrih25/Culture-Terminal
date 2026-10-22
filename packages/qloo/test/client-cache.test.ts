import type { QlooParams } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import { BudgetError, QlooBadRequestError } from "../src/errors";
import type { QlooCallRecord } from "../src/records";
import { createMemoryQlooStore, type MemoryQlooStore } from "../src/store";
import {
  BRAND_PARAMS,
  DAY,
  deferred,
  fakeTransport,
  FakeClock,
  harness,
  MINUTE,
  runScope,
  SEARCH_PARAMS,
  START,
} from "./support/fakes";

/** Lets queued promise chains and the fake transport's gates settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** A store that counts L2 reads, to see when L1 answered. */
function countingStore() {
  const inner = createMemoryQlooStore();
  const reads: string[] = [];
  const store: MemoryQlooStore & { reads: string[] } = {
    ...inner,
    reads,
    getEntry: (key) => {
      reads.push(key);
      return inner.getEntry(key);
    },
  };
  return store;
}

describe("cache statuses", () => {
  it("labels a hit from the same run or no run 'hit' and from another run 'reused'", async () => {
    const h = harness();
    const runA = h.client.forRun(runScope({ runId: "run-alpha" })).forTool("tool-a");
    const runB = h.client.forRun(runScope({ runId: "run-bravo" })).forTool("tool-b");
    const first = await runA.insights("urn:entity:brand", BRAND_PARAMS);
    h.clock.advance(5 * MINUTE);
    const again = await runA.insights("urn:entity:brand", BRAND_PARAMS);
    const other = await runB.insights("urn:entity:brand", BRAND_PARAMS);
    const loose = await h.client.standalone().forTool(null).insights("urn:entity:brand", BRAND_PARAMS);
    expect(first.meta).toMatchObject({ cache: "miss", originRunId: null, stale: false });
    expect(again.meta).toMatchObject({ cache: "hit", originRunId: "run-alpha" });
    expect(other.meta).toMatchObject({ cache: "reused", originRunId: "run-alpha" });
    expect(loose.meta.cache).toBe("hit");
    for (const res of [again, other, loose]) {
      expect(res.meta.requestId).toBe(first.meta.requestId);
      expect(res.meta.fetchedAt).toBe(first.meta.fetchedAt);
    }
    expect(h.transport.requests).toHaveLength(1);
  });

  it("serves another process's L2 entry and stores bodies gzip-compressed", async () => {
    const store = createMemoryQlooStore();
    const a = harness({ store });
    await a.client.forRun(runScope({ runId: "run-alpha" })).forTool(null).search(SEARCH_PARAMS);
    await a.client.flush();
    const [entry] = [...store.entries.values()];
    expect(entry?.body.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));

    const b = harness({ store });
    const res = await b.client.forRun(runScope({ runId: "run-bravo" })).forTool(null).search(SEARCH_PARAMS);
    expect(res.meta).toMatchObject({ cache: "reused", originRunId: "run-alpha" });
    expect(b.transport.requests).toHaveLength(0);
    await b.client.flush();
    expect(store.entries.get(entry?.key ?? "")?.hits).toBe(1);
  });

  it("answers has() for cached and in-flight requests without spending a call", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    const h = harness({ clock, transport: fakeTransport(() => ({ gate: gate.promise }), clock) });
    const qloo = h.client.forRun(runScope()).forTool(null);
    expect(await qloo.has("/search", SEARCH_PARAMS)).toBe(false);
    const pending = qloo.search(SEARCH_PARAMS);
    expect(await qloo.has("/search", { take: 5, types: "urn:entity:brand", query: "Brand Alpha" })).toBe(true);
    gate.resolve();
    await pending;
    expect(await qloo.has("/search", SEARCH_PARAMS)).toBe(true);
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("single-flight", () => {
  it("makes one network call for concurrent identical requests and labels the rest coalesced", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    const h = harness({ clock, transport: fakeTransport(() => ({ gate: gate.promise }), clock) });
    const runA = h.client.forRun(runScope({ runId: "run-alpha" })).forTool("tool-a");
    const runB = h.client.forRun(runScope({ runId: "run-bravo" })).forTool("tool-b");
    const calls = [
      runA.insights("urn:entity:brand", BRAND_PARAMS),
      runA.insights("urn:entity:brand", { take: 10, "signal.interests.entities": "ent-alpha-01" }),
      runB.insights("urn:entity:brand", BRAND_PARAMS),
    ];
    await new Promise((r) => setTimeout(r, 5));
    gate.resolve();
    const results = await Promise.all(calls);
    expect(h.transport.requests).toHaveLength(1);
    expect(results.map((r) => r.meta.cache)).toEqual(["miss", "coalesced", "coalesced"]);
    expect(results[2]?.meta.originRunId).toBe("run-alpha");
    expect(new Set(results.map((r) => r.meta.qlooCallId)).size).toBe(3);
  });

  it("shares a failure with every waiter", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 503 })) });
    const qloo = h.client.standalone().forTool(null);
    const results = await Promise.allSettled([qloo.search(SEARCH_PARAMS), qloo.search(SEARCH_PARAMS)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(h.transport.requests).toHaveLength(3);
    await h.client.flush();
    expect(h.store.calls.map((c) => c.cacheStatus)).toEqual(["miss", "coalesced"]);
  });

  it("lets a waiter retry on its own when the leader's run is out of budget", async () => {
    const h = harness();
    const limits = { ...runScope().limits, qlooCalls: 1, qlooWarnAt: 1 };
    const runA = h.client.forRun(runScope({ runId: "run-alpha", limits })).forTool(null);
    const runB = h.client.forRun(runScope({ runId: "run-bravo" })).forTool(null);
    await runA.search({ query: "Brand Other" });
    const [a, b] = await Promise.allSettled([runA.search(SEARCH_PARAMS), runB.search(SEARCH_PARAMS)]);
    expect(a.status === "rejected" && a.reason instanceof BudgetError).toBe(true);
    expect(b.status === "fulfilled" && b.value.meta.cache).toBe("miss");
    expect(h.transport.requests).toHaveLength(2);
  });

  it("lets a waiter retry when the leader's run is cancelled", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    let attempt = 0;
    const transport = fakeTransport(() => (attempt++ === 0 ? { gate: gate.promise } : {}), clock);
    const h = harness({ clock, transport });
    const controller = new AbortController();
    const runA = h.client.forRun(runScope({ runId: "run-alpha", signal: controller.signal })).forTool(null);
    const runB = h.client.forRun(runScope({ runId: "run-bravo" })).forTool(null);
    const a = runA.search(SEARCH_PARAMS).catch((e: unknown) => e);
    const b = runB.search(SEARCH_PARAMS);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    gate.resolve();
    expect(((await a) as Error).name).toBe("AbortError");
    expect((await b).meta.cache).toBe("miss");
    expect(transport.requests).toHaveLength(2);
  });
});

describe("waiting and concurrency", () => {
  it("lets a waiter leave when its own run is cancelled, while the leader carries on", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    const h = harness({ clock, transport: fakeTransport(() => ({ gate: gate.promise }), clock) });
    const controller = new AbortController();
    const records: QlooCallRecord[] = [];
    const runA = h.client.forRun(runScope({ runId: "run-alpha" })).forTool(null);
    const runB = h.client
      .forRun(runScope({ runId: "run-bravo", signal: controller.signal, onCall: (r) => records.push(r) }))
      .forTool(null);
    const a = runA.search(SEARCH_PARAMS);
    const b = runB.search(SEARCH_PARAMS).catch((e: unknown) => e);
    await settle();
    controller.abort();
    // The waiter rejects while the leader is still in flight.
    expect(((await b) as Error).name).toBe("AbortError");
    gate.resolve();
    expect((await a).meta.cache).toBe("miss");
    await h.client.flush();
    expect(records).toEqual([]);
    expect(h.store.calls.map((c) => c.runId)).toEqual(["run-alpha"]);
    expect(h.transport.requests).toHaveLength(1);
  });

  it("holds one run to four requests in flight without holding back other runs", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    const h = harness({ clock, transport: fakeTransport(() => ({ gate: gate.promise }), clock) });
    const runA = h.client.forRun(runScope({ runId: "run-alpha" })).forTool(null);
    const runB = h.client.forRun(runScope({ runId: "run-bravo" })).forTool(null);
    const calls = ["A", "B", "C", "D", "E", "F"].map((x) => runA.search({ query: `Brand Fixture ${x}` }));
    await settle();
    expect(h.transport.requests).toHaveLength(4);
    calls.push(runB.search({ query: "Brand Other" }));
    await settle();
    expect(h.transport.requests).toHaveLength(5);
    gate.resolve();
    await Promise.all(calls);
    expect(h.transport.requests).toHaveLength(7);
  });
});

describe("no identical request goes to the network twice", () => {
  const variants: QlooParams[] = [
    { "signal.interests.entities": ["ent-beta-02", "ent-alpha-01"], take: 10 },
    { take: "10", "signal.interests.entities": "ent-alpha-01,ent-beta-02" },
    { "signal.interests.entities": ["ent-alpha-01", "ent-beta-02", "ent-alpha-01"], take: 10.0 },
  ];

  it("sequentially", async () => {
    const h = harness();
    const qloo = h.client.forRun(runScope()).forTool(null);
    for (let i = 0; i < 9; i++) await qloo.insights("urn:entity:brand", variants[i % variants.length] ?? {});
    expect(h.transport.requests).toHaveLength(1);
  });

  it("concurrently, across runs", async () => {
    const h = harness();
    const runs = ["run-a", "run-b", "run-c"].map((runId) => h.client.forRun(runScope({ runId })).forTool(null));
    await Promise.all(runs.flatMap((qloo) => variants.map((v) => qloo.insights("urn:entity:brand", v))));
    expect(h.transport.requests).toHaveLength(1);
  });

  it("right after a flight lands, before its L2 write", async () => {
    const h = harness();
    const qloo = h.client.standalone().forTool(null);
    const first = qloo.search(SEARCH_PARAMS);
    await first;
    await Promise.all([qloo.search(SEARCH_PARAMS), qloo.search(SEARCH_PARAMS)]);
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("L1", () => {
  it("evicts the least recently used entry beyond its capacity", async () => {
    const store = countingStore();
    const h = harness({ store, cache: { maxEntries: 2 } });
    const qloo = h.client.standalone().forTool(null);
    for (const name of ["Alpha", "Beta", "Gamma"]) await qloo.search({ query: `Brand ${name}` });
    await h.client.flush();
    store.reads.length = 0;
    await qloo.search({ query: "Brand Gamma" });
    expect(store.reads).toHaveLength(0);
    await qloo.search({ query: "Brand Alpha" });
    expect(store.reads).toEqual([canonicalize("/search", { query: "Brand Alpha" }).key]);
    expect(h.transport.requests).toHaveLength(3);
  });

  it("evicts by body size", async () => {
    const store = countingStore();
    const h = harness({ store, cache: { maxBytes: 150 } });
    const qloo = h.client.standalone().forTool(null);
    await qloo.search({ query: "Brand Alpha" });
    await qloo.search({ query: "Brand Beta" });
    await h.client.flush();
    store.reads.length = 0;
    await qloo.search({ query: "Brand Alpha" });
    expect(store.reads).toHaveLength(1);
  });

  it("re-reads L2 after 15 minutes", async () => {
    const store = countingStore();
    const h = harness({ store });
    const qloo = h.client.standalone().forTool(null);
    await qloo.search(SEARCH_PARAMS);
    await h.client.flush();
    store.reads.length = 0;
    h.clock.advance(14 * MINUTE);
    await qloo.search(SEARCH_PARAMS);
    expect(store.reads).toHaveLength(0);
    h.clock.advance(2 * MINUTE);
    await qloo.search(SEARCH_PARAMS);
    expect(store.reads).toHaveLength(1);
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("TTL and pins in the client", () => {
  it("refetches after the TTL and stores pinned classes without expiry", async () => {
    const h = harness();
    const qloo = h.client.standalone().forTool(null);
    await qloo.search(SEARCH_PARAMS);
    h.clock.advance(29 * DAY);
    await qloo.search(SEARCH_PARAMS);
    expect(h.transport.requests).toHaveLength(1);
    h.clock.advance(2 * DAY);
    await qloo.search(SEARCH_PARAMS);
    expect(h.transport.requests).toHaveLength(2);

    const baseline = { "filter.location": "loc-fixture", "signal.interests.tags": "urn:tag:genre:place:restaurant" };
    await qloo.insights("urn:heatmap", baseline);
    await h.client.flush();
    const key = canonicalize("/v2/insights", { ...baseline, "filter.type": "urn:heatmap" }).key;
    expect(h.store.entries.get(key)).toMatchObject({ pinned: true, expiresAt: null });
    h.clock.advance(400 * DAY);
    expect((await qloo.insights("urn:heatmap", baseline)).meta.cache).toBe("hit");
  });

  it("pins on request, fetching the answer first when it is not cached", async () => {
    const h = harness();
    await h.client.pin("/search", SEARCH_PARAMS);
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    const key = canonicalize("/search", SEARCH_PARAMS).key;
    expect(h.store.entries.get(key)).toMatchObject({ pinned: true, expiresAt: null });
    h.clock.advance(365 * DAY);
    const res = await h.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(res.meta.cache).toBe("hit");
    await h.client.pin("/search", SEARCH_PARAMS);
    expect(h.transport.requests).toHaveLength(1);
  });

  it("keeps a pinned answer when a refetch after a failed L2 read gets a 4xx", async () => {
    const inner = createMemoryQlooStore();
    let l2Down = false;
    const store: MemoryQlooStore = {
      ...inner,
      getEntry: (key) => (l2Down ? Promise.reject(new Error("database unreachable")) : inner.getEntry(key)),
    };
    const a = harness({ store });
    await a.client.pin("/search", SEARCH_PARAMS);
    await a.client.flush();

    l2Down = true;
    const b = harness({
      store,
      clock: new FakeClock(START + DAY),
      transport: fakeTransport(() => ({ status: 400, body: { message: "bad parameter" } })),
    });
    const qloo = b.client.standalone().forTool(null);
    await expect(qloo.search(SEARCH_PARAMS)).rejects.toBeInstanceOf(QlooBadRequestError);
    await b.client.flush();
    l2Down = false;
    const key = canonicalize("/search", SEARCH_PARAMS).key;
    expect(store.entries.get(key)).toMatchObject({ status: 200, pinned: true, expiresAt: null });

    // Once its L1 copy is due for a re-read, the same process serves the pin again.
    b.clock.advance(16 * MINUTE);
    expect((await qloo.search(SEARCH_PARAMS)).meta.cache).toBe("hit");
    expect(b.transport.requests).toHaveLength(1);
  });

  it("uses pinned localities for urn:tag fingerprints", async () => {
    const h = harness({ pinnedLocalities: new Set(["loc-fixture-metro"]) });
    await h.client.standalone().forTool(null).insights("urn:tag", { "signal.location": "loc-fixture-metro" });
    await h.client.flush();
    expect([...h.store.entries.values()][0]).toMatchObject({ pinned: true });
  });
});

describe("mock namespace", () => {
  it("never serves mock data to a live client from the shared store, or the reverse", async () => {
    const store = createMemoryQlooStore();
    const mock = harness({ store, env: "mock" });
    await mock.client.standalone().forTool(null).search(SEARCH_PARAMS);
    await mock.client.flush();
    const live = harness({ store, env: "dev" });
    const res = await live.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(res.meta.cache).toBe("miss");
    expect(live.transport.requests).toHaveLength(1);
    await live.client.flush();
    expect(store.entries.size).toBe(2);
    expect(mock.transport.requests[0]?.key).not.toBe(live.transport.requests[0]?.key);
    expect(new Set(store.calls.map((c) => c.env))).toEqual(new Set(["mock", "dev"]));
  });
});
