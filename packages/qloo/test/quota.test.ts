import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENT_LOGGER } from "../src/logger";
import { QUOTA_KV_KEY, QuotaTracker, utcDay } from "../src/quota";
import { createMemoryQlooStore } from "../src/store";
import type { QlooHeaders } from "../src/transport-types";
import { DAY, FakeClock, START } from "./support/fakes";

const headers = (monthRemaining: number, monthReset: number | null = null): QlooHeaders => ({
  requestId: null,
  monthLimit: 50_000,
  monthRemaining,
  monthReset,
  secondLimit: null,
  secondRemaining: null,
  secondReset: null,
});

describe("quota snapshot persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a change made inside the throttle interval once the interval ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = new FakeClock();
    const store = createMemoryQlooStore();
    const writes: Promise<unknown>[] = [];
    const tracker = new QuotaTracker({ store, kvKey: QUOTA_KV_KEY, now: clock.now, logger: SILENT_LOGGER, track: (w) => writes.push(w) });

    tracker.observe(headers(45_000));
    await Promise.all(writes);
    expect(store.kv.get(QUOTA_KV_KEY)).toMatchObject({ monthRemaining: 45_000 });

    clock.advance(1_000);
    tracker.observe(headers(44_999));
    await Promise.all(writes);
    expect(store.kv.get(QUOTA_KV_KEY)).toMatchObject({ monthRemaining: 45_000 });
    expect(vi.getTimerCount()).toBe(1);

    clock.advance(4_000);
    vi.advanceTimersByTime(4_000);
    await Promise.all(writes);
    expect(store.kv.get(QUOTA_KV_KEY)).toMatchObject({ monthRemaining: 44_999 });
    expect(writes).toHaveLength(2);
  });

  it("drops the owed write when persistNow runs first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = new FakeClock();
    const store = createMemoryQlooStore();
    const writes: Promise<unknown>[] = [];
    const tracker = new QuotaTracker({ store, kvKey: QUOTA_KV_KEY, now: clock.now, logger: SILENT_LOGGER, track: (w) => writes.push(w) });

    tracker.observe(headers(45_000));
    tracker.observe(headers(44_999));
    expect(vi.getTimerCount()).toBe(1);
    tracker.persistNow();
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all(writes);
    expect(store.kv.get(QUOTA_KV_KEY)).toMatchObject({ monthRemaining: 44_999 });
    expect(writes).toHaveLength(2);
  });
});

describe("monthly reset", () => {
  const tracker = (clock: FakeClock, store = createMemoryQlooStore()) =>
    new QuotaTracker({ store, kvKey: QUOTA_KV_KEY, now: clock.now, logger: SILENT_LOGGER, track: () => undefined });

  it("forgets the remaining count once the monthly window resets, keeping the limit", () => {
    const clock = new FakeClock();
    const quota = tracker(clock);
    quota.observe(headers(1_000, 3_600));
    clock.advance(3_600_000 - 1);
    expect(quota.snapshot()).toMatchObject({ monthRemaining: 1_000, monthReset: new Date(START + 3_600_000).toISOString() });
    clock.advance(1);
    expect(quota.snapshot()).toMatchObject({ monthRemaining: null, monthReset: null, monthLimit: 50_000 });
    quota.observe(headers(49_999, 2_592_000));
    expect(quota.snapshot().monthRemaining).toBe(49_999);
  });

  it("rolls a persisted snapshot whose window reset while the process was down", async () => {
    const clock = new FakeClock();
    const store = createMemoryQlooStore();
    await store.setKv(QUOTA_KV_KEY, {
      monthLimit: 50_000,
      monthRemaining: 1_990,
      monthReset: new Date(START - 1).toISOString(),
      capturedAt: new Date(START - DAY).toISOString(),
      lastSuccessAt: null,
      consecutiveAuthErrors: 0,
      day: utcDay(START),
      todayNetwork: 0,
    });
    const quota = tracker(clock, store);
    await quota.load();
    expect(quota.snapshot()).toMatchObject({ monthRemaining: null, monthReset: null });
  });

  it("ignores a reset no later than the capture, so a header of 0 never lifts the floor", () => {
    const clock = new FakeClock();
    const quota = tracker(clock);
    quota.observe(headers(1_000, 0));
    clock.advance(DAY);
    expect(quota.snapshot().monthRemaining).toBe(1_000);
  });
});
