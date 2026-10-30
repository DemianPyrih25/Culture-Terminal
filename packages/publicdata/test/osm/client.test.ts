import { publicDataErrorCode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { publicEventFrom, type PublicCallRecord, type PublicRequest, type PublicTransport } from "../../src/api";
import { OSM_TTL_MS } from "../../src/osm/client";
import { createMemoryPublicStore, type MemoryPublicStore } from "../../src/store";
import { DAY, fakeTransport, type FakeReply, FakeClock, harness, START } from "../support/fakes";
import { answerCounts, BAR, CAFE, CIRCLE, countsBody, OSM_BASE, placesBody, SQUARE } from "./support";

const UA = "Culture Terminal test (ops@example.org)";
const COUNTS = { shapes: [SQUARE, CIRCLE], types: [CAFE, BAR] };
const TODAY_KEY = `osm.count.${new Date(START).toISOString().slice(0, 10)}`;

/** A transport answering Overpass requests from `reply`, with an optional Retry-After per answer. */
function overpass(
  reply: (request: PublicRequest, attempt: number) => FakeReply & { retryAfterS?: number },
  clock: FakeClock,
): PublicTransport & { requests: PublicRequest[]; times: number[] } {
  const requests: PublicRequest[] = [];
  const times: number[] = [];
  const transport = async (request: PublicRequest) => {
    const attempt = requests.length;
    requests.push(request);
    times.push(clock.now());
    const r = reply(request, attempt);
    if (r.error !== undefined) throw r.error;
    const body = r.body === undefined ? answerCounts(request) : r.body;
    return { status: r.status ?? 200, body: typeof body === "string" ? body : JSON.stringify(body), ms: 5, retryAfterS: r.retryAfterS ?? null };
  };
  return Object.assign(transport, { requests, times });
}

function osmHarness(reply: Parameters<typeof overpass>[0] = () => ({}), over: Parameters<typeof harness>[0] = {}) {
  const clock = over.clock ?? new FakeClock();
  const transport = overpass(reply, clock);
  const h = harness({ osmUserAgent: UA, clock, transport: transport as unknown as ReturnType<typeof fakeTransport>, ...over });
  return { ...h, transport };
}

describe("OpenStreetMap through the public-data client", () => {
  it("is not configured without OSM_USER_AGENT, and sends nothing", async () => {
    const h = osmHarness(() => ({}), { osmUserAgent: null });
    expect(h.client.configured.osm).toBe(false);
    const err = await h.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("not_configured");
    expect((err as Error).message).toMatch(/OSM_USER_AGENT/);
    expect(h.transport.requests).toHaveLength(0);
    expect(osmHarness(() => ({}), { osmUserAgent: null, env: "mock" }).client.configured.osm).toBe(true);
    expect(osmHarness().client.configured.osm).toBe(true);
  });

  it("POSTs the canonical query, keeps the answer 30 days and records provenance with method and body", async () => {
    const h = osmHarness();
    const records: PublicCallRecord[] = [];
    const run = h.client.forRun({ runId: "run-alpha", onCall: (r) => records.push(r) });
    const res = await run.forTool("tool-supply").osmCounts(COUNTS);
    expect(res.data).toEqual({ osmBase: "2026-10-01T12:00:00.000Z", counts: { "area-a": { bar: 3, cafe: 3 }, "area-b": { bar: 3, cafe: 3 } } });
    expect(res.meta).toMatchObject({ source: "osm", endpoint: "/api/interpreter", cache: "miss", reference: `osm-${OSM_BASE}`, stale: false });

    const [request] = h.transport.requests;
    expect(request).toMatchObject({ source: "osm", method: "POST", host: "overpass-api.de", path: "/api/interpreter", query: {} });
    expect(request?.body?.startsWith("[out:json][timeout:25]")).toBe(true);

    const provenance = run.provenance(res.meta.publicCallId);
    expect(provenance).toEqual({
      source: "osm",
      method: "POST",
      host: "overpass-api.de",
      path: "/api/interpreter",
      query: {},
      reference: `osm-${OSM_BASE}`,
      body: request?.body,
    });
    const event = publicEventFrom(records[0] as PublicCallRecord);
    expect(event).toMatchObject({ type: "public", source: "osm", toolCallId: "tool-supply", cache: "miss", paramsRedacted: { kind: "counts", shapes: "area-a,area-b", types: "bar,cafe" } });

    await h.client.flush();
    const [entry] = [...h.store.entries.values()];
    expect(entry?.source).toBe("osm");
    expect(entry?.expiresAt?.getTime()).toBe(START + OSM_TTL_MS);
    expect(h.store.calls[0]).toMatchObject({ source: "osm", path: "/api/interpreter", params: { kind: "counts" }, cacheStatus: "miss", httpStatus: 200 });
    expect(h.store.counters.get(TODAY_KEY)).toBe(1);

    // The same question in another order is the same request: a cache hit, no network, no count.
    const again = await h.client.forRun({ runId: "run-beta" }).forTool(null).osmCounts({ shapes: [CIRCLE, SQUARE], types: [BAR, CAFE] });
    expect(again.meta.cache).toBe("reused");
    expect(again.meta.reference).toBe(`osm-${OSM_BASE}`);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.store.counters.get(TODAY_KEY)).toBe(1);
  });

  it("reads named places and their types", async () => {
    const h = osmHarness(() => ({
      body: placesBody([
        { type: "node", id: 21, lat: 10.15, lon: 20.15, tags: { amenity: "bar", name: "Example Bar 1" } },
        { type: "way", id: 22, center: { lat: 10.16, lon: 20.16 }, tags: { amenity: "cafe", name: "Example Cafe 1", brand: "Example Chain" } },
      ]),
    }));
    const res = await h.client.standalone().forTool(null).osmPlaces({ shape: CIRCLE, types: [CAFE, BAR], limit: 60 });
    expect(res.data.map((p) => [p.name, p.typeKey, p.osmType])).toEqual([
      ["Example Bar 1", "bar", "node"],
      ["Example Cafe 1", "cafe", "way"],
    ]);
    expect(h.transport.requests[0]?.body).toMatch(/out center tags 60;$/);
  });

  it("goes one request at a time, at least a second apart", async () => {
    const h = osmHarness();
    const api = h.client.standalone().forTool(null);
    await Promise.all([api.osmCounts({ shapes: [CIRCLE], types: [CAFE] }), api.osmCounts({ shapes: [SQUARE], types: [CAFE] })]);
    expect(h.transport.times).toHaveLength(2);
    expect((h.transport.times[1] as number) - (h.transport.times[0] as number)).toBeGreaterThanOrEqual(1000);
  });

  it("refuses past the daily cap before sending, and serves a stale copy when it has one", async () => {
    const h = osmHarness(() => ({}), { osmDailyMax: 2 });
    const api = h.client.standalone().forTool(null);
    await api.osmCounts({ shapes: [CIRCLE], types: [CAFE] });
    await api.osmCounts({ shapes: [SQUARE], types: [CAFE] });
    const err = await api.osmCounts({ shapes: [CIRCLE], types: [BAR] }).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("rate_limited");
    expect((err as Error).message).toMatch(/request cap for today \(2 Overpass requests\)/);
    expect(h.transport.requests).toHaveLength(2);

    // 31 days on (a new UTC day, but the counter there is already full): the expired copy answers.
    h.clock.advance(31 * DAY);
    h.store.counters.set(`osm.count.${new Date(h.clock.now()).toISOString().slice(0, 10)}`, 2);
    const stale = await api.osmCounts({ shapes: [CIRCLE], types: [CAFE] });
    expect(stale.meta).toMatchObject({ cache: "stale", stale: true });
    expect(h.transport.requests).toHaveLength(2);
  });

  it("counts in-process when the store has no shared counter", async () => {
    const store: Partial<MemoryPublicStore> = createMemoryPublicStore();
    delete store.incrementCounter;
    const h2 = osmHarness(() => ({}), { osmDailyMax: 1, store: store as MemoryPublicStore });
    const api = h2.client.standalone().forTool(null);
    await api.osmCounts({ shapes: [CIRCLE], types: [CAFE] });
    expect(publicDataErrorCode(await api.osmCounts({ shapes: [SQUARE], types: [CAFE] }).catch((e: unknown) => e))).toBe("rate_limited");
  });

  it("retries 429 once after Retry-After, and 502/503/504 once after 5 s", async () => {
    const limited = osmHarness((_, attempt) => (attempt === 0 ? { status: 429, body: "rate limited", retryAfterS: 2 } : {}));
    const ok = await limited.client.standalone().forTool(null).osmCounts(COUNTS);
    expect(ok.meta.cache).toBe("miss");
    expect(limited.transport.requests).toHaveLength(2);
    expect(limited.clock.sleeps).toContain(2000);
    expect(limited.store.counters.get(TODAY_KEY)).toBe(2);

    const busy = osmHarness(() => ({ status: 502, body: "# 502 Gateway Timeout" }));
    const err = await busy.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
    expect(busy.transport.requests).toHaveLength(2);
    expect(busy.clock.sleeps).toContain(5000);
    await busy.client.flush();
    expect(busy.store.entries.size).toBe(0);
  });

  it("does not wait out a long Retry-After or retry a timeout", async () => {
    const long = osmHarness(() => ({ status: 429, retryAfterS: 60 }));
    expect(publicDataErrorCode(await long.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e))).toBe("rate_limited");
    expect(long.transport.requests).toHaveLength(1);

    const timeout = osmHarness(() => ({ error: new TypeError("fetch failed") }));
    expect(publicDataErrorCode(await timeout.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e))).toBe("unavailable");
    expect(timeout.transport.requests).toHaveLength(1);
  });

  it("treats a runtime-error answer as unavailable: not stored, not retried", async () => {
    const h = osmHarness(() => ({ body: countsBody([1], { remark: "runtime error: Query ran out of memory in \"query\" at line 1." }) }));
    const err = await h.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
    expect((err as Error).message).toMatch(/ran out of memory/);
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("serves a stale copy when Overpass is busy after the entry expired", async () => {
    const h = osmHarness((_, attempt) => (attempt === 0 ? {} : { status: 504, body: "Gateway Timeout" }));
    const api = h.client.standalone().forTool(null);
    await api.osmCounts(COUNTS);
    await h.client.flush();
    h.clock.advance(OSM_TTL_MS + DAY);
    const res = await api.osmCounts(COUNTS);
    expect(res.meta).toMatchObject({ cache: "stale", stale: true, reference: `osm-${OSM_BASE}` });
    expect(res.data.counts["area-a"]?.cafe).toBe(3);
  });

  it("stores a rejected query a day as bad_request", async () => {
    const h = osmHarness(() => ({ status: 400, body: "<p>Error: line 1: parse error</p>" }));
    const api = h.client.standalone().forTool(null);
    for (let i = 0; i < 2; i++) {
      const err = await api.osmCounts(COUNTS).catch((e: unknown) => e);
      expect(publicDataErrorCode(err)).toBe("bad_request");
      expect((err as Error).message).toMatch(/Overpass API rejected the query \(HTTP 400\): Error: line 1: parse error/);
    }
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    expect([...h.store.entries.values()][0]?.expiresAt?.getTime()).toBe(START + DAY);
  });

  it("names the configured Overpass instance in requests and provenance", async () => {
    const h = osmHarness(() => ({}), { osmOverpassUrl: "https://overpass.example.org/api/interpreter" });
    const run = h.client.forRun({ runId: "run-gamma" });
    const res = await run.forTool(null).osmCounts(COUNTS);
    expect(h.transport.requests[0]).toMatchObject({ host: "overpass.example.org", path: "/api/interpreter" });
    expect(run.provenance(res.meta.publicCallId)?.host).toBe("overpass.example.org");
  });
});
