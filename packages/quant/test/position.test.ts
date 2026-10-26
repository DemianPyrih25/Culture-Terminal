// The Taste Position card from ledger metrics: invented brands and values only (D29).
import { PositionPayload, type DatasetEnvelope, type Metric } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { buildPosition, parsePeerRank, POSITION_AXIS_LABEL, type PositionEntity } from "../src/position";

const WINDOW = { start: "2025-04-01", end: "2025-09-30" };

let next = 0;
function metric(partial: Partial<Metric> & Pick<Metric, "key" | "subjectRefs" | "value">): Metric {
  next += 1;
  return {
    id: `M${next}`,
    label: partial.key,
    reason: partial.value === null ? "not_scored" : null,
    display: partial.value === null ? "" : String(partial.value),
    unit: "score",
    badge: partial.value === null ? "UNAVAILABLE" : "DERIVED",
    formulaId: partial.key === "popularity" ? "popularity" : partial.key,
    evidenceIds: ["E1"],
    n: null,
    conf: null,
    comparator: null,
    window: null,
    ...partial,
  } as Metric;
}

const dataset = (id: string, kind: string, evidenceIds: string[], payload: Record<string, unknown>) =>
  ({ id, kind, title: id, evidenceIds, formulaIds: [], payload }) as unknown as DatasetEnvelope;

const ENTITIES: Record<string, PositionEntity> = {
  R1: { ref: "R1", label: "Brand Alpha", popularity: 0.62 },
  R2: { ref: "R2", label: "Brand Beta", popularity: 0.91 },
  R3: { ref: "R3", label: "Brand Gamma", popularity: 0.4 },
  R4: { ref: "R4", label: "Brand Delta", popularity: null },
};
const entity = (ref: string) => ENTITIES[ref] ?? null;
const SUBJECT = ENTITIES.R1!;

const subsMap = dataset("D1", "Matrix", ["E1"], {
  mode: "similarity",
  rows: ["R1", "R2", "R3", "R4"].map((ref) => ({ key: ref, label: ref, ref, group: null })),
});
const shareGrid = dataset("D2", "Matrix", ["E2", "E3"], { mode: "share", rows: [] });
const momentumStrip = dataset("D3", "Momentum", ["E4"], {});

function fullLedger(): Metric[] {
  return [
    metric({ key: "subs.distinctiveness", subjectRefs: ["R1"], value: 0.31, display: "2 of 4", evidenceIds: ["E1"] }),
    metric({ key: "subs.similarity", subjectRefs: ["R1", "R2"], value: 0.69, evidenceIds: ["E1"], badge: "MEASURED" }),
    metric({ key: "subs.similarity", subjectRefs: ["R1", "R3"], value: 0.44, evidenceIds: ["E1"], badge: "MEASURED" }),
    metric({ key: "popularity", subjectRefs: ["R1"], value: 0.62, display: "0.62", evidenceIds: ["E5"], badge: "MEASURED" }),
    metric({ key: "share.youth_tilt", subjectRefs: ["R1", "24_and_younger"], value: 0.2, display: "+0.20 · rank 2 of 3", evidenceIds: ["E2"] }),
    metric({ key: "share.youth_tilt", subjectRefs: ["R2", "24_and_younger"], value: 0.35, evidenceIds: ["E2"] }),
    metric({ key: "share.youth_tilt", subjectRefs: ["R3", "24_and_younger"], value: -0.1, evidenceIds: ["E2"] }),
    metric({ key: "share.metros_won", subjectRefs: ["R1", "nashville", "austin"], value: 2, display: "wins 2 of 2 · top half in 2 of 2", evidenceIds: ["E3"] }),
    metric({ key: "share.metros_won", subjectRefs: ["R2", "nashville", "austin"], value: 0, display: "wins 0 of 2 · top half in 1 of 2", evidenceIds: ["E3"] }),
    metric({ key: "mom.label", subjectRefs: ["R1"], value: 1, display: "Rising", badge: "STALE", window: WINDOW, evidenceIds: ["E4"] }),
    metric({ key: "mom.delta_26w", subjectRefs: ["R1"], value: 0.05, badge: "STALE", window: WINDOW, evidenceIds: ["E4"] }),
    metric({ key: "mom.delta_26w", subjectRefs: ["R2"], value: 0.08, badge: "STALE", window: WINDOW, evidenceIds: ["E6"] }),
  ];
}

describe("buildPosition", () => {
  it("reads the five axes in order, each with its peer rank, metric and exhibit", () => {
    const metrics = fullLedger();
    const card = buildPosition({ subject: SUBJECT, metrics, datasets: [subsMap, shareGrid, momentumStrip], entity });
    expect(card).not.toBeNull();
    const payload = PositionPayload.parse(card?.payload);
    expect(payload.subject).toEqual({ ref: "R1", label: "Brand Alpha" });
    expect(payload.peerCount).toBe(3);
    expect(payload.axes.map((a) => a.label)).toEqual(Object.values(POSITION_AXIS_LABEL));

    const [distinct, reach, nextGen, metros, momentum] = payload.axes;
    expect(distinct).toMatchObject({ display: "2 of 4", peerRank: { rank: 2, of: 4 }, note: "nearest: Brand Beta", datasetId: "D1", badge: "DERIVED" });
    // Popularity 0.62 against 0.91 and 0.4; the peer without popularity is left out.
    // Notes read as the card prints them: words under the axis label, numbers in the display.
    expect(reach).toMatchObject({ value: 0.62, peerRank: { rank: 2, of: 3 }, badge: "MEASURED", datasetId: "D1", note: "popularity, not fit" });
    expect(nextGen).toMatchObject({ value: 0.2, display: "+0.20", peerRank: { rank: 2, of: 3 }, datasetId: "D2", note: "young minus old" });
    expect(metros).toMatchObject({ display: "wins 2 of 2", peerRank: { rank: 1, of: 2 }, note: "top half in 2 of 2", datasetId: "D2" });
    expect(momentum).toMatchObject({ display: "Rising", badge: "STALE", peerRank: { rank: 2, of: 2 }, datasetId: "D3", note: "Apr–Sep 2025 only" });

    expect(card?.evidenceIds.sort()).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect(card?.formulaIds).toEqual(["subs.distinctiveness", "popularity", "share.youth_tilt", "share.metros_won", "mom.label"]);
  });

  it("marks an axis the run did not measure as UNAVAILABLE, never as a value", () => {
    const metrics = fullLedger().filter((m) => !m.key.startsWith("mom.") && !m.key.startsWith("share."));
    const card = buildPosition({ subject: SUBJECT, metrics, datasets: [subsMap], entity });
    const axes = PositionPayload.parse(card?.payload).axes;
    for (const axis of [axes[2], axes[3], axes[4]]) {
      expect(axis).toMatchObject({ value: null, reason: "not_measured", badge: "UNAVAILABLE", display: "not measured", metricId: null, peerRank: null });
    }
    // Each says what did not run.
    expect(axes.slice(2).map((a) => a.note)).toEqual(["no age reading run", "no market grid run", "no trending read run"]);
  });

  it("names the momentum window in months, across a year too", () => {
    const momentumOver = (window: { start: string; end: string }) => {
      const metrics = [metric({ key: "mom.label", subjectRefs: ["R1"], value: 1, display: "Rising", badge: "STALE", window, evidenceIds: ["E4"] })];
      return PositionPayload.parse(buildPosition({ subject: SUBJECT, metrics, datasets: [], entity })?.payload).axes[4]?.note;
    };
    expect(momentumOver({ start: "2024-11-04", end: "2025-04-28" })).toBe("Nov 2024–Apr 2025 only");
    expect(momentumOver({ start: "2025-06-02", end: "2025-06-30" })).toBe("Jun 2025 only");
  });

  it("keeps a measured gap's reason and falls back to the DNA youth index for next-gen tilt", () => {
    const metrics = [
      metric({ key: "mom.label", subjectRefs: ["R1"], value: null, reason: "no_signal", badge: "UNAVAILABLE", evidenceIds: ["E4"] }),
      metric({ key: "dna.youth_index", subjectRefs: ["R1"], value: 0.12, evidenceIds: ["E7"] }),
      metric({ key: "dna.youth_index", subjectRefs: ["R2"], value: 0.3, evidenceIds: ["E7"] }),
      metric({ key: "dna.youth_index", subjectRefs: ["R2", "R3"], value: 0.5, evidenceIds: ["E7"] }),
    ];
    const card = buildPosition({ subject: SUBJECT, metrics, datasets: [dataset("D9", "Bars", ["E7"], {})], entity });
    const axes = PositionPayload.parse(card?.payload).axes;
    // The averaged peer row (two refs) is not a peer of its own.
    expect(axes[2]).toMatchObject({ value: 0.12, peerRank: { rank: 2, of: 2 }, note: "0 = average", datasetId: "D9" });
    expect(axes[4]).toMatchObject({ value: null, reason: "no_signal", display: "no signal", badge: "UNAVAILABLE", metricId: expect.any(String) });
    expect(card?.payload.peerCount).toBe(1);
  });

  it("never compares tilts from different calls", () => {
    const metrics = [
      metric({ key: "share.youth_tilt", subjectRefs: ["R1"], value: 0.2, evidenceIds: ["E2"] }),
      metric({ key: "share.youth_tilt", subjectRefs: ["R2"], value: 0.9, evidenceIds: ["E8"] }),
    ];
    const card = buildPosition({ subject: SUBJECT, metrics, datasets: [], entity });
    expect(card?.payload.axes[2]).toMatchObject({ value: 0.2, peerRank: null, display: "0.2" });
  });

  it("returns null when no axis has a value", () => {
    expect(buildPosition({ subject: SUBJECT, metrics: [], datasets: [], entity })).toBeNull();
    const gaps = [metric({ key: "subs.distinctiveness", subjectRefs: ["R1"], value: null })];
    expect(buildPosition({ subject: SUBJECT, metrics: gaps, datasets: [], entity })).toBeNull();
  });

  it("shows the figure the KPI strip shows when a run maps the subject twice: the cited one, else the first", () => {
    // The scan's discovery map (six brands, D1) and a later map of the named peers (four brands, D7).
    const metrics = [
      metric({ key: "subs.distinctiveness", subjectRefs: ["R1"], value: 0.4, display: "1 of 6", evidenceIds: ["E1"] }),
      metric({ key: "subs.distinctiveness", subjectRefs: ["R1"], value: 0.3, display: "2 of 4", evidenceIds: ["E7"] }),
    ];
    const datasets = [subsMap, dataset("D7", "Matrix", ["E7"], { mode: "similarity", rows: [] })];
    const first = buildPosition({ subject: SUBJECT, metrics, datasets, entity })?.payload.axes[0];
    expect(first).toMatchObject({ display: "1 of 6", metricId: metrics[0]?.id, datasetId: "D1" });
    const cited = buildPosition({ subject: SUBJECT, metrics, datasets, entity, cited: ["M999", metrics[1]?.id ?? ""] })?.payload.axes[0];
    expect(cited).toMatchObject({ display: "2 of 4", metricId: metrics[1]?.id, datasetId: "D7" });
  });

  it("reads only the subject's own metrics", () => {
    const metrics = [metric({ key: "subs.distinctiveness", subjectRefs: ["R2"], value: 0.5, display: "1 of 4" })];
    expect(buildPosition({ subject: SUBJECT, metrics, datasets: [], entity })).toBeNull();
  });
});

describe("parsePeerRank", () => {
  it("reads k of n and gives a tie the better whole rank", () => {
    expect(parsePeerRank("2 of 7")).toEqual({ rank: 2, of: 7 });
    expect(parsePeerRank("2.5 of 6 · tie")).toEqual({ rank: 2, of: 6 });
    expect(parsePeerRank("0.31")).toBeNull();
    expect(parsePeerRank("8 of 7")).toBeNull();
  });
});
