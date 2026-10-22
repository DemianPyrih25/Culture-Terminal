import { describe, expect, it } from "vitest";
import { burstFor, RequestLimiter, TokenBucket } from "../src/limiter";
import { deferred, FakeClock, harness, START } from "./support/fakes";

describe("TokenBucket", () => {
  it("starts with a full burst, then paces at rps", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ rps: 2, now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () =>
        bucket.take().then(() => {
          times.push(clock.now() - START);
        }),
      ),
    );
    expect(times).toEqual([0, 0, 500, 1000, 1500, 2000]);
  });

  it("uses burst max(1, floor(rps))", async () => {
    expect(burstFor(7)).toBe(7);
    expect(burstFor(1.5)).toBe(1);
    expect(burstFor(0.5)).toBe(1);
    const clock = new FakeClock();
    const bucket = new TokenBucket({ rps: 1.5, now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await bucket.take();
      times.push(clock.now() - START);
    }
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(666);
    expect(times[3]).toBeLessThanOrEqual(2003);
  });

  it("lets an aborted waiter leave without blocking the queue", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ rps: 1, now: clock.now, sleep: clock.sleep });
    await bucket.take();
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.take(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(bucket.take()).resolves.toBeUndefined();
  });
});

describe("RequestLimiter", () => {
  it("keeps at most `concurrency` requests in flight", async () => {
    const clock = new FakeClock();
    const limiter = new RequestLimiter({ rps: 100, concurrency: 6, now: clock.now, sleep: clock.sleep });
    const gate = deferred();
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight--;
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(6);
    gate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(6);
  });
});

describe("client pacing", () => {
  it("spaces network calls at the configured rps", async () => {
    const h = harness({ rps: 2 });
    const qloo = h.client.standalone().forTool(null);
    await Promise.all(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name) => qloo.search({ query: `Brand ${name}` })));
    expect(h.transport.times.map((t) => t - START)).toEqual([0, 0, 500, 1000, 1500]);
  });
});
