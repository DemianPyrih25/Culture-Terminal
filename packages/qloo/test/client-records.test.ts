import { QlooCallMeta, RunEventInput } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { QlooParamError } from "../src/errors";
import { type QlooCallRecord, qlooEventFrom } from "../src/records";
import { BRAND_PARAMS, deferred, fakeTransport, FakeClock, harness, runScope, SEARCH_PARAMS, START } from "./support/fakes";

describe("call records and the qloo event", () => {
  it("reports every call through onCall with a valid qloo event payload", async () => {
    const records: QlooCallRecord[] = [];
    const h = harness();
    const run = h.client.forRun(runScope({ onCall: (r) => records.push(r) }));
    const qloo = run.forTool("toolu-fixture");
    const res = await qloo.insights("urn:entity:brand", BRAND_PARAMS);
    await qloo.insights("urn:entity:brand", BRAND_PARAMS);
    expect(records.map((r) => r.cache)).toEqual(["miss", "hit"]);
    const [miss, hit] = records;
    expect(miss).toMatchObject({
      qlooCallId: res.meta.qlooCallId,
      toolCallId: "toolu-fixture",
      runId: "run-alpha",
      path: "/v2/insights",
      filterType: "urn:entity:brand",
      status: 200,
      rows: 2,
      cacheAgeMs: null,
      originRunId: null,
      error: null,
      fetchedAt: new Date(START).toISOString(),
    });
    expect(miss?.query).toEqual({ "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-alpha-01", take: "10" });
    expect(hit?.cacheAgeMs).toBe(0);
    for (const record of records) expect(RunEventInput.parse(qlooEventFrom(record))).toEqual(qlooEventFrom(record));
    expect(QlooCallMeta.parse(res.meta)).toEqual(res.meta);
    expect(qlooEventFrom(miss as QlooCallRecord)).toMatchObject({ type: "qloo", endpoint: "/v2/insights", cache: "miss" });
  });

  it("records failures with their status and error, and no data fields", async () => {
    const records: QlooCallRecord[] = [];
    const h = harness({ transport: fakeTransport(() => ({ status: 503 })) });
    await h.client
      .standalone({ onCall: (r) => records.push(r) })
      .forTool(null)
      .search(SEARCH_PARAMS)
      .catch(() => undefined);
    expect(records).toHaveLength(1);
    // The last attempt's receipt, so a failure can be traced with Qloo.
    expect(records[0]).toMatchObject({ cache: "miss", status: 503, requestId: "req-c", rows: null, fetchedAt: null });
    expect(records[0]?.error).toMatch(/HTTP 503/);
    expect(RunEventInput.safeParse(qlooEventFrom(records[0] as QlooCallRecord)).success).toBe(true);
  });

  it("uses one receipt id for the record, the event, the call log and the meta when Qloo sends none", async () => {
    const records: QlooCallRecord[] = [];
    const h = harness({ transport: fakeTransport(() => ({ headers: { requestId: null } })) });
    const res = await h.client
      .standalone({ onCall: (r) => records.push(r) })
      .forTool(null)
      .search(SEARCH_PARAMS);
    await h.client.flush();
    expect(res.meta.requestId).toMatch(/^local-[0-9a-f]{16}$/);
    expect(records[0]?.requestId).toBe(res.meta.requestId);
    expect(qlooEventFrom(records[0] as QlooCallRecord).requestId).toBe(res.meta.requestId);
    expect(h.store.calls[0]?.requestId).toBe(res.meta.requestId);
  });

  it("leaves the receipt null only when no response arrived", async () => {
    const records: QlooCallRecord[] = [];
    const h = harness({ transport: fakeTransport(() => ({ error: new Error("socket hang up") })) });
    await h.client
      .standalone({ onCall: (r) => records.push(r) })
      .forTool(null)
      .search(SEARCH_PARAMS)
      .catch(() => undefined);
    expect(records[0]).toMatchObject({ status: null, requestId: null });

    const silent: QlooCallRecord[] = [];
    const s = harness({ transport: fakeTransport(() => ({ status: 401, headers: { requestId: null } })) });
    await s.client
      .standalone({ onCall: (r) => silent.push(r) })
      .forTool(null)
      .search(SEARCH_PARAMS)
      .catch(() => undefined);
    expect(silent[0]?.status).toBe(401);
    expect(silent[0]?.requestId).toMatch(/^local-[0-9a-f]{16}$/);
  });

  it("makes no record for validation errors", async () => {
    const records: QlooCallRecord[] = [];
    const h = harness();
    const qloo = h.client.standalone({ onCall: (r) => records.push(r) }).forTool(null);
    await expect(qloo.search({ query: "Brand Alpha", "bias.trends": "off" })).rejects.toBeInstanceOf(QlooParamError);
    await expect(qloo.insights("urn:entity:brand", { ...BRAND_PARAMS, "filter.type": "urn:entity:brand" })).rejects.toThrow(
      /must not be repeated/,
    );
    expect(records).toEqual([]);
    expect(h.transport.requests).toHaveLength(0);
  });

  it("keeps provenance and records per run", async () => {
    const h = harness();
    const run = h.client.forRun(runScope());
    const res = await run.forTool(null).entities(["ent-beta-02", "ent-alpha-01"]);
    expect(run.provenance(res.meta.qlooCallId)).toEqual({
      method: "GET",
      path: "/entities",
      query: { entity_ids: "ent-alpha-01,ent-beta-02" },
    });
    expect(run.call(res.meta.qlooCallId)?.cache).toBe("miss");
    expect(run.provenance("qc_unknown")).toBeNull();
    expect(h.client.forRun(runScope({ runId: "run-other" })).call(res.meta.qlooCallId)).toBeNull();
  });

  it("covers every endpoint method", async () => {
    const h = harness();
    const qloo = h.client.standalone().forTool(null);
    const window = { "filter.start_date": "2025-04-01", "filter.end_date": "2025-09-30" };
    const results = await Promise.all([
      qloo.search(SEARCH_PARAMS),
      qloo.entities(["ent-alpha-01"]),
      qloo.tags({ "filter.query": "fixture", "feature.semantic_search": true }),
      qloo.audiences({ "filter.parents.types": "urn:audience:leisure" }),
      qloo.trending({ "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-alpha-01", take: 50, ...window }),
      qloo.insights("urn:tag", { "signal.location": "POINT(-86.7484 36.1766)", take: 50 }),
      qloo.insights("urn:demographics", { "signal.interests.entities": ["ent-alpha-01"], take: 50 }),
    ]);
    expect(results.every((r) => r.meta.cache === "miss")).toBe(true);
    expect(h.transport.requests.map((r) => r.path)).toEqual([
      "/search",
      "/entities",
      "/v2/tags",
      "/v2/audiences",
      "/v2/trending",
      "/v2/insights",
      "/v2/insights",
    ]);
  });
});

describe("call log", () => {
  it("writes one qloo_calls row per call with env, tag, statuses and receipts", async () => {
    const gate = deferred();
    const clock = new FakeClock();
    let n = 0;
    const transport = fakeTransport(() => (n++ === 0 ? { gate: gate.promise } : {}), clock);
    const h = harness({ clock, transport });
    const qloo = h.client.forRun(runScope()).forTool(null);
    const calls = [qloo.search(SEARCH_PARAMS), qloo.search(SEARCH_PARAMS)];
    await new Promise((r) => setTimeout(r, 5));
    gate.resolve();
    await Promise.all(calls);
    await qloo.search(SEARCH_PARAMS);
    await h.client.flush();
    expect(h.store.calls.map((c) => [c.cacheStatus, c.httpStatus, c.requestId, c.monthRemaining])).toEqual([
      ["miss", 200, "req-a", 45_000],
      ["coalesced", null, "req-a", null],
      ["hit", null, "req-a", null],
    ]);
    for (const row of h.store.calls) {
      expect(row).toMatchObject({ env: "dev", tag: "test-agent", runId: "run-alpha", path: "/search", error: null });
      expect(row.params).toEqual({ query: "Brand Alpha", take: "5", types: "urn:entity:brand" });
      expect(row.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("flush() waits for every background write", async () => {
    const h = harness();
    const qloo = h.client.standalone().forTool(null);
    await Promise.all(["Alpha", "Beta", "Gamma"].map((name) => qloo.search({ query: `Brand ${name}` })));
    await h.client.flush();
    expect(h.store.calls).toHaveLength(3);
    expect(h.store.entries.size).toBe(3);
  });
});
