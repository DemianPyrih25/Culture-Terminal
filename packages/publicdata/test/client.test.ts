import { publicDataErrorCode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { PublicDataError, publicEventFrom, type PublicCallRecord } from "../src/api";
import { SEC_TTL_MS } from "../src/client";
import { CENSUS_GET } from "../src/census";
import { publicCacheKey } from "../src/canonical";
import { secTickersRequest } from "../src/sec";
import { DAY, deferred, FakeClock, fakeTransport, FIXTURE_CIK, harness, START } from "./support/fakes";

const ZCTAS = { kind: "zcta", zctas: ["00502", "00501"] } as const;
/** The fake clock is in 2026: the newest vintage tried is 2025. */
const NEWEST = 2025;

describe("SEC reads", () => {
  it("looks tickers up in one cached ticker map", async () => {
    const h = harness();
    const api = h.client.forRun({ runId: "run-alpha" }).forTool("tool-a");
    const a = await api.secTicker("zzqa");
    const b = await api.secTicker("ZZQ.B");
    const none = await api.secTicker("NOPE");
    expect(a.data).toEqual({ cik: FIXTURE_CIK, ticker: "ZZQA", title: "Alpha Fixture Holdings" });
    expect(b.data?.cik).toBe("0000000043");
    expect(none.data).toBeNull();
    expect(h.transport.requests).toHaveLength(1);
    expect([a.meta.cache, b.meta.cache, none.meta.cache]).toEqual(["miss", "hit", "hit"]);
    expect(a.meta).toMatchObject({ source: "sec", endpoint: "/files/company_tickers.json", reference: "company_tickers.json", stale: false });
  });

  it("parses company facts and keeps them 7 days", async () => {
    const h = harness();
    const res = await h.client.standalone().forTool(null).secCompanyFacts("42");
    expect(res.data.cik).toBe(FIXTURE_CIK);
    expect(res.meta.reference).toBe(`CIK${FIXTURE_CIK}`);
    await h.client.flush();
    const [entry] = [...h.store.entries.values()];
    expect(entry?.expiresAt?.getTime()).toBe(START + SEC_TTL_MS);
    expect(entry?.pinned).toBe(false);
    expect(entry?.body.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
  });

  it("fails with not_configured and no request when SEC_USER_AGENT is unset", async () => {
    const h = harness({ secUserAgent: null });
    expect(h.client.configured.sec).toBe(false);
    const err = await h.client.standalone().forTool(null).secTicker("ZZQA").catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("not_configured");
    expect(h.transport.requests).toHaveLength(0);
  });

  it("caches a 404 for a day as not_found", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" })) });
    const api = h.client.standalone().forTool(null);
    for (let i = 0; i < 2; i++) {
      const err = await api.secCompanyFacts("77").catch((e: unknown) => e);
      expect(publicDataErrorCode(err)).toBe("not_found");
    }
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    const [entry] = [...h.store.entries.values()];
    expect(entry?.status).toBe(404);
    expect(entry?.expiresAt?.getTime()).toBe(START + DAY);
  });

  it("retries an SEC 403 block and never stores it", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 403, body: "Undeclared Automated Tool" })) });
    const err = await h.client.standalone().forTool(null).secCompanyFacts("42").catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
    expect((err as Error).message).toMatch(/User-Agent/);
    expect(h.transport.requests).toHaveLength(3);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("never stores 429 or 5xx, and recovers on a retry", async () => {
    const h = harness({ transport: fakeTransport((_, attempt) => (attempt === 0 ? { status: 429 } : attempt === 1 ? { status: 503 } : {})) });
    const res = await h.client.standalone().forTool(null).secCompanyFacts("42");
    expect(res.meta.cache).toBe("miss");
    expect(h.transport.requests).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([300, 600]);

    const limited = harness({ transport: fakeTransport(() => ({ status: 429 })) });
    const err = await limited.client.standalone().forTool(null).secCompanyFacts("42").catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("rate_limited");
    await limited.client.flush();
    expect(limited.store.entries.size).toBe(0);
  });

  it("refuses a body that is not company facts without storing it", async () => {
    const h = harness({ transport: fakeTransport(() => ({ body: { unexpected: true } })) });
    const err = await h.client.standalone().forTool(null).secCompanyFacts("42").catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("invalid_response");
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("paces SEC at 5 requests per second (a burst of 5, never over SEC's 10 in any second)", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, rps: { sec: 5, census: 5 }, transport: fakeTransport(undefined, clock) });
    const api = h.client.standalone().forTool(null);
    await Promise.all(Array.from({ length: 20 }, (_, i) => api.secCompanyFacts(String(100 + i))));
    const times = h.transport.times.map((t) => t - START);
    expect(times).toHaveLength(20);
    // 5 at once, then one every 200 ms.
    expect(times.at(-1)).toBe(15 * 200);
    for (const t of times) expect(times.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(10);
  });
});

describe("cache and single-flight", () => {
  it("joins concurrent identical calls into one request", async () => {
    const gate = deferred();
    const h = harness({ transport: fakeTransport(() => ({ gate: gate.promise })) });
    const api = h.client.forRun({ runId: "run-alpha" }).forTool("tool-a");
    const a = api.secCompanyFacts("42");
    const b = api.secCompanyFacts("0000000042");
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.transport.requests).toHaveLength(1);
    expect([ra.meta.cache, rb.meta.cache].sort()).toEqual(["coalesced", "miss"]);
  });

  it("serves an expired answer when the network fails, marked stale", async () => {
    const h = harness();
    const api = h.client.standalone().forTool(null);
    await api.secCompanyFacts("42");
    h.clock.advance(8 * DAY);
    const failing = harness({ store: h.store, clock: h.clock, transport: fakeTransport(() => ({ status: 503 })) });
    await h.client.flush();
    const res = await failing.client.forRun({ runId: "run-bravo" }).forTool("tool-b").secCompanyFacts("42");
    expect(res.meta).toMatchObject({ cache: "stale", stale: true });
    expect(res.data.cik).toBe(FIXTURE_CIK);
    expect(failing.transport.requests).toHaveLength(3);
  });

  it("does not serve stale data past four TTLs", async () => {
    const h = harness();
    await h.client.standalone().forTool(null).secCompanyFacts("42");
    await h.client.flush();
    h.clock.advance(4 * SEC_TTL_MS + DAY);
    const failing = harness({ store: h.store, clock: h.clock, transport: fakeTransport(() => ({ status: 503 })) });
    const err = await failing.client.standalone().forTool(null).secCompanyFacts("42").catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
  });

  it("marks another run's cached answer as reused, its own as hit", async () => {
    const h = harness();
    await h.client.forRun({ runId: "run-alpha" }).forTool("t").secTicker("ZZQA");
    const own = await h.client.forRun({ runId: "run-alpha" }).forTool("t").secTicker("ZZQA");
    const other = await h.client.forRun({ runId: "run-bravo" }).forTool("t").secTicker("ZZQA");
    expect(own.meta.cache).toBe("hit");
    expect(other.meta).toMatchObject({ cache: "reused", originRunId: "run-alpha" });
  });
});

describe("Census reads", () => {
  it("uses the newest published vintage, pins it, and skips an unpublished one for a day", async () => {
    const h = harness({
      transport: fakeTransport((r) => (r.path === `/data/${NEWEST}/acs/acs5` ? { status: 404, body: "404 Not Found" } : {})),
    });
    const api = h.client.forRun({ runId: "run-alpha" }).forTool("tool-a");
    const first = await api.censusAcs(ZCTAS);
    expect(first.data).toMatchObject({ vintage: NEWEST - 1, dataset: "acs/acs5" });
    expect(first.data.rows.map((r) => r.geoId)).toEqual(["00501", "00502"]);
    expect(first.meta.reference).toBe(`acs5 ${NEWEST - 1} zcta 00501,00502`);
    expect(h.transport.requests.map((r) => r.path)).toEqual([`/data/${NEWEST}/acs/acs5`, `/data/${NEWEST - 1}/acs/acs5`]);

    // Another geography: the unpublished vintage is not tried again today.
    await api.censusAcs({ kind: "tract", state: "01", county: "002" });
    expect(h.transport.requests.map((r) => r.path).slice(2)).toEqual([`/data/${NEWEST - 1}/acs/acs5`]);

    await h.client.flush();
    const pinned = [...h.store.entries.values()].filter((e) => e.status === 200);
    expect(pinned).toHaveLength(2);
    expect(pinned.every((e) => e.pinned && e.expiresAt === null)).toBe(true);
  });

  it("says plainly when no vintage is published", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 404 })) });
    const err = await h.client.standalone().forTool(null).censusAcs(ZCTAS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("not_found");
    expect((err as Error).message).toMatch(/no ACS 5-year vintage/);
    expect(h.transport.requests).toHaveLength(3);
  });

  it("reads an empty answer as not_found", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 204, body: "" })) });
    const err = await h.client.standalone().forTool(null).censusAcs(ZCTAS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("not_found");
    expect(h.transport.requests).toHaveLength(1);
  });

  it("maps a key redirect to not_configured without retry or storage", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 302, body: "" })) });
    const err = await h.client.standalone().forTool(null).censusAcs(ZCTAS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("not_configured");
    expect(h.transport.requests).toHaveLength(1);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("never requests a variable outside the fixed set", async () => {
    const h = harness();
    const api = h.client.standalone().forTool(null);
    await api.censusAcs(ZCTAS);
    await api.censusAcs({ kind: "tract", state: "01", county: "002" });
    expect(h.transport.requests.length).toBeGreaterThan(0);
    for (const r of h.transport.requests) {
      expect(r.query.get).toBe(CENSUS_GET);
      expect(Object.keys(r.query).sort()).toEqual(r.query.in === undefined ? ["for", "get"] : ["for", "get", "in"]);
    }
  });
});

describe("records, events, provenance and the call log", () => {
  it("records every call, emits it, and logs one row per call with no key", async () => {
    const records: PublicCallRecord[] = [];
    const h = harness();
    const run = h.client.forRun({ runId: "run-alpha", onCall: (r) => records.push(r) });
    const api = run.forTool("tool-a");
    const res = await api.censusAcs({ kind: "zcta", zctas: ["00501", "00502", "00503", "00504"] });
    await api.censusAcs({ kind: "zcta", zctas: ["00504", "00503", "00502", "00501"] });
    await h.client.flush();

    expect(records.map((r) => r.cache)).toEqual(["miss", "hit"]);
    const record = run.call(res.meta.publicCallId);
    expect(record).toMatchObject({ toolCallId: "tool-a", runId: "run-alpha", source: "census", status: 200, error: null });
    expect(record?.paramsRedacted.for).toBe("zip code tabulation area:00501,00502,… (+2)");
    expect(publicEventFrom(records[0] as PublicCallRecord)).toMatchObject({ type: "public", source: "census", endpoint: "/data/acs/acs5", cache: "miss" });

    const provenance = run.provenance(res.meta.publicCallId);
    expect(provenance).toEqual({
      source: "census",
      method: "GET",
      host: "api.census.gov",
      path: `/data/${NEWEST}/acs/acs5`,
      query: { get: CENSUS_GET, for: "zip code tabulation area:00501,00502,00503,00504" },
      reference: `acs5 ${NEWEST} zcta 00501,00502,00503,00504`,
    });
    expect(h.store.calls).toHaveLength(2);
    expect(h.store.calls.map((c) => [c.cacheStatus, c.httpStatus, c.env, c.tag, c.source])).toEqual([
      ["miss", 200, "dev", "test-agent", "census"],
      ["hit", null, "dev", "test-agent", "census"],
    ]);
    const queries = [...records.flatMap((r) => [r.query, r.paramsRedacted]), ...h.store.calls.map((c) => c.params), ...[...h.store.entries.values()].map((e) => e.params)];
    for (const q of queries) expect(Object.keys(q).some((k) => /key/i.test(k))).toBe(false);
  });

  it("logs a failed network call with its status, and provenance is null for it", async () => {
    const records: PublicCallRecord[] = [];
    const h = harness({ transport: fakeTransport(() => ({ status: 500 })) });
    const run = h.client.forRun({ runId: "run-alpha", onCall: (r) => records.push(r) });
    await run.forTool("tool-a").secCompanyFacts("42").catch(() => undefined);
    await h.client.flush();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ cache: "miss", status: 500, fetchedAt: null });
    expect(records[0]?.error).toMatch(/HTTP 500/);
    expect(h.store.calls[0]).toMatchObject({ httpStatus: 500, cacheStatus: "miss" });
  });

  it("keys the cache without any credential and refuses a key-like parameter", () => {
    const request = secTickersRequest();
    expect(publicCacheKey(request, "pd-v1")).not.toBe(publicCacheKey(request, "mock-pd-v1"));
    expect(() => publicCacheKey({ ...request, query: { key: "x" } }, "pd-v1")).toThrow(/must never be part/);
  });

  it("throws only PublicDataError, readable by code", async () => {
    const h = harness();
    const err = await h.client.standalone().forTool(null).secTicker("not a ticker").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicDataError);
    expect(publicDataErrorCode(err)).toBe("bad_request");
  });
});
