import {
  DatasetEnvelope,
  digestFits,
  ModelDigest,
  type DatasetOf,
  type GeoApi,
  type InsightsFilterType,
  type InsightsResponse,
  type LocalityApi,
  type MarketId,
  type MetroId,
  type QlooApi,
  type QlooEntity,
  type QlooHeatmapCell,
  type QlooParams,
  type QlooResult,
} from "@ct/contracts";
import ngeohash from "ngeohash";
import { describe, expect, it } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { curatedConcept, HEATMAP_BASELINE } from "../../src/skills/findTags/curated";
import { estimateGeoLiftCalls, geoLiftSkill, PLACES_TAKE } from "../../src/skills/geoLift";
import { MIN_BUSY_AREA_VENUES, THIN_SUPPLY_LABEL } from "../../src/skills/geoLift/lift";
import { BudgetError, fakeProbe, fakeRun, FakeRegistry, FETCHED_AT } from "./support/fakes";

// A synthetic metro on public Austin coordinates: four invented neighbourhoods, invented tags with
// public taxonomy namespaces, an invented locality id and invented venues (D29). The supply filter is
// the public wine bar category URN from config/categories.json, since geo_lift counts similar venues
// only with a probe-verified category tag; UNVERIFIED is an invented one.

const LOCALITY = "loc-synthetic-austin";
const GENRE = "urn:tag:genre:place:test_wine_bar";
const CATEGORY = "urn:tag:category:place:wine_bar";
const UNVERIFIED = "urn:tag:category:place:test_wine_cellar";
const DESCRIPTIVE = "urn:tag:cuisine:qloo:test_natural_wine";
const ANALOG = "ent-analog-venue-01";

interface Box {
  id: string;
  name: string;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const BOX = { minLat: 30.25, maxLat: 30.27, minLon: -97.76, maxLon: -97.74 };
const QUADRANTS: Box[] = [
  { id: "alder_flats", name: "Alder Flats", minLat: 30.26, maxLat: 30.27, minLon: -97.76, maxLon: -97.75 },
  { id: "birch_hollow", name: "Birch Hollow", minLat: 30.26, maxLat: 30.27, minLon: -97.75, maxLon: -97.74 },
  { id: "cedar_point", name: "Cedar Point", minLat: 30.25, maxLat: 30.26, minLon: -97.76, maxLon: -97.75 },
  { id: "dunmore_yards", name: "Dunmore Yards", minLat: 30.25, maxLat: 30.26, minLon: -97.75, maxLon: -97.74 },
];
const FAR_AWAY: Box = { id: "elm_reach", name: "Elm Reach", minLat: 30.4, maxLat: 30.41, minLon: -97.9, maxLon: -97.89 };

const km2 = (b: Box) => (b.maxLat - b.minLat) * 111.32 * (b.maxLon - b.minLon) * 111.32 * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180);
const inside = (b: Box, lat: number, lon: number) => lat >= b.minLat && lat < b.maxLat && lon >= b.minLon && lon < b.maxLon;

function fakeGeo(boxes: readonly Box[]): GeoApi {
  const unused = (): never => {
    throw new Error("unused geo call");
  };
  return {
    metros: () => ["nashville", "austin"],
    neighbourhoods: (metro) =>
      metro === "austin"
        ? boxes.map((b) => ({ id: b.id, name: b.name, metro, centroid: { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 }, areaKm2: km2(b) }))
        : [],
    neighbourhood: unused,
    matchNeighbourhood: unused,
    polygonWkt: unused,
    locate: (metro, p) => (metro === "austin" ? (boxes.find((b) => inside(b, p.lat, p.lon))?.id ?? null) : null),
    geohashCentroid: (g) => {
      const { latitude, longitude } = ngeohash.decode(g);
      return { lat: latitude, lon: longitude };
    },
    boundarySource: (metro) => (metro === "austin" ? "Synthetic test boundaries" : "No neighbourhood boundaries for Nashville in this build."),
  };
}

const PINS: LocalityApi = {
  market: async (id: MarketId) => (id === "austin" ? { entityId: LOCALITY, label: "Austin" } : id === "nashville" ? { entityId: "loc-synthetic-nashville", label: "Nashville" } : null),
};

// The world ------------------------------------------------------------------------------------------

/** Deterministic jitter in [0, 1). */
const noise = (i: number) => ((i * 7919) % 101) / 101;

/** Restaurants concentrate in the south-west; the concept has a pocket in the north-east (Birch Hollow). */
function baselineAffinity(lat: number, lon: number, i: number): number {
  const south = 1 - (lat - BOX.minLat) / (BOX.maxLat - BOX.minLat);
  const west = 1 - (lon - BOX.minLon) / (BOX.maxLon - BOX.minLon);
  return 0.2 + 0.3 * south + 0.3 * west + 0.05 * noise(i);
}

function conceptAffinity(lat: number, lon: number, i: number): number {
  const d2 = (lat - 30.265) ** 2 + (lon + 97.745) ** 2;
  return 0.25 + 0.2 * noise(i + 3) + 0.5 * Math.exp(-d2 / 0.004 ** 2);
}

function rows(precision: number, affinity: (lat: number, lon: number, i: number) => number, box = BOX): QlooHeatmapCell[] {
  return ngeohash
    .bboxes(box.minLat, box.minLon, box.maxLat, box.maxLon, precision)
    .sort()
    .map((geohash, i) => {
      const { latitude, longitude } = ngeohash.decode(geohash);
      return { location: { latitude, longitude, geohash }, query: { affinity: Math.round(affinity(latitude, longitude, i) * 1e6) / 1e6 } };
    });
}

/** Venues per neighbourhood, spread over its box; one more venue has no location. */
function venues(counts: Readonly<Record<string, number>>): QlooEntity[] {
  const out: QlooEntity[] = [];
  for (const b of QUADRANTS) {
    for (let k = 0; k < (counts[b.id] ?? 0); k++) {
      const lat = b.minLat + (((k * 37) % 97) + 0.5) / 97 * (b.maxLat - b.minLat);
      const lon = b.minLon + (((k * 61) % 89) + 0.5) / 89 * (b.maxLon - b.minLon);
      out.push({ entity_id: `ent-venue-${b.id}-${k}`, name: `Venue ${b.name} ${k}`, popularity: 0.4, location: { lat, lon } });
    }
  }
  if (out.length > 0) out.push({ entity_id: "ent-venue-unlocated", name: "Venue Without Location", popularity: 0.4 });
  return out;
}

const SUPPLY = { alder_flats: 15, birch_hollow: 3, cedar_point: 40, dunmore_yards: 25 };

interface World {
  concept?: QlooHeatmapCell[];
  baseline?: QlooHeatmapCell[];
  analog?: QlooHeatmapCell[];
  venues?: QlooEntity[];
}

function defaultWorld(): Required<World> {
  const baseline = rows(7, baselineAffinity);
  const cutoff = [...baseline].map((r) => r.query.affinity).sort((a, b) => b - a)[Math.floor(baseline.length / 5)] ?? 0;
  return {
    concept: rows(7, conceptAffinity),
    baseline,
    // An analog map covers about a fifth of the cells, the most popular ones (P5).
    analog: baseline.filter((r) => r.query.affinity >= cutoff).map((r, i) => ({ ...r, query: { affinity: r.query.affinity * (0.9 + 0.1 * noise(i)) } })),
    venues: venues(SUPPLY),
  };
}

interface Call {
  filterType: string;
  params: QlooParams;
}

interface QlooOptions {
  /** Network calls allowed before BudgetError, counted when a call reaches the gate; cached calls are free. */
  budget?: number;
  fail?: (call: Call) => boolean;
  cached?: (call: Call) => boolean;
  /** Milliseconds the cache lookup takes before a call reaches the budget gate, as in the real client. */
  lookupMs?: (call: Call) => number;
}

function liftQloo(world: World = {}, options: QlooOptions = {}) {
  const w = { ...defaultWorld(), ...world };
  const calls: Call[] = [];
  let spent = 0;
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const list = (v: QlooParams[string] | undefined) => (v === undefined ? [] : typeof v === "object" ? [...v] : [String(v)]);
  const api: QlooApi = {
    search: unused,
    entities: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      const call = { filterType, params };
      const lookup = options.lookupMs?.(call) ?? 0;
      if (lookup > 0) await new Promise((resolve) => setTimeout(resolve, lookup));
      if (!options.cached?.(call)) {
        spent += 1;
        if (options.budget !== undefined && spent > options.budget) throw new BudgetError("run cap reached");
      }
      calls.push(call);
      if (options.fail?.(call)) throw Object.assign(new Error("upstream down"), { code: "qloo_unavailable" });
      let data: unknown;
      if (filterType === "urn:heatmap") {
        const tags = list(params["signal.interests.tags"]);
        const heatmap = tags.length === 0 ? w.analog : tags.length === 1 && tags[0] === HEATMAP_BASELINE.tagId ? w.baseline : w.concept;
        data = { results: { heatmap } };
      } else {
        const take = Number(params.take);
        const page = Number(params.page);
        data = { results: { entities: w.venues.slice((page - 1) * take, page * take) } };
      }
      return {
        data: data as InsightsResponse<F>,
        meta: { qlooCallId: `qc-${calls.length}`, requestId: `req-synthetic-${calls.length}`, cache: "miss", fetchedAt: FETCHED_AT, ms: 6, stale: false, originRunId: null },
      };
    },
  };
  return { api, calls };
}

function setup(options: QlooOptions & { world?: World; boxes?: Box[]; pins?: LocalityApi | null } = {}) {
  const registry = new FakeRegistry();
  registry.registerTag({ tagId: GENRE, name: "Wine Bar", type: "urn:tag:genre:place", signalCapable: true });
  registry.registerTag({ tagId: CATEGORY, name: "Wine Bar", type: "urn:tag:category:place", signalCapable: true });
  registry.registerTag({ tagId: DESCRIPTIVE, name: "Natural Wine", type: "urn:tag:cuisine:qloo", signalCapable: false });
  registry.registerTag({ tagId: HEATMAP_BASELINE.tagId, name: "Restaurant", type: "urn:tag:genre:place", signalCapable: true });
  registry.registerEntity({ entityId: ANALOG, name: "Analog Venue One", type: "place", popularity: 0.6, disambiguation: null, tags: [] });
  registry.registerTag({ tagId: UNVERIFIED, name: "Wine Cellar", type: "urn:tag:category:place", signalCapable: true });
  const qloo = liftQloo(options.world, options);
  const run = fakeRun(qloo.api, registry);
  const pins = options.pins === undefined ? PINS : options.pins;
  const ctx = { ...run.ctx, pillar: "location" as const, geo: fakeGeo(options.boxes ?? QUADRANTS), localities: pins };
  return { ...run, ctx, calls: qloo.calls };
}

function input(raw: Partial<{ metro: MetroId; concept_tags: string[]; concept_entities: string[]; supply: boolean; focus_areas: string[] }> = {}) {
  return geoLiftSkill.input.parse({
    metro: "austin",
    concept_tags: ["T1", "T2"],
    concept_entities: [],
    supply: true,
    trigger_finding_id: null,
    step_id: "S2",
    ...raw,
  });
}

function liftMap(run: ReturnType<typeof setup>): DatasetOf<"GeoLift"> {
  const d = run.ledger.datasets[0];
  if (d?.kind !== "GeoLift") throw new Error("expected a GeoLift dataset");
  return DatasetEnvelope.parse(d) as DatasetOf<"GeoLift">;
}

const metricsOf = (run: ReturnType<typeof setup>, key: string) => run.ledger.metrics.filter((m) => m.key === key);

// Tests ------------------------------------------------------------------------------------------------

describe("geo_lift: requests", () => {
  it("sends genre tags to the heatmap and category tags to the places sample, with no operator or dimensions", async () => {
    const run = setup();
    await geoLiftSkill.run(input(), run.ctx);

    expect(run.calls.map((c) => c.filterType)).toEqual(["urn:heatmap", "urn:heatmap", "urn:entity:place", "urn:entity:place"]);
    expect(run.calls[0]?.params).toEqual({ "filter.location": LOCALITY, "signal.interests.tags": [GENRE] });
    expect(run.calls[1]?.params).toEqual({ "filter.location": LOCALITY, "signal.interests.tags": [HEATMAP_BASELINE.tagId] });
    expect(run.calls[2]?.params).toEqual({ "filter.location": LOCALITY, "filter.tags": [CATEGORY], take: PLACES_TAKE, page: 1 });
    expect(run.calls[3]?.params).toMatchObject({ page: 2 });
    for (const c of run.calls) expect(Object.keys(c.params).some((k) => k.startsWith("operator") || k.includes("dimensions"))).toBe(false);
  });

  it("sends analogs in their own concept call, only when no genre tag fits", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ concept_tags: ["T2"], concept_entities: ["R1"] }), run.ctx);
    expect(run.calls[0]?.params).toEqual({ "filter.location": LOCALITY, "signal.interests.entities": [ANALOG] });
    expect(result.forModel.notices.join(" ")).toMatch(/analog map covers only part of the metro/);
    expect(liftMap(run).payload.concept).toEqual({ label: "Analogs of Analog Venue One", tagRefs: [], entityRefs: ["R1"] });
  });

  it("leaves analogs out when genre tags set the map", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ concept_entities: ["R1"] }), run.ctx);
    expect(run.calls[0]?.params).toEqual({ "filter.location": LOCALITY, "signal.interests.tags": [GENRE] });
    expect(result.forModel.notices.join(" ")).toMatch(/analogs \(R1\) were not sent/);
  });

  it("leaves the restaurant baseline out of a concept that has a more specific genre tag", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ concept_tags: ["T1", "T4", "T2"] }), run.ctx);
    expect(run.calls[0]?.params).toEqual({ "filter.location": LOCALITY, "signal.interests.tags": [GENRE] });
    expect(result.forModel.notices).toContain("T4 (Restaurant) is the restaurant baseline, left out of the concept: lift is measured against it.");
    expect(liftMap(run).payload.concept.tagRefs).toEqual(["T1"]);
    const sent = new Set(run.calls.map((c) => JSON.stringify({ "filter.type": c.filterType, ...c.params })));
    const probe = fakeProbe((_, p) => sent.has(JSON.stringify(p)));
    expect(await estimateGeoLiftCalls(input({ concept_tags: ["T1", "T4", "T2"] }), probe, run.registry, PINS)).toBe(0);
  });

  it("fetches no second page after a short first one", async () => {
    const run = setup({ world: { venues: venues({ birch_hollow: 3, cedar_point: 10 }) } });
    await geoLiftSkill.run(input(), run.ctx);
    expect(run.calls.filter((c) => c.filterType === "urn:entity:place")).toHaveLength(1);
    expect(liftMap(run).payload.supply).toMatchObject({ source: "places_sample", capped: false });
  });

  it("answers an error with no calls without a genre tag or analogs", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ concept_tags: ["T2", "T3"] }), run.ctx);
    expect(result.status).toBe("error");
    expect(run.calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(result.forModel.notices[0]).toMatch(/T3 \(Natural Wine\) is not a place taxonomy tag \(a descriptive tag gives an empty map\)/);
    expect(result.forModel.notices[0]).toMatch(/needs a genre:place concept tag/);
  });

  it("answers an error with no calls when no locality is pinned", async () => {
    for (const pins of [null, { market: async () => null }]) {
      const run = setup({ pins });
      const result = await geoLiftSkill.run(input(), run.ctx);
      expect(result.status).toBe("error");
      expect(result.forModel.notices).toEqual(["No Qloo locality is pinned for Austin yet, so its heatmaps cannot be requested."]);
      expect(run.calls).toHaveLength(0);
    }
  });
});

describe("geo_lift: the lift map", () => {
  it("finds the concept's pocket, rolls it up and marks it latent and open", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input(), run.ctx);

    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["SUPPLY_SAMPLE_ONLY"]);
    expect(run.ledger.evidences.map((e) => [e.purpose, e.status])).toEqual([
      ["Concept heatmap for Wine Bar in Austin", "ok"],
      ["Pinned restaurants baseline heatmap for Austin", "ok"],
      ["Places sample (Wine Bar) in Austin for supply", "ok"],
    ]);
    expect(run.ledger.evidences[2]?.qlooCallIds).toHaveLength(2);

    // KPI order: precision first, then lifts from the highest.
    const [precision, ...rest] = run.ledger.metrics;
    expect(precision).toMatchObject({ key: "lift.precision", formulaId: "lift.confidence", value: 1, display: "gh7 · 1.00", badge: "DERIVED" });
    const lifts = metricsOf(run, "lift.area");
    expect(lifts[0]?.subjectRefs).toEqual(["birch_hollow", "T1"]);
    expect(lifts.every((m) => m.formulaId === "lift.area" && m.badge === "ESTIMATED" && m.comparator === "BASELINE" && m.unit === "lift")).toBe(true);
    const values = lifts.map((m) => m.value ?? Number.NaN);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(lifts[0]?.display).toMatch(/^\d+\.\d\d×$/);
    expect(metricsOf(run, "lift.confidence").slice(1).every((m) => m.formulaId === "lift.confidence" && m.badge === "DERIVED")).toBe(true);
    const ws = metricsOf(run, "lift.white_space");
    expect(ws[0]).toMatchObject({ subjectRefs: ["birch_hollow", "T1"], formulaId: "lift.white_space", badge: "ESTIMATED" });
    expect(ws[0]?.display).toMatch(/Latent & open$/);
    expect(ws[0]?.evidenceIds).toEqual(["E1", "E2", "E3"]);
    for (const m of [precision, ...rest]) expect(m?.evidenceIds.length).toBeGreaterThan(0);

    const d = liftMap(run);
    expect(d.title).toBe("Lift Map · Wine Bar in Austin");
    expect(d.formulaIds).toEqual(["lift.cell", "lift.area", "lift.confidence", "lift.white_space"]);
    expect(d.payload).toMatchObject({ metro: "austin", precision: 7, precisionFactor: 1, coarse: false, boundarySource: "Synthetic test boundaries" });
    expect(d.payload.baseline).toEqual({ label: "Restaurants", tag: HEATMAP_BASELINE.tagId });
    const birch = d.payload.neighbourhoods.find((n) => n.id === "birch_hollow");
    expect(birch).toMatchObject({ quadrant: "LATENT_OPEN", supplyCount: 3, reason: null });
    expect(birch?.lift).toBeGreaterThan(1);
    expect(d.payload.neighbourhoods[0]?.id).toBe("birch_hollow");
    expect(d.payload.cells.some((c) => c.lift !== null && c.gated && c.conf === 1)).toBe(true);
    expect(d.payload.cells.every((c) => (c.lift === null) === !c.gated || c.base === null)).toBe(true);
    expect(d.payload.supply?.points).toHaveLength(83);
    expect(d.payload.supply?.capped).toBe(false);

    const latent = run.ledger.findings.find((f) => f.kind === "LATENT_DEMAND");
    expect(latent?.text).toContain("Birch Hollow");
    expect(latent?.suggestion?.tool).toBe("block_dna");
    expect(latent?.metricIds).toContain(ws[0]?.id);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "geo_lift", step: "S2" })).toBe(true);
    expect(digest.top_rows[0]).toMatchObject({ ref: null, name: "Birch Hollow", values: { area: "birch_hollow", lift_rank: 1, lift_metric: lifts[0]?.id, quadrant: "Latent & open" } });
    expect(JSON.stringify(digest)).not.toContain(LOCALITY);
  });

  it("shows unmeasured neighbourhoods as not measured, never as zero", async () => {
    const run = setup({ boxes: [...QUADRANTS, FAR_AWAY] });
    const result = await geoLiftSkill.run(input(), run.ctx);
    const far = liftMap(run).payload.neighbourhoods.find((n) => n.id === "elm_reach");
    expect(far).toMatchObject({ lift: null, conf: null, demandPct: null, reason: "not_measured", supplyCount: 0, supplyPct: null, whiteSpace: null });
    expect(result.forModel.top_rows.some((r) => r.values.area === "elm_reach")).toBe(false);
    expect(run.ledger.metrics.filter((m) => m.key === "lift.area").every((m) => m.value !== 0)).toBe(true);
    for (const row of result.forModel.top_rows) {
      if (row.values.lift_metric === undefined) expect(row.values.unscored).toMatch(/insufficient_n|not_measured/);
    }
  });

  it("reads an analog map only over the cells it covers", async () => {
    const run = setup();
    await geoLiftSkill.run(input({ concept_tags: ["T2"], concept_entities: ["R1"] }), run.ctx);
    const d = liftMap(run).payload;
    const covered = d.cells.filter((c) => c.raw !== null);
    expect(covered.length).toBeLessThan(d.cells.length / 3);
    expect(d.cells.filter((c) => c.raw === null).every((c) => c.lift === null && !c.gated)).toBe(true);
    expect(d.neighbourhoods.find((n) => n.id === "birch_hollow")).toMatchObject({ lift: null, reason: "not_measured" });
  });

  it("gives every neighbourhood lift 1 when the concept is the baseline", async () => {
    const world = defaultWorld();
    const run = setup({ world: { concept: world.baseline } });
    const result = await geoLiftSkill.run(input({ concept_tags: ["T4"], supply: false }), run.ctx);
    expect(result.forModel.notices).toContain("The concept tag is the restaurant baseline itself, so every lift is 1 by construction.");
    const lifts = liftMap(run).payload.neighbourhoods.flatMap((n) => (n.lift === null ? [] : [n.lift]));
    expect(lifts.length).toBeGreaterThan(0);
    for (const l of lifts) expect(l).toBeCloseTo(1, 12);
  });

  it("reports EMPTY_RESULT for an empty concept map and builds no map", async () => {
    const run = setup({ world: { concept: [] } });
    const result = await geoLiftSkill.run(input({ supply: false }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.findings[0]).toMatchObject({ kind: "EMPTY_RESULT", suggestion: { tool: "find_tags" } });
    expect(run.ledger.evidences[0]).toMatchObject({ status: "empty", flags: ["THIN_RESULT"] });
    expect(run.ledger.metrics).toHaveLength(1);
    expect(run.ledger.metrics[0]).toMatchObject({ key: "lift.area", value: null, reason: "not_measured", badge: "UNAVAILABLE" });
  });

  it("reads an empty baseline as a gap with EMPTY_RESULT, not as too few gated cells", async () => {
    const run = setup({ world: { baseline: [] } });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.calls.every((c) => c.filterType === "urn:heatmap")).toBe(true);
    expect(run.ledger.evidences[1]).toMatchObject({ purpose: "Pinned restaurants baseline heatmap for Austin", status: "empty" });
    expect(run.ledger.findings).toMatchObject([
      { kind: "EMPTY_RESULT", text: "The pinned restaurant baseline heatmap for Austin returned no usable results.", suggestion: null },
    ]);
    const d = liftMap(run).payload;
    expect(d.neighbourhoods.every((n) => n.lift === null && n.reason === "unavailable" && n.supplyCount === null)).toBe(true);
    expect(metricsOf(run, "lift.area")).toMatchObject([{ value: null, reason: "unavailable" }]);
    const notices = result.forModel.notices.join(" ");
    expect(notices).toMatch(/baseline came back empty: the map shows raw heat only/);
    expect(notices).not.toMatch(/gated cells a lift needs/);
  });

  it("reads maps that share no cell as not measured", async () => {
    const far = { minLat: 30.4, maxLat: 30.42, minLon: -97.9, maxLon: -97.88 };
    const run = setup({ world: { baseline: rows(7, baselineAffinity, far) } });
    const result = await geoLiftSkill.run(input({ supply: false }), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.findings).toEqual([]);
    expect(liftMap(run).payload.neighbourhoods.every((n) => n.reason === "not_measured")).toBe(true);
    expect(metricsOf(run, "lift.area")).toMatchObject([{ value: null, reason: "not_measured" }]);
    expect(result.forModel.notices).toContain(
      "The concept and baseline maps share no cell: the map shows raw heat only, which tracks popularity, so no lift is measured.",
    );
  });

  it("takes no supply sample when too few neighbourhoods have a lift to rank it", async () => {
    // Two of the four neighbourhoods lie outside the maps, so only two can have a lift.
    const north = { minLat: 30.26, maxLat: 30.27, minLon: -97.76, maxLon: -97.74 };
    const run = setup({ world: { concept: rows(7, conceptAffinity, north), baseline: rows(7, baselineAffinity, north) } });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.calls.every((c) => c.filterType === "urn:heatmap")).toBe(true);
    const d = liftMap(run).payload;
    const lifted = d.neighbourhoods.filter((n) => n.lift !== null);
    expect(lifted.length).toBeGreaterThan(0);
    expect(lifted.length).toBeLessThan(3);
    expect(d.neighbourhoods.every((n) => n.demandPct === null && n.supplyCount === null && n.quadrant === null)).toBe(true);
    expect(d.supply).toBeNull();
    expect(result.forModel.notices.join(" ")).toMatch(/too few to rank demand and supply \(3 needed\), so no supply sample was taken/);
  });

  it("makes no neighbourhood claim at geohash 4 and flags the coarse grid", async () => {
    const coarse = { minLat: 30.1, maxLat: 30.4, minLon: -98.0, maxLon: -97.5 };
    const run = setup({ world: { concept: rows(4, conceptAffinity, coarse), baseline: rows(4, baselineAffinity, coarse) } });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.flags).toContain("COARSE_GEOHASH");
    const d = liftMap(run).payload;
    expect(d).toMatchObject({ precision: 4, precisionFactor: 0, coarse: true });
    expect(d.neighbourhoods.every((n) => n.lift === null && n.reason === "coarse")).toBe(true);
    expect(run.ledger.metrics[0]).toMatchObject({ key: "lift.precision", value: 0 });
    expect(run.ledger.metrics[0]?.display).toMatch(/coarse/);
    expect(metricsOf(run, "lift.area")).toMatchObject([{ value: null, reason: "coarse", subjectRefs: ["austin", "T1"] }]);
    expect(run.ledger.findings.some((f) => f.kind === "LATENT_DEMAND")).toBe(false);
    expect(result.forModel.notices.join(" ")).toMatch(/too coarse for any neighbourhood claim/);
  });

  it("flags geohash 5 as coarse but keeps neighbourhood claims at half precision", async () => {
    const wide = { minLat: 30.0, maxLat: 30.5, minLon: -98.0, maxLon: -97.5 };
    const run = setup({ world: { concept: rows(5, conceptAffinity, wide), baseline: rows(5, baselineAffinity, wide) } });
    const result = await geoLiftSkill.run(input({ supply: false }), run.ctx);
    expect(result.flags).toContain("COARSE_GEOHASH");
    expect(liftMap(run).payload).toMatchObject({ precision: 5, precisionFactor: 0.5, coarse: false });
  });

  it("normalises mixed precision to the coarser map", async () => {
    const world = defaultWorld();
    const run = setup({ world: { baseline: rows(6, baselineAffinity) } });
    const result = await geoLiftSkill.run(input({ supply: false }), run.ctx);
    expect(world.concept[0]?.location.geohash).toHaveLength(7);
    expect(liftMap(run).payload).toMatchObject({ precision: 6, precisionFactor: 0.8 });
    expect(liftMap(run).payload.cells.every((c) => c.geohash.length === 6)).toBe(true);
    expect(result.flags).not.toContain("COARSE_GEOHASH");
  });

  it("maps cells without neighbourhoods in a metro that has no gazetteer", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ metro: "nashville", supply: false }), run.ctx);
    expect(result.status).toBe("ok");
    const d = liftMap(run).payload;
    expect(d.neighbourhoods).toEqual([]);
    expect(d.cells.length).toBeGreaterThan(0);
    expect(metricsOf(run, "lift.area")).toMatchObject([{ value: null, reason: "unavailable" }]);
    expect(result.forModel.notices).toContain("No neighbourhood boundaries for Nashville in this build: the map shows cells only.");
  });

  it("reads competitors as unknown, never 0, without a verified category tag, and says why", async () => {
    for (const concept_tags of [["T1"], ["T1", "T5"]]) {
      const run = setup();
      const result = await geoLiftSkill.run(input({ concept_tags }), run.ctx);
      expect(result.status).toBe("partial");
      // An unverified category tag (T5) is never sent: it could return no venue where many exist.
      expect(run.calls.every((c) => c.filterType === "urn:heatmap")).toBe(true);
      expect(result.flags).toContain("SUPPLY_UNAVAILABLE");
      expect(run.ledger.evidences[0]?.flags).toContain("SUPPLY_UNAVAILABLE");
      const sentence = "We can't count similar venues in Austin: Qloo's venue data has no verified category for Wine Bar, so the number of competitors here is unknown, not zero.";
      expect(metricsOf(run, "lift.supply")).toMatchObject([{ value: null, reason: "unavailable", badge: "UNAVAILABLE", subjectRefs: ["austin", "T1"] }]);
      expect(metricsOf(run, "lift.supply")[0]?.label).toContain(sentence);
      const d = liftMap(run).payload;
      expect(d.supply).toBeNull();
      expect(d.supplyGap).toBe(sentence);
      expect(d.neighbourhoods.every((n) => n.supplyCount === null && n.whiteSpace === null)).toBe(true);
      expect(metricsOf(run, "lift.white_space")).toEqual([]);
      const notices = result.forModel.notices.join(" ");
      expect(notices).toContain(sentence);
      expect(notices).toMatch(/never state or imply a competitor count/);
      if (concept_tags.includes("T5")) expect(notices).toContain("T5 (Wine Cellar) is not a verified venue category");
      expect(result.forModel.metrics.some((m) => m.badge === "UNAVAILABLE" && m.label.includes("unknown, never 0"))).toBe(true);
    }
  });

  it("reads an empty venue sample as unknown competitors, never as zero venues in every area", async () => {
    const run = setup({ world: { venues: [] } });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(run.calls.filter((c) => c.filterType === "urn:entity:place")).toHaveLength(1);
    expect(metricsOf(run, "lift.supply")).toMatchObject([{ value: null, reason: "not_measured", badge: "UNAVAILABLE" }]);
    const d = liftMap(run).payload;
    expect(d.supplyGap).toMatch(/came back empty in Austin, so the number of competitors here is unknown, not zero/);
    expect(d.neighbourhoods.every((n) => n.supplyCount === null)).toBe(true);
    // No find_tags suggestion: another tag found now would never be counted with, so the count stays unknown.
    expect(run.ledger.findings.find((f) => f.kind === "EMPTY_RESULT")?.suggestion).toBeNull();
    // No venue layer and no venue total: unknown is never drawn or totalled as 0.
    expect(d.supply).toBeNull();
    expect(result.flags).toContain("SUPPLY_UNAVAILABLE");
    expect(result.forModel.notices.join(" ")).toMatch(/came back empty in Austin.*never state or imply a competitor count/);
  });

  it("reads a sample too thin to compare areas as unknown competitors, never as 0 or few", async () => {
    const run = setup({ world: { venues: venues({ birch_hollow: 2, cedar_point: 3 }) } });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(metricsOf(run, "lift.supply")).toMatchObject([{ value: null, reason: "insufficient_n", badge: "UNAVAILABLE" }]);
    const d = liftMap(run).payload;
    expect(d.supplyGap).toBe(
      "Qloo's venue sample for Wine bar places only 5 similar venues in the Austin areas this map compares, too few to count " +
        "competitors area by area (10 needed), so the number of competitors here is unknown, not zero.",
    );
    expect(d.supply).toBeNull();
    expect(d.neighbourhoods.every((n) => n.supplyCount === null && n.quadrant === null)).toBe(true);
    expect(metricsOf(run, "lift.white_space")).toEqual([]);
    expect(run.ledger.findings.some((f) => f.kind === "LATENT_DEMAND")).toBe(false);
    expect(run.ledger.evidences.find((e) => e.purpose.startsWith("Places sample"))?.flags).toContain("SUPPLY_UNAVAILABLE");
    expect(result.forModel.notices.join(" ")).toMatch(/too few to count competitors area by area.*never state or imply a competitor count/);
  });

  it("reads venues that all lie outside the areas with a lift as unknown competitors, never as 0 in every area", async () => {
    const far: QlooEntity[] = Array.from({ length: 12 }, (_, k) => ({
      entity_id: `ent-venue-far-${k}`,
      name: `Venue Far ${k}`,
      popularity: 0.4,
      location: { lat: FAR_AWAY.minLat + 0.0005 * (k + 1), lon: FAR_AWAY.minLon + 0.0005 * (k + 1) },
    }));
    const run = setup({ world: { venues: far }, boxes: [...QUADRANTS, FAR_AWAY] });
    await geoLiftSkill.run(input({ focus_areas: ["birch_hollow"] }), run.ctx);
    expect(metricsOf(run, "lift.supply")).toMatchObject([{ value: null, reason: "insufficient_n", subjectRefs: ["austin", "T1"] }]);
    expect(liftMap(run).payload.supplyGap).toMatch(/places only 0 similar venues/);
    expect(liftMap(run).payload.neighbourhoods.every((n) => n.supplyCount === null)).toBe(true);
  });

  it("counts with the place type's verified category when the call sends only its genre tag", async () => {
    const curated = curatedConcept("wine bar");
    const genre = curated?.served.find((t) => t.use === "heatmap_signal");
    const category = curated?.served.find((t) => t.use === "place_filter");
    if (genre === undefined || category === undefined) throw new Error("expected the curated wine bar tags");
    const run = setup();
    const ref = run.registry.registerTag({ tagId: genre.tagId, name: "Wine Bar", type: "urn:tag:genre:place", signalCapable: true }).ref;
    const result = await geoLiftSkill.run(input({ concept_tags: [ref] }), run.ctx);
    const places = run.calls.filter((c) => c.filterType === "urn:entity:place");
    expect(places.length).toBeGreaterThan(0);
    expect(places[0]?.params["filter.tags"]).toEqual([category.tagId]);
    expect(result.flags).not.toContain("SUPPLY_UNAVAILABLE");
    expect(liftMap(run).payload.supplyGap).toBeUndefined();
  });

  it("labels a counted supply as a sample of Qloo-indexed venues", async () => {
    const run = setup();
    await geoLiftSkill.run(input(), run.ctx);
    expect(metricsOf(run, "lift.white_space").every((m) => m.label.includes("from a sample of Qloo-indexed venues"))).toBe(true);
    expect(liftMap(run).payload.caption).toContain("a capped sample of Qloo-indexed venues, not every business");
    expect(liftMap(run).payload.supplyGap).toBeUndefined();
    expect(metricsOf(run, "lift.supply")).toEqual([]);
  });

  it("never cites a capped sample's 0 as a count: the named area's supply is UNAVAILABLE and reads Not enough venue data", async () => {
    // 110 located venues, so both pages come back full (capped); none of them in Birch Hollow.
    const run = setup({ world: { venues: venues({ alder_flats: 60, cedar_point: 30, dunmore_yards: 20 }) } });
    const result = await geoLiftSkill.run(input({ focus_areas: ["birch_hollow"] }), run.ctx);
    const map = liftMap(run).payload;
    expect(map.supply?.capped).toBe(true);
    const birch = map.neighbourhoods.find((n) => n.id === "birch_hollow");
    expect(birch).toMatchObject({ supplyCount: 0, quadrant: null, whiteSpace: null, supplyPct: null });
    const supply = metricsOf(run, "lift.supply").filter((m) => m.subjectRefs[0] === "birch_hollow");
    expect(supply).toMatchObject([{ value: null, reason: "insufficient_n", badge: "UNAVAILABLE" }]);
    expect(supply[0]?.label).toMatch(/^similar venues in Birch Hollow: unknown, not 0 \(not enough venue data\)\. None of the venues in Qloo's capped sample/);
    const digest = ModelDigest.parse(result.forModel);
    expect(digest.top_rows[0]?.values).toMatchObject({ area: "birch_hollow", quadrant: THIN_SUPPLY_LABEL });
    expect(digest.notices.find((n) => n.includes("the area the question names"))).toContain(`Its competition reads "${THIN_SUPPLY_LABEL}"`);
    // No area of the map is called crowded or saturated from fewer venues than the rule asks.
    for (const n of map.neighbourhoods) {
      if (n.quadrant === "PROVEN_CROWDED" || n.quadrant === "SATURATED") expect(n.supplyCount ?? 0).toBeGreaterThanOrEqual(MIN_BUSY_AREA_VENUES);
    }
  });

  it("skips supply when it is not asked for", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ supply: false }), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual([]);
    expect(run.calls).toHaveLength(2);
    expect(liftMap(run).formulaIds).toEqual(["lift.cell", "lift.area", "lift.confidence"]);
  });

  it("keeps a metro of many long-named neighbourhoods within the digest budget", async () => {
    const boxes: Box[] = [];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const lat = BOX.minLat + (i * (BOX.maxLat - BOX.minLat)) / 6;
        const lon = BOX.minLon + (j * (BOX.maxLon - BOX.minLon)) / 6;
        boxes.push({ id: `area_${i}_${j}`, name: `Invented Heritage Neighbourhood District ${i}${j}`, minLat: lat, maxLat: lat + 0.02 / 6, minLon: lon, maxLon: lon + 0.02 / 6 });
      }
    }
    const run = setup({ boxes });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "geo_lift", step: "S2" })).toBe(true);
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(13);
    expect(result.forModel.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(liftMap(run).payload.neighbourhoods).toHaveLength(36);
  });
});

/** 36 invented neighbourhoods in a six-by-six grid over the synthetic box. */
function grid36(): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const lat = BOX.minLat + (i * (BOX.maxLat - BOX.minLat)) / 6;
      const lon = BOX.minLon + (j * (BOX.maxLon - BOX.minLon)) / 6;
      boxes.push({ id: `area_${i}_${j}`, name: `Invented Quarter ${i}${j}`, minLat: lat, maxLat: lat + 0.02 / 6, minLon: lon, maxLon: lon + 0.02 / 6 });
    }
  }
  return boxes;
}

describe("geo_lift: the areas the question names", () => {
  // Finer maps, so most of the 36 small areas reach the five gated cells a lift needs.
  const fine = (): World => ({ concept: rows(8, conceptAffinity), baseline: rows(8, baselineAffinity) });

  /** The ids of the areas with a lift, highest first, from a run without focus areas. */
  async function rankedIds(boxes: Box[]): Promise<string[]> {
    const run = setup({ boxes, world: fine() });
    await geoLiftSkill.run(input(), run.ctx);
    return liftMap(run).payload.neighbourhoods.filter((n) => n.lift !== null).map((n) => n.id);
  }

  it("gives a named area outside the top five its own lift, rank, confidence and sampled venues, first", async () => {
    const boxes = grid36();
    const ranked = await rankedIds(boxes);
    expect(ranked.length).toBeGreaterThan(8);
    const named = ranked[7] as string;
    const run = setup({ boxes, world: fine() });
    const result = await geoLiftSkill.run(input({ focus_areas: [named] }), run.ctx);
    const about = (key: string) => metricsOf(run, key).filter((m) => m.subjectRefs[0] === named);

    expect(about("lift.area")).toHaveLength(1);
    expect(about("lift.area")[0]?.label).toMatch(/\(named in the question\)$/);
    expect(about("lift.rank")).toMatchObject([{ value: 8, display: `8 of ${ranked.length}`, unit: "rank", badge: "DERIVED", n: ranked.length }]);
    expect(about("lift.confidence")).toHaveLength(1);
    expect(about("lift.confidence")[0]?.label).toMatch(/gated cells? × map precision/);
    const venues = about("lift.supply");
    expect(venues).toHaveLength(1);
    expect(venues[0]?.label).toMatch(/in a sample of Qloo-indexed venues, not every business/);
    expect(venues[0]?.value).toBe(liftMap(run).payload.neighbourhoods.find((n) => n.id === named)?.supplyCount);

    // The model reads the named area first: its digest row, and a notice that says its rank.
    const digest = ModelDigest.parse(result.forModel);
    expect(digest.top_rows[0]?.values).toMatchObject({ area: named, named: "in the question", lift_rank: 8, ranked_of: ranked.length, rank_metric: about("lift.rank")[0]?.id });
    const lead = digest.notices.find((n) => n.includes("the area the question names"));
    expect(lead).toMatch(new RegExp(`the area the question names, ranks 8 of ${ranked.length} areas with a lift`));
    expect(lead).toContain(about("lift.rank")[0]?.id ?? "missing");
    // Only the row cut, which fitting adds, may come before it.
    expect(digest.notices.indexOf(lead ?? "")).toBeLessThanOrEqual(1);
    expect(digestFits(digest, { tool: "geo_lift", step: "S2" })).toBe(true);
    expect(liftMap(run).payload.focusAreas).toEqual([named]);
    // The top three and the lowest keep their own lift metrics.
    for (const id of [...ranked.slice(0, 3), ranked[ranked.length - 1] as string]) expect(metricsOf(run, "lift.area").some((m) => m.subjectRefs[0] === id)).toBe(true);
  });

  it("reuses a named area's metric when it is already among the top areas", async () => {
    const boxes = grid36();
    const ranked = await rankedIds(boxes);
    const top = ranked[0] as string;
    const run = setup({ boxes, world: fine() });
    await geoLiftSkill.run(input({ focus_areas: [top] }), run.ctx);
    expect(metricsOf(run, "lift.area").filter((m) => m.subjectRefs[0] === top)).toHaveLength(1);
    expect(metricsOf(run, "lift.confidence").filter((m) => m.subjectRefs[0] === top)).toHaveLength(1);
    expect(metricsOf(run, "lift.rank").find((m) => m.subjectRefs[0] === top)?.display).toBe(`1 of ${ranked.length}`);
  });

  it("says plainly when a named area has too few gated cells for a reliable lift", async () => {
    // A tiny invented corner, listed first so its cells are located there: too small for five gated cells.
    const corner: Box = { id: "fig_corner", name: "Fig Corner", minLat: 30.2645, maxLat: 30.2655, minLon: -97.7455, maxLon: -97.7445 };
    const run = setup({ boxes: [corner, ...QUADRANTS] });
    const result = await geoLiftSkill.run(input({ focus_areas: ["fig_corner"] }), run.ctx);
    const area = metricsOf(run, "lift.area").find((m) => m.subjectRefs[0] === "fig_corner");
    expect(area).toMatchObject({ value: null, reason: "insufficient_n", badge: "UNAVAILABLE" });
    expect(area?.label).toMatch(/^lift of Fig Corner vs the restaurant baseline: not measured, (only \d of the 5 gated cells a reliable lift needs|no gated cell, and a reliable lift needs 5)$/);
    expect(metricsOf(run, "lift.rank").some((m) => m.subjectRefs[0] === "fig_corner")).toBe(false);
    expect(result.forModel.notices[0]).toMatch(/^Fig Corner \(fig_corner\), the area the question names, has no lift: .*gated cell.*Say so plainly; do not rank it or read it as low interest\.$/);
    expect(result.forModel.top_rows[0]?.values).toMatchObject({ area: "fig_corner", named: "in the question", unscored: "insufficient_n" });
    expect(result.forModel.top_rows[0]?.values.gated_cells).toBe(area?.n);
  });

  it("names an id outside the metro's areas and leaves it out", async () => {
    const run = setup();
    const result = await geoLiftSkill.run(input({ focus_areas: ["nowhere_heights"] }), run.ctx);
    expect(result.forModel.notices).toContain("nowhere_heights is not an area of Austin (AREAS); left out of focus_areas.");
    expect(liftMap(run).payload.focusAreas).toBeUndefined();
  });

  it("keeps three named areas in a metro of many areas within the digest budget", async () => {
    const boxes = grid36();
    const ranked = await rankedIds(boxes);
    const named = [ranked[6], ranked[9], ranked[ranked.length - 2]] as string[];
    const run = setup({ boxes, world: fine() });
    const result = await geoLiftSkill.run(input({ focus_areas: named }), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "geo_lift", step: "S2" })).toBe(true);
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.top_rows.slice(0, 3).map((r) => r.values.area)).toEqual(named);
    expect(digest.notices.filter((n) => n.includes("the area the question names"))).toHaveLength(3);
    expect(metricsOf(run, "lift.rank")).toHaveLength(3);
  });

  it("rejects more than three named areas", () => {
    expect(() => input({ focus_areas: ["a", "b", "c", "d"] })).toThrow();
  });
});

describe("geo_lift: budget and failures", () => {
  it("shows raw heat only when the budget stops the baseline, and spends nothing on supply", async () => {
    const run = setup({ budget: 1 });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.calls.map((c) => c.filterType)).toEqual(["urn:heatmap"]);
    expect(run.ledger.evidences).toHaveLength(1);
    const d = liftMap(run);
    expect(d.payload.cells.every((c) => c.lift === null && c.base === null && c.raw !== null)).toBe(true);
    expect(d.payload.neighbourhoods.every((n) => n.reason === "budget_truncated" && n.supplyCount === null)).toBe(true);
    expect(d.payload.supply).toBeNull();
    expect(d.formulaIds).not.toContain("lift.white_space");
    expect(metricsOf(run, "lift.area")).toMatchObject([{ value: null, reason: "budget_truncated", badge: "UNAVAILABLE" }]);
    expect(result.forModel.notices.join(" ")).toMatch(/baseline was not fetched \(budget\)/);
    expect(result.forModel.notices).toContain("No neighbourhood has a lift, so no supply sample was taken and there is no white space.");
  });

  it("reads supply as not measured, never as zero venues, when the budget stops the first page", async () => {
    const run = setup({ budget: 2 });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences.map((e) => e.purpose)).toEqual(["Concept heatmap for Wine Bar in Austin", "Pinned restaurants baseline heatmap for Austin"]);
    const d = liftMap(run);
    expect(d.payload.neighbourhoods.some((n) => n.lift !== null)).toBe(true);
    expect(d.payload.neighbourhoods.every((n) => n.supplyCount === null && n.supplyPct === null && n.whiteSpace === null)).toBe(true);
    expect(d.payload.supply).toBeNull();
    expect(d.formulaIds).toEqual(["lift.cell", "lift.area", "lift.confidence"]);
    expect(metricsOf(run, "lift.white_space")).toEqual([]);
    expect(run.ledger.findings.some((f) => f.kind === "LATENT_DEMAND")).toBe(false);
    expect(result.forModel.notices).toContain("The budget stopped the supply sample, so there is no white space.");
    expect(result.forModel.notices.join(" ")).not.toMatch(/No sampled venue/);
  });

  it("reads supply as not measured when the first page fails", async () => {
    const run = setup({ fail: (c) => c.filterType === "urn:entity:place" });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual([]);
    expect(run.calls.filter((c) => c.filterType === "urn:entity:place")).toHaveLength(1);
    const d = liftMap(run);
    expect(d.payload.neighbourhoods.every((n) => n.supplyCount === null && n.whiteSpace === null)).toBe(true);
    expect(d.payload.supply).toBeNull();
    expect(d.formulaIds).not.toContain("lift.white_space");
    expect(result.forModel.notices).toContain("The supply sample failed (qloo_unavailable), so there is no white space.");
    expect(result.forModel.notices.join(" ")).not.toMatch(/No sampled venue/);
  });

  it("spends the last call on the concept map, never on a supply page that would race it", async () => {
    // One network call left and the baseline cached; the heatmap lookups are the slower ones, as
    // when the client reserves budget only after an async cache lookup.
    const isBaseline = (c: Call) => c.filterType === "urn:heatmap" && JSON.stringify(c.params).includes(HEATMAP_BASELINE.tagId);
    const run = setup({ budget: 1, cached: isBaseline, lookupMs: (c) => (c.filterType === "urn:heatmap" ? 5 : 0) });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(run.calls.map((c) => c.params["signal.interests.tags"] ?? "places")).toEqual([[GENRE], [HEATMAP_BASELINE.tagId]]);
    expect(result.status).toBe("partial");
    expect(liftMap(run).payload.neighbourhoods.some((n) => n.lift !== null)).toBe(true);
    expect(result.forModel.notices).toContain("The budget stopped the supply sample, so there is no white space.");
  });

  it("builds no map when the budget stops the concept heatmap", async () => {
    const run = setup({ budget: 0 });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toMatchObject([
      { key: "lift.supply", value: null, reason: "budget_truncated" },
      { key: "lift.area", value: null, reason: "budget_truncated" },
    ]);
  });

  it("keeps the first supply page when the budget stops the second", async () => {
    const run = setup({ budget: 3 });
    const result = await geoLiftSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.evidences[2]).toMatchObject({ status: "partial", flags: ["SUPPLY_SAMPLE_ONLY", "BUDGET_TRUNCATED"] });
    expect(liftMap(run).payload.supply).toMatchObject({ capped: true });
    expect(liftMap(run).payload.supply?.points).toHaveLength(PLACES_TAKE);
    expect(result.forModel.notices).toContain("The budget stopped the supply sample after its first page.");
  });

  it("reads a failed baseline as an error gap and a failed concept map as a failure", async () => {
    const baselineDown = setup({ fail: (c) => c.filterType === "urn:heatmap" && JSON.stringify(c.params).includes(HEATMAP_BASELINE.tagId) });
    const result = await geoLiftSkill.run(input({ supply: false }), baselineDown.ctx);
    expect(result.status).toBe("partial");
    expect(metricsOf(baselineDown, "lift.area")).toMatchObject([{ value: null, reason: "error" }]);
    expect(result.forModel.notices.join(" ")).toMatch(/lost to a failed call/);

    const conceptDown = setup({ fail: (c) => c.filterType === "urn:heatmap" && JSON.stringify(c.params).includes(GENRE) });
    await expect(geoLiftSkill.run(input(), conceptDown.ctx)).rejects.toThrow("upstream down");
    expect(conceptDown.ledger.evidences).toHaveLength(0);
  });
});

describe("geo_lift: estimateCalls", () => {
  const registry = () => setup().registry;

  it("is the upper bound without the locality pins", async () => {
    const probe = fakeProbe(() => true);
    expect(await geoLiftSkill.estimateCalls(input(), probe, registry())).toBe(4);
    expect(await geoLiftSkill.estimateCalls(input({ supply: false }), probe, registry())).toBe(2);
    expect(await geoLiftSkill.estimateCalls(input({ concept_tags: ["T1"] }), probe, registry())).toBe(2);
    expect(probe.asked).toHaveLength(0);
  });

  it("counts cached requests as free once the pins key them", async () => {
    const cold = fakeProbe(() => false);
    expect(await estimateGeoLiftCalls(input(), cold, registry(), PINS)).toBe(4);
    expect(cold.asked.map((a) => a.params["filter.type"])).toEqual(["urn:heatmap", "urn:heatmap", "urn:entity:place", "urn:entity:place"]);
    expect(cold.asked[1]?.params).toEqual({ "filter.type": "urn:heatmap", "filter.location": LOCALITY, "signal.interests.tags": [HEATMAP_BASELINE.tagId] });

    const pinnedBaseline = fakeProbe((_, p) => JSON.stringify(p["signal.interests.tags"]) === JSON.stringify([HEATMAP_BASELINE.tagId]));
    expect(await estimateGeoLiftCalls(input(), pinnedBaseline, registry(), PINS)).toBe(3);
    // The skill reads the pins from estimateCalls' fourth argument (EstimateEnv).
    expect(await geoLiftSkill.estimateCalls(input(), fakeProbe(() => true), registry(), { localities: PINS, geo: null })).toBe(0);
    expect(await geoLiftSkill.estimateCalls(input(), fakeProbe(() => true), registry())).toBe(4);
  });

  it("matches what a run actually sends, so a warm cache estimates zero", async () => {
    const run = setup();
    await geoLiftSkill.run(input(), run.ctx);
    const sent = new Set(run.calls.map((c) => JSON.stringify({ "filter.type": c.filterType, ...c.params })));
    const probe = fakeProbe((_, p) => sent.has(JSON.stringify(p)));
    expect(await estimateGeoLiftCalls(input(), probe, run.registry, PINS)).toBe(0);
  });

  it("costs nothing when the run would answer without calls", async () => {
    expect(await estimateGeoLiftCalls(input({ concept_tags: ["T2", "T3"] }), fakeProbe(() => false), registry(), PINS)).toBe(0);
    expect(await estimateGeoLiftCalls(input(), fakeProbe(() => false), registry(), { market: async () => null })).toBe(0);
  });
});

describe("geo_lift: limitations", () => {
  it("returns its fixed method limitations", () => {
    expect(geoLiftSkill.limitations(["COARSE_GEOHASH"])).toEqual([...SKILL_LIMITATIONS.geo_lift]);
  });
});
