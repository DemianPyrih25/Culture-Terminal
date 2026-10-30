import { FindingKind, FindingSuggestion, Severity, type AgeBucket } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  BLOCK_NEW_SOUND_MIN_SHARE,
  FINDING_SEVERITY,
  FINDING_SUGGESTION,
  METRO_OUTLIER_MIN_RANK_GAP,
  TWIN_MIN_RHO,
  analogVetoedFinding,
  blockNewTagsFinding,
  isTasteFinancialsSplit,
  rhoWords,
  tasteFinancialsSplitFinding,
  twinFoundFinding,
  twinsOf,
  droppedCandidatesFinding,
  emptyResultFinding,
  fitPopularityRho,
  generationalSplitFinding,
  hiddenPocketFinding,
  isBlockNewTags,
  isHiddenPocket,
  isLatentDemand,
  isOutsideCategoryNeighbour,
  latentDemandFinding,
  locationFallbackFinding,
  metroOutlierFinding,
  nearSubstitutesFinding,
  noTrendSignalFinding,
  outsideCategoryNeighbourFinding,
  isPartnersOneCategory,
  partnersOneCategoryFinding,
  popularityDominanceFinding,
  suggestedPopularityCap,
  tasteIslandFinding,
  weakCategoryFitFinding,
  oversuppliedFinding,
  undersuppliedFinding,
  lowStreetActivityFinding,
  type FindingDraft,
  type PopularityDominanceResult,
} from "../src/findings";
import { median } from "../src/stats";

// Invented entities only (D29).
const ALPHA = "Brand Alpha";
const BETA = "Brand Beta";
const GAMMA = "Brand Gamma";

const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fired(d: FindingDraft | null): FindingDraft {
  expect(d).not.toBeNull();
  return d!;
}

/** `high` results above popularity 0.95 then `low` at 0.4, with no FIT, so only the share rule can fire. */
const pops = (high: number, low: number): PopularityDominanceResult[] =>
  [...Array<number>(high).fill(0.97), ...Array<number>(low).fill(0.4)].map((popularity) => ({ fit: null, popularity }));

/** Results whose popularity ranks follow `popularityRanks` while FIT ranks run 1..n. */
const ranked = (popularityRanks: readonly number[]): PopularityDominanceResult[] =>
  popularityRanks.map((rank, i) => ({ fit: (i + 1) / 10, popularity: rank / 20 }));

/** Nine results with Spearman ρ exactly 0.8: three disjoint swaps of ranks two apart, Σd² = 24. */
const RHO_AT_EDGE = [3, 2, 1, 6, 5, 4, 9, 8, 7];
/** Nine results with Σd² = 26, the next possible value: ρ just under 0.8. */
const RHO_BELOW_EDGE = [3, 1, 2, 4, 5, 9, 8, 7, 6];

/** One firing draft per kind, from typical inputs. */
function oneOfEach(): FindingDraft[] {
  return [
    fired(tasteIslandFinding({ targetName: ALPHA, lastInRows: 4, scoredRows: 5, nearestName: BETA })),
    nearSubstitutesFinding({ aName: ALPHA, bName: BETA }),
    outsideCategoryNeighbourFinding({ targetName: ALPHA, neighbourName: GAMMA, neighbourCategory: "Energy Drink", neighbourInMap: false }),
    fired(generationalSplitFinding({ targetName: ALPHA, targetTilt: 0.5, setMedianTilt: 0, unreadAges: ["25_to_29", "30_to_34", "45_to_54"] })),
    fired(
      metroOutlierFinding({
        targetName: ALPHA,
        marketLabel: "Nashville",
        metroRank: 1,
        medianRank: 4,
        setSize: 6,
      }),
    ),
    fired(
      hiddenPocketFinding({
        seedLabel: "Artist Nova",
        destinations: [{ name: "Lake Town", residualZ: 2.4, popularity: 0.3 }],
        medianPopularity: 0.5,
      }),
    ),
    fired(
      latentDemandFinding({
        metroLabel: "Austin",
        neighbourhoods: [{ name: "Riverside", demandPct: 0.9, supplyPct: 0.1 }],
      }),
    ),
    fired(
      blockNewTagsFinding({
        areaName: "Riverside",
        family: "WHAT",
        newTags: ["Natural Wine", "Omakase", "Vinyl Bar"],
        familyTags: 6,
        signalTags: [
          { name: "Natural Wine", ref: "T4" },
          { name: "Vinyl Bar", ref: "T6" },
        ],
      }),
    ),
    emptyResultFinding({
      what: "the concept heatmap for Austin",
      suggestion: { tool: "find_tags", reason: "Try broader taxonomy place tags." },
    }),
    fired(droppedCandidatesFinding({ names: [BETA], context: "the Austin metro context" })),
    fired(noTrendSignalFinding({ names: [GAMMA] })),
    fired(
      popularityDominanceFinding({ context: "the music results", results: pops(8, 2), popularityMax: null }),
    ),
    locationFallbackFinding({ areaName: "Riverside", from: "POLYGON", to: "POINT" }),
    fired(weakCategoryFitFinding({ categoryLabel: "Outdoor retail", bestName: GAMMA, fitPct: 0.09, rank: 11, scored: 12 })),
    fired(
      twinFoundFinding({
        sourceName: "Riverside",
        targetCity: "Austin",
        areas: [
          { id: "a", name: "Lakeview", rho: 0.71 },
          { id: "b", name: "Hillcrest", rho: 0.2 },
          { id: "c", name: "Mill Town", rho: -0.1 },
        ],
      }),
    ),
    fired(analogVetoedFinding({ conceptLabel: "hot sauce", vetoed: [BETA], scored: 3, adds: [{ name: GAMMA, ref: "R7" }] })),
    fired(
      tasteFinancialsSplitFinding({
        brandName: ALPHA,
        companyName: "Alpha Holdings",
        momentumDelta: -0.12,
        momentumWindow: "the 2025-04-01..2025-09-30 trending window",
        revenueYoy: 0.06,
        revenuePeriod: "the fiscal year ended 2025-06-30",
      }),
    ),
    fired(
      partnersOneCategoryFinding({
        subjectName: ALPHA,
        subjectRef: "R1",
        categoryLabel: "Food and beverage",
        inCategory: 9,
        scored: 12,
        otherCategories: ["telecom", "travel"],
      }),
    ),
    fired(
      oversuppliedFinding({
        cityLabel: "Nashville",
        candidates: [{ area: "Area North", typeLabel: "Cafes", count: 12, index: 1.8, cityPerKm2: 2 }],
      }),
    ),
    fired(
      undersuppliedFinding({
        cityLabel: "Nashville",
        candidates: [{ area: "Area South", typeLabel: "Cafes", count: 1, index: 0.3, cityPerKm2: 2 }],
      }),
    ),
    fired(
      lowStreetActivityFinding({
        cityLabel: "Nashville",
        areas: [{ area: "Area East", activityPerKm2: 1 }],
        cityActivityPerKm2: 10,
      }),
    ),
  ];
}

describe("supply findings (R6)", () => {
  it("fire only past the SUPPLY thresholds", () => {
    const c = { area: "A", typeLabel: "Cafes", cityPerKm2: 2 };
    expect(oversuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 4, index: 3 }] })).toBeNull();
    expect(oversuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 5, index: 1.49 }] })).toBeNull();
    expect(oversuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 5, index: 1.5 }] })?.kind).toBe("OVERSUPPLIED");
    expect(undersuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 0, index: 0.5 }] })?.kind).toBe("UNDERSUPPLIED");
    expect(undersuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 0, index: 0, cityPerKm2: 0 }] })).toBeNull();
    // Read against the area's street activity: 2× the city's density on a street 2× as busy is the same share.
    expect(oversuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 9, index: 2, activityIndex: 2 }] })).toBeNull();
    expect(oversuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 9, index: 2.5, activityIndex: 2 }] })?.kind).toBe("OVERSUPPLIED");
    expect(undersuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 1, index: 0.4, activityIndex: 0.45 }] })).toBeNull();
    expect(undersuppliedFinding({ cityLabel: "X", candidates: [{ ...c, count: 1, index: 0.3, activityIndex: 0.45 }] })?.kind).toBe("UNDERSUPPLIED");
    expect(lowStreetActivityFinding({ cityLabel: "X", areas: [{ area: "A", activityPerKm2: 3 }], cityActivityPerKm2: 10 })).toBeNull();
    expect(lowStreetActivityFinding({ cityLabel: "X", areas: [{ area: "A", activityPerKm2: 1 }], cityActivityPerKm2: null })).toBeNull();
  });
});

describe("policy tables", () => {
  it("map every finding kind to a suggestion and a severity", () => {
    expect(Object.keys(FINDING_SUGGESTION).sort()).toEqual([...FindingKind.options].sort());
    expect(Object.keys(FINDING_SEVERITY).sort()).toEqual([...FindingKind.options].sort());
  });

  it("mirror the PLAN §4.4 follow-ups", () => {
    expect(FINDING_SUGGESTION).toMatchObject({
      TASTE_ISLAND: "cross_domain",
      NEAR_SUBSTITUTES: "share_of_taste",
      OUTSIDE_CATEGORY_NEIGHBOUR: "peer_landscape",
      METRO_OUTLIER: "share_of_taste",
      LATENT_DEMAND: "block_dna",
      BLOCK_NEW_TAGS: "rank_candidates",
      POPULARITY_DOMINANCE: "cross_domain",
      GENERATIONAL_SPLIT: "share_of_taste",
      WEAK_CATEGORY_FIT: "sponsor_slate",
      EMPTY_RESULT: null,
      HIDDEN_POCKET: null,
      DROPPED_CANDIDATES: null,
      NO_TREND_SIGNAL: null,
      LOCATION_FALLBACK: null,
      TWIN_FOUND: "block_dna",
      ANALOG_VETOED: "rank_candidates",
      TASTE_FINANCIALS_SPLIT: null,
      PARTNERS_ONE_CATEGORY: "sponsor_slate",
      OVERSUPPLIED: "block_dna",
      UNDERSUPPLIED: "block_dna",
      LOW_STREET_ACTIVITY: null,
    });
  });
});

describe("every finding kind", () => {
  const drafts = oneOfEach();

  it("has a detector or builder", () => {
    expect(drafts.map((d) => d.kind).sort()).toEqual([...FindingKind.options].sort());
  });

  it.each(drafts.map((d) => [d.kind, d] as const))("%s draft is one plain sentence with a valid suggestion", (kind, d) => {
    expect(Severity.options).toContain(d.severity);
    expect(d.text).toMatch(/^[A-Z].*\.$/);
    expect(d.text).not.toContain("\n");
    expect(d.text).not.toMatch(LONG_DECIMAL);
    expect(d.text).not.toMatch(UUID);
    if (d.suggestion) {
      expect(FindingSuggestion.parse(d.suggestion)).toEqual(d.suggestion);
      expect(d.suggestion.reason).toMatch(/^[A-Z].*\.$/);
      // EMPTY_RESULT and DROPPED_CANDIDATES have no fixed tool; they carry the caller's.
      if (FINDING_SUGGESTION[kind] !== null) expect(d.suggestion.tool).toBe(FINDING_SUGGESTION[kind]);
    } else {
      expect(["GENERATIONAL_SPLIT", "HIDDEN_POCKET", "DROPPED_CANDIDATES", "NO_TREND_SIGNAL", "LOCATION_FALLBACK", "TASTE_FINANCIALS_SPLIT", "LOW_STREET_ACTIVITY"]).toContain(kind);
    }
  });
});

describe("TASTE_ISLAND", () => {
  const island = (lastInRows: number, scoredRows: number) =>
    tasteIslandFinding({ targetName: ALPHA, lastInRows, scoredRows, nearestName: null });

  it("fires at last in 75% of at least three scored rows", () => {
    expect(island(3, 4)).not.toBeNull();
    expect(island(6, 8)).not.toBeNull();
    expect(island(3, 3)).not.toBeNull();
    expect(island(2, 3)).toBeNull();
    expect(island(5, 7)).toBeNull();
    expect(island(2, 2)).toBeNull();
  });

  it("rejects impossible counts", () => {
    expect(island(5, 4)).toBeNull();
    expect(island(1.5, 2)).toBeNull();
  });

  it("names the nearest peer only when there is one", () => {
    const d = fired(tasteIslandFinding({ targetName: ALPHA, lastInRows: 4, scoredRows: 5, nearestName: BETA }));
    expect(d.text).toBe(
      "Brand Alpha ranks last in 4 of 5 peer rows, so its audience taste sits apart from this peer set; its closest peer is Brand Beta.",
    );
    expect(d.suggestion).toEqual({ tool: "cross_domain", reason: "Look for Brand Alpha's cultural home outside this peer set." });
    expect(fired(island(4, 4)).text).not.toContain("closest peer");
  });
});

describe("NEAR_SUBSTITUTES and OUTSIDE_CATEGORY_NEIGHBOUR", () => {
  it("names the pair in the text and in the follow-up", () => {
    const d = nearSubstitutesFinding({ aName: ALPHA, bName: BETA });
    expect(d.text).toContain("Brand Alpha and Brand Beta");
    expect(d.text).toContain("near-substitutes");
    expect(d.suggestion?.reason).toBe("Compare where Brand Alpha and Brand Beta each win by age and metro.");
  });

  it("shows the neighbour's category when known", () => {
    const withCategory = outsideCategoryNeighbourFinding({
      targetName: ALPHA,
      neighbourName: GAMMA,
      neighbourCategory: "Energy Drink",
      neighbourInMap: false,
    });
    expect(withCategory.text).toMatch(/^Brand Gamma \(Energy Drink\) sits outside Brand Alpha's category/);
    const without = outsideCategoryNeighbourFinding({ targetName: ALPHA, neighbourName: GAMMA, neighbourCategory: null, neighbourInMap: false });
    expect(without.text).not.toContain("(");
  });

  it("pivots to adding a neighbour left out of the map, and to its own map once it holds a slot", () => {
    const args = { targetName: ALPHA, neighbourName: GAMMA, neighbourCategory: null };
    const outside = outsideCategoryNeighbourFinding({ ...args, neighbourInMap: false });
    expect(outside.suggestion).toEqual({
      tool: "peer_landscape",
      reason: "Add Brand Gamma to the Substitution Map as a cross-category peer.",
    });
    const inMap = outsideCategoryNeighbourFinding({ ...args, neighbourInMap: true });
    expect(inMap.suggestion).toEqual({
      tool: "peer_landscape",
      reason: "Map Brand Gamma's own peers, with Brand Gamma as the target.",
    });
    expect(inMap.text).toBe(outside.text);
  });

  it("applies the similarity ≥ best in-category rule", () => {
    const rule = (neighbourScore: number | null, bestInCategoryScore: number | null, neighbourInCategory = false) =>
      isOutsideCategoryNeighbour({ neighbourInCategory, neighbourScore, bestInCategoryScore });
    expect(rule(0.6, 0.6)).toBe(true);
    expect(rule(0.7, 0.6)).toBe(true);
    expect(rule(0.59, 0.6)).toBe(false);
    expect(rule(0.7, 0.6, true)).toBe(false);
    expect(rule(null, 0.6)).toBe(false);
    expect(rule(0.3, null)).toBe(true);
  });
});

describe("GENERATIONAL_SPLIT", () => {
  const split = (targetTilt: number | null, setMedianTilt: number | null, unreadAges: readonly AgeBucket[] = []) =>
    generationalSplitFinding({ targetName: ALPHA, targetTilt, setMedianTilt, unreadAges });

  it("fires when the target's tilt is 0.4 above the set median, absorbing float error at the edge", () => {
    expect(split(0.7, 0.3)).not.toBeNull();
    expect(split(0.69, 0.3)).toBeNull();
    expect(split(0.1, -0.3)).not.toBeNull();
  });

  it("is one-sided: a target skewing older is not a finding", () => {
    expect(split(-0.3, 0.2)).toBeNull();
    expect(split(-0.9, 0.9)).toBeNull();
  });

  it("says the target skews younger and follows up in the age buckets the call left unread", () => {
    const d = fired(split(0.5, 0, ["25_to_29", "30_to_34", "45_to_54", "30_to_34"]));
    expect(d.text).toBe("Brand Alpha skews clearly younger than its peer set: its youth tilt sits well above the set median.");
    expect(d.severity).toBe("medium");
    expect(d.suggestion).toEqual({
      tool: "share_of_taste",
      reason: "Rank the same set in the unread age buckets 25_to_29, 30_to_34, 45_to_54 to find the age where Brand Alpha's lead gives way.",
    });
  });

  it("suggests no follow-up once every age bucket was read", () => {
    expect(fired(split(0.5, 0)).suggestion).toBeNull();
  });

  it("needs both tilts", () => {
    expect(split(null, 0)).toBeNull();
    expect(split(0.9, Number.NaN)).toBeNull();
  });
});

describe("METRO_OUTLIER", () => {
  const outlier = (metroRank: number, medianRank: number) =>
    metroOutlierFinding({ targetName: ALPHA, marketLabel: "Austin", metroRank, medianRank, setSize: 6 });

  it("fires at two places from the median rank, either way", () => {
    expect(fired(outlier(1, 3)).text).toBe("Brand Alpha ranks 1 of 6 in Austin, clearly better than its median rank across metros.");
    expect(fired(outlier(5, 3)).text).toContain("clearly worse");
    expect(outlier(1, 3.5)).not.toBeNull();
    expect(outlier(2, 3)).toBeNull();
    expect(outlier(2, 3.5)).toBeNull();
  });

  it("asks two places in a set of three or four too, so a target whose median sits mid-scale raises none", () => {
    const inSet = (setSize: number, metroRank: number, medianRank: number) =>
      metroOutlierFinding({ targetName: ALPHA, marketLabel: "Riverton", metroRank, medianRank, setSize });
    expect(METRO_OUTLIER_MIN_RANK_GAP).toBe(2);
    // First or last of four where its median rank is 2.5: a place and a half, within reach of noise.
    expect(inSet(4, 1, 2.5)).toBeNull();
    expect(inSet(4, 4, 2.5)).toBeNull();
    expect(inSet(3, 3, 1.5)).toBeNull();
    expect(fired(inSet(4, 1, 3)).text).toBe("Brand Alpha ranks 1 of 4 in Riverton, clearly better than its median rank across metros.");
    expect(fired(inSet(4, 4, 2)).text).toContain("clearly worse");
    expect(fired(inSet(3, 3, 1)).text).toContain("ranks 3 of 3");
    expect(inSet(2, 1, 2)).toBeNull();
  });

  it("fires on pure noise in a set of four over eight metros no more often than the two-place rule itself does", () => {
    // mulberry32: a fixed seed keeps the rate the same on every run.
    let seed = 20261023;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // The target's rank in each metro drawn uniformly, so no metro differs from the rest but by chance.
    const noiseRate = (setSize: number, metros: number, trials = 4000): number => {
      let firing = 0;
      for (let t = 0; t < trials; t++) {
        const ranks = Array.from({ length: metros }, () => 1 + Math.floor(random() * setSize));
        const medianRank = median(ranks)!;
        const fires = ranks.some((metroRank) => metroOutlierFinding({ targetName: ALPHA, marketLabel: "Riverton", metroRank, medianRank, setSize }) !== null);
        if (fires) firing++;
      }
      return firing / trials;
    };
    // Two places fire on about 62% of such grids (a place and a half fired on about 90%), and on about
    // 15% for a set of three. Lowering the gap for short sets would push both bounds.
    expect(noiseRate(4, 8)).toBeLessThan(2 / 3);
    expect(noiseRate(3, 8)).toBeLessThan(0.2);
  });

  it("suggests the same set ranked in other markets, in a gazetteer metro too, since no lift map can run from a share set", () => {
    const better = fired(outlier(1, 3));
    expect(better.severity).toBe("medium");
    expect(better.suggestion).toEqual({
      tool: "share_of_taste",
      reason: "Rank the same set in other markets, those near Austin first, to see whether Brand Alpha's better showing there is local or regional.",
    });
    expect(fired(outlier(5, 3)).suggestion?.reason).toContain("Brand Alpha's worse showing there");
  });

  it("rejects ranks outside the set", () => {
    expect(outlier(0, 3)).toBeNull();
    expect(outlier(7, 3)).toBeNull();
    expect(outlier(1.5, 4)).toBeNull();
    expect(outlier(1, Number.NaN)).toBeNull();
  });
});

describe("HIDDEN_POCKET", () => {
  it("needs a residual z of 2 and popularity below the median", () => {
    expect(isHiddenPocket({ name: "A", residualZ: 2, popularity: 0.49 }, 0.5)).toBe(true);
    expect(isHiddenPocket({ name: "A", residualZ: 1.99, popularity: 0.1 }, 0.5)).toBe(false);
    expect(isHiddenPocket({ name: "A", residualZ: 3, popularity: 0.5 }, 0.5)).toBe(false);
    expect(isHiddenPocket({ name: "A", residualZ: null, popularity: 0.1 }, 0.5)).toBe(false);
  });

  it("never calls a destination at or above popularity 0.85 hidden, however high the median (D3)", () => {
    expect(isHiddenPocket({ name: "A", residualZ: 3, popularity: 0.84 }, 0.95)).toBe(true);
    expect(isHiddenPocket({ name: "A", residualZ: 3, popularity: 0.85 }, 0.95)).toBe(false);
    expect(isHiddenPocket({ name: "A", residualZ: 3, popularity: 0.9 }, 0.95)).toBe(false);
  });

  it("names the strongest pockets first, with agreement for one or many", () => {
    const destinations = [
      { name: "Lake Town", residualZ: 2.1, popularity: 0.2 },
      { name: "Mesa Springs", residualZ: 3.2, popularity: 0.3 },
      { name: "Big City", residualZ: 4, popularity: 0.9 },
      { name: "Pine Hollow", residualZ: 2.5, popularity: 0.1 },
      { name: "Red Rock", residualZ: 2.2, popularity: 0.2 },
    ];
    const many = fired(hiddenPocketFinding({ seedLabel: "Artist Nova", destinations, medianPopularity: 0.5 }));
    expect(many.text).toBe(
      "Mesa Springs, Pine Hollow, Red Rock and 1 more rank higher in the travel taste of the Artist Nova audience than their popularity predicts: hidden pockets for experiential or pop-up ideas.",
    );
    const one = fired(hiddenPocketFinding({ seedLabel: "Artist Nova", destinations: destinations.slice(0, 1), medianPopularity: 0.5 }));
    expect(one.text).toContain("Lake Town ranks higher");
    expect(one.text).toContain("a hidden pocket");
    expect(hiddenPocketFinding({ seedLabel: "Artist Nova", destinations: destinations.slice(2, 3), medianPopularity: 0.5 })).toBeNull();
  });
});

describe("LATENT_DEMAND", () => {
  it("needs demand ≥ 0.7 and supply ≤ 0.3", () => {
    expect(isLatentDemand(0.7, 0.3)).toBe(true);
    expect(isLatentDemand(0.69, 0.3)).toBe(false);
    expect(isLatentDemand(0.7, 0.31)).toBe(false);
    expect(isLatentDemand(null, 0.1)).toBe(false);
  });

  it("orders by white space and suggests BLOCK on the top neighbourhood", () => {
    const d = fired(
      latentDemandFinding({
        metroLabel: "Austin",
        neighbourhoods: [
          { name: "Riverside", demandPct: 0.75, supplyPct: 0.3 },
          { name: "Hilltop", demandPct: 0.95, supplyPct: 0.05 },
          { name: "Old Mill", demandPct: 0.9, supplyPct: 0.8 },
        ],
      }),
    );
    expect(d.text).toBe(
      "Hilltop and Riverside in Austin show high demand for this concept and fewer similar venues than most areas in Qloo's venue sample (a sample, not every business): possible white space.",
    );
    expect(d.suggestion).toEqual({ tool: "block_dna", reason: "Profile the Block DNA of Hilltop to see what its venue-goers favour." });
  });

  it("is null when no neighbourhood qualifies", () => {
    expect(latentDemandFinding({ metroLabel: "Austin", neighbourhoods: [{ name: "Old Mill", demandPct: 0.9, supplyPct: 0.8 }] })).toBeNull();
  });
});

describe("BLOCK_NEW_TAGS", () => {
  /** Every name a taxonomy tag, with refs T1, T2, … in order. */
  const refs = (names: readonly string[]) => names.map((name, i) => ({ name, ref: `T${i + 1}` }));
  const what = (newTags: readonly string[], signalTags = refs(newTags), familyTags = 8) =>
    blockNewTagsFinding({ areaName: "Riverside", family: "WHAT", newTags, familyTags, signalTags });
  const sound = (newTags: readonly string[], familyTags: number, signalTags = refs(newTags)) =>
    blockNewTagsFinding({ areaName: "Riverside", family: "SOUND", newTags, familyTags, signalTags });
  const songs = (n: number) => Array.from({ length: n }, (_, i) => `Genre ${i + 1}`);

  it("fires at three distinct new WHAT tags, whatever share of the family they are", () => {
    const signal = [
      { name: "Natural Wine", ref: "T4" },
      { name: "Natural Wine", ref: "T4" },
      { name: "Vinyl Bar", ref: "T6" },
      { name: "Tapas", ref: "T7" },
      { name: "Omakase", ref: "T8" },
    ];
    const d = fired(what(["Natural Wine", "Omakase", "Vinyl Bar", "Tapas"], signal, 20));
    expect(d.text).toBe(
      "Among its top tags, Riverside has venue and dish tags that are not among the city's top tags, led by Natural Wine, Omakase, Vinyl Bar and 1 more.",
    );
    // Up to the three signal tags rank_candidates takes, so the follow-up can pick the ones that fit a tenant.
    expect(d.suggestion).toEqual({
      tool: "rank_candidates",
      reason: "Rank tenant brands with Natural Wine (T4), Vinyl Bar (T6) or Tapas (T7) as the taste signal at this site against the city.",
    });
    expect(fired(what(["Natural Wine", "Omakase", "Vinyl Bar"], [{ name: "Vinyl Bar", ref: "T6" }])).suggestion?.reason).toBe(
      "Rank tenant brands with Vinyl Bar (T6) as the taste signal at this site against the city.",
    );
    expect(what(["Natural Wine", "Omakase"])).toBeNull();
    expect(what(["Omakase", "Omakase", "Tapas"])).toBeNull();
  });

  it("reads a whole city against its panel, and follows up with concept_vector's open call, which needs no candidate refs", () => {
    const d = fired(
      blockNewTagsFinding({ areaName: "Riverton", family: "SOUND", newTags: songs(6), familyTags: 20, signalTags: refs(songs(2)), panel: "the other 12 map cities" }),
    );
    expect(d.text).toBe(
      "Among its top music tags, Riverton has music tags that are not among the top music tags of the other 12 map cities, led by Genre 1, Genre 2, Genre 3 and 3 more.",
    );
    expect(d.suggestion).toEqual({
      tool: "concept_vector",
      reason: "Name the artists Riverton's distinct taste points to: concept_vector on Genre 1 (T1), Genre 2 (T2), type artist, no analogs.",
    });
  });

  it("fires on SOUND at three new tags that are at least a quarter of its area top 20", () => {
    const d = fired(sound(songs(5), 20));
    expect(d.text).toBe(
      "Among its top music tags, Riverside has music tags that are not among the city's top music tags, led by Genre 1, Genre 2, Genre 3 and 2 more.",
    );
    expect(d.suggestion?.reason).toBe("Rank tenant brands with Genre 1 (T1), Genre 2 (T2) or Genre 3 (T3) as the taste signal at this site against the city.");
    expect(sound(songs(4), 20)).toBeNull();
    expect(sound(songs(3), 12)).not.toBeNull();
    expect(sound(songs(3), 13)).toBeNull();
    expect(sound(songs(2), 4)).toBeNull();
    expect(isBlockNewTags("SOUND", 5, 20)).toBe(true);
    expect(isBlockNewTags("SOUND", 4, 20)).toBe(false);
    expect(isBlockNewTags("WHAT", 3, 20)).toBe(true);
    expect(BLOCK_NEW_SOUND_MIN_SHARE).toBe(0.25);
  });

  it("rejects counts the family cannot hold", () => {
    expect(isBlockNewTags("WHAT", 4, 3)).toBe(false);
    expect(isBlockNewTags("SOUND", 3.5, 10)).toBe(false);
    expect(sound(songs(6), 5)).toBeNull();
  });

  it("suggests no ranking when no NEW tag can be a taste signal", () => {
    const d = fired(what(["Smash Burger", "Fried Pickles", "Brisket"], []));
    expect(d.suggestion).toBeNull();
    expect(d.severity).toBe("medium");
  });
});

describe("WEAK_CATEGORY_FIT", () => {
  const weak = (fitPct: number | null, scored: number, rank: number | null = 11) =>
    weakCategoryFitFinding({ categoryLabel: "Outdoor retail", bestName: GAMMA, fitPct, rank, scored });

  it("fires for a best fit in the bottom quarter of at least eight scored candidates", () => {
    expect(weak(0.25, 8)).not.toBeNull();
    expect(weak(0.26, 12)).toBeNull();
    expect(weak(0.1, 7)).toBeNull();
    expect(weak(null, 12)).toBeNull();
    expect(weak(0.1, 8.5)).toBeNull();
  });

  it("names the rank when known and suggests scoring brands the tag may miss on the slate's scale", () => {
    const d = fired(weak(0.09, 12));
    expect(d.text).toBe(
      "Brand Gamma, the best Outdoor retail fit, ranks 11 of 12 on the slate's one scale and sits in the bottom quarter of the slate: the brands carrying the category's tag fit this audience weakly.",
    );
    expect(d.suggestion?.tool).toBe("sponsor_slate");
    expect(d.suggestion?.reason).toContain("added to the shortlist");
    expect(fired(weak(0.09, 12, null)).text).toMatch(/^Brand Gamma, the best Outdoor retail fit, sits in the bottom quarter/);
  });
});

describe("EMPTY_RESULT, DROPPED_CANDIDATES and NO_TREND_SIGNAL", () => {
  it("passes the caller's suggestion through", () => {
    const d = emptyResultFinding({ what: "the concept heatmap for Austin", suggestion: null });
    expect(d).toEqual({
      kind: "EMPTY_RESULT",
      severity: "high",
      text: "The concept heatmap for Austin returned no usable results.",
      suggestion: null,
    });
    const broaden = { tool: "peer_landscape", reason: "Name three or more peers and set discover to false." } as const;
    expect(emptyResultFinding({ what: "Peer discovery for Brand Alpha", suggestion: broaden }).suggestion).toEqual(broaden);
  });

  it("tidies the noun phrase and reads a blank one as the call", () => {
    expect(emptyResultFinding({ what: "  Substitution Map   scoring ", suggestion: null }).text).toBe(
      "Substitution Map scoring returned no usable results.",
    );
    expect(emptyResultFinding({ what: "   ", suggestion: null }).text).toBe("The call returned no usable results.");
  });

  it("lists dropped candidates with agreement and skips blanks", () => {
    expect(droppedCandidatesFinding({ names: [], context: "the Austin metro context" })).toBeNull();
    expect(droppedCandidatesFinding({ names: ["  "], context: "the Austin metro context" })).toBeNull();
    expect(fired(droppedCandidatesFinding({ names: [BETA], context: "the Austin metro context" })).text).toBe(
      "Brand Beta was not scored in the Austin metro context, so it is shown as not scored there, not ranked last.",
    );
    expect(fired(droppedCandidatesFinding({ names: [BETA, GAMMA, BETA], context: "the Austin metro context" })).text).toMatch(
      /^Brand Beta and Brand Gamma were not scored .* they are shown/,
    );
  });

  it("is context without substitutes and a medium lead with the caller's substitution", () => {
    const plain = fired(droppedCandidatesFinding({ names: [BETA], context: "the one-scale scoring call" }));
    expect(plain).toMatchObject({ severity: "low", suggestion: null });
    const swap = { tool: "sponsor_slate", reason: "Score Brand Gamma from the Beer discovery results instead." } as const;
    const lead = fired(droppedCandidatesFinding({ names: [BETA], context: "the one-scale scoring call", suggestion: swap }));
    expect(lead).toMatchObject({ severity: "medium", suggestion: swap, text: plain.text });
  });

  it("says no signal is not flat", () => {
    expect(noTrendSignalFinding({ names: [] })).toBeNull();
    expect(fired(noTrendSignalFinding({ names: [GAMMA] })).text).toContain("Brand Gamma has no usable trend");
    const many = fired(noTrendSignalFinding({ names: [ALPHA, GAMMA] }));
    expect(many.text).toContain("Brand Alpha and Brand Gamma have no usable trend");
    expect(many.text).toContain("unknown, not flat");
    expect(many.suggestion).toBeNull();
  });
});

describe("POPULARITY_DOMINANCE", () => {
  const dominance = (results: readonly PopularityDominanceResult[], popularityMax: number | null = null) =>
    popularityDominanceFinding({ context: "the music results", results, popularityMax });
  const unknownPopularity = (count: number): PopularityDominanceResult[] =>
    Array.from({ length: count }, (_, i) => ({ fit: (i + 11) / 20, popularity: null }));

  it("computes ρ over the pairs where FIT and popularity are both known", () => {
    expect(fitPopularityRho(ranked(RHO_AT_EDGE)).rho).toBeCloseTo(0.8, 12);
    expect(fitPopularityRho(ranked(RHO_AT_EDGE)).pairs).toBe(9);
    expect(fitPopularityRho(ranked(RHO_BELOW_EDGE)).rho).toBeCloseTo(1 - (6 * 26) / 720, 12);
    expect(fitPopularityRho([...ranked([1, 2]), { fit: 0.5, popularity: null }, { fit: null, popularity: 0.5 }])).toEqual({
      rho: 1,
      pairs: 2,
    });
    expect(fitPopularityRho(ranked([1]))).toEqual({ rho: null, pairs: 1 });
    expect(fitPopularityRho(ranked([2, 2, 2])).rho).toBeNull();
  });

  it("fires on Spearman ≥ 0.8 over at least 8 known pairs", () => {
    expect(fired(dominance(ranked(RHO_AT_EDGE))).text).toBe(
      "In the music results, taste fit closely tracks popularity, so the ranking leans on mainstream names.",
    );
    expect(dominance(ranked(RHO_BELOW_EDGE))).toBeNull();
    expect(dominance(ranked([1, 2, 3, 4, 5, 6, 7, 8]))).not.toBeNull();
    expect(dominance(ranked([1, 2, 3, 4, 5, 6, 7]))).toBeNull();
  });

  it("does not count results with an unknown popularity towards the 8 pairs", () => {
    const sparse = [...ranked([8, 10]), ...unknownPopularity(6)];
    expect(fitPopularityRho(sparse)).toEqual({ rho: 1, pairs: 2 });
    expect(dominance(sparse)).toBeNull();
    expect(dominance([...ranked([1, 2, 3, 4, 5, 6, 7]), ...unknownPopularity(3)])).toBeNull();
  });

  it("fires when more than 70% of results sit above popularity 0.95, with no minimum count", () => {
    expect(fired(dominance(pops(6, 2))).text).toMatch(/^Most of the music results are among the most popular/);
    expect(dominance(pops(3, 0))).not.toBeNull();
    expect(dominance(pops(7, 3))).toBeNull();
    expect(dominance([0.95, 0.95, 0.95].map((popularity) => ({ fit: null, popularity })))).toBeNull();
    // Unknown popularities stay in the denominator: 5 of 8 is not "most".
    expect(dominance([...pops(5, 0), ...unknownPopularity(3)])).toBeNull();
    expect(dominance([])).toBeNull();
  });

  it("suggests a lower cap until the floor", () => {
    const tracking = ranked([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fired(dominance(tracking)).suggestion).toEqual({
      tool: "cross_domain",
      reason: "Re-run with popularity_max 0.85 to surface less mainstream picks.",
    });
    expect(fired(dominance(tracking, 0.85)).suggestion?.reason).toContain("popularity_max 0.75");
    expect(fired(dominance(tracking, 0.5)).suggestion).toBeNull();
  });

  it("steps the cap down by 0.1 to the 0.5 floor", () => {
    expect(suggestedPopularityCap(null)).toBe(0.85);
    expect(suggestedPopularityCap(1)).toBe(0.85);
    expect(suggestedPopularityCap(0.9)).toBe(0.85);
    expect(suggestedPopularityCap(0.85)).toBe(0.75);
    expect(suggestedPopularityCap(0.75)).toBe(0.65);
    expect(suggestedPopularityCap(0.55)).toBe(0.5);
    expect(suggestedPopularityCap(0.5)).toBeNull();
  });
});

describe("LOCATION_FALLBACK", () => {
  it("describes each step down the ladder with no follow-up", () => {
    expect(locationFallbackFinding({ areaName: "Riverside", from: "POLYGON", to: "POINT" })).toEqual({
      kind: "LOCATION_FALLBACK",
      severity: "low",
      text: "Location for Riverside fell back from the neighbourhood boundary to its centre point, a less precise reading of the area.",
      suggestion: null,
    });
    expect(locationFallbackFinding({ areaName: "Riverside", from: "POINT", to: "QUERY" }).text).toContain(
      "from its centre point to a place-name search",
    );
    expect(locationFallbackFinding({ areaName: "Riverside", from: "POLYGON", to: "QUERY" }).kind).toBe("LOCATION_FALLBACK");
  });

  it("throws on a step that does not go down", () => {
    expect(() => locationFallbackFinding({ areaName: "Riverside", from: "POINT", to: "POLYGON" })).toThrow(RangeError);
    expect(() => locationFallbackFinding({ areaName: "Riverside", from: "QUERY", to: "QUERY" })).toThrow(RangeError);
  });
});

describe("Part 9 finding rules", () => {
  it("names a twin only in the top quarter of the checked areas and at least a moderate resemblance", () => {
    const areas = [
      { id: "a", name: "Lakeview", rho: 0.72 },
      { id: "b", name: "Hillcrest", rho: 0.71 },
      { id: "f", name: "Northgate", rho: 0.3 },
      { id: "c", name: "Mill Town", rho: 0.1 },
      { id: "d", name: "Old Port", rho: 0.05 },
      { id: "e", name: "Bayside", rho: null },
    ];
    expect(twinsOf(areas).map((a) => a.id)).toEqual(["a", "b"]);
    // Fewer than three measured areas: no twin is called, however high ρ is.
    expect(twinsOf(areas.slice(0, 2))).toEqual([]);
    // The top area always clears its own set's p75; the floor stops a weak one being called a twin.
    expect(twinsOf([{ id: "a", name: "A", rho: TWIN_MIN_RHO - 0.01 }, { id: "b", name: "B", rho: 0 }, { id: "c", name: "C", rho: -0.2 }])).toEqual([]);
    const d = twinFoundFinding({ sourceName: "Riverside", targetCity: "Austin", areas });
    expect(d?.text).toContain("Of the 5 Austin areas checked");
    expect(d?.suggestion).toEqual({ tool: "block_dna", reason: "Profile the Block DNA of Lakeview to see what its venue-goers favour." });
  });

  it("puts ρ in plain words with the thresholds in one place", () => {
    expect(rhoWords(0.8)).toBe("strong resemblance");
    expect(rhoWords(0.4)).toBe("moderate resemblance");
    expect(rhoWords(0.15)).toBe("weak resemblance");
    expect(rhoWords(0.02)).toBe("about no resemblance");
    expect(rhoWords(-0.5)).toBe("opposite pattern");
  });

  it("vetoes only with a VETO and suggests ranking the concept's own picks", () => {
    expect(analogVetoedFinding({ conceptLabel: "x", vetoed: [], scored: 2, adds: [] })).toBeNull();
    const d = analogVetoedFinding({ conceptLabel: "hot sauce", vetoed: [BETA, GAMMA], scored: 4, adds: [] });
    expect(d?.text).toBe("Brand Beta and Brand Gamma score below the 50th result for hot sauce in the same Qloo call (2 of 4 scored analogs): the concept's taste points elsewhere.");
    expect(d?.suggestion).toBeNull();
  });

  it("splits taste and financials only on clear opposite moves, never as a cause", () => {
    expect(isTasteFinancialsSplit(-0.1, 0.05)).toBe(true);
    expect(isTasteFinancialsSplit(0.1, 0.05)).toBe(false);
    expect(isTasteFinancialsSplit(-0.01, 0.05)).toBe(false);
    expect(isTasteFinancialsSplit(-0.1, 0.01)).toBe(false);
    const d = tasteFinancialsSplitFinding({
      brandName: ALPHA,
      companyName: "Alpha Holdings",
      momentumDelta: 0.2,
      momentumWindow: "the 2025-04-01..2025-09-30 trending window",
      revenueYoy: -0.08,
      revenuePeriod: "the fiscal year ended 2025-06-30",
    });
    expect(d?.text).toContain("neither explains the other");
    expect(d?.text).not.toMatch(/\b(because|due to|drives|causes)\b/);
  });
});

describe("PARTNERS_ONE_CATEGORY", () => {
  const draftOf = (inCategory: number, scored: number, otherCategories: Parameters<typeof partnersOneCategoryFinding>[0]["otherCategories"] = ["telecom"]) =>
    partnersOneCategoryFinding({ subjectName: ALPHA, subjectRef: "R1", categoryLabel: "Food and beverage", inCategory, scored, otherCategories });

  it("fires when at least 60% of at least five scored partners share one category", () => {
    expect(isPartnersOneCategory(3, 5)).toBe(true);
    expect(isPartnersOneCategory(6, 10)).toBe(true);
    expect(isPartnersOneCategory(5, 10)).toBe(false);
    expect(isPartnersOneCategory(4, 4)).toBe(false);
    expect(isPartnersOneCategory(6, 5)).toBe(false);
  });

  it("suggests sponsor_slate seeded by the subject over the categories the partners do not cover, at most six", () => {
    const d = fired(draftOf(9, 12, ["beer", "spirits", "auto", "telecom", "fintech", "beauty", "gaming", "travel"]));
    expect(d.text).toBe(
      "Most partner brands this audience also favours sit in one category (Food and beverage, 9 of 12), with Brand Alpha's own category already left out: the list shows one category, not a range of partners.",
    );
    expect(d.suggestion).toEqual({
      tool: "sponsor_slate",
      reason:
        "Find the best-fitting partner in other categories: sponsor_slate with seed R1 (Brand Alpha) over beer, spirits, auto, telecom, fintech, beauty, sponsor categories none of the discovered partners sits in.",
    });
  });

  it("keeps the finding but suggests nothing when every sponsor category is covered", () => {
    expect(fired(draftOf(4, 5, [])).suggestion).toBeNull();
    expect(draftOf(2, 5)).toBeNull();
  });
});
