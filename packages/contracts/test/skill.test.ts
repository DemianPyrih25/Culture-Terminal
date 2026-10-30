import { describe, expect, it } from "vitest";
import {
  ANALYST_TOOLS,
  DATA_NOTICE,
  digestFits,
  initialRunState,
  applyEvent,
  stampEvent,
  wrapQlooData,
  type EventInput,
  type InsightsFilterType,
  type InsightsResponse,
  type QlooApi,
  type QlooCallMeta,
  type QlooResult,
  type SkillCtx,
  type SkillFor,
  type SkillRegistry,
} from "../src/index";
import { evidence, metric, RUN_ID, ts } from "./fixtures";

// A compile-time check that the interfaces are implementable as written, plus a tiny end-to-end use.

const meta: QlooCallMeta = {
  qlooCallId: "q1",
  requestId: "req-fixture-1",
  cache: "miss",
  fetchedAt: ts(1),
  ms: 120,
  stale: false,
  originRunId: null,
};

const fakeQloo: QlooApi = {
  search: async () => ({ data: { results: [] }, meta }),
  entities: async () => ({ data: { results: [] }, meta }),
  tags: async () => ({ data: { results: { tags: [] } }, meta }),
  audiences: async () => ({ data: { results: { audiences: [] } }, meta }),
  insights: async <F extends InsightsFilterType>(filterType: F): Promise<QlooResult<InsightsResponse<F>>> => {
    const data = filterType === "urn:heatmap" ? { results: { heatmap: [] } } : { results: { entities: [] } };
    // A real client validates with insightsResponseSchema(filterType), whose output is unknown.
    return { data: data as unknown as InsightsResponse<F>, meta };
  },
  trending: async () => ({ data: { results: { trending: [] } }, meta }),
};

const momentumSkill: SkillFor<"momentum"> = {
  id: "momentum",
  mnemonic: "MOM",
  kitWorkflows: ["trends"],
  input: ANALYST_TOOLS.momentum.input,
  estimateCalls: async (input, probe) => {
    let n = 0;
    for (const ref of input.entities) if (!(await probe.has("/v2/trending", { "signal.interests.entities": ref }))) n++;
    return n;
  },
  run: async (input, ctx) => {
    const res = await ctx.qloo.trending({ "filter.type": `urn:entity:${input.type}` });
    const e = ctx.ledger.addEvidence({ skill: "momentum", purpose: "trend", calls: [res.meta], status: "empty", summary: "no points", flags: ["NO_TREND_SIGNAL"] });
    ctx.emit({ type: "note", text: `momentum for ${input.entities.length}` });
    return {
      forModel: {
        _data_notice: DATA_NOTICE,
        status: "empty",
        evidence_ids: [e.id],
        dataset_ids: [],
        metrics: [],
        top_rows: [],
        findings: [],
        flags: ["NO_TREND_SIGNAL"],
        registered: [],
        notices: [],
      },
      evidenceIds: [e.id],
      metricIds: [],
      datasetIds: [],
      findingIds: [],
      flags: ["NO_TREND_SIGNAL"],
      status: "empty",
    };
  },
  limitations: (flags) => (flags.includes("NO_TREND_SIGNAL") ? ["'no signal' is not 'flat'."] : []),
};

// Every skill id must be present in a registry; this line fails to compile if SkillRegistry drifts from SkillId.
type _RegistryKeys = keyof SkillRegistry;
const _momentumKey: _RegistryKeys = "momentum";

describe("skill contract", () => {
  it("runs a skill against fake context implementations", async () => {
    const emitted: EventInput[] = [];
    const ctx = {
      qloo: fakeQloo,
      ledger: {
        addEvidence: () => evidence,
        addMetric: () => metric,
        addDataset: () => {
          throw new Error("unused");
        },
        addFinding: () => {
          throw new Error("unused");
        },
        evidence: () => evidence,
        metric: () => metric,
        dataset: () => undefined,
        finding: () => undefined,
      },
      geo: {} as SkillCtx["geo"],
      publicdata: null,
      localities: null,
      registry: {} as SkillCtx["registry"],
      emit: (e: EventInput) => emitted.push(e),
      budget: {} as SkillCtx["budget"],
      signal: new AbortController().signal,
      runId: RUN_ID,
      pillar: "investment",
      phase: "wave1",
      toolCallId: "toolu_fixture_9",
      concepts: [],
      candidates: { entities: [], areas: [], markets: [] },
    } satisfies SkillCtx;

    const input = momentumSkill.input.parse({ entities: ["R1"], type: "brand", trigger_finding_id: null, step_id: "S4" });
    expect(await momentumSkill.estimateCalls(input, { has: async () => false }, ctx.registry)).toBe(1);
    const result = await momentumSkill.run(input, ctx);
    expect(result.status).toBe("empty");
    expect(digestFits(result.forModel, { tool: "momentum", step: "S4" })).toBe(true);
    expect(wrapQlooData(result.forModel, { tool: "momentum", step: "S4" })).toContain('tool="MOM"');
    expect(momentumSkill.limitations(result.flags)).toHaveLength(1);

    const s = applyEvent(initialRunState(RUN_ID), stampEvent(emitted[0]!, { seq: 1, ts: ts(1), runId: RUN_ID }));
    expect(s.notes[0]?.text).toBe("momentum for 1");
    expect(_momentumKey).toBe("momentum");
  });
});
