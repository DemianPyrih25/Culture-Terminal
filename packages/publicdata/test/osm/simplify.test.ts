import { describe, expect, it } from "vitest";
import { polyText, simplifyRing } from "../../src/osm/simplify";

/** A star-shaped ring with `n` vertices around (10, 20). */
function star(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const r = i % 2 === 0 ? 0.05 : 0.03;
    return [10 + r * Math.sin(a), 20 + r * Math.cos(a)];
  });
}

describe("simplifyRing", () => {
  it("keeps a short ring, opened and rounded to 5 decimals", () => {
    const ring: [number, number][] = [
      [10.123456789, 20.1],
      [10.2, 20.1],
      [10.2, 20.2],
      [10.123456789, 20.1],
    ];
    expect(simplifyRing(ring)).toEqual([
      [10.12346, 20.1],
      [10.2, 20.1],
      [10.2, 20.2],
    ]);
  });

  it("cuts a long ring to at most the limit and keeps its extent", () => {
    for (const n of [49, 200, 2000]) {
      const out = simplifyRing(star(n), 48);
      expect(out.length).toBeLessThanOrEqual(48);
      expect(out.length).toBeGreaterThanOrEqual(3);
      const lats = out.map((p) => p[0]);
      // The outer points survive: the extent shrinks by far less than the star's depth (0.02).
      expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0.09);
    }
  });

  it("drops collinear points first", () => {
    const line: [number, number][] = [];
    for (let i = 0; i <= 100; i++) line.push([10, 20 + i / 1000]);
    line.push([10.05, 20.1], [10.05, 20]);
    const out = simplifyRing(line, 10);
    expect(out).toEqual([
      [10, 20],
      [10, 20.1],
      [10.05, 20.1],
      [10.05, 20],
    ]);
  });

  it("refuses degenerate rings and coordinates out of range", () => {
    expect(() => simplifyRing([[10, 20], [10, 20], [10, 20]])).toThrow(RangeError);
    expect(() => simplifyRing([[95, 20], [10, 21], [11, 20]])).toThrow(RangeError);
    expect(() => simplifyRing(star(10), 2)).toThrow(RangeError);
  });

  it("writes Overpass poly text", () => {
    expect(polyText([[10.1, 20.123456], [10.2, -20]])).toBe("10.1 20.12346 10.2 -20");
  });
});
