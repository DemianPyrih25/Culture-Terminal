import { Badge, type Strength } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  BADGE_WEIGHT,
  STALE_DEFAULT_FRESHNESS,
  argumentStrength,
  badgeWeight,
  derivedBadge,
  distinctBadges,
  evidenceStrength,
  freshness,
  metricConfidence,
  pickBadge,
  windowAgeMonths,
} from "../src/badges";

const WINDOW = { start: "2024-01-01", end: "2024-06-30" };

describe("BADGE_WEIGHT and badgeWeight", () => {
  it("use the D7 weights m = 1 / 1 / 0.6 / F / 0", () => {
    expect(BADGE_WEIGHT).toEqual({ MEASURED: 1, DERIVED: 1, ESTIMATED: 0.6, UNAVAILABLE: 0 });
    expect(Object.keys(BADGE_WEIGHT).sort()).toEqual(Badge.options.filter((b) => b !== "STALE").sort());
    for (const badge of Badge.options.filter((b) => b !== "STALE")) expect(badgeWeight(badge, 0.2)).toBe(BADGE_WEIGHT[badge]);
  });

  it("weights STALE by its freshness, clamped to 0–1", () => {
    expect(badgeWeight("STALE", 0.5)).toBe(0.5);
    expect(badgeWeight("STALE", 1.4)).toBe(1);
    expect(badgeWeight("STALE", -0.2)).toBe(0);
  });

  it("reads a STALE metric without a freshness as a year past its window", () => {
    expect(STALE_DEFAULT_FRESHNESS).toBeCloseTo(Math.exp(-1), 12);
    expect(badgeWeight("STALE")).toBe(STALE_DEFAULT_FRESHNESS);
    expect(badgeWeight("STALE", null)).toBe(STALE_DEFAULT_FRESHNESS);
    expect(badgeWeight("STALE", Number.NaN)).toBe(STALE_DEFAULT_FRESHNESS);
  });
});

describe("windowAgeMonths and freshness", () => {
  it("counts whole calendar months after the window ends", () => {
    expect(windowAgeMonths(WINDOW, "2024-06-30")).toBe(0);
    expect(windowAgeMonths(WINDOW, "2024-07-29")).toBe(0);
    expect(windowAgeMonths(WINDOW, "2024-07-30")).toBe(1);
    expect(windowAgeMonths(WINDOW, "2025-03-15T10:00:00Z")).toBe(8);
    expect(windowAgeMonths(WINDOW, "2025-06-30")).toBe(12);
  });

  it("is 0 before the window ends and null for an unparseable date", () => {
    expect(windowAgeMonths(WINDOW, "2024-03-01")).toBe(0);
    expect(windowAgeMonths(WINDOW, "not a date")).toBeNull();
    expect(windowAgeMonths({ start: "2024-01-01", end: "June" }, "2025-01-01")).toBeNull();
  });

  it("computes F = exp(−months/12)", () => {
    expect(freshness(WINDOW, "2024-06-30")).toBe(1);
    expect(freshness(WINDOW, "2024-12-30")).toBeCloseTo(Math.exp(-0.5), 12);
    expect(freshness(WINDOW, "2025-06-30")).toBeCloseTo(Math.exp(-1), 12);
    expect(freshness(WINDOW, "2025-06-29")).toBeCloseTo(Math.exp(-11 / 12), 12);
    expect(freshness(WINDOW, "2024-01-15")).toBe(1);
    expect(freshness(WINDOW, "")).toBeNull();
  });
});

describe("metricConfidence", () => {
  it("computes m_badge·(1 − 1/√n)", () => {
    expect(metricConfidence("MEASURED", 4)).toBeCloseTo(0.5, 12);
    expect(metricConfidence("MEASURED", 100)).toBeCloseTo(0.9, 12);
    expect(metricConfidence("DERIVED", 4)).toBeCloseTo(0.5, 12);
    expect(metricConfidence("ESTIMATED", 9)).toBeCloseTo(0.4, 12);
  });

  it("uses the freshness as m for STALE and ignores it for other badges", () => {
    expect(metricConfidence("STALE", 16, 0.5)).toBeCloseTo(0.375, 12);
    expect(metricConfidence("STALE", 4, 1)).toBeCloseTo(0.5, 12);
    expect(metricConfidence("STALE", 16, freshness(WINDOW, "2025-06-30"))).toBeCloseTo(0.75 * Math.exp(-1), 12);
    expect(metricConfidence("STALE", 16)).toBeCloseTo(0.75 * STALE_DEFAULT_FRESHNESS, 12);
    expect(metricConfidence("STALE", 16, 0)).toBe(0);
    expect(metricConfidence("MEASURED", 4, 0.1)).toBeCloseTo(0.5, 12);
  });

  it("is 0 for a single observation and stays below the badge weight", () => {
    expect(metricConfidence("MEASURED", 1)).toBe(0);
    const big = metricConfidence("MEASURED", 1e12);
    expect(big).not.toBeNull();
    expect(big!).toBeGreaterThan(0.99);
    expect(big!).toBeLessThanOrEqual(1);
  });

  it("is null for UNAVAILABLE and for a missing or sub-1 n", () => {
    expect(metricConfidence("UNAVAILABLE", 50)).toBeNull();
    expect(metricConfidence("MEASURED", null)).toBeNull();
    expect(metricConfidence("MEASURED", 0)).toBeNull();
    expect(metricConfidence("MEASURED", 0.5)).toBeNull();
    expect(metricConfidence("MEASURED", Number.NaN)).toBeNull();
    expect(metricConfidence("STALE", null, 1)).toBeNull();
  });
});

describe("evidenceStrength", () => {
  it("cuts at 0.6 (STRONG) and 0.35 (MODERATE)", () => {
    expect(evidenceStrength(0.6)).toBe("STRONG");
    expect(evidenceStrength(0.5999)).toBe("MODERATE");
    expect(evidenceStrength(0.35)).toBe("MODERATE");
    expect(evidenceStrength(0.3499)).toBe("THIN");
    expect(evidenceStrength(1)).toBe("STRONG");
    expect(evidenceStrength(0)).toBe("THIN");
    expect(evidenceStrength(null)).toBe("THIN");
  });

  const pill = (badge: Badge, n: number, f?: number | null): Strength => evidenceStrength(metricConfidence(badge, n, f));

  it("matches the documented n thresholds per badge", () => {
    for (const badge of ["MEASURED", "DERIVED"] as const) {
      expect([pill(badge, 6), pill(badge, 7)]).toEqual(["MODERATE", "STRONG"]);
      expect([pill(badge, 2), pill(badge, 3)]).toEqual(["THIN", "MODERATE"]);
    }
    expect([pill("ESTIMATED", 5), pill("ESTIMATED", 6)]).toEqual(["THIN", "MODERATE"]);
  });

  it("fades a 26-week momentum series with the age of its window", () => {
    const at = (asOf: string): Strength => pill("STALE", 26, freshness(WINDOW, asOf));
    expect([at("2024-09-30"), at("2024-10-30")]).toEqual(["STRONG", "MODERATE"]);
    expect([at("2025-03-30"), at("2025-04-30")]).toEqual(["MODERATE", "THIN"]);
    expect(pill("STALE", 26)).toBe("THIN");
  });

  it("never lets ESTIMATED alone reach STRONG", () => {
    expect(pill("ESTIMATED", 1e9)).toBe("MODERATE");
  });
});

describe("argumentStrength", () => {
  it("uses the mean of the known confidences", () => {
    expect(argumentStrength([0.7, 0.5])).toBe("STRONG");
    expect(argumentStrength([0.65, 0.05])).toBe("MODERATE");
    expect(argumentStrength([0.3, 0.2])).toBe("THIN");
  });

  it("ignores missing confidences and is THIN without any", () => {
    expect(argumentStrength([0.7, null])).toBe("STRONG");
    expect(argumentStrength([null, null])).toBe("THIN");
    expect(argumentStrength([])).toBe("THIN");
  });
});

describe("pickBadge", () => {
  it("is UNAVAILABLE without a value, even inside a window", () => {
    expect(pickBadge({ origin: "measured", value: null })).toBe("UNAVAILABLE");
    expect(pickBadge({ origin: "derived", value: null, window: WINDOW })).toBe("UNAVAILABLE");
    expect(pickBadge({ origin: "measured", value: Number.NaN })).toBe("UNAVAILABLE");
  });

  it("is STALE for any value from a historical window", () => {
    expect(pickBadge({ origin: "measured", value: 0.4, window: WINDOW })).toBe("STALE");
    expect(pickBadge({ origin: "estimated", value: 0, window: WINDOW })).toBe("STALE");
  });

  it("otherwise follows the origin, and a zero value is still a value", () => {
    expect(pickBadge({ origin: "measured", value: 0 })).toBe("MEASURED");
    expect(pickBadge({ origin: "derived", value: 0.2, window: null })).toBe("DERIVED");
    expect(pickBadge({ origin: "estimated", value: -1.5 })).toBe("ESTIMATED");
  });
});

describe("derivedBadge", () => {
  it("turns arithmetic over MEASURED inputs into DERIVED", () => {
    expect(derivedBadge(["MEASURED", "MEASURED"])).toBe("DERIVED");
    expect(derivedBadge(["MEASURED", "DERIVED"])).toBe("DERIVED");
  });

  it("lets the weakest input decide", () => {
    expect(derivedBadge(["MEASURED", "ESTIMATED"])).toBe("ESTIMATED");
    expect(derivedBadge(["DERIVED", "STALE"])).toBe("STALE");
    expect(derivedBadge(["ESTIMATED", "STALE"])).toBe("STALE");
    expect(derivedBadge(["STALE", "UNAVAILABLE"])).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE without inputs", () => {
    expect(derivedBadge([])).toBe("UNAVAILABLE");
  });
});

describe("distinctBadges", () => {
  it("deduplicates in display order", () => {
    expect(distinctBadges(["STALE", "MEASURED", "STALE", "DERIVED"])).toEqual(["MEASURED", "DERIVED", "STALE"]);
    expect(distinctBadges([])).toEqual([]);
  });
});
