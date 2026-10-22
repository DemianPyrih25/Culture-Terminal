import { describe, expect, it } from "vitest";
import {
  BarsPayload,
  DATASET_PAYLOADS,
  DatasetEnvelope,
  DatasetKind,
  Evidence,
  isTaxonomyTag,
  MatrixPayload,
  Metric,
  MomentumSeries,
  PositionPayload,
  ValueCell,
  VIZ_COMPAT,
  VizComponent,
  vizFor,
  type PositionAxisRow,
} from "../src/index";
import { evidence, matrixDataset, metric, staleMetric, unavailableMetric } from "./fixtures";

describe("VIZ_COMPAT", () => {
  it("covers every dataset kind with a frozen component name", () => {
    expect(Object.keys(VIZ_COMPAT).sort()).toEqual([...DatasetKind.options].sort());
    for (const kind of DatasetKind.options) expect(VizComponent.options).toContain(vizFor(kind));
    expect(new Set(Object.values(VIZ_COMPAT))).toEqual(new Set(VizComponent.options));
    expect(VIZ_COMPAT.Slate).toBe("RankedTable");
    expect(VIZ_COMPAT.GeoLift).toBe("LiftMap");
  });

  it("has a payload schema for every dataset kind", () => {
    expect(Object.keys(DATASET_PAYLOADS).sort()).toEqual([...DatasetKind.options].sort());
  });
});

describe("UNAVAILABLE is never 0", () => {
  it("requires a reason exactly when the value is missing", () => {
    expect(ValueCell.safeParse({ value: 0, reason: null }).success).toBe(true);
    expect(ValueCell.safeParse({ value: null, reason: "not_scored" }).success).toBe(true);
    expect(ValueCell.safeParse({ value: null, reason: null }).success).toBe(false);
    expect(ValueCell.safeParse({ value: 0, reason: "dropped" }).success).toBe(false);
  });

  it("ties a metric's null value to the UNAVAILABLE badge and a STALE badge to its window", () => {
    expect(Metric.safeParse(metric).success).toBe(true);
    expect(Metric.safeParse(staleMetric).success).toBe(true);
    expect(Metric.safeParse(unavailableMetric).success).toBe(true);
    expect(Metric.safeParse({ ...unavailableMetric, value: 0 }).success).toBe(false);
    expect(Metric.safeParse({ ...metric, value: null, reason: "error" }).success).toBe(false);
    expect(Metric.safeParse({ ...staleMetric, window: null }).success).toBe(false);
  });
});

describe("dataset payloads", () => {
  it("parses the matrix fixture and checks its dimensions", () => {
    expect(DatasetEnvelope.parse(matrixDataset)).toEqual(matrixDataset);
    if (matrixDataset.kind !== "Matrix") throw new Error("fixture");
    const ragged = { ...matrixDataset.payload, cells: [matrixDataset.payload.cells[0]!] };
    expect(MatrixPayload.safeParse(ragged).success).toBe(false);
  });

  it("requires a comparator on bars and one value per series", () => {
    const bars = {
      mode: "diverging",
      comparator: "CITY",
      valueLabel: "rank Δ vs city",
      unit: "delta",
      series: [{ key: "area", label: "Marlowe Ridge", ref: null, group: null }],
      groups: [
        {
          key: "WHAT",
          label: "WHAT",
          family: "WHAT",
          bars: [
            { key: "t1", label: "listening room", tagRef: "T1", values: [{ value: 18, reason: null }], isNew: true, ranks: { subject: 4, comparator: null } },
          ],
        },
      ],
      method: "POINT",
      domain: null,
      caption: null,
    };
    expect(BarsPayload.safeParse(bars).success).toBe(true);
    expect(BarsPayload.safeParse({ ...bars, comparator: null }).success).toBe(false);
    expect(BarsPayload.safeParse({ ...bars, mode: "butterfly" }).success).toBe(false);
  });

  it("models NO SIGNAL momentum without a trend", () => {
    const series = {
      ref: "R1",
      label: "Juniper Cola",
      type: "brand",
      state: "no_signal",
      reason: "no_signal",
      trend: null,
      points: [],
      delta26w: null,
      tau: null,
      p: null,
      peerRank: null,
      scaleBreak: false,
    };
    expect(MomentumSeries.safeParse(series).success).toBe(true);
    expect(MomentumSeries.safeParse({ ...series, trend: "flat" }).success).toBe(false);
    expect(MomentumSeries.safeParse({ ...series, reason: null }).success).toBe(false);
  });

  it("requires the five position axes in order", () => {
    const axis = (axis: PositionAxisRow["axis"]): PositionAxisRow => ({
      axis,
      label: axis,
      display: "2 of 7",
      value: 2,
      reason: null,
      badge: "MEASURED",
      peerRank: { rank: 2, of: 7 },
      note: null,
      metricId: "M1",
      datasetId: "D1",
    });
    const axes = (["distinctiveness", "reach", "next_gen_tilt", "metro_breadth", "momentum"] as const).map(axis);
    const card = { subject: { ref: "R1", label: "Juniper Cola" }, peerCount: 6, axes };
    expect(PositionPayload.safeParse(card).success).toBe(true);
    expect(PositionPayload.safeParse({ ...card, axes: [...axes].reverse() }).success).toBe(false);
    const unavailable = { ...axes[4]!, value: null, reason: "unavailable" as const, display: "not measured" };
    expect(PositionPayload.safeParse({ ...card, axes: [...axes.slice(0, 4), unavailable] }).success).toBe(false);
    expect(
      PositionPayload.safeParse({ ...card, axes: [...axes.slice(0, 4), { ...unavailable, badge: "UNAVAILABLE" }] }).success,
    ).toBe(true);
  });
});

describe("ledger", () => {
  it("keeps call ids, request ids and provenance aligned", () => {
    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(Evidence.safeParse({ ...evidence, requestIds: ["req-fixture-1"] }).success).toBe(false);
  });

  it("recognises taxonomy tags as the only signal tags", () => {
    expect(isTaxonomyTag("urn:tag:genre:place:restaurant")).toBe(true);
    expect(isTaxonomyTag("urn:tag:category:place:cafe")).toBe(true);
    expect(isTaxonomyTag("urn:tag:product_category:qloo:sparkling_water")).toBe(false);
    expect(isTaxonomyTag("urn:tag:genre:qloo:anything")).toBe(false);
  });
});
