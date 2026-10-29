// concept_vector over a scripted Qloo with a planted veto (invented brands, D29). The open call ranks
// 60 brands; the 50th is the anchor. In the scoring call one analog scores above the anchor (KEEP),
// one below (VETO), one at the call's floor (not scored) and one is missing (not scored).
import {
  DatasetEnvelope,
  digestFits,
  Metric,
  ModelDigest,
  type InsightsFilterType,
  type InsightsResponse,
  type QlooApi,
  type QlooEntity,
  type QlooParams,
  type QlooResult,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { anchorText, conceptVectorSkill } from "../../src/skills/conceptVector";
import { analogPrecision, judgeAnalogs, readOpenCall } from "../../src/skills/conceptVector/scoring";
import { fakeProbe, fakeRun, FakeRegistry, FETCHED_AT, registerInvented } from "./support/fakes";

const FLOOR = 0.0213;
const open = Array.from({ length: 60 }, (_, i) => ({ id: `ent-open-${String(i + 1).padStart(2, "0")}`, affinity: 0.95 - i * 0.01 }));
const ANCHOR = open[49] as { id: string; affinity: number };
const ANALOGS = [
  { id: "ent-analog-keep", name: "Brand Keeper", affinity: ANCHOR.affinity + 0.02 },
  { id: "ent-analog-veto", name: "Brand Vetoed", affinity: ANCHOR.affinity - 0.2 },
  { id: "ent-analog-floor", name: "Brand Floored", affinity: FLOOR },
  { id: "ent-analog-gone", name: "Brand Missing", affinity: null },
];

const entity = (id: string, affinity: number | null, popularity = 0.6): QlooEntity => ({
  entity_id: id,
  name: id.replace("ent-", "Brand "),
  type: "urn:entity:brand",
  popularity,
  ...(affinity === null ? {} : { query: { affinity } }),
});

function scripted(options: { anchorInScoring?: boolean } = {}): { api: QlooApi; calls: QlooParams[] } {
  const calls: QlooParams[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const scores = new Map<string, number | null>([...open.map((o) => [o.id, o.affinity] as const), ...ANALOGS.map((a) => [a.id, a.affinity] as const)]);
  const api: QlooApi = {
    insights: async <F extends InsightsFilterType>(_f: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      calls.push(params);
      const listed = params["filter.results.entities"];
      const rows =
        listed === undefined
          ? [...open.map((o) => entity(o.id, o.affinity)), entity("ent-floor-a", FLOOR), entity("ent-floor-b", FLOOR)]
          : (listed as string[])
              .filter((id) => scores.get(id) !== null && (options.anchorInScoring !== false || id !== ANCHOR.id))
              .map((id) => entity(id, scores.get(id) ?? null))
              // Rows come back in no particular order: the skill must read them by id.
              .reverse();
      return {
        data: { results: { entities: rows } } as unknown as InsightsResponse<F>,
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

function setup(options: { anchorInScoring?: boolean } = {}) {
  const q = scripted(options);
  const registry = new FakeRegistry();
  const run = fakeRun(q.api, registry);
  const tag = registry.registerTag({ tagId: "urn:tag:genre:brand:invented_hot_sauce", name: "hot sauce", type: "urn:tag:genre:brand", signalCapable: true });
  const refs = ANALOGS.map((a) => registerInvented(registry, { id: a.id, name: a.name, category: null }).ref);
  const input = conceptVectorSkill.input.parse({ concept_tags: [tag.ref], type: "brand", analogs: refs, trigger_finding_id: null, step_id: "S4" });
  return { ...run, calls: q.calls, input, refs };
}

describe("concept vector scoring", () => {
  it("anchors on the 50th scored result, never on floor rows", () => {
    const read = readOpenCall([...open.map((o) => entity(o.id, o.affinity)), entity("f1", FLOOR), entity("f2", FLOOR)]);
    expect(read.anchor?.entity.entity_id).toBe(ANCHOR.id);
    expect(read.anchor?.rank).toBe(50);
    expect(read.unscored).toBe(2);
    const short = readOpenCall(open.slice(0, 12).map((o) => entity(o.id, o.affinity)));
    expect(short.anchor?.entity.entity_id).toBe(open[11]?.id);
  });

  it("judges inside one call and never vetoes a missing or floor score", () => {
    const rows = [entity(ANCHOR.id, 0.4), entity("top", 0.9), entity("a", 0.41), entity("b", 0.1), entity("c", FLOOR), entity("d", FLOOR)];
    const read = judgeAnalogs(["a", "b", "c", "x"], ANCHOR.id, "top", rows, null);
    expect(read.blocked).toBeNull();
    expect(read.verdicts.map((v) => v.verdict)).toEqual(["KEEP", "VETO", "NOT_SCORED", "NOT_SCORED"]);
    expect(analogPrecision(read.verdicts)).toEqual({ keep: 1, veto: 1, precision: 0.5 });
    // A scoring call whose top falls below the anchor did not reproduce the open order: nothing is judged.
    const odd = judgeAnalogs(["a"], ANCHOR.id, "top", [entity(ANCHOR.id, 0.5), entity("top", 0.3), entity("a", 0.1)], null);
    expect(odd.blocked).not.toBeNull();
    expect(odd.verdicts[0]?.verdict).toBe("NOT_SCORED");
  });
});

describe("concept_vector with a planted veto", () => {
  it("keeps one analog, vetoes one, scores two as not scored, and adds the concept's own picks", async () => {
    const run = setup();
    const result = await conceptVectorSkill.run(run.input, run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls).toHaveLength(2);
    const scoring = run.calls[1] as QlooParams;
    expect(scoring["signal.interests.tags"]).toEqual(["urn:tag:genre:brand:invented_hot_sauce"]);
    expect(scoring["filter.results.entities"]).toEqual([...ANALOGS.map((a) => a.id), ANCHOR.id, open[0]?.id]);

    const verdicts = run.ledger.metrics.filter((m) => m.key === "cnpt.verdict");
    expect(verdicts.map((m) => m.display)).toEqual(["KEEP: at or above the 50th result", "VETO: below the 50th result", "not measured", "not measured"]);
    expect(verdicts.map((m) => m.badge)).toEqual(["DERIVED", "DERIVED", "UNAVAILABLE", "UNAVAILABLE"]);
    const precision = run.ledger.metrics.find((m) => m.key === "cnpt.precision") as Metric;
    expect(precision.value).toBe(0.5);
    expect(precision.display).toBe("1 of 2 kept (50%)");

    const finding = run.ledger.findings.find((f) => f.kind === "ANALOG_VETOED");
    expect(finding?.text).toContain("Brand Vetoed");
    expect(finding?.text).not.toContain("Brand Floored");
    expect(finding?.suggestion?.tool).toBe("rank_candidates");
    expect(finding?.metricIds).toContain(verdicts[1]?.id);

    const table = run.ledger.datasets[0];
    if (table?.kind !== "Ranked") throw new Error("expected the concept table");
    DatasetEnvelope.parse(table);
    const [analogs, adds] = table.payload.groups;
    expect(analogs?.rows.map((r) => r.flags)).toEqual([["KEEP"], ["VETO"], [], []]);
    expect(adds?.rows).toHaveLength(5);
    expect(adds?.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "concept_vector", step: "S4" })).toBe(true);
    expect(digest.registered).toHaveLength(5);
  });

  it("judges nothing when the anchor has no score in the scoring call", async () => {
    const run = setup({ anchorInScoring: false });
    const result = await conceptVectorSkill.run(run.input, run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.metrics.filter((m) => m.key === "cnpt.verdict").every((m) => m.value === null)).toBe(true);
    expect(run.ledger.findings.filter((f) => f.kind === "ANALOG_VETOED")).toHaveLength(0);
    expect(result.forModel.notices.join(" ")).toContain("no bar to compare with");
  });

  it("names the anchor's real position when fewer than 50 results are ranked, in every label", () => {
    expect(anchorText(60)).toBe("the 50th result");
    expect(anchorText(50)).toBe("the 50th result");
    expect(anchorText(48)).toBe("the 48th result (the last ranked)");
    expect(anchorText(21)).toBe("the 21st result (the last ranked)");
    expect(anchorText(12)).toBe("the 12th result (the last ranked)");
    expect(anchorText(3)).toBe("the 3rd result (the last ranked)");
  });

  it("estimates the open call from the cache and always counts the scoring call", async () => {
    const run = setup();
    expect(await conceptVectorSkill.estimateCalls(run.input, fakeProbe(() => true), run.registry)).toBe(1);
    expect(await conceptVectorSkill.estimateCalls(run.input, fakeProbe(() => false), run.registry)).toBe(2);
  });
});
