import {
  AgeBucket,
  BarsPayload,
  DatasetEnvelope,
  digestFits,
  MatrixPayload,
  ModelDigest,
  type DatasetOf,
  type LocalityApi,
  type QlooApi,
  type QlooEntity,
  type QlooParams,
  type SkillCtx,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { NAME_MAX } from "../../src/skills/format";
import { shareContexts } from "../../src/skills/rankCandidates/contexts";
import { fillGrid, type Candidate, type RowResponse, type ScoreGrid } from "../../src/skills/rankCandidates/scoring";
import { estimateShareCalls, shareOfTasteSkill } from "../../src/skills/shareOfTaste";
import { pairSplitPayload, SUBJECT_PCT_MAX, unreadAges } from "../../src/skills/shareOfTaste/outputs";
import { fakeProbe, fakeQloo, fakeRun, FakeRegistry, FETCHED_AT, insightEntity, registerInvented, type Invented } from "./support/fakes";
import { ALPHA, BETA, DELTA, EPSILON, GAMMA, OMEGA, UNTAGGED, ZETA, ARTIST_NOVA } from "./support/world";

// share_of_taste against a scripted Qloo: each context answers from a score table, in reverse
// candidate order so a skill that read row order instead of affinity would rank backwards. Invented
// entities, audiences and locality ids only (D29).

type Score = number | "drop";
type Table = Record<string, Record<string, Score>>;

const ALL: Invented[] = [ALPHA, BETA, GAMMA, DELTA, EPSILON, ZETA, OMEGA, UNTAGGED, ARTIST_NOVA];
const byId = (id: string) => ALL.find((e) => e.id === id) ?? { id, name: id, category: null };
const list = (v: QlooParams[string] | undefined): string[] => (v === undefined ? [] : typeof v === "object" ? [...v] : [String(v)]);

/** The context a request carries, as the score table keys it. */
function contextKey(params: QlooParams): string {
  if (params["signal.demographics.age"] !== undefined) return `age:${String(params["signal.demographics.age"])}`;
  if (params["signal.demographics.audiences"] !== undefined) return `audience:${list(params["signal.demographics.audiences"])[0]}`;
  if (params["signal.location"] !== undefined) return `location:${String(params["signal.location"])}`;
  return "none";
}

function tableInsights(table: Table): (params: QlooParams) => QlooEntity[] {
  return (params) => {
    const row = table[contextKey(params)] ?? {};
    return list(params["filter.results.entities"])
      .filter((id) => row[id] !== "drop")
      .reverse()
      .map((id) => insightEntity(byId(id), row[id] as number | undefined));
  };
}

const PINS: Record<string, { entityId: string; label: string }> = {
  nashville: { entityId: "loc-nashville", label: "Nashville" },
  austin: { entityId: "loc-austin", label: "Austin" },
  chicago: { entityId: "loc-chicago", label: "Chicago" },
};

/** Pinned localities for three markets (SkillCtx.localities); the ids are invented. */
const LOCALITIES: LocalityApi = { market: async (m) => PINS[m] ?? null };

const AGES4 = ["24_and_younger", "25_to_29", "45_to_54", "55_and_older"] as const;

/**
 * Brand Alpha leads the young buckets and trails the old ones; it wins Nashville and Austin and is
 * last in Chicago, where Brand Delta wins.
 */
const REFERENCE: Table = {
  "age:24_and_younger": { [ALPHA.id]: 0.91, [BETA.id]: 0.62, [GAMMA.id]: 0.52, [DELTA.id]: 0.33 },
  "age:25_to_29": { [ALPHA.id]: 0.81, [BETA.id]: 0.72, [GAMMA.id]: 0.43, [DELTA.id]: 0.24 },
  "age:45_to_54": { [ALPHA.id]: 0.25, [BETA.id]: 0.53, [GAMMA.id]: 0.64, [DELTA.id]: 0.74 },
  "age:55_and_older": { [ALPHA.id]: 0.11, [BETA.id]: 0.44, [GAMMA.id]: 0.54, [DELTA.id]: 0.63 },
  "location:loc-nashville": { [ALPHA.id]: 0.61, [BETA.id]: 0.55, [GAMMA.id]: 0.505, [DELTA.id]: 0.45 },
  "location:loc-austin": { [ALPHA.id]: 0.625, [BETA.id]: 0.6, [GAMMA.id]: 0.58, [DELTA.id]: 0.565 },
  "location:loc-chicago": { [ALPHA.id]: 0.4, [BETA.id]: 0.51, [GAMMA.id]: 0.555, [DELTA.id]: 0.605 },
};

interface Setup {
  table?: Table;
  budget?: number;
  members?: Invented[];
  type?: "brand" | "person" | "podcast" | "tv_show" | "movie";
  localities?: LocalityApi | null;
  /** Context keys whose call rejects with this error. */
  fail?: Record<string, () => unknown>;
}

function setup(options: Setup = {}) {
  const registry = new FakeRegistry();
  for (const e of options.members ?? [ALPHA, BETA, GAMMA, DELTA]) registerInvented(registry, e, options.type ?? "brand");
  const qloo = fakeQloo({ insights: tableInsights(options.table ?? REFERENCE), budget: options.budget });
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
  const ctx: SkillCtx = localities === null ? run.ctx : Object.assign(run.ctx, { localities });
  return { ...run, ctx, calls: qloo.calls };
}

type ShareInput = Parameters<typeof shareOfTasteSkill.run>[0];

function input(
  raw: Partial<{ type: string; set: string[]; ages: string[]; audiences: string[]; genders: string[]; metros: string[]; step_id: string | null }> = {},
) {
  return shareOfTasteSkill.input.parse({
    type: "brand",
    set: ["R1", "R2", "R3", "R4"],
    ages: [...AGES4],
    audiences: [],
    metros: ["nashville", "austin", "chicago"],
    trigger_finding_id: null,
    step_id: "S3",
    ...raw,
  });
}

function matrix(run: ReturnType<typeof setup>): DatasetOf<"Matrix"> {
  const d = run.ledger.datasets.find((x) => x.kind === "Matrix");
  if (d?.kind !== "Matrix") throw new Error("expected a Matrix dataset");
  return d;
}

function cell(d: DatasetOf<"Matrix">, rowKey: string, colKey: string) {
  const r = d.payload.rows.findIndex((x) => x.key === rowKey);
  const c = d.payload.cols.findIndex((x) => x.key === colKey);
  return d.payload.cells[r]?.[c];
}

const byKey = (run: ReturnType<typeof setup>, key: string) => run.ledger.metrics.filter((m) => m.key === key);
const unscoredBy = (reason: string) => (m: { value: number | null; reason: string | null; badge: string; display: string }) =>
  m.value === null && m.reason === reason && m.badge === "UNAVAILABLE" && m.display === "not measured";

const hiddenOrId = /ent-|loc-/;

describe("share_of_taste: calls", () => {
  it("makes one rank call per context over the exact set, ages youngest first, metros by pinned locality", async () => {
    const run = setup();
    const result = await shareOfTasteSkill.run(input({ ages: ["55_and_older", "24_and_younger", "45_to_54", "25_to_29"] }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls).toHaveLength(7);
    const ids = [ALPHA, BETA, GAMMA, DELTA].map((e) => e.id);
    for (const call of run.calls) {
      expect(call.filterType).toBe("urn:entity:brand");
      expect(call.params["filter.results.entities"]).toEqual(ids);
      expect(call.params.take).toBe(4);
      expect(call.params["signal.interests.entities"]).toBeUndefined();
    }
    expect(run.calls.map((c) => contextKey(c.params))).toEqual([
      "age:24_and_younger",
      "age:25_to_29",
      "age:45_to_54",
      "age:55_and_older",
      "location:loc-nashville",
      "location:loc-austin",
      "location:loc-chicago",
    ]);
    expect(run.calls[0]?.params).toEqual({ "signal.demographics.age": "24_and_younger", "filter.results.entities": ids, take: 4 });
  });

  it("sends an audience context as signal.demographics.audiences with the URN", async () => {
    const audience = "urn:audience:leisure:board_games";
    const table: Table = { [`audience:${audience}`]: { [ALPHA.id]: 0.3, [BETA.id]: 0.8 } };
    const run = setup({ table, members: [ALPHA, BETA] });
    const result = await shareOfTasteSkill.run(input({ set: ["R1", "R2"], ages: [], audiences: [audience], metros: [] }), run.ctx);
    expect(run.calls[0]?.params["signal.demographics.audiences"]).toEqual([audience]);
    const d = matrix(run);
    expect(d.payload.rows).toEqual([{ key: `audience:${audience}`, label: "leisure: board games", ref: null, group: "AUDIENCE" }]);
    expect(result.forModel.metrics[0]?.label).toBe("Share-of-Taste percentile of Brand Alpha, audience leisure: board games (best context)");
  });
});

describe("share_of_taste: the grid, metrics and findings", () => {
  it("ranks by affinity, never by row order, and builds the Share-of-Taste Matrix", async () => {
    const run = setup();
    await shareOfTasteSkill.run(input(), run.ctx);
    const d = matrix(run);
    expect(DatasetEnvelope.parse(d)).toEqual(d);
    expect(d.title).toBe("Share of Taste · Brand Alpha");
    expect(d.formulaIds).toEqual(["share.pct", "share.youth_tilt", "share.metros_won"]);
    expect(d.evidenceIds).toEqual(["E1", "E2"]);
    expect(d.payload).toMatchObject({ mode: "share", unit: "pct", comparator: "WITHIN_CALL", targetKey: "R1" });
    expect(d.payload.rows.map((r) => [r.label, r.group])).toEqual([
      ["≤24", "AGE"],
      ["25–29", "AGE"],
      ["45–54", "AGE"],
      ["55+", "AGE"],
      ["Nashville", "METRO"],
      ["Austin", "METRO"],
      ["Chicago", "METRO"],
    ]);
    expect(d.payload.cols.map((c) => c.key)).toEqual(["R1", "R2", "R3", "R4"]);
    // The best affinity came back last in its response and still ranks first.
    expect(cell(d, "age:24_and_younger", "R1")).toEqual({ value: 1, reason: null, rank: 1 });
    expect(cell(d, "age:24_and_younger", "R4")).toEqual({ value: 0, reason: null, rank: 4 });
    expect(cell(d, "age:24_and_younger", "R2")?.value).toBeCloseTo(2 / 3);
    expect(cell(d, "metro:chicago", "R4")).toMatchObject({ value: 1, rank: 1 });
    expect(d.payload.margin?.label).toBe("Youth tilt");
    expect(d.payload.margin?.values.map((v) => v.value)).toEqual([1, expect.closeTo(1 / 3), expect.closeTo(-1 / 3), -1]);
    expect(d.payload.annotations.map((a) => a.text)).toEqual(["Brand Alpha wins 2 of 3 metros", "Brand Alpha skews younger than the set"]);
  });

  it("records the subject's percentile per context best first, then each member's youth tilt and metros won", async () => {
    const run = setup();
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    const pct = byKey(run, "share.pct");
    expect(pct.map((m) => m.subjectRefs)).toEqual([
      ["R1", "24_and_younger"],
      ["R1", "25_to_29"],
      ["R1", "nashville"],
      ["R1", "austin"],
      ["R1", "45_to_54"],
      ["R1", "55_and_older"],
      ["R1", "chicago"],
    ]);
    expect(pct[0]).toMatchObject({
      label: "Share-of-Taste percentile of Brand Alpha, age ≤24 (best context)",
      value: 1,
      display: "1.00 · 1 of 4",
      unit: "pct",
      badge: "DERIVED",
      formulaId: "share.pct",
      evidenceIds: ["E1"],
      n: 4,
      comparator: "WITHIN_CALL",
    });
    expect(pct[2]?.evidenceIds).toEqual(["E2"]);
    expect(pct[6]).toMatchObject({ label: "Share-of-Taste percentile of Brand Alpha, metro Chicago (worst context)", value: 0, display: "0.00 · 4 of 4" });

    const tilt = byKey(run, "share.youth_tilt");
    expect(tilt.map((m) => m.subjectRefs[0])).toEqual(["R1", "R2", "R3", "R4"]);
    expect(tilt[0]).toMatchObject({
      label: "youth tilt of Brand Alpha (≤24, 25–29 minus 45–54, 55+)",
      subjectRefs: ["R1", "24_and_younger", "25_to_29", "45_to_54", "55_and_older"],
      value: 1,
      display: "+1.00 · rank 1 of 4",
      unit: "delta",
      badge: "DERIVED",
      formulaId: "share.youth_tilt",
      evidenceIds: ["E1"],
      n: 4,
      comparator: "PEERS",
    });
    expect(tilt[3]?.display).toBe("-1.00 · rank 4 of 4");

    const won = byKey(run, "share.metros_won");
    expect(won[0]).toMatchObject({
      label: "metros won by Brand Alpha (first in the set)",
      subjectRefs: ["R1", "nashville", "austin", "chicago"],
      value: 2,
      display: "wins 2 of 3 · top half in 2 of 3",
      unit: "count",
      badge: "DERIVED",
      formulaId: "share.metros_won",
      evidenceIds: ["E2"],
      n: 3,
    });
    expect(won[3]).toMatchObject({ value: 1, display: "wins 1 of 3 · top half in 1 of 3" });
    // Subject first: the KPI strip reads the first youth tilt and metros-won metrics.
    expect(run.ledger.metrics.map((m) => m.formulaId).slice(7, 9)).toEqual(["share.youth_tilt", "share.metros_won"]);
    expect(result.metricIds).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(run.ledger.metrics.every((m) => m.conf !== null && m.conf > 0)).toBe(true);
  });

  it("fires GENERATIONAL_SPLIT and the METRO_OUTLIER where the subject falls well below its median metro rank", async () => {
    const run = setup();
    await shareOfTasteSkill.run(input(), run.ctx);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["GENERATIONAL_SPLIT", "METRO_OUTLIER"]);
    const [split, outlier] = run.ledger.findings;
    expect(split?.metricIds).toEqual([byKey(run, "share.youth_tilt")[0]?.id]);
    // The four end buckets were read, so the follow-up ranks the set in the two middle ones.
    expect(split?.suggestion).toEqual({
      tool: "share_of_taste",
      reason: "Rank the same set in the unread age buckets 30_to_34, 35_to_44 to find the age where Brand Alpha's lead gives way.",
    });
    expect(outlier?.text).toBe("Brand Alpha ranks 4 of 4 in Chicago, clearly worse than its median rank across metros.");
    // Other markets, nearby first, tell a local exception from a regional pattern.
    expect(outlier).toMatchObject({
      severity: "medium",
      suggestion: {
        tool: "share_of_taste",
        reason: "Rank the same set in other markets, those near Chicago first, to see whether Brand Alpha's worse showing there is local or regional.",
      },
    });
    expect(outlier?.metricIds).toEqual([byKey(run, "share.pct")[6]?.id]);
  });

  it("lists the age buckets a grid left unread, youngest first", () => {
    const row = (kind: "age" | "metro", subject: string) => ({ spec: { kind, subject } }) as unknown as ScoreGrid["rows"][number];
    const grid = (rows: ScoreGrid["rows"]) => ({ rows }) as unknown as ScoreGrid;
    expect(unreadAges(grid([row("age", "55_and_older"), row("metro", "nashville"), row("age", "24_and_younger")]))).toEqual([
      "25_to_29",
      "30_to_34",
      "35_to_44",
      "45_to_54",
    ]);
    expect(unreadAges(grid(AgeBucket.options.map((b) => row("age", b))))).toEqual([]);
  });

  it("suggests other markets for a gazetteer metro where the subject does clearly better than its median, as for any market", async () => {
    const table: Table = {
      ...REFERENCE,
      "location:loc-nashville": { [ALPHA.id]: 0.61, [BETA.id]: 0.55, [GAMMA.id]: 0.5, [DELTA.id]: 0.45 },
      "location:loc-austin": { [ALPHA.id]: 0.41, [BETA.id]: 0.6, [GAMMA.id]: 0.58, [DELTA.id]: 0.56 },
      "location:loc-chicago": { [ALPHA.id]: 0.4, [BETA.id]: 0.5, [GAMMA.id]: 0.55, [DELTA.id]: 0.6 },
    };
    const run = setup({ table });
    await shareOfTasteSkill.run(input({ ages: [] }), run.ctx);
    const outliers = run.ledger.findings.filter((f) => f.kind === "METRO_OUTLIER");
    expect(outliers.map((f) => f.text)).toEqual(["Brand Alpha ranks 1 of 4 in Nashville, clearly better than its median rank across metros."]);
    expect(outliers[0]?.suggestion).toMatchObject({ tool: "share_of_taste", reason: expect.stringContaining("those near Nashville first") });
    expect(matrix(run).payload.margin?.label).toBe("Metros won");
  });

  it("calls no metro outlier a place and a half from a mid-scale median in a set of four", async () => {
    // Four metros put Alpha's median rank at 2.5: first in Nashville is a place and a half from it, short of two.
    const table: Table = {
      "location:loc-nashville": { [ALPHA.id]: 0.7, [BETA.id]: 0.6, [GAMMA.id]: 0.5, [DELTA.id]: 0.4 },
      "location:loc-austin": { [ALPHA.id]: 0.61, [BETA.id]: 0.71, [GAMMA.id]: 0.51, [DELTA.id]: 0.41 },
      "location:loc-chicago": { [ALPHA.id]: 0.52, [BETA.id]: 0.62, [GAMMA.id]: 0.72, [DELTA.id]: 0.42 },
      "location:loc-denver": { [ALPHA.id]: 0.53, [BETA.id]: 0.63, [GAMMA.id]: 0.73, [DELTA.id]: 0.43 },
    };
    const localities: LocalityApi = { market: async (m) => ({ entityId: `loc-${m}`, label: m.charAt(0).toUpperCase() + m.slice(1) }) };
    const run = setup({ table, localities });
    await shareOfTasteSkill.run(input({ ages: [], metros: ["nashville", "austin", "chicago", "denver"] }), run.ctx);
    expect(run.ledger.findings.filter((f) => f.kind === "METRO_OUTLIER")).toEqual([]);
  });

  it("builds a digest that fits, lists the subject first and never shows Qloo ids or bare decimals", async () => {
    const run = setup();
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "share_of_taste", step: "S3" })).toBe(true);
    expect(digest.evidence_ids).toEqual(["E1", "E2"]);
    expect(digest.dataset_ids).toEqual(["D1"]);
    expect(digest.top_rows[0]).toEqual({
      ref: "R1",
      name: "Brand Alpha",
      values: {
        role: "subject",
        ranked_in: "7 of 7 ranked contexts",
        best: "≤24 (1 of 4)",
        worst: "Chicago (4 of 4)",
        best_metric: byKey(run, "share.pct")[0]?.id,
        worst_metric: byKey(run, "share.pct")[6]?.id,
        tilt_metric: byKey(run, "share.youth_tilt")[0]?.id,
        metros_won_metric: byKey(run, "share.metros_won")[0]?.id,
      },
    });
    expect(digest.top_rows.map((r) => r.values.role)).toEqual(["subject", "set", "set", "set"]);
    for (const row of digest.top_rows) {
      for (const v of Object.values(row.values)) if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }
    expect(JSON.stringify(digest)).not.toMatch(hiddenOrId);
    expect(digest.flags).toEqual([]);
    expect(shareOfTasteSkill.limitations(result.flags)).toEqual([...SKILL_LIMITATIONS.share_of_taste]);
  });
});

describe("share_of_taste: unscored values", () => {
  it("leaves floor ties and dropped members unscored, explains them, and never shows them as 0", async () => {
    const floor = 0.0213;
    const table: Table = {
      ...REFERENCE,
      "age:55_and_older": { [ALPHA.id]: floor, [BETA.id]: floor, [GAMMA.id]: 0.5, [DELTA.id]: 0.6 },
      "location:loc-austin": { [ALPHA.id]: 0.625, [BETA.id]: 0.6, [GAMMA.id]: "drop", [DELTA.id]: 0.565 },
    };
    const run = setup({ table });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES", "NOT_SCORED"]);

    const d = matrix(run);
    expect(cell(d, "age:55_and_older", "R1")).toEqual({ value: null, reason: "not_scored", rank: null });
    expect(cell(d, "age:55_and_older", "R2")).toEqual({ value: null, reason: "not_scored", rank: null });
    expect(cell(d, "age:55_and_older", "R4")).toEqual({ value: 1, reason: null, rank: 1 });
    expect(cell(d, "metro:austin", "R3")).toEqual({ value: null, reason: "dropped", rank: null });
    expect(cell(d, "metro:austin", "R4")).toMatchObject({ value: 0, rank: 3 });

    const pct55 = byKey(run, "share.pct").find((m) => m.subjectRefs.includes("55_and_older"));
    expect(pct55 && unscoredBy("not_scored")(pct55)).toBe(true);
    expect(pct55?.conf).toBeNull();
    // The subject's tilt needs 55+, so it is not measured, with that cell's reason; the rest keep theirs.
    const tilt = byKey(run, "share.youth_tilt");
    expect(tilt[0] && unscoredBy("not_scored")(tilt[0])).toBe(true);
    expect(tilt[2]?.value).not.toBeNull();
    expect(d.payload.margin?.values[0]).toEqual({ value: null, reason: "not_scored" });
    // No generational split can fire without the subject's tilt.
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["METRO_OUTLIER", "DROPPED_CANDIDATES"]);
    expect(run.ledger.findings[1]?.text).toContain("Brand Gamma was not scored in the Austin context");
    expect(run.ledger.evidences.map((e) => e.flags)).toEqual([
      ["CANDIDATES_UNSCORED", "NOT_SCORED"],
      ["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES"],
    ]);
    expect(run.ledger.evidences[0]?.summary).toBe("4 age context calls over 4 brands; 14 of 16 cells scored (2 tied at the floor, not scored).");
    expect(result.forModel.top_rows[2]?.values.unscored).toBe("Austin: dropped");
  });

  it("gives a member no metro ranked no metros-won count, never a measured 0", async () => {
    const table: Table = {
      ...REFERENCE,
      "location:loc-nashville": { ...REFERENCE["location:loc-nashville"], [GAMMA.id]: "drop" },
      "location:loc-austin": { ...REFERENCE["location:loc-austin"], [GAMMA.id]: "drop" },
      "location:loc-chicago": { ...REFERENCE["location:loc-chicago"], [GAMMA.id]: "drop", [BETA.id]: "drop" },
    };
    const run = setup({ table });
    await shareOfTasteSkill.run(input(), run.ctx);
    const won = byKey(run, "share.metros_won");
    expect(won[2] && unscoredBy("dropped")(won[2])).toBe(true);
    expect(won[2]?.conf).toBeNull();
    expect(matrix(run).payload.margin?.label).toBe("Youth tilt");
    // Beta is ranked in two of the three metros: its count says where it was not scored.
    expect(won[1]).toMatchObject({ value: 0, display: "wins 0 of 3 · top half in 2 of 3 · not scored in 1", n: 2 });
    expect(won[0]).toMatchObject({ value: 2, display: "wins 2 of 3 · top half in 2 of 3", n: 3 });

    const noTilt = setup({ table });
    await shareOfTasteSkill.run(input({ ages: [] }), noTilt.ctx);
    const margin = matrix(noTilt).payload.margin;
    expect(margin?.label).toBe("Metros won");
    expect(margin?.values[2]).toEqual({ value: null, reason: "dropped" });
    expect(margin?.values[1]).toEqual({ value: 0, reason: null });
  });

  it("subtracts youth-tilt percentiles among the members every bucket ranked", async () => {
    // 55+ drops Beta, so every tilt compares Alpha, Gamma and Delta only.
    const table: Table = { ...REFERENCE, "age:55_and_older": { ...REFERENCE["age:55_and_older"], [BETA.id]: "drop" } };
    const run = setup({ table });
    await shareOfTasteSkill.run(input({ metros: [] }), run.ctx);
    const tilt = byKey(run, "share.youth_tilt");
    expect(tilt.map((m) => m.value)).toEqual([1, null, 0, -1]);
    expect(tilt[1]?.reason).toBe("dropped");
    expect(tilt[0]?.display).toBe("+1.00 · rank 1 of 3");
    // The grid itself keeps each call's own percentiles.
    expect(cell(matrix(run), "age:24_and_younger", "R3")?.value).toBeCloseTo(1 / 3);
  });

  it("ranks nothing in a context where only one member is scored", async () => {
    const table: Table = { ...REFERENCE, "location:loc-chicago": { [ALPHA.id]: "drop", [BETA.id]: "drop", [GAMMA.id]: "drop", [DELTA.id]: 0.605 } };
    const run = setup({ table });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    const d = matrix(run);
    expect(cell(d, "metro:chicago", "R4")).toEqual({ value: null, reason: "insufficient_n", rank: null });
    expect(result.forModel.notices).toContain("Only one brand was scored in Chicago, so that context ranks nothing.");
    // Two metros ranked, so Delta cannot win Chicago by default.
    expect(byKey(run, "share.metros_won")[3]).toMatchObject({ value: 0, display: "wins 0 of 2 · top half in 0 of 2" });
    expect(result.flags).toContain("CANDIDATES_UNSCORED");
  });
});

describe("share_of_taste: partial, truncated and empty results", () => {
  it("returns a partial grid when the budget stops calls, with the missing cells and tilt explained", async () => {
    const run = setup({ budget: 3 });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    expect(run.calls).toHaveLength(3);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    const d = matrix(run);
    expect(cell(d, "age:55_and_older", "R1")).toEqual({ value: null, reason: "budget_truncated", rank: null });
    expect(cell(d, "metro:nashville", "R1")).toEqual({ value: null, reason: "budget_truncated", rank: null });
    expect(byKey(run, "share.youth_tilt").every(unscoredBy("budget_truncated"))).toBe(true);
    expect(byKey(run, "share.metros_won").every(unscoredBy("budget_truncated"))).toBe(true);
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.evidences[0]).toMatchObject({ status: "partial", flags: ["BUDGET_TRUNCATED"] });
    expect(result.forModel.notices).toContain(
      "The call budget stopped 4 of 7 context calls (55+, Nashville, Austin and 1 more); their cells are not measured.",
    );
    expect(run.ledger.findings).toEqual([]);
  });

  it("returns a partial result with nothing in the ledger when the budget allows no call", async () => {
    const run = setup({ budget: 0 });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    expect(result).toMatchObject({ status: "partial", evidenceIds: [], datasetIds: [], metricIds: [], flags: ["BUDGET_TRUNCATED"] });
    expect(run.ledger.evidences).toHaveLength(0);
  });

  it("reports EMPTY_RESULT when no context ranks anything, and suggests age contexts for brands", async () => {
    const drops = Object.fromEntries([ALPHA, BETA, GAMMA, DELTA].map((e) => [e.id, "drop" as const]));
    const table: Table = { "location:loc-nashville": drops, "location:loc-austin": drops };
    const run = setup({ table });
    const result = await shareOfTasteSkill.run(input({ ages: [], metros: ["nashville", "austin"] }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toHaveLength(0);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["DROPPED_CANDIDATES", "EMPTY_RESULT"]);
    expect(run.ledger.findings[1]?.suggestion?.tool).toBe("share_of_taste");
    expect(run.ledger.evidences[0]).toMatchObject({ status: "empty" });
    expect(result.forModel.top_rows[0]?.values).toMatchObject({ role: "subject", best: null, ranked_in: "0 of 0 ranked contexts" });
  });

  it("keeps the other contexts when one call fails, and fails only when nothing came back", async () => {
    const unavailable = () => Object.assign(new Error("Qloo answered HTTP 503 after 3 attempts"), { code: "qloo_unavailable" });
    const run = setup({ fail: { "location:loc-austin": unavailable } });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(cell(matrix(run), "metro:austin", "R2")).toEqual({ value: null, reason: "error", rank: null });
    expect(result.forModel.notices).toContain("1 of 7 context calls failed (qloo_unavailable): Austin; their cells are not measured.");
    expect(byKey(run, "share.metros_won")[0]).toMatchObject({ value: 1, display: "wins 1 of 2 · top half in 1 of 2" });

    const all = Object.fromEntries(["location:loc-nashville", "location:loc-austin"].map((k) => [k, unavailable]));
    const down = setup({ fail: all });
    await expect(shareOfTasteSkill.run(input({ ages: [], metros: ["nashville", "austin"] }), down.ctx)).rejects.toThrow("HTTP 503");
    expect(down.ledger.evidences).toHaveLength(0);
  });

  it("flags only a segment denied on every desk as blocked; a family off this desk's list is a notice", async () => {
    const denied = "urn:audience:communities:invented_group";
    const offDesk = "urn:audience:spending_habits:invented_habit";
    const refusal = (message: string) => () => Object.assign(new Error(message), { code: "qloo_param" });
    const run = setup({
      fail: {
        [`audience:${denied}`]: refusal(`signal.demographics.audiences: audience family "communities" is denied on every desk (D21)`),
        [`audience:${offDesk}`]: refusal(`signal.demographics.audiences: audience family "spending_habits" is not allowed for the location desk (D21)`),
      },
    });
    const result = await shareOfTasteSkill.run(input({ audiences: [denied, offDesk], metros: [] }), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["SENSITIVE_SEGMENT_BLOCKED"]);
    expect(result.forModel.notices).toEqual([
      "communities: invented group: a sensitive segment, refused on every desk (D21), so the context was not called.",
      "spending habits: invented habit: not on this desk's AUDIENCES list, so the context was not called.",
    ]);
    expect(cell(matrix(run), `audience:${offDesk}`, "R1")).toEqual({ value: null, reason: "unavailable", rank: null });

    const deskOnly = setup({ fail: { [`audience:${offDesk}`]: refusal("audience family is not allowed for the location desk (D21)") } });
    const desk = await shareOfTasteSkill.run(input({ audiences: [offDesk], metros: [] }), deskOnly.ctx);
    expect(desk.flags).toEqual([]);
    expect(desk.status).toBe("partial");
  });

  it("returns the refusal as a result, not an error, when every context is a refused audience", async () => {
    const offDesk = "urn:audience:spending_habits:invented_habit";
    const refused = () => Object.assign(new Error("not allowed for the location desk (D21)"), { code: "qloo_param" });
    const run = setup({ fail: { [`audience:${offDesk}`]: refused } });
    const result = await shareOfTasteSkill.run(input({ ages: [], audiences: [offDesk], metros: [] }), run.ctx);
    expect(result).toMatchObject({ status: "partial", evidenceIds: [], datasetIds: [] });
    expect(result.forModel.notices).toEqual(["spending habits: invented habit: not on this desk's AUDIENCES list, so the context was not called."]);
  });

  it("calls no metro it cannot pin, saying why, and errors when no context is left", async () => {
    const unpinned = setup({ localities: { market: async (m) => (m === "nashville" ? (PINS.nashville ?? null) : null) } });
    const partial = await shareOfTasteSkill.run(input({ ages: [], metros: ["nashville", "austin", "chicago"] }), unpinned.ctx);
    expect(unpinned.calls).toHaveLength(1);
    expect(partial.status).toBe("partial");
    expect(partial.forModel.notices).toContain("Austin: its locality is not pinned, so the context was not called.");
    expect(cell(matrix(unpinned), "metro:chicago", "R1")).toEqual({ value: null, reason: "unavailable", rank: null });

    // A lookup that throws leaves that metro uncalled, not the whole grid.
    const flaky = setup({ localities: { market: async (m) => (m === "austin" ? Promise.reject(new Error("kv down")) : (PINS[m] ?? null)) } });
    const some = await shareOfTasteSkill.run(input({ ages: [], metros: ["nashville", "austin"] }), flaky.ctx);
    expect(flaky.calls).toHaveLength(1);
    expect(some.forModel.notices).toContain("Austin: its locality lookup failed, so the context was not called.");

    // Without the locality seam no metro resolves.
    const noSeam = setup({ localities: null });
    const result = await shareOfTasteSkill.run(input({ ages: [], metros: ["nashville"] }), noSeam.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toBe("Nashville: no market locality is available to this build, so the context was not called.");
    expect(noSeam.calls).toHaveLength(0);
  });

  it("leaves out unknown and wrongly typed members, and errors with fewer than two", async () => {
    const run = setup({ members: [ALPHA, BETA] });
    registerInvented(run.registry, ARTIST_NOVA, "artist");
    const result = await shareOfTasteSkill.run(input({ set: ["R1", "R3", "R9"], ages: ["24_and_younger"], metros: [] }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toBe(
      "R3 (Artist Nova) is an artist, not a brand; left out of the set. R9 is not in the registry; left out of the set. A Share-of-Taste grid needs at least 2 brands; 1 usable.",
    );
    expect(run.calls).toHaveLength(0);
  });

  it("refuses a set whose first entity, the subject, is unusable instead of promoting the next one", async () => {
    const run = setup();
    registerInvented(run.registry, ARTIST_NOVA, "artist");
    const result = await shareOfTasteSkill.run(input({ set: ["R5", "R1", "R2"], metros: [] }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toBe(
      "R5 (Artist Nova) is an artist, not a brand; left out of the set. R5 (the subject) is not a usable brand; put the target first.",
    );
    expect(run.calls).toHaveLength(0);
    expect(await estimateShareCalls(input({ set: ["R9", "R1", "R2"] }), fakeProbe(() => false), run.registry, { localities: LOCALITIES, geo: null })).toBe(0);
  });
});

describe("share_of_taste: persons and pairs", () => {
  it("shares person sets by metro, age (P5), audience (C5) and gender (C4)", async () => {
    const run = setup({ type: "person" });
    const result = await shareOfTasteSkill.run(input({ type: "person", ages: [], metros: ["nashville", "austin"] }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls.every((c) => c.filterType === "urn:entity:person" && c.params["signal.location"] !== undefined)).toBe(true);

    const aged = setup({ type: "person" });
    const byAgeInput = input({ type: "person", ages: ["24_and_younger", "55_and_older"], metros: [] });
    const byAge = await shareOfTasteSkill.run(byAgeInput, aged.ctx);
    expect(byAge.status).toBe("ok");
    expect(aged.calls.map((c) => c.params["signal.demographics.age"])).toEqual(["24_and_younger", "55_and_older"]);
    const others = setup({ type: "person" });
    const byOthers = input({ type: "person", ages: [], genders: ["female"], audiences: ["urn:audience:leisure:board_games"], metros: [] });
    expect(shareOfTasteSkill.input.safeParse(byOthers).success).toBe(true);
    await shareOfTasteSkill.run(byOthers, others.ctx);
    expect(others.calls.map((c) => c.params["signal.demographics.gender"] ?? c.params["signal.demographics.audiences"])).toEqual([
      "female",
      ["urn:audience:leisure:board_games"],
    ]);
  });

  it("shares media sets by age, TV shows also by audience, and refuses metros and genders for them (C3, C5)", async () => {
    const shows = setup({ type: "tv_show" });
    const byAge = await shareOfTasteSkill.run(input({ type: "tv_show", ages: ["24_and_younger", "55_and_older"], metros: [] }), shows.ctx);
    expect(byAge.status).not.toBe("error");
    expect(shows.calls.every((c) => c.filterType === "urn:entity:tv_show")).toBe(true);
    for (const bad of [{ metros: ["nashville"] }, { genders: ["male"] }, { audiences: ["urn:audience:leisure:board_games"], type: "podcast" }] as const) {
      const run = setup({ type: "podcast" });
      const refused = await shareOfTasteSkill.run({ ...input({ type: "podcast", ages: ["24_and_younger"], metros: [] }), ...bad } as unknown as ShareInput, run.ctx);
      expect(refused.status).toBe("error");
      expect(run.calls).toHaveLength(0);
    }
  });

  it("builds the who-wins-where split for a pair: the first entity's share of the two affinities in each call", async () => {
    const pair: Candidate[] = [
      { ref: "R1", entityId: ALPHA.id, name: ALPHA.name, popularity: 0.9 },
      { ref: "R2", entityId: BETA.id, name: BETA.name, popularity: 0.8 },
    ];
    const specs = await shareContexts({ ages: ["24_and_younger"], audiences: [], metros: ["nashville", "austin"] }, { localities: LOCALITIES, geo: null });
    const meta = { qlooCallId: "qc-1", requestId: "req-synthetic-1", cache: "miss" as const, fetchedAt: FETCHED_AT, ms: 1, stale: false, originRunId: null };
    const responses: RowResponse[] = [
      { kind: "ok", entities: [insightEntity(ALPHA, 0.6), insightEntity(BETA, 0.4)], meta },
      { kind: "ok", entities: [insightEntity(ALPHA, 0.31), insightEntity(BETA, 0.62)], meta },
      { kind: "gap", reason: "budget_truncated" },
    ];
    const payload = pairSplitPayload(fillGrid(pair, specs, responses));
    expect(payload).not.toBeNull();
    expect(BarsPayload.parse(payload)).toMatchObject({ display: "split", baseline: 0.5, evenBand: 0.02, unit: "ratio", comparator: "WITHIN_CALL" });
    expect(payload).toMatchObject({ mode: "butterfly", display: "split" });
    expect(payload?.series.map((s) => s.key)).toEqual(["R1", "R2"]);
    expect(payload?.groups.map((g) => g.key)).toEqual(["age", "metro"]);
    expect(payload?.groups[0]?.bars[0]?.values.map((v) => v.value)).toEqual([expect.closeTo(0.6), expect.closeTo(0.4)]);
    expect(payload?.groups[1]?.bars.map((b) => b.values)).toEqual([
      [
        { value: expect.closeTo(1 / 3), reason: null },
        { value: expect.closeTo(2 / 3), reason: null },
      ],
      [
        { value: null, reason: "budget_truncated" },
        { value: null, reason: "budget_truncated" },
      ],
    ]);
  });

  it("publishes the split as a Bars dataset for a pair", async () => {
    const run = setup({ members: [ALPHA, BETA] });
    await shareOfTasteSkill.run(input({ set: ["R1", "R2"] }), run.ctx);
    const bars = run.ledger.datasets.find((d) => d.kind === "Bars");
    expect(bars?.title).toBe("Who wins where · Brand Alpha vs Brand Beta");
    expect(bars?.formulaIds).toEqual(["share.pair_split", "share.pct"]);
  });

  it("publishes no split for sets larger than a pair", async () => {
    const four = setup();
    await shareOfTasteSkill.run(input(), four.ctx);
    expect(four.ledger.datasets.map((d) => d.kind)).toEqual(["Matrix"]);
  });
});

describe("share_of_taste: the largest input", () => {
  it("keeps eight long-named brands over eighteen contexts within the digest budget, every metric citable", async () => {
    const long = (e: Invented): Invented => ({ ...e, name: `${e.name} ${"Heritage Trading Company ".repeat(3)}`.trim() });
    const members = [ALPHA, BETA, GAMMA, DELTA, EPSILON, ZETA, OMEGA, UNTAGGED].map(long);
    const audiences = ["board_games", "live_music", "hiking", "cooking"].map((a) => `urn:audience:leisure:${a}`);
    const metros = ["nashville", "austin", "chicago", "denver", "seattle", "miami", "boston", "atlanta"];
    const contexts = [
      ...AGES4.map((a) => `age:${a}`),
      "age:30_to_34",
      "age:35_to_44",
      ...audiences.map((a) => `audience:${a}`),
      ...metros.map((m) => `location:loc-${m}`),
    ];
    const table: Table = Object.fromEntries(
      contexts.map((key, i) => [key, Object.fromEntries(members.map((e, j) => [e.id, 0.1 + ((i * 7 + j * 3) % 10) / 20]))]),
    );
    const localities: LocalityApi = { market: async (m) => ({ entityId: `loc-${m}`, label: m }) };
    const run = setup({ table, members, localities });
    const result = await shareOfTasteSkill.run(
      input({
        set: members.map((_, j) => `R${j + 1}`),
        ages: ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"],
        audiences,
        metros,
      }),
      run.ctx,
    );
    expect(result.status).toBe("ok");
    expect(run.calls).toHaveLength(18);
    expect(run.ledger.metrics).toHaveLength(SUBJECT_PCT_MAX + 2 * 8);
    expect(digestFits(result.forModel, { tool: "share_of_taste", step: "S3" })).toBe(true);
    expect(result.forModel.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(result.forModel.top_rows.every((r) => r.name.length <= NAME_MAX)).toBe(true);
    expect(MatrixPayload.parse(matrix(run).payload).cols[0]?.label.length).toBeGreaterThan(NAME_MAX);
    const kept = result.forModel.top_rows.length;
    if (kept < 8) expect(result.forModel.notices[0]).toBe(`${8 - kept} of 8 rows left out to fit this result; the full table is in D1.`);
  });
});

describe("share_of_taste: findings past the metric cap", () => {
  it("keeps a METRO_OUTLIER metro's percentile metric even when ten better contexts fill the cap", async () => {
    const ages = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
    const audiences = ["board_games", "live_music", "hiking", "cooking"].map((a) => `urn:audience:leisure:${a}`);
    const metros = ["nashville", "austin", "chicago", "denver", "seattle", "miami", "boston", "atlanta"];
    const leads = { [ALPHA.id]: 0.9, [BETA.id]: 0.6, [GAMMA.id]: 0.5, [DELTA.id]: 0.4 };
    // Alpha leads every age and audience and trails every metro but Austin, which it leads. Its
    // trailing scores differ by metro: one value repeated across calls would read as the floor.
    const table: Table = Object.fromEntries([
      ...ages.map((a) => [`age:${a}`, leads]),
      ...audiences.map((a) => [`audience:${a}`, leads]),
      ...metros.map((m, i) => [`location:loc-${m}`, m === "austin" ? leads : { ...leads, [ALPHA.id]: 0.3 + i / 1000 }]),
    ]);
    const localities: LocalityApi = { market: async (m) => ({ entityId: `loc-${m}`, label: m.charAt(0).toUpperCase() + m.slice(1) }) };
    const run = setup({ table, localities });
    await shareOfTasteSkill.run(input({ ages, audiences, metros }), run.ctx);
    expect(run.calls).toHaveLength(18);
    const pct = byKey(run, "share.pct");
    expect(pct).toHaveLength(SUBJECT_PCT_MAX);
    const outliers = run.ledger.findings.filter((f) => f.kind === "METRO_OUTLIER");
    expect(outliers.map((f) => f.text)).toEqual(["Brand Alpha ranks 1 of 4 in Austin, clearly better than its median rank across metros."]);
    const austin = pct.find((m) => m.subjectRefs.includes("austin"));
    expect(austin).toMatchObject({ value: 1, display: "1.00 · 1 of 4" });
    expect(outliers[0]?.metricIds).toEqual([austin?.id]);
    expect(run.ledger.findings.every((f) => f.kind === "DROPPED_CANDIDATES" || f.metricIds.length > 0)).toBe(true);
    // The rest of the cap alternates best and worst, so both ends of the subject's range keep a metric.
    expect(pct.filter((m) => m.value === 1)).toHaveLength(6);
    expect(pct.filter((m) => m.value === 0)).toHaveLength(4);
    expect(pct.map((m) => m.label).filter((l) => / \((best|worst) context\)$/.test(l))).toHaveLength(2);
  });
});

describe("share_of_taste: estimateCalls", () => {
  it("counts one call per context and nothing for cached ones", async () => {
    const registry = new FakeRegistry();
    for (const e of [ALPHA, BETA, GAMMA]) registerInvented(registry, e);
    const raw = input({ set: ["R1", "R2", "R3"] });
    expect(await estimateShareCalls(raw, fakeProbe(() => false), registry, { localities: LOCALITIES, geo: null })).toBe(7);
    const warm = fakeProbe(() => true);
    expect(await estimateShareCalls(raw, warm, registry, { localities: LOCALITIES, geo: null })).toBe(0);
    expect(warm.asked).toHaveLength(7);
    expect(warm.asked.every((a) => a.path === "/v2/insights" && a.params["filter.type"] === "urn:entity:brand")).toBe(true);
    // Half warm: the age calls are cached.
    const ages = fakeProbe((_, p) => p["signal.demographics.age"] !== undefined);
    expect(await shareOfTasteSkill.estimateCalls(raw, ages, registry)).toBe(3);
  });

  it("probes exactly the requests the run makes, so a finished run leaves a warm cache", async () => {
    const run = setup();
    const raw = input();
    await shareOfTasteSkill.run(raw, run.ctx);
    const made = new Set(run.calls.map((c) => JSON.stringify({ "filter.type": c.filterType, ...c.params })));
    const probe = fakeProbe((_, p) => made.has(JSON.stringify(p)));
    expect(await estimateShareCalls(raw, probe, run.registry, { localities: LOCALITIES, geo: null })).toBe(0);
  });

  it("counts unresolved metros as calls without the market seam, and costs nothing for an input it refuses", async () => {
    const registry = new FakeRegistry();
    for (const e of [ALPHA, BETA]) registerInvented(registry, e);
    const raw = input({ set: ["R1", "R2"], ages: ["24_and_younger"] });
    expect(await estimateShareCalls(raw, fakeProbe(() => true), registry)).toBe(3);
    expect(await estimateShareCalls(raw, fakeProbe(() => true), registry, { localities: { market: async () => null }, geo: null })).toBe(0);
    expect(await estimateShareCalls(input({ set: ["R1", "R9"] }), fakeProbe(() => false), registry, { localities: LOCALITIES, geo: null })).toBe(0);
  });
});
