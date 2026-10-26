// The Reality Check harness end to end on an invented world (D29), through the real Qloo client over
// a scripted transport: every request passes the frozen allowlist, so the shapes asserted here are
// ones the live client would send. No network, no database, no LLM: GHOST is a stub.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GHOST_JOB_CATEGORIES } from "@ct/agent";
import { QUESTION_MAX_CHARS, type GhostAnswer, type LocalityApi, type QlooParams } from "@ct/contracts";
import type { CanonicalRequest, QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { EvalSummary } from "../../apps/web/components/method/eval-summary";
import { loadRealityCases, RealityKind, type RealityCase, type RealityCasesFile } from "./cases";
import { areaCells, gridGeo, worldClient, type World } from "./reality-fixtures";
import { loadSecondaryMarkets, type SecondaryMarket } from "./reality-location";
import {
  aggregateReality,
  ghostQuestion,
  ghostTop5FromAnswer,
  planRealityCalls,
  POOL_TAKE,
  REALITY_GHOST,
  realityExport,
  runRealityCheck,
  writeRealityRaw,
  type GhostTop5,
  type RealityCaseResult,
  type RealityDeps,
  type RealityRun,
} from "./reality";

const brand = (id: string, name: string, popularity: number | null) => ({ id, name, type: "brand" as const, popularity });

const ENTITIES = [
  brand("brand-alpha", "Brand Alpha", 0.8),
  brand("brand-beta", "Brand Beta", 0.6),
  brand("brand-gamma", "Brand Gamma", 0.7),
  brand("brand-epsilon", "Brand Epsilon", 0.6),
  brand("brand-pool-a", "Pool Brand A", 0.58),
  brand("brand-pool-b", "Pool Brand B", 0.61),
  brand("brand-pool-c", "Pool Brand C", 0.63),
  brand("brand-pool-d", "Pool Brand D", 0.3),
  brand("brand-pool-e", "Pool Brand E", 0.9),
  brand("brand-pool-f", "Pool Brand F", 0.59),
  brand("brand-pool-g", "Pool Brand G", 0.65),
  brand("brand-pool-h", "Pool Brand H", null),
  brand("brand-kappa-classic", "Brand Kappa Classic", 0.4),
  brand("brand-omega", "Brand Omega", 0.5),
  brand("brand-sigma", "Brand Sigma", 0.5),
  brand("brand-delta", "Brand Delta", 0.5),
  { id: "artist-nova", name: "Artist Nova", type: "artist" as const, popularity: 0.7 },
  { id: "person-vega", name: "Comedian Vega", type: "person" as const, popularity: 0.6 },
  { id: "person-lyra", name: "Comedian Lyra", type: "person" as const, popularity: 0.5 },
];

const MARKETS: SecondaryMarket[] = [
  { id: "riverton", label: "Riverton", state: "WY", stateName: "Wyoming" },
  { id: "lakeside", label: "Lakeside", state: "OR", stateName: "Oregon" },
  { id: "fort_juniper", label: "Fort Juniper", state: "KS", stateName: "Kansas" },
  { id: "grand_marten", label: "Grand Marten", state: "MI", stateName: "Michigan" },
  { id: "cedar_bluff", label: "Cedar Bluff", state: "AL", stateName: "Alabama" },
  { id: "osprey_bay", label: "Osprey Bay", state: "FL", stateName: "Florida" },
];

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
// Concept affinity, baseline affinity and baseline popularity per area, six cells each: Old Mill's
// taste heat is the highest over the lowest baseline, so its lift leads.
const HEAT: [number, number, number][] = [
  [0.9, 0.2, 0.5],
  [0.8, 0.8, 0.7],
  [0.7, 0.5, 0.52],
  [0.6, 0.9, 0.47],
  [0.3, 0.3, 0.45],
  [0.2, 0.4, 0.56],
  [0.1, 0.6, 0.4],
  [0.05, 0.7, 0.9],
];
const BASELINE_TAG = "urn:tag:genre:place:restaurant";

const WORLD: World = {
  entities: ENTITIES,
  pools: {
    // The choices' look-alikes. Qloo leaves the signal entity out; the seed and two GHOST picks are in the pool and must be excluded.
    "brand-beta": [
      "brand-alpha",
      "brand-gamma",
      "brand-epsilon",
      ...["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => `brand-pool-${x}`),
    ],
    "brand-sigma": ["brand-pool-a", "brand-pool-b", "brand-pool-c", "brand-pool-d", "brand-pool-e"],
  },
  affinity: {
    "brand-alpha": {
      "brand-beta": 0.9,
      "brand-gamma": 0.8,
      "brand-epsilon": 0.5,
      "brand-pool-a": 0.7,
      "brand-pool-b": 0.95,
      "brand-pool-c": 0.4,
      "brand-pool-d": 0.1,
      "brand-pool-e": 0.2,
      "brand-pool-f": 0.6,
      "brand-pool-g": 0.6,
      "brand-pool-h": 0.3,
    },
    // Brand Sigma, the choice, is dropped from the response.
    "brand-omega": { "brand-pool-a": 0.5, "brand-pool-b": 0.4, "brand-pool-c": 0.3, "brand-pool-d": 0.2, "brand-pool-e": 0.1 },
  },
  localities: {
    "loc-riverton": { "person-vega": 0.9, "person-lyra": 0.3 },
    "loc-lakeside": { "person-vega": 0.8, "person-lyra": 0.4 },
    "loc-fort_juniper": { "person-vega": 0.2, "person-lyra": 0.7 },
    "loc-grand_marten": { "person-vega": 0.1, "person-lyra": 0.6 },
    "loc-cedar_bluff": { "person-vega": 0.7, "person-lyra": 0.5 },
  },
  heatmaps: {
    "loc-austin|brand-delta": HEAT.flatMap(([c], i) => areaCells(i, 6, c)),
    [`loc-austin|${BASELINE_TAG}`]: HEAT.flatMap(([, b, p], i) => areaCells(i, 6, b, p)),
  },
};

const base = { context: "invented context", claim: "An invented public fact.", public_date: "2025-06-01", note: null };
const sources = [{ url: "https://example.com/news/1", publisher: "Example News", published: "2025-06-01", accessed: "2026-01-10" }];

const CASES: RealityCase[] = [
  { ...base, sources, id: "rc01", kind: "brand_collaboration", showcase: null, seed: { name: "Brand Alpha", entity_type: "brand" }, choice: { name: "Brand Beta", entity_type: "brand" } },
  {
    ...base,
    sources,
    id: "rc02",
    kind: "tour_sponsor",
    showcase: null,
    seed: { name: "Artist Nova", entity_type: "artist" },
    choice: { name: "Brand Kappa", entity_type: "brand" },
    sponsor_category: "beer",
  },
  { ...base, sources, id: "rc03", kind: "brand_collaboration", showcase: null, seed: { name: "Brand Notfound", entity_type: "brand" }, choice: { name: "Brand Beta", entity_type: "brand" } },
  { ...base, sources, id: "rc04", kind: "brand_collaboration", showcase: null, seed: { name: "Brand Omega", entity_type: "brand" }, choice: { name: "Brand Sigma", entity_type: "brand" } },
  {
    ...base,
    sources,
    id: "rc07",
    kind: "comedian_market",
    showcase: "S6",
    seed: { name: "Comedian Vega", entity_type: "person" },
    choice: { entity_type: "locality", tour: "Invented Tour", markets: ["riverton", "lakeside", "osprey_bay"] },
  },
  {
    ...base,
    sources,
    id: "rc08",
    kind: "comedian_market",
    showcase: null,
    seed: { name: "Comedian Lyra", entity_type: "person" },
    choice: { entity_type: "locality", tour: "Second Tour", markets: ["fort_juniper", "grand_marten"] },
  },
  {
    ...base,
    sources,
    id: "rc09",
    kind: "comedian_market",
    showcase: null,
    seed: { name: "Comedian Notfound", entity_type: "person" },
    choice: { entity_type: "locality", tour: "Third Tour", markets: ["cedar_bluff"] },
  },
  {
    ...base,
    sources,
    id: "rc10",
    kind: "dtc_neighbourhood",
    showcase: null,
    seed: { name: "Brand Delta", entity_type: "brand" },
    choice: { name: "Mill District", entity_type: "neighbourhood", metro: "austin", area_id: "old_mill", address: "100 Example Street" },
  },
  {
    ...base,
    sources,
    id: "rc11",
    kind: "dtc_neighbourhood",
    showcase: null,
    seed: { name: "Brand Delta", entity_type: "brand" },
    choice: { name: "Riverside", entity_type: "neighbourhood", metro: "nashville", area_id: "zcta_00000", address: "1 Example Road" },
  },
];

const FILE: RealityCasesFile = { registered: "2026-01-15", caveats: ["An invented caveat about leakage."], scoring: ["An invented rule."], cases: CASES };

const GHOST: Record<string, string[]> = {
  rc01: ["Brand Beta", "Brand Gamma", "Brand Notfound Pick", "Brand Alpha", "Brand Epsilon", "Brand Omega"],
  rc02: ["Brand Gamma"],
  rc03: ["Brand Gamma"],
  rc04: [],
  rc07: ["Riverton, WY", "Metro Prime"],
  rc08: ["Lakeside"],
  rc09: ["Cedar Bluff"],
  rc10: ["Mill District", "Juniper Row", "Unknown Quarter"],
  rc11: [],
};

const ghostStub: GhostTop5 = async (c) => GHOST[c.id] ?? [];

/** Austin and every market but Osprey Bay are pinned; Nashville is not. */
const LOCALITIES: LocalityApi = {
  market: async (id) => (id === "osprey_bay" || id === "nashville" ? null : { entityId: `loc-${id}`, label: id }),
};

function deps(client: QlooClient, overrides: Partial<RealityDeps> = {}): RealityDeps {
  return {
    client,
    geo: gridGeo("austin", AREAS),
    localities: LOCALITIES,
    markets: MARKETS,
    ghostTop5: ghostStub,
    now: () => new Date("2026-01-20T12:00:00.000Z"),
    ...overrides,
  };
}

async function run(overrides: Partial<RealityDeps> = {}): Promise<{ result: RealityRun; requests: CanonicalRequest[]; lines: string[] }> {
  const { client, requests } = worldClient(WORLD);
  const lines: string[] = [];
  const result = await runRealityCheck(FILE, deps(client, { log: (line) => lines.push(line), ...overrides }));
  await client.flush();
  return { result, requests, lines };
}

const byId = (r: RealityRun, id: string): RealityCaseResult => {
  const found = r.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

const insightsOf = (requests: readonly CanonicalRequest[], filterType: string) =>
  requests.filter((r) => r.path === "/v2/insights" && r.filterType === filterType);

const sorted = (xs: readonly string[]) => [...xs].sort();
const list = (params: QlooParams, key: string): string[] => {
  const v = params[key];
  return v === undefined ? [] : Array.isArray(v) ? [...v] : [String(v)];
};

describe("an entity case (brand collaboration, tour sponsor)", () => {
  it("scores the choice, GHOST's resolved picks and five popularity-matched distractors in one call", async () => {
    const { result, requests } = await run();
    const rc01 = byId(result, "rc01");
    const signalled = (id: string) => insightsOf(requests, "urn:entity:brand").filter((r) => list(r.params, "signal.interests.entities")[0] === id);
    const scoring = signalled("brand-alpha").filter((r) => r.params["filter.results.entities"] !== undefined);

    // The pool: the choice's own top brands, never the seed's, nothing else in the request.
    expect(signalled("brand-alpha").filter((r) => r.params["filter.results.entities"] === undefined)).toEqual([]);
    expect(signalled("brand-beta").map((r) => r.params)).toEqual([{ "filter.type": "urn:entity:brand", "signal.interests.entities": ["brand-beta"], take: POOL_TAKE }]);
    // One scoring call: the seed's taste over the exact candidate list, take = its size.
    expect(scoring).toHaveLength(1);
    const candidates = ["brand-beta", "brand-gamma", "brand-epsilon", "brand-pool-a", "brand-pool-b", "brand-pool-c", "brand-pool-f", "brand-pool-g"];
    expect(scoring[0]?.params).toEqual({
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": ["brand-alpha"],
      "filter.results.entities": sorted(candidates),
      take: candidates.length,
    });
    const roles = (role: string) => rc01.candidates.filter((c) => c.role === role).map((c) => c.key);
    expect(roles("choice")).toEqual(["brand-beta"]);
    expect(roles("ghost")).toEqual(["brand-gamma", "brand-epsilon"]);
    expect(sorted(roles("distractor"))).toEqual(["brand-pool-a", "brand-pool-b", "brand-pool-c", "brand-pool-f", "brand-pool-g"]);
  });

  it("excludes the choice, GHOST's picks and the seed from the distractors, and uses GHOST's first five only", async () => {
    const { result } = await run();
    const rc01 = byId(result, "rc01");
    const distractors = rc01.candidates.filter((c) => c.role === "distractor").map((c) => c.key);
    expect(distractors).toHaveLength(5);
    // Brand Epsilon sits in the pool at the choice's own popularity: as a GHOST pick it is never a distractor.
    for (const excluded of ["brand-alpha", "brand-beta", "brand-gamma", "brand-epsilon"]) expect(distractors).not.toContain(excluded);
    // The two far-off pool brands and the one with no popularity are never matched.
    for (const far of ["brand-pool-d", "brand-pool-e", "brand-pool-h"]) expect(distractors).not.toContain(far);
    // GHOST's sixth name is not one of its five.
    expect(rc01.ghost.picks).toEqual(GHOST.rc01?.slice(0, 5));
    expect(rc01.candidates.map((c) => c.key)).not.toContain("brand-omega");
  });

  it("reports the percentile among the other scored candidates, the rank of N and a GHOST hit", async () => {
    const { result } = await run();
    const rc01 = byId(result, "rc01");
    // Brand Beta beats six of the seven others and loses only to Pool Brand B.
    expect(rc01).toMatchObject({ status: "scored", reason: null, detail: null, rank: 2, of: 8 });
    expect(rc01.percentile).toBeCloseTo(6 / 7, 12);
    // Beta is a hit; the seed and an unresolved name are not candidates.
    expect(rc01.ghost).toMatchObject({ hit: true, resolved: 4, error: null });
    expect(rc01.candidates.find((c) => c.role === "choice")?.ghost).toBe(true);
  });

  it("reports a case whose seed or choice does not resolve as not scorable, and final", async () => {
    const { result, requests } = await run();
    expect(byId(result, "rc02")).toMatchObject({ status: "not_scorable", reason: "choice_unresolved", percentile: null, ghost: { hit: null, resolved: 1 }, retry: false });
    expect(byId(result, "rc02").detail).toContain("'Brand Kappa' is not found as a brand");
    expect(byId(result, "rc03")).toMatchObject({ status: "not_scorable", reason: "seed_unresolved", ghost: { hit: false }, retry: false });
    // Nothing is called for a case that cannot be scored past its searches.
    const unresolvedSeeds = insightsOf(requests, "urn:entity:brand").filter((r) => list(r.params, "signal.interests.entities")[0] === "artist-nova");
    expect(unresolvedSeeds).toEqual([]);
  });

  it("ranks a candidate Qloo leaves out of the scoring call below every scored one, the choice included", async () => {
    const { result } = await run();
    // Brand Sigma, the choice, is dropped: it is scored last, not set aside.
    expect(byId(result, "rc04")).toMatchObject({ status: "scored", percentile: 0, rank: 6, of: 6, ghost: { hit: false } });
    expect(byId(result, "rc04").candidates.filter((c) => c.score !== null)).toHaveLength(5);

    const cases = CASES.filter((c) => c.id === "rc04");
    const thin = (affinity: Record<string, number>) => worldClient({ ...WORLD, affinity: { ...WORLD.affinity, "brand-omega": affinity } }).client;
    // Only Pool Brand B is scored: the choice ties the four other dropped candidates at the bottom.
    const one = await runRealityCheck({ ...FILE, cases }, deps(thin({ "brand-pool-b": 0.4 })));
    expect(byId(one, "rc04")).toMatchObject({ status: "scored", percentile: 0.4, rank: 2, of: 6 });
    // A call that scored no candidate scores no one.
    const none = await runRealityCheck({ ...FILE, cases }, deps(thin({})));
    expect(byId(none, "rc04")).toMatchObject({ status: "not_scorable", reason: "choice_unscored", retry: false });
    expect(byId(none, "rc04").detail).toContain("no affinity for any of the 6 candidates");
  });

  it("keeps scoring a case whose GHOST call failed, with the hit unknown", async () => {
    const failing: GhostTop5 = async (c) => {
      if (c.id === "rc01") throw new Error("ghost timed out");
      return ghostStub(c);
    };
    const { result } = await run({ ghostTop5: failing });
    const rc01 = byId(result, "rc01");
    expect(rc01.ghost).toMatchObject({ picks: [], hit: null, error: "ghost timed out" });
    expect(rc01.status).toBe("scored");
    expect(rc01.candidates.filter((c) => c.role === "ghost")).toEqual([]);
  });

  it("reports a case the Qloo budget refused as not scorable, never dropped", async () => {
    const { client } = worldClient(WORLD);
    const refusing: QlooClient = {
      ...client,
      standalone: (options) => {
        const scope = client.standalone(options);
        return {
          ...scope,
          forTool: (id) => {
            const tool = scope.forTool(id);
            return {
              search: (p) => tool.search(p),
              entities: (ids) => tool.entities(ids),
              tags: (p) => tool.tags(p),
              audiences: (p) => tool.audiences(p),
              trending: (p) => tool.trending(p),
              has: (path, p) => tool.has(path, p),
              insights: async () => {
                throw Object.assign(new Error("tag cap reached"), { name: "BudgetError" });
              },
            };
          },
        };
      },
    };
    const result = await runRealityCheck(FILE, deps(refusing));
    expect(result.cases).toHaveLength(CASES.length);
    // Each is marked to retry: the eval runs it again on --resume.
    expect(byId(result, "rc01")).toMatchObject({ status: "not_scorable", reason: "budget", detail: "tag cap reached", retry: true });
    expect(byId(result, "rc07")).toMatchObject({ status: "not_scorable", reason: "budget", retry: true });
    expect(byId(result, "rc10")).toMatchObject({ status: "not_scorable", reason: "budget", retry: true });
    // A case that needed no refused call is final.
    expect(byId(result, "rc02")).toMatchObject({ reason: "choice_unresolved", retry: false });
  });
});

describe("a comedian case", () => {
  it("ranks the registered comedians once per pinned secondary market, shared by every comedian case", async () => {
    const { requests } = await run();
    const persons = insightsOf(requests, "urn:entity:person");
    expect(persons.map((r) => r.params["signal.location"]).sort()).toEqual(
      ["loc-cedar_bluff", "loc-fort_juniper", "loc-grand_marten", "loc-lakeside", "loc-riverton"].sort(),
    );
    for (const r of persons) {
      expect(r.params).toEqual({
        "filter.type": "urn:entity:person",
        "signal.location": r.params["signal.location"],
        "filter.results.entities": ["person-lyra", "person-vega"],
        take: 2,
      });
    }
  });

  it("takes each booked market's percentile among the unbooked ones, and the median across them", async () => {
    const { result } = await run();
    const rc07 = byId(result, "rc07");
    // Vega leads the panel in Riverton, Lakeside and Cedar Bluff; Osprey Bay has no pinned locality.
    expect(rc07).toMatchObject({ status: "scored", rank: null, of: 5 });
    expect(rc07.booked).toEqual([
      { market: "riverton", percentile: 2.5 / 3 },
      { market: "lakeside", percentile: 2.5 / 3 },
      { market: "osprey_bay", percentile: null },
    ]);
    expect(rc07.percentile).toBeCloseTo(2.5 / 3, 12);
    // Riverton and Lakeside each tie Cedar Bluff, where Vega also leads: two of six comparisons.
    expect(rc07.ties).toEqual({ tied: 2, of: 6 });
    expect(byId(result, "rc08")).toMatchObject({ percentile: 1, ties: { tied: 0, of: 6 }, retry: false });
  });

  it("builds the panel from every registered comedian, so a case run alone scores as in the full run", async () => {
    const full = await run();
    const { client, requests } = worldClient(WORLD);
    const alone = await runRealityCheck({ ...FILE, cases: CASES.filter((c) => c.id === "rc07") }, deps(client, { registered: CASES }));
    expect(byId(alone, "rc07")).toMatchObject({ status: "scored", booked: byId(full.result, "rc07").booked, ties: byId(full.result, "rc07").ties });
    expect(byId(alone, "rc07").percentile).toBe(byId(full.result, "rc07").percentile);
    // The other comedians' seeds are searched as shared calls; the market calls rank the whole panel.
    expect(byId(alone, "rc07").calls.network).toBe(1);
    for (const r of insightsOf(requests, "urn:entity:person")) expect(r.params["filter.results.entities"]).toEqual(["person-lyra", "person-vega"]);
    expect(alone.plan.shared).toBe(MARKETS.length + 2);
  });

  it("is not scorable when every booked-versus-unbooked comparison ties, rather than scored 0.5", async () => {
    // Vega leads the panel in every market and Lyra trails everywhere: no case's markets stand apart.
    const leads = Object.fromEntries(Object.keys(WORLD.localities).map((loc) => [loc, { "person-vega": 0.9, "person-lyra": 0.1 }]));
    const { client } = worldClient({ ...WORLD, localities: leads });
    const result = await runRealityCheck(FILE, deps(client));
    for (const id of ["rc07", "rc08"]) {
      expect(byId(result, id), id).toMatchObject({ status: "not_scorable", reason: "no_contrast", percentile: null, ties: { tied: 6, of: 6 } });
    }
    expect(byId(result, "rc07").detail).toContain("same place in the panel in every scored market");
  });

  it("marks every comedian case to retry when one of the panel's market calls failed", async () => {
    const { client } = worldClient(WORLD);
    const flaky: QlooClient = {
      ...client,
      standalone: (options) => {
        const scope = client.standalone(options);
        return {
          ...scope,
          forTool: (id) => {
            const tool = scope.forTool(id);
            return {
              search: (p) => tool.search(p),
              entities: (ids) => tool.entities(ids),
              tags: (p) => tool.tags(p),
              audiences: (p) => tool.audiences(p),
              trending: (p) => tool.trending(p),
              has: (path, p) => tool.has(path, p),
              insights: async (type, params) => {
                if (params["signal.location"] === "loc-cedar_bluff") throw new Error("Qloo answered 503 three times");
                return tool.insights(type, params);
              },
            };
          },
        };
      },
    };
    const result = await runRealityCheck(FILE, deps(flaky));
    // rc07 is still scored on the other markets, but a rerun may score it differently.
    expect(byId(result, "rc07")).toMatchObject({ status: "scored", retry: true });
    expect(byId(result, "rc08")).toMatchObject({ retry: true });
    expect(byId(result, "rc01")).toMatchObject({ status: "scored", retry: false });
  });

  it("counts any booked market among GHOST's five as a hit, beside the chance of one", async () => {
    const { result } = await run();
    expect(byId(result, "rc07").ghost).toMatchObject({ hit: true, resolved: 1, chance: 1 });
    expect(byId(result, "rc08").ghost).toMatchObject({ hit: false, resolved: 1 });
    // The seed did not resolve, but the hit needs no Qloo call: one booked of six markets.
    expect(byId(result, "rc09")).toMatchObject({ status: "not_scorable", reason: "seed_unresolved", ghost: { hit: true } });
    expect(byId(result, "rc09").ghost.chance).toBeCloseTo(1 - 1 / 6, 12);
  });

  it("is not scorable when fewer than two registered comedians resolve", async () => {
    const { client } = worldClient(WORLD);
    const lone: RealityCasesFile = { ...FILE, cases: CASES.filter((c) => c.id === "rc07" || c.id === "rc09") };
    const result = await runRealityCheck(lone, deps(client));
    expect(byId(result, "rc07")).toMatchObject({ status: "not_scorable", reason: "panel_too_small" });
  });
});

describe("a store neighbourhood case", () => {
  it("scores every area on the seed's Lift Map against the pinned baseline, the same requests geo_lift sends", async () => {
    const { requests } = await run();
    const maps = insightsOf(requests, "urn:heatmap").map((r) => r.params);
    expect(maps).toHaveLength(2);
    expect(maps).toContainEqual({ "filter.type": "urn:heatmap", "filter.location": "loc-austin", "signal.interests.entities": ["brand-delta"] });
    expect(maps).toContainEqual({ "filter.type": "urn:heatmap", "filter.location": "loc-austin", "signal.interests.tags": [BASELINE_TAG] });
  });

  it("puts the registered area against GHOST's areas and five areas matched on baseline popularity", async () => {
    const { result } = await run();
    const rc10 = byId(result, "rc10");
    expect(rc10.candidates.map((c) => [c.key, c.role])).toEqual([
      ["old_mill", "choice"],
      ["juniper_row", "ghost"],
      ["kestrel_park", "distractor"],
      ["linden_cross", "distractor"],
      ["pine_hollow", "distractor"],
      ["marten_bluff", "distractor"],
      ["nettle_green", "distractor"],
    ]);
    // Every area both maps cover has a lift, weak taste included.
    expect(rc10).toMatchObject({ status: "scored", percentile: 1, rank: 1, of: 7 });
    expect(rc10.candidates.every((c) => c.score !== null)).toBe(true);
    expect(rc10.ghost).toMatchObject({ hit: true, resolved: 2 });
  });

  it("scores a registered area where the seed's taste is weak low, never unscored", async () => {
    const rc10 = CASES.find((c) => c.id === "rc10");
    if (rc10?.kind !== "dtc_neighbourhood") throw new Error("no store case");
    const weak: RealityCase = { ...rc10, id: "rc12", choice: { ...rc10.choice, name: "Osprey Flats", area_id: "osprey_flats" } };
    const { client } = worldClient(WORLD);
    const result = await runRealityCheck({ ...FILE, cases: [weak] }, deps(client, { ghostTop5: async () => [] }));
    expect(byId(result, "rc12")).toMatchObject({ status: "scored", percentile: 0, rank: 6, of: 6 });
  });

  it("is not scorable without a pinned locality, and makes no map call for it", async () => {
    const { result, requests } = await run();
    expect(byId(result, "rc11")).toMatchObject({ status: "not_scorable", reason: "no_locality", ghost: { hit: false } });
    expect(insightsOf(requests, "urn:heatmap").every((r) => r.params["filter.location"] === "loc-austin")).toBe(true);
  });
});

describe("the call plan and the call log", () => {
  it("logs every case with its network calls, each within its cold-cache plan", async () => {
    const { result, requests, lines } = await run();
    expect(result.calls.network).toBe(requests.length);
    for (const c of result.cases) {
      const planned = result.plan.perCase.find((p) => p.id === c.id)?.calls ?? 0;
      expect(c.calls.network, c.id).toBeLessThanOrEqual(planned);
    }
    expect(result.shared.network).toBeLessThanOrEqual(result.plan.shared);
    expect(result.calls.network).toBeLessThanOrEqual(result.plan.total);
    expect(lines[0]).toContain(`at most ${result.plan.total} Qloo network calls`);
    expect(lines.filter((l) => /^rc\d{2} /.test(l))).toHaveLength(CASES.length);
  });

  it("serves a rerun on the same client from the cache, with the same distractors", async () => {
    const { client, requests } = worldClient(WORLD);
    const first = await runRealityCheck(FILE, deps(client));
    const sent = requests.length;
    const second = await runRealityCheck(FILE, deps(client));
    expect(requests.length).toBe(sent);
    expect(second.calls.network).toBe(0);
    expect(second.cases.map((c) => c.candidates.map((k) => k.key))).toEqual(first.cases.map((c) => c.candidates.map((k) => k.key)));
  });

  it("keeps the registered check under about 100 network calls on a cold cache", () => {
    const plan = planRealityCalls(loadRealityCases().cases, loadSecondaryMarkets());
    expect(plan.total).toBeLessThanOrEqual(100);
    expect(plan.perCase).toHaveLength(12);
  });

  it("plans the searches of the registered comedians a run leaves out, as shared calls", () => {
    const rc07 = CASES.filter((c) => c.id === "rc07");
    expect(planRealityCalls(rc07, MARKETS, CASES).shared).toBe(MARKETS.length + 2);
    expect(planRealityCalls(rc07, MARKETS).shared).toBe(MARKETS.length);
    expect(
      planRealityCalls(
        CASES.filter((c) => c.id === "rc01"),
        MARKETS,
        CASES,
      ).shared,
    ).toBe(0);
  });
});

describe("the aggregates and the export", () => {
  it("reports the median, the GHOST hit rate without comedian cases and n scorable, with and without showcase seeds", async () => {
    const { result } = await run();
    const agg = aggregateReality(result);
    // GHOST's hit rate leaves the three comedian cases out: rc01 and rc10 hit, rc03, rc04 and rc11 miss.
    expect(agg.all).toMatchObject({ cases: 9, scorable: 5, ghostCases: 5, ghostHits: 2, ghostHitRate: 0.4 });
    expect(agg.all.medianPercentile).toBeCloseTo(6 / 7, 12);
    expect(agg.withoutShowcase).toMatchObject({ cases: 8, scorable: 4, ghostCases: 5, ghostHits: 2 });
    expect(agg.withoutShowcase.medianPercentile).toBeCloseTo((6 / 7 + 1) / 2, 12);
    expect(agg.byKind.comedian_market).toMatchObject({ cases: 3, scorable: 2, ghostCases: 3, ghostHits: 2 });
    expect(agg.notScorable.map((n) => `${n.id}:${n.reason}`)).toEqual(["rc02:choice_unresolved", "rc03:seed_unresolved", "rc09:seed_unresolved", "rc11:no_locality"]);
    expect(agg.caveats[0]).toBe("An invented caveat about leakage.");
    expect(agg.caveats.some((c) => c.startsWith("5 of 9 cases were scored; not scorable: rc02 (choice_unresolved)"))).toBe(true);
    expect(agg.caveats.some((c) => c.includes("near certain by chance") && c.includes("they hit 2 of 3"))).toBe(true);
    expect(agg.caveats.some((c) => c.startsWith("2 of 12 booked-versus-unbooked market comparisons in the comedian cases tied"))).toBe(true);
    expect(agg.caveats.some((c) => c.includes("partly measures recall"))).toBe(true);
  });

  it("exports EvalSummary.realityCheck and a table at two decimals, with no raw score", async () => {
    const { result } = await run();
    const out = realityExport(result);
    expect(out.summary).toMatchObject({ cases: 5, medianPercentile: 0.86, ghostHitRate: 0.4 });
    expect(out.summary.note).toContain("5 of 9 registered cases scored; the GHOST hit rate is over 5 cases, comedian cases apart");
    expect(out.summary.note).toContain("Without showcase seeds: median 0.93 (n = 4)");
    expect(out.summary.note).toContain("GHOST may recall choices made public before its training data ends");
    const summary = EvalSummary.parse({
      ranAt: result.ranAt,
      model: "claude-sonnet-5-5",
      questions: { total: 16, adversarial: 4 },
      metrics: [{ id: "traceability", label: "Numbers traced to a request", unit: "rate", grounded: 1, ghost: 0 }],
      realityCheck: out.summary,
    });
    expect(summary.realityCheck).toEqual(out.summary);
    expect(out.table.find((r) => r.id === "rc01")).toEqual({
      id: "rc01",
      kind: "brand_collaboration",
      showcase: null,
      seed: "Brand Alpha",
      choice: "Brand Beta",
      rank: 2,
      of: 8,
      percentile: 0.86,
      ghostHit: true,
      ghostChance: null,
      status: "scored",
      reason: null,
    });
    expect(out.table.find((r) => r.id === "rc07")).toMatchObject({ choice: "Invented Tour (3 secondary markets)", rank: null, percentile: 0.83, ghostChance: 1 });
    const text = JSON.stringify(out);
    for (const raw of ['"candidates":', '"score":', '"affinity":', '"popularity":', "brand-", "loc-"]) expect(text).not.toContain(raw);
  });

  it("writes the raw run, scores included, to the private folder it is given", async () => {
    const { result } = await run();
    const dir = mkdtempSync(path.join(tmpdir(), "reality-raw-"));
    try {
      const file = writeRealityRaw(result, dir);
      expect(path.basename(file)).toBe("reality-check-20260120T120000000Z.json");
      const back = JSON.parse(readFileSync(file, "utf8")) as RealityRun;
      expect(back.cases.map((c) => c.id)).toEqual(CASES.map((c) => c.id));
      expect(back.cases[0]?.candidates[0]?.score).toBe(0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the GHOST questions", () => {
  const registered = loadRealityCases().cases;
  const markets = loadSecondaryMarkets();

  it("name the seed and never the registered choice, within the web's question length", () => {
    for (const c of registered) {
      const q = ghostQuestion(c, markets);
      expect(q.length, c.id).toBeLessThanOrEqual(QUESTION_MAX_CHARS);
      expect(q, c.id).toContain(c.seed.name);
      if (c.kind !== "comedian_market") expect(q, c.id).not.toContain(c.choice.name);
      // Nothing else of the case reaches GHOST: the tour, the claim, the date or a source.
      if (c.kind === "comedian_market") expect(q, c.id).not.toContain(c.choice.tour);
      for (const leak of [c.claim, c.public_date, ...c.sources.map((s) => s.publisher)]) expect(q, c.id).not.toContain(leak);
    }
  });

  it("are asked under a job whose LISTS line fills the list the case reads", () => {
    for (const kind of RealityKind.options) expect(GHOST_JOB_CATEGORIES[REALITY_GHOST[kind].job]).toContain(REALITY_GHOST[kind].category);
  });

  it("never tell GHOST the sponsor's category, which describes the registered sponsor", () => {
    const sponsors = registered.filter((c) => c.kind === "tour_sponsor");
    expect(sponsors.length).toBeGreaterThan(0);
    for (const c of sponsors) {
      const words = ghostQuestion(c, markets).replace(c.seed.name, "").toLowerCase().split(/[^a-z]+/);
      for (const word of c.sponsor_category.split("_")) expect(words, c.id).not.toContain(word);
    }
  });

  it("offer a comedian every secondary market, so GHOST picks from the scored universe", () => {
    const c = registered.find((x) => x.kind === "comedian_market");
    if (c === undefined) throw new Error("no comedian case registered");
    const q = ghostQuestion(c, markets);
    for (const m of markets) expect(q).toContain(m.label);
  });

  it("read the top five of the kind's pick category from GHOST's answer", () => {
    const answer: GhostAnswer = {
      headline: "An invented headline.",
      picks: {
        competitors: [],
        markets: ["Riverton", "Lakeside", "Fort Juniper", "Grand Marten", "Cedar Bluff", "Osprey Bay"],
        neighbourhoods: ["Old Mill"],
        tenants: [],
        partners: ["Brand Beta"],
      },
      numeric_claims: [],
    };
    expect(ghostTop5FromAnswer(answer, "comedian_market")).toEqual(["Riverton", "Lakeside", "Fort Juniper", "Grand Marten", "Cedar Bluff"]);
    expect(ghostTop5FromAnswer(answer, "tour_sponsor")).toEqual(["Brand Beta"]);
    expect(ghostTop5FromAnswer(answer, "dtc_neighbourhood")).toEqual(["Old Mill"]);
  });
});
