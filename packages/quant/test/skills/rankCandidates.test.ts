import {
  DatasetEnvelope,
  digestFits,
  ModelDigest,
  RankedPayload,
  SlopePayload,
  type DatasetOf,
  type GeoApi,
  type LocalityApi,
  type QlooApi,
  type QlooEntity,
  type QlooParams,
  type SkillCtx,
  type ToolInput,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { NAME_MAX } from "../../src/skills/format";
import { estimateRankCandidatesCalls, rankCandidatesSkill } from "../../src/skills/rankCandidates";
import { RANK_SHIFT_FORMULA, tenantFit } from "../../src/skills/rankCandidates/outputs";
import { fakeProbe, fakeQloo, fakeRun, FakeRegistry, insightEntity, registerInvented, type Invented } from "./support/fakes";
import { ALPHA, ARTIST_NOVA, BETA, DELTA, EPSILON, GAMMA } from "./support/world";

// rank_candidates against a scripted Qloo: each context answers from a score table, in reverse
// candidate order, so ranks must come from affinities. Invented entities, areas and locality ids
// only (D29).

type Score = number | "drop";
type Table = Record<string, Record<string, Score>>;
type RankInput = ToolInput<"rank_candidates">;

const list = (v: QlooParams[string] | undefined): string[] => (v === undefined ? [] : typeof v === "object" ? [...v] : [String(v)]);

function contextKey(params: QlooParams): string {
  if (params["signal.demographics.age"] !== undefined) return `age:${String(params["signal.demographics.age"])}`;
  if (params["signal.demographics.audiences"] !== undefined) return `audience:${list(params["signal.demographics.audiences"])[0]}`;
  if (params["signal.location"] !== undefined) return `location:${String(params["signal.location"])}`;
  return "none";
}

function tableInsights(table: Table, known: readonly Invented[]): (params: QlooParams) => QlooEntity[] {
  return (params) => {
    const row = table[contextKey(params)] ?? {};
    return list(params["filter.results.entities"])
      .filter((id) => row[id] !== "drop")
      .reverse()
      .map((id) => insightEntity(known.find((e) => e.id === id) ?? { id, name: id, category: null }, row[id] as number | undefined));
  };
}

const EAST_SIDE_WKT = "POLYGON((-86.76 36.17, -86.74 36.17, -86.74 36.19, -86.76 36.17))";

/** The gazetteer as the skill sees it: one invented Nashville neighbourhood. */
const GEO: GeoApi = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: () => [],
  neighbourhood: (metro, id) =>
    metro === "nashville" && id === "east_side"
      ? { id, name: "East Side", metro, centroid: { lat: 36.18, lon: -86.75 }, areaKm2: 4 }
      : null,
  matchNeighbourhood: () => null,
  polygonWkt: (metro, id) => (metro === "nashville" && id === "east_side" ? EAST_SIDE_WKT : null),
  locate: () => null,
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "invented",
};

const PINS: Record<string, { entityId: string; label: string }> = {
  nashville: { entityId: "loc-nashville", label: "Nashville" },
  austin: { entityId: "loc-austin", label: "Austin" },
};

/** The run's locality pins (SkillCtx.localities). */
const LOCALITIES: LocalityApi = { market: async (m) => PINS[m] ?? null };

const FIVE = [ALPHA, BETA, GAMMA, DELTA, EPSILON];

/** Delta climbs most at the East Side against Nashville; Alpha leads the city and falls at the site. */
const TENANT: Table = {
  "location:loc-nashville": { [ALPHA.id]: 0.7, [BETA.id]: 0.65, [GAMMA.id]: 0.6, [DELTA.id]: 0.55, [EPSILON.id]: 0.5 },
  [`location:${EAST_SIDE_WKT}`]: { [ALPHA.id]: 0.52, [BETA.id]: 0.61, [GAMMA.id]: 0.58, [DELTA.id]: 0.66, [EPSILON.id]: 0.49 },
};

/** Alpha leads the youngest bucket and Epsilon the oldest: a full reversal. */
const AGES: Table = {
  "age:24_and_younger": { [ALPHA.id]: 0.9, [BETA.id]: 0.7, [GAMMA.id]: 0.5, [DELTA.id]: 0.3, [EPSILON.id]: 0.12 },
  "age:55_and_older": { [ALPHA.id]: 0.15, [BETA.id]: 0.35, [GAMMA.id]: 0.55, [DELTA.id]: 0.75, [EPSILON.id]: 0.95 },
};

interface Setup {
  table?: Table;
  budget?: number;
  members?: Invented[];
  type?: "brand" | "person" | "artist" | "place" | "destination" | "tv_show";
  localities?: LocalityApi | null;
  fail?: Record<string, () => unknown>;
}

function setup(options: Setup = {}) {
  const registry = new FakeRegistry();
  const members = options.members ?? FIVE;
  for (const e of members) registerInvented(registry, e, options.type ?? "brand");
  registerInvented(registry, ARTIST_NOVA, "artist");
  registry.registerTag({ tagId: "urn:tag:genre:music:folk", name: "folk", type: "urn:tag:genre:music", signalCapable: true });
  registry.registerTag({ tagId: "urn:tag:lifestyle:qloo:outdoors", name: "outdoors", type: "urn:tag:lifestyle:qloo", signalCapable: false });
  const qloo = fakeQloo({ insights: tableInsights(options.table ?? TENANT, members), budget: options.budget });
  const fail = options.fail ?? {};
  const api: QlooApi = {
    ...qloo.api,
    insights: (filterType, params) => {
      const error = fail[contextKey(params)];
      return error === undefined ? qloo.api.insights(filterType, params) : Promise.reject(error());
    },
  };
  const run = fakeRun(api, registry);
  const localities = options.localities === undefined ? LOCALITIES : options.localities;
  const ctx: SkillCtx = Object.assign(run.ctx, { geo: GEO }, localities === null ? {} : { localities });
  return { ...run, ctx, calls: qloo.calls };
}

const SEED = "R6";
const TENANT_CONTEXTS: RankInput["contexts"] = [
  { kind: "site", area: { kind: "nbhd", ref: "east_side", metro: "nashville" } },
  { kind: "city", metro: "nashville" },
];

function input(raw: Partial<Record<keyof RankInput, unknown>> = {}): RankInput {
  return rankCandidatesSkill.input.parse({
    type: "brand",
    candidates: ["R1", "R2", "R3", "R4", "R5"],
    signal_entities: [],
    signal_tags: [],
    contexts: TENANT_CONTEXTS,
    trigger_finding_id: null,
    step_id: "S4",
    ...raw,
  });
}

/** An input straight into the skill, without the tool schema, so the skill's own refusals are exercised too. */
function unparsed(raw: Partial<RankInput>): RankInput {
  return { ...input(), ...raw } as RankInput;
}

function dataset<K extends "Ranked" | "Slope">(run: ReturnType<typeof setup>, kind: K): DatasetOf<K> {
  const d = run.ledger.datasets.find((x) => x.kind === kind);
  if (d?.kind !== kind) throw new Error(`expected a ${kind} dataset`);
  return d as DatasetOf<K>;
}

const byFormula = (run: ReturnType<typeof setup>, formulaId: string) => run.ledger.metrics.filter((m) => m.formulaId === formulaId);

describe("rank_candidates: tenant fit (site vs city)", () => {
  it("ranks the candidates under the site polygon and the city locality, with no radius", async () => {
    const run = setup();
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    const ids = FIVE.map((e) => e.id);
    expect(run.calls.map((c) => c.params)).toEqual([
      { "signal.location": EAST_SIDE_WKT, "filter.results.entities": ids, take: 5 },
      { "signal.location": "loc-nashville", "filter.results.entities": ids, take: 5 },
    ]);
    expect(run.calls.every((c) => c.filterType === "urn:entity:brand")).toBe(true);
  });

  it("reads city → site on a Slope with TenantFit per line and the climbers highlighted", async () => {
    const run = setup();
    await rankCandidatesSkill.run(input(), run.ctx);
    const d = dataset(run, "Slope");
    expect(DatasetEnvelope.parse(d)).toEqual(d);
    expect(d.title).toBe("Tenant fit · East Side vs Nashville (city)");
    expect(d.formulaIds).toEqual(["pct.within_call", "tenant.rank_shift", "tenant.fit"]);
    expect(d.payload).toMatchObject({ scale: "pct", comparator: "CITY", scoreLabel: "Tenant fit (0–100)" });
    expect(d.payload.axes.map((a) => a.label)).toEqual(["Nashville (city)", "East Side"]);
    const line = (ref: string) => d.payload.lines.find((l) => l.key === ref)!;
    expect(line("R4")).toMatchObject({
      points: [
        { value: 0.25, reason: null, rank: 4 },
        { value: 1, reason: null, rank: 1 },
      ],
      delta: 0.75,
      highlight: true,
      score: 100,
    });
    expect(line("R1")).toMatchObject({ delta: -0.75, highlight: false, score: 15 });
    expect(line("R2").score).toBeCloseTo(65);
    expect(d.payload.lines.filter((l) => l.highlight).map((l) => l.key)).toEqual(["R4"]);
  });

  it("records rank shifts climbers first, then TenantFit best first, all DERIVED against the city", async () => {
    const run = setup();
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    const shifts = byFormula(run, "tenant.rank_shift");
    expect(shifts.map((m) => m.subjectRefs[0])).toEqual(["R4", "R2", "R3", "R5", "R1"]);
    expect(shifts[0]).toMatchObject({
      key: "tenant.rank_shift",
      label: "rank shift of Brand Delta, East Side vs Nashville (city)",
      subjectRefs: ["R4", "east_side", "nashville"],
      value: 0.75,
      display: "+0.75 · site 1 of 5 · city 4 of 5, among the 5 ranked at both",
      unit: "delta",
      badge: "DERIVED",
      evidenceIds: ["E1"],
      n: 5,
      comparator: "CITY",
    });
    const fits = byFormula(run, "tenant.fit");
    expect(fits.map((m) => m.subjectRefs[0])).toEqual(["R4", "R2", "R3", "R5", "R1"]);
    expect(fits[0]).toMatchObject({ value: 100, display: "100 of 100 · site 1 of 5 · city 4 of 5, among the 5 ranked at both", unit: "score", badge: "DERIVED" });
    expect(run.ledger.metrics.indexOf(shifts[0]!)).toBe(0);
    expect(result.forModel.top_rows[0]).toEqual({
      ref: "R4",
      name: "Brand Delta",
      values: { site: "1 of 5", city: "4 of 5", tenant_fit_metric: fits[0]?.id, shift_metric: shifts[0]?.id },
    });
    expect(tenantFit(0.5, 0)).toBe(50);
    expect(tenantFit(0, -1)).toBe(0);
  });

  it("compares the same candidates at both ends: a city that drops some leaves the shared order's shifts at 0", async () => {
    // The site scores all five; the city drops Alpha and Beta, and Gamma > Delta > Epsilon in both.
    const table: Table = {
      "location:loc-nashville": { [ALPHA.id]: "drop", [BETA.id]: "drop", [GAMMA.id]: 0.9, [DELTA.id]: 0.8, [EPSILON.id]: 0.7 },
      [`location:${EAST_SIDE_WKT}`]: { [ALPHA.id]: 0.95, [BETA.id]: 0.9, [GAMMA.id]: 0.85, [DELTA.id]: 0.8, [EPSILON.id]: 0.75 },
    };
    const run = setup({ table });
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    const shifts = byFormula(run, "tenant.rank_shift");
    expect(shifts.map((m) => [m.subjectRefs[0], m.value])).toEqual([
      ["R3", 0],
      ["R4", 0],
      ["R5", 0],
    ]);
    expect(shifts[0]).toMatchObject({ display: "no shift · site 1 of 3 · city 1 of 3, among the 3 ranked at both", n: 3 });
    expect(byFormula(run, "tenant.fit").map((m) => [m.subjectRefs[0], m.value])).toEqual([
      ["R3", 80],
      ["R4", 50],
      ["R5", 20],
    ]);
    const d = dataset(run, "Slope");
    expect(SlopePayload.parse(d.payload)).toEqual(d.payload);
    expect(d.payload.valueLabel).toBe("FIT among the 3 brands ranked at both the site and the city");
    const line = (ref: string) => d.payload.lines.find((l) => l.key === ref)!;
    expect(line("R3")).toMatchObject({ points: [{ value: 1, rank: 1 }, { value: 1, rank: 1 }], delta: 0, score: 80, highlight: false });
    // Alpha has no city rank, so it has no shift or fit: never a 0, always the reason.
    expect(line("R1")).toEqual({
      key: "R1",
      label: "Brand Alpha",
      ref: "R1",
      points: [
        { value: null, reason: "dropped", rank: null },
        { value: null, reason: "dropped", rank: null },
      ],
      delta: null,
      highlight: false,
      score: null,
    });
    expect(d.payload.lines.some((l) => l.highlight)).toBe(false);
    expect(result.forModel.top_rows.find((r) => r.ref === "R1")?.values.unscored).toBe("Nashville (city): dropped");
  });

  it("shows the site alone as a Ranked table when the city could not be called, and says why", async () => {
    const run = setup({ localities: null });
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(run.calls).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("Nashville (city): no market locality is available to this build, so the context was not called.");
    expect(result.forModel.notices).toContain(
      "Tenant fit needs both the site and the city ranked, and Nashville (city) ranked nothing, so East Side is shown alone as a Ranked table.",
    );
    expect(run.ledger.metrics.some((m) => m.formulaId.startsWith("tenant."))).toBe(false);
    expect(run.ledger.metrics.some((m) => m.key === "rank.shift")).toBe(false);
    const fit = byFormula(run, "pct.within_call");
    expect(fit).toHaveLength(5);
    expect(fit.every((m) => m.value !== null && m.subjectRefs[1] === "east_side")).toBe(true);
    const d = dataset(run, "Ranked");
    expect(d.title).toBe("Ranked · East Side");
    expect(d.formulaIds).toEqual(["pct.within_call", "popularity"]);
    expect(run.ledger.datasets).toHaveLength(1);
  });

  it("draws a plain slope with no shift when fewer than two candidates are ranked at both ends", async () => {
    const table: Table = {
      "location:loc-nashville": { [ALPHA.id]: 0.9, [BETA.id]: 0.8, [GAMMA.id]: "drop", [DELTA.id]: "drop", [EPSILON.id]: "drop" },
      [`location:${EAST_SIDE_WKT}`]: { [ALPHA.id]: "drop", [BETA.id]: 0.6, [GAMMA.id]: 0.7, [DELTA.id]: 0.5, [EPSILON.id]: "drop" },
    };
    const run = setup({ table });
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(result.forModel.notices).toContain(
      "Tenant fit needs at least 2 candidates ranked at both the site and the city; fewer were, so this shows each context's FIT with no rank shift.",
    );
    const d = dataset(run, "Slope");
    expect(d.formulaIds).toEqual(["pct.within_call"]);
    expect(d.payload).toMatchObject({ comparator: "WITHIN_CALL", scoreLabel: null, valueLabel: "FIT (within-call percentile)" });
    expect(d.payload.lines.every((l) => l.delta === null && l.score === null && !l.highlight)).toBe(true);
    expect(d.payload.lines.find((l) => l.key === "R3")?.points).toEqual([
      { value: 1, reason: null, rank: 1 },
      { value: null, reason: "dropped", rank: null },
    ]);
    // FIT per context for the best candidates; a cell Qloo dropped is explicit, never a 0.
    expect(run.ledger.metrics.every((m) => m.formulaId === "pct.within_call" && (m.value !== null || m.reason === "dropped"))).toBe(true);
  });

  it("ranks places site vs city by location only (P5), and refuses places with a seed under a location", async () => {
    const run = setup({ type: "place" });
    const result = await rankCandidatesSkill.run(unparsed({ type: "place" }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls.every((c) => c.filterType === "urn:entity:place" && c.params["signal.interests.entities"] === undefined)).toBe(true);
    expect(byFormula(run, "tenant.fit")).toHaveLength(5);

    const seeded = setup({ type: "place" });
    const refused = await rankCandidatesSkill.run(unparsed({ type: "place", signal_entities: [SEED] }), seeded.ctx);
    expect(refused.status).toBe("error");
    expect(refused.forModel.notices[0]).toContain("under a none context only");
    expect(seeded.calls).toHaveLength(0);
  });
});

describe("rank_candidates: one context and slopes", () => {
  it("ranks under one context with the seed riding along, as a Ranked table of FIT", async () => {
    const table: Table = { "age:55_and_older": { [ALPHA.id]: 0.3, [BETA.id]: 0.8, [GAMMA.id]: 0.6, [DELTA.id]: 0.4, [EPSILON.id]: 0.2 } };
    const run = setup({ table });
    const result = await rankCandidatesSkill.run(input({ signal_entities: [SEED], contexts: [{ kind: "age", age: "55_and_older" }] }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls[0]?.params).toEqual({
      "signal.demographics.age": "55_and_older",
      "signal.interests.entities": [ARTIST_NOVA.id],
      "filter.results.entities": FIVE.map((e) => e.id),
      take: 5,
    });
    const d = dataset(run, "Ranked");
    expect(RankedPayload.parse(d.payload)).toEqual(d.payload);
    expect(d.title).toBe("Ranked · 55+");
    expect(d.formulaIds).toEqual(["pct.within_call", "popularity"]);
    expect(d.payload.columns.map((c) => c.key)).toEqual(["fit", "popularity"]);
    expect(d.payload.groups[0]?.rows.map((r) => [r.key, r.rank])).toEqual([
      ["R2", 1],
      ["R3", 2],
      ["R4", 3],
      ["R1", 4],
      ["R5", 5],
    ]);
    expect(d.payload.groups[0]?.rows[0]?.cells).toEqual([
      { value: 1, reason: null },
      { value: 0.8, reason: null },
    ]);
    const fit = byFormula(run, "pct.within_call");
    expect(fit.map((m) => m.subjectRefs)).toEqual([
      ["R2", "55_and_older"],
      ["R3", "55_and_older"],
      ["R4", "55_and_older"],
      ["R1", "55_and_older"],
      ["R5", "55_and_older"],
    ]);
    expect(fit[0]).toMatchObject({ key: "rank.fit", label: "FIT of Brand Beta, 55+", value: 1, display: "1.00 · 1 of 5", badge: "DERIVED", comparator: "WITHIN_CALL" });
    expect(result.forModel.top_rows[0]).toEqual({ ref: "R2", name: "Brand Beta", values: { age: "1 of 5", fit_metrics: fit[0]?.id } });
  });

  it("draws a Slope across two ages in input order, with FIT per context and the rank shift once registered", async () => {
    const run = setup({ table: AGES });
    await rankCandidatesSkill.run(
      input({ signal_entities: [SEED], contexts: [{ kind: "age", age: "24_and_younger" }, { kind: "age", age: "55_and_older" }] }),
      run.ctx,
    );
    const d = dataset(run, "Slope");
    expect(SlopePayload.parse(d.payload)).toEqual(d.payload);
    expect(d.title).toBe("Rank shift · ≤24 → 55+");
    expect(d.payload).toMatchObject({ comparator: "WITHIN_CALL", scoreLabel: null });
    expect(d.payload.lines.map((l) => l.delta)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(d.payload.lines.filter((l) => l.highlight).map((l) => l.key)).toEqual(["R4", "R5"]);
    expect(byFormula(run, "pct.within_call")).toHaveLength(10);
    // Every candidate is ranked at both ends, so each has a generic shift.
    expect(byFormula(run, RANK_SHIFT_FORMULA)).toHaveLength(5);
  });

  it("ranks artists from seeds and taxonomy tags, leaving descriptive tags out (P5)", async () => {
    const run = setup({ type: "artist", table: { none: { [ALPHA.id]: 0.4, [BETA.id]: 0.3, [GAMMA.id]: 0.2, [DELTA.id]: 0.6, [EPSILON.id]: 0.5 } } });
    const result = await rankCandidatesSkill.run(
      unparsed({ type: "artist", signal_entities: [SEED], signal_tags: ["T1", "T2"], contexts: [{ kind: "none" }] }),
      run.ctx,
    );
    expect(result.status).toBe("ok");
    expect(run.calls[0]).toMatchObject({
      filterType: "urn:entity:artist",
      params: { "signal.interests.entities": [ARTIST_NOVA.id], "signal.interests.tags": ["urn:tag:genre:music:folk"] },
    });
    expect(result.forModel.notices).toContain("Tag T2 (outdoors) is descriptive and gives no signal; left out.");
    expect(dataset(run, "Ranked").title).toBe("Ranked · Artist Nova and folk taste");
  });

  it("ranks persons by location and age with no interest signal", async () => {
    const table: Table = { ...AGES, "location:loc-austin": { [ALPHA.id]: 0.5, [BETA.id]: 0.52, [GAMMA.id]: 0.48, [DELTA.id]: 0.51, [EPSILON.id]: 0.47 } };
    const run = setup({ type: "person", table });
    const result = await rankCandidatesSkill.run(
      unparsed({ type: "person", contexts: [{ kind: "metro", market: "austin" }, { kind: "age", age: "24_and_younger" }] }),
      run.ctx,
    );
    expect(result.status).toBe("ok");
    expect(run.calls.map((c) => [c.filterType, contextKey(c.params)])).toEqual([
      ["urn:entity:person", "location:loc-austin"],
      ["urn:entity:person", "age:24_and_younger"],
    ]);
    expect(run.calls.every((c) => c.params["signal.interests.entities"] === undefined)).toBe(true);
  });

  it("refuses contexts and signals a type cannot take, with no calls", async () => {
    const run = setup();
    const tv = await rankCandidatesSkill.run(unparsed({ type: "tv_show", contexts: [{ kind: "age", age: "24_and_younger" }], signal_entities: [SEED] }), run.ctx);
    expect(tv.status).toBe("error");
    expect(tv.forModel.notices[0]).toBe(
      "tv_shows take signal_entities and signal_tags under a none context only; their other contexts are verified with no signal.",
    );
    const podcast = await rankCandidatesSkill.run(
      unparsed({ type: "podcast", contexts: [{ kind: "audience", audience: "urn:audience:leisure:board_games" }] }),
      run.ctx,
    );
    expect(podcast.forModel.notices[0]).toBe("podcasts rank under none, age contexts only; not audience.");
    const person = await rankCandidatesSkill.run(unparsed({ type: "person", contexts: [{ kind: "none" }], signal_entities: [SEED] }), run.ctx);
    expect(person.forModel.notices[0]).toBe("persons rank under site, city, metro, age, audience, gender contexts only; not none.");
    expect(run.calls).toHaveLength(0);
    expect(rankCandidatesSkill.limitations(["BUDGET_TRUNCATED"])).toEqual([...SKILL_LIMITATIONS.rank_candidates]);
  });

  it("leaves seeds out of the candidates and calls a repeated context once", async () => {
    // Artist Nova is registered as a brand here, so it is both a candidate and the seed.
    const run = setup({ members: [...FIVE, ARTIST_NOVA], table: AGES });
    const raw = unparsed({
      candidates: ["R1", "R2", "R3", "R6"],
      signal_entities: ["R6", "R9"],
      contexts: [{ kind: "age", age: "24_and_younger" }, { kind: "age", age: "24_and_younger" }],
    });
    const result = await rankCandidatesSkill.run(raw, run.ctx);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.params["filter.results.entities"]).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(result.forModel.notices).toEqual([
      "R6 is a seed, so not ranked against itself.",
      "Seed R9 is not in the registry; left out of the signal.",
      "Repeated contexts were called once: ≤24.",
    ]);
  });
});

describe("rank_candidates: unscored, partial and empty results", () => {
  it("lists floor ties and dropped candidates last with their reasons, never as a rank", async () => {
    const floor = 0.0213;
    const table: Table = { "age:55_and_older": { [ALPHA.id]: 0.3, [BETA.id]: 0.8, [GAMMA.id]: "drop", [DELTA.id]: floor, [EPSILON.id]: floor } };
    const run = setup({ table });
    const result = await rankCandidatesSkill.run(input({ contexts: [{ kind: "age", age: "55_and_older" }] }), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES", "NOT_SCORED"]);
    const rows = dataset(run, "Ranked").payload.groups[0]?.rows ?? [];
    expect(rows.map((r) => [r.key, r.rank, r.cells[0]])).toEqual([
      ["R2", 1, { value: 1, reason: null }],
      ["R1", 2, { value: 0, reason: null }],
      ["R3", null, { value: null, reason: "dropped" }],
      ["R4", null, { value: null, reason: "not_scored" }],
      ["R5", null, { value: null, reason: "not_scored" }],
    ]);
    expect(byFormula(run, "pct.within_call")).toHaveLength(2);
    expect(run.ledger.findings.map((f) => f.text)).toEqual([
      "Brand Gamma was not scored in the 55+ context, so it is shown as not scored there, not ranked last.",
    ]);
    expect(result.forModel.top_rows.at(-1)).toEqual({ ref: "R5", name: "Brand Epsilon", values: { age: null, unscored: "55+: not_scored" } });
  });

  it("reads a tie at a row's own minimum as the floor whatever other contexts share the call (PROBE consequence 2)", async () => {
    const city = { [ALPHA.id]: 0.9999, [BETA.id]: 0.9995, [GAMMA.id]: 0.9987, [DELTA.id]: 0.9987, [EPSILON.id]: 0.9991 };
    const table: Table = { ...TENANT, "location:loc-nashville": city };
    const cityRow = (run: ReturnType<typeof setup>) =>
      run.ledger.metrics.filter((m) => m.subjectRefs[1] === "nashville" && m.formulaId === "pct.within_call").map((m) => [m.subjectRefs[0], m.reason]);

    const alone = setup({ table });
    const one = await rankCandidatesSkill.run(input({ contexts: [{ kind: "city", metro: "nashville" }] }), alone.ctx);
    expect(one.flags).toEqual(["CANDIDATES_UNSCORED", "NOT_SCORED"]);
    const rows = dataset(alone, "Ranked").payload.groups[0]?.rows ?? [];
    expect(rows.filter((r) => r.rank === null).map((r) => [r.key, r.cells[0]?.reason])).toEqual([
      ["R3", "not_scored"],
      ["R4", "not_scored"],
    ]);
    expect(cityRow(alone).map(([ref]) => ref)).toEqual(["R1", "R2", "R5"]);

    // Next to a site whose scores sit far lower, the same city row keeps the same unscored cells.
    const paired = setup({ table });
    const two = await rankCandidatesSkill.run(input(), paired.ctx);
    expect(two.flags).toContain("NOT_SCORED");
    const lines = dataset(paired, "Slope").payload.lines;
    for (const ref of ["R3", "R4"]) {
      expect(lines.find((l) => l.key === ref)).toMatchObject({ points: [{ value: null, reason: "not_scored" }, { value: null }], score: null });
    }
    expect(byFormula(paired, "tenant.fit").map((m) => m.subjectRefs[0]).sort()).toEqual(["R1", "R2", "R5"]);
  });

  it("returns the context that answered as a partial Ranked table when the budget stops the second", async () => {
    const run = setup({ table: AGES, budget: 1 });
    const result = await rankCandidatesSkill.run(
      input({ signal_entities: [SEED], contexts: [{ kind: "age", age: "24_and_younger" }, { kind: "age", age: "55_and_older" }] }),
      run.ctx,
    );
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(dataset(run, "Ranked").title).toBe("Ranked · ≤24");
    const fit = byFormula(run, "pct.within_call");
    expect(fit).toHaveLength(5);
    expect(fit.every((m) => m.value !== null && m.subjectRefs[1] === "24_and_younger")).toBe(true);
    expect(run.ledger.evidences[0]).toMatchObject({ status: "partial", flags: ["BUDGET_TRUNCATED"] });
    expect(result.forModel.notices).toContain("The call budget stopped 1 of 2 context calls (55+); their cells are not measured.");
    expect(result.forModel.notices).toContain("A slope needs two ranked contexts, and 55+ ranked nothing, so ≤24 is shown alone as a Ranked table.");
    expect(result.forModel.top_rows[0]?.values.unscored).toBe("55+: budget_truncated");
  });

  it("draws a three-context slope over the contexts that ranked, among the candidates all of them scored", async () => {
    const table: Table = { ...AGES, "age:55_and_older": { ...AGES["age:55_and_older"], [GAMMA.id]: "drop" } };
    const run = setup({ table, budget: 2 });
    const result = await rankCandidatesSkill.run(
      input({
        signal_entities: [SEED],
        contexts: [{ kind: "age", age: "24_and_younger" }, { kind: "age", age: "55_and_older" }, { kind: "age", age: "35_to_44" }],
      }),
      run.ctx,
    );
    expect(result.status).toBe("partial");
    const d = dataset(run, "Slope");
    expect(d.payload.valueLabel).toBe("FIT among the 4 brands ranked in ≤24 and 55+");
    const line = (ref: string) => d.payload.lines.find((l) => l.key === ref)!;
    // Re-ranked over the four both ages scored: Alpha is first of four at ≤24 and last at 55+.
    expect(line("R1").points).toEqual([
      { value: 1, reason: null, rank: 1 },
      { value: 0, reason: null, rank: 4 },
      { value: null, reason: "budget_truncated", rank: null },
    ]);
    expect(line("R1").delta).toBeNull();
    expect(line("R3").points.map((p) => p.reason)).toEqual(["dropped", "dropped", "budget_truncated"]);
    // FIT metrics only for the contexts that ranked, each over its own call.
    const fit = byFormula(run, "pct.within_call");
    expect(fit.some((m) => m.subjectRefs[1] === "35_to_44")).toBe(false);
    expect(fit.filter((m) => m.value === null).map((m) => [m.subjectRefs[0], m.subjectRefs[1], m.reason])).toEqual([["R3", "55_and_older", "dropped"]]);
  });

  it("returns a partial result with an empty ledger when the budget allows no call", async () => {
    const run = setup({ budget: 0 });
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(result).toMatchObject({ status: "partial", evidenceIds: [], datasetIds: [], flags: ["BUDGET_TRUNCATED"] });
  });

  it("reports EMPTY_RESULT when nothing is ranked, pointing places to a seed signal", async () => {
    const drops = Object.fromEntries(FIVE.map((e) => [e.id, "drop" as const]));
    const run = setup({ type: "place", table: { "location:loc-nashville": drops, [`location:${EAST_SIDE_WKT}`]: drops } });
    const result = await rankCandidatesSkill.run(unparsed({ type: "place" }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["DROPPED_CANDIDATES", "EMPTY_RESULT"]);
    expect(run.ledger.findings[1]?.suggestion).toEqual({
      tool: "rank_candidates",
      reason: "Rank the places under a none context with a seed entity, which scores every candidate.",
    });
    expect(result.forModel.notices).toContain(
      "A location signal scores only part of a place list (about half in the probe); a none context with a seed entity scores every place.",
    );
  });

  it("keeps the other context when one call fails, and fails when nothing came back", async () => {
    const unavailable = () => Object.assign(new Error("Qloo answered HTTP 503 after 3 attempts"), { code: "qloo_unavailable" });
    const run = setup({ fail: { "location:loc-nashville": unavailable } });
    const result = await rankCandidatesSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("1 of 2 context calls failed (qloo_unavailable): Nashville (city); their cells are not measured.");
    expect(dataset(run, "Ranked").title).toBe("Ranked · East Side");
    expect(result.forModel.top_rows[0]?.values.unscored).toBe("Nashville (city): error");

    const down = setup({ fail: { "location:loc-nashville": unavailable, [`location:${EAST_SIDE_WKT}`]: unavailable } });
    await expect(rankCandidatesSkill.run(input(), down.ctx)).rejects.toThrow("HTTP 503");
  });

  it("explains an unknown neighbourhood and errors when no context is left", async () => {
    const run = setup();
    const result = await rankCandidatesSkill.run(
      input({ contexts: [{ kind: "site", area: { kind: "nbhd", ref: "nowhere", metro: "nashville" } }] }),
      run.ctx,
    );
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toBe("nowhere is not a Nashville neighbourhood in the gazetteer, so the site was not called.");
  });

  it("sends a point site as lon-first WKT", async () => {
    const point = "-86.75,36.18";
    const run = setup({ table: { "location:POINT(-86.75 36.18)": { [ALPHA.id]: 0.5, [BETA.id]: 0.6 } }, members: [ALPHA, BETA] });
    const result = await rankCandidatesSkill.run(
      input({ candidates: ["R1", "R2"], contexts: [{ kind: "site", area: { kind: "point", ref: point, metro: "nashville" } }] }),
      run.ctx,
    );
    expect(run.calls[0]?.params["signal.location"]).toBe("POINT(-86.75 36.18)");
    expect(dataset(run, "Ranked").title).toBe(`Ranked · Site ${point}`);
    expect(result.status).toBe("ok");
  });
});

describe("rank_candidates: digest and estimateCalls", () => {
  it("keeps fifty long-named candidates over three contexts within the digest budget", async () => {
    const many: Invented[] = Array.from({ length: 50 }, (_, i) => ({
      id: `ent-cand-${String(i).padStart(2, "0")}`,
      name: `Brand Candidate ${i} Heritage Trading Company Limited Extended`,
      category: null,
    }));
    const ages = ["24_and_younger", "35_to_44", "55_and_older"] as const;
    const table: Table = Object.fromEntries(
      ages.map((a, k) => [`age:${a}`, Object.fromEntries(many.map((e, i) => [e.id, 0.05 + ((i * 7 + k * 13) % 50) / 60]))]),
    );
    const run = setup({ members: many, table });
    const result = await rankCandidatesSkill.run(
      input({ candidates: many.map((_, i) => `R${i + 1}`), signal_entities: [], contexts: ages.map((age) => ({ kind: "age", age })) }),
      run.ctx,
    );
    expect(result.status).toBe("ok");
    expect(run.calls[0]?.params.take).toBe(50);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "rank_candidates", step: "S4" })).toBe(true);
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.top_rows.every((r) => r.name.length <= NAME_MAX)).toBe(true);
    expect(JSON.stringify(digest)).not.toMatch(/ent-|loc-/);
    expect(dataset(run, "Slope").payload.lines).toHaveLength(50);
  });

  it("counts one call per context, nothing for cached ones, and areas and cities as calls without the seams", async () => {
    const registry = new FakeRegistry();
    for (const e of FIVE) registerInvented(registry, e);
    const raw = input();
    expect(await estimateRankCandidatesCalls(raw, fakeProbe(() => true), registry)).toBe(2);
    expect(await estimateRankCandidatesCalls(raw, fakeProbe(() => true), registry, { geo: GEO, localities: LOCALITIES })).toBe(0);
    // The pins without the gazetteer: the city is probed, the polygon still counts.
    expect(await estimateRankCandidatesCalls(raw, fakeProbe(() => true), registry, { geo: null, localities: LOCALITIES })).toBe(1);
    const failing: LocalityApi = { market: async () => Promise.reject(new Error("kv down")) };
    expect(await estimateRankCandidatesCalls(raw, fakeProbe(() => true), registry, { geo: GEO, localities: failing })).toBe(1);
    const cold = fakeProbe(() => false);
    expect(await rankCandidatesSkill.estimateCalls(input({ contexts: [{ kind: "age", age: "25_to_29" }] }), cold, registry)).toBe(1);
    expect(cold.asked[0]?.params).toEqual({
      "filter.type": "urn:entity:brand",
      "signal.demographics.age": "25_to_29",
      "filter.results.entities": FIVE.map((e) => e.id),
      take: 5,
    });
    expect(await estimateRankCandidatesCalls(unparsed({ type: "tv_show" }), cold, registry)).toBe(0);
  });

  it("probes exactly the requests the run makes, so a finished run leaves a warm cache", async () => {
    const run = setup();
    await rankCandidatesSkill.run(input(), run.ctx);
    const made = new Set(run.calls.map((c) => JSON.stringify({ "filter.type": c.filterType, ...c.params })));
    const probe = fakeProbe((_, p) => made.has(JSON.stringify(p)));
    expect(await estimateRankCandidatesCalls(input(), probe, run.registry, { geo: GEO, localities: LOCALITIES })).toBe(0);
  });
});
