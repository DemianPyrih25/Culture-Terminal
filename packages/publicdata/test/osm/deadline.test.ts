import { publicDataErrorCode } from "@ct/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicRequest, PublicTransportResponse } from "../../src/api";
import { OSM_CALL_DEADLINE_MS, OSM_FALLBACK_RESERVE_MS, OSM_TTL_MS } from "../../src/osm/client";
import { DAY, FakeClock, harness } from "../support/fakes";
import { answerCounts, CAFE, CIRCLE, SQUARE } from "./support";

// The deadline's abort runs on a timer (vitest's fake timers here); the client reads time from the
// FakeClock. `elapse` moves both together, as real time would.

const UA = "Culture Terminal test (ops@example.org)";
const FALLBACK = "https://overpass-fallback.example.org/api/interpreter";
const COUNTS = { shapes: [SQUARE], types: [CAFE] };
const STEP_MS = 100;

type Reply = (request: PublicRequest, attempt: number, signal: AbortSignal | undefined) => Promise<PublicTransportResponse>;

/** Never answers; ends with the signal's reason when it aborts, as fetch does. */
const hang = (_: PublicRequest, __: number, signal: AbortSignal | undefined): Promise<PublicTransportResponse> =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true }));

const answer = (request: PublicRequest, status = 200): Promise<PublicTransportResponse> =>
  Promise.resolve({ status, body: status === 200 ? JSON.stringify(answerCounts(request)) : "busy", ms: 5, retryAfterS: null });

function deadlineHarness(reply: Reply, over: Parameters<typeof harness>[0] = {}) {
  const clock = new FakeClock();
  const requests: PublicRequest[] = [];
  const transport = (request: PublicRequest, signal?: AbortSignal) => {
    const attempt = requests.length;
    requests.push(request);
    return reply(request, attempt, signal);
  };
  const h = harness({ osmUserAgent: UA, clock, transport: transport as never, ...over });
  // Small steps, so code that reads the clock between timers sees about the time a real run would.
  const elapse = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(0);
    for (let left = ms; left > 0; left -= STEP_MS) {
      const step = Math.min(STEP_MS, left);
      clock.advance(step);
      await vi.advanceTimersByTimeAsync(step);
    }
  };
  return { ...h, requests, elapse };
}

/** The promise's outcome so far, without waiting for it. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

describe("the OpenStreetMap deadline of one tool call", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a hanging Overpass request at the deadline, and the queued and later requests with it", async () => {
    const h = deadlineHarness(hang);
    const api = h.client.forRun({ runId: "run-a" }).forTool("tool-supply");
    const counts = track(api.osmCounts(COUNTS));
    const city = track(api.osmCounts({ shapes: [CIRCLE], types: [CAFE] }));
    await h.elapse(OSM_CALL_DEADLINE_MS - 1);
    expect(counts.settled).toBe(false);
    expect(city.settled).toBe(false);
    await h.elapse(1);
    expect(publicDataErrorCode(counts.error)).toBe("unavailable");
    expect((counts.error as Error).message).toMatch(/did not answer in time \(the OpenStreetMap step is limited to 12 s\)/);
    expect(publicDataErrorCode(city.error)).toBe("unavailable");
    // The second request waited behind the first and never left.
    expect(h.requests).toHaveLength(1);

    // Names asked after the deadline fail at once, without a request.
    const names = track(api.osmPlaces({ shape: SQUARE, types: [CAFE], limit: 10 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(publicDataErrorCode(names.error)).toBe("unavailable");
    expect(h.requests).toHaveLength(1);
    await h.client.flush();
    expect(h.store.entries.size).toBe(0);
  });

  it("frees the caller at the deadline even when the transport ignores the signal", async () => {
    const h = deadlineHarness(() => new Promise<PublicTransportResponse>(() => undefined));
    const call = track(h.client.standalone().forTool(null).osmCounts(COUNTS));
    await h.elapse(OSM_CALL_DEADLINE_MS);
    expect(publicDataErrorCode(call.error)).toBe("unavailable");
  });

  it("does not retry when the wait would pass the deadline", async () => {
    // The first answer is a 503 after 6 s: 6 s + the 5 s retry wait leaves too little of the 12 s.
    const h = deadlineHarness(async (request, attempt) => {
      if (attempt === 0) h.clock.advance(6_000);
      return answer(request, 503);
    });
    const err = await h.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
    expect((err as Error).message).toMatch(/busy \(HTTP 503\)/);
    expect(h.requests).toHaveLength(1);
    expect(h.clock.sleeps).not.toContain(5_000);

    // A quick 503 still gets its one retry inside the deadline.
    const quick = deadlineHarness((request, attempt) => answer(request, attempt === 0 ? 503 : 200));
    const ok = await quick.client.standalone().forTool(null).osmCounts(COUNTS);
    expect(ok.meta.cache).toBe("miss");
    expect(quick.requests).toHaveLength(2);
  });

  it("serves the stale cached copy when the deadline passes", async () => {
    let live = true;
    const h = deadlineHarness((request, attempt, signal) => (live ? answer(request) : hang(request, attempt, signal)));
    await h.client.standalone().forTool(null).osmCounts(COUNTS);
    await h.client.flush();
    h.clock.advance(OSM_TTL_MS + DAY);
    live = false;
    const call = track(h.client.standalone().forTool(null).osmCounts(COUNTS));
    await h.elapse(OSM_CALL_DEADLINE_MS);
    expect(call.error).toBeUndefined();
    expect(call.value?.meta).toMatchObject({ cache: "stale", stale: true });
    expect(call.value?.data.counts["area-b"]?.cafe).toBe(3);
    expect(h.requests).toHaveLength(2);
  });

  it("tries the fallback instance once, inside the same deadline, when the primary hangs", async () => {
    const h = deadlineHarness((request, attempt, signal) => (request.host === "overpass-api.de" ? hang(request, attempt, signal) : answer(request)), {
      osmOverpassFallbackUrl: FALLBACK,
    });
    const run = h.client.forRun({ runId: "run-b" });
    const call = track(run.forTool("tool-supply").osmCounts(COUNTS));
    await h.elapse(OSM_CALL_DEADLINE_MS - OSM_FALLBACK_RESERVE_MS);
    expect(call.error).toBeUndefined();
    expect(call.value?.meta.cache).toBe("miss");
    expect(h.requests.map((r) => r.host)).toEqual(["overpass-api.de", "overpass-fallback.example.org"]);
    expect(run.provenance(call.value?.meta.publicCallId ?? "")?.host).toBe("overpass-fallback.example.org");

    // The answer is cached under the same key: the next tool call reads it without a request.
    const again = await run.forTool("tool-supply-2").osmCounts(COUNTS);
    expect(again.meta.cache).toBe("hit");
    expect(h.requests).toHaveLength(2);
  });

  it("ends within the deadline when the fallback hangs too", async () => {
    const h = deadlineHarness(hang, { osmOverpassFallbackUrl: FALLBACK });
    const call = track(h.client.standalone().forTool(null).osmCounts(COUNTS));
    await h.elapse(OSM_CALL_DEADLINE_MS - 1);
    expect(call.settled).toBe(false);
    await h.elapse(1);
    expect(publicDataErrorCode(call.error)).toBe("unavailable");
    expect(h.requests.map((r) => r.host)).toEqual(["overpass-api.de", "overpass-fallback.example.org"]);
  });

  it("uses no fallback when none is set or the query was rejected, and has no deadline for the warm-up", async () => {
    const busy = deadlineHarness((request) => answer(request, 503));
    expect(publicDataErrorCode(await busy.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e))).toBe("unavailable");
    expect(busy.requests.map((r) => r.host)).toEqual(["overpass-api.de", "overpass-api.de"]);

    const rejected = deadlineHarness((request) => answer(request, 400), { osmOverpassFallbackUrl: FALLBACK });
    expect(publicDataErrorCode(await rejected.client.standalone().forTool(null).osmCounts(COUNTS).catch((e: unknown) => e))).toBe("bad_request");
    expect(rejected.requests.map((r) => r.host)).toEqual(["overpass-api.de"]);

    const warm = deadlineHarness(hang, { osmLongQueries: true });
    const call = track(warm.client.standalone().forTool(null).osmCounts(COUNTS));
    await warm.elapse(5 * OSM_CALL_DEADLINE_MS);
    expect(call.settled).toBe(false);
  });
});
