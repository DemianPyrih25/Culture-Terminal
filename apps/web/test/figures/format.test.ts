// Number formatting and layout arithmetic shared by the figure families.
import { describe, expect, it } from "vitest";
import { MINUS, abbreviateRequestId, axisCodes, cellText, formatNumber, formatTick } from "../../components/figures";
import { fitText, hatchPath, niceDomain, symmetricDomain, textWidth, ticksBetween } from "../../components/figures/scale";

describe("formatNumber", () => {
  it("prints the dense style without a leading zero", () => {
    expect(formatNumber(0.56, "similarity", { leadingZero: false })).toBe(".56");
    expect(formatNumber(0.56, "similarity")).toBe("0.56");
    expect(formatNumber(1.34, "index", { leadingZero: false })).toBe("1.34");
  });

  it("signs deltas and uses the typographic minus", () => {
    expect(formatNumber(0.18, "delta")).toBe("+0.18");
    expect(formatNumber(-0.21, "delta")).toBe(`${MINUS}0.21`);
    expect(formatNumber(-0.001, "delta")).toBe("0.00");
  });

  it("prints ranks and counts as whole numbers", () => {
    expect(formatNumber(4, "rank")).toBe("4");
    expect(formatNumber(12, "count")).toBe("12");
  });

  it("explains a missing value instead of printing 0", () => {
    expect(cellText({ value: null, reason: "not_scored" }, "similarity")).toEqual({ kind: "missing", reason: "not scored" });
    expect(cellText({ value: 0, reason: null }, "similarity")).toEqual({ kind: "value", text: "0.00" });
  });
});

describe("formatTick", () => {
  it("uses the digits the step needs and a bare 0", () => {
    expect(formatTick(0, 0.2, "similarity")).toBe("0");
    expect(formatTick(0.4, 0.2, "similarity")).toBe("0.4");
    expect(formatTick(-0.05, 0.05, "pct", { leadingZero: false, absolute: true })).toBe(".05");
    expect(formatTick(1, 0.1, "index", { minDigits: 2 })).toBe("1.00");
  });
});

describe("abbreviateRequestId", () => {
  it("keeps the first and last four characters", () => {
    expect(abbreviateRequestId("0001aaaa0000f001")).toBe("0001…f001");
    expect(abbreviateRequestId("short-id")).toBe("short-id");
  });
});

describe("axisCodes", () => {
  it("makes short unique codes and honours overrides", () => {
    const codes = axisCodes([
      { key: "a", label: "Brand Alpha" },
      { key: "b", label: "Juniper Cola" },
      { key: "c", label: "Juniper" },
      { key: "d", label: "Junction" },
      { key: "e", label: "Kettle Ridge Tonic" },
    ]);
    expect(codes.get("a")).toBe("BA");
    expect(codes.get("b")).toBe("JC");
    expect(codes.get("c")).toBe("JUN");
    expect(codes.get("d")).toBe("JUNC");
    expect(codes.get("e")).toBe("KRT");
    expect(axisCodes([{ key: "a", label: "Brand Alpha" }], { a: "ALP" }).get("a")).toBe("ALP");
  });
});

describe("scale", () => {
  it("builds nice domains and ticks without float noise", () => {
    expect(niceDomain(0, 0.56, 3)).toEqual({ min: 0, max: 0.6, step: 0.2 });
    expect(ticksBetween(0, 0.6, 0.2)).toEqual([0, 0.2, 0.4, 0.6]);
  });

  it("centres a symmetric domain", () => {
    expect(symmetricDomain([0.13, -0.11], 0, 3)).toEqual({ min: -0.15, max: 0.15, step: 0.05 });
    expect(symmetricDomain([1.38, 0.66], 1, 3)).toEqual({ min: 0.6, max: 1.4, step: 0.2 });
  });

  it("keeps hatch lines inside their rectangle", () => {
    const d = hatchPath(10, 20, 30, 12, 5);
    const nums = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(nums.length).toBeGreaterThan(4);
    for (const [x, y] of nums) {
      expect(x).toBeGreaterThanOrEqual(10);
      expect(x).toBeLessThanOrEqual(40);
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(32);
    }
  });

  it("cuts labels to fit with an ellipsis", () => {
    const cut = fitText("Beverage peers, average of six", 80, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, 12)).toBeLessThanOrEqual(80);
    expect(fitText("Short", 80, 12)).toBe("Short");
  });
});
