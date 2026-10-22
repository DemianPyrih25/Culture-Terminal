import { FindingKind, FindingSuggestion, Severity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  FINDING_SEVERITY,
  FINDING_SUGGESTION,
  blockNewTagsFinding,
  droppedCandidatesFinding,
  emptyResultFinding,
  fitPopularityRho,
  generationalSplitFinding,
  hiddenPocketFinding,
  isHiddenPocket,
  isLatentDemand,
  isOutsideCategoryNeighbour,
  latentDemandFinding,
  locationFallbackFinding,
  metroOutlierFinding,
  nearSubstitutesFinding,
  noTrendSignalFinding,
  outsideCategoryNeighbourFinding,
  popularityDominanceFinding,
  suggestedPopularityCap,
  tasteIslandFinding,
  type FindingDraft,
  type PopularityDominanceResult,
} from "../src/findings";

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
    fired(generationalSplitFinding({ targetName: ALPHA, targetTilt: 0.5, setMedianTilt: 0 })),
    fired(
      metroOutlierFinding({
        targetName: ALPHA,
        marketLabel: "Nashville",
        metroRank: 1,
        medianRank: 4,
        setSize: 6,
        gazetteerMetro: "nashville",
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
    fired(blockNewTagsFinding({ areaName: "Riverside", newWhatTags: ["Natural Wine", "Omakase", "Vinyl Bar"] })),
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
  ];
}

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
      METRO_OUTLIER: "geo_lift",
      LATENT_DEMAND: "block_dna",
      BLOCK_NEW_TAGS: "rank_candidates",
      POPULARITY_DOMINANCE: "cross_domain",
      EMPTY_RESULT: null,
      GENERATIONAL_SPLIT: null,
      HIDDEN_POCKET: null,
      DROPPED_CANDIDATES: null,
      NO_TREND_SIGNAL: null,
      LOCATION_FALLBACK: null,
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
      // EMPTY_RESULT has no fixed tool; it carries the caller's.
      if (FINDING_SUGGESTION[kind] !== null) expect(d.suggestion.tool).toBe(FINDING_SUGGESTION[kind]);
    } else {
      expect(["GENERATIONAL_SPLIT", "HIDDEN_POCKET", "DROPPED_CANDIDATES", "NO_TREND_SIGNAL", "LOCATION_FALLBACK"]).toContain(kind);
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
  const split = (targetTilt: number | null, setMedianTilt: number | null) =>
    generationalSplitFinding({ targetName: ALPHA, targetTilt, setMedianTilt });

  it("fires when the target's tilt is 0.4 above the set median, absorbing float error at the edge", () => {
    expect(split(0.7, 0.3)).not.toBeNull();
    expect(split(0.69, 0.3)).toBeNull();
    expect(split(0.1, -0.3)).not.toBeNull();
  });

  it("is one-sided: a target skewing older is not a finding", () => {
    expect(split(-0.3, 0.2)).toBeNull();
    expect(split(-0.9, 0.9)).toBeNull();
  });

  it("says the target skews younger, with no follow-up", () => {
    const d = fired(split(0.5, 0));
    expect(d.text).toBe("Brand Alpha skews clearly younger than its peer set: its youth tilt sits well above the set median.");
    expect(d.suggestion).toBeNull();
  });

  it("needs both tilts", () => {
    expect(split(null, 0)).toBeNull();
    expect(split(0.9, Number.NaN)).toBeNull();
  });
});

describe("METRO_OUTLIER", () => {
  const outlier = (metroRank: number, medianRank: number, gazetteerMetro: "austin" | null = "austin") =>
    metroOutlierFinding({ targetName: ALPHA, marketLabel: "Austin", metroRank, medianRank, setSize: 6, gazetteerMetro });

  it("fires at two places from the median rank, either way", () => {
    expect(fired(outlier(1, 3)).text).toBe("Brand Alpha ranks 1 of 6 in Austin, clearly better than its median rank across metros.");
    expect(fired(outlier(5, 3)).text).toContain("clearly worse");
    expect(outlier(1, 3.5)).not.toBeNull();
    expect(outlier(2, 3)).toBeNull();
    expect(outlier(2, 3.5)).toBeNull();
  });

  it("suggests geo_lift only in a gazetteer metro", () => {
    const inGazetteer = fired(outlier(1, 3));
    expect(inGazetteer.severity).toBe("medium");
    expect(inGazetteer.suggestion?.tool).toBe("geo_lift");
    expect(inGazetteer.suggestion?.reason).toContain("inside Austin");
    const outside = fired(outlier(1, 3, null));
    expect(outside.severity).toBe("low");
    expect(outside.suggestion).toBeNull();
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
      "Hilltop and Riverside in Austin show high demand for this concept with low venue supply: latent, open white space.",
    );
    expect(d.suggestion).toEqual({ tool: "block_dna", reason: "Profile the Block DNA of Hilltop to see what its venue-goers favour." });
  });

  it("is null when no neighbourhood qualifies", () => {
    expect(latentDemandFinding({ metroLabel: "Austin", neighbourhoods: [{ name: "Old Mill", demandPct: 0.9, supplyPct: 0.8 }] })).toBeNull();
  });
});

describe("BLOCK_NEW_TAGS", () => {
  it("fires at three distinct new WHAT tags", () => {
    const d = fired(blockNewTagsFinding({ areaName: "Riverside", newWhatTags: ["Natural Wine", "Omakase", "Vinyl Bar", "Tapas"] }));
    expect(d.text).toBe(
      "Among its top tags, Riverside has WHAT tags that are not among the city's top tags, led by Natural Wine, Omakase, Vinyl Bar and 1 more.",
    );
    expect(d.suggestion).toEqual({
      tool: "rank_candidates",
      reason: "Rank tenant brands carrying Natural Wine or Omakase at this site against the city.",
    });
    expect(blockNewTagsFinding({ areaName: "Riverside", newWhatTags: ["Natural Wine", "Omakase"] })).toBeNull();
    expect(blockNewTagsFinding({ areaName: "Riverside", newWhatTags: ["Omakase", "Omakase", "Tapas"] })).toBeNull();
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
      text: "Location for Riverside fell back from the neighbourhood boundary to its centre point (a CODE FALLBACK).",
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
