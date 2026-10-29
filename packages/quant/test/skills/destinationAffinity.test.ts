import { digestFits, ModelDigest, QuadrantPayload, type DatasetOf, type QlooEntity, type QlooParams } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { SKILLS } from "../../src/skills/index";
import {
  DESTINATION_TAKE,
  destinationAffinitySkill,
  destinationParams,
  TRAVEL_CAPTION,
} from "../../src/skills/destinationAffinity";
import { computeTravelQuadrant, labelledRows, quadrantOf } from "../../src/skills/destinationAffinity/quadrant";
import { fakeProbe, fakeQloo, fakeRun, FakeRegistry, registerInvented, type Invented } from "./support/fakes";

// Invented destinations and seeds only (D29). The fake insights handler answers the one destination
// call from a list, so each test reads like the travel taste it sets up.

const SEED: Invented = { id: "ent-seed-nova", name: "Artist Nova", category: null };
const SEED_B: Invented = { id: "ent-seed-ember", name: "Brand Ember", category: null };

interface Dest {
  id: string;
  name: string;
  affinity?: number;
  popularity?: number | null;
  region?: string | null;
  country?: string;
}

function destination(d: Dest): QlooEntity {
  return {
    entity_id: d.id,
    name: d.name,
    type: "urn:entity:destination",
    ...(d.popularity === null ? {} : { popularity: d.popularity ?? 0.5 }),
    properties: {
      geocode: { name: d.name, admin1_region: d.region === undefined ? "Tennessee" : d.region, country_code: d.country ?? "US" },
    },
    location: { lat: 36 + d.id.length / 100, lon: -86 - d.id.length / 100 },
    tags: [{ id: "urn:tag:genre:destination:town", name: "town", type: "urn:tag:genre:destination" }],
    ...(d.affinity === undefined ? {} : { query: { affinity: d.affinity } }),
  };
}

// Twelve destinations whose FIT tracks popularity, with small deterministic jitter, except Lantern
// Hollow: second in FIT and least popular, the one hidden pocket.
const JITTER = [0.012, -0.009, 0.006, -0.011, 0.008, -0.004, 0.01, -0.007, 0.003, -0.012, 0.009, -0.005];
const TOWNS = ["Ridgeview", "Lantern Hollow", "Cedar Falls", "Mill Creek", "Stone Harbor", "Pine Bluff", "Copper Flats", "Elm Crossing", "Fox Run", "Willow Bend", "Iron Gate", "Maple Ford"];
const REGIONS = ["Tennessee", "Tennessee", "Texas", "Texas", "Tennessee", "Ohio", "Texas", "Ohio", "Tennessee", "Texas", "Ohio", "Texas"];

function travelWorld(): Dest[] {
  return TOWNS.map((name, i) => ({
    id: `ent-dest-${String(i + 1).padStart(2, "0")}`,
    name,
    affinity: 0.9 - 0.05 * i,
    popularity: i === 1 ? 0.12 : 0.9 - 0.06 * i + (JITTER[i] ?? 0),
    region: REGIONS[i] ?? null,
  }));
}

function setup(rows: Dest[], options: { budget?: number; seeds?: Invented[] } = {}) {
  const registry = new FakeRegistry();
  for (const s of options.seeds ?? [SEED]) registerInvented(registry, s, "artist");
  const qloo = fakeQloo({ insights: () => rows.map(destination), budget: options.budget });
  return { ...fakeRun(qloo.api, registry), calls: qloo.calls };
}

function input(raw: Partial<{ seeds: string[]; step_id: string | null }> = {}) {
  return destinationAffinitySkill.input.parse({ seeds: ["R1"], trigger_finding_id: null, step_id: "S3", ...raw });
}

function quadrant(run: ReturnType<typeof setup>): DatasetOf<"Quadrant"> {
  const d = run.ledger.datasets.find((x) => x.kind === "Quadrant");
  if (d?.kind !== "Quadrant") throw new Error("expected a Quadrant dataset");
  return d;
}

describe("destination_affinity: the request", () => {
  it("sends the seeds only, US destinations, the top 50: no tag signal (P5) and no page", async () => {
    const run = setup(travelWorld(), { seeds: [SEED, SEED_B] });
    await destinationAffinitySkill.run(input({ seeds: ["R1", "R2"] }), run.ctx);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toEqual({
      method: "insights",
      filterType: "urn:entity:destination",
      params: { "signal.interests.entities": [SEED.id, SEED_B.id], "filter.geocode.country_code": "US", take: 50 },
    });
    expect(DESTINATION_TAKE).toBe(50);
    expect(Object.keys(destinationParams(["x"])).some((k) => k.includes("tags") || k === "page")).toBe(false);
  });

  it("answers an unregistered seed with an error and no calls", async () => {
    const run = setup(travelWorld());
    const result = await destinationAffinitySkill.run(input({ seeds: ["R1", "R7"] }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices).toEqual(["R7 is not in the registry; resolve the seeds first."]);
    expect(run.calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
  });
});

describe("destination_affinity: the quadrant", () => {
  it("splits at the medians, finds the hidden pocket and sums positive residuals into state belts", async () => {
    const run = setup(travelWorld());
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");

    const d = quadrant(run);
    QuadrantPayload.parse(d.payload);
    expect(d.payload.points).toHaveLength(12);
    expect(d.payload.inset).toBe("us_dots");
    expect(d.payload.caption).toBe(TRAVEL_CAPTION);
    expect(d.formulaIds).toEqual(expect.arrayContaining(["trvl.quadrant", "trvl.hidden_pocket"]));
    const byLabel = new Map(d.payload.points.map((p) => [p.label, p]));
    const pocket = byLabel.get("Lantern Hollow")!;
    expect(pocket).toMatchObject({ quadrant: "HIDDEN_POCKET", utr: true, labelled: true, ref: expect.stringMatching(/^R\d+$/) });
    expect(pocket.score).toBeGreaterThanOrEqual(2);
    expect(byLabel.get("Ridgeview")).toMatchObject({ quadrant: "HEARTLAND", y: 1 });
    expect(byLabel.get("Maple Ford")).toMatchObject({ quadrant: "COLD", y: 0 });
    for (const p of d.payload.points) {
      const above = p.y >= d.payload.ySplit;
      const popular = p.x >= d.payload.xSplit;
      expect(p.quadrant).toBe(above ? (popular ? "HEARTLAND" : "HIDDEN_POCKET") : popular ? "MASS" : "COLD");
      expect(p.geo?.region).toBe(p.group);
    }
    // Half the set sits on each side of a median split.
    expect(d.payload.points.filter((p) => p.y >= d.payload.ySplit)).toHaveLength(6);
    expect(d.payload.belts[0]?.region).toBe("Tennessee");
    expect(d.payload.belts.every((b) => b.value > 0)).toBe(true);
    const beltNotice = result.forModel.notices.find((n) => n.startsWith("Top state belts"));
    expect(beltNotice).toMatch(/^Top state belts \(taste above the popularity line\): Tennessee(, \w+)*; the values are in D1\.$/);

    const findings = run.ledger.findings;
    expect(findings.map((f) => f.kind)).toEqual(["HIDDEN_POCKET"]);
    expect(findings[0]?.text).toContain("Lantern Hollow");
    expect(findings[0]?.text).toContain("Artist Nova");
    const pocketMetric = run.ledger.metrics.find((m) => m.key === "trvl.hidden_pocket");
    expect(findings[0]?.metricIds).toEqual([pocketMetric?.id]);
  });

  it("records every number as a ledger metric with its formula, badge and evidence", async () => {
    const run = setup(travelWorld());
    await destinationAffinitySkill.run(input(), run.ctx);
    const evidenceId = run.ledger.evidences[0]?.id;
    const metrics = run.ledger.metrics;
    expect(metrics.length).toBeLessThanOrEqual(8 + 3);

    const fit = metrics.filter((m) => m.key === "trvl.fit");
    expect(fit).toHaveLength(8);
    for (const m of fit) {
      expect(m).toMatchObject({ formulaId: "trvl.quadrant", badge: "DERIVED", unit: "pct", comparator: "WITHIN_CALL", n: 12 });
    }
    expect(fit.find((m) => m.label.includes("Ridgeview"))?.display).toBe("1.00 · 1 of 12");
    expect(metrics.find((m) => m.key === "trvl.hidden_pocket")).toMatchObject({
      formulaId: "trvl.hidden_pocket",
      badge: "ESTIMATED",
      unit: "stat",
    });
    // No formula defines a state belt yet, so belts stay in the Quadrant payload and are never a metric.
    expect(metrics.some((m) => m.key === "trvl.state_belt")).toBe(false);
    for (const m of metrics) {
      expect(m.evidenceIds).toEqual([evidenceId]);
      expect(m.value).not.toBeNull();
    }
  });

  it("builds a digest that fits, cites its metrics by id and never shows Qloo ids", async () => {
    const run = setup(travelWorld());
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "destination_affinity", step: "S3" })).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("ent-");
    expect(digest.top_rows[0]).toMatchObject({ name: "Lantern Hollow", values: { quadrant: "hidden pocket", state: "Tennessee" } });
    expect(digest.top_rows).toHaveLength(8);
    expect(digest.registered).toHaveLength(8);
    expect(digest.registered.every((r) => r.type === "destination")).toBe(true);
    const metricIds = new Set(digest.metrics.map((m) => m.id));
    for (const row of digest.top_rows) expect(metricIds.has(row.values.fit_metric as `M${number}`)).toBe(true);
    expect(digest.dataset_ids).toEqual(["D1"]);
  });

  it("is deterministic: the same response gives the same digest and dataset", async () => {
    const a = setup(travelWorld());
    const b = setup(travelWorld());
    const ra = await destinationAffinitySkill.run(input(), a.ctx);
    const rb = await destinationAffinitySkill.run(input(), b.ctx);
    expect(ra.forModel).toEqual(rb.forModel);
    expect(a.ledger.datasets).toEqual(b.ledger.datasets);
  });
});

describe("destination_affinity: unscored, empty, partial and truncated results", () => {
  it("leaves floor ties and rows without an affinity unscored and unplaced, never ranked", async () => {
    const rows = travelWorld();
    rows.push({ id: "ent-dest-13", name: "Quiet Lake", affinity: 0.01, popularity: 0.5 });
    rows.push({ id: "ent-dest-14", name: "Still Point", affinity: 0.01, popularity: 0.4 });
    rows.push({ id: "ent-dest-15", name: "No Score Bay", popularity: 0.3 });
    const run = setup(rows);
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(expect.arrayContaining(["CANDIDATES_UNSCORED", "NOT_SCORED"]));
    const d = quadrant(run);
    expect(d.payload.points.map((p) => p.label)).not.toContain("Quiet Lake");
    expect(d.payload.omitted).toEqual([
      { label: "Quiet Lake", ref: null, reason: "not_scored" },
      { label: "Still Point", ref: null, reason: "not_scored" },
      { label: "No Score Bay", ref: null, reason: "not_scored" },
    ]);
    // FIT ranks the twelve scored rows only.
    expect(run.ledger.metrics.find((m) => m.label.includes("Ridgeview"))?.display).toBe("1.00 · 1 of 12");
    expect(result.forModel.notices).toContain("3 destinations without a score or a popularity are not placed on the quadrant.");
  });

  it("omits a scored destination without a popularity as not measured", async () => {
    const rows = travelWorld();
    rows.push({ id: "ent-dest-16", name: "Unknown Reach", affinity: 0.88, popularity: null });
    const run = setup(rows);
    await destinationAffinitySkill.run(input(), run.ctx);
    expect(quadrant(run).payload.omitted).toEqual([{ label: "Unknown Reach", ref: null, reason: "not_measured" }]);
  });

  it("skips quality-gate artifacts and results outside the US, and says so", async () => {
    const rows = travelWorld();
    rows.push({ id: "ent-dest-17", name: "Artifact Town", affinity: 0.95, popularity: 0.004 });
    rows.push({ id: "ent-dest-18", name: "Far Shore", affinity: 0.93, popularity: 0.7, country: "CA" });
    const run = setup(rows);
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.flags).toContain("QUALITY_GATE_DROPPED");
    expect(run.ledger.evidences[0]?.summary).toBe(
      "14 destinations returned; 12 placed on the quadrant (1 skipped by the quality gate, 1 outside the US left out).",
    );
    expect(quadrant(run).payload.points.map((p) => p.label)).not.toEqual(expect.arrayContaining(["Artifact Town", "Far Shore"]));
    expect(result.forModel.notices).toEqual(
      expect.arrayContaining(["1 destination below the popularity quality gate was skipped.", "1 result outside the US was left out."]),
    );
  });

  it("answers an empty call with EMPTY_RESULT, an empty evidence bundle and no dataset", async () => {
    const run = setup([]);
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("empty");
    expect(result.flags).toEqual(["THIN_RESULT"]);
    expect(run.ledger.evidences[0]).toMatchObject({ status: "empty", skill: "destination_affinity" });
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toHaveLength(0);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["EMPTY_RESULT"]);
    expect(run.ledger.findings[0]?.suggestion?.tool).toBe("destination_affinity");
  });

  it("flags a thin result and places what it has without a hidden pocket", async () => {
    const run = setup(travelWorld().slice(0, 3));
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toContain("THIN_RESULT");
    expect(quadrant(run).payload.points).toHaveLength(3);
  });

  it("returns a partial result with BUDGET_TRUNCATED and nothing in the ledger when the budget refuses the call", async () => {
    const run = setup(travelWorld(), { budget: 0 });
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(result.forModel.notices).toEqual(["The call budget refused the destination call, so travel taste was not measured."]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.metrics).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
  });

  it("lets a failed Qloo call reach the caller, since nothing is in the ledger yet", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, SEED, "artist");
    const failing = fakeQloo({
      insights: () => {
        throw Object.assign(new Error("Qloo unavailable"), { code: "qloo_unavailable" });
      },
    });
    const run = fakeRun(failing.api, registry);
    await expect(destinationAffinitySkill.run(input(), run.ctx)).rejects.toThrow("Qloo unavailable");
  });
});

describe("destination_affinity: estimateCalls and the registry", () => {
  it("costs one call cold, none when the request is cached, and none for an unregistered seed", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, SEED, "artist");
    const cold = fakeProbe(() => false);
    expect(await destinationAffinitySkill.estimateCalls(input(), cold, registry)).toBe(1);
    expect(cold.asked).toEqual([
      {
        path: "/v2/insights",
        params: { "filter.type": "urn:entity:destination", "signal.interests.entities": [SEED.id], "filter.geocode.country_code": "US", take: 50 },
      },
    ]);
    const warm = fakeProbe((path, params: QlooParams) => path === "/v2/insights" && params["filter.type"] === "urn:entity:destination");
    expect(await destinationAffinitySkill.estimateCalls(input(), warm, registry)).toBe(0);
    expect(await destinationAffinitySkill.estimateCalls(input({ seeds: ["R9"] }), cold, registry)).toBe(0);
  });

  it("is the registered skill, with the travel limitations as its method bullets", () => {
    expect(SKILLS.destination_affinity).toBe(destinationAffinitySkill);
    expect(destinationAffinitySkill.mnemonic).toBe("TRVL");
    expect(destinationAffinitySkill.limitations(["BUDGET_TRUNCATED"])).toEqual([...SKILL_LIMITATIONS.destination_affinity]);
  });
});

describe("computeTravelQuadrant", () => {
  it("gives no hidden-pocket score without two distinct popularities, and labels at most eight points", () => {
    const flat = computeTravelQuadrant(
      [0.9, 0.8, 0.7].map((a, i) => destination({ id: `ent-flat-${i}`, name: `Flat ${i}`, affinity: a, popularity: 0.5 })),
    );
    expect(flat.placed).toHaveLength(3);
    expect(flat.score).toEqual([null, null, null]);
    expect(flat.hiddenPockets).toEqual([]);
    expect(flat.belts).toEqual([]);

    const many = computeTravelQuadrant(travelWorld().map(destination));
    expect(labelledRows(many)).toHaveLength(8);
    expect(labelledRows(many)[0]).toBe(1);
  });
});

describe("destination_affinity: the hidden-pocket ceiling (D3)", () => {
  it("never places a destination at popularity 0.85 or more in the hidden-pocket quadrant, however high the median", () => {
    expect(quadrantOf(0.9, 0.84, 0.5, 0.95)).toBe("HIDDEN_POCKET");
    expect(quadrantOf(0.9, 0.85, 0.5, 0.95)).toBe("HEARTLAND");
    expect(quadrantOf(0.9, 0.9, 0.5, 0.95)).toBe("HEARTLAND");
    // Below the fit median the split is unchanged.
    expect(quadrantOf(0.2, 0.9, 0.5, 0.95)).toBe("COLD");
    expect(quadrantOf(0.2, 0.96, 0.5, 0.95)).toBe("MASS");
  });
});
