// The location equivalents on invented markets, comedians and areas (D29): GHOST market and area
// names, the panel percentile per market call, a comedian case's booked-market percentiles, and the
// ungated D18 Lift Map roll-up the neighbourhood cases are scored on.
import type { LocalityApi, QlooApi, QlooEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { areaCells, gridGeo } from "./reality-fixtures";
import {
  affinityById,
  areaLifts,
  baselineHeatParams,
  comedianCaseScore,
  loadSecondaryMarkets,
  REGISTERED_SECONDARY_MARKETS,
  matchArea,
  matchMarket,
  panelPercentiles,
  panelRankParams,
  scoreMarkets,
  seedHeatParams,
  type MarketCell,
  type SecondaryMarket,
} from "./reality-location";

const MARKETS: SecondaryMarket[] = [
  { id: "riverton", label: "Riverton", state: "WY", stateName: "Wyoming" },
  { id: "lakeside", label: "Lakeside", state: "OR", stateName: "Oregon" },
  { id: "fort_juniper", label: "Fort Juniper", state: "KS", stateName: "Kansas" },
  { id: "grand_marten", label: "Grand Marten", state: "MI", stateName: "Michigan" },
];

describe("loadSecondaryMarkets", () => {
  it("reads only the secondary tier of config/metros.json", () => {
    const markets = loadSecondaryMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.map((m) => m.id)).not.toContain("nashville");
    expect(markets.every((m) => m.label.length > 0 && /^[A-Z]{2}$/.test(m.state))).toBe(true);
  });

  it("keeps the 22 markets the cases were registered on, every one still a secondary market, and no later one", () => {
    expect(loadSecondaryMarkets().map((m) => m.id)).toEqual(REGISTERED_SECONDARY_MARKETS);
    expect(REGISTERED_SECONDARY_MARKETS).toHaveLength(22);
    expect(loadSecondaryMarkets().map((m) => m.id)).not.toContain("st_louis");
  });
});

describe("matchMarket", () => {
  it("matches a market by its name, with or without its state", () => {
    expect(matchMarket("Riverton", MARKETS)).toBe("riverton");
    expect(matchMarket("riverton, WY", MARKETS)).toBe("riverton");
    expect(matchMarket("Fort Juniper, Kansas", MARKETS)).toBe("fort_juniper");
    expect(matchMarket("Grand Marten MI", MARKETS)).toBe("grand_marten");
    expect(matchMarket("  Lakeside ", MARKETS)).toBe("lakeside");
  });

  it("rejects a namesake in another state, a market outside the secondary tier and an empty name", () => {
    expect(matchMarket("Riverton, ID", MARKETS)).toBeNull();
    expect(matchMarket("Lakeside Heights", MARKETS)).toBeNull();
    expect(matchMarket("Metro Prime", MARKETS)).toBeNull();
    expect(matchMarket(" , WY", MARKETS)).toBeNull();
  });
});

const person = (id: string, affinity?: number): QlooEntity => ({
  entity_id: id,
  name: id,
  ...(affinity === undefined ? {} : { query: { affinity } }),
});

describe("panelPercentiles", () => {
  const panel = ["vega", "lyra", "orion"];

  it("ranks the panel within the call, ties sharing the average rank and a floor tie counted as a score", () => {
    expect(Object.fromEntries(panelPercentiles(panel, affinityById([person("vega", 0.9), person("lyra", 0.5), person("orion", 0.1)])))).toEqual({
      vega: 1,
      lyra: 0.5,
      orion: 0,
    });
    // Two members at the same lowest value (a floor) share the bottom rather than being set aside.
    expect(Object.fromEntries(panelPercentiles(panel, affinityById([person("vega", 0.9), person("lyra", 0.2), person("orion", 0.2)])))).toEqual({
      vega: 1,
      lyra: 0.25,
      orion: 0.25,
    });
  });

  it("ranks a member Qloo left out, or returned without an affinity, below every member it scored", () => {
    // Lyra has no affinity and Orion is missing: both share the bottom; a stranger to the panel is ignored.
    expect(Object.fromEntries(panelPercentiles(panel, affinityById([person("vega", 0.9), person("lyra"), person("stranger", 0.99)])))).toEqual({
      vega: 1,
      lyra: 0.25,
      orion: 0.25,
    });
    expect(Object.fromEntries(panelPercentiles(panel, affinityById([person("vega", 0.3), person("orion", 0.6)])))).toEqual({ vega: 0.5, orion: 1, lyra: 0 });
  });

  it("scores no one when the call scored no member, or the panel is under two", () => {
    expect(Object.fromEntries(panelPercentiles(panel, affinityById([person("stranger", 0.5), person("lyra")])))).toEqual({});
    expect(Object.fromEntries(panelPercentiles(["vega"], affinityById([person("vega", 0.9)])))).toEqual({});
  });
});

describe("scoreMarkets", () => {
  // No market here is called: a call would fail on this empty client and show as call_failed for Riverton.
  const unused = {} as QlooApi;

  it("leaves a market without a pinned locality uncalled, and takes a failed lookup for a failed call, not a missing pin", async () => {
    const localities: LocalityApi = {
      market: async (id) => {
        if (id === "lakeside") throw new Error("the database is unreachable");
        return null;
      },
    };
    const cells = await scoreMarkets(unused, localities, MARKETS.slice(0, 2), ["vega", "lyra"]);
    expect(cells.map((c) => [c.market.id, c.gap])).toEqual([
      ["riverton", "no_locality"],
      ["lakeside", "call_failed"],
    ]);
    expect(cells[1]?.error).toBe("the locality lookup failed: the database is unreachable");
  });
});

describe("the request shapes", () => {
  it("rank the panel in one market per call, and map the seed alone against the pinned baseline", () => {
    expect(panelRankParams("loc-riverton", ["vega", "lyra"])).toEqual({
      "signal.location": "loc-riverton",
      "filter.results.entities": ["vega", "lyra"],
      take: 2,
    });
    expect(seedHeatParams("loc-metro", "brand-delta")).toEqual({ "filter.location": "loc-metro", "signal.interests.entities": ["brand-delta"] });
    expect(baselineHeatParams("loc-metro")).toEqual({ "filter.location": "loc-metro", "signal.interests.tags": ["urn:tag:genre:place:restaurant"] });
  });
});

function cell(market: SecondaryMarket, pct: Record<string, number>, gap: MarketCell["gap"] = null): MarketCell {
  return { market, gap, error: null, pct: new Map(Object.entries(pct)), affinity: new Map() };
}

describe("comedianCaseScore", () => {
  const [riverton, lakeside, fortJuniper, grandMarten] = MARKETS as [SecondaryMarket, SecondaryMarket, SecondaryMarket, SecondaryMarket];

  it("takes each booked market's percentile among the unbooked ones, then the median", () => {
    const cells = [cell(riverton, { vega: 1 }), cell(lakeside, { vega: 0.5 }), cell(fortJuniper, { vega: 0.5 }), cell(grandMarten, { vega: 0 })];
    const score = comedianCaseScore("vega", ["riverton", "lakeside"], cells);
    // Riverton beats both unbooked markets; Lakeside ties one and beats the other.
    expect(score.booked).toEqual([
      { market: "riverton", percentile: 1 },
      { market: "lakeside", percentile: 0.75 },
    ]);
    expect(score.percentile).toBe(0.875);
    expect(score.distractors).toBe(2);
    expect(score.scored).toBe(4);
    // Four booked-versus-unbooked comparisons; Lakeside against Fort Juniper is the one tie.
    expect(score).toMatchObject({ comparisons: 4, ties: 1 });
  });

  it("counts every comparison as tied when the seed holds one place in every scored market", () => {
    const cells = [cell(riverton, { vega: 1 }), cell(lakeside, { vega: 1 }), cell(fortJuniper, { vega: 1 })];
    expect(comedianCaseScore("vega", ["riverton"], cells)).toMatchObject({ percentile: 0.5, comparisons: 2, ties: 2 });
  });

  it("leaves a booked market the seed has no score in out of the median, and an unscored market out of the distractors", () => {
    const cells = [cell(riverton, {}, "no_locality"), cell(lakeside, { vega: 1 }), cell(fortJuniper, { vega: 0 }), cell(grandMarten, {}, "budget")];
    const score = comedianCaseScore("vega", ["riverton", "lakeside"], cells);
    expect(score.booked).toEqual([
      { market: "riverton", percentile: null },
      { market: "lakeside", percentile: 1 },
    ]);
    expect(score.percentile).toBe(1);
    expect(score.distractors).toBe(1);
    expect(score).toMatchObject({ comparisons: 1, ties: 0 });
  });

  it("has no score with no distractor scored or no booked market scored", () => {
    const cells = [cell(riverton, { vega: 1 }), cell(lakeside, {})];
    expect(comedianCaseScore("vega", ["riverton"], cells).percentile).toBeNull();
    expect(comedianCaseScore("lyra", ["riverton"], [cell(riverton, {}), cell(lakeside, { lyra: 1 })]).percentile).toBeNull();
  });
});

const AREAS = [
  { id: "old_mill", name: "Old Mill" },
  { id: "juniper_row", name: "Juniper Row" },
  { id: "kestrel_park", name: "Kestrel Park" },
  { id: "linden_cross", name: "Linden Cross" },
  { id: "pine_hollow", name: "Pine Hollow" },
  { id: "marten_bluff", name: "Marten Bluff" },
  { id: "nettle_green", name: "Nettle Green" },
  { id: "osprey_flats", name: "Osprey Flats" },
];

describe("matchArea", () => {
  const geo = gridGeo("austin", AREAS);
  const choice = { name: "Mill District", metro: "austin" as const, area_id: "old_mill" };

  it("resolves the registered choice's own name to its registered area, any other name through the gazetteer", () => {
    expect(matchArea(geo, choice, "mill district")).toBe("old_mill");
    expect(matchArea(geo, choice, "Juniper Row")).toBe("juniper_row");
    expect(matchArea(geo, choice, "Unknown Quarter")).toBeNull();
    expect(matchArea(geo, choice, "")).toBeNull();
  });
});

describe("areaLifts", () => {
  const geo = gridGeo("austin", AREAS);
  // Concept and baseline affinity per area, six cells each; the baseline cells carry popularity.
  const values: [number, number, number][] = [
    [0.9, 0.2, 0.5],
    [0.8, 0.8, 0.7],
    [0.7, 0.5, 0.52],
    [0.6, 0.9, 0.47],
    [0.3, 0.3, 0.45],
    [0.2, 0.4, 0.56],
    [0.1, 0.6, 0.4],
    [0.05, 0.7, 0.9],
  ];
  const concept = values.flatMap(([c], i) => areaCells(i, 6, c));
  const baseline = values.flatMap(([, b, p], i) => areaCells(i, 6, b, p));

  // 48 shared cells, six per area tied: an area at concept rank block k (0-based) has u = 1 − (6k + 2.5)/47.
  const pctAt = (block: number) => 1 - (6 * block + 2.5) / 47;
  const lift = (uBlock: number, vBlock: number) => (pctAt(uBlock) + 0.05) / (pctAt(vBlock) + 0.05);

  it("gives every area both maps cover a lift over the baseline, ungated, so weak taste scores low rather than none", () => {
    const rows = areaLifts(geo, "austin", concept, baseline);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.old_mill?.lift).toBeCloseTo(lift(0, 7), 10);
    expect(byId.juniper_row?.lift).toBeCloseTo(lift(1, 1), 10);
    expect(byId.kestrel_park?.lift).toBeCloseTo(lift(2, 4), 10);
    expect(byId.linden_cross?.lift).toBeCloseTo(lift(3, 0), 10);
    // The bottom half of the concept map, which D18's u ≥ 0.5 gate would leave without a lift.
    expect(byId.pine_hollow?.lift).toBeCloseTo(lift(4, 6), 10);
    expect(byId.marten_bluff?.lift).toBeCloseTo(lift(5, 5), 10);
    expect(byId.nettle_green?.lift).toBeCloseTo(lift(6, 3), 10);
    expect(byId.osprey_flats?.lift).toBeCloseTo(lift(7, 2), 10);
    expect(byId.osprey_flats?.lift).toBeLessThan(byId.old_mill?.lift ?? 0);
    expect(rows.every((r) => r.n === 6)).toBe(true);
  });

  it("reads each area's popularity from the baseline map", () => {
    const rows = areaLifts(geo, "austin", concept, baseline);
    rows.forEach((r, i) => expect(r.popularity).toBeCloseTo(values[i]?.[2] ?? Number.NaN, 12));
  });

  it("needs five cells both maps cover, both maps, and a precision finer than geohash 4", () => {
    const thin = values.flatMap(([c], i) => areaCells(i, i === 0 ? 4 : 6, c));
    expect(areaLifts(geo, "austin", thin, baseline).find((r) => r.id === "old_mill")).toMatchObject({ n: 4, lift: null });
    expect(areaLifts(geo, "austin", concept, []).every((r) => r.lift === null && r.popularity === null)).toBe(true);
    const coarse = concept.map((c) => ({ ...c, location: { ...c.location, geohash: c.location.geohash.slice(0, 4) } }));
    expect(areaLifts(geo, "austin", coarse, baseline).every((r) => r.lift === null)).toBe(true);
  });

  it("excludes zero-affinity and malformed cells", () => {
    const zeroed = concept.map((c, i) => (i < 6 ? { ...c, query: { affinity: 0 } } : i < 8 ? { ...c, location: { ...c.location, geohash: "not a hash" } } : c));
    const rows = areaLifts(geo, "austin", zeroed, baseline);
    expect(rows.find((r) => r.id === "old_mill")).toMatchObject({ n: 0, lift: null });
    expect(rows.find((r) => r.id === "juniper_row")?.n).toBe(4);
  });
});
