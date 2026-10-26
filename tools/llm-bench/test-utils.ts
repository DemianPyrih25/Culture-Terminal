// Test-only builders: valid submit inputs and scripted ANALYST responses (invented entities only).
import type { Anthropic, ReportDraft, SubmitPlanInput } from "./deps";
import { fakeMessage, fakeUsage, toolUse } from "./fakes";

export function validPlan(): SubmitPlanInput {
  return {
    restated_question: "Is the Juniper Cola audience a moat or a niche?",
    hypotheses: [
      {
        id: "H1",
        statement: "Juniper Cola's closest taste neighbour sits outside the soda category.",
        expectation: "A non-beverage brand ranks first in the Juniper Cola row.",
        test_tool: "peer_landscape",
        metric_hint: "rank of the nearest peer in the Juniper Cola row",
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
    headline: "Juniper Cola: a distinct niche with a young tilt",
    signal: "mixed",
    verdict_tag: "Distinct niche",
    thesis: "Juniper Cola's audience sits apart from its category {{M1}} [E1].",
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M1"], note: "Nearest neighbour is outside the category {{M1}}." },
      { hypothesis_id: "H2", verdict: "inconclusive", metric_ids: ["M2"], note: "Youth tilt is close to the median {{M2}}." },
    ],
    arguments: [argument("A1", "competition"), argument("A2", "audience"), argument("A3", "risk")],
    exhibits: [{ dataset_id: "D1", title: "Substitution Map", caption: "Where the brand sits among its peers." }],
    bear_case: [{ text: "A wider peer set could close the gap {{M1}}.", metric_ids: ["M1"] }],
    recommendations: [{ action: "Test a cross-category partnership.", priority: "next", argument_ids: ["A1"] }],
    next_moves: [
      { label: "Footwear crossover", question: "Which footwear brands share Juniper Cola's audience?" },
      { label: "Markets", question: "Where does Juniper Cola win against Marlowe Ridge Sparkling?" },
    ],
    open_questions: [],
  };
}

type Content = Anthropic.Beta.BetaContentBlock[];

export function respond(
  content: Content,
  stopReason: Anthropic.Beta.BetaStopReason = "tool_use",
  usage: Partial<Anthropic.Beta.BetaUsage> = {},
): Anthropic.Beta.BetaMessage {
  return fakeMessage({ content, stop_reason: stopReason, usage: fakeUsage(usage) });
}

export const planCall = (id = "toolu_plan") => toolUse(id, "submit_plan", validPlan());
export const reportCall = (id = "toolu_report") => toolUse(id, "submit_report", validReport());
export const peerCall = (id = "toolu_peer") =>
  toolUse(id, "peer_landscape", { target: "R1", peers: ["R2"], discover: true, k: 6, trigger_finding_id: null, step_id: "S1" });
export const shareCall = (id = "toolu_share") =>
  toolUse(id, "share_of_taste", {
    type: "brand",
    set: ["R1", "R2"],
    ages: ["24_and_younger", "25_to_29", "45_to_54", "55_and_older"],
    audiences: [],
    metros: ["nashville", "denver"],
    trigger_finding_id: null,
    step_id: "S2",
  });
/** A follow-up; the opening scan always issues F1. */
export const dnaFollowUp = (id = "toolu_dna", trigger: string | null = "F1") =>
  toolUse(id, "audience_dna", { set: ["R1", "R2"], compare_with: null, trigger_finding_id: trigger, step_id: null });
