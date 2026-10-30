import { describe, expect, it } from "vitest";
import {
  ABOUT_LEVEL,
  aboutLevelRankPlaces,
  areaStanding,
  isAboutLevelDensityIndex,
  isAboutLevelIndex,
  isAboutLevelPctDelta,
  isAboutLevelRankGain,
  isAboutLevelTilt,
  STANDING,
  SUPPLY,
  THIN_SAMPLE,
} from "../src/formulas";

describe("thresholds that live in one place (Part 11)", () => {
  it("keeps the DESIGN 1.7 numbers", () => {
    expect(THIN_SAMPLE).toEqual({ rankedRows: 5, pairEntities: 2, liftConf: 0.5, liftCells: 12, blockTags: 20, conceptAnalogs: 4, twinSharedTags: 12 });
    expect(ABOUT_LEVEL).toEqual({ audienceIndex: 0.1, youthTilt: 0.1, pctDelta: 0.05, rankGainMinPlaces: 2, rankGainShare: 0.05, densityIndexLow: 0.8, densityIndexHigh: 1.25 });
    expect(STANDING).toEqual({ top: 0.75, low: 0.5 });
    expect(SUPPLY).toEqual({ overIndex: 1.5, underIndex: 0.5, minCount: 5, lowActivityShare: 0.3, beyondActivity: 1.25, belowActivity: 0.8 });
  });

  it("never reads +1 or +2 of 50 as a win (V13)", () => {
    expect(aboutLevelRankPlaces(50)).toBe(3);
    expect(aboutLevelRankPlaces(20)).toBe(2);
    expect(aboutLevelRankPlaces(0)).toBe(2);
    expect(isAboutLevelRankGain(1, 50)).toBe(true);
    expect(isAboutLevelRankGain(2, 50)).toBe(true);
    expect(isAboutLevelRankGain(-3, 50)).toBe(true);
    expect(isAboutLevelRankGain(4, 50)).toBe(false);
    expect(isAboutLevelRankGain(null, 50)).toBe(false);
  });

  it("puts small index, tilt and percentile differences in the about-level band", () => {
    expect(isAboutLevelIndex(0.09)).toBe(true);
    expect(isAboutLevelIndex(-0.1)).toBe(false);
    expect(isAboutLevelTilt(0.05)).toBe(true);
    expect(isAboutLevelPctDelta(0.049)).toBe(true);
    expect(isAboutLevelPctDelta(0.05)).toBe(false);
    expect(isAboutLevelDensityIndex(0.8)).toBe(true);
    expect(isAboutLevelDensityIndex(1.25)).toBe(true);
    expect(isAboutLevelDensityIndex(1.26)).toBe(false);
    expect(isAboutLevelDensityIndex(null)).toBe(false);
  });

  it("names popular, hidden and popular-and-distinct areas (R7)", () => {
    expect(areaStanding(0.8, 0.2)).toBe("popular");
    expect(areaStanding(0.8, null)).toBe("popular");
    expect(areaStanding(0.3, 0.9)).toBe("hidden");
    expect(areaStanding(0.6, 0.9)).toBeNull();
    expect(areaStanding(0.9, 0.9)).toBe("popular_distinct");
    expect(areaStanding(null, 0.9)).toBeNull();
  });
});
