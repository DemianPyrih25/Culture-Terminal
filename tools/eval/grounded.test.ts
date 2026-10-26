// The grounded arm's record from a run's result and events, and the options it hands runAgent. A
// scripted agent stands in for runAgent: no model, no Qloo, no network (D29: invented names only).
import type { AgentRunOptions, AgentRunResult, AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, type EventInput, type Intent } from "@ct/contracts";
import type { QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { syntheticResult } from "../dev/cli/fixtures";
import { coreQuestion } from "./fixtures";
import { createGroundedArm, EVAL_RUN_PREFIX, evalRunId, groundedRecordOf, refusalCategoryOf } from "./grounded";

function intent(overrides: { safety?: Partial<Intent["safety"]>; mentions?: Intent["mentions"]; metro?: Intent["geo"]["metro"] } = {}): Intent {
  return {
    pillar: "investment",
    job: "head_to_head",
    mentions: overrides.mentions ?? [{ text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false }],
    geo: { metro: overrides.metro ?? null, area: null, unsupported_place: null },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
    safety: { allowed: true, category: null, reframe: null, ...overrides.safety },
    assumptions: [],
    mnemonic: "BRAND ALPHA VS <B>",
  };
}

const PLAN: Extract<EventInput, { type: "plan" }> = {
  type: "plan",
  plan: {
    restated_question: "Invented.",
    hypotheses: [1, 2, 3].map((n) => ({ id: `H${n}`, statement: "s", expectation: "e", test_tool: "peer_landscape" as const, metric_hint: "m" })),
    steps: [{ id: "S1", tool: "peer_landscape", purpose: "p" }],
    assumptions: [],
  },
  estimates: [],
};

const check = (attempt: 1 | 2, ok: boolean): EventInput => ({ type: "validation", ok, attempt, issues: [], numbersTraced: { traced: 3, total: 3 }, adviceTerms: 0 });

describe("run ids", () => {
  it("start with the dev CLIs' prefix, which the web leaves out of its run counts", () => {
    const id = evalRunId("q01", 2, new Date("2026-10-23T10:15:00.123Z"));
    expect(id).toBe("cli-eval-q01t2-20261023T101500123Z");
    expect(id.startsWith(EVAL_RUN_PREFIX)).toBe(true);
    // apps/web/server/run-counts.ts: `id not like 'cli-%'`.
    expect(id.startsWith("cli-")).toBe(true);
  });
});

describe("refusalCategoryOf", () => {
  it("reads the category a refusal applies, as runAgent decides it", () => {
    expect(refusalCategoryOf(intent())).toBeNull();
    expect(refusalCategoryOf(intent({ safety: { allowed: false, category: "political_targeting" } }))).toBe("political_targeting");
    expect(refusalCategoryOf(intent({ safety: { allowed: true, category: "injection" } }))).toBe("injection");
    const person = intent({ mentions: [{ text: "Dana Example", entity_type: "person", role: "primary", public_figure: false }] });
    expect(refusalCategoryOf(person)).toBe("private_individual");
  });
});

describe("groundedRecordOf", () => {
  const question = coreQuestion("q01");
  const at = new Date("2026-10-23T10:00:00.000Z");

  it("takes CLERK's job and metro, the plan's priors and the CHECKER's first verdict from the events", () => {
    const events: EventInput[] = [{ type: "clerk", intent: intent({ metro: "austin" }), ms: 900 }, PLAN, check(1, false), check(2, true)];
    const record = groundedRecordOf({ question, take: 1, runId: "cli-eval-q01t1-x", result: syntheticResult("cli-eval-q01t1-x"), events, finishedAt: at });
    expect(record).toMatchObject({
      questionId: "q01",
      take: 1,
      status: "completed",
      job: "head_to_head",
      metro: "austin",
      refusalCategory: null,
      plannedHypotheses: 3,
      checkerFirstPass: false,
      numbersTraced: { traced: 3, total: 3 },
      qloo: { network: 6, cached: 2, reused: 1 },
      usd: 0.31,
      finishedAt: at.toISOString(),
    });
  });

  it("reads a refusal's category from the clerk event, since the result keeps no intent", () => {
    const events: EventInput[] = [{ type: "clerk", intent: intent({ safety: { allowed: false, category: "sensitive_inference" } }), ms: 500 }];
    const result = syntheticResult("r", { status: "refused", report: null, intent: null, validation: null, reason: "declined" });
    const record = groundedRecordOf({ question, take: 1, runId: "r", result, events, finishedAt: at });
    expect(record).toMatchObject({ status: "refused", refusalCategory: "sensitive_inference", plannedHypotheses: null, checkerFirstPass: null, numbersTraced: null });
  });

  it("has no category for a refusal CLERK never read", () => {
    const result = syntheticResult("r", { status: "refused", report: null, validation: null });
    expect(groundedRecordOf({ question, take: 1, runId: "r", result, events: [], finishedAt: at })).toMatchObject({ job: null, refusalCategory: null });
  });
});

describe("createGroundedArm", () => {
  it("runs the question as a web live run would, and books the per-run hard cap", async () => {
    const seen: AgentRunOptions[] = [];
    const agent = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      seen.push(options);
      options.emit({ type: "note", text: "thinking" });
      return syntheticResult(options.runId);
    };
    const localities = { market: async () => null };
    const arm = createGroundedArm({
      qloo: {} as QlooClient,
      anthropic: {} as AnthropicLike,
      localities,
      runAgent: agent,
      now: () => new Date("2026-10-23T10:15:00.000Z"),
    });
    expect(arm.worstCaseUsd).toBe(DEFAULT_RUN_LIMITS.usdHard);
    const out = await arm.run({ question: coreQuestion("q03"), take: 1, signal: new AbortController().signal });
    expect(seen[0]).toMatchObject({ question: coreQuestion("q03").question, lane: "public", mode: "live", limits: DEFAULT_RUN_LIMITS, parent: null, localities });
    expect(seen[0]?.pins).toBeUndefined();
    expect(seen[0]?.runId).toBe("cli-eval-q03t1-20261023T101500000Z");
    expect(out.events).toEqual([{ type: "note", text: "thinking" }]);
    expect(out.record.runId).toBe(seen[0]?.runId);
    expect(out.datasets).toEqual([]);
  });
});
