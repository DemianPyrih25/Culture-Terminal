import { DEFAULT_RUN_LIMITS } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { FollowupLead } from "../../src/analyst";
import {
  FOLLOWUP_NUDGE_ASK,
  FOLLOWUP_NUDGE_COMPANION,
  NOTICE_FOLLOWUP_OPEN,
  NOTICE_TRUNCATED,
  NOTICE_TURN2_OPEN,
  NUDGE_PLAN,
  NUDGE_REPORT,
  TURN3_NOTICE,
  turn2Guide,
} from "../../src/llm/notices";
import { usdFor } from "../../src/pricing";
import { fakeMessage, fakeRefusalDetails, ManualClock, respond, text, thinking, toolUse } from "../support/fake-anthropic";
import {
  blocksOf,
  digestFor,
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
      { toolCallId: "toolu_dna", tool: "audience_dna", triggerFindingId: "F1", args: followUp().input, afterNudge: false },
    ]);
    expect(h.outcome.nudges).toEqual({ plan: false, report: false, time: false, cost: false, followup: false });
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
    expect(resultText(result)).toBe(
      [
        "INVALID_INPUT: the arguments do not match the tool schema; fix them and call again.",
        // A name where a ref belongs is described, never echoed.
        'target: expected an entity ref id such as "R1"; got text',
        "k: Too big: expected number to be <=7; got 9",
        "(input): without discovery, name at least 3 peers",
      ].join("\n"),
    );
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

describe("turn 2: follow-ups worth running", () => {
  const lead = (findingId: `F${number}`, kind: FollowupLead["kind"], tool: FollowupLead["tool"], subjects: string[] = []): FollowupLead => ({
    findingId,
    kind,
    tool,
    subjects,
  });
  const CLOSES = "A follow-up on one of them could change the signal or decide a prior.";
  const leads = [
    lead("F1", "GENERATIONAL_SPLIT", "audience_dna", ["R2"]),
    lead("F3", "TASTE_ISLAND", "cross_domain", ["R1"]),
    lead("F4", "OUTSIDE_CATEGORY_NEIGHBOUR", "peer_landscape", ["R6"]),
    lead("F5", "METRO_OUTLIER", "geo_lift"),
  ];
  /** Wave 1 carries out both of validPlan's steps, so no plan step is pending in turn 2. */
  const fullWaveOne = () => respond([planCall(), peerCall(), shareCall()]);

  it("lists up to three after the closing context, hypothesis test tools first, and asks for one in the TURN 2 guide", async () => {
    const h = await runScripted([fullWaveOne(), respond([followUp("toolu_dna", "F1")]), respond([reportCall()])], {
      closingContext: () => ["EVIDENCE (synthetic)"],
      followupLeads: () => leads,
    });
    const texts = textsOf(lastMessage(h.fake.streamRequests[1]));
    expect(texts).toEqual([
      "EVIDENCE (synthetic)",
      "FOLLOW-UPS WORTH RUNNING: F4 (outside-category neighbour) suggests peer_landscape on R6 (the test tool of H1); " +
        `F1 (generational split) suggests audience_dna on R2; F3 (taste island) suggests cross_domain on R1. ${CLOSES}`,
      turn2Guide(DEFAULT_RUN_LIMITS, { followups: true }),
    ]);
    expect(texts[2]).toMatch(
      /^TURN 2: .*Run at least one of the FOLLOW-UPS WORTH RUNNING before submit_report, citing its finding; .*say why in open_questions, naming their F#\.$/,
    );
    expect(h.pivots).toEqual(["F1"]);
  });

  it("puts a lead that tests a hypothesis before retries of empty results, in the caller's order otherwise", async () => {
    const empty = [
      lead("F1", "EMPTY_RESULT", "destination_affinity"),
      lead("F2", "EMPTY_RESULT", "audience_dna"),
      lead("F3", "EMPTY_RESULT", "cross_domain"),
    ];
    const h = await runScripted([fullWaveOne(), respond([reportCall()])], {
      followupLeads: () => [...empty, lead("F4", "OUTSIDE_CATEGORY_NEIGHBOUR", "peer_landscape", ["R6"])],
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))[0]).toBe(
      "FOLLOW-UPS WORTH RUNNING: F4 (outside-category neighbour) suggests peer_landscape on R6 (the test tool of H1); " +
        `F1 (empty result) suggests destination_affinity; F2 (empty result) suggests audience_dna. ${CLOSES}`,
    );
  });

  it("names the pending plan step a lead would replace, and says the two share the follow-up calls", async () => {
    // validPlan's S2 (share_of_taste) has not run after a wave 1 of S1 only.
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], {
      followupLeads: () => [lead("F2", "NEAR_SUBSTITUTES", "share_of_taste", ["R2", "R3"]), lead("F7", "EMPTY_RESULT", "share_of_taste")],
    });
    const texts = textsOf(lastMessage(h.fake.streamRequests[1]));
    expect(texts).toEqual([
      "FOLLOW-UPS WORTH RUNNING: F2 (near substitutes) suggests share_of_taste on R2, R3 " +
        `(the test tool of H2; S2 plans share_of_taste: run it on this finding's subjects instead, citing F2 with step_id null). ${CLOSES}`,
      turn2Guide(DEFAULT_RUN_LIMITS, { followups: true, stepsPending: true }),
    ]);
    expect(texts[1]).toMatch(/ Planned steps and follow-ups share those 8 calls, so keep the follow-up narrow \(fewer entities, ages or markets\)\.$/);
  });

  it("keeps the usual pivot a site_selection plan schedules as a step (LATENT_DEMAND, block_dna)", async () => {
    const sitePlan = { ...validPlan(), steps: [...validPlan().steps, { id: "S3", tool: "block_dna" as const, purpose: "Profile the top-lift area." }] };
    const h = await runScripted([respond([planCall("toolu_plan", sitePlan), peerCall(), shareCall()]), respond([reportCall()])], {
      followupLeads: () => [lead("F3", "LATENT_DEMAND", "block_dna", ["testville:north"])],
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))[0]).toBe(
      "FOLLOW-UPS WORTH RUNNING: F3 (latent demand) suggests block_dna on testville:north " +
        `(S3 plans block_dna: run it on this finding's subjects instead, citing F3 with step_id null). ${CLOSES}`,
    );
  });

  it("keeps the guide without follow-ups when no lead is left: none given, or only a pending step's lead that names no subjects", async () => {
    for (const given of [[], [lead("F2", "NEAR_SUBSTITUTES", "share_of_taste")]]) {
      const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], { followupLeads: () => given });
      const guide = textsOf(lastMessage(h.fake.streamRequests[1]));
      expect(guide).toEqual([turn2Guide(DEFAULT_RUN_LIMITS, { stepsPending: true })]);
      // S2 is still to run: it shares the turn-2 calls with any follow-up on what it finds.
      expect(guide[0]).toMatch(/hypotheses are resolved\. Planned steps share those 8 calls with any follow-up on what they find, so leave room for one\.$/);
    }
  });

  it("lists a lead whose tool the plan uses only in steps that already ran, without a step note", async () => {
    const h = await runScripted([fullWaveOne(), respond([reportCall()])], {
      followupLeads: () => [lead("F2", "NEAR_SUBSTITUTES", "share_of_taste", ["R6"])],
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([
      `FOLLOW-UPS WORTH RUNNING: F2 (near substitutes) suggests share_of_taste on R6 (the test tool of H2). ${CLOSES}`,
      turn2Guide(DEFAULT_RUN_LIMITS, { followups: true }),
    ]);
  });

  it("asks for no follow-ups when turn 3 comes next", async () => {
    let asked = 0;
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], {
      limits: { modelResponses: 2 },
      followupLeads: () => (asked++, leads),
    });
    expect(asked).toBe(0);
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([TURN3_NOTICE]);
  });

  it("fails with hook_error when followupLeads throws", async () => {
    const h = await runScripted([respond([planCall(), peerCall()])], {
      followupLeads: () => {
        throw new Error("ledger offline");
      },
    });
    expect(h.outcome).toMatchObject({ status: "failed", code: "hook_error", reason: "followupLeads failed: ledger offline" });
  });
});

describe("turn 2: the follow-up nudge", () => {
  const listed: FollowupLead[] = [{ findingId: "F1", kind: "OUTSIDE_CATEGORY_NEIGHBOUR", tool: "peer_landscape", subjects: ["R6"] }];
  const LINE =
    "FOLLOW-UPS WORTH RUNNING: F1 (outside-category neighbour) suggests peer_landscape on R6 (the test tool of H1). " +
    "A follow-up on one of them could change the signal or decide a prior.";
  const NUDGE = ["FOLLOWUP_EXPECTED: no follow-up ran in turn 2, so this report was not taken yet.", LINE, FOLLOWUP_NUDGE_ASK].join("\n");
  /** Wave 1 carries out both of validPlan's steps, so no plan step is pending in turn 2. */
  const fullWaveOne = () => respond([planCall(), peerCall(), shareCall()]);
  const pivot = (id = "toolu_pivot") =>
    toolUse(id, "peer_landscape", { target: "R6", peers: ["R1"], discover: true, k: 5, trigger_finding_id: "F1", step_id: null });

  it("answers a turn-2 report sent without a follow-up once with the listed leads, and keeps turn 2 open for the model's pick", async () => {
    const h = await runScripted([fullWaveOne(), respond([reportCall("toolu_r1")]), respond([pivot()]), respond([reportCall("toolu_r2")])], {
      followupLeads: () => listed,
    });
    const nudge = lastMessage(h.fake.streamRequests[2]);
    expect(toolResults(nudge)).toEqual([{ type: "tool_result", tool_use_id: "toolu_r1", is_error: true, content: NUDGE }]);
    expect(textsOf(nudge)).toEqual([]);
    // The follow-up ran as turn 2, the model's own call, and closed the turn.
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer", "toolu_share"]],
      [2, ["toolu_pivot"]],
    ]);
    expect(textsOf(lastMessage(h.fake.streamRequests[3]))).toEqual([TURN3_NOTICE]);
    expect(h.pivots).toEqual(["F1"]);
    // The pivot says it came after the nudge, so a trace can tell it from an unprompted one.
    expect(h.outcome.pivots.map((p) => [p.toolCallId, p.afterNudge])).toEqual([["toolu_pivot", true]]);
    // The nudged report was never reviewed.
    expect(h.drafts).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, turn: 3, nudges: { followup: true, report: false } });
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_r1", tool: "submit_report", code: "FOLLOWUP_EXPECTED", turn: 2 }]);
  });

  it("comes once: the next submit_report is reviewed whether or not a follow-up ran", async () => {
    const reviewed: Array<1 | 2> = [];
    const h = await runScripted([fullWaveOne(), respond([reportCall("toolu_r1")]), respond([reportCall("toolu_r2")])], {
      followupLeads: () => listed,
      reviewReport: (_draft, context) => (reviewed.push(context.attempt), { ok: true }),
    });
    expect(reviewed).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, turn: 2, nudges: { followup: true }, pivots: [] });
  });

  it("does not run the calls made with the nudged report, and asks for them again without it", async () => {
    const h = await runScripted([fullWaveOne(), respond([pivot(), reportCall("toolu_r1")]), respond([pivot("toolu_pivot_again")]), respond([reportCall("toolu_r2")])], {
      followupLeads: () => listed,
    });
    expect(toolResults(lastMessage(h.fake.streamRequests[2])).map((r) => [r.tool_use_id, resultText(r)])).toEqual([
      ["toolu_pivot", `REPORT_SUBMITTED: ${FOLLOWUP_NUDGE_COMPANION}`],
      ["toolu_r1", NUDGE],
    ]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer", "toolu_share"]],
      [2, ["toolu_pivot_again"]],
    ]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4 });
  });

  it("is not sent to a report that already declines the listed leads in an open question naming their finding", async () => {
    const reviewed: Array<1 | 2> = [];
    const declined = { ...validReport(), open_questions: ["F1 could not change the signal: the scan already placed Brand Alpha's nearest peer."] };
    const h = await runScripted([fullWaveOne(), respond([reportCall("toolu_r1", declined)])], {
      followupLeads: () => listed,
      reviewReport: (_draft, context) => (reviewed.push(context.attempt), { ok: true }),
    });
    expect(reviewed).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false }, pivots: [], rejections: [] });
  });

  it("is still sent when the open questions name no listed lead's finding", async () => {
    for (const open of [["Qloo has no sales data, so share of wallet is unknown."], ["F2 and F10 are context, not leads."]]) {
      const h = await runScripted([fullWaveOne(), respond([reportCall("toolu_r1", { ...validReport(), open_questions: open })]), respond([reportCall("toolu_r2")])], {
        followupLeads: () => listed,
      });
      expect(toolResults(lastMessage(h.fake.streamRequests[2]))).toEqual([{ type: "tool_result", tool_use_id: "toolu_r1", is_error: true, content: NUDGE }]);
      expect(h.outcome).toMatchObject({ status: "completed", responses: 3, nudges: { followup: true } });
    }
  });

  it("is not sent when turn 1 listed no follow-up", async () => {
    const h = await runScripted([fullWaveOne(), respond([reportCall()])], { followupLeads: () => [] });
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false } });
  });

  it("is not sent with fewer than three responses left, so the CHECKER repair keeps its response", async () => {
    const h = await runScripted([fullWaveOne(), respond([reportCall()])], { limits: { modelResponses: 4 }, followupLeads: () => listed });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))[0]).toBe(LINE);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false } });
  });

  it("is not sent once a wrap-up notice went out", async () => {
    // 30000 output tokens on Sonnet 5.5 cost $0.30: the turn-2 response itself crosses usdNudge.
    const h = await runScripted([fullWaveOne(), respond([reportCall()], "tool_use", { output_tokens: 30_000 })], {
      limits: { usdNudge: 0.25 },
      followupLeads: () => listed,
    });
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { cost: true, followup: false } });
  });

  it("is not sent once the follow-up's time would run past the soft window, or the repair could pass the cost cap", async () => {
    const clock = new ManualClock();
    const late = { message: respond([reportCall()]), onSend: () => clock.advance(DEFAULT_RUN_LIMITS.softMs - DEFAULT_RUN_LIMITS.followupMs + 1) };
    const timed = await runScripted([fullWaveOne(), late], { now: clock.now, followupLeads: () => listed });
    expect(timed.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false, time: false } });
    // 8000 output tokens make the run's average about $0.04 a response: under a $0.25 cap, two more at
    // that average leave less than a repair's 8000 output tokens alone would cost.
    const tight = await runScripted([respond([planCall(), peerCall(), shareCall()], "tool_use", { output_tokens: 8000 }), respond([reportCall()])], {
      limits: { usdNudge: 0.24, usdHard: 0.25 },
      followupLeads: () => listed,
    });
    expect(tight.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false, cost: false } });
    // The same run under the default caps gets the nudge.
    const roomy = await runScripted([respond([planCall(), peerCall(), shareCall()], "tool_use", { output_tokens: 8000 }), respond([reportCall()]), respond([reportCall("toolu_r2")])], {
      followupLeads: () => listed,
    });
    expect(roomy.outcome).toMatchObject({ status: "completed", responses: 3, nudges: { followup: true } });
  });

  it("asks for the leads again, and is not sent when none is left", async () => {
    let asked = 0;
    const h = await runScripted([fullWaveOne(), respond([reportCall()])], { followupLeads: () => (asked++ === 0 ? listed : []) });
    expect(asked).toBe(2);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 2, nudges: { followup: false } });
  });
});

describe("turn 2: the follow-up nudge after planned steps", () => {
  const listed: FollowupLead[] = [{ findingId: "F1", kind: "OUTSIDE_CATEGORY_NEIGHBOUR", tool: "peer_landscape", subjects: ["R6"] }];
  const LINE =
    "FOLLOW-UPS WORTH RUNNING: F1 (outside-category neighbour) suggests peer_landscape on R6 (the test tool of H1). " +
    "A follow-up on one of them could change the signal or decide a prior.";
  /** Wave 1 carries out S1 only, so validPlan's S2 (share_of_taste) runs in turn 2 as a planned step. */
  const waveOne = () => respond([planCall(), peerCall()]);
  const plannedStep = () => respond([stepCall("toolu_s2", "S2")]);
  const pivot = (id = "toolu_pivot") =>
    toolUse(id, "peer_landscape", { target: "R6", peers: ["R1"], discover: true, k: 5, trigger_finding_id: "F1", step_id: null });

  it("keeps turn 2 open once with the leads when it ran only a planned step, and the model's own pick makes the pivot", async () => {
    const h = await runScripted([waveOne(), plannedStep(), respond([pivot()]), respond([reportCall()])], { followupLeads: () => listed });
    const after = lastMessage(h.fake.streamRequests[2]);
    // The step's result, then the leads as they now stand and the notice in place of TURN 3.
    expect(toolResults(after).map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([["toolu_s2", false]]);
    expect(textsOf(after)).toEqual([LINE, NOTICE_FOLLOWUP_OPEN]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_s2"]],
      [2, ["toolu_pivot"]],
    ]);
    expect(textsOf(lastMessage(h.fake.streamRequests[3]))).toEqual([TURN3_NOTICE]);
    expect(h.pivots).toEqual(["F1"]);
    expect(h.outcome.pivots.map((p) => p.afterNudge)).toEqual([true]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, turn: 3, nudges: { followup: true }, rejections: [] });
  });

  it("lists a lead the planned step itself raised, though turn 1 listed none", async () => {
    let stepRan = false;
    const h = await runScripted([waveOne(), plannedStep(), respond([pivot()]), respond([reportCall()])], {
      executeTools: async (calls, turn) => {
        if (turn === 2 && calls.some((c) => c.id === "toolu_s2")) stepRan = true;
        return calls.map((call) => ({ tool_use_id: call.id, content: digestFor(call) }));
      },
      followupLeads: () => (stepRan ? listed : []),
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([turn2Guide(DEFAULT_RUN_LIMITS, { stepsPending: true })]);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([LINE, NOTICE_FOLLOWUP_OPEN]);
    expect(h.pivots).toEqual(["F1"]);
  });

  it("comes once per run, shared with the nudge on a report: the next submit_report is reviewed", async () => {
    const reviewed: Array<1 | 2> = [];
    const h = await runScripted([waveOne(), plannedStep(), respond([reportCall()])], {
      followupLeads: () => listed,
      reviewReport: (_draft, context) => (reviewed.push(context.attempt), { ok: true }),
    });
    expect(reviewed).toEqual([1]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, turn: 2, nudges: { followup: true }, pivots: [], rejections: [] });
  });

  it("is not sent when a follow-up ran with the step, with fewer than three responses left, after a wrap-up notice or with no lead", async () => {
    const closed = async (script: Parameters<typeof runScripted>[0], options: Parameters<typeof runScripted>[1]) => {
      const h = await runScripted(script, options);
      expect(textsOf(lastMessage(h.fake.streamRequests[2])).at(-1)).toBe(TURN3_NOTICE);
      expect(h.outcome).toMatchObject({ status: "completed", responses: 3, nudges: { followup: false } });
      return h;
    };
    const withPivot = await closed([waveOne(), respond([stepCall("toolu_s2", "S2"), pivot()]), respond([reportCall()])], { followupLeads: () => listed });
    expect(withPivot.pivots).toEqual(["F1"]);
    await closed([waveOne(), plannedStep(), respond([reportCall()])], { limits: { modelResponses: 4 }, followupLeads: () => listed });
    // 30000 output tokens on Sonnet 5.5 cost $0.30: the turn-2 response itself crosses usdNudge.
    const wrapped = await closed([waveOne(), respond([stepCall("toolu_s2", "S2")], "tool_use", { output_tokens: 30_000 }), respond([reportCall()])], {
      limits: { usdNudge: 0.25 },
      followupLeads: () => listed,
    });
    expect(wrapped.outcome.nudges.cost).toBe(true);
    await closed([waveOne(), plannedStep(), respond([reportCall()])], { followupLeads: () => [] });
  });

  it("is not sent when nothing ran: a refused response closes turn 2 once its one reopening is spent", async () => {
    const untriggered = (id: string) => followUp(id, null);
    const h = await runScripted([waveOne(), respond([untriggered("toolu_a")]), respond([untriggered("toolu_b")]), respond([reportCall()])], {
      followupLeads: () => listed,
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[2])).at(-1)).toBe(NOTICE_TURN2_OPEN);
    expect(textsOf(lastMessage(h.fake.streamRequests[3])).at(-1)).toBe(TURN3_NOTICE);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, nudges: { followup: false }, repairs: { input: true } });
  });
});

describe("turn 2: calls all refused for their input", () => {
  const badInput = (id: string) =>
    toolUse(id, "peer_landscape", { target: "Brand Gamma", peers: [], discover: true, k: 5, trigger_finding_id: "F1", step_id: null });

  it("keeps turn 2 open once so the model can correct them", async () => {
    const h = await runScripted(
      [respond([planCall(), peerCall()]), respond([stepCall("toolu_s7", "S7"), badInput("toolu_bad")]), respond([followUp()]), respond([reportCall()])],
      { findings: () => [{ id: "F1", kind: "NEAR_SUBSTITUTES" }] },
    );
    const reopened = lastMessage(h.fake.streamRequests[2]);
    expect(toolResults(reopened).map((r) => resultText(r))).toEqual([
      "UNTRIGGERED_FOLLOWUP: S7 is not a step of the plan; a follow-up cites the finding (F#) that motivates it as trigger_finding_id. " +
        "Findings you can cite: F1 (near substitutes).",
      'INVALID_INPUT: the arguments do not match the tool schema; fix them and call again.\ntarget: expected an entity ref id such as "R1"; got text',
    ]);
    expect(textsOf(reopened)).toEqual([NOTICE_TURN2_OPEN]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_dna"]],
    ]);
    expect(textsOf(lastMessage(h.fake.streamRequests[3]))).toEqual([TURN3_NOTICE]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, repairs: { input: true }, pivots: [expect.objectContaining({ toolCallId: "toolu_dna" })] });
  });

  it("keeps it open only once: a second refused response closes turn 2", async () => {
    const h = await runScripted([
      respond([planCall(), peerCall()]),
      respond([badInput("toolu_bad")]),
      respond([badInput("toolu_bad_again")]),
      respond([reportCall()]),
    ]);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([NOTICE_TURN2_OPEN]);
    expect(textsOf(lastMessage(h.fake.streamRequests[3]))).toEqual([TURN3_NOTICE]);
    expect(h.executed).toHaveLength(1);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, repairs: { input: true } });
  });

  it("closes turn 2 as usual when a call ran, when fewer than three responses are left, or for a lone submit_plan", async () => {
    const ran = await runScripted([respond([planCall(), peerCall()]), respond([followUp(), badInput("toolu_bad")]), respond([reportCall()])]);
    const short = await runScripted([respond([planCall(), peerCall()]), respond([badInput("toolu_bad")]), respond([reportCall()])], {
      limits: { modelResponses: 4 },
    });
    const plan = await runScripted([respond([planCall(), peerCall()]), respond([planCall("toolu_plan_again")]), respond([reportCall()])]);
    for (const h of [ran, short, plan]) {
      expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([TURN3_NOTICE]);
      expect(h.outcome).toMatchObject({ status: "completed", responses: 3, repairs: { input: false } });
    }
  });
});

describe("tool input: ids the run does not have (checkInput)", () => {
  const MARKET_ISSUE = 'metros.0: expected a market id from MARKETS, such as "nashville"; got "coastal_placeholder"';
  /** The run's own check: the made-up market is refused, everything else passes. */
  const checkInput = (_tool: string, input: unknown) =>
    ((input as { metros?: string[] }).metros ?? []).includes("coastal_placeholder") ? [MARKET_ISSUE] : [];
  const madeUp = (id: string) => toolUse(id, "share_of_taste", { ...(shareCall().input as object), metros: ["coastal_placeholder"], trigger_finding_id: "F1", step_id: null });

  it("refuses a follow-up whose market the run does not have before it counts as a pivot, and turn 2 stays open for the fix", async () => {
    const h = await runScripted(
      [respond([planCall(), peerCall()]), respond([madeUp("toolu_made_up")]), respond([followUp()]), respond([reportCall()])],
      { checkInput },
    );
    const reopened = lastMessage(h.fake.streamRequests[2]);
    expect(toolResults(reopened).map((r) => [r.is_error, resultText(r)])).toEqual([
      [true, `INVALID_INPUT: the arguments name ids this run does not have; fix them and call again.\n${MARKET_ISSUE}`],
    ]);
    expect(textsOf(reopened)).toEqual([NOTICE_TURN2_OPEN]);
    expect(h.executed.map((e) => e.calls.map((c) => c.id))).toEqual([["toolu_peer"], ["toolu_dna"]]);
    expect(h.outcome.pivots.map((p) => p.toolCallId)).toEqual(["toolu_dna"]);
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_made_up", tool: "share_of_taste", code: "INVALID_INPUT", turn: 2 }]);
  });

  it("refuses such a call in wave 1 too and runs the rest; a throwing check fails the run", async () => {
    const wave = await runScripted([respond([planCall(), peerCall(), madeUp("toolu_made_up")]), respond([reportCall()])], { checkInput });
    expect(wave.executed[0]?.calls.map((c) => c.id)).toEqual(["toolu_peer"]);
    expect(wave.outcome.rejections.map((r) => [r.toolCallId, r.code, r.turn])).toEqual([["toolu_made_up", "INVALID_INPUT", 1]]);
    const broken = await runScripted([respond([planCall(), peerCall()])], {
      checkInput: () => {
        throw new Error("markets offline");
      },
    });
    expect(broken.outcome).toMatchObject({ status: "failed", code: "hook_error", reason: "checkInput failed: markets offline" });
  });
});

describe("turn 2: the findings a refused follow-up could cite", () => {
  it("names them, or says there is none, when the findings hook is given; otherwise the answer is unchanged", async () => {
    const answer = async (options: Parameters<typeof runScripted>[1]) => {
      const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp("toolu_unknown", "F9")]), respond([reportCall()]), respond([reportCall()])], options);
      return resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0]);
    };
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `F${i + 1}` as const, kind: "EMPTY_RESULT" as const }));
    expect(await answer({ findings: () => [{ id: "F1", kind: "NEAR_SUBSTITUTES" }, { id: "F2", kind: "GENERATIONAL_SPLIT" }] })).toBe(
      "UNTRIGGERED_FOLLOWUP: F9 is not a finding of this run. Findings you can cite: F1 (near substitutes), F2 (generational split).",
    );
    expect(await answer({ findings: () => [] })).toBe("UNTRIGGERED_FOLLOWUP: F9 is not a finding of this run. This run has no findings to cite yet.");
    expect(await answer({ findings: () => many })).toMatch(/F8 \(empty result\) and 2 more\.$/);
    expect(await answer({})).toBe("UNTRIGGERED_FOLLOWUP: F9 is not a finding of this run.");
  });

  it("fails with hook_error when the findings hook throws", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp("toolu_none", null)])], {
      findings: () => {
        throw new Error("ledger offline");
      },
    });
    expect(h.outcome).toMatchObject({ status: "failed", code: "hook_error", reason: "findings failed: ledger offline" });
  });
});

describe("tool input: an id inside an extra pair of quotes", () => {
  it("runs a planned step whose step_id came quoted, under the step it names", async () => {
    const quoted = stepCall("toolu_quoted", '"S2"');
    const h = await runScripted([respond([planCall(), peerCall()]), respond([quoted]), respond([reportCall()])]);
    expect(h.executed[1]).toEqual({ turn: 2, calls: [expect.objectContaining({ id: "toolu_quoted", input: expect.objectContaining({ step_id: "S2" }) })] });
    expect(h.outcome).toMatchObject({ status: "completed", pivots: [], rejections: [] });
  });

  it("reads a quoted trigger_finding_id and quoted refs as the ids they wrap", async () => {
    const quoted = toolUse("toolu_quoted", "audience_dna", { set: ['"R1"', "R2"], compare_with: '"R2"', trigger_finding_id: '"F1"', step_id: null });
    const h = await runScripted([respond([planCall(), peerCall()]), respond([quoted]), respond([reportCall()])]);
    expect(h.executed[1]?.calls[0]?.input).toEqual({ set: ["R1", "R2"], compare_with: "R2", trigger_finding_id: "F1", step_id: null });
    expect(h.pivots).toEqual(["F1"]);
  });

  it("still refuses an id of the wrong kind once unwrapped, and a quoted value that holds no id", async () => {
    const wrongKind = stepCall("toolu_wrong", '"F2"');
    const noId = stepCall("toolu_text", '"step two"');
    const h = await runScripted([respond([planCall(), peerCall()]), respond([wrongKind, noId]), respond([stepCall("toolu_s2", "S2")]), respond([reportCall()])]);
    const results = toolResults(lastMessage(h.fake.streamRequests[2]));
    expect(results.map((r) => resultText(r).split("\n")[1])).toEqual([
      'step_id: expected a plan step id such as "S1" or null; got "F2"',
      'step_id: expected a plan step id such as "S1" or null; got a quoted string',
    ]);
    expect(h.outcome.rejections.map((r) => r.code)).toEqual(["INVALID_INPUT", "INVALID_INPUT"]);
  });

  it("leaves free text alone: a mention that reads like a quoted id is searched as written", async () => {
    const resolve = toolUse("toolu_res", "resolve_entities", {
      mentions: [{ text: '"R2"', type: "brand", metro: null }],
      trigger_finding_id: null,
      step_id: "S1",
    });
    const h = await runScripted([respond([planCall(), resolve]), respond([reportCall()])]);
    expect(h.executed[0]?.calls[0]?.input).toEqual(resolve.input);
  });
});

describe("turn 2: plan steps the opening scan carried out", () => {
  const lead = (findingId: `F${number}`, tool: FollowupLead["tool"], subjects: string[] = []): FollowupLead => ({
    findingId,
    kind: "NEAR_SUBSTITUTES",
    tool,
    subjects,
  });

  it("never calls a step that names a scan call still to run, in the leads or the guide", async () => {
    // validPlan's S1 (peer_landscape) is the scan's peer map; wave 1 ran S2 only.
    const h = await runScripted([respond([planCall(), shareCall()]), respond([reportCall()])], {
      scanTools: () => ["peer_landscape"],
      followupLeads: () => [lead("F1", "peer_landscape", ["R6"]), lead("F2", "peer_landscape")],
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([
      "FOLLOW-UPS WORTH RUNNING: F1 (near substitutes) suggests peer_landscape on R6 (the test tool of H1); " +
        "F2 (near substitutes) suggests peer_landscape (the test tool of H1). A follow-up on one of them could change the signal or decide a prior.",
      turn2Guide(DEFAULT_RUN_LIMITS, { followups: true }),
    ]);
  });

  it("covers one step per scan call, so a second step of the same tool stays to run", async () => {
    const twoPeerSteps = { ...validPlan(), steps: [...validPlan().steps, { id: "S3", tool: "peer_landscape" as const, purpose: "Map the new peer." }] };
    const h = await runScripted([respond([planCall("toolu_plan", twoPeerSteps), shareCall()]), respond([reportCall()])], {
      scanTools: () => ["peer_landscape"],
      followupLeads: () => [lead("F1", "peer_landscape", ["R6"])],
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))[0]).toMatch(/\(the test tool of H1; S3 plans peer_landscape: run it on this finding's subjects instead/);
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))[1]).toBe(turn2Guide(DEFAULT_RUN_LIMITS, { followups: true, stepsPending: true }));
  });

  it("still runs such a step once under its step_id: the planned-step rule reads the model's own calls", async () => {
    const h = await runScripted([respond([planCall(), shareCall()]), respond([peerCall("toolu_s1")]), respond([reportCall()])], { scanTools: () => ["peer_landscape"] });
    expect(h.executed[1]).toEqual({ turn: 2, calls: [expect.objectContaining({ id: "toolu_s1" })] });
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
