// The brand screener's compute (PLAN §5.5) on invented brands: FIT from one scoring call, the seed's
// own FIT marked self, youth tilt and metro breadth through the S2 helpers, UNDER-THE-RADAR against the
// set's medians, distinctiveness only from a whole taste map, and every absence a reason, never 0.
import { ScreenerRow, type QlooCallMeta, type QlooEntity, type ScreenerRequestId } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  categoryPath,
  classifyCategoryTags,
  computeScreener,
  screenerAgeSpecs,
  screenerMapMembers,
  screenerMapPlan,
  type ScreenerCandidate,
  type ScreenerContextCall,
  type ScreenerResponse,
} from "../src/screener";
import { metroContext } from "../src/skills/rankCandidates/contexts";

const meta = (n: number): QlooCallMeta => ({
  qlooCallId: `call-${n}`,
  requestId: `req-${n}`,
  cache: "miss",
  fetchedAt: "2026-10-28T10:00:00.000Z",
  ms: 5,
  stale: false,
  originRunId: null,
});

const NAMES = ["Juniper Cola", "Kestrel Tonic", "Larkspur Soda", "Moraine Fizz", "Nimbus Pop"];
const POP = [0.9, 0.3, 0.6, 0.2, 0.7];

function cands(seed = false): ScreenerCandidate[] {
  return NAMES.map((label, j) => ({
    key: `b${j + 1}`,
    label,
    disambiguation: null,
    entityId: `ent-${j}`,
    popularity: POP[j] ?? null,
    popularityFrom: "Q2",
    seed: seed && j === 0,
  }));
}

/** One response scoring the given ids (affinity null drops the row from the response). */
function scored(id: ScreenerRequestId, n: number, scores: readonly (number | null)[]): ScreenerResponse {
  const entities: QlooEntity[] = scores.flatMap((a, j) => (a === null ? [] : [{ entity_id: `ent-${j}`, name: NAMES[j] ?? "", query: { affinity: a } }]));
  return { kind: "ok", id, entities, meta: meta(n) };
}

function ages(rows: readonly (readonly number[])[]): ScreenerContextCall[] {
  return screenerAgeSpecs().map((spec, i) => ({ spec, response: scored(`Q${4 + i}` as ScreenerRequestId, 4 + i, rows[i] ?? []) }));
}

const AGES_FLAT = ages([
  [0.51, 0.62, 0.73, 0.84, 0.95],
  [0.52, 0.63, 0.74, 0.85, 0.96],
  [0.97, 0.86, 0.75, 0.64, 0.53],
]);

describe("computeScreener", () => {
  it("ranks by FIT from the one scoring call, and every row satisfies the contract", () => {
    const out = computeScreener({
      candidates: cands(),
      fit: scored("Q3", 3, [0.4, 0.9, 0.6, 0.8, 0.5]),
      ages: AGES_FLAT,
      markets: [],
      map: null,
    });
    expect(out.rows.map((r) => r.label)).toEqual(["Kestrel Tonic", "Moraine Fizz", "Larkspur Soda", "Nimbus Pop", "Juniper Cola"]);
    expect(out.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(out.rows[0]?.cells.fit).toEqual({ status: "ok", value: 1, reason: null, display: "1.00", requestIds: ["Q3"] });
    expect(out.rows[4]?.cells.fit.value).toBe(0);
    for (const row of out.rows) {
      expect(ScreenerRow.safeParse(row).success).toBe(true);
      // No market and no map asked: not measured, citing nothing, never 0.
      expect(row.cells.metro_breadth).toMatchObject({ status: "unavailable", value: null, reason: "not_measured", requestIds: [] });
      expect(row.cells.distinctiveness).toMatchObject({ status: "unavailable", reason: "not_measured" });
      expect(row.cells.popularity.requestIds).toEqual(["Q2"]);
    }
  });

  it("youth tilt reads the two young buckets against the old one", () => {
    const out = computeScreener({ candidates: cands(), fit: scored("Q3", 3, [0.4, 0.9, 0.6, 0.8, 0.5]), ages: AGES_FLAT, markets: [], map: null });
    const tilt = Object.fromEntries(out.rows.map((r) => [r.label, r.cells.next_gen_tilt]));
    expect(tilt["Nimbus Pop"]).toMatchObject({ status: "ok", value: 1, display: "+1.00", requestIds: ["Q4", "Q5", "Q6"] });
    expect(tilt["Juniper Cola"]).toMatchObject({ value: -1, display: "-1.00" });
    expect(tilt["Larkspur Soda"]?.value).toBe(0);
  });

  it("marks the seed's FIT as self and keeps its other columns", () => {
    const out = computeScreener({ candidates: cands(true), fit: scored("Q2", 2, [null, 0.9, 0.6, 0.8, 0.5]), ages: AGES_FLAT, markets: [], map: null });
    const seed = out.rows.find((r) => r.flags.includes("SEED"));
    expect(seed?.cells.fit).toMatchObject({ status: "unavailable", reason: "self", requestIds: ["Q2"] });
    expect(seed?.cells.under_the_radar).toMatchObject({ status: "unavailable", reason: "self" });
    expect(seed?.cells.popularity).toMatchObject({ status: "ok", value: 0.9 });
    expect(seed?.rank).toBe(5);
    expect(out.notes).toEqual([]);
  });

  it("leaves floor ties and dropped brands unscored, with their reasons", () => {
    const out = computeScreener({ candidates: cands(), fit: scored("Q3", 3, [0.0213, 0.9, 0.0213, 0.8, null]), ages: AGES_FLAT, markets: [], map: null });
    const fit = Object.fromEntries(out.rows.map((r) => [r.label, r.cells.fit]));
    expect(fit["Juniper Cola"]).toMatchObject({ status: "unavailable", value: null, reason: "not_scored", requestIds: ["Q3"] });
    expect(fit["Nimbus Pop"]).toMatchObject({ reason: "dropped" });
    expect(out.rows.slice(0, 2).map((r) => r.label)).toEqual(["Kestrel Tonic", "Moraine Fizz"]);
    expect(out.notes[0]).toMatch(/^3 of 5 brands were not scored/);
  });

  it("flags UNDER-THE-RADAR: fit at or above the median, popularity below the median", () => {
    const out = computeScreener({ candidates: cands(), fit: scored("Q3", 3, [0.4, 0.9, 0.6, 0.8, 0.5]), ages: AGES_FLAT, markets: [], map: null });
    const flagged = out.rows.filter((r) => r.flags.includes("UTR")).map((r) => r.label);
    // FIT median 0.5 (Larkspur), popularity median 0.6: Kestrel (fit 1, pop 0.3) and Moraine (0.75, 0.2).
    expect(flagged).toEqual(["Kestrel Tonic", "Moraine Fizz"]);
    const kestrel = out.rows[0]!.cells.under_the_radar;
    expect(kestrel).toMatchObject({ status: "ok", display: "+0.70", requestIds: ["Q3", "Q2"] });
  });

  it("counts metro breadth over the markets that ranked, and a failed market is a cited gap", () => {
    const env = { localities: { market: async () => null }, geo: null };
    const pin = { entityId: "loc-x", label: "Rivertown" };
    const markets: ScreenerContextCall[] = [
      { spec: metroContext("rivertown", pin, env), response: scored("Q7", 7, [0.1, 0.9, 0.5, 0.3, 0.7]) },
      { spec: metroContext("lakeport", { entityId: "loc-y", label: "Lakeport" }, env), response: scored("Q8", 8, [0.2, 0.8, 0.9, 0.15, 0.3]) },
    ];
    const out = computeScreener({ candidates: cands(), fit: scored("Q3", 3, [0.4, 0.9, 0.6, 0.8, 0.5]), ages: AGES_FLAT, markets, map: null });
    const breadth = Object.fromEntries(out.rows.map((r) => [r.label, r.cells.metro_breadth]));
    expect(breadth["Kestrel Tonic"]).toMatchObject({ status: "ok", value: 2, display: "top half in 2 of 2 · first in 1", requestIds: ["Q7", "Q8"] });
    expect(breadth["Juniper Cola"]).toMatchObject({ value: 0, display: "top half in 0 of 2" });

    const failed = computeScreener({
      candidates: cands(),
      fit: scored("Q3", 3, [0.4, 0.9, 0.6, 0.8, 0.5]),
      ages: AGES_FLAT,
      markets: [{ spec: markets[0]!.spec, response: { kind: "gap", id: "Q7", reason: "error" } }],
      map: null,
    });
    expect(failed.rows[0]?.cells.metro_breadth).toMatchObject({ status: "unavailable", reason: "error", requestIds: ["Q7"] });
  });

  it("measures distinctiveness from a whole taste map, and none from an incomplete one", () => {
    const candidates = cands().slice(0, 4);
    const members = screenerMapMembers(candidates, [0.2, 1, 0.5, 0.8]);
    expect(members).toEqual([1, 3, 2, 0]);
    expect(screenerMapPlan(members.map((j) => `ent-${j}`))).toHaveLength(3);
    // sim over members [Kestrel, Moraine, Larkspur, Juniper]: Kestrel–Moraine 0.8, the rest lower.
    const row = (id: ScreenerRequestId, n: number, pairs: [number, number][]): ScreenerResponse => ({
      kind: "ok",
      id,
      meta: meta(n),
      entities: pairs.map(([j, a]) => ({ entity_id: `ent-${j}`, name: NAMES[j] ?? "", query: { affinity: a } })),
    });
    const responses = [
      row("Q9", 9, [[3, 0.8], [2, 0.3], [0, 0.4]]),
      row("Q10", 10, [[2, 0.5], [0, 0.2]]),
      row("Q11", 11, [[0, 0.6]]),
    ];
    const fit = scored("Q3", 3, [0.4, 0.9, 0.6, 0.8]);
    const out = computeScreener({ candidates, fit, ages: [], markets: [], map: { members, responses } });
    const d = Object.fromEntries(out.rows.map((r) => [r.label, r.cells.distinctiveness]));
    expect(d["Kestrel Tonic"]).toMatchObject({ status: "ok", requestIds: ["Q9", "Q10", "Q11"] });
    expect(d["Kestrel Tonic"]?.value).toBeCloseTo(0.2);
    expect(d["Larkspur Soda"]?.value).toBeCloseTo(0.4);
    expect(d["Larkspur Soda"]?.display).toBe("0.40 · 1 of 4");
    expect(out.map).toMatchObject({ source: "screener", complete: true, requestIds: ["Q9", "Q10", "Q11"] });
    expect(out.map?.members.map((m) => m.label)).toEqual(["Kestrel Tonic", "Moraine Fizz", "Larkspur Soda", "Juniper Cola"]);
    // No age call: next-gen tilt is unavailable, never 0.
    expect(out.rows[0]?.cells.next_gen_tilt).toMatchObject({ status: "unavailable", value: null });

    const partial = computeScreener({
      candidates,
      fit,
      ages: [],
      markets: [],
      map: { members, responses: [responses[0]!, { kind: "gap", id: "Q10", reason: "error" }, responses[2]!] },
    });
    expect(partial.rows.every((r) => r.cells.distinctiveness.status === "unavailable")).toBe(true);
    expect(partial.rows[0]?.cells.distinctiveness.reason).toBe("error");
    expect(partial.map?.complete).toBe(false);
    expect(partial.notes.join(" ")).toMatch(/Distinctiveness is not measured/);
  });
});

describe("classifyCategoryTags", () => {
  const tag = (id: string, name: string) => ({ id, name, type: "urn:tag:genre:brand" });
  it("applies only genre:brand tags named exactly as asked, and offers the rest", () => {
    const items = [
      { id: "urn:tag:product_category:qloo:sparkling_tea", name: "Sparkling Tea", type: "urn:tag:product_category:qloo" },
      tag("urn:tag:genre:brand:beverage:sparkling_tea", "Sparkling Tea"),
      tag("urn:tag:genre:brand:beverage:iced_tea", "Iced Tea"),
      tag("urn:tag:genre:brand:beverage:sparkling_tea", "Sparkling Tea"),
    ];
    const { exact, others } = classifyCategoryTags("  sparkling TEA ", items);
    expect(exact.map((t) => t.id)).toEqual(["urn:tag:genre:brand:beverage:sparkling_tea"]);
    expect(others.map((t) => t.name)).toEqual(["Iced Tea"]);
    expect(classifyCategoryTags("Sparkling Teas", items).exact).toEqual([]);
    expect(categoryPath("urn:tag:genre:brand:beverage:sparkling_tea")).toBe("beverage");
    expect(categoryPath("urn:tag:genre:brand:beverage")).toBeNull();
  });
});
