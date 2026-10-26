// runAgent with a preset intent (AgentRunOptions.intent, from a preview): CLERK is skipped, its
// event and the safety checks are not. The scripted fake Anthropic answers no CLERK request, so any
// CLERK call fails the test. Invented entities only (D29).
import { DEFAULT_RUN_LIMITS, Report, type EventInput, type Intent } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { runAgent, type AgentRunResult } from "../../src/run";
import { FakeAnthropic, type StreamScript } from "../support/fake-anthropic";
import { intentFor, mockQloo, parseAll, planCall, reportWithoutFollowup, respond, run, RUN_ID, typesOf } from "./support";

interface PresetRun {
  result: AgentRunResult;
  events: EventInput[];
  fake: FakeAnthropic;
}

async function runWithPreset(intent: Intent, stream: readonly StreamScript[] = [], signal = new AbortController().signal): Promise<PresetRun> {
  const events: EventInput[] = [];
  const fake = new FakeAnthropic({ create: [], stream });
  const result = await runAgent({
    runId: RUN_ID,
    question: "Is Brand Alpha's audience a moat or a niche?",
    lane: "public",
    mode: "live",
    qloo: mockQloo(),
    anthropic: fake,
    emit: (e) => events.push(e),
    signal,
    limits: DEFAULT_RUN_LIMITS,
    intent,
  });
  return { result, events, fake };
}

/** Turn 1 submits the plan while the scan runs; turn 2 submits a report citing the scan, again after the follow-up nudge. */
const shortScript = (): StreamScript[] => [respond([planCall()]), ...reportWithoutFollowup()];

describe("runAgent with a preset intent", () => {
  it("skips CLERK: no CLERK request or spend, the clerk event at 0 ms, then the gate and scan as usual", async () => {
    const intent = intentFor();
    const { result, events, fake } = await runWithPreset(intent, shortScript());

    expect(fake.createRequests).toHaveLength(0);
    expect(result.status).toBe("completed");
    expect(events[0]?.type).toBe("run.created");
    expect(events[1]).toEqual({ type: "clerk", intent, ms: 0 });
    expect(typesOf(events)).toContain("resolve");
    expect(result.intent).toEqual(intent);
    // Only the three ANALYST responses are billed.
    expect(result.usage.input).toBe(3 * 1000);
    const report = Report.parse(result.report);
    expect(report.receipt.numbersTraced.traced).toBe(report.receipt.numbersTraced.total);
    expect(report.receipt.models.clerk).toBe("claude-haiku-5-5");
    parseAll(events);

    // The same run with CLERK costs CLERK's response on top.
    const viaClerk = await run({ intent, stream: shortScript() });
    expect(viaClerk.fake.createRequests).toHaveLength(1);
    expect(viaClerk.result.usage.input).toBe(900 + 3 * 1000);
    expect(result.usd).toBeLessThan(viaClerk.result.usd);
  });

  it("normalises the preset intent: the pillar follows the job and the mnemonic is recompiled", async () => {
    const intent = intentFor({ pillar: "audience", mnemonic: "ANYTHING" });
    const { events } = await runWithPreset(intent, shortScript());
    expect(events[1]).toMatchObject({ type: "clerk", intent: { pillar: "investment", mnemonic: "BRAND ALPHA <BRAND> HLTH" } });
  });

  it("still refuses a preset intent that fails the safety checks, with no model call and no spend", async () => {
    const reframe = "Group-level taste profile of a neighbourhood for a commercial concept";
    const unsafe = await runWithPreset(intentFor({ safety: { allowed: false, category: "residential_screening", reframe } }));
    expect(unsafe.result).toMatchObject({ status: "refused", reason: reframe, report: null, intent: null, usd: 0 });
    expect(typesOf(unsafe.events)).toEqual(["run.created", "clerk", "usage"]);
    expect(unsafe.fake.streamRequests).toHaveLength(0);

    const privatePerson = await runWithPreset(
      intentFor({ mentions: [{ text: "Rowan Vale", entity_type: "person", role: "primary", public_figure: false }] }),
    );
    expect(privatePerson.result.status).toBe("refused");
    expect(typesOf(privatePerson.events)).not.toContain("qloo");
    parseAll(privatePerson.events);
  });

  it("ends cancelled before the clerk event when the run is already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, events } = await runWithPreset(intentFor(), [], controller.signal);
    expect(result.status).toBe("cancelled");
    expect(typesOf(events)).toEqual(["run.created", "usage"]);
  });
});
