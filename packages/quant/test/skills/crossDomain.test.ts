// S9 cross_domain against an in-memory Qloo: each domain call is answered from a small invented
// neighbourhood, so a test reads like the cultural map it sets up. Invented entities only (D29).
import {
  DATASET_PAYLOADS,
  digestFits,
  ModelDigest,
  type DatasetOf,
  type Domain,
  type InsightsFilterType,
  type InsightsResponse,
  type QlooApi,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type QlooResult,
} from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { isFormulaId } from "../../src/formulas";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { crossDomainSkill, estimateCrossDomainCalls } from "../../src/skills/crossDomain";
import { computeNeighbourhoods, genreLeafOf, isExplainabilityEdge, isUnderTheRadar } from "../../src/skills/crossDomain/neighbourhood";
import { BudgetError, fakeProbe, fakeRun, FakeRegistry, FETCHED_AT } from "./support/fakes";

// The invented world ------------------------------------------------------------------------------------

const NOVA = { id: "ent-nova-09", name: "Artist Nova" };
const ALPHA = { id: "ent-alpha-01", name: "Brand Alpha" };
const KESTREL = { id: "ent-kestrel-11", name: "Podcast Kestrel" };
const WATER_ROOT = "urn:tag:genre:brand:beverage";
const WATER_LEAF = "urn:tag:genre:brand:beverage:water";
const INDIE = "urn:tag:genre:music:indie_rock";
const FOLK = "urn:tag:genre:music:folk";
const DESCRIPTIVE = "urn:tag:lifestyle:qloo:outdoorsy";
const CATEGORY = "urn:tag:category:place:mock_reading_room";
const ALL_DOMAINS: Domain[] = ["artist", "podcast", "tv_show", "movie", "brand"];

interface Spec {
  name: string;
  /** Defaults to an id derived from the domain and the name. */
  id?: string;
  popularity?: number | null;
  /** Omitted: the row comes back without query.affinity. */
  affinity?: number;
  /** Per-seed explainability shares by seed id. */
  shares?: Record<string, number>;
  genre?: { id: string; name: string } | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function entity(domain: Domain, s: Spec): QlooEntity {
  const shares = s.shares === undefined ? undefined : Object.entries(s.shares).map(([entity_id, score]) => ({ entity_id, score }));
  const query =
    s.affinity === undefined ? undefined : { affinity: s.affinity, ...(shares === undefined ? {} : { explainability: { "signal.interests.entities": shares } }) };
  return {
    entity_id: s.id ?? `ent-${domain}-${slug(s.name)}`,
    name: s.name,
    type: "urn:entity",
    subtype: `urn:entity:${domain}`,
    popularity: s.popularity === undefined ? 0.5 : s.popularity,
    tags: s.genre === null || s.genre === undefined ? [] : [{ id: s.genre.id, name: s.genre.name, type: "urn:tag:genre" }],
    ...(query === undefined ? {} : { query }),
  };
}

const indie = { id: INDIE, name: "Indie Rock" };
const folk = { id: FOLK, name: "Folk" };
const even = { [NOVA.id]: 0.5, [ALPHA.id]: 0.5 };

/**
 * Music: Marigold Static is the under-the-radar pick (FIT 0.75 at or above the median 0.5,
 * popularity 0.4 below the median 0.5); Velvet Lanterns tops FIT but is the most popular.
 */
const MUSIC: Spec[] = [
  { name: "Velvet Lanterns", popularity: 0.9, affinity: 0.8, shares: even, genre: indie },
  { name: "Marigold Static", popularity: 0.4, affinity: 0.7, shares: { [NOVA.id]: 0.6, [ALPHA.id]: 0.4 }, genre: indie },
  { name: "Harbor Pine", popularity: 0.7, affinity: 0.6, shares: { [NOVA.id]: 0.45, [ALPHA.id]: 0.55 }, genre: folk },
  { name: "Low Orchard", popularity: 0.3, affinity: 0.5, shares: { [NOVA.id]: 0.46, [ALPHA.id]: 0.54 }, genre: folk },
  { name: "Saint Ferro", popularity: 0.5, affinity: 0.4, shares: even, genre: indie },
];

const media = (name: string) => ({ id: `urn:tag:genre:media:${slug(name)}`, name });
const PODCASTS: Spec[] = [
  { name: "Field Notes Weekly", popularity: 0.8, affinity: 0.9, shares: even, genre: media("Comedy") },
  { name: "The Long Table", popularity: 0.6, affinity: 0.85, shares: even, genre: media("Comedy") },
  { name: "Quiet Hours", popularity: 0.2, affinity: 0.7, shares: even, genre: media("Documentary") },
  { name: "Small Print Radio", popularity: 0.7, affinity: 0.65, shares: even, genre: media("News") },
  { name: "Night Ferry", popularity: 0.65, affinity: 0.6, shares: even, genre: media("Documentary") },
];

const brandGenre = (leaf: string) => ({ id: `urn:tag:genre:brand:${slug(leaf)}`, name: leaf });
const BRANDS: Spec[] = [
  { name: "Northwind Outfitters", popularity: 0.85, affinity: 0.75, shares: even, genre: brandGenre("Outdoor") },
  { name: "Fernleaf Apothecary", popularity: 0.3, affinity: 0.7, shares: even, genre: brandGenre("Beauty") },
  { name: "Pale Harbor", popularity: 0.6, affinity: 0.65, shares: even, genre: brandGenre("Apparel") },
  { name: "Stonecrop Goods", popularity: 0.55, affinity: 0.6, shares: even, genre: brandGenre("Home") },
  { name: "Driftline", popularity: 0.5, affinity: 0.55, shares: even, genre: brandGenre("Footwear") },
];

type World = Partial<Record<Domain, Spec[]>>;

const BASE_WORLD: World = { artist: MUSIC, podcast: PODCASTS, brand: BRANDS };

// The fake Qloo -----------------------------------------------------------------------------------------

class FakeQlooError extends Error {
  constructor(readonly code: string) {
    super(`fake ${code}`);
  }
}

interface Call {
  domain: Domain;
  params: QlooParams;
}

function domainQloo(world: World, options: { budget?: number; fail?: Partial<Record<Domain, string>> } = {}) {
  const calls: Call[] = [];
  let attempts = 0;
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      attempts += 1;
      if (options.budget !== undefined && attempts > options.budget) throw new BudgetError("run cap reached");
      const domain = filterType.replace("urn:entity:", "") as Domain;
      const failure = options.fail?.[domain];
      if (failure !== undefined) throw new FakeQlooError(failure);
      calls.push({ domain, params });
      const meta: QlooCallMeta = {
        qlooCallId: `qc-${calls.length}`,
        requestId: `req-synthetic-${calls.length}`,
        cache: "miss",
        fetchedAt: FETCHED_AT,
        ms: 5,
        stale: false,
        originRunId: null,
      };
      const entities = (world[domain] ?? []).map((s) => entity(domain, s));
      return { data: { results: { entities } } as unknown as InsightsResponse<F>, meta };
    },
    search: unused,
    entities: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
  };
  return { api, calls };
}

function registry(options: { seeds?: "both" | "nova" | "three"; tags?: boolean } = {}): FakeRegistry {
  const reg = new FakeRegistry();
  reg.registerEntity({ entityId: NOVA.id, name: NOVA.name, type: "artist", popularity: 0.7, disambiguation: null, tags: [] });
  reg.registerEntity({
    entityId: ALPHA.id,
    name: ALPHA.name,
    type: "brand",
    popularity: 0.8,
    disambiguation: null,
    tags: [
      { tagId: WATER_ROOT, name: "Beverage", type: "urn:tag:genre:brand" },
      { tagId: WATER_LEAF, name: "Water", type: "urn:tag:genre:brand" },
    ],
  });
  reg.registerEntity({ entityId: KESTREL.id, name: KESTREL.name, type: "podcast", popularity: 0.6, disambiguation: null, tags: [] });
  if (options.tags !== false) {
    reg.registerTag({ tagId: INDIE, name: "Indie Rock", type: "urn:tag:genre:music", signalCapable: true });
    reg.registerTag({ tagId: DESCRIPTIVE, name: "Outdoorsy", type: "urn:tag:lifestyle:qloo", signalCapable: false });
    reg.registerTag({ tagId: CATEGORY, name: "Reading Room", type: "urn:tag:category:place", signalCapable: true });
  }
  return reg;
}

function input(raw: Partial<{ seeds: string[]; seed_tags: string[]; domains: Domain[]; popularity_max: number; step_id: string | null }> = {}) {
  return crossDomainSkill.input.parse({
    seeds: ["R1", "R2"],
    seed_tags: ["T1"],
    domains: ["brand", "artist", "podcast"],
    popularity_max: 0.85,
    trigger_finding_id: null,
    step_id: "S4",
    ...raw,
  });
}

function setup(world: World = BASE_WORLD, options: { budget?: number; fail?: Partial<Record<Domain, string>>; reg?: FakeRegistry } = {}) {
  const qloo = domainQloo(world, options);
  return { ...fakeRun(qloo.api, options.reg ?? registry()), calls: qloo.calls };
}

function ranked(run: ReturnType<typeof setup>): DatasetOf<"Ranked"> {
  const d = run.ledger.datasets[0];
  if (d?.kind !== "Ranked") throw new Error("expected a Ranked dataset");
  return d;
}

function group(d: DatasetOf<"Ranked">, domain: Domain) {
  const g = d.payload.groups.find((x) => x.key === domain);
  if (g === undefined) throw new Error(`no ${domain} group`);
  return g;
}

function rowNamed(d: DatasetOf<"Ranked">, domain: Domain, label: string) {
  const r = group(d, domain).rows.find((x) => x.label === label);
  if (r === undefined) throw new Error(`no ${label} row`);
  return r;
}

const texts = (run: ReturnType<typeof setup>, digest: ModelDigest) => [
  ...digest.notices,
  ...digest.findings.map((f) => `${f.text} ${f.suggestion?.reason ?? ""}`),
  ...run.ledger.evidences.flatMap((e) => [e.purpose, e.summary]),
  ...run.ledger.datasets.map((d) => (d.kind === "Ranked" ? (d.payload.caption ?? "") : "")),
];

// Rules ---------------------------------------------------------------------------------------------------

describe("cross_domain rules", () => {
  it("keeps an explainability edge only with two or more seeds and share·K ≥ 1.1 (G15)", () => {
    expect(isExplainabilityEdge(0.56, 2)).toBe(true);
    expect(isExplainabilityEdge(0.55, 2)).toBe(true);
    expect(isExplainabilityEdge(0.54, 2)).toBe(false);
    expect(isExplainabilityEdge(0.37, 3)).toBe(true);
    expect(isExplainabilityEdge(0.36, 3)).toBe(false);
    expect(isExplainabilityEdge(1, 1)).toBe(false);
    expect(isExplainabilityEdge(Number.NaN, 2)).toBe(false);
  });

  it("reads a result's genre as its deepest genre tag and ignores other namespaces", () => {
    const tag = (tagId: string) => ({ tagId, name: tagId.split(":").pop() ?? "", type: "urn:tag:genre" });
    expect(genreLeafOf([tag(WATER_ROOT), tag(WATER_LEAF), tag(DESCRIPTIVE)])?.tagId).toBe(WATER_LEAF);
    expect(genreLeafOf([tag(DESCRIPTIVE)])).toBeNull();
  });

  it("lets a row be the UNDER-THE-RADAR pick only at or above the median FIT, below the median popularity and with U > 0", () => {
    const row = (fit: number | null, popularity: number | null) => ({ fit, popularity, utr: fit === null || popularity === null ? null : fit - popularity });
    expect(isUnderTheRadar(row(0.75, 0.4), 0.5, 0.5)).toBe(true);
    expect(isUnderTheRadar(row(0.5, 0.2), 0.5, 0.5)).toBe(true);
    // The top of a mainstream list: FIT 1 and U > 0, but popularity is not below the median.
    expect(isUnderTheRadar(row(1, 0.99), 0.5, 0.98)).toBe(false);
    expect(isUnderTheRadar(row(0.25, 0.1), 0.5, 0.5)).toBe(false);
    expect(isUnderTheRadar(row(0.5, 0.5), 0.5, 0.5)).toBe(false);
    expect(isUnderTheRadar(row(0.3, 0.4), 0.25, 0.5)).toBe(false);
    expect(isUnderTheRadar(row(1, null), 0.5, 0.5)).toBe(false);
  });

  it("keeps every seed's share for a row without an edge, and no shares with one seed", () => {
    const entities = MUSIC.map((s) => entity("artist", s));
    const [two] = computeNeighbourhoods([{ domain: "artist", entities }], [NOVA.id, ALPHA.id]);
    const low = two?.rows.find((r) => r.entity.name === "Low Orchard");
    expect(low?.edges).toEqual([]);
    expect(low?.shares).toEqual([
      { seedEntityId: NOVA.id, share: 0.46 },
      { seedEntityId: ALPHA.id, share: 0.54 },
    ]);
    const marigold = two?.rows.find((r) => r.entity.name === "Marigold Static");
    expect(marigold?.edges).toEqual([{ seedEntityId: NOVA.id, share: 0.6 }]);
    expect(marigold?.shares).toHaveLength(2);

    const [one] = computeNeighbourhoods([{ domain: "artist", entities }], [NOVA.id]);
    expect(one?.rows.every((r) => r.shares.length === 0 && r.edges.length === 0 && r.explained)).toBe(true);
  });
});

// Requests ----------------------------------------------------------------------------------------------

describe("cross_domain: requests", () => {
  it("makes one call per domain in display order, with seeds, tag context, explainability, the cap and take 15", async () => {
    const run = setup();
    await crossDomainSkill.run(input(), run.ctx);

    expect(run.calls.map((c) => c.domain)).toEqual(["artist", "podcast", "brand"]);
    expect(run.calls[0]?.params).toEqual({
      "signal.interests.entities": [NOVA.id, ALPHA.id],
      "signal.interests.tags": [INDIE],
      "feature.explainability": true,
      "filter.popularity.max": 0.85,
      take: 15,
    });
    // The brand call also leaves out the brand seed's own category: its genre:brand leaf (P5).
    expect(run.calls[2]?.params).toEqual({ ...run.calls[0]?.params, "filter.exclude.tags": [WATER_LEAF] });
  });

  it("sends no tag signal without seed tags and drops descriptive and unknown refs with a notice", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input({ seeds: ["R1", "R9"], seed_tags: ["T2", "T7"], domains: ["artist"] }), run.ctx);

    expect(run.calls[0]?.params).toEqual({
      "signal.interests.entities": [NOVA.id],
      "feature.explainability": true,
      "filter.popularity.max": 0.85,
      take: 15,
    });
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining([
        "R9 is not in the registry; left out of the seeds.",
        "T2 (Outdoorsy) is a descriptive tag, which gives no taste signal; left out.",
        "T7 is not in the registry; left out of the seed tags.",
      ]),
    );
  });

  it("sends no category tag as a taste signal: category tags are filters (G10, P5)", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input({ seed_tags: ["T1", "T3"], domains: ["artist"] }), run.ctx);
    expect(run.calls[0]?.params["signal.interests.tags"]).toEqual([INDIE]);
    expect(result.forModel.notices).toContain("T3 (Reading Room) is a category tag, which acts as a filter, not a taste signal; left out.");

    const only = setup();
    await crossDomainSkill.run(input({ seed_tags: ["T3"], domains: ["artist"] }), only.ctx);
    expect(only.calls[0]?.params["signal.interests.tags"]).toBeUndefined();
    // Nothing tells the reader a tag shaped the lists when none was sent.
    expect(only.ledger.evidences[0]?.summary).not.toContain("taste context");
    expect(ranked(only).payload.caption).not.toContain("Seed tags");
  });

  it("notes a brand seed without a category and excludes nothing then", async () => {
    const reg = registry();
    reg.registerEntity({ entityId: "ent-plain-10", name: "Brand Plain", type: "brand", popularity: 0.5, disambiguation: null, tags: [] });
    const run = setup(BASE_WORLD, { reg });
    const result = await crossDomainSkill.run(input({ seeds: ["R4"], domains: ["brand"] }), run.ctx);
    expect(run.calls[0]?.params["filter.exclude.tags"]).toBeUndefined();
    expect(result.forModel.notices).toContain("Brand Plain has no genre:brand tag, so the brand list may include its own category.");
  });

  it("answers an error without calls when no seed is registered", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input({ seeds: ["R8"] }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toContain("R8 is not in the registry");
    expect(run.calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
  });
});

// The happy path ------------------------------------------------------------------------------------------

describe("cross_domain: the cultural neighbourhood", () => {
  it("reads FIT within each call, UNDER-THE-RADAR as FIT − popularity and flags each domain's pick", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual([]);

    const d = ranked(run);
    expect(DATASET_PAYLOADS.Ranked.parse(d.payload)).toEqual(d.payload);
    expect(d.title).toBe("Cultural neighbourhood · Artist Nova and Brand Alpha");
    expect(d.payload.groups.map((g) => [g.key, g.label])).toEqual([
      ["artist", "Music · artists"],
      ["podcast", "Podcasts"],
      ["brand", "Brands"],
    ]);
    expect(d.payload.columns.map((c) => c.key)).toEqual(["fit", "popularity", "utr"]);
    expect(d.formulaIds).toEqual(["pct.within_call", "popularity", "xdom.under_the_radar", "xdom.edge"]);
    expect(d.evidenceIds).toEqual(["E1", "E2", "E3"]);

    const music = group(d, "artist").rows;
    expect(music.map((r) => [r.label, r.rank, r.cells[0]?.value])).toEqual([
      ["Velvet Lanterns", 1, 1],
      ["Marigold Static", 2, 0.75],
      ["Harbor Pine", 3, 0.5],
      ["Low Orchard", 4, 0.25],
      ["Saint Ferro", 5, 0],
    ]);
    const marigold = rowNamed(d, "artist", "Marigold Static");
    expect(marigold.cells[1]).toEqual({ value: 0.4, reason: null });
    expect(marigold.cells[2]?.value).toBeCloseTo(0.35, 10);
    expect(marigold.flags).toEqual(["UTR"]);
    expect(music.filter((r) => r.flags.includes("UTR"))).toHaveLength(1);
    // Velvet Lanterns has FIT 1 (U 0.10) but sits above the median popularity: no flag.
    expect(rowNamed(d, "artist", "Velvet Lanterns").flags).toEqual([]);
    expect(marigold.sublabel).toBe("Indie Rock");
    expect(rowNamed(d, "podcast", "Quiet Hours").flags).toEqual(["UTR"]);
    expect(rowNamed(d, "brand", "Fernleaf Apothecary").flags).toEqual(["UTR"]);
    // A FIT of 0 is the bottom of a scored call, not a missing value.
    expect(rowNamed(d, "artist", "Saint Ferro").cells[0]).toEqual({ value: 0, reason: null });
  });

  it("records per domain the top FIT and the UNDER-THE-RADAR pick's score, cited to that domain's call", async () => {
    const run = setup();
    await crossDomainSkill.run(input(), run.ctx);
    const metrics = run.ledger.metrics;

    expect(metrics.map((m) => [m.key, m.formulaId, m.badge])).toEqual([
      ["xdom.fit", "pct.within_call", "DERIVED"],
      ["xdom.under_the_radar", "xdom.under_the_radar", "DERIVED"],
      ["xdom.fit", "pct.within_call", "DERIVED"],
      ["xdom.under_the_radar", "xdom.under_the_radar", "DERIVED"],
      ["xdom.fit", "pct.within_call", "DERIVED"],
      ["xdom.under_the_radar", "xdom.under_the_radar", "DERIVED"],
      ["xdom.edge", "xdom.edge", "DERIVED"],
    ]);
    for (const m of metrics) {
      expect(isFormulaId(m.formulaId)).toBe(true);
      expect(m.evidenceIds.length).toBeGreaterThan(0);
      for (const id of m.evidenceIds) expect(run.ledger.evidence(id)).toBeDefined();
    }
    const [fit, utr] = metrics;
    // Labels leave the name to the subject ref and the digest row, which keeps the digest within budget.
    expect(fit).toMatchObject({ label: "music · FIT of the top result", display: "rank 1 of 5", value: 1, unit: "pct", comparator: "WITHIN_CALL", evidenceIds: ["E1"], n: 5 });
    expect(utr).toMatchObject({ label: "music · under-the-radar pick", display: "0.35 · fit 0.75 − popularity 0.40", evidenceIds: ["E1"] });
    expect(utr?.value).toBeCloseTo(0.35, 10);
    expect(run.registry.entity(fit?.subjectRefs[0] ?? "")?.name).toBe("Velvet Lanterns");
    expect(run.registry.entity(utr?.subjectRefs[0] ?? "")?.name).toBe("Marigold Static");
    // Subjects are refs the registry holds, never Qloo ids.
    for (const m of metrics) for (const s of m.subjectRefs) expect(s).toMatch(/^R\d+$/);
  });

  it("keeps explainability edges by share·K ≥ 1.1 and counts the results that lean on one seed", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input(), run.ctx);
    const d = ranked(run);

    expect(rowNamed(d, "artist", "Marigold Static").explain).toEqual([{ seedRef: "R1", share: 0.6 }]);
    expect(rowNamed(d, "artist", "Harbor Pine").explain).toEqual([{ seedRef: "R2", share: 0.55 }]);
    expect(rowNamed(d, "artist", "Low Orchard").explain).toEqual([]);
    expect(rowNamed(d, "artist", "Low Orchard").shares).toEqual([{ seedRef: "R1", share: 0.46 }, { seedRef: "R2", share: 0.54 }]);
    expect(rowNamed(d, "artist", "Velvet Lanterns").explain).toEqual([]);

    const edge = run.ledger.metrics.find((m) => m.key === "xdom.edge");
    expect(edge).toMatchObject({ value: 2, display: "2 of 15 results", n: 15, subjectRefs: ["R1", "R2"], evidenceIds: ["E1", "E2", "E3"] });
    const rows = result.forModel.top_rows;
    expect(rows.find((r) => r.name === "Marigold Static")?.values.leans_on).toBe("R1");
  });

  it("draws no edges from a single seed and says so", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input({ seeds: ["R1"] }), run.ctx);
    const d = ranked(run);
    expect(d.payload.groups.flatMap((g) => g.rows).every((r) => r.explain.length === 0)).toBe(true);
    expect(run.ledger.metrics.some((m) => m.key === "xdom.edge")).toBe(false);
    expect(d.formulaIds).not.toContain("xdom.edge");
    expect(result.forModel.notices).toContain(
      "With one seed every result is explained by it alone; explainability edges need two or more seeds.",
    );
  });

  it("writes one evidence bundle per domain with the halo of its results' genre tags", async () => {
    const run = setup();
    await crossDomainSkill.run(input(), run.ctx);
    expect(run.ledger.evidences.map((e) => [e.purpose, e.status, e.qlooCallIds])).toEqual([
      ["Cultural neighbourhood in artists for Artist Nova and Brand Alpha", "ok", ["qc-1"]],
      ["Cultural neighbourhood in podcasts for Artist Nova and Brand Alpha", "ok", ["qc-2"]],
      ["Cultural neighbourhood in brands for Artist Nova and Brand Alpha", "ok", ["qc-3"]],
    ]);
    expect(run.ledger.evidences[0]?.summary).toBe(
      "5 artists under a popularity cap of 0.85, with 1 seed tag as taste context: 5 scored; " +
        "most often tagged Indie Rock (3), Folk (2); under-the-radar pick Marigold Static " +
        "(median FIT 0.50, median popularity 0.50); 2 of 5 explained results lean on one seed.",
    );
  });

  it("gives the model the shown rows with their metric ids, registers only those and leaks no Qloo id", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input(), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "cross_domain", step: "S4" })).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("ent-");

    // Priority order, since the digest is trimmed from the end: every domain's top row, then every
    // pick, then the next rows by FIT, one domain at a time, up to twelve.
    expect(digest.top_rows.map((r) => r.name)).toEqual([
      "Velvet Lanterns",
      "Field Notes Weekly",
      "Northwind Outfitters",
      "Marigold Static",
      "Quiet Hours",
      "Fernleaf Apothecary",
      "The Long Table",
      "Harbor Pine",
      "Pale Harbor",
      "Low Orchard",
      "Small Print Radio",
      "Stonecrop Goods",
    ]);
    const velvet = digest.top_rows[0];
    const marigold = digest.top_rows[3];
    expect(velvet?.values).toMatchObject({ domain: "artist", rank: 1, genre: "Indie Rock", fit_metric: "M1", domain_tags: "Indie Rock, Folk" });
    expect(velvet?.values.under_the_radar).toBeUndefined();
    expect(marigold?.values).toMatchObject({ domain: "artist", rank: 2, utr_metric: "M2", under_the_radar: "pick" });
    expect(digest.registered.map((r) => r.name)).toEqual(digest.top_rows.map((r) => r.name));
    expect(digest.registered.map((r) => r.type)).toEqual([
      ...["artist", "podcast", "brand"],
      ...["artist", "podcast", "brand"],
      ...["podcast", "artist", "brand", "artist", "podcast", "brand"],
    ]);
    expect(digest.top_rows.every((r) => r.ref !== null)).toBe(true);
    // Unshown results stay in the dataset only, without a ref.
    expect(rowNamed(ranked(run), "artist", "Saint Ferro").ref).toBeNull();
    expect(rowNamed(ranked(run), "artist", "Velvet Lanterns").ref).toBe(velvet?.ref);
    expect(result.metricIds).toEqual(digest.metrics.map((m) => m.id));
  });

  it("keeps every domain's top row and pick when five domains share the twelve rows", async () => {
    const world: World = { ...BASE_WORLD, tv_show: MUSIC, movie: PODCASTS };
    const run = setup(world);
    const result = await crossDomainSkill.run(input({ domains: ALL_DOMAINS }), run.ctx);
    const rows = result.forModel.top_rows;
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 5).map((r) => [r.values.domain, r.values.rank])).toEqual(ALL_DOMAINS.map((d) => [d, 1]));
    expect(rows.slice(5, 10).map((r) => [r.values.domain, r.values.under_the_radar])).toEqual(ALL_DOMAINS.map((d) => [d, "pick"]));
    // The two rows left after the five tops and picks go to the next rows by FIT, domain by domain.
    const names = (domain: Domain) => rows.filter((r) => r.values.domain === domain).map((r) => r.name);
    expect(names("artist")).toEqual(["Velvet Lanterns", "Marigold Static"]);
    expect(names("podcast")).toEqual(["Field Notes Weekly", "Quiet Hours", "The Long Table"]);
    expect(names("movie")).toEqual(["Field Notes Weekly", "Quiet Hours", "The Long Table"]);
    expect(names("brand")).toEqual(["Northwind Outfitters", "Fernleaf Apothecary"]);
  });

  it("counts a status row for each domain without results against the twelve, right after the top rows", async () => {
    const run = setup({ artist: mainstream("Arena Act") }, { budget: 1 });
    const result = await crossDomainSkill.run(input({ domains: ["artist", "podcast"] }), run.ctx);
    expect(result.forModel.top_rows.map((r) => r.values.domain)).toEqual(["artist", "podcast", ...Array(9).fill("artist")]);
  });

  it("never calls a tag signal a genre steer, and names seed tags taste context", async () => {
    const run = setup();
    const result = await crossDomainSkill.run(input(), run.ctx);
    const all = texts(run, result.forModel).join(" ");
    expect(all).not.toMatch(/steer/i);
    expect(ranked(run).payload.caption).toContain("Seed tags are taste context next to the seeds, not a genre filter.");
    expect(ranked(run).payload.caption).toContain("Explainability is attribution inside Qloo's model, not causation.");
    expect(ranked(run).payload.caption).toContain(
      "UTR marks the highest one with FIT at or above the domain's median and popularity below its median.",
    );
  });

  it("returns the skill's fixed method limitations", () => {
    expect(crossDomainSkill.limitations([])).toEqual([...SKILL_LIMITATIONS.cross_domain]);
    expect(crossDomainSkill.mnemonic).toBe("XDOM");
  });
});

// The UNDER-THE-RADAR pick ------------------------------------------------------------------------------

describe("cross_domain: the UNDER-THE-RADAR pick", () => {
  it("flags nothing in an all-mainstream list, although its top row has FIT 1 and U > 0", async () => {
    const arena: Spec[] = [
      { name: "Arena One", popularity: 0.99, affinity: 0.9, genre: indie },
      { name: "Arena Two", popularity: 0.98, affinity: 0.8, genre: indie },
      { name: "Arena Three", popularity: 0.97, affinity: 0.7, genre: indie },
    ];
    const run = setup({ artist: arena });
    const result = await crossDomainSkill.run(input({ domains: ["artist"], popularity_max: 1 }), run.ctx);

    const rows = group(ranked(run), "artist").rows;
    expect(rows[0]?.cells[2]?.value).toBeCloseTo(0.01, 10);
    expect(rows.some((r) => r.flags.includes("UTR"))).toBe(false);
    expect(run.ledger.metrics.some((m) => m.key === "xdom.under_the_radar")).toBe(false);
    expect(run.ledger.evidences[0]?.summary).toContain("no under-the-radar pick (median FIT 0.50, median popularity 0.98)");
    const top = result.forModel.top_rows[0];
    expect(top?.values).toMatchObject({ rank: 1, fit_metric: "M1", under_the_radar: "none" });
    expect(top?.values.utr_metric).toBeUndefined();
    expect(result.forModel.top_rows.some((r) => r.values.under_the_radar === "pick")).toBe(false);
  });

  it("passes over a rank-1 row above the median popularity for a less popular row, even with a higher U", async () => {
    const list: Spec[] = [
      { name: "Bright Arena", popularity: 0.6, affinity: 0.9 },
      { name: "Cellar Lights", popularity: 0.4, affinity: 0.8 },
      { name: "Grand Hall", popularity: 0.7, affinity: 0.7 },
      { name: "Back Room", popularity: 0.3, affinity: 0.6 },
      { name: "Side Stage", popularity: 0.5, affinity: 0.5 },
    ];
    const run = setup({ artist: list });
    const result = await crossDomainSkill.run(input({ domains: ["artist"] }), run.ctx);

    const d = ranked(run);
    // Bright Arena: U 0.40 but popularity 0.60 ≥ median 0.50. Cellar Lights: U 0.35, FIT 0.75, popularity 0.40.
    expect(rowNamed(d, "artist", "Bright Arena").cells[2]?.value).toBeCloseTo(0.4, 10);
    expect(rowNamed(d, "artist", "Bright Arena").flags).toEqual([]);
    expect(rowNamed(d, "artist", "Cellar Lights").flags).toEqual(["UTR"]);
    // Back Room is less popular still, but below the median FIT.
    expect(rowNamed(d, "artist", "Back Room").flags).toEqual([]);
    const utr = run.ledger.metrics.find((m) => m.key === "xdom.under_the_radar");
    expect(utr?.value).toBeCloseTo(0.35, 10);
    expect(run.registry.entity(utr?.subjectRefs[0] ?? "")?.name).toBe("Cellar Lights");
    expect(result.forModel.top_rows.map((r) => [r.name, r.values.under_the_radar])).toEqual(
      expect.arrayContaining([
        ["Bright Arena", undefined],
        ["Cellar Lights", "pick"],
      ]),
    );
  });

  it("lets the top row be the pick when it is also below the median popularity, shown once", async () => {
    const list: Spec[] = [
      { name: "Quiet Giant", popularity: 0.2, affinity: 0.9 },
      { name: "Loud Neighbour", popularity: 0.9, affinity: 0.8 },
      { name: "Middle Ground", popularity: 0.5, affinity: 0.7 },
      { name: "Even Keel", popularity: 0.6, affinity: 0.6 },
      { name: "Late Bloom", popularity: 0.7, affinity: 0.5 },
    ];
    const run = setup({ artist: list });
    const result = await crossDomainSkill.run(input({ domains: ["artist"] }), run.ctx);
    expect(rowNamed(ranked(run), "artist", "Quiet Giant").flags).toEqual(["UTR"]);
    const giant = result.forModel.top_rows.filter((r) => r.name === "Quiet Giant");
    expect(giant).toHaveLength(1);
    expect(giant[0]?.values).toMatchObject({ rank: 1, fit_metric: "M1", utr_metric: "M2", under_the_radar: "pick" });
  });
});

// Unscored, dropped and missing values --------------------------------------------------------------------

describe("cross_domain: unscored and dropped values stay explicit", () => {
  it("leaves floor ties and rows without an affinity unscored, never ranked last or shown as 0", async () => {
    const floor = 0.0213;
    const world: World = {
      artist: [...MUSIC.slice(0, 3), { name: "Tied Floor One", affinity: floor, genre: folk }, { name: "No Score", genre: folk }],
      podcast: [...PODCASTS.slice(0, 4), { name: "Tied Floor Two", affinity: floor }],
    };
    const run = setup(world);
    const result = await crossDomainSkill.run(input({ domains: ["artist", "podcast"] }), run.ctx);

    expect(result.flags).toContain("NOT_SCORED");
    const d = ranked(run);
    for (const [domain, label] of [["artist", "Tied Floor One"], ["artist", "No Score"], ["podcast", "Tied Floor Two"]] as const) {
      const r = rowNamed(d, domain, label);
      expect(r.rank).toBeNull();
      expect(r.cells[0]).toEqual({ value: null, reason: "not_scored" });
      expect(r.cells[2]).toEqual({ value: null, reason: "not_scored" });
    }
    // Percentiles cover the three scored music rows only.
    expect(group(d, "artist").rows.slice(0, 3).map((r) => r.cells[0]?.value)).toEqual([1, 0.5, 0]);
    expect(run.ledger.evidences[0]?.summary).toContain("3 scored, 2 not scored");
    expect(run.ledger.evidences[0]?.flags).toEqual(["NOT_SCORED"]);
  });

  it("leaves a flat call unscored: its rows tie at their own minimum, above the other calls' scores", async () => {
    const flat: Spec[] = ["Even One", "Even Two", "Even Three"].map((name) => ({ name, affinity: 0.6 }));
    const run = setup({ artist: MUSIC, podcast: flat });
    const result = await crossDomainSkill.run(input({ domains: ["artist", "podcast"] }), run.ctx);
    const d = ranked(run);
    expect(group(d, "podcast").rows.every((r) => r.rank === null && r.cells[0]?.reason === "not_scored")).toBe(true);
    expect(group(d, "artist").rows.every((r) => r.rank !== null)).toBe(true);
    expect(run.ledger.findings.map((f) => f.kind)).toContain("EMPTY_RESULT");
    expect(result.status).toBe("partial");
  });

  it("keeps a result without a popularity, with its under-the-radar score not measured", async () => {
    const world: World = { tv_show: [{ name: "Harbor Lights", popularity: null, affinity: 0.9 }, { name: "Glass Valley", popularity: 0.3, affinity: 0.8 }, { name: "Quiet County", popularity: 0.6, affinity: 0.7 }, { name: "Long Shadow", popularity: 0.5, affinity: 0.6 }, { name: "Red Mesa", popularity: 0.4, affinity: 0.5 }] };
    const run = setup(world);
    const result = await crossDomainSkill.run(input({ domains: ["tv_show"] }), run.ctx);
    const row = rowNamed(ranked(run), "tv_show", "Harbor Lights");
    expect(row.rank).toBe(1);
    expect(row.cells).toEqual([
      { value: 1, reason: null },
      { value: null, reason: "not_measured" },
      { value: null, reason: "not_measured" },
    ]);
    expect(result.forModel.notices).toContain("1 TV show result came without a popularity, so its under-the-radar score is not measured.");
    expect(result.forModel.top_rows[0]?.values.popularity).toBe("not measured");
    // U and its medians use the rows that have a popularity: Glass Valley, 0.75 − 0.30.
    const utr = run.ledger.metrics.find((m) => m.key === "xdom.under_the_radar");
    expect(utr?.label).toBe("TV · under-the-radar pick");
    expect(run.registry.entity(utr?.subjectRefs[0] ?? "")?.name).toBe("Glass Valley");
    expect(utr?.n).toBe(4);
    expect(rowNamed(ranked(run), "tv_show", "Glass Valley").flags).toEqual(["UTR"]);
  });

  it("records the under-the-radar score as not measured when no result has a popularity", async () => {
    const world: World = { movie: [{ name: "Copper Sky", popularity: null, affinity: 0.9 }, { name: "Salt Road", popularity: null, affinity: 0.8 }] };
    const run = setup(world);
    const result = await crossDomainSkill.run(input({ domains: ["movie"] }), run.ctx);
    const utr = run.ledger.metrics.find((m) => m.key === "xdom.under_the_radar");
    expect(utr).toMatchObject({ label: "movie · under-the-radar score", value: null, badge: "UNAVAILABLE", reason: "not_measured", display: "not measured", subjectRefs: ["R1", "R2"] });
    expect(ranked(run).payload.groups[0]?.rows.some((r) => r.flags.includes("UTR"))).toBe(false);
    // The top row points to the UNAVAILABLE metric rather than saying "none".
    expect(result.forModel.top_rows[0]?.values).toMatchObject({ under_the_radar: "not measured", utr_metric: utr?.id });
  });

  it("drops results below the popularity quality gate before any statistic and shows them as dropped", async () => {
    const world: World = { artist: [...MUSIC, { name: "Brand Junk", popularity: 0.004, affinity: 0.95 }] };
    const run = setup(world);
    // The fake ledger keeps the contract fields only, so the drop count is read off the input.
    const addEvidence = vi.spyOn(run.ledger, "addEvidence");
    const result = await crossDomainSkill.run(input({ domains: ["artist"] }), run.ctx);
    expect(result.flags).toContain("QUALITY_GATE_DROPPED");
    expect(addEvidence.mock.calls[0]?.[0]).toMatchObject({ qualityGateDrops: 1, flags: ["QUALITY_GATE_DROPPED"] });
    const d = ranked(run);
    expect(d.formulaIds).toContain("quality_gate");
    const junk = rowNamed(d, "artist", "Brand Junk");
    expect(junk).toMatchObject({ rank: null, flags: [], explain: [] });
    expect(junk.cells).toEqual([
      { value: null, reason: "quality_gate" },
      { value: 0.004, reason: null },
      { value: null, reason: "quality_gate" },
    ]);
    expect(group(d, "artist").rows.at(-1)?.label).toBe("Brand Junk");
    // The gate runs before ranking: Velvet Lanterns still tops the call.
    expect(rowNamed(d, "artist", "Velvet Lanterns").cells[0]?.value).toBe(1);
  });

  it("leaves seeds out of their own neighbourhood", async () => {
    const run = setup({ podcast: [{ name: KESTREL.name, id: KESTREL.id, affinity: 0.99 }, ...PODCASTS] });
    await crossDomainSkill.run(input({ seeds: ["R3"], domains: ["podcast"] }), run.ctx);
    expect(group(ranked(run), "podcast").rows.map((r) => r.label)).not.toContain(KESTREL.name);
    expect(group(ranked(run), "podcast").rows).toHaveLength(5);
  });
});

// Empty, partial and truncated -----------------------------------------------------------------------------

describe("cross_domain: empty, partial and budget-truncated results", () => {
  it("reports an empty domain with EMPTY_RESULT, THIN_RESULT and an explained row, the rest still ok", async () => {
    const run = setup({ artist: MUSIC, podcast: [] });
    const result = await crossDomainSkill.run(input({ domains: ["artist", "podcast"] }), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.flags).toContain("THIN_RESULT");
    const empty = run.ledger.findings.find((f) => f.kind === "EMPTY_RESULT");
    expect(empty?.text).toBe("The podcast call for Artist Nova and Brand Alpha returned no usable results.");
    expect(empty?.suggestion).toEqual({ tool: "cross_domain", reason: "Re-run the podcast domain with a higher popularity_max or without seed_tags." });
    expect(run.ledger.evidences[1]).toMatchObject({ status: "empty", flags: ["THIN_RESULT"] });
    expect(group(ranked(run), "podcast").rows).toEqual([
      expect.objectContaining({ key: "podcast-gap", label: "Not measured", sublabel: "no results under this popularity cap", rank: null }),
    ]);
    expect(group(ranked(run), "podcast").rows[0]?.cells.every((c) => c.value === null && c.reason === "not_measured")).toBe(true);
    // The status row follows the top rows, so trimming never removes it before the extra rows.
    expect(result.forModel.top_rows[1]).toEqual({ ref: null, name: "Podcasts", values: { domain: "podcast", status: "empty" } });
  });

  it("is empty when no domain returns anything, and offers no broadening that cannot help", async () => {
    const run = setup({});
    const result = await crossDomainSkill.run(input({ domains: ["movie"], seed_tags: [], popularity_max: 1 }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.findings.map((f) => [f.kind, f.suggestion])).toEqual([["EMPTY_RESULT", null]]);
    expect(run.ledger.metrics).toEqual([]);
  });

  it("keeps the answered domains when the budget refuses the rest", async () => {
    const run = setup(BASE_WORLD, { budget: 2 });
    const result = await crossDomainSkill.run(input(), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.calls.map((c) => c.domain)).toEqual(["artist", "podcast"]);
    expect(result.forModel.notices).toContain("The brand call was not made (run budget), so the brand neighbourhood is not measured.");
    const brand = group(ranked(run), "brand").rows;
    expect(brand).toHaveLength(1);
    expect(brand[0]).toMatchObject({ key: "brand-gap", sublabel: "call not made: run budget reached" });
    expect(brand[0]?.cells.every((c) => c.value === null && c.reason === "budget_truncated")).toBe(true);
    expect(result.forModel.top_rows[2]?.values).toEqual({ domain: "brand", status: "budget_truncated" });
    expect(run.ledger.metrics.filter((m) => m.key === "xdom.fit")).toHaveLength(2);
    // The edge count covers the answered domains only.
    expect(run.ledger.metrics.find((m) => m.key === "xdom.edge")?.evidenceIds).toEqual(["E1", "E2"]);
  });

  it("returns a partial result with no evidence when the budget refuses every call", async () => {
    const run = setup(BASE_WORLD, { budget: 0 });
    const result = await crossDomainSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toHaveLength(0);
    expect(result.forModel.top_rows.map((r) => r.values.status)).toEqual(["budget_truncated", "budget_truncated", "budget_truncated"]);
  });

  it("explains a failed domain call as a gap and keeps the others", async () => {
    const run = setup(BASE_WORLD, { fail: { podcast: "qloo_unavailable" } });
    const result = await crossDomainSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).not.toContain("BUDGET_TRUNCATED");
    expect(result.forModel.notices).toContain("The podcast call failed (qloo_unavailable), so the podcast neighbourhood is not measured.");
    expect(group(ranked(run), "podcast").rows[0]?.cells[0]).toEqual({ value: null, reason: "error" });
  });

  it("fails like the client when every call fails, and on a request the client rejects as a bug", async () => {
    await expect(crossDomainSkill.run(input({ domains: ["artist"] }), setup(BASE_WORLD, { fail: { artist: "qloo_unavailable" } }).ctx)).rejects.toThrow(
      "fake qloo_unavailable",
    );
    await expect(crossDomainSkill.run(input(), setup(BASE_WORLD, { fail: { brand: "qloo_param" } }).ctx)).rejects.toThrow("fake qloo_param");
  });
});

// Findings ----------------------------------------------------------------------------------------------

/** Ten results whose FIT order is exactly their popularity order: ρ = 1. */
function mainstream(prefix: string): Spec[] {
  return Array.from({ length: 10 }, (_, i) => ({ name: `${prefix} ${i + 1}`, popularity: 0.8 - 0.05 * i, affinity: 0.9 - 0.05 * i }));
}

describe("cross_domain: findings", () => {
  it("flags POPULARITY_DOMINANCE per domain and suggests a lower cap, citing the domain's metrics", async () => {
    const run = setup({ artist: mainstream("Arena Act"), podcast: PODCASTS });
    await crossDomainSkill.run(input({ domains: ["artist", "podcast"], popularity_max: 1 }), run.ctx);
    const found = run.ledger.findings.filter((f) => f.kind === "POPULARITY_DOMINANCE");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("In the music results, taste fit closely tracks popularity, so the ranking leans on mainstream names.");
    expect(found[0]?.suggestion).toEqual({ tool: "cross_domain", reason: "Re-run with popularity_max 0.85 to surface less mainstream picks." });
    // A list whose FIT order is its popularity order has no pick, so only its FIT metric is cited.
    expect(found[0]?.metricIds).toEqual(["M1"]);
  });

  it("gives the domains one finding per wording, since the cap the re-run lowers is one value for the call", async () => {
    const charts: Spec[] = [0.99, 0.98, 0.97, 0.96, 0.4].map((popularity, i) => ({ name: `Chart Label ${i + 1}`, popularity, affinity: 0.9 - 0.1 * i }));
    const run = setup({ artist: mainstream("Arena Act"), movie: mainstream("Big Screen"), brand: charts, podcast: PODCASTS });
    await crossDomainSkill.run(input({ domains: ["artist", "podcast", "movie", "brand"], popularity_max: 1 }), run.ctx);
    const found = run.ledger.findings.filter((f) => f.kind === "POPULARITY_DOMINANCE");
    expect(found.map((f) => [f.text, f.suggestion?.reason])).toEqual([
      [
        "In the music and movie results, taste fit closely tracks popularity, so the ranking leans on mainstream names.",
        "Re-run with popularity_max 0.85 to surface less mainstream picks.",
      ],
      [
        "Most of the brand results are among the most popular entities in Qloo, so the ranking leans on mainstream names.",
        "Re-run with popularity_max 0.85 to surface less mainstream picks.",
      ],
    ]);
    // Each finding cites the metrics of every domain it names: music M1, movie M4 (podcast holds M2, M3).
    expect(found[0]?.metricIds).toEqual(["M1", "M4"]);
    expect(found[1]?.metricIds).toEqual(["M5"]);
  });

  it("suggests no re-run once the cap is at its floor", async () => {
    const run = setup({ artist: mainstream("Arena Act") });
    await crossDomainSkill.run(input({ domains: ["artist"], popularity_max: 0.5 }), run.ctx);
    expect(run.ledger.findings.find((f) => f.kind === "POPULARITY_DOMINANCE")?.suggestion).toBeNull();
  });
});

// Digest budget -----------------------------------------------------------------------------------------

describe("cross_domain: digest budget", () => {
  const shares = { [NOVA.id]: 0.7, [ALPHA.id]: 0.2, [KESTREL.id]: 0.1 };
  const omittedNotices = (digest: ModelDigest) => digest.notices.filter((n) => n.includes("rows left out"));

  it("keeps every domain's top row, then the picks, with five full domains, three seeds, 40-character names and three notices", async () => {
    const long = (s: string) => `${s} Heritage Collective Recording Company`.slice(0, 40);
    // Eleven of fifteen results above popularity 0.95 (POPULARITY_DOMINANCE in every domain) and four
    // well below it, so every domain also has a pick, its metric and its row.
    const low = new Set([1, 5, 9, 13]);
    const full = (prefix: string): Spec[] =>
      Array.from({ length: 15 }, (_, i) => ({
        name: long(`${prefix} ${i + 1}`),
        popularity: low.has(i) ? 0.3 + 0.01 * i : 0.999 - 0.002 * i,
        affinity: 0.95 - 0.02 * i,
        shares,
        genre: { id: `urn:tag:genre:music:long_${i % 3}`, name: `Long Genre Name Number ${i % 3} Extended` },
      }));
    const world: World = { artist: full("Act"), podcast: full("Show"), tv_show: full("Series"), movie: full("Film"), brand: full("Label") };
    const reg = registry();
    reg.registerEntity({ entityId: "ent-plain-10", name: "Brand Plain Without Any Category Tag", type: "brand", popularity: 0.5, disambiguation: null, tags: [] });
    const run = setup(world, { reg });
    const result = await crossDomainSkill.run(
      input({ seeds: ["R1", "R4", "R3"], seed_tags: ["T1", "T2", "T3"], domains: ALL_DOMAINS, popularity_max: 1 }),
      run.ctx,
    );

    expect(result.status).toBe("ok");
    expect(run.ledger.findings.map((f) => [f.kind, f.metricIds.length])).toEqual([["POPULARITY_DOMINANCE", 10]]);
    expect(run.ledger.metrics).toHaveLength(11);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "cross_domain", step: "S4" })).toBe(true);
    // Rows may be cut to fit, never metrics or findings.
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.findings).toHaveLength(1);
    expect(digest.notices).toEqual(expect.arrayContaining([expect.stringContaining("T2 (Outdoorsy)"), expect.stringContaining("T3 (Reading Room)")]));
    // Rows go from the end: the extra rows by FIT first, then the last picks, never a top row. This
    // extreme case keeps the five top rows and four picks; the realistic case below keeps all twelve.
    const rows = digest.top_rows;
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.slice(0, 5).map((r) => [r.values.domain, r.values.rank])).toEqual(ALL_DOMAINS.map((d) => [d, 1]));
    const picks = rows.slice(5, 10);
    expect(picks.map((r) => [r.values.domain, r.values.under_the_radar])).toEqual(ALL_DOMAINS.slice(0, picks.length).map((d) => [d, "pick"]));
    const omitted = 12 - rows.length;
    expect(omittedNotices(digest)).toEqual(omitted === 0 ? [] : [`${omitted} of 12 rows left out to fit this result; the full table is in D1.`]);
  });

  it("shows all twelve rows of a heavy realistic run, with no rows left out", async () => {
    const names = ["Velvet Lantern Society", "Marigold Static Band", "Harbor Pine Collective", "Low Orchard Trio", "Saint Ferro and Sons", "Quiet Hours Ensemble", "Night Ferry Players", "Small Print Radio Hour", "Glass Valley Echoes", "Red Mesa Sound", "Copper Sky Union", "Salt Road Revival", "Long Shadow Choir", "Pale Harbor Group", "Driftline Assembly"];
    const list = (domain: Domain, dominant: boolean): Spec[] =>
      names.map((name, i) => ({
        name,
        popularity: domain === "tv_show" && i === 3 ? null : dominant ? 0.85 - 0.01 * i : 0.2 + ((i * 37) % 60) / 100,
        affinity: 0.95 - 0.02 * i,
        shares,
        genre: media(`Genre ${i % 4} Name`),
      }));
    const world: World = { artist: list("artist", true), podcast: list("podcast", false), tv_show: list("tv_show", false), movie: list("movie", true), brand: list("brand", false) };
    const run = setup(world);
    const result = await crossDomainSkill.run(
      input({ seeds: ["R1", "R2", "R3"], seed_tags: ["T1", "T2", "T3"], domains: ALL_DOMAINS, popularity_max: 0.9 }),
      run.ctx,
    );
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "cross_domain", step: "S4" })).toBe(true);
    expect(digest.notices).toHaveLength(3);
    expect(digest.findings).toHaveLength(1);
    expect(digest.top_rows).toHaveLength(12);
    expect(omittedNotices(digest)).toEqual([]);
    expect(new Set(digest.top_rows.map((r) => r.values.domain))).toEqual(new Set(ALL_DOMAINS));
  });
});

// estimateCalls -----------------------------------------------------------------------------------------

describe("cross_domain: estimateCalls", () => {
  it("costs one call per domain cold, as the run sends it, and nothing with a warm cache", async () => {
    const reg = registry();
    const cold = fakeProbe(() => false);
    expect(await estimateCrossDomainCalls(input(), cold, reg)).toBe(3);

    const run = setup(BASE_WORLD, { reg });
    await crossDomainSkill.run(input(), run.ctx);
    // The probe sees exactly the requests the run sent, filter.type included.
    expect(cold.asked.map((a) => a.params)).toEqual(
      run.calls.map((c) => ({ "filter.type": `urn:entity:${c.domain}`, ...c.params })),
    );
    expect(cold.asked.every((a) => a.path === "/v2/insights")).toBe(true);

    const warm = fakeProbe(() => true);
    expect(await crossDomainSkill.estimateCalls(input(), warm, reg)).toBe(0);
    const brandCached = fakeProbe((_, p) => p["filter.type"] === "urn:entity:brand");
    expect(await crossDomainSkill.estimateCalls(input(), brandCached, reg)).toBe(2);
  });

  it("costs nothing when no seed is registered", async () => {
    const probe = fakeProbe(() => false);
    expect(await crossDomainSkill.estimateCalls(input({ seeds: ["R9"] }), probe, registry())).toBe(0);
    expect(probe.asked).toHaveLength(0);
  });
});
