import { GHOST_HONESTY_LINE, GhostDiff, type DatasetEnvelope, type EntityRef } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { buildGhostDiff, GHOST_OVERLAP_K } from "../../src/ghost/diff";
import { resolveGhostPicks, type ResolvedGhostPick } from "../../src/ghost/resolve";
import { createEntityRegistry } from "../../src/registry";
import {
  answer,
  blockBars,
  crossDomain,
  entity,
  entityIdOf,
  FAKE_GEO,
  FAKE_MARKETS,
  FakeSearch,
  liftMap,
  localBrands,
  positionCard,
  registryOf,
  report,
  shareGrid,
  siteRanked,
  slate,
  subsMap,
  tenantSlope,
  travelQuadrant,
} from "./support";

type Item = GhostDiff["items"][number];
const rows = (items: readonly Item[]) => items.map((i) => [i.category, i.status, i.name, i.resolvesInQloo]);

// A sponsorship brief: the slate, then a cultural neighbourhood with two more brands.
const SPONSORS = registryOf([
  ["Artist Nova", 0.7],
  ["Harrow Pale Lager", 0.31],
  ["Mesa Line Trucks", 0.5],
  ["Voltline Energy", 0.85],
  ["Granite Peak Light", 0.9],
  ["Summit Rush Cola", 0.8],
  ["Lantern & Loom", 0.2],
  ["Ridgeway Outdoor", 0.4],
]);

function sponsorshipDatasets(): DatasetEnvelope[] {
  const r = SPONSORS.ref;
  return [
    slate("D2", [r("Artist Nova"), "Artist Nova"], [
      { category: "beer", best: [r("Harrow Pale Lager"), "Harrow Pale Lager", 0.95, 0.31], runnerUp: [r("Granite Peak Light"), "Granite Peak Light", 0.6, 0.9] },
      { category: "energy_drinks", best: [r("Voltline Energy"), "Voltline Energy", 0.88, 0.85], runnerUp: [r("Summit Rush Cola"), "Summit Rush Cola", 0.4, 0.8] },
      { category: "auto", best: [r("Mesa Line Trucks"), "Mesa Line Trucks", 0.91, 0.5], runnerUp: null },
    ]),
    crossDomain("D3", [
      [r("Lantern & Loom"), "Lantern & Loom", 0.2],
      [r("Ridgeway Outdoor"), "Ridgeway Outdoor", 0.4],
      [r("Harrow Pale Lager"), "Harrow Pale Lager", 0.31],
    ]),
  ];
}

async function sponsorshipDiff(partners: string[], claims: string[] = []) {
  const search = new FakeSearch(
    {
      "Voltline Energy": [entity(entityIdOf("Voltline Energy"), "Voltline Energy")],
      "Ridgeway Outdoor": [entity(entityIdOf("Ridgeway Outdoor"), "Ridgeway Outdoor")],
      "Cinder Hollow Rye": [entity("ent-cinder-hollow-rye", "Cinder Hollow Rye", "urn:entity:brand", { popularity: 0.2 })],
    },
    new Set(["Old Mill Root Beer"]),
  );
  const ghost = answer({ partners }, claims, "Voltline Energy is the natural sponsor.");
  const resolved = await resolveGhostPicks({ answer: ghost, search: search.search, registry: SPONSORS.registry, geo: FAKE_GEO });
  const datasets = sponsorshipDatasets();
  return buildGhostDiff({ answer: ghost, resolved, report: report("sponsorship", datasets), datasets, registry: SPONSORS.registry, geo: FAKE_GEO });
}

describe("buildGhostDiff: statuses and header", () => {
  it("marks both, found only by Qloo, and LLM only with whether it resolves", async () => {
    const diff = await sponsorshipDiff(
      ["Voltline Energy", "Bluebonnet Boot Co.", "Mesa-Line Trucks", "Cinder Hollow Rye", "Old Mill Root Beer"],
      ["about 70%", "1.5 million"],
    );
    expect(rows(diff.items)).toEqual([
      // The brief's side in its order: bests by FIT, runners-up by FIT, then the cultural neighbourhood.
      ["partners", "qloo_only", "Harrow Pale Lager", null],
      ["partners", "both", "Mesa Line Trucks", null], // matched by name: Qloo's spelling is kept
      ["partners", "both", "Voltline Energy", null], // matched by ref
      ["partners", "qloo_only", "Granite Peak Light", null],
      ["partners", "qloo_only", "Summit Rush Cola", null],
      ["partners", "qloo_only", "Lantern & Loom", null],
      ["partners", "qloo_only", "Ridgeway Outdoor", null],
      // GHOST's own names in its order.
      ["partners", "llm_only", "Bluebonnet Boot Co.", false],
      ["partners", "llm_only", "Cinder Hollow Rye", true],
      ["partners", "llm_only", "Old Mill Root Beer", null], // its search failed: never checked
    ]);
    expect(diff.items.find((i) => i.name === "Voltline Energy")?.ref).toBe(SPONSORS.ref("Voltline Energy"));
    expect(diff.items.find((i) => i.name === "Cinder Hollow Rye")?.ref).toBeNull();

    // Voltline (GHOST 1, Qloo 3) and Mesa (GHOST 3, Qloo 2) are in both top fives.
    expect(diff.overlapAt5).toBeCloseTo(2 / GHOST_OVERLAP_K, 12);
    // Checked: Voltline, Bluebonnet, Mesa, Cinder; resolving: Voltline, Mesa, Cinder.
    expect(diff.resolvability).toBeCloseTo(3 / 4, 12);
    expect(diff.unsourcedNumericClaims).toBe(2);
    // GHOST: the payload's popularity for the two matches, the search's for Cinder.
    expect(diff.meanPopularity.ghost).toBeCloseTo((0.85 + 0.5 + 0.2) / 3, 12);
    // Qloo: its top five.
    expect(diff.meanPopularity.qloo).toBeCloseTo((0.31 + 0.5 + 0.85 + 0.9 + 0.8) / 5, 12);
    expect(diff.honestyLine).toBe(GHOST_HONESTY_LINE);
    expect(GhostDiff.parse(diff)).toEqual(diff);
  });

  it("counts a match outside either top five as both, but not towards overlap@5", async () => {
    const diff = await sponsorshipDiff(["Ridgeway Outdoor"]);
    expect(diff.items.find((i) => i.name === "Ridgeway Outdoor")?.status).toBe("both");
    expect(diff.overlapAt5).toBe(0);
    expect(diff.resolvability).toBe(1);
  });

  it("averages overlap@5 over the categories with both sides only", async () => {
    const { registry, ref } = registryOf([["Brand Alpha", 0.5], ["Brand Beta", 0.6], ["Brand Gamma", 0.3]]);
    const datasets = [
      subsMap("D1", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta", 0.8], [ref("Brand Gamma"), "Brand Gamma", 0.6]]),
      shareGrid("D2", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta"]], [["harbor_city", "Harbor City", 0.9], ["nashville", "Nashville", 0.4]]),
    ];
    const ghost = answer({ competitors: ["Brand Beta", "Brand Zeta"], markets: ["Nashville, TN", "Riverton, QB"] });
    const resolved = await resolveGhostPicks({ answer: ghost, search: new FakeSearch().search, registry, geo: FAKE_GEO, markets: FAKE_MARKETS });
    const diff = buildGhostDiff({ answer: ghost, resolved, report: report("head_to_head", datasets), datasets, registry, geo: FAKE_GEO });
    // competitors 1 of 5, markets 1 of 5 (Nashville by market id).
    expect(diff.overlapAt5).toBeCloseTo(1 / 5, 12);
    expect(rows(diff.items.filter((i) => i.category === "markets"))).toEqual([
      ["markets", "qloo_only", "Harbor City", null],
      ["markets", "both", "Nashville", null],
      ["markets", "llm_only", "Riverton, QB", true], // a catalogue market, ranked by no share grid
    ]);
  });
});

describe("buildGhostDiff: matching by ref, then by name", () => {
  const registry = createEntityRegistry();
  const alpha = registry.registerEntity({ entityId: "ent-alpha", name: "Brand Alpha", type: "brand", popularity: 0.5, disambiguation: null, tags: [] }).ref;
  const beta = registry.registerEntity({ entityId: "ent-beta-1", name: "Brand Beta", type: "brand", popularity: 0.6, disambiguation: null, tags: [] }).ref;
  const otherBeta = registry.registerEntity({ entityId: "ent-beta-2", name: "Brand Beta", type: "brand", popularity: 0.1, disambiguation: null, tags: [] }).ref;
  const datasets = [subsMap("D1", [alpha, "Brand Alpha"], [[beta, "Brand Beta", 0.8]])];

  const pick = (name: string, extra: Partial<ResolvedGhostPick>): ResolvedGhostPick => ({
    name,
    category: "competitors",
    rank: 1,
    ref: null,
    entityId: null,
    market: null,
    area: null,
    matchedName: null,
    popularity: null,
    exact: true,
    lookup: "search",
    ...extra,
  });
  const diffFor = (name: string, resolved: ResolvedGhostPick) =>
    buildGhostDiff({ answer: answer({ competitors: [name] }), resolved: [resolved], report: report("brand_health", datasets), datasets, registry, geo: FAKE_GEO });

  it("never matches two different entities by their shared name", () => {
    const diff = diffFor("Brand Beta", pick("Brand Beta", { ref: otherBeta, entityId: "ent-beta-2", matchedName: "Brand Beta" }));
    expect(rows(diff.items)).toEqual([
      ["competitors", "qloo_only", "Brand Beta", null],
      ["competitors", "llm_only", "Brand Beta", true],
    ]);
    expect(diff.items[1]?.ref).toBe(otherBeta);
  });

  it("matches the same entity under another name, through the registry when the pick has no ref", () => {
    const diff = diffFor("Beta Original", pick("Beta Original", { entityId: "ent-beta-1", matchedName: "Beta Original" }));
    expect(rows(diff.items)).toEqual([["competitors", "both", "Brand Beta", null]]);
    expect(diff.items[0]?.ref).toBe(beta);
  });

  it("falls back to the normalised name when the pick did not resolve", () => {
    const diff = diffFor("The Brand Beta Co.", pick("The Brand Beta Co.", { exact: false }));
    expect(rows(diff.items)).toEqual([["competitors", "both", "Brand Beta", null]]);
    expect(diff.resolvability).toBe(1); // a pick the brief names is in Qloo
  });
});

describe("buildGhostDiff: empty sides", () => {
  const { registry, ref } = registryOf([["Brand Alpha", 0.5], ["Brand Beta", 0.6]]);
  const datasets = [subsMap("D1", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta", 0.8]])];

  it("lists only the brief's names when GHOST named none", () => {
    const diff = buildGhostDiff({ answer: answer(), resolved: [], report: report("brand_health", datasets), datasets, registry, geo: FAKE_GEO });
    expect(rows(diff.items)).toEqual([["competitors", "qloo_only", "Brand Beta", null]]);
    expect(diff.overlapAt5).toBeNull();
    expect(diff.resolvability).toBeNull();
    expect(diff.meanPopularity).toEqual({ ghost: null, qloo: 0.6 });
    expect(diff.unsourcedNumericClaims).toBe(0);
  });

  it("compares only the job's lists: a list GHOST fills outside them is LLM only", () => {
    const withLift = [...datasets, liftMap("D2", "nashville", [["lantern_row", "Lantern Row", 1.4]])];
    const ghost = answer({ neighbourhoods: ["Lantern Row"] });
    const resolved: ResolvedGhostPick[] = [
      { name: "Lantern Row", category: "neighbourhoods", rank: 1, ref: null, entityId: null, market: null, area: { metro: "nashville", id: "lantern_row" }, matchedName: "Lantern Row", popularity: null, exact: true, lookup: "gazetteer" },
    ];
    const diff = buildGhostDiff({ answer: ghost, resolved, report: report("brand_health", withLift), datasets: withLift, registry, geo: FAKE_GEO });
    expect(rows(diff.items)).toEqual([
      ["competitors", "qloo_only", "Brand Beta", null],
      ["neighbourhoods", "llm_only", "Lantern Row", true],
    ]);
    expect(diff.overlapAt5).toBeNull();
  });

  it("stays a valid diff for a brief with no Qloo data", () => {
    const ghost = answer({ competitors: ["Brand Beta", "Brand Zeta"] }, ["12%"]);
    const diff = buildGhostDiff({ answer: ghost, resolved: [], report: report("brand_health", []), datasets: [], geo: FAKE_GEO });
    expect(diff).toEqual({
      items: [
        { name: "Brand Beta", category: "competitors", status: "llm_only", resolvesInQloo: null, ref: null },
        { name: "Brand Zeta", category: "competitors", status: "llm_only", resolvesInQloo: null, ref: null },
      ],
      overlapAt5: null,
      resolvability: null,
      unsourcedNumericClaims: 1,
      meanPopularity: { ghost: null, qloo: null },
      honestyLine: GHOST_HONESTY_LINE,
    });
    expect(GhostDiff.parse(diff)).toEqual(diff);
  });
});

describe("the Qloo side: what the brief ranks per category", () => {
  const { registry, ref } = registryOf([
    ["Brand Alpha", 0.5],
    ["Brand Beta", 0.6],
    ["Brand Gamma", 0.3],
    ["Brand Delta", 0.2],
    ["Brand Eta", null],
    ["Tenant One", 0.1],
    ["Tenant Two", 0.15],
    ["Tenant Three", 0.25],
    ["Dest Port Ember", 0.45],
  ]);
  const qlooNames = (job: Parameters<typeof report>[0], datasets: DatasetEnvelope[], exhibits = datasets) =>
    buildGhostDiff({ answer: answer(), resolved: [], report: report(job, exhibits), datasets, registry, geo: FAKE_GEO }).items.map((i) => i.name);

  it("competitors: the target's row by similarity, unscored peers and the target left out, maps in exhibit order", () => {
    const first = subsMap("D1", [ref("Brand Alpha"), "Brand Alpha"], [
      [ref("Brand Gamma"), "Brand Gamma", 0.4],
      [ref("Brand Beta"), "Brand Beta", 0.9],
      [ref("Brand Eta"), "Brand Eta", null],
    ]);
    const second = subsMap("D2", [ref("Brand Beta"), "Brand Beta"], [[ref("Brand Delta"), "Brand Delta", 0.7], [ref("Brand Alpha"), "Brand Alpha", 0.6]]);
    // The second map ranks the brief's subject too; it is never one of its own competitors.
    expect(qlooNames("brand_health", [first, second])).toEqual(["Brand Beta", "Brand Gamma", "Brand Delta"]);
  });

  it("takes the brief's subject from the Taste Position card when a pivot map comes first", () => {
    const pivot = subsMap("D2", [ref("Brand Delta"), "Brand Delta"], [[ref("Brand Alpha"), "Brand Alpha", 0.8], [ref("Brand Gamma"), "Brand Gamma", 0.5]]);
    const primary = subsMap("D3", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Delta"), "Brand Delta", 0.7]]);
    expect(qlooNames("brand_health", [positionCard("D1", [ref("Brand Alpha"), "Brand Alpha"]), pivot, primary])).toEqual(["Brand Gamma", "Brand Delta"]);
  });

  it("markets: the subject's percentile per share-grid market; travel taste only when no grid ranks one", () => {
    const grid = shareGrid("D1", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta"]], [
      ["nashville", "Nashville", 0.3],
      ["harbor_city", "Harbor City", 0.8],
      ["riverton_q", "Riverton", null],
    ]);
    const travel = travelQuadrant("D2", [["Mill Bay", null, 0.3, 0.4], ["Port Ember", ref("Dest Port Ember"), 0.45, 0.9]]);
    expect(qlooNames("market_selection", [grid, travel])).toEqual(["Harbor City", "Nashville"]);
    expect(qlooNames("market_selection", [travel])).toEqual(["Port Ember", "Mill Bay"]);
  });

  it("neighbourhoods: lift order, none from a coarse map, then the Block DNA area", () => {
    const lift = liftMap("D1", "nashville", [["mill_quarter", "Mill Quarter", 1.1], ["lantern_row", "Lantern Row", 1.6], ["old_town_n", "Old Town", null]]);
    expect(qlooNames("site_selection", [lift, blockBars("D2", "old_town_n", "Old Town"), blockBars("D3", "lantern_row", "Lantern Row")])).toEqual([
      "Lantern Row",
      "Mill Quarter",
      "Old Town",
    ]);
    expect(qlooNames("site_selection", [liftMap("D4", "nashville", [["lantern_row", "Lantern Row", 1.6]], true), blockBars("D5", "point", "Lantern Row (point)")])).toEqual([]);
  });

  it("tenants: tenant fit by score, then a site ranking, then local brands", () => {
    const fit = tenantSlope("D1", [[ref("Tenant One"), "Tenant One", 40], [ref("Tenant Two"), "Tenant Two", 75], [ref("Brand Eta"), "Brand Eta", null]]);
    const site = siteRanked("D2", [[ref("Tenant Three"), "Tenant Three"], [ref("Tenant One"), "Tenant One"]]);
    const local = localBrands("D3", [[ref("Brand Delta"), "Brand Delta", 0.2], [null, "Corner Kiln", 0.05]]);
    expect(qlooNames("tenant_mix", [local, site, fit])).toEqual(["Tenant Two", "Tenant One", "Tenant Three", "Brand Delta", "Corner Kiln"]);
  });

  it("reads only the datasets the report shows, and lists at most ten names", () => {
    const peers = Array.from({ length: 12 }, (_, i): [EntityRef, string, number] => [`R${20 + i}`, `Peer ${i + 1}`, 0.9 - i / 100]);
    const wide = subsMap("D1", [ref("Brand Alpha"), "Brand Alpha"], peers);
    const hidden = subsMap("D2", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta", 0.99]]);
    const names = qlooNames("brand_health", [wide, hidden], [wide]);
    expect(names).toEqual(Array.from({ length: 10 }, (_, i) => `Peer ${i + 1}`));
  });

  it("takes popularity from the payload, else the registry", () => {
    const fit = tenantSlope("D1", [[ref("Tenant Two"), "Tenant Two", 75]]);
    const local = localBrands("D2", [[null, "Corner Kiln", 0.05]]);
    const diff = buildGhostDiff({ answer: answer(), resolved: [], report: report("tenant_mix", [fit, local]), datasets: [fit, local], registry, geo: FAKE_GEO });
    expect(diff.meanPopularity.qloo).toBeCloseTo((0.15 + 0.05) / 2, 12);
  });
});

describe("matching places", () => {
  it("matches a gazetteer neighbourhood by area and a catalogue market against a travel destination by name", async () => {
    const { registry, ref } = registryOf([["Dest Harbor City", 0.5]]);
    const lift = liftMap("D1", "nashville", [["mill_quarter", "Mill Quarter", 1.1]]);
    const travel = travelQuadrant("D2", [["Harbor City", ref("Dest Harbor City"), 0.5, 0.9]]);
    const search = new FakeSearch();
    const hoods = answer({ neighbourhoods: ["Mill Quarter, Nashville"] });
    const hoodDiff = buildGhostDiff({
      answer: hoods,
      resolved: await resolveGhostPicks({ answer: hoods, search: search.search, geo: FAKE_GEO }),
      report: report("site_selection", [lift]),
      datasets: [lift],
      geo: FAKE_GEO,
    });
    expect(rows(hoodDiff.items)).toEqual([["neighbourhoods", "both", "Mill Quarter", null]]);

    const markets = answer({ markets: ["Harbor City, QA"] });
    const marketDiff = buildGhostDiff({
      answer: markets,
      resolved: await resolveGhostPicks({ answer: markets, search: search.search, geo: FAKE_GEO, markets: FAKE_MARKETS }),
      report: report("market_selection", [travel]),
      datasets: [travel],
      registry,
      geo: FAKE_GEO,
    });
    expect(rows(marketDiff.items)).toEqual([["markets", "both", "Harbor City", null]]);
    expect(search.calls).toEqual([]);
  });
});
