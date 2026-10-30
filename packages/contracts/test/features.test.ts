// Part 10 contracts: Following, the brand screener, the Category Taste Map and the cost-per-use table.
// Every entity here is invented.
import { describe, expect, it } from "vitest";
import {
  DatasetEnvelope,
  FEATURE_COSTS,
  Feature,
  Follow,
  FollowCreate,
  FollowSetLatest,
  JOB_QLOO_PLAN,
  Job,
  RUN_QUEUE_DEFAULTS,
  SCREENER_COLUMN_FORMULA,
  ScreenerAnswer,
  ScreenerCell,
  ScreenerColumn,
  ScreenerRequest,
  type ScreenerResult,
  TASTE_MAP_MAX_K,
  TasteMapPayload,
  brandFollowQuestion,
  followSubjectKey,
  vizFor,
} from "../src/index";

const point = (key: string, x: number, y: number, target = false) => ({ key, label: key, ref: null, x, y, hub: null, target });

const map = {
  source: "substitution_map" as const,
  points: [point("a", 0, 0, true), point("b", 1, 0), point("c", 0, 1)],
  k: 3,
  stress: 0.04,
  explained: 0.92,
  imputedPairs: [["b", "c"]] as [string, string][],
  omitted: [],
  method: "Classical MDS of 1 − taste similarity; nearby means similar audience taste; axes have no meaning.",
};

describe("Following", () => {
  it("keys a subject the same however it is written", () => {
    expect(followSubjectKey("brand", "  Juniper   Cola ")).toBe("brand:juniper cola");
    expect(followSubjectKey("place", "austin", "East Riverside")).toBe("place:austin:east riverside");
    expect(() => followSubjectKey("question", "  ")).toThrow(RangeError);
  });

  it("accepts a follow from a note or a profile, never a client-made key", () => {
    expect(FollowCreate.parse({ from: "run", runId: "0b7c1f2e-run", kind: "question" })).toMatchObject({ from: "run" });
    expect(FollowCreate.parse({ from: "profile", name: "Juniper Cola" })).toMatchObject({ from: "profile" });
    expect(FollowCreate.safeParse({ from: "run", runId: "x", kind: "brand" }).success).toBe(false);
    expect(FollowSetLatest.safeParse({ id: "f1", runId: "0b7c1f2e-run" }).success).toBe(true);
    expect(brandFollowQuestion(" Juniper Cola ")).toContain("Juniper Cola's");
  });

  it("parses a listed follow with and without a latest note", () => {
    const base = {
      id: "f1",
      kind: "brand",
      subjectKey: "brand:juniper cola",
      label: "Juniper Cola",
      rerun: { question: brandFollowQuestion("Juniper Cola"), job: "brand_health", metro: null },
      latest: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    };
    expect(Follow.parse(base).latest).toBeNull();
    const latest = { runId: "0b7c1f2e-run", status: "completed", createdAt: base.createdAt, headline: "A taste island", tag: "Taste island", signal: "mixed" };
    expect(Follow.parse({ ...base, latest }).latest?.tag).toBe("Taste island");
  });
});

describe("Run queue", () => {
  it("defaults to D24: 6 at once, 12 waiting, 120 s", () => {
    expect(RUN_QUEUE_DEFAULTS).toEqual({ maxActive: 6, queueMax: 12, waitS: 120 });
  });
});

describe("Category Taste Map", () => {
  it("renders with its own figure and rides in a dataset envelope", () => {
    expect(vizFor("TasteMap")).toBe("TasteMap");
    const d = DatasetEnvelope.parse({ id: "D4", title: "Taste map", evidenceIds: ["E1"], formulaIds: ["taste_map_mds"], kind: "TasteMap", payload: map });
    expect(d.kind).toBe("TasteMap");
  });

  it("rejects a k that disagrees with the points, duplicate keys, two targets and stray imputed pairs", () => {
    expect(TasteMapPayload.safeParse({ ...map, k: 4 }).success).toBe(false);
    expect(TasteMapPayload.safeParse({ ...map, points: [...map.points.slice(0, 2), point("a", 2, 2)] }).success).toBe(false);
    expect(TasteMapPayload.safeParse({ ...map, points: [point("a", 0, 0, true), point("b", 1, 0, true), point("c", 0, 1)] }).success).toBe(false);
    expect(TasteMapPayload.safeParse({ ...map, imputedPairs: [["a", "z"]] }).success).toBe(false);
    const many = Array.from({ length: TASTE_MAP_MAX_K + 1 }, (_, i) => point(`p${i}`, i, 0));
    expect(TasteMapPayload.safeParse({ ...map, points: many, k: many.length, imputedPairs: [] }).success).toBe(false);
  });
});

describe("Brand screener", () => {
  const ok = { status: "ok", value: 0.8, reason: null, display: "0.80", requestIds: ["Q2"] };
  const missing = { status: "unavailable", value: null, reason: "not_measured", display: null, requestIds: [] };
  const cells = Object.fromEntries(ScreenerColumn.options.map((c) => [c, c === "distinctiveness" ? missing : ok]));
  const screen: ScreenerResult = {
    seed: { by: "tag", label: "Craft soda" },
    markets: [],
    columns: ScreenerColumn.options.map((key) => ({ key, label: key, formulaId: SCREENER_COLUMN_FORMULA[key], unit: "pct", badge: "MEASURED" })),
    rows: [{ key: "r1", rank: 1, label: "Juniper Cola", disambiguation: null, flags: ["UTR"], cells: cells as ScreenerResult["rows"][number]["cells"] }],
    requests: [
      {
        id: "Q2",
        purpose: "scoring",
        context: null,
        request: { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand" } },
        requestId: "req-invented-2",
        cache: "miss",
        fetchedAt: "2026-10-01T10:00:00.000Z",
        rows: 20,
        error: null,
      },
    ],
    map: null,
    limitations: ["Taste fit within this set, not sales or share."],
    mode: "live",
    qloo: { network: 6, cached: 0 },
    createdAt: "2026-10-01T10:00:00.000Z",
  };

  it("defaults a request and caps its markets at four", () => {
    expect(ScreenerRequest.parse({ seed: { by: "brand", name: "Juniper Cola" } })).toMatchObject({ markets: [], rows: 20, map: false });
    expect(ScreenerRequest.safeParse({ seed: { by: "tag", query: "craft soda" }, markets: ["a1", "b1", "c1", "d1", "e1"] }).success).toBe(false);
  });

  it("never lets an unavailable cell carry a number, nor an ok cell lack its request", () => {
    expect(ScreenerCell.safeParse({ ...missing, value: 0 }).success).toBe(false);
    expect(ScreenerCell.safeParse({ ...ok, requestIds: [] }).success).toBe(false);
  });

  it("accepts a screen whose cells cite its own requests, and rejects one that cites another's", () => {
    expect(ScreenerAnswer.parse({ kind: "ok", screen }).kind).toBe("ok");
    const stray = { ...screen, rows: [{ ...screen.rows[0]!, cells: { ...screen.rows[0]!.cells, fit: { ...ok, requestIds: ["Q9"] } } }] };
    expect(ScreenerAnswer.safeParse({ kind: "ok", screen: stray }).success).toBe(false);
  });
});

describe("Cost per use", () => {
  it("has an entry for every Part 10 feature and every job", () => {
    expect(Object.keys(FEATURE_COSTS).sort()).toEqual([...Feature].sort());
    expect(Object.keys(JOB_QLOO_PLAN).sort()).toEqual([...Job.options].sort());
  });

  it("keeps the screener and taste-map figures inside their call plans", () => {
    const screener = FEATURE_COSTS.screener;
    const map = FEATURE_COSTS.taste_map_screener;
    if (screener.basis !== "plan" || map.basis !== "plan") throw new Error("expected plan figures");
    expect(screener.qlooCold).toEqual({ min: 5, max: 9 }); // lookup 1 + discovery 1 + ages 3 + markets ≤ 4
    expect(map.qlooCold.max).toBe(TASTE_MAP_MAX_K - 1);
    for (const cost of Object.values(FEATURE_COSTS)) {
      if (cost.basis !== "plan") continue;
      expect(cost.qlooCold.min).toBeLessThanOrEqual(cost.qlooCold.max);
      expect(cost.qlooWarm.max).toBeLessThanOrEqual(cost.qlooCold.max);
    }
  });
});
