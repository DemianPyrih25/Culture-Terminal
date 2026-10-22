import {
  AudienceKey,
  JOB_MNEMONIC,
  type Evidence,
  PILLAR_LABEL,
  type GeoApi,
  type Intent,
  type MetroId,
  type Pillar,
  type RunLimits,
  type SkillId,
} from "@ct/contracts";
import { audienceDenial, sanitizeQlooName, sanitizeQlooText } from "@ct/qloo";
import type { AnalystMode } from "../anthropic";
import { MIN_OK_EVIDENCE } from "../checker";
import { wrapQuestion } from "../clerk";
import type { RunRegistry } from "../registry";
import { toolLabel } from "./catalogue";
import { describeScanStep, type ScanPlan } from "./scan";

/**
 * The ANALYST's first user message (director.md §1 "The first user message"): labelled blocks
 * written by code, in this order: TODAY, MODE, DESK, JOB, BUDGET, CLERK, REGISTRY, MARKETS,
 * AUDIENCES, AREAS, OPENING SCAN, UNAVAILABLE TOOLS, CASE SUMMARY, then the wrapped question.
 * Everything per run lives here, never in the system prompt, so the cached prefix stays frozen.
 * Text that came from the user or from Qloo is escaped so it can never open or close a tag.
 */

export const RUN_CONTEXT_LABELS = [
  "TODAY",
  "MODE",
  "DESK",
  "JOB",
  "BUDGET",
  "CLERK",
  "REGISTRY",
  "MARKETS",
  "AUDIENCES",
  "AREAS",
  "OPENING SCAN",
  "UNAVAILABLE TOOLS",
  "CASE SUMMARY",
] as const;

/**
 * Leaf audience URNs the build can offer the model. No audience catalogue ships yet, so AUDIENCES
 * reads "none"; a catalogue joins here and is filtered by the desk allowlist (D21).
 */
export const AUDIENCE_CATALOGUE: readonly string[] = [];

export interface ScanSummary {
  plan: ScanPlan;
  /** Estimated network calls per scan step (toolCallId), null when unknown. */
  estimates: ReadonlyMap<string, number | null>;
}

export interface RunContextInput {
  /** YYYY-MM-DD. */
  today: string;
  mode: AnalystMode;
  intent: Intent;
  limits: RunLimits;
  registry: RunRegistry;
  geo: GeoApi;
  scan: ScanSummary;
  unavailable: readonly SkillId[];
  qlooEnabled: boolean;
  caseSummary: string | null;
  /** The raw question; wrapQuestion sanitises, caps and wraps it. */
  question: string;
}

const NONE = "none in this build";
const NAME_MAX = 80;

/** Untrusted text (the user's, CLERK's, Qloo's) with its angle brackets escaped, so it can never open or close a tag. */
export const escapeAngles = (s: string): string => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON whose angle brackets are escaped, the way wrapQlooData escapes digests. */
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The line that closes turn 1 while fewer than MIN_OK_EVIDENCE bundles are ok, so the ANALYST knows
 * that reporting now ends in insufficient_evidence (V7) before it chooses between follow-ups and
 * submit_report. When turn 3 comes next (`followups` false: a wrap-up notice went out or one
 * response is left), it only states the V7 outcome, since submit_report is the only call left. Null
 * at or above the minimum, and with Qloo disabled, where V7 forces the signal whatever the ANALYST does.
 */
export function evidenceStatus(
  evidence: readonly Pick<Evidence, "id" | "status">[],
  qlooEnabled: boolean,
  followups: boolean,
): string | null {
  if (!qlooEnabled) return null;
  const ok = evidence.filter((e) => e.status === "ok").map((e) => e.id);
  if (ok.length >= MIN_OK_EVIDENCE) return null;
  const held = ok.length === 0 ? "no evidence bundle is ok" : `${ok.length} evidence bundle${ok.length === 1 ? " is" : "s are"} ok (${ok.join(", ")})`;
  if (!followups) {
    return (
      `EVIDENCE: ${held}. With fewer than ${MIN_OK_EVIDENCE} ok bundles the signal is forced to insufficient_evidence (V7); ` +
      "say in the report what the missing evidence leaves open."
    );
  }
  return (
    `EVIDENCE: ${held}. A report submitted with fewer than ${MIN_OK_EVIDENCE} ok bundles is forced to insufficient_evidence (V7), ` +
    "even when the priors look resolved. Before submit_report, follow up on the finding most likely to change the signal " +
    "with an available tool; submit now only if none can add an ok bundle."
  );
}

/** Allowlisted audience keys for the desk: well-formed leaf URNs that D21 allows. */
export function audienceKeysFor(pillar: Pillar, catalogue: readonly string[] = AUDIENCE_CATALOGUE): string[] {
  return catalogue.filter((k) => AudienceKey.safeParse(k).success && audienceDenial(k, pillar) === null);
}

function budgetBlock(input: RunContextInput): string {
  const { limits } = input;
  const s = (ms: number) => `${Math.round(ms / 1000)} s`;
  if (!input.qlooEnabled) {
    return [
      "BUDGET:",
      "- Qloo: disabled for this run. Every tool answers with no data, so the note can only be insufficient_evidence.",
      `- Time: wrap-up notice at ${s(limits.softMs)}, hard stop at ${s(limits.hardMs)}.`,
      `- Model responses: at most ${limits.modelResponses}, nudges and the CHECKER repair included.`,
    ].join("\n");
  }
  const scanCalls = [...input.scan.estimates.values()].reduce<number>((n, c) => n + (c ?? 0), 0);
  return [
    "BUDGET:",
    `- Qloo network calls: ${limits.qlooCalls} for the run (warning at ${limits.qlooWarnAt}); cached requests are free.`,
    `- Opening scan: about ${scanCalls} network calls of that budget.`,
    `- Turn 2: up to ${limits.followupCalls} network calls and about ${s(limits.followupMs)}.`,
    `- Time: wrap-up notice at ${s(limits.softMs)}, hard stop at ${s(limits.hardMs)}.`,
    `- Model responses: at most ${limits.modelResponses}, nudges and the CHECKER repair included.`,
  ].join("\n");
}

function registryBlock(registry: RunRegistry): string {
  const rows = registry.registryTable().map((r) => ({
    ref: r.ref,
    name: sanitizeQlooName(r.name, NAME_MAX),
    type: r.type,
    disambiguation: r.disambiguation === null ? null : sanitizeQlooText(r.disambiguation, NAME_MAX),
    popularity: r.popularity,
  }));
  return rows.length === 0 ? "REGISTRY: empty (no entity resolved)" : `REGISTRY:\n${rows.map((r) => safeJson(r)).join("\n")}`;
}

function areasBlock(geo: GeoApi, metro: MetroId | null): string {
  const metros = metro === null ? geo.metros() : [metro];
  const areas = metros.flatMap((m) => geo.neighbourhoods(m).map((n) => `${n.id} (${escapeAngles(n.name)}, ${m})`));
  return `AREAS: ${areas.length === 0 ? NONE : areas.join("; ")}`;
}

function scanBlock(input: RunContextInput): string {
  if (!input.qlooEnabled) return "OPENING SCAN: none (Qloo is disabled for this run).";
  const { plan, estimates } = input.scan;
  const lines = plan.steps.map((step) => {
    const calls = estimates.get(step.toolCallId);
    const cost = calls === null || calls === undefined ? "cost unknown" : `about ${calls} network calls`;
    return `- ${describeScanStep(step)}: running now, ${cost}.`;
  });
  for (const s of plan.skipped) lines.push(`- ${toolLabel(s.tool)}: skipped, ${s.reason}.`);
  if (plan.unavailable.length > 0) lines.push(`- Not available in this build: ${plan.unavailable.map(toolLabel).join(", ")}.`);
  const head =
    plan.steps.length > 0
      ? "OPENING SCAN (its digests arrive with your wave-1 results; do not repeat these calls):"
      : "OPENING SCAN: nothing runs for this question.";
  return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
}

export function buildRunContext(input: RunContextInput): string {
  const { intent } = input;
  const unavailable = input.unavailable.length === 0 ? "none" : input.unavailable.map(toolLabel).join(", ");
  const blocks = [
    `TODAY: ${input.today}`,
    `MODE: ${input.mode}`,
    `DESK: ${PILLAR_LABEL[intent.pillar]}`,
    `JOB: ${intent.job} (${JOB_MNEMONIC[intent.job]}), compiled to ${escapeAngles(intent.mnemonic)}`,
    budgetBlock(input),
    `CLERK:\n${safeJson(intent)}`,
    registryBlock(input.registry),
    `MARKETS: ${input.geo.metros().join(", ")}`,
    `AUDIENCES: ${audienceKeysFor(intent.pillar).join(", ") || NONE}`,
    areasBlock(input.geo, intent.geo.metro),
    scanBlock(input),
    `UNAVAILABLE TOOLS: ${unavailable}`,
    `CASE SUMMARY: ${input.caseSummary === null ? "none" : escapeAngles(input.caseSummary)}`,
    wrapQuestion(input.question),
  ];
  return blocks.join("\n\n");
}
