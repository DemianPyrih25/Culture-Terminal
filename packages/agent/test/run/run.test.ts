// runAgent end to end: the scripted fake Anthropic, the real Qloo client over the mock transport and
// the memory store. No network; invented entities only (D29).
import type Anthropic from "@anthropic-ai/sdk";
import { Report, type EventInput, type EventInputOf, type RunEvent } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type Transport } from "@ct/qloo";
import { searchParams, normaliseName, SKILL_LIMITATIONS } from "@ct/quant";
import { describe, expect, it } from "vitest";
import type { AnalystRequest } from "../../src/anthropic";
import { INCOMPLETE_HEADLINE, NO_DATA_DISCLAIMER } from "../../src/assemble";
import { NOTICE_TIME, TURN3_NOTICE } from "../../src/llm/notices";
import { findPickerChoice } from "../../src/run/picker";
import { RUN_CONTEXT_LABELS } from "../../src/run/context";
import { SCAN_RESULTS_HEADER } from "../../src/run/agentRun";
import { PRIVATE_PERSON_REASON } from "../../src/run/gate";
import { QLOO_DISABLED_NOTICE } from "../../src/run/tools";
import { fakeGaMessage, ManualClock, type StreamScript } from "../support/fake-anthropic";
import {
  digestsIn,
  draftFrom,
  intentFor,
  mockQloo,
  parseAll,
  plan,
  planCall,
  reportCall,
  respond,
  run,
  seenIds,
  text,
  thinking,
  toolUse,
  typesOf,
  userTexts,
} from "./support";

type Of<T extends EventInput["type"]> = EventInputOf<T>;
const ofType = <T extends EventInput["type"]>(events: readonly EventInput[], type: T): Of<T>[] =>
  events.filter((e): e is Of<T> => e.type === type);

/** Asserts that each predicate matches an event after the previous match. */
function expectInOrder(events: readonly EventInput[], steps: readonly [string, (e: EventInput) => boolean][]): void {
  let at = -1;
  for (const [label, match] of steps) {
    const next = events.findIndex((e, i) => i > at && match(e));
    expect(next, `${label} should follow event #${at}`).toBeGreaterThan(at);
    at = next;
  }
}

const is =
  <T extends EventInput["type"]>(type: T, where: (e: Of<T>) => boolean = () => true) =>
  (e: EventInput): boolean =>
    e.type === type && where(e as Of<T>);

const planWithResolve = () => ({
  ...plan(),
  steps: [...plan().steps, { id: "S2", tool: "resolve_entities" as const, purpose: "Resolve the named rival." }],
});

/** Turn 1: plan plus one wave-1 call; turn 2: a pivot on the scan's first finding; turn 3: the report. */
function brandHealthScript(): StreamScript[] {
  return [
    respond([
      thinking("Map the peers first, then test the priors."),
      planCall(planWithResolve()),
      toolUse("toolu_res", "resolve_entities", {
        mentions: [{ text: "Brand Beta", type: "brand", metro: null }],
        trigger_finding_id: null,
        step_id: "S2",
      }),
    ]),
    (req: AnalystRequest) => {
      const finding = seenIds(req).findings[0];
      const peer = digestsIn(req, "SUBS")[0]?.registered[0];
      if (finding === undefined || peer === undefined) throw new Error("the scan digest carries no finding or peer");
      return respond([
        toolUse("toolu_pivot", "peer_landscape", {
          target: peer.ref,
          peers: [],
          discover: true,
          k: 4,
          trigger_finding_id: finding.id,
          step_id: null,
        }),
      ]);
    },
    (req: AnalystRequest) => respond([reportCall("toolu_report", draftFrom(seenIds(req)))]),
  ];
}

describe("runAgent: a brand_health run", () => {
  it("runs CLERK → gate → scan ∥ turn 1 → pivot → report → CHECKER → ASSEMBLE, in event order", async () => {
    const { result, events, fake } = await run({ stream: brandHealthScript() });

    expect(result.status).toBe("completed");
    expect(result.reason).toBeNull();
    const parsed: RunEvent[] = parseAll(events);
    expect(parsed).toHaveLength(events.length);

    expect(events[0]).toMatchObject({ type: "run.created", mode: "live", lane: "public", model: "claude-sonnet-5-5", parentRunId: null });
    expect(events[1]?.type).toBe("clerk");
    expect(events.at(-1)?.type).toBe("usage");
    expect(typesOf(events)).not.toContain("error");
    expectInOrder(events, [
      ["run.created", is("run.created")],
      ["clerk", is("clerk")],
      ["gate /search", is("qloo", (e) => e.toolCallId === null && e.endpoint === "/search")],
      ["resolve", is("resolve", (e) => e.entities.every((m) => m.source === "gate"))],
      ["plan", is("plan")],
      ["wave-1 tool.start", is("tool.start", (e) => e.toolCallId === "toolu_res" && e.phase === "wave1" && e.stepId === "S2")],
      ["finding", is("finding")],
      ["pivot", is("pivot", (e) => e.toolCallId === "toolu_pivot")],
      ["follow-up tool.start", is("tool.start", (e) => e.toolCallId === "toolu_pivot" && e.phase === "followup" && e.triggerFindingId !== null)],
      ["follow-up qloo", is("qloo", (e) => e.toolCallId === "toolu_pivot")],
      ["follow-up tool.end", is("tool.end", (e) => e.toolCallId === "toolu_pivot" && e.ok)],
      ["report.draft", is("report.draft", (e) => e.attempt === 1)],
      ["validation", is("validation", (e) => e.ok && e.attempt === 1)],
      ["report.final", is("report.final")],
      ["usage", is("usage")],
    ]);

    // The gate resolved the primary; the scan ran as its own tool call, after the gate.
    expect(ofType(events, "resolve")[0]?.entities).toEqual([
      expect.objectContaining({ mention: "Brand Alpha", role: "primary", match: "exact", ref: "R1", source: "gate" }),
    ]);
    const scanStart = ofType(events, "tool.start").find((e) => e.toolCallId === "scan-1");
    expect(scanStart).toMatchObject({ tool: "peer_landscape", phase: "scan", stepId: null, triggerFindingId: null, estimatedCalls: 7 });
    expect(scanStart?.args).toMatchObject({ target: "R1", discover: true, k: 6 });
    expect(ofType(events, "qloo").filter((e) => e.toolCallId === "scan-1")).toHaveLength(7);
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "scan-1")).toMatchObject({ ok: true, status: "ok" });
    expect(ofType(events, "plan")[0]?.estimates).toEqual([
      { stepId: "S1", calls: 0 },
      { stepId: "S2", calls: 1 },
    ]);
    const pivot = ofType(events, "pivot")[0];
    expect(ofType(events, "finding").some((f) => f.finding.id === pivot?.triggerFindingId)).toBe(true);
    expect(ofType(events, "note").length).toBeGreaterThan(0);

    // The report: valid, Scorecard first, every number traced.
    const report = Report.parse(result.report);
    expect(report.incomplete).toBe(false);
    expect(report.verdict.signal).toBe("mixed");
    expect(report.exhibits[0]?.kind).toBe("Scorecard");
    expect(report.scorecard.map((r) => r.hypothesisId)).toEqual(["H1", "H2"]);
    expect(report.receipt.numbersTraced.total).toBeGreaterThan(0);
    expect(report.receipt.numbersTraced.traced).toBe(report.receipt.numbersTraced.total);
    expect(report.receipt.models).toEqual({ clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null });
    expect(ofType(events, "report.final")[0]?.report).toEqual(result.report);

    // The result agrees with the receipt and the last usage event.
    expect(result.intent?.job).toBe("brand_health");
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.validation?.numbersTraced).toEqual(report.receipt.numbersTraced);
    expect(result.qloo).toEqual({ network: report.receipt.qlooNetwork, cached: report.receipt.qlooCached, reused: 0 });
    expect(result.qloo.network).toBeGreaterThan(7);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.usage.input).toBe(900 + 3 * 1000);
    const lastUsage = ofType(events, "usage").at(-1);
    expect(lastUsage).toMatchObject({ llmUsd: result.usd, tokens: result.usage, qloo: result.qloo });
    expect(result.ledger.evidence.filter((e) => e.status === "ok").length).toBeGreaterThanOrEqual(3);
    expect(result.ledger.datasets[result.ledger.datasets.length - 1]?.kind).toBe("Scorecard");

    // The model saw labelled blocks in order, the scan's digests with turn 1's results, and no Qloo ids.
    const first = fake.streamRequests[0];
    const context = String(first?.messages[0]?.content);
    const positions = RUN_CONTEXT_LABELS.map((label) => context.indexOf(`\n${label}`) + 1 || context.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(context.indexOf("<user_question>")).toBeGreaterThan(positions.at(-1) ?? 0);
    expect(context).toContain('{"ref":"R1","name":"Brand Alpha","type":"brand"');
    expect(context).toContain("peer_landscape (SUBS) for R1, discovery on, k 6: running now, about 7 network calls.");
    const second = fake.streamRequests[1];
    expect(second && userTexts(second)).toContain(SCAN_RESULTS_HEADER);
    expect(second && digestsIn(second, "SUBS")).toHaveLength(1);
    for (const r of fake.streamRequests) expect(JSON.stringify(r.messages)).not.toContain("mock-ent-");
  });

  it("serves a second identical run from the cache: no network calls", async () => {
    const qloo = mockQloo();
    const first = await run({ qloo, stream: brandHealthScript() });
    const second = await run({ qloo, runId: "run-test-0002", stream: brandHealthScript() });

    expect(first.result.qloo.network).toBeGreaterThan(0);
    expect(second.result.status).toBe("completed");
    expect(second.result.qloo.network).toBe(0);
    const caches = ofType(second.events, "qloo").map((e) => e.cache);
    expect(caches.length).toBe(first.result.qloo.network + first.result.qloo.cached);
    expect(caches.every((c) => c === "hit" || c === "reused")).toBe(true);
    expect(second.result.report?.receipt.qlooNetwork).toBe(0);
    expect(second.result.report?.receipt.qlooReused).toBeGreaterThan(0);
    parseAll(second.events);
  });
});

describe("runAgent: the resolution gate", () => {
  it("stops with a picker when the primary target has no exact match", async () => {
    const intent = intentFor({ mentions: [{ text: "Brand Notfound", entity_type: "brand", role: "primary", public_figure: false }] });
    const { result, events, fake } = await run({ intent });

    expect(result).toMatchObject({ status: "needs_input", report: null, model: null, validation: null });
    expect(result.reason).toContain("pick the one you mean");
    expect(result.intent?.job).toBe("brand_health");
    expect(typesOf(events)).toEqual(["run.created", "clerk", "qloo", "resolve", "needs_input", "usage"]);
    expect(fake.streamRequests).toHaveLength(0);
    const picker = ofType(events, "needs_input")[0];
    expect(picker).toMatchObject({ mention: "Brand Notfound", entityType: "brand", reason: "not_found" });
    expect(picker?.candidates.length).toBeGreaterThan(1);
    for (const c of picker?.candidates ?? []) expect(c.key).toMatch(/^pk_[0-9a-f]{16}$/);
    expect(ofType(events, "resolve")[0]?.entities[0]).toMatchObject({ match: "not_found", ref: null, source: "gate" });
    expect(JSON.stringify(events)).not.toContain("mock-ent-");
    parseAll(events);
  });

  it("resolves the picker's answer as a pin on the next run", async () => {
    const qloo = mockQloo();
    const mention = { text: "Brand Notfound", entity_type: "brand" as const, role: "primary" as const, public_figure: false };
    const intent = intentFor({ mentions: [mention] });
    const asked = await run({ qloo, intent });
    const choice = ofType(asked.events, "needs_input")[0]?.candidates[1];
    if (choice === undefined) throw new Error("no candidate");

    // The server maps the key back through the same /search (cached, so free).
    const params = searchParams({ text: mention.text, type: "brand", metro: null });
    if (params === null) throw new Error("no params");
    const search = await qloo.standalone().forTool(null).search(params);
    expect(search.meta.cache).not.toBe("miss");
    const picked = findPickerChoice(search.data.results, choice.key);
    if (picked === null) throw new Error("the key does not map back");

    const { result, events } = await run({
      qloo,
      intent,
      runId: "run-test-0003",
      pins: { [normaliseName(mention.text)]: picked.entity_id },
      stream: [respond([planCall()]), (req: AnalystRequest) => respond([reportCall("toolu_report", draftFrom(seenIds(req)))])],
    });
    expect(result.status).toBe("completed");
    expect(ofType(events, "resolve")[0]?.entities[0]).toMatchObject({ match: "exact", ref: "R1", name: choice.name, source: "gate" });
    parseAll(events);
  });

  it("offers exact ties as an ambiguous picker", async () => {
    const intent = intentFor({ mentions: [{ text: "Brand Twin", entity_type: "brand", role: "primary", public_figure: false }] });
    const { result, events } = await run({ intent });
    expect(result.status).toBe("needs_input");
    const picker = ofType(events, "needs_input")[0];
    expect(picker?.reason).toBe("ambiguous");
    expect(picker?.candidates.slice(0, 2).map((c) => c.disambiguation)).toEqual(["2004", "2019"]);
  });
});

describe("runAgent: refusals", () => {
  it("refuses on CLERK's safety call with the group-level reframe and makes no Qloo call", async () => {
    const reframe = "Group-level taste profile of a neighbourhood for a commercial concept";
    const intent = intentFor({ safety: { allowed: false, category: "residential_screening", reframe } });
    const { result, events, fake } = await run({ intent });
    expect(result).toMatchObject({ status: "refused", reason: reframe, report: null, intent: null, model: null });
    expect(typesOf(events)).toEqual(["run.created", "clerk", "usage"]);
    expect(fake.streamRequests).toHaveLength(0);
    expect(result.usd).toBeGreaterThan(0);
    parseAll(events);
  });

  it("refuses on a refusal category even when CLERK marked the question allowed", async () => {
    const intent = intentFor({ safety: { allowed: true, category: "injection", reframe: null } });
    const { result } = await run({ intent });
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("injection");
  });

  it("refuses when the CLERK request itself is refused", async () => {
    const refusal = fakeGaMessage({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Synthetic refusal.", recommended_model: null } as Anthropic.Message["stop_details"],
    });
    const { result, events } = await run({ clerk: refusal });
    expect(result).toMatchObject({ status: "refused", reason: "Synthetic refusal.", intent: null });
    expect(typesOf(events)).toEqual(["run.created", "usage"]);
  });

  it("fails with an llm_error event when CLERK cannot answer", async () => {
    const { result, events } = await run({ clerk: { error: new Error("synthetic outage") } });
    expect(result.status).toBe("failed");
    expect(ofType(events, "error")[0]).toMatchObject({ code: "llm_error" });
    parseAll(events);
  });
});

describe("runAgent: fail-closed and stop paths", () => {
  it("with Qloo disabled makes no Qloo call and the note comes out insufficient_evidence (V7)", async () => {
    const { result, events, fake } = await run({
      qlooEnabled: false,
      limits: { modelResponses: 2 },
      stream: [
        respond([
          planCall(),
          toolUse("toolu_peer", "peer_landscape", { target: "R1", peers: [], discover: true, k: 6, trigger_finding_id: null, step_id: "S1" }),
        ]),
        respond([reportCall("toolu_report", draftFrom({ evidence: ["E1"], metrics: ["M1"], datasets: [], findings: [] }, { signal: "strong" }))]),
      ],
    });
    expect(result.status).toBe("completed");
    expect(ofType(events, "qloo")).toHaveLength(0);
    expect(ofType(events, "resolve")).toHaveLength(0);
    expect(ofType(events, "tool.start").map((e) => e.toolCallId)).toEqual(["toolu_peer"]);
    expect(ofType(events, "tool.end")[0]).toMatchObject({ ok: false, status: "error" });
    const report = Report.parse(result.report);
    expect(report.verdict.signal).toBe("insufficient_evidence");
    expect(report.disclaimers).toContain(NO_DATA_DISCLAIMER);
    expect(report.receipt.qlooNetwork + report.receipt.qlooCached + report.receipt.qlooReused).toBe(0);
    expect(result.validation?.issues.some((i) => i.rule === "V7" && i.action === "forced")).toBe(true);
    const context = String(fake.streamRequests[0]?.messages[0]?.content);
    expect(context).toContain("Qloo: disabled for this run");
    expect(context).toContain("REGISTRY: empty");
    expect(fake.streamRequests[1] && userTexts(fake.streamRequests[1]).join("\n")).toContain(QLOO_DISABLED_NOTICE);
    parseAll(events);
  });

  it("returns cancelled when the caller aborts mid-run, with no report and nothing after the abort", async () => {
    const controller = new AbortController();
    const { result, events } = await run({
      signal: controller.signal,
      stream: [respond([planCall()]), { hang: true, onSend: () => controller.abort() }],
    });
    expect(result).toMatchObject({ status: "cancelled", report: null, reason: "the run was cancelled" });
    expect(typesOf(events)).not.toContain("report.final");
    expect(typesOf(events)).not.toContain("error");
    expect(events.at(-1)?.type).toBe("usage");
    const starts = ofType(events, "tool.start").map((e) => e.toolCallId);
    const ends = ofType(events, "tool.end").map((e) => e.toolCallId);
    expect(ends).toEqual(expect.arrayContaining(starts));
    parseAll(events);
  });

  it("stops an in-flight scan on cancel and still closes its tool call", async () => {
    const controller = new AbortController();
    const { result, events } = await run({
      qloo: mockQloo([], 25),
      signal: controller.signal,
      stream: [{ message: respond([planCall()]), onSend: () => setTimeout(() => controller.abort(), 5) }],
    });
    expect(result.status).toBe("cancelled");
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "scan-1")).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "cancelled" },
    });
    expect(events.at(-1)?.type).toBe("usage");
    parseAll(events);
  });

  it("gives the CHECKER's rejection one repair turn, then accepts the corrected draft", async () => {
    const { result, events, fake } = await run({
      stream: [
        respond([planCall()]),
        (req: AnalystRequest) =>
          respond([reportCall("toolu_report", draftFrom(seenIds(req), { thesis: "Brand Alpha sits apart {{M99}} [E1]." }))]),
        (req: AnalystRequest) => respond([reportCall("toolu_report_2", draftFrom(seenIds(req)))]),
      ],
    });
    expect(result.status).toBe("completed");
    const validations = ofType(events, "validation");
    expect(validations.map((v) => [v.attempt, v.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(validations[0]?.issues.some((i) => i.action === "reject" && i.subjects.includes("M99"))).toBe(true);
    expect(ofType(events, "report.draft").map((d) => d.attempt)).toEqual([1, 2]);
    const repair = fake.streamRequests[2];
    expect(repair && userTexts(repair).join("\n")).toContain("CHECKER rejected the report");
    expect(result.report?.verdict.thesis).not.toContain("M99");
    parseAll(events);
  });

  it("stops at the hard wall clock on the run's own clock and still delivers the evidence digest", async () => {
    const clock = new ManualClock();
    const { result, events } = await run({
      now: clock.now,
      stream: [
        { message: respond([planCall()]), onSend: () => clock.advance(5_000) },
        { message: respond([text("Still thinking.")], "end_turn"), onSend: () => clock.advance(200_000) },
      ],
    });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("hard wall-clock limit");
    expect(result.elapsedMs).toBe(205_000);
    expect(result.report?.incomplete).toBe(true);
    expect(result.report?.receipt.ms).toBe(205_000);
    parseAll(events);
  });

  it("closes turn 1 with follow-up advice only while turn 2 follows, and with the V7 outcome alone before TURN 3", async () => {
    const report = (req: AnalystRequest) => respond([reportCall("toolu_report", draftFrom(seenIds(req)))]);
    const evidenceLine = (texts: readonly string[]) => texts.find((t) => t.startsWith("EVIDENCE:"));

    const early = await run({ stream: [respond([planCall()]), report] });
    const turn2 = early.fake.streamRequests[1];
    const earlyTexts = turn2 ? userTexts(turn2) : [];
    expect(evidenceLine(earlyTexts)).toContain("follow up on the finding");
    expect(earlyTexts.at(-1)).toMatch(/^TURN 2:/);

    // Wave 1 finishes past the wrap-up time: the same thin evidence, but submit_report is the only call left.
    const clock = new ManualClock();
    const late = await run({
      now: clock.now,
      stream: [{ message: respond([planCall()]), onSend: () => clock.advance(125_000) }, report],
    });
    const turn3 = late.fake.streamRequests[1];
    const lateTexts = turn3 ? userTexts(turn3) : [];
    expect(evidenceLine(lateTexts)).toMatch(/forced to insufficient_evidence \(V7\)/);
    expect(evidenceLine(lateTexts)).not.toMatch(/follow up/i);
    expect(lateTexts).toContain(NOTICE_TIME);
    expect(lateTexts.at(-1)).toBe(TURN3_NOTICE);
    parseAll(late.events);
  });

  it("fails with an llm_error event after an ANALYST API error, keeping the evidence digest", async () => {
    const { result, events } = await run({ stream: [respond([planCall()]), { error: new Error("synthetic stream failure") }] });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("synthetic stream failure");
    expect(result.report?.incomplete).toBe(true);
    expect(typesOf(events).slice(-3)).toEqual(["report.final", "error", "usage"]);
    expect(ofType(events, "error")[0]).toMatchObject({ code: "llm_error", retryable: false });
    parseAll(events);
  });

  it("builds the INCOMPLETE evidence digest when no report comes after the nudge", async () => {
    const { result, events } = await run({
      stream: [respond([planCall()]), respond([text("The map speaks for itself.")], "end_turn"), respond([text("Done.")], "end_turn")],
    });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("nudge");
    const report = Report.parse(result.report);
    expect(report).toMatchObject({ incomplete: true, arguments: [] });
    expect(report.verdict).toMatchObject({ headline: INCOMPLETE_HEADLINE, signal: "insufficient_evidence" });
    expect(report.exhibits.map((x) => x.kind)).toEqual(["Scorecard", "Matrix"]);
    expect(report.limitations.some((l) => l.flag === "INCOMPLETE_RUN")).toBe(true);
    expect(typesOf(events).slice(-2)).toEqual(["report.final", "usage"]);
    parseAll(events);
  });
});

describe("runAgent: budgets and the gate's drops", () => {
  /** The mock transport, made to hang (until the run stops it) once `slow` is set. */
  function slowableQloo() {
    const state = { slow: false };
    const base = createMockTransport();
    const transport: Transport = async (request, signal) => {
      if (state.slow) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
      }
      return base(request, signal);
    };
    const qloo = createQlooClient({
      transport,
      env: "mock",
      baseUrl: "https://mock.invalid",
      tag: "agent-run-test",
      tagCap: null,
      rps: 1000,
      store: createMemoryQlooStore(),
    });
    return { qloo, state };
  }

  it("cuts turn 2 at the follow-up time budget (D24) and still reaches submit_report", async () => {
    const { qloo, state } = slowableQloo();
    const [turn1, pivot, report] = brandHealthScript();
    if (turn1 === undefined || typeof pivot !== "function" || report === undefined) throw new Error("script");
    const started = Date.now();
    const { result, events } = await run({
      qloo,
      limits: { followupMs: 50 },
      stream: [
        turn1,
        (req: AnalystRequest, i: number) => {
          // From here on every Qloo request hangs: only the follow-up deadline can end turn 2.
          state.slow = true;
          return pivot(req, i);
        },
        report,
      ],
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe("completed");
    const end = ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_pivot");
    expect(end).toMatchObject({ error: null });
    expect(end?.flags).toContain("BUDGET_TRUNCATED");
    expect(ofType(events, "qloo").some((e) => e.toolCallId === "toolu_pivot")).toBe(true);
    expect(Report.parse(result.report).incomplete).toBe(false);
    parseAll(events);
  });

  it("reports a dropped secondary mention under its SECONDARY_ENTITY_DROPPED flag, ahead of the desk bullets", async () => {
    const intent = intentFor({
      mentions: [
        { text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false },
        { text: "Brand Notfound", entity_type: "brand", role: "secondary", public_figure: false },
      ],
    });
    const { result, events } = await run({ intent, stream: brandHealthScript() });
    expect(result.status).toBe("completed");

    const bundle = ofType(events, "evidence").find((e) => e.evidence.flags.includes("SECONDARY_ENTITY_DROPPED"));
    expect(bundle?.evidence).toMatchObject({ skill: "resolve_entities", status: "partial", qlooCallIds: expect.any(Array) });
    expect(bundle?.evidence.qlooCallIds).toHaveLength(2);
    expectInOrder(events, [
      ["resolve", is("resolve")],
      ["gate evidence", is("evidence", (e) => e.evidence.id === bundle?.evidence.id)],
      ["plan", is("plan")],
    ]);

    const limitations = Report.parse(result.report).limitations;
    const flagAt = limitations.findIndex((l) => l.source === "flag" && l.flag === "SECONDARY_ENTITY_DROPPED");
    const firstDesk = limitations.findIndex((l) => l.source === "desk");
    expect(flagAt).toBeGreaterThanOrEqual(0);
    expect(flagAt).toBeLessThan(firstDesk);
    const texts = limitations.map((l) => l.text);
    expect(texts.some((t) => t.includes("'Brand Notfound' not found"))).toBe(true);
    for (const line of [...SKILL_LIMITATIONS.resolve_entities, ...SKILL_LIMITATIONS.peer_landscape]) {
      expect(texts.some((t) => t.startsWith(line.replace(/\.$/, "")))).toBe(true);
    }
    parseAll(events);
  });

  it("refuses a primary private person in code even with Qloo disabled", async () => {
    const intent = intentFor({ mentions: [{ text: "Pat Example", entity_type: "person", role: "primary", public_figure: false }] });
    const { result, events, fake } = await run({ intent, qlooEnabled: false });
    expect(result).toMatchObject({ status: "refused", reason: PRIVATE_PERSON_REASON, report: null, intent: null, model: null });
    expect(typesOf(events)).toEqual(["run.created", "clerk", "usage"]);
    expect(fake.streamRequests).toHaveLength(0);
  });

  it("never sends a secondary private person to Qloo, even when the ANALYST asks resolve_entities for it", async () => {
    const intent = intentFor({
      mentions: [
        { text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false },
        { text: "Pat Example", entity_type: "person", role: "secondary", public_figure: false },
      ],
    });
    const { result, events, fake } = await run({
      intent,
      stream: [
        respond([
          planCall(planWithResolve()),
          toolUse("toolu_res", "resolve_entities", {
            // The CLERK-marked private person, under any type and spelling that normalises to it.
            mentions: [
              { text: "pat  EXAMPLE", type: "person", metro: null },
              { text: "Brand Beta", type: "brand", metro: null },
            ],
            trigger_finding_id: null,
            step_id: "S2",
          }),
        ]),
        (req: AnalystRequest) => respond([reportCall("toolu_report", draftFrom(seenIds(req)))]),
      ],
    });
    expect(result.status).toBe("completed");
    const searched = ofType(events, "qloo").flatMap((e) => Object.values(e.paramsRedacted));
    expect(searched.some((v) => normaliseName(v) === normaliseName("Pat Example"))).toBe(false);
    expect(ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_res")).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "invalid_tool_input" },
    });
    const answer = fake.streamRequests[1] && userTexts(fake.streamRequests[1]).find((t) => t.includes("pat  EXAMPLE"));
    expect(answer).toMatch(/^INVALID_INPUT: 'pat {2}EXAMPLE' is a person the question did not name as a public figure/);
    parseAll(events);
  });

  it("counts CLERK's spend against the run's cost cap", async () => {
    const refused = await run({ intent: intentFor({ safety: { allowed: false, category: "out_of_scope", reframe: "Ask about a brand." } }) });
    const clerkUsd = refused.result.usd;
    expect(clerkUsd).toBeGreaterThan(0);

    const { result, events, fake } = await run({ limits: { usdNudge: clerkUsd, usdHard: clerkUsd }, stream: [respond([planCall()])] });
    expect(fake.streamRequests).toHaveLength(0);
    expect(result.status).toBe("incomplete");
    expect(result.reason).toBe(`the next response could pass the per-run cost cap of $${clerkUsd}`);
    expect(result.usd).toBe(clerkUsd);
    expect(ofType(events, "run.created")[0]?.limits).toMatchObject({ usdHard: clerkUsd });
    parseAll(events);
  });
});
