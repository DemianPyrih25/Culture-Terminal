// runAgent end to end on what makes a run an ANALYST PIVOT or keeps it going: the FOLLOW-UPS WORTH
// RUNNING line that closes turn 1, the follow-up nudge, a turn 2 kept open after refused input, and a
// tool input the SDK cannot parse (eager input streaming), played through the SDK's own
// BetaMessageStream. Scripted fake Anthropic, the real Qloo client on the mock transport, invented
// entities only (D29).
import { DEFAULT_RUN_LIMITS, Report, type EventInput, type EventInputOf } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { HAIKU_MODEL, SONNET_MODEL, type AnalystRequest } from "../../src/anthropic";
import { FOLLOWUP_NUDGE_ASK, NOTICE_INVALID_JSON, NOTICE_TURN2_OPEN, TURN3_NOTICE, turn2Guide } from "../../src/llm/notices";
import { ESTIMATE_ABORT_LAG_MS, ESTIMATE_OUTPUT_TOKENS_PER_SECOND, unreportedOutputUsd, usdFor } from "../../src/pricing";
import { ManualClock, streamEvents } from "../support/fake-anthropic";
import {
  draftFrom,
  intentFor,
  NO_FOLLOWUP_REASON,
  parseAll,
  plan,
  planCall,
  reportCall,
  reportWithoutFollowup,
  respond,
  run,
  seenIds,
  START,
  thinking,
  toolUse,
  userTexts,
} from "./support";

type Of<T extends EventInput["type"]> = EventInputOf<T>;
const ofType = <T extends EventInput["type"]>(events: readonly EventInput[], type: T): Of<T>[] =>
  events.filter((e): e is Of<T> => e.type === type);

const FOLLOWUPS = /^FOLLOW-UPS WORTH RUNNING: (F\d+) \([a-z -]+\) suggests ([a-z_]+)(?: on ([^;.(]+))?/;

/** The first follow-up the line that closed turn 1 lists: finding, tool and subjects. */
function firstListed(req: AnalystRequest): { finding: string; tool: string; subjects: string[] } {
  const match = userTexts(req)
    .map((t) => FOLLOWUPS.exec(t))
    .find((m) => m !== null);
  if (!match) throw new Error("turn 1 closed without FOLLOW-UPS WORTH RUNNING");
  return { finding: match[1]!, tool: match[2]!, subjects: (match[3] ?? "").split(", ").map((s) => s.trim()).filter((s) => s !== "") };
}

const reportFrom = (req: AnalystRequest) => respond([reportCall("toolu_report", draftFrom(seenIds(req)))]);

/** A share_of_taste follow-up on the first listed lead's subjects, with trigger_finding_id as the model writes it. */
const shareListed = (id: string, req: AnalystRequest, trigger: string | null = firstListed(req).finding) =>
  toolUse(id, "share_of_taste", {
    type: "brand",
    set: ["R1", ...firstListed(req).subjects],
    ages: ["24_and_younger", "55_and_older"],
    audiences: [],
    metros: [],
    trigger_finding_id: trigger,
    step_id: null,
  });

/** The tool_result a request carries for one tool call. */
function resultOf(req: AnalystRequest, toolUseId: string): string {
  for (const m of req.messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    }
  }
  throw new Error(`no tool_result for ${toolUseId}`);
}

describe("runAgent: follow-ups worth running", () => {
  it("lists the scan's finding when turn 1 closes, and a model that runs it makes an ANALYST PIVOT", async () => {
    const { result, events, fake } = await run({
      stream: [
        respond([thinking("Plan first; the scan maps the peers."), planCall(plan())]),
        (req: AnalystRequest) => {
          // The model takes the first listed follow-up as the line words it.
          const { finding, tool, subjects } = firstListed(req);
          return respond([
            toolUse("toolu_listed", tool, {
              type: "brand",
              set: ["R1", ...subjects],
              ages: ["24_and_younger", "55_and_older"],
              audiences: [],
              metros: [],
              trigger_finding_id: finding,
              step_id: null,
            }),
          ]);
        },
        reportFrom,
      ],
    });

    expect(result.status).toBe("completed");
    parseAll(events);
    // The line follows the scan digests and comes right before the guide that asks for a follow-up.
    // The plan's only step names the scan's peer map, which already ran, so no step shares the calls.
    const closing = userTexts(fake.streamRequests[1]!);
    expect(closing.at(-2)).toMatch(FOLLOWUPS);
    expect(closing.at(-2)).not.toMatch(/S1 plans/);
    expect(closing.at(-1)).toBe(turn2Guide(DEFAULT_RUN_LIMITS, { followups: true }));
    // The scan map's NEAR_SUBSTITUTES pair suggests share_of_taste for the pair.
    const listed = firstListed(fake.streamRequests[1]!);
    expect(listed).toEqual({ finding: "F1", tool: "share_of_taste", subjects: ["R2", "R3"] });
    expect(ofType(events, "finding").find((f) => f.finding.id === "F1")?.finding).toMatchObject({
      kind: "NEAR_SUBSTITUTES",
      suggestion: { tool: "share_of_taste" },
    });
    expect(ofType(events, "pivot")).toEqual([expect.objectContaining({ toolCallId: "toolu_listed", tool: "share_of_taste", triggerFindingId: "F1" })]);
    expect(ofType(events, "tool.start").find((e) => e.toolCallId === "toolu_listed")).toMatchObject({ phase: "followup", triggerFindingId: "F1" });
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_listed")).toMatchObject({ ok: true });
  });

  it("lists nothing, and keeps the plain guide, when turn 2 has no Qloo call left: none allowed, or the scan spent the run's", async () => {
    const noFollowups = { ...DEFAULT_RUN_LIMITS, followupCalls: 0 };
    // The opening scan spends every network call this run allows, after the peer map issued F1.
    const smallRun = { ...DEFAULT_RUN_LIMITS, qlooCalls: 10, qlooWarnAt: 9 };
    for (const limits of [noFollowups, smallRun]) {
      const { result, events, fake } = await run({ limits, stream: [respond([planCall(plan())]), reportFrom] });
      expect(result.status).toBe("completed");
      expect(ofType(events, "finding").map((f) => f.finding.suggestion?.tool)).toEqual(["share_of_taste"]);
      const closing = userTexts(fake.streamRequests[1]!);
      expect(closing.some((t) => t.startsWith("FOLLOW-UPS WORTH RUNNING"))).toBe(false);
      expect(closing.at(-1)).toBe(turn2Guide(limits));
      if (limits === smallRun) expect(result.qloo.network).toBe(smallRun.qlooCalls);
    }
  });
});

describe("runAgent: the follow-up nudge", () => {
  it("answers a turn-2 report sent without a follow-up once with the listed leads, and the model's own pick makes the pivot", async () => {
    const { result, events, fake } = await run({
      stream: [
        respond([planCall(plan())]),
        (req: AnalystRequest) => respond([reportCall("toolu_report_early", draftFrom(seenIds(req)))]),
        (req: AnalystRequest) => respond([shareListed("toolu_listed", req)]),
        reportFrom,
      ],
    });

    expect(result.status).toBe("completed");
    parseAll(events);
    // The nudge restates the leads and leaves the call to the model; nothing ran on its behalf.
    const listed = userTexts(fake.streamRequests[1]!).find((t) => FOLLOWUPS.test(t));
    expect(resultOf(fake.streamRequests[2]!, "toolu_report_early")).toBe(
      ["FOLLOWUP_EXPECTED: no follow-up ran in turn 2, so this report was not taken yet.", listed, FOLLOWUP_NUDGE_ASK].join("\n"),
    );
    expect(ofType(events, "tool.start").filter((e) => e.phase === "followup").map((e) => e.toolCallId)).toEqual(["toolu_listed"]);
    expect(ofType(events, "pivot")).toEqual([expect.objectContaining({ toolCallId: "toolu_listed", tool: "share_of_taste", triggerFindingId: "F1" })]);
    // The follow-up closed turn 2; only the reviewed report counts as a draft.
    expect(userTexts(fake.streamRequests[3]!).at(-1)).toBe(TURN3_NOTICE);
    expect(ofType(events, "report.draft").map((d) => d.attempt)).toEqual([1]);
    expect(ofType(events, "validation").map((v) => [v.attempt, v.ok])).toEqual([[1, true]]);
  });

  it("reviews the next report either way, so a model that says why none could help still completes", async () => {
    const { result, events, fake } = await run({ stream: [respond([planCall(plan())]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    expect(fake.streamRequests).toHaveLength(3);
    expect(resultOf(fake.streamRequests[2]!, "toolu_report_early")).toMatch(/^FOLLOWUP_EXPECTED: /);
    expect(ofType(events, "pivot")).toEqual([]);
    expect(ofType(events, "report.draft").map((d) => d.draft.open_questions)).toEqual([[NO_FOLLOWUP_REASON]]);
    parseAll(events);
  });
});

describe("runAgent: a turn 2 whose calls were all refused for their input", () => {
  it("stays open once, naming the field, the fix and the findings to cite, and the corrected call makes the pivot", async () => {
    const { result, events, fake } = await run({
      stream: [
        respond([planCall(plan())]),
        // No trigger and no plan step; then a name where a ref belongs.
        (req: AnalystRequest) =>
          respond([
            shareListed("toolu_untriggered", req, null),
            toolUse("toolu_named", "peer_landscape", { target: "Brand Gamma", peers: [], discover: true, k: 5, trigger_finding_id: "F1", step_id: null }),
          ]),
        // The finding id comes back inside an extra pair of quotes: it is read as the id it wraps.
        (req: AnalystRequest) => respond([shareListed("toolu_corrected", req, '"F1"')]),
        reportFrom,
      ],
    });

    expect(result.status).toBe("completed");
    parseAll(events);
    const reopened = fake.streamRequests[2]!;
    expect(resultOf(reopened, "toolu_untriggered")).toBe(
      "UNTRIGGERED_FOLLOWUP: every turn-2 call cites the finding (F#) that motivates it as trigger_finding_id, except a plan step that has not run yet, " +
        "named by its step_id. Findings you can cite: F1 (near substitutes).",
    );
    expect(resultOf(reopened, "toolu_named")).toBe(
      'INVALID_INPUT: the arguments do not match the tool schema; fix them and call again.\ntarget: expected an entity ref id such as "R1"; got text',
    );
    expect(userTexts(reopened).at(-1)).toBe(NOTICE_TURN2_OPEN);
    expect(ofType(events, "tool.end").filter((e) => e.error?.code === "invalid_tool_input").map((e) => e.toolCallId)).toEqual([
      "toolu_untriggered",
      "toolu_named",
    ]);
    expect(ofType(events, "pivot")).toEqual([
      expect.objectContaining({ toolCallId: "toolu_corrected", triggerFindingId: "F1", args: expect.objectContaining({ trigger_finding_id: "F1" }) }),
    ]);
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_corrected")).toMatchObject({ ok: true });
    expect(userTexts(fake.streamRequests[3]!).at(-1)).toBe(TURN3_NOTICE);
  });
});

describe("runAgent: a tool input the SDK cannot parse", () => {
  const intent = intentFor({
    job: "head_to_head",
    mentions: [
      { text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false },
      { text: "Brand Beta", entity_type: "brand", role: "peer", public_figure: false },
    ],
    mnemonic: "BRAND ALPHA VS BRAND BETA",
  });
  const duelPlan = () => ({
    ...plan(),
    steps: [...plan().steps, { id: "S2", tool: "momentum" as const, purpose: "Read both brands' momentum." }],
  });
  const momentum = (id: string) => toolUse(id, "momentum", { entities: ["R1", "R2"], type: "brand", trigger_finding_id: null, step_id: "S2" });
  /** The live failure: a comma missing between two array elements. */
  const MALFORMED_MOMENTUM = '{"entities": ["R1" "R2"], "type": "brand", "trigger_finding_id": null, "step_id": "S2"}';
  const turnOneUsage = { input_tokens: 2400, cache_creation_input_tokens: 9000, output_tokens: 2200 };

  it("answers the call INVALID_JSON, runs the rest and completes the head_to_head run, charging the reported usage", async () => {
    const clock = new ManualClock();
    clock.advance(START);
    const broken = streamEvents(respond([thinking("Plan, then momentum."), planCall(duelPlan()), momentum("toolu_mom")], "tool_use", turnOneUsage), {
      toolu_mom: MALFORMED_MOMENTUM,
    });
    const { result, events, fake } = await run({
      intent,
      now: clock.now,
      stream: [
        { events: broken, onSend: () => clock.advance(20_000) },
        (req: AnalystRequest) => {
          const listed = firstListed(req);
          return respond([
            momentum("toolu_mom_again"),
            toolUse("toolu_listed", "share_of_taste", {
              type: "brand",
              set: ["R1", ...listed.subjects],
              ages: ["24_and_younger", "55_and_older"],
              audiences: [],
              metros: [],
              trigger_finding_id: listed.finding,
              step_id: null,
            }),
          ]);
        },
        reportFrom,
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.reason).toBeNull();
    parseAll(events);
    expect(ofType(events, "error")).toEqual([]);
    expect(Report.parse(result.report).incomplete).toBe(false);

    // The unparsed call is a failed step in the trace; the plan and the run went on.
    const second = fake.streamRequests[1]!;
    expect(userTexts(second)).toContain(`INVALID_JSON: the tool input was not valid JSON; send the call again.\nreceived: ${JSON.stringify(MALFORMED_MOMENTUM)}`);
    expect(userTexts(second)).toContain(NOTICE_INVALID_JSON);
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_mom")).toMatchObject({ ok: false, error: { code: "invalid_tool_input" } });
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_mom_again")).toMatchObject({ ok: true });
    expect(ofType(events, "plan")).toHaveLength(1);
    expect(ofType(events, "pivot").map((p) => p.toolCallId)).toEqual(["toolu_listed"]);

    // The broken response is charged the usage its message_start reported, plus the output it could
    // have generated in its 20 s, never the per-run worst case.
    const reported = respond([], "tool_use", { ...turnOneUsage, output_tokens: 1 }).usage;
    expect(result.usage.input).toBe(900 + 2400 + 1000 + 1000);
    const clerk = usdFor(HAIKU_MODEL, { input_tokens: 900, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const metered = clerk + usdFor(SONNET_MODEL, reported) + 2 * usdFor(SONNET_MODEL, respond([]).usage);
    const unreported = unreportedOutputUsd(SONNET_MODEL, reported, ((20_000 + ESTIMATE_ABORT_LAG_MS) / 1000) * ESTIMATE_OUTPUT_TOKENS_PER_SECOND - 1);
    expect(result.usd).toBeCloseTo(metered + unreported, 12);
    expect(result.usd).toBeLessThan(DEFAULT_RUN_LIMITS.usdNudge);
    expect(ofType(events, "usage").at(-1)).toMatchObject({ llmUsd: result.usd });
  });
});
