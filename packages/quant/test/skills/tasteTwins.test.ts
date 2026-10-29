// taste_twins over a scripted Qloo: a planted twin among invented areas (D29). Both cities share one
// city tag list; the source area reorders it one way, the planted twin the same way, the others
// differently, so the twin must come out on top with ρ = 1 and TWIN_FOUND must name it.
import {
  DatasetEnvelope,
  digestFits,
  Metric,
  ModelDigest,
  type GeoApi,
  type InsightsFilterType,
  type InsightsResponse,
  type LocalityApi,
  type Neighbourhood,
  type QlooApi,
  type QlooParams,
  type QlooResult,
  type QlooTagInsightRow,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { isFormulaId } from "../../src/formulas";
import { tasteTwinsSkill } from "../../src/skills/tasteTwins";
import { largestAreas, topLiftAreas, twinScore, TWIN_MIN_TAGS } from "../../src/skills/tasteTwins/twins";
import { compareLists, rankTagRows } from "../../src/skills/blockDna/fingerprint";
import { fakeProbe, fakeRun, FakeRegistry, FETCHED_AT } from "./support/fakes";

const TAGS = Array.from({ length: 30 }, (_, i) => `urn:tag:genre:place:invented_${String(i).padStart(2, "0")}`);

function rows(order: readonly string[]): QlooTagInsightRow[] {
  return order.map((id, i) => ({ tag_id: id, name: id.split(":").pop() ?? id, subtype: "urn:tag:genre:place", query: { affinity: 0.9 - i * 0.01 } }));
}

/** A deterministic reshuffle: the city order with chosen tags lifted to the top. */
function lifted(top: readonly number[]): string[] {
  const head = top.map((i) => TAGS[i] as string);
  return [...head, ...TAGS.filter((t) => !head.includes(t))];
}

const SOURCE_ORDER = lifted([20, 25, 3, 17, 29]);
const AREA_ORDERS: Record<string, string[]> = {
  lakeview: lifted([20, 25, 3, 17, 29]), // the planted twin
  hillcrest: lifted([1, 2, 4, 5, 6]),
  milltown: lifted([10, 11, 12, 13, 14]),
  oldport: lifted([27, 8, 9, 0, 22]),
};

const WKT_INDEX = ["riverside", "lakeview", "hillcrest", "milltown", "oldport"];
const wkt = (id: string) => `POLYGON((0 0,1 0,1 1,0 ${WKT_INDEX.indexOf(id) + 2},0 0))`;
const area = (id: string, metro: "nashville" | "austin", km2: number): Neighbourhood => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  metro,
  centroid: { lat: 30, lon: -97 },
  areaKm2: km2,
});
const SOURCE = area("riverside", "nashville", 5);
const TARGETS = [area("lakeview", "austin", 9), area("hillcrest", "austin", 8), area("milltown", "austin", 7), area("oldport", "austin", 6)];

const GEO: GeoApi = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: (m) => (m === "nashville" ? [SOURCE] : m === "austin" ? TARGETS : []),
  neighbourhood: (m, id) => [SOURCE, ...TARGETS].find((a) => a.metro === m && a.id === id) ?? null,
  matchNeighbourhood: () => null,
  polygonWkt: (_, id) => wkt(id),
  locate: () => null,
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "Invented test gazetteer",
};
const PINS: LocalityApi = { market: async (m) => ({ entityId: `loc-invented-${m}`, label: m }) };

function scriptedQloo(): { api: QlooApi; calls: QlooParams[] } {
  const calls: QlooParams[] = [];
  const byWkt = new Map([[wkt(SOURCE.id), SOURCE_ORDER], ...TARGETS.map((t) => [wkt(t.id), AREA_ORDERS[t.id] ?? TAGS] as const)]);
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const api: QlooApi = {
    insights: async <F extends InsightsFilterType>(_f: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      calls.push(params);
      const loc = String(params["signal.location"]);
      const order = loc.startsWith("loc-") ? TAGS : (byWkt.get(loc) ?? []);
      return {
        data: { results: { tags: rows(order) } } as unknown as InsightsResponse<F>,
        meta: { qlooCallId: `qc-${calls.length}`, requestId: `req-${calls.length}`, cache: "miss", fetchedAt: FETCHED_AT, ms: 1, stale: false, originRunId: null },
      };
    },
    search: unused,
    entities: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
  };
  return { api, calls };
}

function input(fields: Record<string, unknown> = {}) {
  return tasteTwinsSkill.input.parse({
    source: { kind: "nbhd", ref: "riverside", metro: "nashville" },
    target_metro: "austin",
    target_areas: [],
    concept_tags: [],
    trigger_finding_id: null,
    step_id: "S1",
    ...fields,
  });
}

function setup() {
  const q = scriptedQloo();
  const run = fakeRun(q.api, new FakeRegistry());
  return { ...run, calls: q.calls, ctx: { ...run.ctx, geo: GEO, localities: PINS, pillar: "location" as const } };
}

describe("twinScore", () => {
  const city = rankTagRows(rows(TAGS), ["WHAT"]);
  const cmp = (order: readonly string[]) => compareLists(rankTagRows(rows(order), ["WHAT"]), city, 51, 20);

  it("gives ρ = 1 for the same pattern of gains and less for another", () => {
    expect(twinScore(cmp(SOURCE_ORDER), cmp(SOURCE_ORDER)).rho).toBeCloseTo(1, 10);
    const other = twinScore(cmp(SOURCE_ORDER), cmp(lifted([1, 2, 4, 5, 6])));
    expect(other.rho).not.toBeNull();
    expect(other.rho as number).toBeLessThan(0.5);
    expect(other.shared).toBe(30);
  });

  it("refuses ρ over fewer than the minimum tags", () => {
    const few = TAGS.slice(0, TWIN_MIN_TAGS - 2);
    const small = rankTagRows(rows(few), ["WHAT"]);
    const s = twinScore(compareLists(small, small, 51, 20), compareLists(small, small, 51, 20));
    expect(s.rho).toBeNull();
    expect(s.reason).toBe("insufficient_n");
  });

  it("picks the largest areas and the top lifts deterministically", () => {
    expect(largestAreas(TARGETS, 2).map((a) => a.id)).toEqual(["lakeview", "hillcrest"]);
    expect(topLiftAreas([{ id: "b", lift: 1.2 }, { id: "a", lift: 1.2 }, { id: "c", lift: null }, { id: "d", lift: 0.8 }], 2).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("taste_twins with a planted twin", () => {
  it("ranks the planted twin first, fires TWIN_FOUND and writes valid ledger output", async () => {
    const run = setup();
    const result = await tasteTwinsSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    // Source polygon, two city sides, four target polygons.
    expect(run.calls).toHaveLength(7);
    expect(run.calls.filter((p) => "filter.tag.types" in p)).toHaveLength(0);

    const rho = run.ledger.metrics.filter((m) => m.key === "twin.rho");
    expect(rho).toHaveLength(4);
    const top = rho[0] as Metric;
    expect(top.subjectRefs[0]).toBe("lakeview");
    expect(top.value).toBeCloseTo(1, 10);
    expect(top.display).toBe("1.00 · strong resemblance · rank 1 of 4 among the areas checked");
    for (const m of run.ledger.metrics) {
      Metric.parse(m);
      expect(isFormulaId(m.formulaId)).toBe(true);
    }
    const finding = run.ledger.findings.find((f) => f.kind === "TWIN_FOUND");
    expect(finding?.text).toContain("Lakeview");
    expect(finding?.suggestion?.tool).toBe("block_dna");
    expect(finding?.metricIds).toContain(top.id);

    for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);
    const table = run.ledger.datasets.find((d) => d.kind === "Ranked");
    if (table?.kind !== "Ranked") throw new Error("expected the twins table");
    expect(table.payload.groups[0]?.label).toBe("4 of 4 Austin areas checked");
    expect(table.payload.groups[0]?.rows[0]?.key).toBe("lakeview");
    const bars = run.ledger.datasets.find((d) => d.kind === "Bars");
    if (bars?.kind !== "Bars") throw new Error("expected the butterfly");
    expect(bars.payload.mode).toBe("butterfly");
    expect(bars.payload.series.map((s) => s.key)).toEqual(["riverside", "lakeview"]);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "taste_twins", step: "S1" })).toBe(true);
    expect(digest.notices[0]).toContain("Checked 4 of 4 Austin areas");
    expect(digest.notices.join(" ")).toContain("SOUND");
  });

  it("checks only the named areas and refuses unknown ones with a notice", async () => {
    const run = setup();
    const result = await tasteTwinsSkill.run(input({ target_areas: ["hillcrest", "nowhere"] }), run.ctx);
    expect(run.ledger.metrics.filter((m) => m.key === "twin.rho")).toHaveLength(1);
    expect(result.forModel.notices.join(" ")).toContain("nowhere is not a Austin area");
    // One area checked: no twin is called.
    expect(run.ledger.findings.filter((f) => f.kind === "TWIN_FOUND")).toHaveLength(0);
  });

  it("refuses a target city without neighbourhood boundaries", async () => {
    const run = setup();
    const result = await tasteTwinsSkill.run(input({ target_metro: "denver" }), run.ctx);
    expect(result.status).toBe("error");
    expect(run.calls).toHaveLength(0);
  });

  it("estimates the source, both pinned city sides and the target polygons, cached ones free", async () => {
    const probe = fakeProbe((_, p) => String(p["signal.location"]).startsWith("loc-"));
    expect(await tasteTwinsSkill.estimateCalls(input(), probe, new FakeRegistry(), { geo: GEO, localities: PINS })).toBe(5);
    expect(await tasteTwinsSkill.estimateCalls(input(), fakeProbe(() => false), new FakeRegistry())).toBe(1 + 2 + 8);
  });
});
