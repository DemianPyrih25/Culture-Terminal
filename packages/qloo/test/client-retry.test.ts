import type { Mode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  BudgetError,
  QlooAuthError,
  QlooBadRequestError,
  QlooNetworkError,
  QlooRateLimitError,
  QlooResponseError,
  QlooServerError,
} from "../src/errors";
import { QUOTA_KV_KEY, utcDay } from "../src/quota";
import { createMemoryQlooStore } from "../src/store";
import { DAY, type FakeReply, fakeTransport, FakeClock, harness, runScope, SEARCH_PARAMS, START } from "./support/fakes";

const RATE_LIMIT_BODY = { error_msg: "slow down" };

/** Replies from a list per attempt, then healthy answers. */
const script = (replies: FakeReply[]) => (_req: unknown, attempt: number) => replies[attempt] ?? {};

describe("retries and classification", () => {
  it("retries 429 with exponential backoff and returns the eventual answer", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, transport: fakeTransport(script([{ status: 429 }, { status: 429 }]), clock) });
    const res = await h.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(h.transport.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([300, 600]);
    expect(res.meta.cache).toBe("miss");
    expect(res.meta.requestId).toBe("req-c");
    expect(res.meta.ms).toBe(900);
  });

  it("waits for the per-second reset when it is longer, capped at 8 s", async () => {
    const clock = new FakeClock();
    const h = harness({
      clock,
      transport: fakeTransport(script([{ status: 429, headers: { secondReset: 2 } }, { status: 503, headers: { secondReset: 30 } }]), clock),
    });
    await h.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(clock.sleeps).toEqual([2000, 8000]);
  });

  it("applies U(0.8, 1.2) jitter", async () => {
    const low = new FakeClock();
    const a = harness({ clock: low, random: () => 0, transport: fakeTransport(script([{ status: 502 }]), low) });
    await a.client.standalone().forTool(null).search(SEARCH_PARAMS);
    const high = new FakeClock();
    const b = harness({ clock: high, random: () => 0.999999, transport: fakeTransport(script([{ status: 502 }]), high) });
    await b.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(low.sleeps).toEqual([240]);
    expect(high.sleeps).toEqual([360]);
  });

  it("treats a 200 with error_msg as a rate limit: retried, then thrown, never cached", async () => {
    const h = harness({ transport: fakeTransport(() => ({ body: RATE_LIMIT_BODY })) });
    const qloo = h.client.standalone().forTool(null);
    const err = await qloo.search(SEARCH_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooRateLimitError);
    expect((err as QlooRateLimitError).status).toBe(200);
    expect(h.transport.requests).toHaveLength(3);
    await qloo.search(SEARCH_PARAMS).catch(() => undefined);
    expect(h.transport.requests).toHaveLength(6);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("recovers from a rate-limit body on retry", async () => {
    const h = harness({ transport: fakeTransport(script([{ body: RATE_LIMIT_BODY }])) });
    const res = await h.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(res.data.results[0]?.name).toBe("Brand Alpha");
    expect(h.transport.requests).toHaveLength(2);
  });

  it("never caches a 429 that outlasts the retries", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 429 })) });
    const qloo = h.client.standalone().forTool(null);
    await expect(qloo.search(SEARCH_PARAMS)).rejects.toMatchObject({ status: 429, code: "qloo_rate_limited" });
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
    await qloo.search(SEARCH_PARAMS).catch(() => undefined);
    expect(h.transport.requests).toHaveLength(6);
  });

  it("retries 5xx and network errors, and never caches them", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 503 })) });
    const qloo = h.client.standalone().forTool(null);
    await expect(qloo.search(SEARCH_PARAMS)).rejects.toBeInstanceOf(QlooServerError);
    expect(h.transport.requests).toHaveLength(3);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);

    const n = harness({
      transport: fakeTransport(script([{ error: new QlooNetworkError("timeout", "no response") }, { error: new Error("socket hang up") }])),
    });
    const res = await n.client.standalone().forTool(null).search(SEARCH_PARAMS);
    expect(res.meta.cache).toBe("miss");
    expect(n.transport.requests).toHaveLength(3);
  });

  it("gives up after three attempts with the last error", async () => {
    const h = harness({ transport: fakeTransport(() => ({ error: new QlooNetworkError("network", "refused") })) });
    const err = await h.client.standalone().forTool(null).search(SEARCH_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooNetworkError);
    expect(h.transport.requests).toHaveLength(3);
  });

  it("does not retry other 5xx statuses or a body that is not JSON", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 501 })) });
    await expect(h.client.standalone().forTool(null).search(SEARCH_PARAMS)).rejects.toMatchObject({ status: 501 });
    expect(h.transport.requests).toHaveLength(1);

    const j = harness({ transport: fakeTransport(() => ({ body: "<html>oops</html>" })) });
    await expect(j.client.standalone().forTool(null).search(SEARCH_PARAMS)).rejects.toBeInstanceOf(QlooResponseError);
    expect(j.transport.requests).toHaveLength(1);
  });

  it("does not retry a body over the size cap, or answer it from a stale entry", async () => {
    const clock = new FakeClock();
    const tooLarge = new QlooNetworkError("too_large", "Qloo response is over the size cap");
    const h = harness({ clock, transport: fakeTransport((_req, attempt) => (attempt === 0 ? {} : { error: tooLarge }), clock) });
    const qloo = h.client.standalone().forTool(null);
    await qloo.search(SEARCH_PARAMS);
    clock.advance(31 * DAY);
    await expect(qloo.search(SEARCH_PARAMS)).rejects.toMatchObject({ reason: "too_large" });
    expect(h.transport.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([]);
  });

  it("rejects a body that fails the contracts schema, without caching it", async () => {
    const h = harness({ transport: fakeTransport(() => ({ body: { results: "nothing" } })) });
    await expect(h.client.standalone().forTool(null).search(SEARCH_PARAMS)).rejects.toBeInstanceOf(QlooResponseError);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });
});

describe("auth failures", () => {
  it("throws QlooAuthError on 401 without retrying", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 401 })) });
    const err = await h.client.standalone().forTool(null).search(SEARCH_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooAuthError);
    expect((err as QlooAuthError).status).toBe(401);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.client.quota().consecutiveAuthErrors).toBe(1);
  });

  it("switches to replay_only at three 401/403 in a row, and asks again on each later one", async () => {
    const modes: Mode[] = [];
    const h = harness({ onModeChange: (m) => modes.push(m), transport: fakeTransport(() => ({ status: 403 })) });
    const qloo = h.client.standalone().forTool(null);
    for (const name of ["Alpha", "Beta"]) await qloo.search({ query: `Brand ${name}` }).catch(() => undefined);
    expect(modes).toEqual([]);
    await qloo.search({ query: "Brand Gamma" }).catch(() => undefined);
    expect(modes).toEqual(["replay_only"]);
    // Live mode switched back on with the same bad key: the next rejection asks again.
    await qloo.search({ query: "Brand Delta" }).catch(() => undefined);
    expect(modes).toEqual(["replay_only", "replay_only"]);
  });

  it("continues a streak persisted by an earlier process", async () => {
    const store = createMemoryQlooStore();
    await store.setKv(QUOTA_KV_KEY, {
      monthLimit: null,
      monthRemaining: null,
      monthReset: null,
      capturedAt: null,
      lastSuccessAt: null,
      consecutiveAuthErrors: 3,
      day: utcDay(START),
      todayNetwork: 0,
    });
    const modes: Mode[] = [];
    const h = harness({ store, onModeChange: (m) => modes.push(m), transport: fakeTransport(() => ({ status: 401 })) });
    await h.client.standalone().forTool(null).search(SEARCH_PARAMS).catch(() => undefined);
    expect(modes).toEqual(["replay_only"]);
    expect(h.client.quota().consecutiveAuthErrors).toBe(4);
  });

  it("resets the streak on a success", async () => {
    const modes: Mode[] = [];
    const h = harness({
      onModeChange: (m) => modes.push(m),
      transport: fakeTransport(script([{ status: 401 }, { status: 401 }, {}, { status: 401 }, { status: 401 }])),
    });
    const qloo = h.client.standalone().forTool(null);
    for (const name of ["A", "B", "C", "D", "E"]) await qloo.search({ query: `Brand ${name}` }).catch(() => undefined);
    expect(modes).toEqual([]);
    expect(h.client.quota().consecutiveAuthErrors).toBe(2);
  });
});

describe("400 answers", () => {
  it("caches a 400 for one day so the same request fails without the network", async () => {
    const h = harness({ transport: fakeTransport(() => ({ status: 400, body: { message: "bad parameter" } })) });
    const qloo = h.client.forRun(runScope()).forTool("tool-a");
    const first = await qloo.search(SEARCH_PARAMS).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(QlooBadRequestError);
    expect(first).toMatchObject({ status: 400, cached: false });
    expect((first as Error).message).toContain("bad parameter");
    expect(h.transport.requests).toHaveLength(1);

    const second = await qloo.search(SEARCH_PARAMS).catch((e: unknown) => e);
    expect(second).toMatchObject({ status: 400, cached: true });
    expect(h.transport.requests).toHaveLength(1);

    h.clock.advance(DAY + 1);
    await qloo.search(SEARCH_PARAMS).catch(() => undefined);
    expect(h.transport.requests).toHaveLength(2);

    await h.client.flush();
    const rows = h.store.calls.map((c) => [c.cacheStatus, c.httpStatus, c.error !== null]);
    expect(rows).toEqual([
      ["miss", 400, true],
      ["hit", null, true],
      ["miss", 400, true],
    ]);
  });
});

describe("stale-on-error", () => {
  const failing = (clock: FakeClock, failure: FakeReply) => fakeTransport((_req, attempt) => (attempt === 0 ? {} : failure), clock);

  it("serves an expired entry younger than 4×TTL when the network fails, keeping its receipt", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, transport: failing(clock, { status: 503 }) });
    const qloo = h.client.standalone().forTool(null);
    const fresh = await qloo.search(SEARCH_PARAMS);
    clock.advance(31 * DAY);
    const stale = await qloo.search(SEARCH_PARAMS);
    expect(stale.meta).toMatchObject({ cache: "stale", stale: true, requestId: fresh.meta.requestId, fetchedAt: fresh.meta.fetchedAt });
    expect(stale.data).toEqual(fresh.data);
    expect(h.transport.requests).toHaveLength(4);
  });

  it("labels only the leader stale; a caller that waited on its flight is coalesced, still stale and free", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, transport: failing(clock, { status: 503 }) });
    const qloo = h.client.standalone().forTool(null);
    await qloo.search(SEARCH_PARAMS);
    clock.advance(31 * DAY);
    const [lead, follower] = await Promise.all([qloo.search(SEARCH_PARAMS), qloo.search(SEARCH_PARAMS)]);
    expect(lead.meta).toMatchObject({ cache: "stale", stale: true });
    expect(follower.meta).toMatchObject({ cache: "coalesced", stale: true, requestId: lead.meta.requestId });
    expect(h.transport.requests).toHaveLength(4);
    await h.client.flush();
    expect(h.store.calls.map((c) => c.cacheStatus).sort()).toEqual(["coalesced", "miss", "stale"]);
    expect(await h.store.countNetworkCalls({ env: "dev", tag: "test-agent" })).toBe(2);
  });

  it("refuses entries older than 4×TTL", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, transport: failing(clock, { error: new QlooNetworkError("network", "down") }) });
    const qloo = h.client.standalone().forTool(null);
    await qloo.search(SEARCH_PARAMS);
    clock.advance(121 * DAY);
    await expect(qloo.search(SEARCH_PARAMS)).rejects.toBeInstanceOf(QlooNetworkError);
  });

  it("does not cover 4xx, auth or budget failures", async () => {
    for (const failure of [{ status: 400 }, { status: 401 }] satisfies FakeReply[]) {
      const clock = new FakeClock();
      const h = harness({ clock, transport: failing(clock, failure) });
      const qloo = h.client.standalone().forTool(null);
      await qloo.search(SEARCH_PARAMS);
      clock.advance(31 * DAY);
      await expect(qloo.search(SEARCH_PARAMS)).rejects.toThrow(failure.status === 400 ? QlooBadRequestError : QlooAuthError);
    }

    const clock = new FakeClock();
    let alphaFetched = false;
    const transport = fakeTransport((req) => {
      if (req.query.query !== "Brand Alpha") return {};
      if (alphaFetched) return { status: 503 };
      alphaFetched = true;
      return {};
    }, clock);
    const h = harness({ clock, transport });
    await h.client.standalone().forTool(null).search(SEARCH_PARAMS);
    clock.advance(31 * DAY);
    const run = h.client.forRun(runScope({ limits: { ...runScope().limits, qlooCalls: 1, qlooWarnAt: 1 } })).forTool(null);
    await run.search({ query: "Brand Other" });
    await expect(run.search(SEARCH_PARAMS)).rejects.toBeInstanceOf(BudgetError);
  });
});
