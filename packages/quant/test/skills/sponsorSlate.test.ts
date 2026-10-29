import { readFileSync } from "node:fs";
import {
  digestFits,
  ModelDigest,
  QuadrantPayload,
  SlatePayload,
  SlopePayload,
  SponsorCategory,
  type DatasetKind,
  type DatasetOf,
  type InsightsFilterType,
  type InsightsResponse,
  type LocalityApi,
  type MarketId,
  type QlooApi,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type QlooResult,
  type QlooTagSearchItem,
} from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { SKILLS } from "../../src/skills/index";
import { DISCOVERY_TAKE, sponsorSlateSkill } from "../../src/skills/sponsorSlate";
import { SPONSOR_CATEGORIES, TAG_LOOKUP_TAKE } from "../../src/skills/sponsorSlate/categories";
import { MAX_SLATE_METRICS } from "../../src/skills/sponsorSlate/outputs";
import { MAIN_LINE_MIN_TAGS, offCategoryBranch, quadrantOf } from "../../src/skills/sponsorSlate/slate";
import { BudgetError, FETCHED_AT, fakeProbe, fakeRun, FakeRegistry, insightEntity, registerInvented, type Invented } from "./support/fakes";

// The run tests cover both S10 paths: a category with a probe-verified tag and one whose tag is
// looked up at run time. C2 verified a tag for all but one category, so they run over the
// pre-Part-8 map, where only beer and energy drinks carry a tag; the mirror test reads the real map.
vi.mock("../../src/skills/sponsorSlate/categories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/skills/sponsorSlate/categories")>();
  const verified = new Set<string>(["beer", "energy_drinks"]);
  const map = Object.fromEntries(
    Object.entries(actual.SPONSOR_CATEGORIES).map(([id, spec]) => [id, verified.has(id) ? spec : { ...spec, tag: null }]),
  );
  return { ...actual, SPONSOR_CATEGORIES: map };
});

// Invented brands, seeds, tags and localities only (D29). The fake answers each call from a small
// world: discovery lists by category tag, national scores for the one-scale call, and per-market
// scores where a missing brand is one the market call dropped.

const BEER_TAG = SPONSOR_CATEGORIES.beer.tag!;
const ENERGY_TAG = SPONSOR_CATEGORIES.energy_drinks.tag!;
const WHISKEY_TAG = "urn:tag:genre:brand:mock_whiskey";
const FLOOR = 0.0213;

const SEED: Invented = { id: "ent-seed-nova", name: "Artist Nova", category: null };
const B1: Invented = { id: "ent-b1", name: "Hollow Pine Lager", category: null, popularity: 0.2 };
const B2: Invented = { id: "ent-b2", name: "Granite Ale", category: null, popularity: 0.85 };
const B3: Invented = { id: "ent-b3", name: "Foam Works", category: null, popularity: 0.6 };
const B4: Invented = { id: "ent-b4", name: "Junk Brew", category: null, popularity: 0.004 };
const E1: Invented = { id: "ent-e1", name: "Volt Fizz", category: null, popularity: 0.92 };
const E2: Invented = { id: "ent-e2", name: "Spark Can", category: null, popularity: 0.5 };
const E3: Invented = { id: "ent-e3", name: "Bolt Brew", category: null, popularity: 0.4 };
const E4: Invented = { id: "ent-e4", name: "Rush Tonic", category: null, popularity: 0.3 };
const E5: Invented = { id: "ent-e5", name: "Zap Water", category: null, popularity: 0.2 };
const S1: Invented = { id: "ent-s1", name: "Ridge Rye", category: null, popularity: 0.55 };
const S2: Invented = { id: "ent-s2", name: "Barrel Nine", category: null, popularity: 0.3 };
const T1: Invented = { id: "ent-t1", name: "Trail Outfitters", category: null, popularity: 0.4 };
const G1: Invented = { id: "ent-g1", name: "Summit Pack Co", category: null, popularity: 0.45 };
const G2: Invented = { id: "ent-g2", name: "Ridgeline Boots", category: null, popularity: 0.35 };
const ARTIST: Invented = { id: "ent-a1", name: "Artist Other", category: null };

interface World {
  /** Discovery results per filter tag, in Qloo order. */
  discovery: Record<string, Invented[]>;
  /** /v2/tags results per semantic query. */
  tags: Record<string, QlooTagSearchItem[]>;
  /** Seed affinity per brand id (national). A missing id is dropped from the scoring call. */
  national: Record<string, number>;
  /** Per locality id: affinity per brand id; a missing id is dropped from that market call. */
  markets: Record<string, Record<string, number>>;
  /** Tag ids a brand's discovery row carries besides the filter tag. */
  rowTags?: Record<string, string[]>;
}

const tag = (id: string, name: string, type: string): QlooTagSearchItem => ({ id, name, type });

function baseWorld(): World {
  const national = { [B1.id]: 0.8, [B2.id]: 0.7, [S1.id]: 0.65, [S2.id]: 0.6, [T1.id]: 0.5, [B3.id]: 0.4, [E2.id]: 0.35, [E1.id]: 0.3, [B4.id]: 0.95 };
  return {
    discovery: {
      [BEER_TAG]: [B4, B1, B2, B3],
      // Granite Ale shows up for energy too, but beer (requested first) already holds it.
      [ENERGY_TAG]: [B2, E2, E1],
      [WHISKEY_TAG]: [S1, S2],
    },
    tags: {
      whiskey: [tag("urn:tag:product_category:qloo:whiskey", "whiskey", "urn:tag:product_category:qloo"), tag(WHISKEY_TAG, "Whiskey", "urn:tag:genre:brand")],
      "pickup trucks": [tag("urn:tag:product_category:qloo:pickup_trucks", "pickup trucks", "urn:tag:product_category:qloo")],
    },
    national,
    markets: {
      "loc-nash": { [B1.id]: 0.5, [B2.id]: 0.4, [E2.id]: 0.45, [E1.id]: 0.31, [S1.id]: 0.55, [T1.id]: 0.35 },
      "loc-aus": { [B1.id]: 0.6, [E1.id]: 0.7, [B2.id]: FLOOR, [S1.id]: FLOOR },
    },
  };
}

const ALL = [SEED, B1, B2, B3, B4, E1, E2, E3, E4, E5, S1, S2, T1, G1, G2, ARTIST];
const byId = (id: string): Invented => {
  const e = ALL.find((x) => x.id === id);
  if (e === undefined) throw new Error(`unknown synthetic entity ${id}`);
  return e;
};
const list = (v: QlooParams[string] | undefined): string[] => (typeof v === "object" ? [...v] : v === undefined ? [] : [String(v)]);

interface Recorded {
  method: "tags" | "insights";
  filterType: string | null;
  params: QlooParams;
}

/** A QlooApi over the world, with one budget for every endpoint (calls past it throw BudgetError). */
function worldQloo(world: World, budget?: number): { api: QlooApi; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let attempts = 0;
  const meta = (): QlooCallMeta => ({
    qlooCallId: `qc-${calls.length}`,
    requestId: `req-synthetic-${calls.length}`,
    cache: "miss",
    fetchedAt: FETCHED_AT,
    ms: 5,
    stale: false,
    originRunId: null,
  });
  const gate = () => {
    attempts += 1;
    if (budget !== undefined && attempts > budget) throw new BudgetError("run cap reached");
  };
  const insightsRows = (params: QlooParams): QlooEntity[] => {
    const filter = list(params["filter.tags"])[0];
    if (filter !== undefined) {
      return (world.discovery[filter] ?? []).map((e) => {
        const row = insightEntity(e, world.national[e.id]);
        const tags = [filter, ...(world.rowTags?.[e.id] ?? [])].map((id) => ({ id, name: id, type: "urn:tag:genre:brand" }));
        return { ...row, tags };
      });
    }
    const candidates = list(params["filter.results.entities"]);
    const location = params["signal.location"];
    const scores = typeof location === "string" ? (world.markets[location] ?? {}) : world.national;
    return candidates.filter((id) => scores[id] !== undefined).map((id) => insightEntity(byId(id), scores[id]));
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    tags: async (params) => {
      gate();
      calls.push({ method: "tags", filterType: null, params });
      return { data: { results: { tags: world.tags[String(params["filter.query"])] ?? [] } }, meta: meta() };
    },
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      gate();
      calls.push({ method: "insights", filterType, params });
      return { data: { results: { entities: insightsRows(params) } } as unknown as InsightsResponse<F>, meta: meta() };
    },
    search: unused,
    entities: unused,
    audiences: unused,
    trending: unused,
  };
  return { api, calls };
}

const LOCALITIES: Record<string, { entityId: string; label: string }> = {
  nashville: { entityId: "loc-nash", label: "Nashville" },
  austin: { entityId: "loc-aus", label: "Austin" },
};
const localities: LocalityApi = { market: async (id: MarketId) => LOCALITIES[id] ?? null };

function setup(world: World, options: { budget?: number; shortlist?: Invented[]; localities?: LocalityApi | null } = {}) {
  const registry = new FakeRegistry();
  registerInvented(registry, SEED, "artist");
  for (const e of options.shortlist ?? [T1, B3]) registerInvented(registry, e, e === ARTIST ? "artist" : "brand");
  const qloo = worldQloo(world, options.budget);
  const run = fakeRun(qloo.api, registry);
  if (options.localities !== null) Object.assign(run.ctx, { localities: options.localities ?? localities });
  return { ...run, calls: qloo.calls };
}

type SlateRaw = Partial<{ seed: string; categories: string[]; shortlist: string[]; markets: string[]; step_id: string | null }>;

function input(raw: SlateRaw = {}) {
  return sponsorSlateSkill.input.parse({
    seed: "R1",
    categories: ["beer", "energy_drinks", "spirits", "auto"],
    shortlist: ["R2", "R3"],
    markets: ["nashville", "austin"],
    trigger_finding_id: null,
    step_id: "S2",
    ...raw,
  });
}

function dataset<K extends DatasetKind>(run: ReturnType<typeof setup>, kind: K): DatasetOf<K> {
  const d = run.ledger.datasets.find((x) => x.kind === kind);
  if (d === undefined) throw new Error(`expected a ${kind} dataset`);
  return d as DatasetOf<K>;
}

const refOf = (run: ReturnType<typeof setup>, e: Invented) => run.registry.byEntityId(e.id)?.ref;

describe("sponsor_slate: the requests", () => {
  it("looks up tags only for unverified categories, sends one tag per discovery call and scores on one scale", async () => {
    const run = setup(baseWorld());
    await sponsorSlateSkill.run(input(), run.ctx);

    const tagCalls = run.calls.filter((c) => c.method === "tags");
    expect(tagCalls.map((c) => c.params)).toEqual([
      { "filter.query": "whiskey", "feature.semantic_search": true, "filter.parents.types": ["urn:entity:brand"], "filter.tag.types": ["urn:tag:genre:brand"], take: TAG_LOOKUP_TAKE },
      { "filter.query": "pickup trucks", "feature.semantic_search": true, "filter.parents.types": ["urn:entity:brand"], "filter.tag.types": ["urn:tag:genre:brand"], take: TAG_LOOKUP_TAKE },
    ]);

    const insights = run.calls.filter((c) => c.method === "insights");
    expect(insights.every((c) => c.filterType === "urn:entity:brand")).toBe(true);
    const discovery = insights.filter((c) => c.params["filter.tags"] !== undefined);
    expect(discovery.map((c) => c.params)).toEqual([BEER_TAG, ENERGY_TAG, WHISKEY_TAG].map((t) => ({
      "signal.interests.entities": [SEED.id],
      "filter.tags": [t],
      take: DISCOVERY_TAKE,
    })));

    const [scoring, ...markets] = insights.filter((c) => c.params["filter.results.entities"] !== undefined);
    expect(scoring?.params).toEqual({
      "signal.interests.entities": [SEED.id],
      "filter.results.entities": [B1.id, B2.id, E2.id, E1.id, S1.id, S2.id, T1.id, B3.id],
      take: 8,
    });
    const slate = [B1.id, B2.id, E2.id, E1.id, S1.id, S2.id, T1.id];
    expect(markets.map((c) => c.params)).toEqual([
      { "signal.interests.entities": [SEED.id], "signal.location": "loc-nash", "filter.results.entities": slate, take: 7 },
      { "signal.interests.entities": [SEED.id], "signal.location": "loc-aus", "filter.results.entities": slate, take: 7 },
    ]);
    expect(run.calls).toHaveLength(2 + 3 + 1 + 2);
  });

  it("answers an unregistered seed with an error and no calls", async () => {
    const run = setup(baseWorld());
    const result = await sponsorSlateSkill.run(input({ seed: "R9" }), run.ctx);
    expect(result.status).toBe("error");
    expect(run.calls).toHaveLength(0);
  });

  it("does not measure a category whose looked-up tag equals or nests with an earlier category's tag", async () => {
    const world = baseWorld();
    const GEAR_TAG = "urn:tag:genre:brand:mock_gear";
    // A broader tag over the configured energy leaf: its parent in the taxonomy.
    const DRINKS_TAG = ENERGY_TAG.split(":").slice(0, -1).join(":");
    world.tags = {
      "outdoor gear": [tag(GEAR_TAG, "Gear", "urn:tag:genre:brand")],
      "boots and footwear": [tag(GEAR_TAG, "Gear", "urn:tag:genre:brand")],
      whiskey: [tag(DRINKS_TAG, "Drinks", "urn:tag:genre:brand")],
    };
    world.discovery[GEAR_TAG] = [G1, G2];
    world.national[G1.id] = 0.55;
    world.national[G2.id] = 0.45;
    const run = setup(world, { shortlist: [] });
    const result = await sponsorSlateSkill.run(
      input({ categories: ["energy_drinks", "outdoor_sporting_retail", "apparel_footwear", "spirits"], shortlist: [], markets: [] }),
      run.ctx,
    );

    const discovery = run.calls.filter((c) => c.params["filter.tags"] !== undefined).map((c) => c.params["filter.tags"]);
    expect(discovery).toEqual([[ENERGY_TAG], [GEAR_TAG]]);
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining([
        "Apparel and footwear resolved to the same tag as Outdoor and sporting retail; not measured separately.",
        "Spirits resolved to a tag nested with that of Energy drinks; not measured separately.",
      ]),
    );
    const rows = dataset(run, "Slate").payload.rows;
    expect(rows.map((r) => [r.category, r.best?.label ?? null, r.reason])).toEqual([
      ["energy_drinks", "Granite Ale", null],
      ["outdoor_sporting_retail", "Summit Pack Co", null],
      ["apparel_footwear", null, "unavailable"],
      ["spirits", null, "unavailable"],
    ]);
    expect(run.ledger.evidences[0]?.summary).toBe(
      "3 lookups; genre:brand tag found for Outdoor and sporting retail (Gear); 2 categories shared an earlier category's tag.",
    );
    expect(result.status).toBe("partial");
  });

  it("leaves out shortlist refs that are unknown, not brands or the seed, with a notice each", async () => {
    const run = setup(baseWorld(), { shortlist: [T1, ARTIST] });
    const result = await sponsorSlateSkill.run(input({ shortlist: ["R2", "R3", "R1", "R8"] }), run.ctx);
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining([
        "R3 (Artist Other) is a artist, not a brand; left out of the slate.",
        "R1 is the seed; left out of the slate.",
        "R8 is not in the registry; left out of the slate.",
      ]),
    );
    const scoring = run.calls.find((c) => c.params["filter.results.entities"] !== undefined && c.params["signal.location"] === undefined);
    expect(list(scoring?.params["filter.results.entities"])).not.toContain(ARTIST.id);
  });
});

describe("sponsor_slate: the slate", () => {
  it("picks one best fit per category on the one-scale FIT, flags UNDER-THE-RADAR and keeps a brand in one category", async () => {
    const run = setup(baseWorld());
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");

    const d = dataset(run, "Slate");
    SlatePayload.parse(d.payload);
    expect(d.payload.caption).toBe("Taste fit only; no fee, availability or ROI data.");
    expect(d.payload.seed).toEqual({ ref: "R1", label: "Artist Nova" });
    expect(d.payload.markets).toEqual([
      { id: "nashville", label: "Nashville" },
      { id: "austin", label: "Austin" },
    ]);
    const rows = Object.fromEntries(d.payload.rows.map((r) => [r.category, r]));
    expect(d.payload.rows.map((r) => r.category)).toEqual(["beer", "energy_drinks", "spirits", "auto"]);
    expect(rows.beer?.best).toMatchObject({ label: "Hollow Pine Lager", fit: { value: 1, reason: null }, popularity: 0.2, utr: true, topMarkets: [] });
    expect(rows.beer?.runnerUp).toMatchObject({ label: "Granite Ale", utr: false });
    expect(rows.energy_drinks?.best?.label).toBe("Spark Can");
    // Nashville scored six slate brands: Spark Can is 3rd of 6 there and 5th of the same 6 nationally.
    expect(rows.energy_drinks?.best?.topMarkets).toEqual([{ market: "nashville", label: "Nashville", delta: expect.closeTo(0.6 - 0.2, 9) }]);
    // Volt Fizz is last of the six in both rankings; Austin scored only two brands, too few for a Δ.
    expect(rows.energy_drinks?.runnerUp?.topMarkets).toEqual([]);
    expect(rows.spirits?.best).toMatchObject({ label: "Ridge Rye", utr: false });
    expect(rows.spirits?.runnerUp).toMatchObject({ label: "Barrel Nine", utr: true });
    expect(rows.auto).toEqual({ category: "auto", label: "Auto", best: null, runnerUp: null, reason: "unavailable" });
    expect(result.forModel.notices).toContain("Category tags found by semantic search, not probe-verified: Spirits (Whiskey).");
  });

  it("skips a discovered brand whose main line lies in another category, and says so (ANSWER_QUALITY §9)", async () => {
    const fashion = ["urn:tag:genre:brand:fashion", "urn:tag:genre:brand:fashion:casual", "urn:tag:genre:brand:fashion:footwear"];
    const world = { ...baseWorld(), rowTags: { [G1.id]: fashion } };
    world.discovery[WHISKEY_TAG] = [G1, S1, S2];
    world.national[G1.id] = 0.9;
    const run = setup(world);
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    const rows = Object.fromEntries(dataset(run, "Slate").payload.rows.map((r) => [r.category, r]));
    expect(rows.spirits?.best?.label).toBe("Ridge Rye");
    expect(run.calls.find((c) => c.params["filter.results.entities"] !== undefined)?.params["filter.results.entities"]).not.toContain(G1.id);
    expect(result.forModel.notices).toContain(
      "Spirits: 1 discovery result carried the category tag only beside a main line elsewhere and was skipped: Summit Pack Co (fashion).",
    );
    expect(run.ledger.evidences[1]?.summary).toContain("1 skipped as outside their category");

    // With every row from another line, the category says that no fitting brand is left.
    const only = { ...baseWorld(), rowTags: { [G1.id]: fashion } };
    only.discovery[WHISKEY_TAG] = [G1];
    const empty = setup(only);
    const out = await sponsorSlateSkill.run(input(), empty.ctx);
    expect(Object.fromEntries(dataset(empty, "Slate").payload.rows.map((r) => [r.category, r])).spirits).toMatchObject({ best: null, reason: "quality_gate" });
    expect(out.forModel.notices.find((n) => n.startsWith("Spirits:"))).toContain("No brand that fits Spirits is left, so the slate has no Spirits pick.");
  });

  it("records every number as a metric with its formula, badge and evidence, and absent values as UNAVAILABLE", async () => {
    const run = setup(baseWorld());
    await sponsorSlateSkill.run(input(), run.ctx);
    const [tags, discovery, scoring, markets] = run.ledger.evidences.map((e) => e.id);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "ok", "ok", "ok"]);
    const metric = (label: string) => run.ledger.metrics.find((m) => m.label.includes(label));

    // The best fit's label carries the UNDER-THE-RADAR flag; there is no separate per-brand metric.
    expect(metric("FIT · Hollow Pine Lager · Beer best fit")).toMatchObject({
      key: "slate.fit",
      label: "FIT · Hollow Pine Lager · Beer best fit, under the radar",
      formulaId: "slate.best_fit",
      badge: "DERIVED",
      unit: "pct",
      comparator: "WITHIN_CALL",
      value: 1,
      display: "1.00 · 1 of 8",
      evidenceIds: [discovery, scoring],
      n: 8,
    });
    expect(metric("FIT · Spark Can · Energy drinks best fit")?.label).toBe("FIT · Spark Can · Energy drinks best fit");
    expect(metric("FIT · Auto best fit")).toMatchObject({ value: null, reason: "unavailable", badge: "UNAVAILABLE", display: "not measured" });
    expect(metric("best fits under the radar")).toMatchObject({ formulaId: "slate.under_the_radar", unit: "count", value: 1, display: "1 of 3" });
    expect(run.ledger.metrics.some((m) => m.key === "slate.under_the_radar")).toBe(false);
    // Δ ranks the six brands Nashville scored on both sides; n is that set.
    expect(metric("Hollow Pine Lager · strongest market")).toMatchObject({
      formulaId: "slate.market_alignment",
      unit: "delta",
      comparator: "BASELINE",
      value: expect.closeTo(-0.2, 9),
      display: "−0.20 in Nashville",
      subjectRefs: [refOf(run, B1), "nashville"],
      evidenceIds: [scoring, markets],
      n: 6,
    });
    expect(metric("Spark Can · strongest market")?.display).toBe("+0.40 in Nashville");
    expect(metric("FIT · Trail Outfitters · shortlist")).toMatchObject({ formulaId: "pct.within_call", value: expect.closeTo(3 / 7, 9) });
    expect(metric("FIT · Foam Works · shortlist")).toMatchObject({ formulaId: "pct.within_call" });
    // The looked-up categories (Spirits, Auto) cite the tag lookup that defined them; Beer and Energy do not.
    expect(metric("FIT · Ridge Rye · Spirits best fit")?.evidenceIds).toEqual([tags, discovery, scoring]);
    expect(metric("FIT · Auto best fit")?.evidenceIds).toEqual([tags, discovery, scoring]);
    expect(run.ledger.metrics.filter((m) => m.evidenceIds.includes(tags!)).map((m) => m.label)).toEqual([
      "FIT · Ridge Rye · Spirits best fit",
      "FIT · Auto best fit",
    ]);
    expect(dataset(run, "Slate").evidenceIds).toEqual([tags, discovery, scoring, markets]);
    expect(run.ledger.metrics.filter((m) => m.formulaId === "slate.best_fit")).toHaveLength(4);
  });

  it("places the scored candidates on the quadrant and names the under-the-radar corner without price language", async () => {
    const run = setup(baseWorld());
    await sponsorSlateSkill.run(input(), run.ctx);
    const d = dataset(run, "Quadrant");
    QuadrantPayload.parse(d.payload);
    expect(d.payload.quadrantLabels.HIDDEN_POCKET).toBe("UNDER-THE-RADAR FIT · no pricing data");
    expect(d.payload.xSplit).toBeCloseTo(0.525, 9);
    expect(d.payload.ySplit).toBeCloseTo(0.5, 9);
    expect(d.payload.points).toHaveLength(8);
    const pt = (name: string) => d.payload.points.find((p) => p.label === name);
    expect(pt("Hollow Pine Lager")).toMatchObject({ quadrant: "HIDDEN_POCKET", utr: true, labelled: true, group: "Beer" });
    expect(pt("Volt Fizz")).toMatchObject({ quadrant: "MASS", utr: false, labelled: false, group: "Energy drinks" });
    expect(pt("Trail Outfitters")).toMatchObject({ group: "Shortlist" });
    expect(d.payload.points.filter((p) => p.labelled).map((p) => p.label)).toEqual(["Hollow Pine Lager", "Spark Can", "Ridge Rye", "Barrel Nine"]);
    expect(d.payload.belts).toEqual([]);
  });

  it("draws market alignment as a slope where a brand a market did not score is not scored there, never ranked", async () => {
    const run = setup(baseWorld());
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    const d = dataset(run, "Slope");
    SlopePayload.parse(d.payload);
    expect(d.payload.axes.map((a) => a.label)).toEqual(["National", "Nashville", "Austin"]);
    const line = (name: string) => d.payload.lines.find((l) => l.label === name)!;
    // National is re-ranked over the seven slate brands, not the eight candidates of the scoring call.
    expect(line("Hollow Pine Lager").points[0]).toEqual({ value: 1, reason: null, rank: 1 });
    expect(line("Volt Fizz").points[0]).toEqual({ value: 0, reason: null, rank: 7 });
    expect(line("Barrel Nine").points.slice(1)).toEqual([
      { value: null, reason: "dropped", rank: null },
      { value: null, reason: "dropped", rank: null },
    ]);
    expect(line("Granite Ale").points[2]).toEqual({ value: null, reason: "not_scored", rank: null });
    // Austin scored two slate brands: its percentiles would be all 1s and 0s, so it draws none.
    expect(line("Volt Fizz").points[2]).toEqual({ value: null, reason: "insufficient_n", rank: null });
    expect(line("Volt Fizz")).toMatchObject({ delta: null, highlight: false });
    expect(line("Spark Can")).toMatchObject({ highlight: true });
    expect(line("Barrel Nine").delta).toBeNull();
    expect(result.forModel.notices).toContain(
      "Austin scored fewer than 3 slate brands, too few to compare with the national ranking; no market alignment there.",
    );
  });

  it("gives no market alignment from a market that scored fewer than three slate brands", async () => {
    const run = setup(baseWorld());
    await sponsorSlateSkill.run(input({ markets: ["austin"] }), run.ctx);
    const alignment = (name: string) => run.ledger.metrics.find((m) => m.label === `${name} · strongest market`);
    // Austin scored Hollow Pine Lager and Volt Fizz only, dropped Spark Can and floored Ridge Rye.
    expect(alignment("Hollow Pine Lager")).toMatchObject({ value: null, reason: "insufficient_n", badge: "UNAVAILABLE", n: null });
    expect(alignment("Spark Can")).toMatchObject({ value: null, reason: "dropped" });
    expect(alignment("Ridge Rye")).toMatchObject({ value: null, reason: "not_scored" });
    expect(dataset(run, "Slate").payload.rows.every((r) => (r.best?.topMarkets ?? []).length === 0)).toBe(true);
  });

  it("reads no market lean where a market keeps the national order of the brands it scored", async () => {
    const world = baseWorld();
    // Both markets keep the national order (Nashville drops Barrel Nine); affinities differ, ranks do not.
    world.markets["loc-nash"] = { [B1.id]: 0.61, [B2.id]: 0.6, [S1.id]: 0.5, [T1.id]: 0.45, [E2.id]: 0.4, [E1.id]: 0.2 };
    world.markets["loc-aus"] = { [B1.id]: 0.9, [B2.id]: 0.85, [S1.id]: 0.8, [S2.id]: 0.75, [T1.id]: 0.7, [E2.id]: 0.65, [E1.id]: 0.6 };
    const run = setup(world);
    await sponsorSlateSkill.run(input(), run.ctx);

    const alignment = run.ledger.metrics.filter((m) => m.key === "slate.market_alignment");
    expect(alignment).toHaveLength(3);
    for (const m of alignment) expect(m).toMatchObject({ value: 0, display: "0.00 in Nashville" });
    // The national #1 is not penalised and the national last gains nothing: no market leans anywhere.
    for (const row of dataset(run, "Slate").payload.rows) {
      expect(row.best?.topMarkets ?? []).toEqual([]);
      expect(row.runnerUp?.topMarkets ?? []).toEqual([]);
    }
    expect(dataset(run, "Slope").payload.lines.some((l) => l.highlight)).toBe(false);
    // Where a market scored every slate brand, its axis equals the re-ranked national one.
    for (const l of dataset(run, "Slope").payload.lines) expect(l.points[2]).toEqual(l.points[0]);
  });

  it("raises EMPTY_RESULT for a category without a tag and DROPPED_CANDIDATES for the market calls", async () => {
    const run = setup(baseWorld());
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    const [empty, dropped] = run.ledger.findings;
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["EMPTY_RESULT", "DROPPED_CANDIDATES", "WEAK_CATEGORY_FIT"]);
    expect(empty?.text).toBe("Sponsor discovery for Auto returned no usable results.");
    expect(empty?.suggestion).toEqual({ tool: "resolve_entities", reason: "Resolve brands you expect in Auto, then pass them as the shortlist." });
    expect(empty?.metricIds).toEqual([run.ledger.metrics.find((m) => m.label === "FIT · Auto best fit")?.id]);
    expect(dropped?.text).toContain("not scored in the Nashville and Austin market calls");
    expect(dropped?.text).toContain("Granite Ale, Spark Can, Ridge Rye and 2 more");
    // The small discovery lists (four, three and two rows) are thin results too.
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "QUALITY_GATE_DROPPED", "DROPPED_CANDIDATES", "NOT_SCORED", "THIN_RESULT"]);
  });

  it("raises WEAK_CATEGORY_FIT for the weakest best fit in the bottom quarter of eight or more scored candidates", async () => {
    const run = setup(baseWorld());
    await sponsorSlateSkill.run(input(), run.ctx);
    const weak = run.ledger.findings.filter((f) => f.kind === "WEAK_CATEGORY_FIT");
    // Eight candidates scored; Spark Can, the energy best fit, ranks 7 of 8 (FIT 1/7).
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({
      severity: "medium",
      text: "Spark Can, the best Energy drinks fit, ranks 7 of 8 on the slate's one scale and sits in the bottom quarter of the slate: the brands carrying the category's tag fit this audience weakly.",
      suggestion: {
        tool: "sponsor_slate",
        reason:
          "Score Energy drinks brands the category tag may miss, from the cultural neighbourhood or resolve_entities: run sponsor_slate again with the same categories and them added to the shortlist.",
      },
    });
    // It cites the category's best-fit metric, so a lead names the weak best fit.
    expect(weak[0]?.metricIds).toEqual([run.ledger.metrics.find((m) => m.label.includes("Energy drinks best fit"))?.id]);

    // Above the bottom quarter, or over fewer than eight scored candidates, nothing fires.
    const world = baseWorld();
    world.national[E2.id] = 0.62;
    const strong = setup(world);
    await sponsorSlateSkill.run(input(), strong.ctx);
    expect(strong.ledger.findings.filter((f) => f.kind === "WEAK_CATEGORY_FIT")).toEqual([]);
    const small = setup(baseWorld(), { shortlist: [] });
    await sponsorSlateSkill.run(input({ shortlist: [] }), small.ctx);
    expect(small.ledger.findings.filter((f) => f.kind === "WEAK_CATEGORY_FIT")).toEqual([]);
  });

  it("builds a digest that fits, points rows at metrics and never shows Qloo or locality ids", async () => {
    const run = setup(baseWorld());
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "sponsor_slate", step: "S2" })).toBe(true);
    const text = JSON.stringify(digest);
    expect(text).not.toContain("ent-");
    expect(text).not.toContain("loc-");
    // Category rows are named by the category and carry refs; names are in the metric labels and the registered list.
    expect(digest.top_rows.map((r) => r.name)).toEqual(["Beer", "Energy drinks", "Spirits", "Auto", "Trail Outfitters"]);
    expect(digest.top_rows[0]).toEqual({
      ref: refOf(run, B1),
      name: "Beer",
      values: {
        best_fit_metric: run.ledger.metrics.find((m) => m.label.startsWith("FIT · Hollow Pine Lager"))?.id,
        runner_up: refOf(run, B2),
        market_metric: run.ledger.metrics.find((m) => m.label === "Hollow Pine Lager · strongest market")?.id,
      },
    });
    expect(digest.top_rows[3]).toMatchObject({ ref: null, values: { unscored: "unavailable" } });
    expect(digest.top_rows[4]?.values).toMatchObject({ category: "none (shortlist)", under_the_radar: "no" });
    const ids = new Set(digest.metrics.map((m) => m.id));
    for (const v of digest.top_rows.flatMap((r) => Object.entries(r.values))) if (v[0].endsWith("_metric") && v[1] !== null) expect(ids.has(v[1] as `M${number}`)).toBe(true);
    expect(digest.registered.map((r) => r.name)).toEqual(["Hollow Pine Lager", "Granite Ale", "Spark Can", "Volt Fizz", "Ridge Rye", "Barrel Nine"]);
    expect(digest.dataset_ids).toEqual(["D1", "D2", "D3"]);
  });

  it("is deterministic: the same world gives the same digest and datasets", async () => {
    const a = setup(baseWorld());
    const b = setup(baseWorld());
    const ra = await sponsorSlateSkill.run(input(), a.ctx);
    const rb = await sponsorSlateSkill.run(input(), b.ctx);
    expect(ra.forModel).toEqual(rb.forModel);
    expect(a.ledger.datasets).toEqual(b.ledger.datasets);
  });
});

describe("sponsor_slate: unscored, empty, partial and truncated results", () => {
  it("leaves candidates the scoring call dropped or floored unscored, with DROPPED_CANDIDATES and no rank", async () => {
    const world = baseWorld();
    delete world.national[E1.id];
    world.national[T1.id] = FLOOR;
    world.national[B3.id] = FLOOR;
    const run = setup(world, { localities: null });
    const result = await sponsorSlateSkill.run(input({ markets: [] }), run.ctx);
    expect(result.flags).toEqual(expect.arrayContaining(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES", "NOT_SCORED"]));
    const scoring = run.ledger.evidences.find((e) => e.purpose.startsWith("One-scale"));
    expect(scoring?.summary).toBe("5 of 8 candidates scored (2 tied at the floor, not scored, 1 dropped by Qloo).");
    const finding = run.ledger.findings.find((f) => f.kind === "DROPPED_CANDIDATES");
    expect(finding?.text).toBe("Volt Fizz, Trail Outfitters and Foam Works were not scored in the one-scale scoring call, so they are shown as not scored there, not ranked last.");
    const slate = dataset(run, "Slate").payload;
    expect(slate.rows.find((r) => r.category === "energy_drinks")?.runnerUp).toBeNull();
    const shortlist = run.ledger.metrics.find((m) => m.label.includes("Trail Outfitters"));
    expect(shortlist).toMatchObject({ value: null, reason: "not_scored", badge: "UNAVAILABLE" });
    expect(dataset(run, "Quadrant").payload.omitted).toEqual([
      { label: "Volt Fizz", ref: refOf(run, E1), reason: "dropped" },
      { label: "Trail Outfitters", ref: refOf(run, T1), reason: "not_scored" },
      { label: "Foam Works", ref: refOf(run, B3), reason: "not_scored" },
    ]);
    // FIT ranks the five scored candidates only.
    expect(run.ledger.metrics.find((m) => m.label.includes("Beer best fit"))?.display).toBe("1.00 · 1 of 5");
    // Energy keeps a scored pick and the floored brands are shortlist ones: nothing to substitute.
    expect(finding).toMatchObject({ severity: "low", suggestion: null });
  });

  it("offers a category's next discovery results when the scoring call drops all its picks, and the follow-up fills it", async () => {
    const world = baseWorld();
    world.discovery[ENERGY_TAG] = [B2, E2, E1, E3, E4, E5];
    Object.assign(world.national, { [E3.id]: 0.25, [E4.id]: 0.2, [E5.id]: 0.15 });
    const run = setup(world, { localities: null });
    const answer = run.ctx.qloo.insights.bind(run.ctx.qloo);
    // The one-scale call drops both energy picks; discovery still returns them.
    Object.assign(run.ctx.qloo, {
      insights: async (filterType: InsightsFilterType, params: QlooParams) => {
        const res = await answer(filterType, params);
        if (params["filter.results.entities"] === undefined) return res;
        const rows = (res.data as unknown as { results: { entities: QlooEntity[] } }).results.entities;
        return { ...res, data: { results: { entities: rows.filter((e) => e.entity_id !== E1.id && e.entity_id !== E2.id) } } };
      },
    });
    const result = await sponsorSlateSkill.run(input({ markets: [] }), run.ctx);

    const finding = run.ledger.findings.find((f) => f.kind === "DROPPED_CANDIDATES");
    const [r3, r4] = [refOf(run, E3), refOf(run, E4)];
    const energy = SPONSOR_CATEGORIES.energy_drinks.label;
    expect(finding).toMatchObject({
      severity: "medium",
      suggestion: {
        tool: "sponsor_slate",
        reason: `Score Bolt Brew and Rush Tonic from the ${energy} discovery results instead: run sponsor_slate again with the same categories and ${r3}, ${r4} added to the shortlist.`,
      },
    });
    expect(result.forModel.registered.map((e) => e.name)).toEqual(expect.arrayContaining(["Bolt Brew", "Rush Tonic"]));
    expect(refOf(run, E5)).toBeUndefined();

    // The suggested follow-up: the same picks, and the substitutes join the category they came from and fill it.
    await sponsorSlateSkill.run(input({ shortlist: ["R2", "R3", r3!, r4!], markets: [], step_id: null }), run.ctx);
    const slate = run.ledger.datasets.filter((d) => d.kind === "Slate").at(-1) as DatasetOf<"Slate">;
    expect(slate.payload.rows.find((r) => r.category === "energy_drinks")?.best?.ref).toBe(r3);
  });

  it("answers a slate with nothing discovered and no shortlist as empty, with no scoring call", async () => {
    const world = baseWorld();
    world.discovery = {};
    const run = setup(world, { shortlist: [] });
    const result = await sponsorSlateSkill.run(input({ shortlist: [] }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.calls.filter((c) => c.params["filter.results.entities"] !== undefined)).toHaveLength(0);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["EMPTY_RESULT"]);
    expect(run.ledger.findings[0]?.text).toBe("Sponsor discovery for Beer, Energy drinks, Spirits and Auto returned no usable results.");
    expect(dataset(run, "Slate").payload.rows.map((r) => r.reason)).toEqual(["not_measured", "not_measured", "not_measured", "unavailable"]);
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Slate"]);
    expect(run.ledger.evidences.find((e) => e.purpose.startsWith("Sponsor category discovery"))?.status).toBe("empty");
    expect(result.forModel.notices).toContain("No brand was scored nationally, so no market call was made.");
  });

  it("calls a category whose results the quality gate removed quality_gate", async () => {
    const world = baseWorld();
    world.discovery[BEER_TAG] = [B4];
    const run = setup(world, { shortlist: [] });
    await sponsorSlateSkill.run(input({ categories: ["beer", "spirits"], shortlist: [], markets: [] }), run.ctx);
    expect(dataset(run, "Slate").payload.rows[0]).toMatchObject({ category: "beer", best: null, reason: "quality_gate" });
    expect(run.registry.byEntityId(B4.id)).toBeNull();
  });

  it("returns a partial slate when the budget runs out during discovery, every gap explicit", async () => {
    // Two lookups, then beer and energy discovery; spirits discovery and everything after are refused.
    const run = setup(baseWorld(), { budget: 4 });
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    const rows = dataset(run, "Slate").payload.rows;
    expect(rows.map((r) => [r.category, r.reason])).toEqual([
      ["beer", "budget_truncated"],
      ["energy_drinks", "budget_truncated"],
      ["spirits", "budget_truncated"],
      ["auto", "unavailable"],
    ]);
    const bestFits = run.ledger.metrics.filter((m) => m.formulaId === "slate.best_fit");
    expect(bestFits.map((m) => m.reason)).toEqual(["budget_truncated", "budget_truncated", "budget_truncated", "unavailable"]);
    expect(bestFits.every((m) => m.badge === "UNAVAILABLE" && m.value === null)).toBe(true);
    expect(run.ledger.evidences.find((e) => e.purpose.startsWith("Sponsor category discovery"))).toMatchObject({
      status: "partial",
      flags: expect.arrayContaining(["BUDGET_TRUNCATED"]),
    });
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Slate"]);
  });

  it("keeps the national slate and the markets that answered when the budget refuses a market call", async () => {
    const run = setup(baseWorld(), { budget: 2 + 3 + 1 + 1 });
    const result = await sponsorSlateSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    const slope = dataset(run, "Slope").payload;
    expect(slope.axes.map((a) => a.label)).toEqual(["National", "Nashville", "Austin"]);
    expect(slope.lines.every((l) => l.points[2]?.reason === "budget_truncated" && l.points[2]?.value === null)).toBe(true);
    expect(dataset(run, "Slate").payload.markets).toEqual([{ id: "nashville", label: "Nashville" }]);
    expect(run.ledger.evidences.at(-1)).toMatchObject({ status: "partial", summary: "Nashville scored 6 of 7." });
  });

  it("measures no market without the locality seam, and names a market with no pinned locality", async () => {
    const without = setup(baseWorld(), { localities: null });
    const a = await sponsorSlateSkill.run(input(), without.ctx);
    expect(a.forModel.notices).toContain("Market localities are not available in this build, so market alignment was not measured.");
    expect(without.calls.filter((c) => c.params["signal.location"] !== undefined)).toHaveLength(0);
    expect(without.ledger.metrics.some((m) => m.formulaId === "slate.market_alignment")).toBe(false);
    expect(without.ledger.datasets.map((d) => d.kind)).toEqual(["Slate", "Quadrant"]);

    const unpinned = setup(baseWorld());
    const b = await sponsorSlateSkill.run(input({ markets: ["nashville", "kansas_city"] }), unpinned.ctx);
    expect(b.forModel.notices).toContain("No pinned locality for Kansas City; market alignment was not measured there.");
    expect(unpinned.calls.filter((c) => c.params["signal.location"] !== undefined)).toHaveLength(1);
  });

  it("tells a failed locality lookup apart from an unpinned market, and returns a partial slate", async () => {
    const categories = ["beer", "energy_drinks", "spirits"];
    const control = setup(baseWorld());
    expect((await sponsorSlateSkill.run(input({ categories, markets: ["nashville"] }), control.ctx)).status).toBe("ok");

    const failing: LocalityApi = {
      market: async (id: MarketId) => {
        if (id === "austin") throw new Error("kv unavailable");
        return LOCALITIES[id] ?? null;
      },
    };
    const run = setup(baseWorld(), { localities: failing });
    const result = await sponsorSlateSkill.run(input({ categories, markets: ["nashville", "austin", "kansas_city"] }), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining([
        "No pinned locality for Kansas City; market alignment was not measured there.",
        "Locality lookup failed for Austin; market alignment was not measured there.",
      ]),
    );
    expect(result.forModel.notices.some((n) => n.includes("No pinned locality for Austin"))).toBe(false);
    expect(result.forModel.notices.some((n) => n.startsWith("Some Qloo calls failed"))).toBe(false);
    expect(run.calls.filter((c) => c.params["signal.location"] !== undefined).map((c) => c.params["signal.location"])).toEqual(["loc-nash"]);
  });

  it("keeps the evidence it has when a Qloo call fails after discovery", async () => {
    const qloo = worldQloo(baseWorld());
    const failing: QlooApi = {
      ...qloo.api,
      insights: async (filterType, params) => {
        if (params["signal.location"] === "loc-aus") throw Object.assign(new Error("Qloo unavailable"), { code: "qloo_unavailable" });
        return qloo.api.insights(filterType, params);
      },
    };
    const registry = new FakeRegistry();
    registerInvented(registry, SEED, "artist");
    const run = fakeRun(failing, registry);
    Object.assign(run.ctx, { localities });
    const result = await sponsorSlateSkill.run(input({ shortlist: [] }), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("Some Qloo calls failed (qloo_unavailable); what they cover is not measured.");
    const slope = run.ledger.datasets.find((d) => d.kind === "Slope");
    if (slope?.kind !== "Slope") throw new Error("expected a Slope dataset");
    expect(slope.payload.lines.every((l) => l.points[2]?.reason === "error")).toBe(true);
  });
});

describe("sponsor_slate: digest budget at full size", () => {
  /**
   * The largest valid input: 6 categories whose best fits are all under the radar (high FIT, low
   * popularity), a 10-brand popular shortlist, 4 markets with long labels, 40-character names and
   * long looked-up tag names.
   */
  function worstCase() {
    const long = (id: string, i: number, popularity: number): Invented => ({
      id,
      name: `Heritage Trading Company Brand ${String(i).padStart(2, "0")} Holdings Ltd`.slice(0, 40),
      category: null,
      popularity,
    });
    // Per category: a best fit (even index) and a runner-up (odd index).
    const discovered = Array.from({ length: 12 }, (_, i) => long(`ent-long-d${i}`, i, i % 2 === 0 ? 0.05 + 0.01 * i : 0.5));
    const shortlisted = Array.from({ length: 10 }, (_, i) => long(`ent-long-s${i}`, 20 + i, 0.9));
    ALL.push(...discovered, ...shortlisted);
    const world = baseWorld();
    const lookups = ["hard seltzer", "outdoor gear", "boots and footwear", "fast food"];
    const lookupTag = (q: string) => `urn:tag:genre:brand:mock_${q.replace(/ /g, "_")}`;
    world.tags = Object.fromEntries(lookups.map((q) => [q, [tag(lookupTag(q), `${q} and related very long tag name`, "urn:tag:genre:brand")]]));
    world.discovery = Object.fromEntries([BEER_TAG, ENERGY_TAG, ...lookups.map(lookupTag)].map((t, c) => [t, discovered.slice(2 * c, 2 * c + 2)]));
    world.national = Object.fromEntries([
      ...discovered.map((e, i) => [e.id, i % 2 === 0 ? 0.9 - 0.001 * i : 0.3 - 0.001 * i] as const),
      ...shortlisted.map((e, i) => [e.id, 0.6 - 0.01 * i] as const),
    ]);
    const everyone = [...discovered, ...shortlisted];
    world.markets = Object.fromEntries(
      ["loc-1", "loc-2", "loc-3", "loc-4"].map((loc, m) => [loc, Object.fromEntries(everyone.map((e, i) => [e.id, 0.2 + ((i * 7 + m * 3) % 17) / 25]))]),
    );
    const markets = ["nashville", "austin", "denver", "atlanta"];
    const many: LocalityApi = { market: async (id) => ({ entityId: `loc-${markets.indexOf(id) + 1}`, label: `${id[0]!.toUpperCase()}${id.slice(1)} Metropolitan Area` }) };
    const run = setup(world, { shortlist: shortlisted, localities: many });
    const categories = ["beer", "energy_drinks", "rtd_seltzer", "outdoor_sporting_retail", "apparel_footwear", "qsr"];
    return { run, input: input({ categories, shortlist: shortlisted.map((_, i) => `R${i + 2}`), markets }) };
  }

  it("fits six under-the-radar best fits, a ten-brand shortlist and four markets with 40-character names, keeping every category row", async () => {
    const { run, input: full } = worstCase();
    const result = await sponsorSlateSkill.run(full, run.ctx);

    expect(result.status).toBe("ok");
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "sponsor_slate", step: "S2" })).toBe(true);
    expect(run.calls.filter((c) => c.params["filter.results.entities"] !== undefined)[0]?.params.take).toBe(22);
    expect(run.ledger.metrics.find((m) => m.key === "slate.utr_count")?.display).toBe("6 of 6");
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(MAX_SLATE_METRICS);
    // Rows may be cut to fit, never metrics; here every category row stays, with room to spare.
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.top_rows.slice(0, 6).map((r) => r.name)).toEqual([
      "Beer",
      "Energy drinks",
      "RTD and hard seltzer",
      "Outdoor and sporting retail",
      "Apparel and footwear",
      "Quick-service restaurants",
    ]);
    expect(digest.top_rows.length).toBeGreaterThan(6);
    // Nothing had to be shortened.
    expect(digest.metrics.some((m) => m.label.endsWith("…"))).toBe(false);
    expect(digest.registered.some((r) => r.name.endsWith("…"))).toBe(false);
  });

  it("gives the shortlist the FIT metrics the cap leaves, best first, and says where the rest are", async () => {
    const { run, input: full } = worstCase();
    const result = await sponsorSlateSkill.run(full, run.ctx);
    const shortlistFit = run.ledger.metrics.filter((m) => m.label.endsWith(" · shortlist"));
    // 6 best fits, the UTR count and 6 strongest markets leave two.
    expect(shortlistFit.map((m) => m.label)).toEqual([20, 21].map((i) => `FIT · Heritage Trading Company Brand ${i} Holdin · shortlist`));
    const quadrant = run.ledger.datasets.find((d) => d.kind === "Quadrant")?.id;
    expect(result.forModel.notices).toContain(`8 more shortlist brands have no FIT metric, to fit this result; their FIT is in ${quadrant}.`);
  });

  it("never throws at full size when calls also drop brands and the run carries extra notices", async () => {
    // The scoring call drops every shortlist brand, each market call drops one best fit, and four shortlist refs are rejected.
    const { run, input: full } = worstCase();
    const answer = run.ctx.qloo.insights.bind(run.ctx.qloo);
    Object.assign(run.ctx.qloo, {
      insights: async (filterType: InsightsFilterType, params: QlooParams) => {
        const res = await answer(filterType, params);
        if (params["filter.results.entities"] === undefined) return res;
        const local = params["signal.location"] !== undefined;
        const rows = (res.data as unknown as { results: { entities: QlooEntity[] } }).results.entities;
        const kept = rows.filter((e) => (local ? e.entity_id !== "ent-long-d0" : !e.entity_id.startsWith("ent-long-s")));
        return { ...res, data: { results: { entities: kept } } };
      },
    });
    const result = await sponsorSlateSkill.run({ ...full, shortlist: [...full.shortlist.slice(0, 6), "R40", "R41", "R42", "R1"] }, run.ctx);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "sponsor_slate", step: "S2" })).toBe(true);
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.findings.map((f) => f.kind)).toEqual(["DROPPED_CANDIDATES", "DROPPED_CANDIDATES"]);
    expect(result.forModel.notices).toContain("R1 is the seed; left out of the slate.");
  });
});

describe("sponsor_slate: estimateCalls", () => {
  it("probes lookups and verified discovery, counts searched categories, scoring and markets as one each", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, SEED, "artist");
    const cold = fakeProbe(() => false);
    expect(await sponsorSlateSkill.estimateCalls(input(), cold, registry)).toBe(2 + 2 + 2 + 1 + 2);
    expect(cold.asked.filter((a) => a.path === "/v2/insights").map((a) => a.params)).toEqual([
      { "filter.type": "urn:entity:brand", "signal.interests.entities": [SEED.id], "filter.tags": [BEER_TAG], take: DISCOVERY_TAKE },
      { "filter.type": "urn:entity:brand", "signal.interests.entities": [SEED.id], "filter.tags": [ENERGY_TAG], take: DISCOVERY_TAKE },
    ]);
    expect(cold.asked.filter((a) => a.path === "/v2/tags")).toHaveLength(2);

    const warm = fakeProbe(() => true);
    expect(await sponsorSlateSkill.estimateCalls(input(), warm, registry)).toBe(0 + 0 + 2 + 1 + 2);
    expect(await sponsorSlateSkill.estimateCalls(input({ categories: ["beer"], markets: [] }), warm, registry)).toBe(1);
    expect(await sponsorSlateSkill.estimateCalls(input({ seed: "R9" }), cold, registry)).toBe(0);
  });

  it("is the registered skill, with the sponsor limitations as its method bullets", () => {
    expect(SKILLS.sponsor_slate).toBe(sponsorSlateSkill);
    expect(sponsorSlateSkill.mnemonic).toBe("SLATE");
    expect(sponsorSlateSkill.limitations(["BUDGET_TRUNCATED"])).toEqual([...SKILL_LIMITATIONS.sponsor_slate]);
  });
});

describe("SPONSOR_CATEGORIES", () => {
  it("mirrors config/sponsor_categories.json: labels, semantic queries and the one verified filter tag", async () => {
    const real = await vi.importActual<typeof import("../../src/skills/sponsorSlate/categories")>("../../src/skills/sponsorSlate/categories");
    const raw = readFileSync(new URL("../../../../config/sponsor_categories.json", import.meta.url), "utf8");
    const config = JSON.parse(raw) as {
      categories: Record<string, { label: string; semantic_query: string; tags: { urn: string; status: string; verified_as?: string }[] }>;
    };
    expect(Object.keys(real.SPONSOR_CATEGORIES).sort()).toEqual([...SponsorCategory.options].sort());
    for (const id of SponsorCategory.options) {
      const c = config.categories[id]!;
      const verified = c.tags.filter((t) => t.status === "verified" && t.verified_as === "brand_filter");
      expect(verified.length).toBeLessThanOrEqual(1);
      expect(real.SPONSOR_CATEGORIES[id]).toEqual({ label: c.label, semanticQuery: c.semantic_query, tag: verified[0]?.urn ?? null });
    }
  });

  it("looks a tag up at run time only for the categories on the named fallback", async () => {
    const real = await vi.importActual<typeof import("../../src/skills/sponsorSlate/categories")>("../../src/skills/sponsorSlate/categories");
    const raw = readFileSync(new URL("../../../../config/sponsor_categories.json", import.meta.url), "utf8");
    const config = JSON.parse(raw) as { categories: Record<string, { fallback?: string }> };
    const searched = SponsorCategory.options.filter((id) => real.SPONSOR_CATEGORIES[id].tag === null);
    expect(searched).toEqual(SponsorCategory.options.filter((id) => config.categories[id]!.fallback === "semantic_tag_search"));
    expect(searched).toEqual(["outdoor_sporting_retail"]);
  });
});

describe("sponsor_slate: quadrantOf", () => {
  it("puts a high-fit candidate below the slate's median popularity in UNDER-THE-RADAR only when it is not well known (§3)", () => {
    expect(quadrantOf(0.8, 0.6, 0.5, 0.9)).toBe("HIDDEN_POCKET");
    // Below a 0.95 median, but popularity 0.94 is a well-known name: high fit · well known.
    expect(quadrantOf(0.8, 0.94, 0.5, 0.95)).toBe("HEARTLAND");
    expect(quadrantOf(0.8, 0.85, 0.5, 0.95)).toBe("HEARTLAND");
    expect(quadrantOf(0.2, 0.94, 0.5, 0.95)).toBe("COLD");
    expect(quadrantOf(0.2, 0.96, 0.5, 0.95)).toBe("MASS");
  });
});

describe("offCategoryBranch", () => {
  const row = (...ids: string[]) => ({ tags: ids.map((id) => ({ id: `urn:tag:genre:brand:${id}`, name: id, type: "urn:tag:genre:brand" })) });
  const BEAUTY = "urn:tag:genre:brand:health_and_beauty";

  it("names the other branch when the brand carries the category tag only beside a main line elsewhere", () => {
    expect(MAIN_LINE_MIN_TAGS).toBe(3);
    expect(offCategoryBranch(row("health_and_beauty", "fashion", "fashion:casual", "fashion:footwear"), BEAUTY)).toBe("fashion");
    // Two tags elsewhere are a side line, not a main line.
    expect(offCategoryBranch(row("health_and_beauty", "mobile_app", "mobile_app:healthcare"), BEAUTY)).toBeNull();
  });

  it("keeps a brand with a tag under the category, a brand with nothing else and a non-genre filter tag", () => {
    expect(offCategoryBranch(row("health_and_beauty", "health_and_beauty:skincare", "fashion", "fashion:casual", "fashion:jeans"), BEAUTY)).toBeNull();
    expect(offCategoryBranch(row("health_and_beauty"), BEAUTY)).toBeNull();
    expect(offCategoryBranch({}, BEAUTY)).toBeNull();
    expect(offCategoryBranch(row("fashion", "fashion:casual", "fashion:jeans"), "urn:tag:product_category:qloo:invented")).toBeNull();
    // Tags in the category's own top-level branch never count against it.
    expect(offCategoryBranch(row("mobile_app:food_and_dining", "mobile_app", "mobile_app:games", "mobile_app:music"), "urn:tag:genre:brand:mobile_app:food_and_dining")).toBeNull();
  });
});
