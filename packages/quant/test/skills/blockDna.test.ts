// block_dna against a scripted Qloo: invented tags, brands and a neighbourhood (D29). The fake answers
// urn:tag and brand insights by location rung, so each test reads like the area and city it sets up.
import {
  BarsPayload,
  DatasetEnvelope,
  digestFits,
  isTaxonomyTag,
  Metric,
  ModelDigest,
  RankedPayload,
  type DatasetOf,
  type GeoApi,
  type InsightsFilterType,
  type InsightsResponse,
  type LatLon,
  type LocalityApi,
  type QlooApi,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type QlooResult,
  type QlooTagInsightRow,
} from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { FORMULAS } from "../../src/formulas";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { blockDnaSkill, brandParams, estimateBlockDnaCalls, tagParams } from "../../src/skills/blockDna";
import {
  compareLists,
  familyBars,
  familyOf,
  MUSIC_TAG_TYPE,
  rankBrandRows,
  rankTagRows,
} from "../../src/skills/blockDna/fingerprint";
import { cityLocation, nameFromSlug, pointWkt, resolveArea } from "../../src/skills/blockDna/location";
import { SKILLS } from "../../src/skills/index";
import { BudgetError, FETCHED_AT, fakeProbe, fakeRun, FakeRegistry } from "./support/fakes";

// The synthetic world ------------------------------------------------------------------------------------

const WHO = "urn:tag:customer_identity:qloo";
const VIBE = "urn:tag:ambience:qloo";
const WHAT = "urn:tag:genre:place";
const DISH = "urn:tag:specialty_dish:place";
const OTHER = "urn:tag:genre:qloo";
const SOUND = MUSIC_TAG_TYPE;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Tag rows in rank order, affinities falling from 0.9 so the list order is the affinity order. */
function tags(entries: readonly [string, string][], start = 0.9, step = 0.01): QlooTagInsightRow[] {
  return entries.map(([type, name], i) => ({
    tag_id: `${type}:test_${slug(name)}`,
    name,
    types: ["urn:entity:place"],
    subtype: type,
    popularity: 0.5,
    query: { affinity: Number((start - i * step).toFixed(4)) },
  }));
}

interface Brand {
  id: string;
  name: string;
  popularity: number;
}
const brand = (n: string, popularity = 0.6): Brand => ({ id: `ent-${slug(n)}`, name: n, popularity });

function brandRows(list: readonly (Brand & { affinity?: number })[]): QlooEntity[] {
  return list.map((b, i) => ({
    entity_id: b.id,
    name: b.name,
    type: "urn:entity:brand",
    popularity: b.popularity,
    tags: [{ id: "urn:tag:genre:brand:test_retail", name: "Retail", type: "urn:tag:genre:brand" }],
    query: { affinity: b.affinity ?? Number((0.6 - i * 0.01).toFixed(4)) },
  }));
}

type Rung = "POLYGON" | "POINT" | "QUERY" | "CITY";

interface Side {
  tags?: QlooTagInsightRow[];
  music?: QlooTagInsightRow[];
  brands?: QlooEntity[];
}

type World = Partial<Record<Rung, Side>>;

const CITY_TAGS = tags([
  [WHO, "Families"],
  [WHAT, "Chain Dining"],
  [VIBE, "Lively"],
  [WHO, "Tourists"],
  [WHAT, "Taqueria"],
  [VIBE, "Cozy"],
  [WHO, "Night Owls"],
  [WHAT, "Bakery"],
  [VIBE, "Upscale"],
  [WHO, "Students"],
]);
const AREA_TAGS = tags([
  [OTHER, "Outside Every Family"],
  [WHO, "Night Owls"],
  [WHAT, "Ramen"],
  [DISH, "Listening Room"],
  [VIBE, "Cozy"],
  [WHAT, "Wine Bar"],
  [WHO, "Vinyl Collectors"],
  [WHAT, "Taqueria"],
  [VIBE, "Lively"],
  [WHO, "Families"],
  [SOUND, "Stray Music Tag"],
]);
const CITY_MUSIC = tags([
  [SOUND, "Country"],
  [SOUND, "Americana"],
  [SOUND, "Blues"],
  [SOUND, "Rock"],
  [SOUND, "Folk"],
]);
const AREA_MUSIC = tags([
  [SOUND, "Jazz"],
  [SOUND, "Americana"],
  [SOUND, "Soul"],
  [SOUND, "Country"],
  [SOUND, "Folk"],
]);

const ROAST = brand("Corner Roast");
const BOOKS = brand("Corner Books");
const BURGER = brand("Big Burger", 0.85);
const COLA = brand("Mega Cola", 0.88);
const CHAIN = brand("Chain Coffee", 0.8);
const JUNK = brand("Junk Artifact", 0.004);
const FLOOR_A = brand("Floor Alpha");
const FLOOR_B = brand("Floor Beta");

const CITY_BRANDS = brandRows([COLA, BURGER, CHAIN, ROAST, brand("City Filler One"), brand("City Filler Two")]);
const AREA_BRANDS = brandRows([
  ROAST,
  JUNK,
  BOOKS,
  BURGER,
  COLA,
  { ...FLOOR_A, affinity: 0.0213 },
  { ...FLOOR_B, affinity: 0.0213 },
]);

const WORLD: World = {
  POLYGON: { tags: AREA_TAGS, music: AREA_MUSIC, brands: AREA_BRANDS },
  CITY: { tags: CITY_TAGS, music: CITY_MUSIC, brands: CITY_BRANDS },
};

// Invented metro locality pins: the city side is read by id, never by name.
const AUSTIN = { entityId: "loc-invented-austin", label: "Austin" };
const NASHVILLE = { entityId: "loc-invented-nashville", label: "Nashville" };
const PINS: LocalityApi = { market: async (id) => (id === "austin" ? AUSTIN : id === "nashville" ? NASHVILLE : null) };
const NO_AUSTIN_PIN: LocalityApi = { market: async (id) => (id === "nashville" ? NASHVILLE : null) };

// The fake Qloo ------------------------------------------------------------------------------------------

function rungOf(params: QlooParams): Rung {
  const location = params["signal.location"];
  if (location === AUSTIN.entityId || location === NASHVILLE.entityId) return "CITY";
  if (typeof location === "string") return location.startsWith("POLYGON") ? "POLYGON" : "POINT";
  return "QUERY";
}

class QlooFailure extends Error {
  readonly code = "qloo_unavailable";
}

interface Call {
  filterType: string;
  params: QlooParams;
  rung: Rung;
}

interface FakeOptions {
  /** Network calls allowed before every further call throws BudgetError. */
  budget?: number;
  /** Calls that fail in the client (a qloo_* error) instead of answering. */
  fail?: (call: Call) => boolean;
  stale?: boolean;
}

function blockQloo(world: World, options: FakeOptions = {}) {
  const calls: Call[] = [];
  let attempts = 0;
  const meta = (): QlooCallMeta => ({
    qlooCallId: `qc-${calls.length}`,
    requestId: `req-synthetic-${calls.length}`,
    cache: "miss",
    fetchedAt: FETCHED_AT,
    ms: 5,
    stale: options.stale ?? false,
    originRunId: null,
  });
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      attempts += 1;
      if (options.budget !== undefined && attempts > options.budget) throw new BudgetError("run cap reached");
      const call: Call = { filterType, params, rung: rungOf(params) };
      if (options.fail?.(call)) throw new QlooFailure("synthetic outage");
      calls.push(call);
      const side = world[call.rung] ?? {};
      const music = params["filter.tag.types"] !== undefined;
      const data =
        filterType === "urn:tag"
          ? { results: { tags: (music ? side.music : side.tags) ?? [] } }
          : { results: { entities: side.brands ?? [] } };
      return { data: data as unknown as InsightsResponse<F>, meta: meta() };
    },
    search: unused,
    entities: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
  };
  return { api, calls };
}

// An invented Austin neighbourhood: a small square east of the centre.
const RIVERBEND = {
  id: "riverbend",
  name: "Riverbend",
  metro: "austin" as const,
  centroid: { lat: 30.26, lon: -97.73 },
  areaKm2: 4.2,
};
const RIVERBEND_WKT = "POLYGON((-97.74 30.25,-97.72 30.25,-97.72 30.27,-97.74 30.27,-97.74 30.25))";

function fakeGeo(options: { polygon?: boolean } = {}): GeoApi {
  const inside = (p: LatLon) => p.lon >= -97.74 && p.lon <= -97.72 && p.lat >= 30.25 && p.lat <= 30.27;
  return {
    metros: () => ["nashville", "austin"],
    neighbourhoods: (metro) => (metro === "austin" ? [RIVERBEND] : []),
    neighbourhood: (metro, id) => (metro === "austin" && id === RIVERBEND.id ? RIVERBEND : null),
    matchNeighbourhood: () => null,
    polygonWkt: (metro, id) => (metro === "austin" && id === RIVERBEND.id && options.polygon !== false ? RIVERBEND_WKT : null),
    locate: (metro, p) => (metro === "austin" && inside(p) ? RIVERBEND.id : null),
    geohashCentroid: () => ({ lat: 0, lon: 0 }),
    boundarySource: () => "Invented test gazetteer",
  };
}

function setup(world: World = WORLD, options: FakeOptions & { polygon?: boolean; localities?: LocalityApi | null } = {}) {
  const qloo = blockQloo(world, options);
  const base = fakeRun(qloo.api, new FakeRegistry());
  const pins = options.localities === undefined ? PINS : options.localities;
  const ctx = { ...base.ctx, geo: fakeGeo(options), pillar: "location" as const, ...(pins === null ? {} : { localities: pins }) };
  return { ...base, ctx, calls: qloo.calls };
}

function input(raw: Partial<{ area: unknown; include_brands: boolean; step_id: string | null }> = {}) {
  return blockDnaSkill.input.parse({
    area: { kind: "nbhd", ref: "riverbend", metro: "austin" },
    include_brands: true,
    trigger_finding_id: null,
    step_id: "S3",
    ...raw,
  });
}

function barsOf(run: ReturnType<typeof setup>): DatasetOf<"Bars"> {
  const d = run.ledger.datasets.find((x) => x.kind === "Bars");
  if (d?.kind !== "Bars") throw new Error("expected a Bars dataset");
  return d;
}

function group(d: DatasetOf<"Bars">, family: string) {
  return d.payload.groups.find((g) => g.family === family);
}

const barValues = (d: DatasetOf<"Bars">, family: string) =>
  group(d, family)?.bars.map((b) => [b.label, b.values[0]?.value ?? null, b.isNew] as const);

// Pure parts ---------------------------------------------------------------------------------------------

describe("block_dna fingerprint arithmetic", () => {
  it("assigns families by tag type and leaves other namespaces out", () => {
    expect(familyOf({ tag_id: `${WHO}:x`, subtype: WHO })).toBe("WHO");
    expect(familyOf({ tag_id: `${DISH}:x`, subtype: null })).toBe("WHAT");
    expect(familyOf({ tag_id: "urn:tag:category:place:x", subtype: undefined })).toBe("WHAT");
    expect(familyOf({ tag_id: `${SOUND}:x`, subtype: SOUND })).toBe("SOUND");
    expect(familyOf({ tag_id: `${OTHER}:x`, subtype: OTHER })).toBeNull();
    expect(familyOf({ tag_id: "urn:tag:activities:place:x", subtype: null })).toBeNull();
  });

  it("ranks by affinity, never by row order, among the families the list speaks for", () => {
    const rows = tags([
      [WHO, "Low"],
      [OTHER, "Elsewhere"],
      [WHO, "High"],
    ]).map((r, i) => ({ ...r, query: { affinity: [0.2, 0.99, 0.8][i] as number } }));
    const list = rankTagRows(rows, ["WHO"]);
    expect(Object.fromEntries(list.ranks)).toEqual({ [`${WHO}:test_high`]: 1, [`${WHO}:test_low`]: 2 });
    expect(list.rows).toBe(3);
  });

  it("keeps rows tied at the floor unranked and drops brands below the quality gate", () => {
    const list = rankBrandRows(AREA_BRANDS);
    expect(list.gateDropped).toBe(1);
    expect([...list.unscored]).toEqual([FLOOR_A.id, FLOOR_B.id]);
    expect([...list.ranks.entries()]).toEqual([
      [ROAST.id, 1],
      [BOOKS.id, 2],
      [BURGER.id, 3],
      [COLA.id, 4],
    ]);
  });

  it("counts a missing rank as one below the list and marks NEW only inside the area top 20", () => {
    const area = rankTagRows(tags([[WHAT, "Here Only"], [WHAT, "Shared"]]), ["WHAT"]);
    const city = rankTagRows(tags([[WHAT, "Shared"], [WHAT, "City Only"]]), ["WHAT"]);
    const compared = compareLists(area, city, 51, 20);
    const byName = Object.fromEntries(compared.map((c) => [c.item.name, c]));
    expect(byName["Here Only"]).toMatchObject({ areaRank: 1, cityRank: null, delta: 50, isNew: true });
    expect(byName["Shared"]).toMatchObject({ areaRank: 2, cityRank: 1, delta: -1, isNew: false });
    expect(byName["City Only"]).toMatchObject({ areaRank: null, cityRank: 2, delta: -49, isNew: false });
    expect(compareLists(area, city, 51, 0).some((c) => c.isNew)).toBe(false);
    expect(compareLists(area, null, 51, 20).every((c) => c.delta === null && !c.isNew)).toBe(true);
  });

  it("counts a tag tied at the city floor as missing for the delta but never as NEW", () => {
    const area = rankTagRows(tags([[WHAT, "Tied In City"], [WHAT, "Second"]]), ["WHAT"]);
    const cityRows = tags([[WHAT, "City Top"], [WHAT, "Tied In City"], [WHAT, "Also Tied"]]).map((r, i) => (i === 0 ? r : { ...r, query: { affinity: 0.1 } }));
    const city = rankTagRows(cityRows, ["WHAT"]);
    expect([...city.unscored]).toHaveLength(2);
    const tied = compareLists(area, city, 51, 20).find((c) => c.item.name === "Tied In City");
    expect(tied).toMatchObject({ areaRank: 1, cityRank: null, delta: 50, isNew: false });
  });

  it("shows the top gains then the largest losses, or the area's order without a city side", () => {
    const area = rankTagRows(tags([[WHO, "A"], [WHO, "B"], [WHO, "C"]]), ["WHO"]);
    const city = rankTagRows(tags([[WHO, "C"], [WHO, "B"], [WHO, "D"]]), ["WHO"]);
    const { top, bottom } = familyBars(compareLists(area, city, 51, 20), true);
    expect(top.map((c) => [c.item.name, c.delta])).toEqual([["A", 50]]);
    expect(bottom.map((c) => [c.item.name, c.delta])).toEqual([
      ["D", -48],
      ["C", -2],
    ]);
    expect(familyBars(compareLists(area, null, 51, 20), false).top.map((c) => c.item.name)).toEqual(["A", "B", "C"]);
  });
});

describe("block_dna location ladder", () => {
  it("starts a gazetteer neighbourhood at its boundary, then its centre, then a place-name search", () => {
    const resolved = resolveArea({ kind: "nbhd", ref: "riverbend", metro: "austin" }, fakeGeo());
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.area.rungs.map((r) => [r.method, r.params])).toEqual([
      ["POLYGON", { "signal.location": RIVERBEND_WKT }],
      ["POINT", { "signal.location": "POINT(-97.73 30.26)" }],
      ["QUERY", { "signal.location.query": "Riverbend, Austin" }],
    ]);
  });

  it("refuses an id outside a metro's AREAS list and a point outside the metro", () => {
    expect(resolveArea({ kind: "nbhd", ref: "nowhere", metro: "austin" }, fakeGeo())).toMatchObject({ ok: false });
    const far = resolveArea({ kind: "point", ref: "-96.80,32.78", metro: "austin" }, fakeGeo());
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.message).toContain("km from central Austin");
  });

  it("takes a far point only when the map city's gazetteer holds it, never on the place search radius alone", () => {
    // About 85 km from central Los Angeles: inside the place search radius, outside the county.
    const outsideCounty = resolveArea({ kind: "point", ref: "-117.40,33.95", metro: "los_angeles" }, fakeGeo());
    expect(outsideCounty.ok).toBe(false);
    // The same distance on an island the gazetteer holds resolves.
    const island: GeoApi = { ...fakeGeo(), locate: (metro) => (metro === "los_angeles" ? RIVERBEND.id : null), neighbourhood: () => RIVERBEND };
    expect(resolveArea({ kind: "point", ref: "-117.40,33.95", metro: "los_angeles" }, island).ok).toBe(true);
    // A near point outside every area still resolves, as before.
    expect(resolveArea({ kind: "point", ref: "-97.60,30.40", metro: "austin" }, fakeGeo()).ok).toBe(true);
  });

  it("reads a neighbourhood of a metro without boundaries as a place-name search", () => {
    const resolved = resolveArea({ kind: "nbhd", ref: "east_side", metro: "nashville" }, fakeGeo());
    if (!resolved.ok) throw new Error(resolved.message);
    expect(nameFromSlug("east_side")).toBe("East Side");
    expect(resolved.area.rungs.map((r) => r.params)).toEqual([null, null, { "signal.location.query": "East Side, Nashville" }]);
    expect(resolved.area.notices[0]).toContain("No neighbourhood boundaries for Nashville");
  });

  it("starts a point at itself and searches the neighbourhood holding it", () => {
    const inside = resolveArea({ kind: "point", ref: "-97.73,30.26", metro: "austin" }, fakeGeo());
    const outside = resolveArea({ kind: "point", ref: "-97.70,30.30", metro: "austin" }, fakeGeo());
    if (!inside.ok || !outside.ok) throw new Error("expected both points to resolve");
    expect(inside.area.name).toBe("Riverbend (point)");
    expect(inside.area.rungs.map((r) => r.method)).toEqual(["POINT", "QUERY"]);
    expect(inside.area.rungs[1]?.params).toEqual({ "signal.location.query": "Riverbend, Austin" });
    expect(outside.area.rungs[1]?.params).toBeNull();
    expect(pointWkt({ lat: 30.123456789, lon: -97.987654321 })).toBe("POINT(-97.98765 30.12346)");
  });
});

// The skill ----------------------------------------------------------------------------------------------

describe("block_dna: the happy path", () => {
  it("reads the polygon, then the area music, both city lists and the brand pair", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");

    const city = cityLocation(AUSTIN);
    expect(run.calls.map((c) => [c.filterType, c.params])).toEqual([
      ["urn:tag", tagParams({ "signal.location": RIVERBEND_WKT }, false)],
      ["urn:tag", tagParams({ "signal.location": RIVERBEND_WKT }, true)],
      ["urn:tag", tagParams(city, false)],
      ["urn:tag", tagParams(city, true)],
      ["urn:entity:brand", brandParams({ "signal.location": RIVERBEND_WKT })],
      ["urn:entity:brand", brandParams(city)],
    ]);
    expect(run.calls[1]?.params).toEqual({ "signal.location": RIVERBEND_WKT, "filter.tag.types": [SOUND], take: 50 });
    // The city side is the pinned locality id, never a name search a namesake could answer.
    expect(run.calls[2]?.params).toEqual({ "signal.location": "loc-invented-austin", take: 50 });
    expect(run.calls[5]?.params).toEqual({ "signal.location": "loc-invented-austin", "filter.popularity.max": 0.9, take: 30 });
    expect(run.calls.some((c) => "signal.location.query" in c.params)).toBe(false);
    // The ladder sends no radius (G8), and brands never take filter.location (§5.1).
    expect(run.calls.some((c) => "signal.location.radius" in c.params || "filter.location" in c.params)).toBe(false);
    expect(run.events.filter((e) => e.type === "fallback")).toHaveLength(0);
  });

  it("writes rank gains by family with NEW notches, the method chip and venue-goer labels", async () => {
    const run = setup();
    await blockDnaSkill.run(input(), run.ctx);
    const d = barsOf(run);
    BarsPayload.parse(d.payload);
    DatasetEnvelope.parse(d);
    expect(d.formulaIds).toEqual(["block.rank_delta", "block.new_tag"]);
    expect(d.payload).toMatchObject({ mode: "diverging", comparator: "CITY", unit: "delta", method: "POLYGON" });
    expect(d.payload.groups.map((g) => g.label)).toEqual([
      "Who the venue-goers are",
      "Ambience",
      "Venues and dishes",
      "Music",
    ]);
    // The genre:qloo tag above Night Owls takes no rank, and the stray music tag stays out of WHO/VIBE/WHAT.
    expect(barValues(d, "WHO")).toEqual([
      ["Vinyl Collectors", 45, true],
      ["Night Owls", 6, false],
      ["Tourists", -47, false],
      ["Students", -41, false],
      ["Families", -8, false],
    ]);
    expect(barValues(d, "WHAT")?.slice(0, 3)).toEqual([
      ["Ramen", 49, true],
      ["Listening Room", 48, true],
      ["Wine Bar", 46, true],
    ]);
    expect(barValues(d, "SOUND")).toEqual([
      ["Jazz", 50, true],
      ["Soul", 48, true],
      ["Blues", -48, false],
      ["Rock", -47, false],
      ["Country", -3, false],
    ]);
    const ramen = group(d, "WHAT")?.bars[0];
    expect(ramen?.ranks).toEqual({ subject: 2, comparator: null });
    expect(ramen?.tagRef).toMatch(/^T\d+$/);
    expect(d.payload.groups.flatMap((g) => g.bars).some((b) => b.label === "Outside Every Family" || b.label === "Stray Music Tag")).toBe(false);
  });

  it("records bounded metrics with formula ids, badges, the city comparator and evidence", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input(), run.ctx);
    for (const m of run.ledger.metrics) {
      Metric.parse(m);
      expect(FORMULAS[m.formulaId as keyof typeof FORMULAS]).toBeDefined();
      expect(m.comparator).toBe("CITY");
      expect(m.evidenceIds.length).toBeGreaterThan(0);
    }
    const byKey = (key: string) => run.ledger.metrics.filter((m) => m.key === key);
    expect(byKey("block.new_tag").map((m) => [m.value, m.display, m.badge, m.formulaId])).toEqual([
      [1, "1 of 3 in the area top 20", "DERIVED", "block.new_tag"],
      [0, "0 of 2 in the area top 20", "DERIVED", "block.new_tag"],
      [3, "3 of 4 in the area top 20", "DERIVED", "block.new_tag"],
      [2, "2 of 5 in the area top 20", "DERIVED", "block.new_tag"],
    ]);
    const deltas = byKey("block.rank_delta").map((m) => [m.value, m.display, m.badge, m.unit]);
    expect(deltas).toEqual([
      // "+2 of 50" is about level (V13), never a gain.
      [45, "+45 · new here", "DERIVED", "delta"],
      [6, "+6", "DERIVED", "delta"],
      [-47, "−47 · outside the top 50 here", "DERIVED", "delta"],
      [2, "+2 · about level", "DERIVED", "delta"],
      [-42, "−42 · outside the top 50 here", "DERIVED", "delta"],
      [49, "+49 · new here", "DERIVED", "delta"],
      [48, "+48 · new here", "DERIVED", "delta"],
      [-49, "−49 · outside the top 50 here", "DERIVED", "delta"],
      [50, "+50 · new here", "DERIVED", "delta"],
      [48, "+48 · new here", "DERIVED", "delta"],
      [-48, "−48 · outside the top 50 here", "DERIVED", "delta"],
      [29, "+29 · not in the Austin top 30", "DERIVED", "delta"],
      [3, "+3", "DERIVED", "delta"],
    ]);
    expect(byKey("block.rank_delta")[0]?.label).toBe("rank gain vs Austin: Vinyl Collectors (venue-goer taste tag, Riverbend)");
    // The largest loss of each family is a metric too, so what falls against the city can be cited.
    const losses = run.ledger.metrics.filter((m) => m.label.startsWith("rank loss"));
    expect(losses.map((m) => m.label)).toEqual([
      "rank loss vs Austin: Tourists (venue-goer taste tag, Riverbend)",
      "rank loss vs Austin: Upscale (ambience tag, Riverbend)",
      "rank loss vs Austin: Chain Dining (venue or dish tag, Riverbend)",
      "rank loss vs Austin: Blues (music tag, Riverbend)",
    ]);
    expect(losses.every((m) => m.subjectRefs[0]?.startsWith("T") && m.evidenceIds.length === 2)).toBe(true);
    expect(group(barsOf(run), "WHO")?.bars.find((b) => b.label === "Tourists")?.tagRef).toBe(losses[0]?.subjectRefs[0]);
    expect(result.metricIds).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(4 * 4 + 4);
  });

  it("raises BLOCK_NEW_TAGS with its metrics and hands local brands to tenant fit", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input(), run.ctx);
    const finding = run.ledger.findings.find((f) => f.kind === "BLOCK_NEW_TAGS");
    expect(finding?.text).toContain("led by Ramen, Listening Room and Wine Bar");
    expect(finding?.suggestion?.tool).toBe("rank_candidates");
    // The WHAT NEW count first, then the WHAT gains it rests on.
    expect(finding?.metricIds).toEqual(["M11", "M8", "M9"]);

    expect(run.registry.entities().map((e) => [e.name, e.type])).toEqual([
      ["Corner Books", "brand"],
      ["Corner Roast", "brand"],
    ]);
    expect(result.forModel.registered.map((e) => e.name)).toEqual(["Corner Books", "Corner Roast"]);
    expect(result.forModel.notices.at(-1)).toBe("Tenant fit: rank_candidates on this area, contexts [site, city], brands favoured here R1, R2 (they rank higher here, not necessarily based here).");
    const tagsRegistered = run.registry.tags();
    expect(tagsRegistered.map((t) => [t.name, t.signalCapable])).toContainEqual(["Ramen", true]);
    expect(tagsRegistered.map((t) => [t.name, t.signalCapable])).toContainEqual(["Night Owls", false]);
    expect(tagsRegistered.every((t) => t.signalCapable === isTaxonomyTag(t.tagId))).toBe(true);
  });

  it("raises BLOCK_NEW_TAGS for SOUND once a quarter of the area's music is NEW and its venue mix matches the city's", async () => {
    const music = tags([
      [SOUND, "Jazz"],
      [SOUND, "Americana"],
      [SOUND, "Soul"],
      [SOUND, "Bluegrass"],
      [SOUND, "Country"],
    ]);
    // Every WHAT tag here is one the city ranks too: no NEW WHAT tag.
    const cityLike = tags([
      [WHO, "Night Owls"],
      [WHAT, "Taqueria"],
      [VIBE, "Cozy"],
      [WHAT, "Bakery"],
      [WHO, "Families"],
      [VIBE, "Lively"],
    ]);
    const run = setup({ ...WORLD, POLYGON: { ...WORLD.POLYGON, tags: cityLike, music } });
    await blockDnaSkill.run(input(), run.ctx);
    const found = run.ledger.findings.filter((f) => f.kind === "BLOCK_NEW_TAGS");
    expect(found).toHaveLength(1);
    const sound = found[0]!;
    expect(sound.text).toBe(
      "Among its top music tags, Riverbend has music tags that are not among the city's top music tags, led by Jazz, Soul and Bluegrass.",
    );
    // The NEW count, then the two NEW gains: a lead reads the area, the city and a signal tag.
    const cited = sound.metricIds.map((id) => run.ledger.metric(id)!);
    expect(cited.map((m) => m.key)).toEqual(["block.new_tag", "block.rank_delta", "block.rank_delta"]);
    const [jazz, soul] = [cited[1]!.subjectRefs[0], cited[2]!.subjectRefs[0]];
    expect([...new Set(cited.flatMap((m) => m.subjectRefs))].slice(0, 3)).toEqual(["riverbend", "austin", jazz]);
    expect(run.registry.tags().find((t) => t.ref === jazz)).toMatchObject({ name: "Jazz", signalCapable: true });
    // Every NEW music tag here is a taxonomy tag; the suggestion names the three rank_candidates takes.
    const bluegrass = run.registry.tags().find((t) => t.name === "Bluegrass")?.ref;
    expect(sound.suggestion).toEqual({
      tool: "rank_candidates",
      reason: `Rank tenant brands with Jazz (${jazz}), Soul (${soul}) or Bluegrass (${bluegrass}) as the taste signal at this site against the city.`,
    });

    // With NEW WHAT tags too, the one finding is WHAT's: both lead to the same ranking.
    const both = setup({ ...WORLD, POLYGON: { ...WORLD.POLYGON, music } });
    await blockDnaSkill.run(input(), both.ctx);
    expect(both.ledger.findings.filter((f) => f.kind === "BLOCK_NEW_TAGS").map((f) => f.text.slice(0, 32))).toEqual([
      "Among its top tags, Riverbend ha",
    ]);
    // Two NEW of five music tags is under the rule.
    const quiet = setup({ ...WORLD, POLYGON: { ...WORLD.POLYGON, tags: cityLike } });
    await blockDnaSkill.run(input(), quiet.ctx);
    expect(quiet.ledger.findings.filter((f) => f.kind === "BLOCK_NEW_TAGS")).toEqual([]);
  });

  it("writes the local brands table without artifacts or floor ties, and flags both", async () => {
    const run = setup();
    const addEvidence = vi.spyOn(run.ledger, "addEvidence");
    const result = await blockDnaSkill.run(input(), run.ctx);
    const d = run.ledger.datasets.find((x) => x.kind === "Ranked");
    if (d?.kind !== "Ranked") throw new Error("expected a Ranked dataset");
    RankedPayload.parse(d.payload);
    expect(d.payload.groups[0]?.rows.map((r) => [r.label, r.cells[0]?.value, r.cells[2]?.value ?? r.cells[2]?.reason, r.flags])).toEqual([
      ["Corner Books", 29, "not_measured", ["LOCAL"]],
      ["Corner Roast", 3, 4, ["LOCAL"]],
    ]);
    expect(result.flags).toEqual(["QUALITY_GATE_DROPPED", "NOT_SCORED"]);
    const brandEvidence = addEvidence.mock.calls.map(([e]) => e).find((e) => e.purpose.startsWith("Local brands"));
    expect(brandEvidence).toMatchObject({ status: "ok", qualityGateDrops: 1, flags: ["NOT_SCORED", "QUALITY_GATE_DROPPED"] });
  });

  it("returns a digest that fits, cites metric tokens in rows and carries no Qloo ids", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input(), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "block_dna", step: "S3" })).toBe(true);
    // WHAT rows first: the tags tenant fit picks keep their refs when rows are trimmed.
    expect(digest.top_rows[0]).toEqual({ ref: expect.stringMatching(/^T\d+$/), name: "Ramen", values: { family: "WHAT", gain_metric: "M8" } });
    expect(digest.top_rows.map((r) => r.values.family ?? r.values.role)).toEqual(["WHAT", "WHAT", "WHO", "WHO", "VIBE", "SOUND", "SOUND", "local_brand", "local_brand"]);
    expect(digest.top_rows.at(-1)).toMatchObject({ ref: "R2", name: "Corner Roast", values: { role: "local_brand" } });
    expect(digest.dataset_ids).toEqual(["D1", "D2"]);
    expect(digest.notices).toContain("Area read by POLYGON (its gazetteer boundary); city side: Qloo's Austin locality.");
    const text = JSON.stringify(digest);
    expect(text).not.toContain("ent-");
    expect(text).not.toContain("urn:tag");
    expect(text).not.toContain("loc-invented");
  });

  it("skips the brand pair without include_brands", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input({ include_brands: false }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls.every((c) => c.filterType === "urn:tag")).toBe(true);
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Bars"]);
    expect(result.forModel.notices.some((n) => n.startsWith("Tenant fit"))).toBe(false);
  });

  it("measures no city side, by name or otherwise, when the metro has no pinned locality", async () => {
    const run = setup(WORLD, { localities: NO_AUSTIN_PIN });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    // The area's two lists only: no city calls, and no area brands with nothing to rank them against.
    expect(run.calls.map((c) => [c.filterType, c.rung])).toEqual([
      ["urn:tag", "POLYGON"],
      ["urn:tag", "POLYGON"],
    ]);
    expect(result.forModel.notices).toEqual([
      "Area read by POLYGON (its gazetteer boundary).",
      "No Qloo locality is pinned for Austin yet; the city side is not measured.",
    ]);
    expect(run.ledger.metrics.map((m) => [m.key, m.value, m.reason, m.badge])).toEqual([
      ["block.new_tag", null, "unavailable", "UNAVAILABLE"],
      ["block.new_tag", null, "unavailable", "UNAVAILABLE"],
      ["block.new_tag", null, "unavailable", "UNAVAILABLE"],
      ["block.new_tag", null, "unavailable", "UNAVAILABLE"],
      ["block.rank_delta", null, "unavailable", "UNAVAILABLE"],
    ]);
    const d = barsOf(run);
    BarsPayload.parse(d.payload);
    expect(d.payload.groups.flatMap((g) => g.bars.flatMap((b) => b.values)).every((v) => v.value === null && v.reason === "unavailable")).toBe(true);
    expect(group(d, "WHAT")?.bars[0]).toMatchObject({ label: "Ramen", ranks: { subject: 2, comparator: null }, isNew: false });
    expect(run.ledger.datasets.map((x) => x.kind)).toEqual(["Bars"]);
    expect(run.ledger.evidences.map((e) => e.purpose)).toEqual(["Tag fingerprint of Riverbend by POLYGON"]);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "block_dna", step: "S3" })).toBe(true);

    // Without the locality seam at all the run reads the same way.
    const bare = setup(WORLD, { localities: null });
    expect((await blockDnaSkill.run(input(), bare.ctx)).status).toBe("partial");
    expect(bare.calls).toHaveLength(2);
  });

  it("gives each concept tag a citable rank against the city, or the reason it has none (CR 5)", async () => {
    const run = setup();
    const reg = (type: string, slugName: string, name: string) =>
      run.registry.registerTag({ tagId: `${type}:test_${slugName}`, name, type, signalCapable: true }).ref;
    const ramen = reg(WHAT, "ramen", "Ramen");
    const taqueria = reg(WHAT, "taqueria", "Taqueria");
    const bakery = reg(WHAT, "bakery", "Bakery");
    const nowhere = reg(WHAT, "nowhere", "Nowhere Hall");
    const result = await blockDnaSkill.run({ ...input(), concept_tags: [ramen, taqueria, bakery, nowhere] }, run.ctx);
    const concept = run.ledger.metrics.filter((m) => m.key === "block.concept_rank");
    expect(concept.map((m) => [m.subjectRefs[0], m.value, m.display, m.badge, m.reason])).toEqual([
      [ramen, 49, "+49 (rank 2 here, outside the top 50 in Austin)", "DERIVED", null],
      [taqueria, -2, "−2 (rank 7 here, rank 5 in Austin)", "DERIVED", null],
      [bakery, -43, "−43 (outside the top 50 here, rank 8 in Austin)", "DERIVED", null],
      [nowhere, null, "not measured", "UNAVAILABLE", "not_measured"],
    ]);
    expect(concept.every((m) => m.formulaId === "block.concept_rank" && m.comparator === "CITY")).toBe(true);
    expect(concept[3]?.label).toContain("not among the top-50 tags of either");
    // No extra call for the concept tags: the six calls of the happy path.
    expect(run.calls).toHaveLength(6);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "block_dna", step: "S3" })).toBe(true);

    const second = setup();
    const keyword = second.registry.registerTag({ tagId: "urn:tag:keyword:qloo:test_loud", name: "Loud", type: "urn:tag:keyword:qloo", signalCapable: true }).ref;
    await blockDnaSkill.run({ ...input(), concept_tags: [keyword] }, second.ctx);
    const none = second.ledger.metrics.find((m) => m.key === "block.concept_rank");
    expect(none).toMatchObject({ value: null, reason: "unavailable", badge: "UNAVAILABLE" });
    expect(none?.label).toContain("block_dna reads only");
  });

  it("returns the fixed method limitations", () => {
    expect(blockDnaSkill.limitations(["LOCATION_FALLBACK"])).toEqual([...SKILL_LIMITATIONS.block_dna]);
    expect(SKILLS.block_dna).toBe(blockDnaSkill);
  });
});

describe("block_dna: the location ladder at run time", () => {
  const atPoint: World = { ...WORLD, POLYGON: { tags: [], music: [], brands: [] }, POINT: WORLD.POLYGON };

  it("steps down to the centre point when the polygon has no tags: a CODE FALLBACK with its finding", async () => {
    const run = setup(atPoint);
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls.map((c) => c.rung)).toEqual(["POLYGON", "POINT", "POINT", "CITY", "CITY", "POINT", "CITY"]);
    const fallback = run.ledger.findings.find((f) => f.kind === "LOCATION_FALLBACK");
    expect(fallback?.text).toBe("Location for Riverbend fell back from the neighbourhood boundary to its centre point, a less precise reading of the area.");
    expect(run.events.filter((e) => e.type === "fallback")).toEqual([
      {
        type: "fallback",
        from: "POLYGON",
        to: "POINT",
        reason: "POLYGON returned no taste tags",
        toolCallId: run.ctx.toolCallId,
        findingId: fallback?.id,
      },
    ]);
    expect(result.flags).toContain("LOCATION_FALLBACK");
    expect(barsOf(run).payload.method).toBe("POINT");
    // The empty rung is a receipt in its own bundle, not a thin result.
    expect(run.ledger.evidences[0]).toMatchObject({ status: "empty", flags: ["LOCATION_FALLBACK"] });
    expect(run.ledger.evidences[1]?.flags).not.toContain("THIN_RESULT");
  });

  it("steps down past a polygon the client fails, keeping no receipt for it", async () => {
    const run = setup({ ...WORLD, POINT: WORLD.POLYGON }, { fail: (c) => c.rung === "POLYGON" });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    const [fallback] = run.events.filter((e) => e.type === "fallback");
    expect(fallback).toMatchObject({ from: "POLYGON", to: "POINT", reason: "the POLYGON call failed (qloo_unavailable)" });
    expect(run.ledger.evidences[0]?.purpose).toBe("Tag fingerprint of Riverbend by POINT");
  });

  it("steps down past a polygon whose family tags all tie at the floor: no relation to the place", async () => {
    const tied = tags([
      [WHO, "Tied Who"],
      [VIBE, "Tied Vibe"],
      [WHAT, "Tied What"],
      [OTHER, "Ranked Outsider"],
    ]).map((r) => (r.subtype === OTHER ? r : { ...r, query: { affinity: 0.2 } }));
    const run = setup({ ...WORLD, POLYGON: { tags: tied, music: AREA_MUSIC }, POINT: WORLD.POLYGON });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.events.filter((e) => e.type === "fallback")).toEqual([
      expect.objectContaining({ from: "POLYGON", to: "POINT", reason: "POLYGON returned no ranked taste tags (all tied at the floor)" }),
    ]);
    expect(barsOf(run).payload.method).toBe("POINT");
    // The tied rung is a receipt flagged NOT_SCORED; the fingerprint is the centre point's.
    expect(run.ledger.evidences[0]).toMatchObject({ status: "empty", flags: ["LOCATION_FALLBACK", "NOT_SCORED"] });
    expect(run.ledger.evidences[1]?.purpose).toBe("Tag fingerprint of Riverbend by POINT");
    expect(group(barsOf(run), "WHO")?.bars[0]?.label).toBe("Vinyl Collectors");
  });

  it("emits each fallback before the follow-on calls", async () => {
    const run = setup({ ...WORLD, POLYGON: { tags: [] }, POINT: WORLD.POLYGON });
    const order: string[] = [];
    const { qloo, emit } = run.ctx;
    const insights: QlooApi["insights"] = (filterType, params) => {
      order.push(`call:${rungOf(params)}`);
      return qloo.insights(filterType, params);
    };
    const ctx = {
      ...run.ctx,
      qloo: { ...qloo, insights },
      emit: (e: Parameters<typeof emit>[0]) => {
        if (e.type === "fallback") order.push("fallback");
        emit(e);
      },
    };
    await blockDnaSkill.run(input(), ctx);
    expect(order.slice(0, 4)).toEqual(["call:POLYGON", "call:POINT", "fallback", "call:POINT"]);
  });

  it("folds missing rungs into one step for a metro without boundaries", async () => {
    const run = setup({ QUERY: WORLD.POLYGON, CITY: WORLD.CITY });
    const result = await blockDnaSkill.run(input({ area: { kind: "nbhd", ref: "east_side", metro: "nashville" } }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls[0]?.params).toEqual({ "signal.location.query": "East Side, Nashville", take: 50 });
    expect(run.calls[2]?.params).toEqual({ "signal.location": "loc-invented-nashville", take: 50 });
    const events = run.events.filter((e) => e.type === "fallback");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from: "POLYGON",
      to: "QUERY",
      reason: "no neighbourhood boundaries for Nashville in this build; no neighbourhood centre for Nashville in this build",
    });
    expect(barsOf(run).payload.method).toBe("QUERY");
  });

  it("is empty when no rung returns tags, with EMPTY_RESULT and every fallback recorded", async () => {
    const run = setup({ CITY: WORLD.CITY });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.calls.map((c) => c.rung)).toEqual(["POLYGON", "POINT", "QUERY"]);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["LOCATION_FALLBACK", "LOCATION_FALLBACK", "EMPTY_RESULT"]);
    expect(run.ledger.findings[2]?.suggestion?.tool).toBe("block_dna");
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.evidences[0]?.status).toBe("empty");
    expect(run.ledger.metrics).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(result.flags).toEqual(["LOCATION_FALLBACK"]);
  });

  it("does not call the area empty when a later rung failed: partial, with a retry notice", async () => {
    const run = setup({ CITY: WORLD.CITY }, { fail: (c) => c.rung === "POINT" || c.rung === "QUERY" });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["LOCATION_FALLBACK", "LOCATION_FALLBACK"]);
    expect(result.forModel.notices).toEqual([
      "2 location calls failed (qloo_unavailable) and the rest returned no ranked taste tags, so nothing was measured; retry block_dna on Riverbend later.",
    ]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["empty"]);

    // The same after one empty rung when the walk stops on the rate limit.
    const qloo = blockQloo({ CITY: WORLD.CITY });
    let n = 0;
    const limited: QlooApi["insights"] = (filterType, params) => {
      n += 1;
      if (n > 1) return Promise.reject(Object.assign(new Error("slow down"), { code: "qloo_rate_limited" }));
      return qloo.api.insights(filterType, params);
    };
    const base = fakeRun({ ...qloo.api, insights: limited }, new FakeRegistry());
    const stopped = await blockDnaSkill.run(input(), { ...base.ctx, geo: fakeGeo(), localities: PINS } as typeof base.ctx);
    expect(stopped.status).toBe("partial");
    expect(n).toBe(2);
    expect(base.ledger.findings.map((f) => f.kind)).toEqual(["LOCATION_FALLBACK"]);
  });

  it("hands the error to the caller when every rung fails and nothing is in the ledger", async () => {
    const run = setup(WORLD, { fail: (c) => c.rung !== "CITY" });
    await expect(blockDnaSkill.run(input(), run.ctx)).rejects.toThrow("synthetic outage");
    expect(run.ledger.findings).toHaveLength(0);
    expect(run.events).toHaveLength(0);
  });

  it("stops the ladder on an error no other rung can fix", async () => {
    const qloo = blockQloo(WORLD);
    const base = fakeRun(
      {
        ...qloo.api,
        insights: async () => {
          throw Object.assign(new Error("key rejected"), { code: "qloo_auth" });
        },
      },
      new FakeRegistry(),
    );
    const ctx = { ...base.ctx, geo: fakeGeo() };
    const spy = vi.spyOn(ctx.qloo, "insights");
    await expect(blockDnaSkill.run(input(), ctx)).rejects.toThrow("key rejected");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses bad areas without a call", async () => {
    const run = setup();
    const result = await blockDnaSkill.run(input({ area: { kind: "nbhd", ref: "nowhere", metro: "austin" } }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toContain("not a neighbourhood in the Austin AREAS list");
    expect(run.calls).toHaveLength(0);
  });
});

describe("block_dna: partial, truncated and unscored results", () => {
  it("returns partial with nothing recorded when the budget refuses the first call", async () => {
    const run = setup(WORLD, { budget: 0 });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.events.filter((e) => e.type === "fallback")).toHaveLength(0);
  });

  it("records every comparison the budget cut as not measured, never as 0", async () => {
    // The area call and its music list fit; the city lists and brands are refused.
    const run = setup(WORLD, { budget: 2 });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    const newCounts = run.ledger.metrics.filter((m) => m.key === "block.new_tag");
    expect(newCounts).toHaveLength(4);
    expect(newCounts.every((m) => m.value === null && m.reason === "budget_truncated" && m.badge === "UNAVAILABLE")).toBe(true);
    expect(newCounts[0]?.display).toBe("not measured");
    const brandGap = run.ledger.metrics.find((m) => m.label.startsWith("brands favoured in"));
    expect(brandGap).toMatchObject({ value: null, reason: "budget_truncated", badge: "UNAVAILABLE" });
    const d = barsOf(run);
    BarsPayload.parse(d.payload);
    const values = d.payload.groups.flatMap((g) => g.bars.flatMap((b) => b.values));
    expect(values.every((v) => v.value === null && v.reason === "budget_truncated")).toBe(true);
    expect(group(d, "WHO")?.bars[0]).toMatchObject({ label: "Night Owls", ranks: { subject: 1, comparator: null }, isNew: false });
    expect(result.forModel.notices).toContain("Venue-goer, ambience and venue tags are not compared: the Austin tag list is missing (budget_truncated).");
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "block_dna", step: "S3" })).toBe(true);
  });

  it("shows SOUND as not measured at city scale when the city music call fails", async () => {
    const run = setup(WORLD, { fail: (c) => c.rung === "CITY" && c.params["filter.tag.types"] !== undefined });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("Music is not measured at city scale (error).");
    expect(result.forModel.notices.some((n) => n.startsWith("1 of 5 follow-on calls failed (qloo_unavailable)"))).toBe(true);
    const sound = group(barsOf(run), "SOUND");
    expect(sound?.bars.map((b) => [b.label, b.values[0]])).toEqual([
      ["Jazz", { value: null, reason: "error" }],
      ["Americana", { value: null, reason: "error" }],
      ["Soul", { value: null, reason: "error" }],
      ["Country", { value: null, reason: "error" }],
      ["Folk", { value: null, reason: "error" }],
    ]);
    const soundCount = run.ledger.metrics.filter((m) => m.key === "block.new_tag").at(-1);
    expect(soundCount).toMatchObject({ value: null, reason: "error" });
    const cityEvidence = run.ledger.evidences.find((e) => e.purpose.startsWith("City tag fingerprint"));
    expect(cityEvidence?.status).toBe("partial");
    // The other families still compare.
    expect(group(barsOf(run), "WHAT")?.bars[0]?.values[0]).toEqual({ value: 49, reason: null });
  });

  it("flags thin and stale answers and floor ties in tag lists", async () => {
    const thin = tags([
      [WHO, "Only One"],
      [WHAT, "Tied One"],
      [VIBE, "Tied Two"],
    ]).map((r, i) => (i === 0 ? r : { ...r, query: { affinity: 0.1 } }));
    const run = setup({ POLYGON: { tags: thin, music: AREA_MUSIC }, CITY: WORLD.CITY }, { stale: true });
    const result = await blockDnaSkill.run(input({ include_brands: false }), run.ctx);
    expect(result.flags).toEqual(["STALE_CACHE", "NOT_SCORED", "THIN_RESULT"]);
    const what = group(barsOf(run), "WHAT")?.bars.find((b) => b.label === "Tied One");
    // Tied at the floor: present but unranked, so it counts as missing (51) on both sides: no bar, never NEW.
    expect(what).toBeUndefined();
    expect(run.ledger.evidences[0]?.summary).toBe(
      "POLYGON: 1 taste tag, 2 tied at the floor and not ranked (WHO 1, VIBE 1, WHAT 1); 5 music tags.",
    );
  });

  it("records SOUND as not measured when the area has no music tags, never as city-wide losses", async () => {
    const run = setup({ POLYGON: { tags: AREA_TAGS, music: [] }, CITY: WORLD.CITY });
    const result = await blockDnaSkill.run(input({ include_brands: false }), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("No music tags came back for this area, so music is not measured.");
    expect(group(barsOf(run), "SOUND")).toBeUndefined();
    const sound = run.ledger.metrics.filter((m) => m.label.includes("SOUND"));
    expect(sound.map((m) => [m.key, m.value, m.reason, m.badge])).toEqual([["block.new_tag", null, "not_measured", "UNAVAILABLE"]]);
    // An answer with no rows is still a thin result.
    expect(result.flags).toEqual(["THIN_RESULT"]);
    expect(run.ledger.evidences[0]?.summary).toBe("POLYGON: 9 taste tags (WHO 3, VIBE 2, WHAT 4); 0 music tags.");
  });

  it("raises EMPTY_RESULT for local brands when the area brand call answers with none", async () => {
    const run = setup({ POLYGON: { tags: AREA_TAGS, music: AREA_MUSIC, brands: [] }, CITY: WORLD.CITY });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    const empty = run.ledger.findings.find((f) => f.kind === "EMPTY_RESULT");
    expect(empty?.text).toBe("The search for brands favoured in Riverbend returned no usable results.");
    expect(empty?.suggestion?.tool).toBe("rank_candidates");
    expect(run.ledger.evidences.find((e) => e.purpose.startsWith("Local brands"))?.status).toBe("empty");
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Bars"]);
  });
});

describe("block_dna: estimateCalls", () => {
  const registry = new FakeRegistry();
  const point = { kind: "point", ref: "-97.73,30.26", metro: "austin" } as const;
  const pointLocation = { "signal.location": "POINT(-97.73 30.26)" };

  it("counts six calls cold and nothing for a point area once everything is cached", async () => {
    const cold = fakeProbe(() => false);
    expect(await estimateBlockDnaCalls(input({ area: point }), cold, PINS)).toBe(6);
    expect(cold.asked).toHaveLength(6);
    expect(cold.asked[0]).toEqual({ path: "/v2/insights", params: { "filter.type": "urn:tag", ...tagParams(cityLocation(AUSTIN), false) } });
    expect(cold.asked[0]?.params["signal.location"]).toBe("loc-invented-austin");
    expect(cold.asked[3]).toEqual({ path: "/v2/insights", params: { "filter.type": "urn:tag", ...tagParams(pointLocation, false) } });
    const warm = fakeProbe(() => true);
    expect(await estimateBlockDnaCalls(input({ area: point }), warm, PINS)).toBe(0);
    // Without the locality pins the city side cannot be keyed, so it counts as uncached.
    expect(await blockDnaSkill.estimateCalls(input({ area: point }), warm, registry)).toBe(3);
    expect(await blockDnaSkill.estimateCalls(input({ area: point }), cold, registry)).toBe(6);
  });

  it("probes the pinned city side and counts a neighbourhood's area calls, which need the gazetteer", async () => {
    const cityWarm = fakeProbe((_, p) => p["signal.location"] === AUSTIN.entityId);
    expect(await estimateBlockDnaCalls(input(), cityWarm, PINS)).toBe(3);
    expect(cityWarm.asked).toHaveLength(3);
    expect(await estimateBlockDnaCalls(input({ include_brands: false }), cityWarm, PINS)).toBe(2);
    expect(await estimateBlockDnaCalls(input({ area: point, include_brands: false }), cityWarm, PINS)).toBe(2);
  });

  it("counts no city side and no area brands for a metro with no pinned locality", async () => {
    const cold = fakeProbe(() => false);
    expect(await estimateBlockDnaCalls(input(), cold, NO_AUSTIN_PIN)).toBe(2);
    expect(cold.asked).toHaveLength(0);
    expect(await estimateBlockDnaCalls(input({ area: point }), cold, NO_AUSTIN_PIN)).toBe(2);
    expect(cold.asked.map((a) => a.params["signal.location"])).toEqual(["POINT(-97.73 30.26)", "POINT(-97.73 30.26)"]);
  });

  it("costs nothing for a point the run would refuse", async () => {
    const probe = fakeProbe(() => false);
    expect(await estimateBlockDnaCalls(input({ area: { kind: "point", ref: "-96.80,32.78", metro: "austin" } }), probe, PINS)).toBe(0);
    expect(probe.asked).toHaveLength(0);
  });
});

describe("block_dna: digest budget", () => {
  it("fits the worst case: long names, every family with its loss, four local brands, two fallbacks and BLOCK_NEW_TAGS", async () => {
    const long = (n: string) => `${n} Extended Neighbourhood Name Here`;
    const nth = (type: string, prefix: string, i: number): [string, string] => [type, long(`${prefix} ${i + 1}`)];
    // Families interleaved, so WHAT tags sit in the area top 20 and all of them are NEW. The two top
    // WHAT gains are dishes, so the follow-up names NEW taxonomy tags outside the top gains by ref.
    const areaTags = tags(
      Array.from({ length: 10 }, (_, i) => [nth(WHO, "Who", i), nth(VIBE, "Vibe", i), nth(i < 2 ? DISH : WHAT, "What", i)]).flat(),
      0.95,
      0.005,
    );
    // Every music tag is NEW too, but the one finding is WHAT's.
    const areaMusic = tags(Array.from({ length: 10 }, (_, i) => nth(SOUND, "Sound", i)), 0.95, 0.005);
    const brandsHere = brandRows(Array.from({ length: 8 }, (_, i) => brand(long(`Local Brand ${i + 1}`))));
    const run = setup({
      POLYGON: { tags: [] },
      POINT: { tags: [] },
      QUERY: { tags: areaTags, music: areaMusic, brands: brandsHere },
      CITY: { tags: CITY_TAGS, music: CITY_MUSIC, brands: CITY_BRANDS },
    });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["LOCATION_FALLBACK", "LOCATION_FALLBACK", "BLOCK_NEW_TAGS"]);
    // The finding cites its NEW count and the gains of its NEW tags; the signal tags go by ref.
    const what = run.ledger.findings[2];
    const label = (id: string) => run.ledger.metric(id)?.label.slice(0, 28) ?? "";
    expect(what?.metricIds.map(label)).toEqual(["NEW WHAT tags in Riverbend (", "rank gain vs Austin: What 1 ", "rank gain vs Austin: What 2 "]);
    const named = [...(what?.suggestion?.reason ?? "").matchAll(/\((T\d+)\)/g)].map((m) => run.registry.tag(m[1]!)?.name);
    expect(named).toEqual([long("What 3"), long("What 4"), long("What 5")]);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "block_dna", step: "S3" })).toBe(true);
    // Rows are cut from the end to fit, never metrics or findings: the tag rows (T# refs) stay, and a
    // local brand whose row is cut keeps its ref in `registered` and its metric.
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.findings.map((f) => f.id)).toEqual(run.ledger.findings.map((f) => f.id));
    expect(digest.top_rows.slice(0, 8).every((r) => r.ref?.startsWith("T"))).toBe(true);
    expect(digest.top_rows.slice(0, 2).map((r) => r.values.family)).toEqual(["WHAT", "WHAT"]);
    expect(digest.registered.map((e) => e.ref)).toEqual(["R1", "R2", "R3", "R4"]);
    const kept = digest.top_rows.length;
    if (kept < 12) expect(digest.notices[0]).toBe(`${12 - kept} of 12 rows left out to fit this result; the full table is in D1, D2.`);
    // Two gains, the largest loss and the NEW count per family, then four local brands.
    expect(run.ledger.metrics).toHaveLength(4 * 4 + 4);
    expect(digest.metrics.filter((m) => m.label.startsWith("rank loss")).map((m) => m.display)).toEqual([
      "−50 · outside the top 50 here",
      "−48 · outside the top 50 here",
      "−49 · outside the top 50 here",
      "−50 · outside the top 50 here",
    ]);
    // Ten gains, and the four city WHO tags the area lacks as losses.
    expect(group(barsOf(run), "WHO")?.bars).toHaveLength(10 + 4);

    // The same worst case with four long concept tags (CR 5): their metrics still fit, never dropped.
    const withConcepts = setup({
      POLYGON: { tags: [] },
      POINT: { tags: [] },
      QUERY: { tags: areaTags, music: areaMusic, brands: brandsHere },
      CITY: { tags: CITY_TAGS, music: CITY_MUSIC, brands: CITY_BRANDS },
    });
    const conceptRefs = [nth(WHAT, "What", 5), nth(SOUND, "Sound", 2), nth(WHAT, "Absent", 0), nth("urn:tag:keyword:qloo", "Keyword", 0)].map(
      ([type, name]) => withConcepts.registry.registerTag({ tagId: `${type}:test_${slug(name)}`, name, type, signalCapable: true }).ref,
    );
    const conceptResult = await blockDnaSkill.run({ ...input(), concept_tags: conceptRefs }, withConcepts.ctx);
    const conceptDigest = ModelDigest.parse(conceptResult.forModel);
    expect(digestFits(conceptDigest, { tool: "block_dna", step: "S3" })).toBe(true);
    expect(conceptDigest.metrics.filter((m) => withConcepts.ledger.metric(m.id)?.key === "block.concept_rank")).toHaveLength(4);
  });
});
