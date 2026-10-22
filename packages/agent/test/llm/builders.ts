// Test-only builders: valid submit inputs, tool calls and a runAnalyst harness (invented entities only).
import {
  DEFAULT_RUN_LIMITS,
  type FindingId,
  type ReportDraft,
  type RunLimits,
  type SubmitPlanInput,
  type SubmitPlanInputShape,
} from "@ct/contracts";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runAnalyst,
  type AnalystOptions,
  type AnalystOutcome,
  type AnalystToolCall,
  type AnalystToolEnd,
  type AnalystToolResult,
  type AnalystTurn,
} from "../../src/analyst";
import { FakeAnthropic, toolUse, type StreamScript } from "../support/fake-anthropic";

export const SYSTEM_PROMPT = "You are the ANALYST of a synthetic test desk. Use the tools.";
export const FIRST_MESSAGE = "RUN CONTEXT (synthetic)\n<user_question>Is Brand Alpha a moat or a niche?</user_question>";

export function validPlan(): SubmitPlanInput {
  return {
    restated_question: "Is the Brand Alpha audience a moat or a niche?",
    hypotheses: [
      {
        id: "H1",
        statement: "Brand Alpha's closest taste neighbour sits outside its category.",
        expectation: "A brand from another category ranks first in the Brand Alpha row.",
        test_tool: "peer_landscape",
        metric_hint: "rank of the nearest peer in the Brand Alpha row",
      },
      {
        id: "H2",
        statement: "Its audience skews young against its peers.",
        expectation: "Positive youth tilt above the set median.",
        test_tool: "share_of_taste",
        metric_hint: "youth tilt",
      },
    ],
    steps: [
      { id: "S1", tool: "peer_landscape", purpose: "Map near-substitutes." },
      { id: "S2", tool: "share_of_taste", purpose: "Check generational skew." },
    ],
    assumptions: ["US geography"],
  };
}

export function validReport(): ReportDraft {
  const argument = (id: "A1" | "A2" | "A3", section: "audience" | "competition" | "risk") => ({
    id,
    section,
    qloo_fact: "The matrix places the brand apart from its category {{M1}} [E1].",
    our_read: "The audience is distinct, which reads as a niche with loyalty.",
    metric_ids: ["M1" as const],
    evidence_ids: ["E1" as const],
  });
  return {
    headline: "Brand Alpha: a distinct niche with a young tilt",
    signal: "mixed",
    thesis: "Brand Alpha's audience sits apart from its category {{M1}} [E1].",
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M1"], note: "Nearest neighbour is outside the category {{M1}}." },
      { hypothesis_id: "H2", verdict: "inconclusive", metric_ids: ["M2"], note: "Youth tilt is close to the median {{M2}}." },
    ],
    arguments: [argument("A1", "competition"), argument("A2", "audience"), argument("A3", "risk")],
    exhibits: [{ dataset_id: "D1", title: "Substitution Map", caption: "Where the brand sits among its peers." }],
    bear_case: [{ text: "A wider peer set could close the gap {{M1}}.", metric_ids: ["M1"] }],
    recommendations: [{ action: "Test a cross-category partnership.", priority: "next", argument_ids: ["A1"] }],
    next_moves: [
      { label: "Footwear crossover", question: "Which footwear brands share Brand Alpha's audience?" },
      { label: "Markets", question: "Where does Brand Alpha win against Brand Beta?" },
    ],
    open_questions: [],
  };
}

export const planCall = (id = "toolu_plan", input: unknown = validPlan()) => toolUse(id, "submit_plan", input);
export const reportCall = (id = "toolu_report", input: unknown = validReport()) => toolUse(id, "submit_report", input);
export const peerCall = (id = "toolu_peer") =>
  toolUse(id, "peer_landscape", { target: "R1", peers: ["R2"], discover: true, k: 6, trigger_finding_id: null, step_id: "S1" });
export const shareCall = (id = "toolu_share") =>
  toolUse(id, "share_of_taste", {
    type: "brand",
    set: ["R1", "R2"],
    ages: ["24_and_younger", "55_and_older"],
    audiences: [],
    metros: [],
    trigger_finding_id: null,
    step_id: "S2",
  });
/** share_of_taste carrying `step` (validPlan has S1 and S2) and `trigger`, for the turn-2 planned-step rule. */
export const stepCall = (id: string, step: string | null, trigger: string | null = null) =>
  toolUse(id, "share_of_taste", { ...(shareCall().input as object), trigger_finding_id: trigger, step_id: step });
/** A follow-up citing `trigger`; the default harness knows findings F1 and F2. */
export const followUp = (id = "toolu_dna", trigger: string | null = "F1") =>
  toolUse(id, "audience_dna", { set: ["R1", "R2"], compare_with: null, trigger_finding_id: trigger, step_id: null });

export const digestFor = (call: AnalystToolCall): string => `<qloo_data tool="${call.name}">{"synthetic":true}</qloo_data>`;

export interface Harness {
  outcome: AnalystOutcome;
  fake: FakeAnthropic;
  executed: Array<{ calls: AnalystToolCall[]; turn: AnalystTurn }>;
  toolEnds: AnalystToolEnd[];
  notes: string[];
  usages: Array<{ usd: number; model: string }>;
  plans: Array<{ plan: SubmitPlanInputShape; issues: readonly string[] }>;
  /** The attempt of every onReportDraft call. */
  drafts: Array<1 | 2>;
  pivots: FindingId[];
}

export type HarnessOptions = Partial<Omit<AnalystOptions, "client" | "limits">> & { limits?: Partial<RunLimits> };

/** Runs the loop against a scripted fake with a default executor and records every observer call. */
export async function runScripted(script: readonly StreamScript[], options: HarnessOptions = {}): Promise<Harness> {
  const fake = new FakeAnthropic({ stream: script });
  const executed: Harness["executed"] = [];
  const toolEnds: AnalystToolEnd[] = [];
  const notes: string[] = [];
  const usages: Harness["usages"] = [];
  const plans: Harness["plans"] = [];
  const drafts: Harness["drafts"] = [];
  const pivots: FindingId[] = [];
  const { limits, ...rest } = options;
  const outcome = await runAnalyst({
    client: fake,
    model: "live",
    systemPrompt: SYSTEM_PROMPT,
    firstUserMessage: FIRST_MESSAGE,
    findingExists: (id) => id === "F1" || id === "F2",
    executeTools: async (calls, turn) => {
      executed.push({ calls, turn });
      return calls.map((call): AnalystToolResult => ({ tool_use_id: call.id, content: digestFor(call) }));
    },
    onToolEnd: (end) => toolEnds.push(end),
    onThinking: (note) => notes.push(note),
    onUsage: (_usage, usd, model) => usages.push({ usd, model }),
    onPlan: (plan, issues) => plans.push({ plan, issues }),
    onReportDraft: (_draft, attempt) => drafts.push(attempt),
    onPivot: (pivot) => pivots.push(pivot.triggerFindingId),
    ...rest,
    limits: { ...DEFAULT_RUN_LIMITS, ...limits },
  });
  return { outcome, fake, executed, toolEnds, notes, usages, plans, drafts, pivots };
}

// Request inspection ----------------------------------------------------------------------------------

type Block = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

export const blocksOf = (m: MessageParam | undefined): Block[] =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : ((m?.content ?? []) as Block[]);
export const lastMessage = (request: { messages: MessageParam[] } | undefined): MessageParam | undefined =>
  request?.messages[request.messages.length - 1];
export const toolResults = (m: MessageParam | undefined): Anthropic.Beta.BetaToolResultBlockParam[] =>
  blocksOf(m).filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result");
export const textsOf = (m: MessageParam | undefined): string[] => blocksOf(m).flatMap((b) => (b.type === "text" ? [b.text] : []));
export const resultText = (r: Anthropic.Beta.BetaToolResultBlockParam | undefined): string =>
  typeof r?.content === "string" ? r.content : JSON.stringify(r?.content);
