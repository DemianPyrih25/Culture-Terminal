import { describe, expect, it } from "vitest";
import { NOTICE_TRUNCATED, NUDGE_PLAN, NUDGE_REPORT, TURN3_NOTICE } from "../../src/llm/notices";
import { usdFor } from "../../src/pricing";
import { fakeMessage, fakeRefusalDetails, respond, text, thinking, toolUse } from "../support/fake-anthropic";
import {
  blocksOf,
  followUp,
  lastMessage,
  peerCall,
  planCall,
  reportCall,
  resultText,
  runScripted,
  shareCall,
  stepCall,
  textsOf,
  toolResults,
  validPlan,
  validReport,
} from "./builders";

const happy = () => [
  respond([thinking("Planning: peers first, then age skew."), planCall(), peerCall(), shareCall()], "tool_use", {
    input_tokens: 300,
    cache_creation_input_tokens: 9000,
    output_tokens: 1800,
  }),
  respond([thinking("The matrix put another category closest."), followUp()], "tool_use", {
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 6000,
  }),
  respond([reportCall()], "tool_use", { cache_read_input_tokens: 15_000, output_tokens: 2500 }),
];

describe("a clean three-turn run", () => {
  it("completes in three responses with the plan, one pivot and the report", async () => {
    const h = await runScripted(happy());
    expect(h.outcome).toMatchObject({ status: "completed", code: "report_accepted", reason: null, responses: 3, turn: 3 });
    expect(h.outcome.plan).toEqual(validPlan());
    expect(h.outcome.submittedPlan).toEqual(validPlan());
    expect(h.outcome.draft).toEqual(validReport());
    expect(h.plans).toEqual([{ plan: validPlan(), issues: [] }]);
    expect(h.drafts).toEqual([1]);
    expect(h.pivots).toEqual(["F1"]);
    expect(h.outcome.pivots).toEqual([
      { toolCallId: "toolu_dna", tool: "audience_dna", triggerFindingId: "F1", args: followUp().input },
    ]);
    expect(h.outcome.nudges).toEqual({ plan: false, report: false, time: false, cost: false });
    expect(h.outcome.rejections).toEqual([]);
  });

  it("runs the wave-1 tools of turn 1 together and the follow-ups in turn 2", async () => {
    const h = await runScripted(happy());
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.name)])).toEqual([
      [1, ["peer_landscape", "share_of_taste"]],
      [2, ["audience_dna"]],
    ]);
  });

  it("answers every tool_use of a response in ONE user message, results first, in call order", async () => {
    const h = await runScripted(happy(), { turnContext: (turn) => (turn === 1 ? ["OPENING SCAN (synthetic)"] : []) });
    const t1 = lastMessage(h.fake.streamRequests[1]);
    expect(t1?.role).toBe("user");
    const results = toolResults(t1);
    expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_plan", "toolu_peer", "toolu_share"]);
    expect(results.every((r) => r.is_error === undefined)).toBe(true);
    expect(resultText(results[0])).toMatch(/^PLAN_ACCEPTED: hypotheses H1, H2; steps S1, S2/);
    expect(resultText(results[1])).toBe('<qloo_data tool="peer_landscape">{"synthetic":true}</qloo_data>');
    const kinds = blocksOf(t1).map((b) => b.type);
    expect(kinds.lastIndexOf("tool_result")).toBeLessThan(kinds.indexOf("text"));
    expect(textsOf(t1)[0]).toBe("OPENING SCAN (synthetic)");
    expect(textsOf(t1)[1]).toMatch(/^TURN 2: .*up to 8 Qloo calls/);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([TURN3_NOTICE]);
  });

  it("totals usage and USD over the responses and reports each one", async () => {
    const steps = happy();
    const h = await runScripted(steps);
    const expected = steps.reduce((sum, m) => sum + usdFor("claude-sonnet-5-5", m.usage), 0);
    expect(h.outcome.usd).toBeCloseTo(expected, 12);
    expect(h.usages.map((u) => u.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(h.usages.reduce((s, u) => s + u.usd, 0)).toBeCloseTo(expected, 12);
    expect(h.outcome.usage).toEqual({ input: 2300, output: 4500, cacheRead: 24_000, cacheCreation: 15_000 });
  });

  it("streams thinking updates to onThinking", async () => {
    const h = await runScripted(happy());
    expect(h.notes).toEqual(["Planning: peers first, then age skew.", "The matrix put another category closest."]);
  });

  it("reports every call to onToolEnd, executed or not", async () => {
    const h = await runScripted(happy());
    expect(h.toolEnds.map((e) => [e.use.name, e.turn, e.ok, e.executed])).toEqual([
      ["submit_plan", 1, true, false],
      ["peer_landscape", 1, true, true],
      ["share_of_taste", 1, true, true],
      ["audience_dna", 2, true, true],
      ["submit_report", 3, true, false],
    ]);
  });
});

describe("turn 1 guards", () => {
  it("nudges once when turn 1 lacks submit_plan, holding back wave-1 data until the plan exists", async () => {
    const h = await runScripted([respond([peerCall("toolu_early")]), respond([planCall(), peerCall()]), respond([reportCall()])]);
    const nudge = lastMessage(h.fake.streamRequests[1]);
    expect(toolResults(nudge)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_early", is_error: true, content: expect.stringMatching(/^PLAN_REQUIRED: /) },
    ]);
    expect(textsOf(nudge)).toEqual([NUDGE_PLAN]);
    expect(h.executed).toEqual([{ turn: 1, calls: [expect.objectContaining({ id: "toolu_peer" })] }]);
    expect(h.outcome).toMatchObject({ status: "completed", nudges: { plan: true } });
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_early", tool: "peer_landscape", code: "PLAN_REQUIRED", turn: 1 }]);
  });

  it("nudges for the plan only once, then runs wave 1 without one", async () => {
    const h = await runScripted([
      respond([text("Let me think about this question.")], "end_turn"),
      respond([peerCall()]),
      respond([reportCall()]),
    ]);
    expect(lastMessage(h.fake.streamRequests[1])).toEqual({ role: "user", content: [{ type: "text", text: NUDGE_PLAN }] });
    expect(h.executed.map((e) => e.turn)).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", plan: null, nudges: { plan: true } });
  });

  it("gives an invalid plan one repair, still holding back data", async () => {
    const bad = { ...validPlan(), hypotheses: [{ ...validPlan().hypotheses[0], id: "X1" }] };
    const h = await runScripted([respond([planCall("toolu_bad", bad), peerCall("toolu_early")]), respond([planCall(), peerCall()]), respond([reportCall()])]);
    const repair = toolResults(lastMessage(h.fake.streamRequests[1]));
    expect(repair[0]).toMatchObject({ tool_use_id: "toolu_bad", is_error: true });
    expect(resultText(repair[0])).toMatch(/^INVALID_PLAN: fix these issues/);
    expect(resultText(repair[0])).toMatch(/hypotheses\.0\.id: expected a hypothesis id like H1/);
    expect(resultText(repair[0])).toMatch(/hypotheses: Too small/);
    expect(repair[1]).toMatchObject({ tool_use_id: "toolu_early", is_error: true });
    expect(h.outcome).toMatchObject({ status: "completed", repairs: { plan: true }, nudges: { plan: false } });
    expect(h.outcome.plan).toEqual(validPlan());
    expect(h.plans).toEqual([{ plan: validPlan(), issues: [] }]);
  });

  it("keeps the last well-formed plan with its issues when the repair misses its limits too", async () => {
    const bad = { ...validPlan(), steps: [] };
    const h = await runScripted([respond([planCall("toolu_a", bad)]), respond([planCall("toolu_b", bad), peerCall()]), respond([reportCall()])]);
    const answer = resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0]);
    expect(answer).toMatch(/^INVALID_PLAN: no repair is left, so the last well-formed plan is kept/);
    expect(h.executed.map((e) => e.turn)).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", plan: null, submittedPlan: bad });
    expect(h.plans).toEqual([{ plan: bad, issues: [expect.stringMatching(/^steps: Too small/)] }]);
  });

  it("settles an over-limit plan once wave 1 runs, even when the repair response has no plan", async () => {
    const five = { ...validPlan(), hypotheses: [1, 2, 3, 4, 5].map((n) => ({ ...validPlan().hypotheses[0]!, id: `H${n}` })) };
    const h = await runScripted([
      respond([planCall("toolu_five", five)]),
      respond([peerCall("toolu_early")]),
      respond([peerCall()]),
      respond([reportCall()]),
    ]);
    expect(h.outcome.rejections.map((r) => r.code)).toEqual(["INVALID_PLAN", "PLAN_REQUIRED"]);
    expect(h.executed).toEqual([{ turn: 1, calls: [expect.objectContaining({ id: "toolu_peer" })] }]);
    expect(h.plans).toEqual([{ plan: five, issues: [expect.stringMatching(/^hypotheses: Too big/)] }]);
    expect(h.outcome).toMatchObject({ status: "completed", plan: null, submittedPlan: five, repairs: { plan: true }, nudges: { plan: true } });
  });

  it("continues without a plan when no submit_plan was well-formed", async () => {
    const broken = { restated_question: "Is Brand Alpha a niche?" };
    const h = await runScripted([respond([planCall("toolu_a", broken)]), respond([planCall("toolu_b", broken), peerCall()]), respond([reportCall()])]);
    expect(resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0])).toMatch(/^INVALID_PLAN: no repair is left and no well-formed plan/);
    expect(h.executed.map((e) => e.turn)).toEqual([1]);
    expect(h.plans).toEqual([]);
    expect(h.outcome).toMatchObject({ status: "completed", plan: null, submittedPlan: null });
  });

  it("refuses submit_report in turn 1 and duplicate plans", async () => {
    const h = await runScripted([respond([planCall(), planCall("toolu_again"), reportCall("toolu_early")]), respond([reportCall()])]);
    const codes = h.outcome.rejections.map((r) => [r.toolCallId, r.code]);
    expect(codes).toEqual([
      ["toolu_again", "DUPLICATE_SUBMISSION"],
      ["toolu_early", "WRONG_TURN"],
    ]);
    expect(h.outcome.status).toBe("completed");
  });
});

describe("tool input validation", () => {
  it("answers invalid arguments with is_error and the zod issues, and runs the valid calls", async () => {
    const bad = toolUse("toolu_bad", "peer_landscape", { target: "Brand Alpha", peers: [], discover: false, k: 9, trigger_finding_id: null, step_id: "S1" });
    const h = await runScripted([respond([planCall(), bad, shareCall()]), respond([reportCall()])]);
    const result = toolResults(lastMessage(h.fake.streamRequests[1])).find((r) => r.tool_use_id === "toolu_bad");
    expect(result?.is_error).toBe(true);
    expect(resultText(result)).toMatch(/^INVALID_INPUT: /);
    expect(resultText(result)).toMatch(/target: expected a entity ref id like R1/);
    expect(resultText(result)).toMatch(/k: Too big/);
    expect(h.executed[0]?.calls.map((c) => c.id)).toEqual(["toolu_share"]);
  });

  it("answers an unknown tool with UNKNOWN_TOOL", async () => {
    const h = await runScripted([respond([planCall(), toolUse("toolu_x", "web_fetch", { url: "x" })]), respond([reportCall()])]);
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_x", tool: "web_fetch", code: "UNKNOWN_TOOL", turn: 1 }]);
  });

  it("answers TOOL_FAILED when the executor returns no result for a call", async () => {
    const h = await runScripted([respond([planCall(), peerCall(), shareCall()]), respond([reportCall()])], {
      executeTools: async (calls) => [{ tool_use_id: calls[0]!.id, content: "only one" }],
    });
    const results = toolResults(lastMessage(h.fake.streamRequests[1]));
    expect(results.find((r) => r.tool_use_id === "toolu_share")).toMatchObject({ is_error: true, content: expect.stringMatching(/^TOOL_FAILED/) });
  });
});

describe("turn 2: finding-triggered follow-ups and late planned steps", () => {
  it("rejects follow-ups without a trigger or with an unknown finding, and runs the triggered one", async () => {
    const seen: string[] = [];
    const h = await runScripted(
      [respond([planCall(), peerCall()]), respond([followUp("toolu_none", null), followUp("toolu_unknown", "F9"), followUp("toolu_ok", "F2")]), respond([reportCall()])],
      { findingExists: (id) => (seen.push(id), id === "F2") },
    );
    const results = toolResults(lastMessage(h.fake.streamRequests[2]));
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["toolu_none", true],
      ["toolu_unknown", true],
      ["toolu_ok", false],
    ]);
    expect(resultText(results[0])).toMatch(/^UNTRIGGERED_FOLLOWUP: /);
    expect(resultText(results[1])).toBe("UNTRIGGERED_FOLLOWUP: F9 is not a finding of this run.");
    expect(seen).toEqual(["F9", "F2"]);
    expect(h.executed[1]).toEqual({ turn: 2, calls: [expect.objectContaining({ id: "toolu_ok" })] });
    expect(h.pivots).toEqual(["F2"]);
    expect(h.outcome.rejections.map((r) => r.code)).toEqual(["UNTRIGGERED_FOLLOWUP", "UNTRIGGERED_FOLLOWUP"]);
  });

  it("runs an untriggered call naming a plan step that has not run yet as a planned step, not a pivot", async () => {
    // Wave 1 ran S1 only; S2 needed its results, so it runs in turn 2 under its step_id.
    const h = await runScripted([respond([planCall(), peerCall()]), respond([stepCall("toolu_planned", "S2")]), respond([reportCall()])]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_planned"]],
    ]);
    expect(toolResults(lastMessage(h.fake.streamRequests[2]))).toEqual([
      { type: "tool_result", tool_use_id: "toolu_planned", content: expect.stringMatching(/^<qloo_data/) },
    ]);
    expect(h.pivots).toEqual([]);
    expect(h.outcome).toMatchObject({ status: "completed", pivots: [], rejections: [] });
  });

  it("refuses an untriggered step_id that already ran, in turn 1 or earlier in the response", async () => {
    const h = await runScripted([
      respond([planCall(), peerCall()]),
      respond([stepCall("toolu_s2", "S2"), stepCall("toolu_s2_again", "S2"), peerCall("toolu_s1_again")]),
      respond([reportCall()]),
    ]);
    expect(h.executed[1]).toEqual({ turn: 2, calls: [expect.objectContaining({ id: "toolu_s2" })] });
    const results = toolResults(lastMessage(h.fake.streamRequests[2]));
    expect(resultText(results[1])).toBe(
      "UNTRIGGERED_FOLLOWUP: S2 has already run; running it again is a follow-up that cites the finding (F#) that motivates it as trigger_finding_id.",
    );
    expect(resultText(results[2])).toMatch(/^UNTRIGGERED_FOLLOWUP: S1 has already run;/);
    expect(h.outcome.rejections.map((r) => [r.toolCallId, r.code])).toEqual([
      ["toolu_s2_again", "UNTRIGGERED_FOLLOWUP"],
      ["toolu_s1_again", "UNTRIGGERED_FOLLOWUP"],
    ]);
  });

  it("refuses an untriggered step_id that is not a step of the plan", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([stepCall("toolu_s7", "S7")]), respond([reportCall()])]);
    expect(resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0])).toBe(
      "UNTRIGGERED_FOLLOWUP: S7 is not a step of the plan; a follow-up cites the finding (F#) that motivates it as trigger_finding_id.",
    );
    expect(h.executed).toHaveLength(1);
  });

  it("refuses an untriggered call that names an unrun plan step but not the tool that step plans", async () => {
    // S2 plans share_of_taste; the refused call does not use up S2, so the real step still runs.
    const wrongTool = toolUse("toolu_wrong_tool", "audience_dna", { set: ["R1", "R2"], compare_with: null, trigger_finding_id: null, step_id: "S2" });
    const h = await runScripted([respond([planCall(), peerCall()]), respond([wrongTool, stepCall("toolu_planned", "S2")]), respond([reportCall()])]);
    expect(resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0])).toBe(
      "UNTRIGGERED_FOLLOWUP: S2 plans share_of_taste, not audience_dna; a follow-up cites the finding (F#) that motivates it as trigger_finding_id.",
    );
    expect(h.executed[1]).toEqual({ turn: 2, calls: [expect.objectContaining({ id: "toolu_planned" })] });
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_wrong_tool", tool: "audience_dna", code: "UNTRIGGERED_FOLLOWUP", turn: 2 }]);
    expect(h.pivots).toEqual([]);
  });

  it("pivots only on triggered calls, which also count as running the step they name", async () => {
    const h = await runScripted([
      respond([planCall(), peerCall()]),
      respond([stepCall("toolu_triggered", "S2", "F2"), stepCall("toolu_untriggered", "S2"), followUp("toolu_dna", "F1")]),
      respond([reportCall()]),
    ]);
    expect(h.executed[1]?.calls.map((c) => c.id)).toEqual(["toolu_triggered", "toolu_dna"]);
    expect(h.pivots).toEqual(["F2", "F1"]);
    expect(h.outcome.pivots.map((p) => p.toolCallId)).toEqual(["toolu_triggered", "toolu_dna"]);
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_untriggered", tool: "share_of_taste", code: "UNTRIGGERED_FOLLOWUP", turn: 2 }]);
  });

  it("takes the plan steps from the last well-formed plan when the plan kept issues after its repair", async () => {
    const five = { ...validPlan(), hypotheses: [1, 2, 3, 4, 5].map((n) => ({ ...validPlan().hypotheses[0]!, id: `H${n}` })) };
    const h = await runScripted([
      respond([planCall("toolu_five", five)]),
      respond([planCall("toolu_five_again", five), peerCall()]),
      respond([stepCall("toolu_planned", "S2")]),
      respond([reportCall()]),
    ]);
    expect(h.outcome).toMatchObject({ status: "completed", plan: null, submittedPlan: five, pivots: [] });
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_planned"]],
    ]);
  });

  it("refuses every untriggered turn-2 call when the run has no plan", async () => {
    const h = await runScripted([
      respond([text("Let me think about this question.")], "end_turn"),
      respond([peerCall()]),
      respond([stepCall("toolu_s2", "S2")]),
      respond([reportCall()]),
    ]);
    expect(h.outcome.plan).toBeNull();
    expect(h.outcome.rejections.map((r) => [r.toolCallId, r.code])).toEqual([["toolu_s2", "UNTRIGGERED_FOLLOWUP"]]);
    expect(h.executed.map((e) => e.turn)).toEqual([1]);
  });

  it("accepts submit_report in turn 2 and does not run calls made with it", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp(), reportCall()])]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, turn: 2 });
    expect(h.executed).toHaveLength(1);
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_dna", tool: "audience_dna", code: "REPORT_SUBMITTED", turn: 2 }]);
  });
});

describe("report guards", () => {
  it("answers turn-3 tool calls with INVESTIGATION_BUDGET_EXHAUSTED and the report nudge", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp()]), respond([followUp("toolu_more", "F2")]), respond([reportCall()])]);
    const t3 = lastMessage(h.fake.streamRequests[3]);
    expect(resultText(toolResults(t3)[0])).toBe("INVESTIGATION_BUDGET_EXHAUSTED: turn 3 allows only submit_report.");
    expect(textsOf(t3)).toEqual([NUDGE_REPORT]);
    expect(h.executed).toHaveLength(2);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, nudges: { report: true } });
  });

  it("nudges once when a turn ends without submit_report, then ends incomplete", async () => {
    const h = await runScripted([
      respond([planCall(), peerCall()]),
      respond([text("The evidence looks sufficient.")], "end_turn"),
      respond([text("Done.")], "end_turn"),
    ]);
    expect(lastMessage(h.fake.streamRequests[2])).toEqual({ role: "user", content: [{ type: "text", text: NUDGE_REPORT }] });
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "no_report_after_nudge", responses: 3, draft: null });
    expect(h.outcome.plan).toEqual(validPlan());
  });

  it("answers calls made with submit_report in turn 3 with INVESTIGATION_BUDGET_EXHAUSTED", async () => {
    let reviews = 0;
    const h = await runScripted(
      [
        respond([planCall(), peerCall()]),
        respond([followUp()]),
        respond([followUp("toolu_more", "F2"), reportCall("toolu_r1")]),
        respond([reportCall("toolu_r2")]),
      ],
      { reviewReport: () => (reviews++ === 0 ? { ok: false, feedback: "V4: advice phrase in thesis" } : { ok: true }) },
    );
    const repair = toolResults(lastMessage(h.fake.streamRequests[3]));
    expect(repair.map((r) => r.tool_use_id)).toEqual(["toolu_more", "toolu_r1"]);
    expect(resultText(repair[0])).toMatch(/^INVESTIGATION_BUDGET_EXHAUSTED: turn 3 allows only submit_report/);
    expect(resultText(repair[1])).toMatch(/^REPORT_REJECTED: /);
    expect(h.executed).toHaveLength(2);
    expect(h.outcome.rejections.map((r) => [r.toolCallId, r.code, r.turn])).toEqual([
      ["toolu_more", "INVESTIGATION_BUDGET_EXHAUSTED", 3],
      ["toolu_r1", "REPORT_REJECTED", 3],
    ]);
    expect(h.outcome).toMatchObject({ status: "completed", repairs: { report: true } });
  });

  it("without a CHECKER, checks the report limits itself and gives one repair turn", async () => {
    const tooFew = { ...validReport(), arguments: validReport().arguments.slice(0, 1) };
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall("toolu_r1", tooFew)]), respond([reportCall("toolu_r2")])]);
    const repair = toolResults(lastMessage(h.fake.streamRequests[2]));
    expect(repair).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_r1",
        is_error: true,
        content: expect.stringMatching(/^REPORT_REJECTED: fix the issues below[^\n]*only repair turn\.\narguments: Too small/),
      },
    ]);
    expect(h.drafts).toEqual([1, 2]);
    expect(h.outcome).toMatchObject({ status: "completed", reason: null, repairs: { report: true }, draft: validReport() });
  });

  it("accepts a repaired report that still misses its limits, with warnings", async () => {
    const tooFew = { ...validReport(), arguments: [] };
    const h = await runScripted([respond([planCall()]), respond([reportCall("toolu_r1", tooFew)]), respond([reportCall("toolu_r2", tooFew)])]);
    expect(h.outcome).toMatchObject({ status: "completed", code: "report_accepted", draft: tooFew, submittedDraft: tooFew });
    expect(h.outcome.reason).toMatch(/^accepted with warnings after the repair turn: arguments: Too small/);
  });

  it("gives a report without the tool structure one repair, then ends incomplete", async () => {
    const broken = { headline: "Brand Alpha" };
    const h = await runScripted([respond([planCall()]), respond([reportCall("toolu_r1", broken)]), respond([reportCall("toolu_r2", broken)])]);
    expect(resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0])).toMatch(/^INVALID_REPORT: fix these issues/);
    expect(h.drafts).toEqual([]);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "report_invalid", draft: null, submittedDraft: null });
  });

  it("hands the CHECKER every well-formed draft, limits unchecked, so V1–V9 share one repair message", async () => {
    const tooFew = { ...validReport(), arguments: [] };
    const seen: unknown[] = [];
    const h = await runScripted([respond([planCall()]), respond([reportCall("toolu_r1", tooFew)])], {
      reviewReport: (draft, context) => (seen.push([draft, context]), { ok: true }),
    });
    expect(seen).toEqual([[tooFew, { attempt: 1, final: false }]]);
    expect(h.outcome).toMatchObject({ status: "completed", reason: null, draft: tooFew, repairs: { report: false } });
  });

  it("sends CHECKER feedback back once, then accepts the second draft with warnings", async () => {
    const contexts: unknown[] = [];
    const h = await runScripted([respond([planCall()]), respond([reportCall("toolu_r1")]), respond([reportCall("toolu_r2")])], {
      reviewReport: (_draft, context) => (contexts.push(context), { ok: false, feedback: "V3: bare number in thesis\nV5: H2 has no verdict metric" }),
    });
    expect(contexts).toEqual([
      { attempt: 1, final: false },
      { attempt: 2, final: true },
    ]);
    const repair = toolResults(lastMessage(h.fake.streamRequests[2]));
    expect(resultText(repair[0])).toBe(
      "REPORT_REJECTED: fix the issues below and call submit_report once more with the complete report; this is the only repair turn.\n" +
        "V3: bare number in thesis\nV5: H2 has no verdict metric",
    );
    expect(h.outcome).toMatchObject({ status: "completed", code: "report_accepted", repairs: { report: true } });
    expect(h.outcome.reason).toMatch(/^accepted with warnings after the repair turn: V3: bare number/);
  });

  it("marks the review final when no response is left for a repair, and accepts the draft", async () => {
    const contexts: unknown[] = [];
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], {
      limits: { modelResponses: 2 },
      reviewReport: (_draft, context) => (contexts.push(context), { ok: false, feedback: "V5: H2 has no verdict metric" }),
    });
    expect(contexts).toEqual([{ attempt: 1, final: true }]);
    expect(h.outcome).toMatchObject({ status: "completed", code: "report_accepted", responses: 2, repairs: { report: false } });
    expect(h.outcome.reason).toMatch(/^accepted with warnings with no response left for a repair turn: V5/);
  });
});

describe("stop reasons, checked before content", () => {
  it("turns a refusal into a refused outcome and never runs the cut-off tools", async () => {
    const refused = fakeMessage({
      content: [planCall(), peerCall()],
      stop_reason: "refusal",
      stop_details: fakeRefusalDetails({ category: "general_harms" }),
    });
    const h = await runScripted([refused]);
    expect(h.outcome).toMatchObject({ status: "refused", code: "refused", responses: 1, plan: null });
    expect(h.outcome.refusal).toEqual({ category: "general_harms", explanation: "Synthetic refusal for an offline test.", partialOutput: true });
    expect(h.executed).toEqual([]);
    expect(h.plans).toEqual([]);
  });

  it("continues after pause_turn with the paused content as the last message", async () => {
    const paused = respond([thinking("Still working.")], "pause_turn");
    const h = await runScripted([paused, respond([planCall(), peerCall()]), respond([reportCall()])]);
    expect(lastMessage(h.fake.streamRequests[1])).toEqual({ role: "assistant", content: paused.content });
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3 });
  });

  it("fails a turn cut off by max_tokens with a pending tool_use, runs none of its tools and asks once more", async () => {
    const cut = respond([thinking("Planning."), planCall("toolu_cut_plan"), peerCall("toolu_cut_peer")], "max_tokens");
    const h = await runScripted([cut, respond([planCall(), peerCall()]), respond([reportCall()])]);
    const retry = h.fake.streamRequests[1]!;
    expect(retry.messages[1]).toEqual({ role: "assistant", content: cut.content });
    const answers = toolResults(lastMessage(retry));
    expect(answers.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["toolu_cut_plan", true],
      ["toolu_cut_peer", true],
    ]);
    expect(resultText(answers[0])).toMatch(/^TOOL_INPUT_TRUNCATED: /);
    expect(textsOf(lastMessage(retry))).toEqual([NOTICE_TRUNCATED]);
    expect(h.executed).toEqual([{ turn: 1, calls: [expect.objectContaining({ id: "toolu_peer" })] }]);
    expect(h.plans).toHaveLength(1);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, repairs: { truncated: true } });
  });

  it("ends incomplete, not failed, after a second max_tokens cut", async () => {
    const cut = () => respond([planCall(), peerCall()], "max_tokens");
    const h = await runScripted([cut(), cut()]);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "max_tokens_pending_tool", responses: 2 });
    expect(h.outcome.reason).toMatch(/submit_plan, peer_landscape/);
    expect(h.executed).toEqual([]);
  });

  it("ends incomplete when a report cut off by max_tokens leaves no response for a retry", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()], "max_tokens")], { limits: { modelResponses: 2 } });
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "max_tokens_pending_tool", draft: null, repairs: { truncated: false } });
    expect(h.outcome.plan).toEqual(validPlan());
  });

  it("treats max_tokens without a tool call as an ended turn", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([text("cut off mid")], "max_tokens"), respond([reportCall()])]);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([NUDGE_REPORT]);
    expect(h.outcome.status).toBe("completed");
  });
});
