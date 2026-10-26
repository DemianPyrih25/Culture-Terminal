// The tearsheet's own limits: per visitor (a minute and an hour), per hour for the process, and fresh
// Qloo calls per UTC day, reserved when a lookup starts; each says when a lookup frees up.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { DesLimiter } = await import("../../server/des/limits");

const T0 = Date.parse("2026-10-23T09:00:00.000Z");
const LIMITS = { visitorPerMinute: 2, visitorPerHour: 3, globalPerHour: 5, dailyNetworkCalls: 20 };

describe("DesLimiter", () => {
  it("holds a visitor to its minute, then its hour, saying when the oldest lookup leaves the window", () => {
    const limiter = new DesLimiter(LIMITS);
    expect(limiter.take("a", T0)).toBeNull();
    expect(limiter.take("a", T0 + 20_000)).toBeNull();
    expect(limiter.take("a", T0 + 30_000)).toEqual({ scope: "visitor", retryAfterS: 30 });
    expect(limiter.take("a", T0 + 60_000)).toBeNull();
    // Three in the hour: the first leaves it at T0 + 1 h.
    expect(limiter.take("a", T0 + 10 * 60_000)).toEqual({ scope: "visitor", retryAfterS: 50 * 60 });
    expect(limiter.take("a", T0 + 3_600_000)).toBeNull();
  });

  it("does not count a refused lookup, nor limit a visitor without an address", () => {
    const limiter = new DesLimiter(LIMITS);
    limiter.take("a", T0);
    limiter.take("a", T0);
    for (let i = 0; i < 3; i++) expect(limiter.take("a", T0 + 1000)?.scope).toBe("visitor");
    expect(limiter.take("a", T0 + 60_000)).toBeNull();
    expect(limiter.take(null, T0)).toBeNull();
    expect(limiter.take(null, T0)).toBeNull();
  });

  it("caps the process per hour across visitors", () => {
    const limiter = new DesLimiter(LIMITS);
    for (const v of ["a", "b", "c", "d", "e"]) expect(limiter.take(v, T0 + 1000)).toBeNull();
    expect(limiter.take("f", T0 + 2000)).toEqual({ scope: "global", retryAfterS: 3599 });
    expect(limiter.take("f", T0 + 3_601_000)).toBeNull();
  });

  it("holds a lookup's cap from its start and counts what it used once it settles, until 00:00 UTC", () => {
    const limiter = new DesLimiter(LIMITS);
    expect(limiter.take(null, T0, 12)).toBeNull();
    expect(limiter.networkToday(T0)).toBe(12);
    // A second lookup started together would pass the day's 20 calls between them: it waits.
    expect(limiter.take(null, T0, 12)).toEqual({ scope: "daily", retryAfterS: 15 * 3600 });
    limiter.settle(12, 8, T0, T0 + 5_000);
    expect(limiter.networkToday(T0)).toBe(8);
    expect(limiter.take(null, T0, 12)).toBeNull();
    limiter.settle(12, 12, T0, T0 + 5_000);
    expect(limiter.networkToday(T0)).toBe(20);
    expect(limiter.take(null, T0, 1)).toEqual({ scope: "daily", retryAfterS: 15 * 3600 });
    const tomorrow = Date.parse("2026-10-24T00:00:00.000Z");
    expect(limiter.take(null, tomorrow, 12)).toBeNull();
    expect(limiter.networkToday(tomorrow)).toBe(12);
  });

  it("counts only the calls of a lookup that ran past 00:00 UTC, its reservation having gone with the day", () => {
    const limiter = new DesLimiter(LIMITS);
    const late = Date.parse("2026-10-23T23:59:59.000Z");
    expect(limiter.take(null, late, 12)).toBeNull();
    const after = Date.parse("2026-10-24T00:00:03.000Z");
    limiter.settle(12, 9, late, after);
    expect(limiter.networkToday(after)).toBe(9);
  });

  it("forgets the least recently seen visitors past its bound", () => {
    const limiter = new DesLimiter({ ...LIMITS, visitorPerMinute: 1, globalPerHour: 100 }, 2);
    limiter.take("a", T0);
    limiter.take("b", T0);
    limiter.take("c", T0);
    // "a" was forgotten, so its window starts over; "c" is still held.
    expect(limiter.take("a", T0 + 1000)).toBeNull();
    expect(limiter.take("c", T0 + 1000)?.scope).toBe("visitor");
  });
});
