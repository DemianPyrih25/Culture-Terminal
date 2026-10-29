import {
  AgeBucket,
  digestFits,
  ModelDigest,
  type DatasetOf,
  type InsightsFilterType,
  type InsightsResponse,
  type QlooApi,
  type QlooCallMeta,
  type QlooDemographicsBlock,
  type QlooParams,
  type QlooResult,
  type RegisteredEntity,
} from "@ct/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import {
  audienceDnaSkill,
  demographicsBatches,
  describeBatches,
  DNA_BATCH_MAX,
  DNA_TAKE,
  estimateAudienceDnaCalls,
} from "../../src/skills/audienceDna";
import { contrastTags, facetOf, facetProfile, facetTags, namespaceOf } from "../../src/skills/audienceDna/facets";
import { ageExtremes, averageIndices, youthIndex, type Indices } from "../../src/skills/audienceDna/profiles";
import { BudgetError, FETCHED_AT, fakeProbe, fakeRun, FakeRegistry, type FakeLedger } from "./support/fakes";

// Invented entities, tags and indices only (D29). Indices sit on Qloo's −1..1 scale around 0.

/**
 * The real ledger's rule, which the fake does not enforce: every metric with a value and every
 * dataset cites evidence, every cited evidence id exists, and every finding cites metrics that exist.
 */
function expectEvidenceChain(ledger: FakeLedger): void {
  const evidence = new Set<string>(ledger.evidences.map((e) => e.id));
  for (const m of ledger.metrics) {
    if (m.value !== null) expect(m.evidenceIds.length, `${m.id} ${m.key} has a value but no evidence`).toBeGreaterThan(0);
    for (const id of m.evidenceIds) expect(evidence.has(id), `${m.id} cites missing ${id}`).toBe(true);
  }
  for (const d of ledger.datasets) {
    expect(d.evidenceIds.length, `${d.id} cites no evidence`).toBeGreaterThan(0);
    for (const id of d.evidenceIds) expect(evidence.has(id), `${d.id} cites missing ${id}`).toBe(true);
  }
  const metrics = new Set<string>(ledger.metrics.map((m) => m.id));
  for (const f of ledger.findings) for (const id of f.metricIds) expect(metrics.has(id), `${f.id} cites missing ${id}`).toBe(true);
}

/** Every ledger a test's skill runs wrote to; each is checked once the test ends. */
const ledgers: FakeLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) expectEvidenceChain(ledger);
});

type Ages = readonly [number, number, number, number, number, number];

interface Subject {
  id: string;
  name: string;
  type?: RegisteredEntity["type"];
  /** Tag ids; names are the last segment. */
  tags?: readonly string[];
  /** Indices, or undefined for an entity Qloo has no block for. */
  ages?: Ages;
  gender?: { female: number; male: number };
}

const tag = (ns: string, leaf: string) => `urn:tag:${ns}:qloo:${leaf}`;
const GENRE = "urn:tag:genre:brand:beverage";

const ALPHA: Subject = {
  id: "ent-alpha-01",
  name: "Brand Alpha",
  tags: [GENRE, tag("lifestyle", "trail_weekends"), tag("aesthetic_property", "sunwashed"), tag("core_value", "craft"), tag("emotional_tone", "calm")],
  ages: [0.4, 0.3, 0.1, 0, -0.2, -0.4],
  gender: { female: 0.2, male: -0.18 },
};
const BETA: Subject = {
  id: "ent-beta-02",
  name: "Brand Beta",
  tags: [GENRE, tag("lifestyle", "trail_weekends"), tag("emotional_tone", "bold")],
  ages: [0.1, 0.1, 0, 0, 0, -0.1],
  gender: { female: -0.1, male: 0.1 },
};
const GAMMA: Subject = {
  id: "ent-gamma-03",
  name: "Brand Gamma",
  tags: [GENRE, tag("aesthetic_property", "sunwashed")],
  ages: [-0.2, -0.1, 0, 0.1, 0.2, 0.3],
  gender: { female: 0, male: 0 },
};
const DELTA: Subject = {
  id: "ent-delta-04",
  name: "Brand Delta",
  tags: [GENRE],
  ages: [0, 0.2, 0.1, 0, -0.1, -0.1],
  gender: { female: 0.1, male: -0.1 },
};
const QUIET: Subject = { id: "ent-quiet-05", name: "Brand Quiet", tags: [GENRE] };
const NOVA: Subject = { id: "ent-nova-09", name: "Artist Nova", type: "artist", ages: [0.6, 0.5, 0.2, -0.1, -0.4, -0.6], gender: { female: 0.3, male: -0.3 } };
const BARE: Subject = { id: "ent-bare-12", name: "Brand Bare", ages: [0, 0, 0, 0, 0, 0], gender: { female: 0, male: 0 } };

function block(s: Subject): QlooDemographicsBlock | null {
  if (s.ages === undefined) return null;
  const age = Object.fromEntries(AgeBucket.options.map((b, i) => [b, s.ages![i]!])) as QlooDemographicsBlock["query"]["age"];
  return { entity_id: s.id, query: { age, gender: s.gender ?? { female: 0, male: 0 } } };
}

type DnaCall = { filterType: string; params: QlooParams } | { entityIds: readonly string[] };

function tagRefs(s: Subject) {
  return (s.tags ?? []).map((t) => ({ tag_id: t, name: t.split(":").pop()!.replace(/_/g, " "), type: t.split(":").slice(0, 3).join(":") }));
}

/**
 * A Qloo double: urn:demographics answers from the subjects' blocks in request order, skipping the
 * missing ones; /entities answers /search-shaped rows with the subjects' tags. `fail` makes a call
 * throw a Qloo client error with that code.
 */
function dnaQloo(subjects: readonly Subject[], budget?: number, fail?: { entities?: string; insights?: string }) {
  const calls: DnaCall[] = [];
  let attempts = 0;
  const byId = new Map(subjects.map((s) => [s.id, s]));
  const meta = (): QlooCallMeta => ({
    qlooCallId: `qc-${calls.length}`,
    requestId: `req-synthetic-${calls.length}`,
    cache: "miss",
    fetchedAt: FETCHED_AT,
    ms: 5,
    stale: false,
    originRunId: null,
  });
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const gate = (code: string | undefined) => {
    attempts += 1;
    if (budget !== undefined && attempts > budget) throw new BudgetError("run cap reached");
    if (code !== undefined) throw Object.assign(new Error(`synthetic ${code}`), { code });
  };
  const api: QlooApi = {
    search: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
    entities: async (entityIds) => {
      gate(fail?.entities);
      calls.push({ entityIds });
      const results = entityIds.flatMap((id) => {
        const s = byId.get(id);
        return s === undefined ? [] : [{ entity_id: s.id, name: s.name, types: [`urn:entity:${s.type ?? "brand"}`], tags: tagRefs(s) }];
      });
      return { data: { results }, meta: meta() };
    },
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      gate(fail?.insights);
      calls.push({ filterType, params });
      const ids = params["signal.interests.entities"] as readonly string[];
      const demographics = ids.flatMap((id) => {
        const s = byId.get(id);
        const b = s === undefined ? null : block(s);
        return b === null ? [] : [b];
      });
      return { data: { results: { demographics } } as unknown as InsightsResponse<F>, meta: meta() };
    },
  };
  return { api, calls };
}

/** Registers a subject without tags: the skill reads facet tags from /entities, never from the registry. */
function register(registry: FakeRegistry, s: Subject): RegisteredEntity {
  return registry.registerEntity({ entityId: s.id, name: s.name, type: s.type ?? "brand", popularity: 0.7, disambiguation: null, tags: [] });
}

/** A subject's tags as the facet helpers read them. */
const tagsOf = (s: Subject) => facetTags({ tags: tagRefs(s).map((t) => ({ tagId: t.tag_id, name: t.name, type: t.type })) });

function setup(
  subjects: readonly Subject[],
  options: { budget?: number; known?: readonly Subject[]; fail?: { entities?: string; insights?: string } } = {},
) {
  const registry = new FakeRegistry();
  for (const s of subjects) register(registry, s);
  // `known`: the subjects Qloo has a demographics block for (all by default); every subject keeps its tags.
  const known = options.known ?? subjects;
  const qloo = dnaQloo(subjects.map((s) => (known.includes(s) ? s : { ...s, ages: undefined })), options.budget, options.fail);
  const run = fakeRun(qloo.api, registry);
  ledgers.push(run.ledger);
  return { ...run, calls: qloo.calls };
}

function input(set: string[], compare_with: string | null = null) {
  return audienceDnaSkill.input.parse({ set, compare_with, trigger_finding_id: null, step_id: "S5" });
}

function dataset<K extends "Bars" | "Ranked">(run: ReturnType<typeof setup>, kind: K, title: string): DatasetOf<K> {
  const d = run.ledger.datasets.find((x) => x.kind === kind && x.title.startsWith(title));
  if (d === undefined) throw new Error(`no ${kind} dataset titled ${title}`);
  return d as DatasetOf<K>;
}

const indices = (s: Subject): Indices => ({
  age: Object.fromEntries(AgeBucket.options.map((b, i) => [b, s.ages![i]!])) as Indices["age"],
  gender: s.gender!,
});

describe("audience_dna: profiles and facets", () => {
  it("computes Y as the mean of the two youngest indices minus the two oldest", () => {
    expect(youthIndex(indices(ALPHA))).toBeCloseTo((0.4 + 0.3) / 2 - (-0.2 - 0.4) / 2, 12);
    expect(youthIndex(indices(GAMMA))).toBeCloseTo(-0.4, 12);
    expect(ageExtremes(indices(ALPHA))).toEqual({ highest: "24_and_younger", lowest: "55_and_older" });
    expect(ageExtremes(indices(BARE))).toEqual({ highest: "24_and_younger", lowest: "24_and_younger" });
  });

  it("averages profiles bucket by bucket and has no average of nothing", () => {
    const avg = averageIndices([indices(BETA), indices(GAMMA)])!;
    expect(avg.age["24_and_younger"]).toBeCloseTo(-0.05, 12);
    expect(avg.gender).toEqual({ female: -0.05, male: 0.05 });
    expect(averageIndices([])).toBeNull();
  });

  it("groups tags by namespace into the SPEC facets first, other namespaces after", () => {
    expect(namespaceOf({ tagId: GENRE, type: "" })).toBe("genre");
    expect(facetOf({ tagId: tag("aesthetic_property", "x"), type: "" })).toBe("aesthetic");
    expect(facetOf({ tagId: tag("product_service", "x"), type: "" })).toBe("product");
    expect(facetOf({ tagId: "plain-id", type: "urn:tag:lifestyle" })).toBe("lifestyle");
    expect(facetOf({ tagId: "plain-id", type: "" })).toBe("other");
    const profile = facetProfile(tagsOf(ALPHA), []);
    expect(profile.groups.map((g) => g.label)).toEqual(["Aesthetic", "Emotional tone", "Lifestyle", "Genre", "Core value"]);
  });

  it("leaves noise tags (a place name, a generic music word) out of the facet tags through the shared filter", () => {
    const tags = facetTags({
      tags: [
        { tagId: tag("lifestyle", "slow_living"), name: "slow living", type: "urn:tag:lifestyle" },
        { tagId: tag("genre", "usa"), name: "Usa", type: "urn:tag:genre" },
        { tagId: "urn:tag:genre:music:seen_live", name: "seen live", type: "urn:tag:genre:music" },
      ],
    });
    expect(tags.map((t) => t.name)).toEqual(["slow living"]);
  });

  it("calls a tag in the SPEC facets distinctive when fewer than half of the peers with known tags carry it", () => {
    const target = tagsOf(ALPHA);
    const sets = [BETA, GAMMA, DELTA].map((s) => new Set(s.tags));
    const profile = facetProfile(target, [...sets, new Set<string>()]);
    expect(profile.peers).toBe(3);
    expect(profile.distinctive.map((t) => t.name)).toEqual(["sunwashed", "calm", "trail weekends"]);
    // core_value is not one of the seven facets: listed with its peer count, never scored or counted.
    expect(profile.total).toBe(4);
    expect(profile.groups.find((g) => g.facet === "core_value")?.tags[0]).toMatchObject({ peerCount: 0, distinctive: null });
    const lifestyle = profile.groups.find((g) => g.facet === "lifestyle")?.tags[0];
    expect(lifestyle).toMatchObject({ peerCount: 1, distinctive: true });
    expect(profile.groups.find((g) => g.facet === "genre")?.tags[0]).toMatchObject({ peerCount: 3, distinctive: false });
    expect(facetProfile(target, []).distinctive).toEqual([]);
    expect(facetProfile(target, []).groups[0]?.tags[0]).toMatchObject({ peerCount: null, distinctive: null });
  });

  it("splits two tag lists into only-A, both and only-B", () => {
    const c = contrastTags(tagsOf(ALPHA), tagsOf(BETA));
    expect(c.aOnly.map((t) => t.name)).toEqual(["sunwashed", "calm", "craft"]);
    expect(c.shared.map((t) => t.name)).toEqual(["trail weekends", "beverage"]);
    expect(c.bOnly.map((t) => t.name)).toEqual(["bold"]);
  });

  it("batches at most 30 ids with take 50, and describes at most 50 ids a call", () => {
    const ids = Array.from({ length: 61 }, (_, i) => `ent-x-${i}`);
    const batches = demographicsBatches(ids);
    expect(batches.map((b) => (b["signal.interests.entities"] as string[]).length)).toEqual([DNA_BATCH_MAX, DNA_BATCH_MAX, 1]);
    expect(batches.every((b) => b.take === DNA_TAKE)).toBe(true);
    expect(DNA_TAKE).toBe(50);
    expect(describeBatches(ids).map((b) => b.length)).toEqual([50, 11]);
  });
});

describe("audience_dna: a set against its peers", () => {
  it("asks one urn:demographics batch for the set and measures the target against the peers' average", async () => {
    const run = setup([ALPHA, BETA, GAMMA, DELTA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);

    expect(run.calls).toEqual([
      { filterType: "urn:demographics", params: { "signal.interests.entities": [ALPHA.id, BETA.id, GAMMA.id, DELTA.id], take: 50 } },
      { entityIds: [ALPHA.id, BETA.id, GAMMA.id, DELTA.id] },
    ]);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["DEMOGRAPHICS_ARE_INDICES"]);
    expect(run.ledger.evidences.map((e) => [e.skill, e.status, e.flags])).toEqual([
      ["audience_dna", "ok", ["DEMOGRAPHICS_ARE_INDICES"]],
      ["audience_dna", "ok", []],
    ]);
    expect(run.ledger.evidences[1]?.summary).toBe("4 of 4 entities carry tags, grouped by namespace.");
    expect(run.ledger.findings).toEqual([]);

    const metrics = run.ledger.metrics;
    // Target 6 + 2 + Y, peer average 6 + 2 + Y, Y for each of the three peers, distinctive tags.
    expect(metrics).toHaveLength(9 + 9 + 3 + 1);
    const target = metrics.filter((m) => m.subjectRefs.join() === "R1");
    expect(target.map((m) => [m.formulaId, m.badge])).toEqual([
      ...Array.from({ length: 6 }, () => ["dna.age_index", "MEASURED"]),
      ["dna.gender_index", "MEASURED"],
      ["dna.gender_index", "MEASURED"],
      ["dna.youth_index", "DERIVED"],
      ["dna.distinctive_tags", "DERIVED"],
    ]);
    expect(target[1]).toMatchObject({ label: "Brand Alpha age index 25–29", value: 0.3, display: "+0.30", unit: "index", comparator: "BASELINE", n: 6, evidenceIds: ["E1"] });
    expect(target[6]).toMatchObject({ label: "Brand Alpha gender index, women", value: 0.2, n: 2 });
    expect(target[8]?.value).toBeCloseTo(0.65, 12);
    expect(target[8]?.display).toBe("+0.65 · rank 1 of 4, youngest first");

    const average = metrics.filter((m) => m.label.startsWith("peers (average of 3)"));
    expect(average).toHaveLength(9);
    expect(average.every((m) => m.badge === "DERIVED" && m.n === 3 && m.subjectRefs.join() === "R2,R3,R4")).toBe(true);
    expect(average[0]?.value).toBeCloseTo((0.1 - 0.2 + 0) / 3, 12);

    const youth = metrics.filter((m) => m.key === "dna.youth_index" && m.subjectRefs.length === 1).map((m) => [m.subjectRefs[0], m.display]);
    expect(youth).toEqual([
      ["R1", "+0.65 · rank 1 of 4, youngest first"],
      ["R2", "+0.15 · rank 3 of 4, youngest first"],
      ["R3", "-0.40 · rank 4 of 4, youngest first"],
      ["R4", "+0.20 · rank 2 of 4, youngest first"],
    ]);
    expect(metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({
      label: "distinctive facet tags of Brand Alpha (on fewer than half of its peers of the same type)",
      value: 3,
      display: "3 of 4 facet tags distinctive, vs 3 peers of the same type",
      unit: "count",
      comparator: "PEERS",
      n: 3,
      evidenceIds: ["E2"],
    });
  });

  it("draws a dumbbell of the target against the peers' average around 0", async () => {
    const run = setup([ALPHA, BETA, GAMMA, DELTA]);
    await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);
    const bars = dataset(run, "Bars", "Audience DNA");
    expect(bars.title).toBe("Audience DNA · Brand Alpha vs peers");
    expect(bars.evidenceIds).toEqual(["E1"]);
    expect(bars.formulaIds).toEqual(["dna.age_index", "dna.gender_index"]);
    expect(bars.payload).toMatchObject({ mode: "butterfly", display: "dumbbell", baseline: 0, comparator: "BASELINE", unit: "index", method: null });
    expect(bars.payload.series).toEqual([
      { key: "R1", label: "Brand Alpha", ref: "R1", group: null },
      { key: "peers", label: "Peers, average of 3", ref: null, group: null },
    ]);
    const [age, gender] = bars.payload.groups;
    expect(age?.bars.map((b) => [b.key, b.label])).toEqual(AgeBucket.options.map((b, i) => [b, ["≤24", "25–29", "30–34", "35–44", "45–54", "55+"][i]]));
    expect(age?.bars[0]?.values[0]).toEqual({ value: 0.4, reason: null });
    expect(gender?.bars.map((b) => b.label)).toEqual(["Women", "Men"]);
    expect(gender?.bars[1]?.values[0]).toEqual({ value: -0.18, reason: null });
  });

  it("ranks the set by youth index and lists the target's facet tags, distinctive first", async () => {
    const run = setup([ALPHA, BETA, GAMMA, DELTA]);
    await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);
    const youth = dataset(run, "Ranked", "Youth index");
    expect(youth.payload.groups[0]?.rows.map((r) => [r.ref, r.rank, r.flags])).toEqual([
      ["R1", 1, ["TARGET"]],
      ["R4", 2, []],
      ["R2", 3, []],
      ["R3", 4, []],
    ]);
    const facets = dataset(run, "Ranked", "Facet tags · Brand Alpha");
    expect(facets.evidenceIds).toEqual(["E2"]);
    expect(facets.payload.columns).toEqual([{ key: "peers", label: "Same-type peers with the tag (of 3)", unit: "count", comparator: "PEERS" }]);
    expect(facets.payload.groups.map((g) => g.label)).toEqual(["Aesthetic", "Emotional tone", "Lifestyle", "Genre", "Core value"]);
    const genre = facets.payload.groups.find((g) => g.key === "genre")?.rows[0];
    expect(genre).toMatchObject({ label: "beverage", sublabel: null, cells: [{ value: 3, reason: null }] });
    expect(facets.payload.groups[0]?.rows[0]).toMatchObject({ label: "sunwashed", sublabel: "distinctive", cells: [{ value: 1, reason: null }] });
    const coreValue = facets.payload.groups.find((g) => g.key === "core_value")?.rows[0];
    expect(coreValue).toMatchObject({ label: "craft", sublabel: null, cells: [{ value: 0, reason: null }] });
    expect(facets.payload.caption).toContain("fewer than half of its 3 peers of the same type");
    expect(facets.payload.caption).toContain("other namespaces are listed as context");
  });

  it("fits the digest with rows that name the metrics and leaks no Qloo ids", async () => {
    const run = setup([ALPHA, BETA, GAMMA, DELTA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "audience_dna", step: "S5" })).toBe(true);
    expect(digest.dataset_ids).toEqual(["D1", "D2", "D3"]);
    expect(digest.top_rows.map((r) => r.name)).toEqual([
      "Brand Alpha",
      "peers (average of 3)",
      "distinctive tags · Brand Alpha",
      "Brand Delta",
      "Brand Beta",
      "Brand Gamma",
    ]);
    expect(digest.top_rows[0]?.values).toMatchObject({ role: "target", demographics: "measured", highest_age: "≤24", lowest_age: "55+", tags: 5 });
    expect(digest.top_rows[2]?.values).toEqual({ metric: "M22", tags: "sunwashed; calm; trail weekends" });
    expect(digest.notices).toEqual(["The DNA figure compares Brand Alpha with peers (average of 3)."]);
    expect(JSON.stringify(digest)).not.toContain("ent-");
  });
});

describe("audience_dna: two subjects", () => {
  it("mirrors the compare subject against the target with full profiles and qualitative tag lists", async () => {
    const run = setup([ALPHA, GAMMA, DELTA, BETA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3"], "R4"), run.ctx);
    expect(run.calls[0]).toMatchObject({ params: { "signal.interests.entities": [ALPHA.id, BETA.id, GAMMA.id, DELTA.id] } });
    const bars = dataset(run, "Bars", "Audience DNA");
    expect(bars.title).toBe("Audience DNA · Brand Alpha vs Brand Beta");
    expect(bars.payload.series.map((s) => s.key)).toEqual(["R1", "R4"]);
    expect(bars.payload.groups[0]?.bars[0]?.values).toEqual([{ value: 0.4, reason: null }, { value: 0.1, reason: null }]);
    // Target 9, compare 9, Y for the two set peers, distinctive tags.
    expect(run.ledger.metrics).toHaveLength(9 + 9 + 2 + 1);
    expect(run.ledger.metrics.filter((m) => m.subjectRefs.join() === "R4").map((m) => m.badge)).toEqual([
      ...Array.from({ length: 8 }, () => "MEASURED"),
      "DERIVED",
    ]);

    const contrast = dataset(run, "Ranked", "Facet tags · Brand Alpha vs Brand Beta");
    expect(contrast.payload.groups.map((g) => [g.label, g.rows.map((r) => r.label)])).toEqual([
      ["Only Brand Alpha", ["sunwashed", "calm", "craft"]],
      ["Both", ["trail weekends", "beverage"]],
      ["Only Brand Beta", ["bold"]],
    ]);
    expect(contrast.payload.groups[0]?.rows[0]).toMatchObject({ sublabel: "Aesthetic", cells: [{ value: 1, reason: null }] });
    const rows = result.forModel.top_rows.map((r) => r.name);
    expect(rows.slice(0, 5)).toEqual(["Brand Alpha", "Brand Beta", "distinctive tags · Brand Alpha", "tags only on Brand Alpha", "tags only on Brand Beta"]);
    expect(result.forModel.top_rows[4]?.values).toEqual({ tags: "bold", presence: "qualitative" });
  });

  it("uses the one other set member as the second series when there is no compare subject", async () => {
    const run = setup([ALPHA, NOVA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("ok");
    const bars = dataset(run, "Bars", "Audience DNA");
    expect(bars.title).toBe("Audience DNA · Brand Alpha vs Artist Nova");
    expect(bars.payload.display).toBe("dumbbell");
    expect(run.ledger.metrics.filter((m) => m.subjectRefs.join() === "R2" && m.badge === "MEASURED")).toHaveLength(8);
    expect(run.ledger.datasets.some((d) => d.title.startsWith("Youth index"))).toBe(false);
    // Artist Nova is not a brand, so no tag of Brand Alpha can be called distinctive.
    expect(run.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, badge: "UNAVAILABLE", reason: "not_measured" });
    expect(result.forModel.notices).toContain("No set peer of the same type (brand) carries tags in Qloo, so no tag is called distinctive.");
  });

  it("calls tags distinctive only against set peers of the target's own type", async () => {
    // An artist and a TV show carry their own tags; none of them can ever sit on a brand.
    const SONG: Subject = {
      id: "ent-song-13",
      name: "Artist Song",
      type: "artist",
      tags: ["urn:tag:genre:music:indie", tag("emotional_tone", "wistful")],
      ages: [0.5, 0.3, 0, -0.1, -0.3, -0.4],
      gender: { female: 0.1, male: -0.1 },
    };
    const SERIES: Subject = { id: "ent-series-14", name: "Show Series", type: "tv_show", tags: ["urn:tag:genre:media:drama"], ages: [0, 0, 0.1, 0.1, 0, 0], gender: { female: 0.2, male: -0.2 } };

    const mixed = setup([ALPHA, SONG, SERIES]);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3"]), mixed.ctx);
    expect(mixed.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, badge: "UNAVAILABLE", reason: "not_measured" });
    expect(result.forModel.notices).toContain("No set peer of the same type (brand) carries tags in Qloo, so no tag is called distinctive.");
    const facets = dataset(mixed, "Ranked", "Facet tags · Brand Alpha");
    expect(facets.payload.columns[0]?.label).toBe("Same-type peers with the tag");
    expect(facets.payload.groups.flatMap((g) => g.rows).every((r) => r.sublabel === null && r.cells[0]?.reason === "not_measured")).toBe(true);
    // The indices still compare across types (P5): the figure averages both peers.
    expect(dataset(mixed, "Bars", "Audience DNA").payload.series[1]?.label).toBe("Peers, average of 2");

    // With a brand in the set, only it counts: trail weekends and beverage are on Brand Beta.
    const withBrand = setup([ALPHA, SONG, SERIES, BETA]);
    await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), withBrand.ctx);
    expect(withBrand.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({
      value: 2,
      display: "2 of 4 facet tags distinctive, vs 1 peer of the same type",
      n: 1,
    });
  });

  it("does not score tags outside the core facets, so a target with only those has no distinctive count", async () => {
    const CORE: Subject = {
      id: "ent-core-15",
      name: "Brand Core",
      tags: [tag("core_value", "craft"), tag("competitor_brand", "brand_kappa")],
      ages: [0.1, 0, 0, 0, 0, -0.1],
      gender: { female: 0, male: 0 },
    };
    const run = setup([CORE, BETA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(run.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, reason: "not_measured" });
    expect(result.forModel.notices).toContain("Brand Core carries no tags in the core facets, so no tag is called distinctive.");
    const facets = dataset(run, "Ranked", "Facet tags · Brand Core");
    expect(facets.payload.groups.map((g) => [g.label, g.rows.map((r) => [r.label, r.sublabel, r.cells[0]?.value])])).toEqual([
      ["Competitor brand", [["brand kappa", null, 0]]],
      ["Core value", [["craft", null, 0]]],
    ]);
  });

  it("draws one diverging series for a single entity", async () => {
    const run = setup([BARE]);
    const result = await audienceDnaSkill.run(input(["R1"]), run.ctx);
    const bars = dataset(run, "Bars", "Audience DNA");
    expect(bars.title).toBe("Audience DNA · Brand Bare");
    expect(bars.payload.mode).toBe("diverging");
    expect(bars.payload.display).toBeUndefined();
    expect(bars.payload.baseline).toBe(0);
    expect(run.ledger.metrics.find((m) => m.key === "dna.youth_index")?.display).toBe("0.00");
    expect(result.forModel.notices).toEqual(["Brand Bare carries no tags in Qloo, so its facets are not measured."]);
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Bars"]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "empty"]);
  });
});

describe("audience_dna: gaps", () => {
  it("records an entity without a block as not measured, never 0, with a DROPPED_CANDIDATES finding", async () => {
    const run = setup([ALPHA, BETA, QUIET, GAMMA]);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DEMOGRAPHICS_ARE_INDICES", "DROPPED_CANDIDATES"]);
    const quiet = run.ledger.metrics.filter((m) => m.subjectRefs.join() === "R3");
    expect(quiet).toEqual([expect.objectContaining({ key: "dna.youth_index", value: null, reason: "not_measured", badge: "UNAVAILABLE", display: "not measured" })]);
    expect(run.ledger.findings).toEqual([
      expect.objectContaining({ kind: "DROPPED_CANDIDATES", metricIds: [quiet[0]!.id], severity: "low" }),
    ]);
    expect(run.ledger.findings[0]?.text).toContain("Brand Quiet was not scored in the demographics batch");
    expect(run.ledger.evidences[0]?.summary).toBe("3 of 4 entities have a demographics block; no block (not measured): Brand Quiet.");
    const youth = dataset(run, "Ranked", "Youth index");
    expect(youth.payload.groups[0]?.rows.at(-1)).toMatchObject({ ref: "R3", rank: null, cells: [{ value: null, reason: "not_measured" }] });
    // The average covers the two measured peers only.
    expect(dataset(run, "Bars", "Audience DNA").payload.series[1]?.label).toBe("Peers, average of 2");
  });

  it("keeps a target without a block in the figure as not measured and calls the result partial", async () => {
    const run = setup([QUIET, BETA], { known: [BETA] });
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    const bars = dataset(run, "Bars", "Audience DNA");
    expect(bars.payload.groups[0]?.bars[0]?.values).toEqual([{ value: null, reason: "not_measured" }, { value: 0.1, reason: null }]);
  });

  it("finds nothing to read when no entity has a block and suggests age contexts for brands", async () => {
    const run = setup([QUIET, { ...BETA, ages: undefined }]);
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.evidences[0]?.status).toBe("empty");
    expect(run.ledger.datasets.some((d) => d.kind === "Bars")).toBe(false);
    const empty = run.ledger.findings.find((f) => f.kind === "EMPTY_RESULT");
    expect(empty).toMatchObject({
      text: "The demographics batch for Brand Quiet returned no usable results.",
      suggestion: { tool: "share_of_taste", reason: "Rank Brand Quiet against its peers in age contexts instead." },
    });
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES"]);
  });

  it("reports budget-refused calls as partial with every index and the tag count explained", async () => {
    const run = setup([ALPHA, BETA], { budget: 0 });
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.findings).toEqual([]);
    expect(run.ledger.datasets).toEqual([]);
    const youth = run.ledger.metrics.filter((m) => m.key === "dna.youth_index");
    expect(youth.map((m) => [m.subjectRefs[0], m.reason])).toEqual([
      ["R1", "budget_truncated"],
      ["R2", "budget_truncated"],
    ]);
    expect(run.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, reason: "budget_truncated" });
  });

  it("keeps the indices when only the facet-tag call is refused or fails", async () => {
    const cut = setup([ALPHA, BETA], { budget: 1 });
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), cut.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["DEMOGRAPHICS_ARE_INDICES", "BUDGET_TRUNCATED"]);
    expect(cut.ledger.evidences.map((e) => e.purpose)).toEqual(["Age and gender affinity indices (urn:demographics) for 2 entities"]);
    expect(cut.ledger.datasets.map((d) => d.kind)).toEqual(["Bars"]);
    expect(cut.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, reason: "budget_truncated" });

    const failed = setup([ALPHA, BETA], { fail: { entities: "qloo_unavailable" } });
    const partial = await audienceDnaSkill.run(input(["R1", "R2"]), failed.ctx);
    expect(partial.status).toBe("partial");
    expect(partial.flags).toEqual(["CANDIDATES_UNSCORED", "DEMOGRAPHICS_ARE_INDICES"]);
    expect(partial.forModel.notices).toContain("The facet-tag call failed, so facet tags are not measured.");
    expect(failed.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, reason: "error" });
    expect(failed.ledger.metrics.filter((m) => m.badge === "MEASURED")).toHaveLength(16);
  });

  it("fails outright when the demographics call fails, and on a caller bug in either call", async () => {
    const lost = setup([ALPHA, BETA], { fail: { insights: "qloo_unavailable" } });
    await expect(audienceDnaSkill.run(input(["R1", "R2"]), lost.ctx)).rejects.toThrow("synthetic qloo_unavailable");
    expect(lost.ledger.evidences).toHaveLength(0);
    // The demographics batch goes first, so its failure spends no describe call.
    expect(lost.calls).toEqual([]);
    const bug = setup([ALPHA, BETA], { fail: { entities: "qloo_param" } });
    await expect(audienceDnaSkill.run(input(["R1", "R2"]), bug.ctx)).rejects.toThrow("synthetic qloo_param");
  });
});

describe("audience_dna: inputs, estimate, digest budget", () => {
  it("errors when the first entity is unknown and leaves out other unknown refs", async () => {
    const run = setup([ALPHA]);
    const error = await audienceDnaSkill.run(input(["R5"]), run.ctx);
    expect(error.status).toBe("error");
    expect(error.forModel.notices).toEqual(["R5 is not in the registry; resolve it first."]);
    expect(run.calls).toHaveLength(0);

    const result = await audienceDnaSkill.run(input(["R1", "R8"], "R9"), run.ctx);
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining(["R8 is not in the registry; left out.", "R9 is not in the registry; no comparison drawn."]),
    );
    const self = await audienceDnaSkill.run(input(["R1"], "R1"), run.ctx);
    expect(self.forModel.notices).toContain("compare_with R1 is the first entity of the set; nothing to mirror.");
  });

  it("counts the batch and the describe call, each free when cached, and none without a known target", async () => {
    const registry = new FakeRegistry();
    for (const s of [ALPHA, BETA, GAMMA]) register(registry, s);
    const cold = fakeProbe(() => false);
    expect(await audienceDnaSkill.estimateCalls(input(["R1", "R2"], "R3"), cold, registry)).toBe(2);
    expect(cold.asked).toEqual([
      {
        path: "/v2/insights",
        params: { "filter.type": "urn:demographics", "signal.interests.entities": [ALPHA.id, GAMMA.id, BETA.id], take: 50 },
      },
      { path: "/entities", params: { entity_ids: [ALPHA.id, GAMMA.id, BETA.id] } },
    ]);
    expect(await estimateAudienceDnaCalls(input(["R1", "R2"], "R3"), fakeProbe(() => true), registry)).toBe(0);
    expect(await estimateAudienceDnaCalls(input(["R1", "R2"], "R3"), fakeProbe((path) => path === "/entities"), registry)).toBe(1);
    expect(await audienceDnaSkill.estimateCalls(input(["R7"]), cold, registry)).toBe(0);
  });

  it("fits twelve long-named entities and a compare subject into the digest without dropping a metric", async () => {
    const many: Subject[] = Array.from({ length: 13 }, (_, i) => ({
      id: `ent-many-${String(i).padStart(2, "0")}`,
      name: `Brand ${String.fromCharCode(65 + i)} Heritage Trading Company Limited of Somewhere`,
      tags: [GENRE, tag("lifestyle", `leaf_${i % 4}`), tag("emotional_tone", `tone_${i % 3}`)],
      ages: [0.1 * (i % 5), 0.05, 0, 0, -0.05, -0.1 * (i % 3)],
      gender: { female: 0.01 * i, male: -0.01 * i },
      type: i === 5 ? "tv_show" : "brand",
    }));
    const run = setup(many);
    const refs = many.map((_, i) => `R${i + 1}`);
    const result = await audienceDnaSkill.run(input(refs.slice(0, 12), "R13"), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "audience_dna", step: "S5" })).toBe(true);
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(30);
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(JSON.stringify(digest)).not.toContain("ent-");
  });

  it("returns its fixed method limitations", () => {
    expect(audienceDnaSkill.limitations(["DEMOGRAPHICS_ARE_INDICES"])).toEqual([...SKILL_LIMITATIONS.audience_dna]);
    expect(audienceDnaSkill.mnemonic).toBe("DNA");
  });
});
