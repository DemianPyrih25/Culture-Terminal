import { describe, expect, it } from "vitest";
import { p50, percentile, sum } from "./stats";

describe("p50", () => {
  it("is null for no samples", () => {
    expect(p50([])).toBeNull();
  });

  it("is the middle value for an odd count, regardless of order", () => {
    expect(p50([9, 1, 5])).toBe(5);
    expect(p50([42])).toBe(42);
  });

  it("is the mean of the two middle values for an even count (two runs per config)", () => {
    expect(p50([80, 120])).toBe(100);
    expect(p50([4, 1, 3, 2])).toBe(2.5);
  });

  it("ignores non-finite values", () => {
    expect(p50([Number.NaN, 2, Number.POSITIVE_INFINITY, 4])).toBe(3);
  });
});

describe("percentile", () => {
  it("returns the extremes at 0 and 100", () => {
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it("interpolates between ranks", () => {
    expect(percentile([0, 10], 25)).toBe(2.5);
  });

  it("rejects out-of-range percentiles", () => {
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("sum", () => {
  it("adds values", () => {
    expect(sum([0.1, 0.2, 0.3])).toBeCloseTo(0.6, 10);
    expect(sum([])).toBe(0);
  });
});
