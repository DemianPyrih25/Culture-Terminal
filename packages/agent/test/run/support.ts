// End-to-end harness for runAgent: the scripted fake Anthropic, the real Qloo client over the mock
// transport and the memory store (no network), and helpers that read digests out of the requests.
// Invented entities only (D29).
import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_RUN_LIMITS,
  RunEvent,
  stampEvent,
  type EventInput,
  type Intent,
  type ModelDigest,
  type ReportDraftShape,
  type RunLimits,
  type SubmitPlanInputShape,
} from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type MockFault, type QlooClient } from "@ct/qloo";
import type { AnalystRequest } from "../../src/anthropic";
import { runAgent, type AgentRunOptions, type AgentRunResult } from "../../src/run";
import { fakeGaMessage, FakeAnthropic, respond, text, thinking, toolUse, type StreamScript } from "../support/fake-anthropic";

export const RUN_ID = "run-test-0001";
export const START = Date.parse("2026-10-22T09:00:00.000Z");

export function mockQloo(faults: readonly MockFault[] = [], latencyMs = 0): QlooClient {
  return createQlooClient({
    transport: createMockTransport({ faults, latencyMs }),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "agent-run-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

export function intentFor(partial: Partial<Intent> = {}): Intent {
  return {
    pillar: "investment",
    job: "brand_health",
    mentions: [{ text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false }],
    geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
    safety: { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
    candidates: { named_areas: [], named_markets: [], obvious_entities: [], obvious_areas: [], obvious_markets: [] },
    assumptions: ["US geography"],
    mnemonic: "BRAND ALPHA <BRAND> HLTH",
    ...partial,
  };
}

/** The CLERK's messages.create answer for an intent. */
export const clerkAnswer = (intent: Intent): Anthropic.Message =>
  fakeGaMessage({ content: [{ type: "text", text: JSON.stringify(intent), citations: null }] });

// Reading the requests ------------------------------------------------------------------------------

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Every text the model was sent in user messages: tool results and text blocks, in order. */
export function userTexts(request: AnalystRequest): string[] {
  const out: string[] = [];
  for (const m of request.messages) {
    if (m.role !== "user") continue;
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]);
    for (const b of blocks) {
      if (b.type === "text") out.push(b.text);
      if (b.type === "tool_result") out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}

/** The digests inside every <qloo_data> wrapper the model has seen so far, optionally of one tool mnemonic. */
export function digestsIn(request: AnalystRequest, tool?: string): ModelDigest[] {
  const out: ModelDigest[] = [];
  for (const t of userTexts(request)) {
    for (const m of t.matchAll(/<qloo_data tool="([A-Z]+)"[^>]*>(.*?)<\/qloo_data>/gs)) {
      if (tool === undefined || m[1] === tool) out.push(JSON.parse(m[2] ?? "{}") as ModelDigest);
    }
  }
  return out;
}

export interface SeenIds {
  evidence: string[];
  metrics: string[];
  datasets: string[];
  findings: { id: string; kind: string }[];
}

export function seenIds(request: AnalystRequest): SeenIds {
  const digests = digestsIn(request);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    evidence: uniq(digests.flatMap((d) => d.evidence_ids)),
    metrics: uniq(digests.flatMap((d) => d.metrics.filter((m) => m.badge !== "UNAVAILABLE").map((m) => m.id))),
    datasets: uniq(digests.flatMap((d) => d.dataset_ids)),
    findings: digests.flatMap((d) => d.findings.map((f) => ({ id: f.id, kind: f.kind }))),
  };
}

// Scripted ANALYST turns -------------------------------------------------------------------------------

export function plan(): SubmitPlanInputShape {
  return {
    restated_question: "Is the Brand Alpha audience a moat or a niche?",
    hypotheses: [
      {
        id: "H1",
        statement: "Brand Alpha's nearest taste neighbour sits in its own category.",
        expectation: "A same-category brand ranks first in the Brand Alpha row.",
        test_tool: "peer_landscape",
        metric_hint: "nearest neighbour in the Brand Alpha row",
      },
      {
        id: "H2",
        statement: "Brand Alpha is distinctive against its peers.",
        expectation: "Brand Alpha ranks near the top on distinctiveness.",
        test_tool: "peer_landscape",
        metric_hint: "distinctiveness rank",
      },
    ],
    steps: [{ id: "S1", tool: "peer_landscape", purpose: "Map the near-substitutes of Brand Alpha." }],
    assumptions: ["US geography"],
  };
}

/** A draft that passes the CHECKER, citing only ids the model has seen. */
export function draftFrom(ids: SeenIds, overrides: Partial<ReportDraftShape> = {}): ReportDraftShape {
  const m = (i: number) => ids.metrics[i % ids.metrics.length] ?? "M1";
  const e = (i: number) => ids.evidence[i % ids.evidence.length] ?? "E1";
  const argument = (i: number, section: "competition" | "audience" | "risk") => ({
    id: `A${i + 1}`,
    section,
    qloo_fact: `The Substitution Map measures {{${m(i)}}} for this set [${e(i)}].`,
    our_read: "The audience reads as a distinct niche rather than a crowded field.",
    metric_ids: [m(i)],
    evidence_ids: [e(i)],
  });
  return {
    headline: "Brand Alpha reads as a distinct niche among its taste neighbours",
    signal: "mixed",
    verdict_tag: "Distinct niche",
    thesis: `Brand Alpha sits apart from most of its peers {{${m(0)}}} [${e(0)}].`,
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: [m(0)], note: `The nearest neighbour is measured {{${m(0)}}}.` },
      { hypothesis_id: "H2", verdict: "inconclusive", metric_ids: [m(1)], note: `Distinctiveness reads {{${m(1)}}}.` },
    ],
    arguments: [argument(0, "competition"), argument(1, "audience"), argument(2, "risk")],
    exhibits: ids.datasets.slice(0, 2).map((d) => ({ dataset_id: d, title: "Substitution Map", caption: "Where Brand Alpha sits among peers." })),
    bear_case: [{ text: `A wider peer set could close the gap {{${m(0)}}}.`, metric_ids: [m(0)] }],
    recommendations: [{ action: "Test a partnership with the nearest neighbour.", priority: "next", argument_ids: ["A1"] }],
    next_moves: [
      { label: "Audience", question: "Who is the Brand Alpha audience?" },
      { label: "Head to head", question: "Brand Alpha vs Brand Beta: same customer?" },
    ],
    open_questions: [],
    ...overrides,
  };
}

export const planCall = (input: unknown = plan()) => toolUse("toolu_plan", "submit_plan", input);
export const reportCall = (id: string, draft: ReportDraftShape) => toolUse(id, "submit_report", draft);
export { respond, text, thinking, toolUse };

/** The one line the follow-up nudge asks for when no listed follow-up is run. */
export const NO_FOLLOWUP_REASON = "No listed follow-up could change the signal: the opening scan already decided both priors.";

/**
 * Turn 2 for a model that reports without a follow-up. The opening scan's finding is listed, so the
 * first submit_report meets the follow-up nudge (FOLLOWUP_EXPECTED) and the report goes in again
 * with the line the nudge asks for. `draft` writes each report from what the model has seen.
 */
export function reportWithoutFollowup(draft: (req: AnalystRequest) => ReportDraftShape = (req) => draftFrom(seenIds(req))): StreamScript[] {
  return [
    (req: AnalystRequest) => respond([reportCall("toolu_report_early", draft(req))]),
    (req: AnalystRequest) => respond([reportCall("toolu_report", { ...draft(req), open_questions: [NO_FOLLOWUP_REASON] })]),
  ];
}

// Running ----------------------------------------------------------------------------------------------

export interface Harness {
  result: AgentRunResult;
  events: EventInput[];
  fake: FakeAnthropic;
}

export interface HarnessOptions extends Partial<Omit<AgentRunOptions, "emit" | "anthropic" | "signal" | "limits">> {
  intent?: Intent;
  clerk?: Anthropic.Message | { error: unknown };
  stream?: readonly StreamScript[];
  signal?: AbortSignal;
  limits?: Partial<RunLimits>;
}

export async function run(options: HarnessOptions = {}): Promise<Harness> {
  const events: EventInput[] = [];
  const { intent, clerk, stream, limits, signal, ...rest } = options;
  const fake = new FakeAnthropic({ create: [clerk ?? clerkAnswer(intent ?? intentFor())], stream: stream ?? [] });
  const result = await runAgent({
    runId: RUN_ID,
    question: "Is Brand Alpha's audience a moat or a niche?",
    lane: "public",
    mode: "live",
    ...rest,
    qloo: rest.qloo ?? mockQloo(),
    anthropic: fake,
    emit: (e) => events.push(e),
    signal: signal ?? new AbortController().signal,
    limits: { ...DEFAULT_RUN_LIMITS, ...limits },
  });
  return { result, events, fake };
}

/** Stamps and parses every event with the contracts schema; throws on the first invalid one. */
export function parseAll(events: readonly EventInput[]): RunEvent[] {
  return events.map((e, i) => RunEvent.parse(stampEvent(e, { seq: i + 1, ts: new Date(START + i).toISOString(), runId: RUN_ID })));
}

export const typesOf = (events: readonly EventInput[]): string[] => events.map((e) => e.type);
