// The KPI strip per job, picked by metric key. Invented refs and values only (D29).
import { Job, type Metric } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { KPI_SLOTS, pickKpis } from "../../src/report/kpis";

let next = 0;
function metric(key: string, value: number | null, subjectRefs: string[], extra: Partial<Metric> = {}): Metric {
  next += 1;
  return {
    id: `M${next}`,
    key,
    label: `${key} ${subjectRefs.join(" ")}`,
    subjectRefs,
    value,
    reason: value === null ? "not_scored" : null,
    display: value === null ? "not measured" : String(value),
    unit: "score",
    badge: value === null ? "UNAVAILABLE" : "DERIVED",
    formulaId: key,
    evidenceIds: ["E1"],
    n: null,
    conf: null,
    comparator: null,
    window: null,
    ...extra,
  } as Metric;
}

const ids = (strip: { metricId: string }[]) => strip.map((k) => k.metricId);

describe("KPI_SLOTS", () => {
  it("gives every job a strip of key figures", () => {
    for (const job of Job.options) expect(KPI_SLOTS[job].length, job).toBeGreaterThan(0);
  });
});

describe("pickKpis", () => {
  it("prefers cited metrics, then the subject's own, then ledger order", () => {
    const peer = metric("share.youth_tilt", 0.4, ["R2"]);
    const own = metric("share.youth_tilt", 0.1, ["R1"]);
    expect(ids(pickKpis("brand_health", [peer, own], []))).toEqual([peer.id]);
    expect(ids(pickKpis("brand_health", [peer, own], [], { subject: "R1" }))).toEqual([own.id]);
    expect(ids(pickKpis("brand_health", [peer, own], [peer.id], { subject: "R1" }))).toEqual([peer.id]);
  });

  it("leads head_to_head with the pair's similarity, not the subject's nearest audience", () => {
    // The Substitution Map's nearest peer is a discovered brand (R3); the duel is R1 against R2.
    const nearest = metric("subs.similarity", 0.82, ["R1", "R3"]);
    const pair = metric("subs.similarity", 0.41, ["R1", "R2"]);
    const fit = metric("rank.fit", 0.7, ["R2", "austin"]);
    const focus = { subject: "R1" as const, peers: ["R2" as const] };
    expect(ids(pickKpis("head_to_head", [nearest, pair, fit], [], focus))).toEqual([pair.id]);
    expect(ids(pickKpis("head_to_head", [nearest, pair, fit], [nearest.id], focus))).toEqual([pair.id]);
    // Either order of the pair counts; brand_health keeps the nearest audience.
    const reversed = metric("subs.similarity", 0.41, ["R2", "R1"]);
    expect(ids(pickKpis("head_to_head", [nearest, reversed], [], focus))).toEqual([reversed.id]);
    expect(ids(pickKpis("brand_health", [nearest, pair], [], focus))).toEqual([nearest.id]);
    // Without a pair similarity the slot falls back to the pair's fit, never to the nearest audience.
    expect(ids(pickKpis("head_to_head", [nearest, fit], [], focus))).toEqual([fit.id]);
    expect(ids(pickKpis("head_to_head", [nearest, pair, fit], [], { subject: "R1" }))).toEqual([fit.id]);
  });

  it("ranks a top slot by value: the three highest lifts, then the map's precision", () => {
    const lifts = [0.9, 1.6, 1.2, 2.1, 0.4].map((v, i) => metric("lift.area", v, [`area_${i}`], { formulaId: "lift.area" }));
    const precision = metric("lift.precision", 0.8, ["austin"], { formulaId: "lift.confidence" });
    const confidence = metric("lift.confidence", 0.9, ["area_3"], { formulaId: "lift.confidence" });
    expect(ids(pickKpis("site_selection", [...lifts, confidence, precision], []))).toEqual([lifts[3]!.id, lifts[1]!.id, lifts[2]!.id, precision.id]);
  });

  it("tells the slate's best fits from its other fits by formula", () => {
    const anyFit = metric("slate.fit", 0.95, ["R4", "R1"], { formulaId: "pct.within_call" });
    const best = metric("slate.fit", 0.7, ["R5", "R1"], { formulaId: "slate.best_fit" });
    const utr = metric("slate.utr_count", 1, ["R1"], { formulaId: "slate.under_the_radar" });
    expect(ids(pickKpis("sponsorship", [anyFit, best, utr], []))).toEqual([best.id, utr.id]);
  });

  it("reads market_selection's top markets from market contexts only", () => {
    const age = metric("share.pct", 0.99, ["R1", "24_and_younger"]);
    const audience = metric("share.pct", 0.98, ["R1", "urn:audience:leisure:synthetic_one"]);
    const denver = metric("share.pct", 0.6, ["R1", "denver"]);
    const boise = metric("share.pct", 0.8, ["R1", "boise"]);
    const won = metric("share.metros_won", 2, ["R1", "denver", "boise"]);
    expect(ids(pickKpis("market_selection", [age, audience, denver, boise, won], []))).toEqual([won.id, boise.id, denver.id]);
  });

  it("skips metrics without a value and falls back to cited metrics when no slot matches", () => {
    const gap = metric("subs.similarity", null, ["R1", "R2"]);
    const cited = metric("xdom.fit", 0.5, ["R7"]);
    expect(ids(pickKpis("brand_health", [gap, cited], [cited.id]))).toEqual([cited.id]);
  });
});
