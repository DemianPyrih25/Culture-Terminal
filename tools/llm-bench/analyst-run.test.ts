import { describe, expect, it } from "vitest";
import { MAX_RESPONSES, runAnalyst, type RunRecord } from "./analyst-run";
import { BudgetGuard } from "./budget";
import { BENCH_CONFIGS, THINKING_UPDATES_BETA, type BenchConfig } from "./config";
import { Anthropic, ANALYST_TOOL_NAMES } from "./deps";
import { fakeClock, fakeRefusalDetails, scriptedStreamer, text, thinking, toolUse, type ScriptStep } from "./fakes";
import { usageToUsd } from "./pricing";
import { NUDGE_PLAN, NUDGE_REPORT, TURN2_GUIDE, TURN3_NOTICE } from "./scenario";
import { dnaFollowUp, peerCall, planCall, reportCall, respond, shareCall } from "./test-utils";

const [sonnetMedium, , haikuMedium] = BENCH_CONFIGS as readonly [BenchConfig, BenchConfig, BenchConfig];

async function run(steps: ScriptStep[], config: BenchConfig = sonnetMedium) {
  const scripted = scriptedStreamer(steps);
  const guard = new BudgetGuard(100);
  const rec = await runAnalyst(config, 1, { streamer: scripted.streamer, guard, now: fakeClock(1000) });
  return { rec, ...scripted, guard };
}

type Block = Anthropic.Beta.BetaContentBlockParam;
const blocks = (m: Anthropic.Beta.BetaMessageParam | undefined): Block[] =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : ((m?.content ?? []) as Block[]);
const lastMessage = (req: { messages: Anthropic.Beta.BetaMessageParam[] }) => req.messages[req.messages.length - 1];
const toolResults = (m: Anthropic.Beta.BetaMessageParam | undefined) =>
  blocks(m).filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result");
const texts = (m: Anthropic.Beta.BetaMessageParam | undefined) => blocks(m).flatMap((b) => (b.type === "text" ? [b.text] : []));
const resultText = (r: Anthropic.Beta.BetaToolResultBlockParam) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

describe("a clean three-turn run", () => {
  const happy = (): ScriptStep[] => [
    respond([thinking("Planning: peers first, then age skew."), planCall(), peerCall(), shareCall()], "tool_use", {
      input_tokens: 300,
      cache_creation_input_tokens: 9000,
      output_tokens: 1800,
    }),
    respond([thinking("The matrix put a footwear brand closest; checking the audience."), dnaFollowUp()], "tool_use", {
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 6000,
    }),
    respond([reportCall()], "tool_use", { cache_read_input_tokens: 15_000, output_tokens: 2500 }),
  ];

  it("completes in three responses with a valid plan and report", async () => {
    const { rec, requests } = await run(happy());
    expect(rec.outcome).toBe("completed");
    expect(rec.responses).toBe(3);
    expect(requests).toHaveLength(3);
    expect(rec.turns.map((t) => [t.turn, t.kind])).toEqual([
      [1, "turn"],
      [2, "turn"],
      [3, "turn"],
    ]);
    expect(rec.plan).toMatchObject({ submitted: true, structural: true, limits: true });
    expect(rec.report).toMatchObject({ submitted: true, structural: true, limits: true });
    expect(rec.quality).toMatchObject({ arguments: 3, hypothesesPlanned: 2, hypothesesJudged: 2, bareNumbers: 0 });
    expect(rec.nudges).toEqual({ plan: false, report: false });
    expect(rec.thinkingNonEmpty).toBe(true);
    expect(rec.turns[0]?.thinking.texts).toEqual(["Planning: peers first, then age skew."]);
  });

  it("keeps the history append-only and sends each response back unchanged", async () => {
    const steps = happy();
    const { requests, snapshots } = await run(steps);
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1]!.messages;
      const next = requests[i]!.messages;
      expect(next.length).toBeGreaterThan(prev.length);
      prev.forEach((m, j) => expect(next[j]).toBe(m));
    }
    // Nothing already sent was edited afterwards.
    requests.forEach((r, i) => expect(JSON.stringify(r.messages)).toBe(snapshots[i]));
    // The assistant turn is the response's own content array, thinking signatures included.
    const firstResponse = steps[0] as Anthropic.Beta.BetaMessage;
    expect(requests[1]!.messages[1]).toEqual({ role: "assistant", content: firstResponse.content });
    expect(requests[1]!.messages[1]!.content).toBe(firstResponse.content);
  });

  it("answers every tool_use of turn 1 in one message, then the scan and the turn-2 guide", async () => {
    const { requests } = await run(happy());
    const t1Results = lastMessage(requests[1]!);
    const results = toolResults(t1Results);
    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_plan", "toolu_peer", "toolu_share"]);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(resultText(results[0]!)).toMatch(/^PLAN_ACCEPTED: hypotheses H1, H2; steps S1, S2/);
    expect(resultText(results[1]!)).toMatch(/^<qloo_data tool="SUBS" step="S1">\{"_data_notice"/);
    // tool_result blocks come first; text follows them.
    const kinds = blocks(t1Results).map((b) => b.type);
    expect(kinds.lastIndexOf("tool_result")).toBeLessThan(kinds.indexOf("text"));
    const t = texts(t1Results);
    expect(t[0]).toMatch(/^OPENING SCAN/);
    expect(t[0]).toContain('<qloo_data tool="DNA">');
    expect(t[1]).toBe(TURN2_GUIDE);
    expect(texts(lastMessage(requests[2]!))).toEqual([TURN3_NOTICE]);
  });

  it("sends the ANALYST request shape on every turn", async () => {
    const { requests } = await run(happy());
    for (const req of requests) {
      expect(req.tool_choice).toEqual({ type: "auto" });
      expect(req.thinking).toEqual({ type: "adaptive", display: "updates" });
      expect(req.betas).toEqual([THINKING_UPDATES_BETA]);
      expect(req.cache_control).toEqual({ type: "ephemeral" });
      expect(req.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual(ANALYST_TOOL_NAMES);
      // The prefix is byte-identical across turns, so it caches.
      expect(JSON.stringify([req.system, req.tools])).toBe(JSON.stringify([requests[0]!.system, requests[0]!.tools]));
    }
  });

  it("totals cost, tokens, latency and the first request's cache read", async () => {
    const steps = happy();
    const { rec, guard } = await run(steps);
    const expected = steps.reduce((acc, s) => acc + usageToUsd(sonnetMedium.model, (s as Anthropic.Beta.BetaMessage).usage), 0);
    expect(rec.usd).toBeCloseTo(expected, 12);
    expect(guard.spentUsd).toBeCloseTo(expected, 12);
    expect(rec.usage.cacheRead).toBe(24_000);
    expect(rec.firstRequestCacheRead).toBe(0);
    expect(rec.wallMs).toBeGreaterThan(0);
    expect(rec.turns.every((t) => t.latencyMs > 0 && t.firstDeltaMs !== null)).toBe(true);
  });

  it("runs the economy config without the beta and with summarized thinking", async () => {
    const { rec, requests } = await run(happy(), haikuMedium);
    expect(rec.outcome).toBe("completed");
    expect(requests[0]).not.toHaveProperty("betas");
    expect(requests[0]!.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("nudges (PLAN §4.2 guards)", () => {
  it("nudges once when turn 1 has no submit_plan, holding back data until the plan exists", async () => {
    const { rec, requests } = await run([
      respond([peerCall("toolu_early")]),
      respond([planCall(), peerCall()]),
      respond([reportCall()]),
    ]);
    const nudge = lastMessage(requests[1]!);
    expect(toolResults(nudge)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_early", is_error: true, content: expect.stringMatching(/^PLAN_REQUIRED/) },
    ]);
    expect(texts(nudge)).toEqual([NUDGE_PLAN]);
    expect(rec.nudges.plan).toBe(true);
    expect(rec.turns.map((t) => t.kind)).toEqual(["turn", "nudge_retry", "turn"]);
    expect(rec.outcome).toBe("completed");
  });

  it("nudges for the plan only once, then carries on without one", async () => {
    const { rec, requests } = await run([
      respond([text("Let me think about this question.")], "end_turn"),
      respond([peerCall()]),
      respond([reportCall()]),
    ]);
    const all = requests[2]!.messages.flatMap((m) => texts(m));
    expect(all.filter((t) => t === NUDGE_PLAN)).toHaveLength(1);
    // After the one nudge, wave-1 calls get data even without a plan.
    expect(toolResults(lastMessage(requests[2]!))[0]?.is_error).toBeUndefined();
    expect(rec.plan.submitted).toBe(false);
    expect(rec.outcome).toBe("completed");
  });

  it("nudges once when a turn ends without submit_report, then accepts the report", async () => {
    const { rec, requests } = await run([
      respond([planCall(), peerCall()]),
      respond([text("The evidence looks sufficient.")], "end_turn"),
      respond([reportCall()]),
    ]);
    expect(lastMessage(requests[2]!)).toEqual({ role: "user", content: NUDGE_REPORT });
    expect(rec.nudges.report).toBe(true);
    expect(rec.outcome).toBe("completed");
  });

  it("answers turn-3 tool calls with INVESTIGATION_BUDGET_EXHAUSTED, nudges once, then marks the run incomplete", async () => {
    const { rec, requests } = await run([
      respond([planCall(), peerCall()]),
      respond([dnaFollowUp()]),
      respond([dnaFollowUp("toolu_more", "F2")]),
      respond([dnaFollowUp("toolu_again", "F2")]),
    ]);
    const t3 = lastMessage(requests[3]!);
    expect(resultText(toolResults(t3)[0]!)).toMatch(/^INVESTIGATION_BUDGET_EXHAUSTED/);
    expect(texts(t3)).toEqual([NUDGE_REPORT]);
    expect(rec.outcome).toBe("incomplete");
    expect(rec.reason).toMatch(/no submit_report after the nudge/);
    expect(rec.responses).toBe(4);
    expect(rec.report.submitted).toBe(false);
  });
});

describe("stop reasons are checked before content", () => {
  it("ends the run with a refusal result and runs no tools", async () => {
    const refused = { ...respond([planCall()], "refusal"), stop_details: fakeRefusalDetails({ category: "general_harms" }) };
    const { rec, requests } = await run([refused, respond([reportCall()])]);
    expect(rec.outcome).toBe("refused");
    expect(rec.refusal).toMatchObject({ kind: "refusal", category: "general_harms", partialOutput: true });
    expect(requests).toHaveLength(1);
    expect(rec.plan.submitted).toBe(false);
  });

  it("pushes a pause_turn response unchanged and continues without a new user message", async () => {
    const paused = respond([thinking("Still working.")], "pause_turn");
    const { rec, requests } = await run([paused, respond([planCall(), peerCall()]), respond([reportCall()])]);
    expect(lastMessage(requests[1]!)).toEqual({ role: "assistant", content: paused.content });
    expect(rec.turns.map((t) => t.kind)).toEqual(["turn", "pause_continue", "turn"]);
    expect(rec.outcome).toBe("completed");
  });

  it("fails the turn on max_tokens with a pending tool_use and never runs its tools", async () => {
    const { rec, requests } = await run([respond([planCall(), peerCall()], "max_tokens"), respond([reportCall()])]);
    expect(rec.outcome).toBe("failed");
    expect(rec.reason).toMatch(/max_tokens with a pending tool_use \(submit_plan, peer_landscape\)/);
    expect(requests).toHaveLength(1);
    expect(rec.plan.submitted).toBe(false);
  });

  it("stops at the five-response limit (D4)", async () => {
    const pause = () => respond([], "pause_turn");
    const { rec, requests } = await run([pause(), pause(), pause(), pause(), pause(), respond([reportCall()])]);
    expect(MAX_RESPONSES).toBe(5);
    expect(requests).toHaveLength(5);
    expect(rec.outcome).toBe("incomplete");
    expect(rec.reason).toMatch(/limit of 5 model responses/);
  });
});

describe("follow-up rules", () => {
  async function followUp(use: Anthropic.Beta.BetaToolUseBlock): Promise<string> {
    const { requests } = await run([respond([planCall(), peerCall()]), respond([use]), respond([reportCall()])]);
    const result = toolResults(lastMessage(requests[2]!))[0]!;
    return `${result.is_error ? "error " : ""}${resultText(result)}`;
  }

  it("answers a follow-up that cites an issued finding", async () => {
    expect(await followUp(dnaFollowUp())).toMatch(/^<qloo_data tool="DNA">/);
  });

  it("rejects a follow-up without trigger_finding_id", async () => {
    expect(await followUp(dnaFollowUp("t", null))).toMatch(/^error TRIGGER_REQUIRED/);
  });

  it("rejects a finding id that was never issued", async () => {
    expect(await followUp(dnaFollowUp("t", "F99"))).toMatch(/^error UNKNOWN_FINDING: F99/);
  });

  it("rejects refs that are not in the registry", async () => {
    const use = toolUse("t", "audience_dna", { set: ["R1", "R77"], compare_with: null, trigger_finding_id: "F1", step_id: null });
    expect(await followUp(use)).toMatch(/^error UNKNOWN_REF: R77/);
  });

  it("validates input with zod, as eager input streaming requires", async () => {
    const use = toolUse("t", "audience_dna", { set: [], compare_with: null, trigger_finding_id: "F1", step_id: null });
    expect(await followUp(use)).toMatch(/^error INVALID_INPUT\nset:/);
  });

  it("rejects unknown tools", async () => {
    expect(await followUp(toolUse("t", "web_search", {}))).toMatch(/^error UNKNOWN_TOOL/);
  });
});

describe("errors", () => {
  const apiError = (status: number) =>
    Anthropic.APIError.generate(status, { type: "error", error: { type: "api_error", message: "synthetic" } }, "synthetic", new Headers());

  it("re-issues the turn once after unparseable tool JSON, charging the estimate to the guard but not to the run's cost", async () => {
    const { rec, requests, guard } = await run([
      new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model."),
      respond([planCall(), peerCall()]),
      respond([reportCall()]),
    ]);
    expect(requests).toHaveLength(3);
    expect(rec.outcome).toBe("completed");
    expect(rec.turns.map((t) => t.kind)).toEqual(["retry_after_error", "turn"]);
    expect(rec.turns[0]?.retryCause).toMatch(/^sdk_client_error: Unable to parse tool parameter JSON/);
    expect(rec.turns[1]?.retryCause).toBeNull();
    expect(rec.responses).toBe(3);
    const measured = rec.turns.reduce((a, t) => a + t.usd, 0);
    expect(rec.usd).toBeCloseTo(measured, 12);
    expect(rec.estimatedChargesUsd).toBeGreaterThan(0);
    expect(guard.spentUsd).toBeCloseTo(measured + rec.estimatedChargesUsd, 12);
  });

  it("re-issues the turn after a stream the SDK cut mid-SSE, and records why", async () => {
    // BetaMessageStream wraps a raw stream error (an undici "terminated") in a plain AnthropicError.
    const { rec } = await run([respond([planCall(), peerCall()]), new Anthropic.AnthropicError("terminated"), respond([reportCall()])]);
    expect(rec.outcome).toBe("completed");
    expect(rec.turns.map((t) => [t.turn, t.kind, t.retryCause])).toEqual([
      [1, "turn", null],
      [2, "retry_after_error", "sdk_client_error: terminated"],
    ]);
    expect(rec.usd).toBeCloseTo(rec.turns.reduce((a, t) => a + t.usd, 0), 12);
  });

  it("fails after a second unparseable response", async () => {
    const bad = () => new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model.");
    const { rec } = await run([bad(), bad(), respond([reportCall()])]);
    expect(rec.outcome).toBe("failed");
    expect(rec.error).toMatchObject({ kind: "sdk_client_error" });
  });

  it("records the error scope so the bench can skip a config or stop", async () => {
    const bad: RunRecord = (await run([apiError(400)])).rec;
    expect(bad.outcome).toBe("failed");
    expect(bad.error).toMatchObject({ kind: "bad_request", scope: "config" });
    expect(bad.usd).toBe(0);
    expect((await run([apiError(401)])).rec.error?.scope).toBe("bench");
  });
});
