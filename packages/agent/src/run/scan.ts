import { ANALYST_TOOLS, type Intent, type Job, type RegisteredEntity, type SkillId, type ToolInput } from "@ct/contracts";
import { isSkillAvailable, toolLabel } from "./catalogue";

/**
 * The opening scan (PLAN §4.1 step C, SPEC §4.1): code runs the job's scan skills with default
 * arguments, in parallel with ANALYST turn 1, so the first charts appear early; its digests reach the
 * model with the wave-1 results and its evidence is cited like any other. SCAN_TABLE is the one place
 * a job's scan is defined: a skill that lands in this build gets its default-input builder here.
 */

export interface ScanContext {
  intent: Intent;
  /** The resolved primary target, or null when the question has none. */
  primary: RegisteredEntity | null;
  /** Resolved peer mentions, in question order. */
  peers: readonly RegisteredEntity[];
}

/** A scan skill and how to build its default input; no builder means the build cannot run it yet. */
type ScanEntry = {
  [Id in SkillId]: { tool: Id; build?: (ctx: ScanContext) => ToolInput<Id> | null; why?: string };
}[SkillId];

/** Substitution Map size for the scan: the target plus five peers. */
export const SCAN_PEER_K = 6;

/**
 * brand_health maps the target with discovery; head_to_head maps the primary against the named
 * brands, with discovery filling the matrix unless three or more were named.
 */
function peerMap(alwaysDiscover: boolean): (ctx: ScanContext) => ToolInput<"peer_landscape"> | null {
  return ({ primary, peers }) => {
    if (primary === null || primary.type !== "brand") return null;
    const named = [...new Set(peers.filter((p) => p.type === "brand" && p.ref !== primary.ref).map((p) => p.ref))].slice(0, SCAN_PEER_K - 1);
    return {
      target: primary.ref,
      peers: named,
      discover: alwaysDiscover || named.length < 3,
      k: SCAN_PEER_K,
      trigger_finding_id: null,
      step_id: null,
    };
  };
}

const PEER_MAP_WHY = "needs a brand as the primary target";

/**
 * The scan skills per job, in PLAN §4.1 order. Two entries go beyond the SPEC §4.1 scan table on
 * purpose: brand_health maps the target with peer_landscape (k 6, discovery on) rather than discovery
 * alone, and head_to_head adds the primary's peer_landscape before the pair, ages and DNA, so the
 * duel has a Substitution Map while those skills are unbuilt. Each costs up to 2 + (k - 1) = 7 cold
 * calls. director.md §5 describes these scans, so wave 1 does not repeat them.
 */
export const SCAN_TABLE: Readonly<Record<Job, readonly ScanEntry[]>> = {
  brand_health: [
    { tool: "peer_landscape", build: peerMap(true), why: PEER_MAP_WHY },
    { tool: "audience_dna" },
    { tool: "destination_affinity" },
  ],
  head_to_head: [
    { tool: "peer_landscape", build: peerMap(false), why: PEER_MAP_WHY },
    { tool: "rank_candidates" },
    { tool: "share_of_taste" },
    { tool: "audience_dna" },
  ],
  site_selection: [{ tool: "find_tags" }, { tool: "geo_lift" }],
  area_profile: [{ tool: "block_dna" }],
  tenant_mix: [{ tool: "block_dna" }],
  sponsorship: [{ tool: "sponsor_slate" }, { tool: "cross_domain" }],
  market_selection: [{ tool: "destination_affinity" }, { tool: "share_of_taste" }],
  audience_discovery: [{ tool: "cross_domain" }, { tool: "audience_dna" }],
};

export interface ScanStep {
  /** Code-made tool call id: scan-1, scan-2, … */
  toolCallId: string;
  tool: SkillId;
  /** Parsed by the tool's own schema. */
  input: unknown;
}

export interface ScanPlan {
  steps: ScanStep[];
  /** Scan skills this build cannot run yet. */
  unavailable: SkillId[];
  /** Scan skills that could run but not for this question, with the reason. */
  skipped: { tool: SkillId; reason: string }[];
}

export function planScan(job: Job, ctx: ScanContext): ScanPlan {
  const plan: ScanPlan = { steps: [], unavailable: [], skipped: [] };
  for (const entry of SCAN_TABLE[job]) {
    if (!isSkillAvailable(entry.tool) || entry.build === undefined) {
      plan.unavailable.push(entry.tool);
      continue;
    }
    const raw = (entry.build as (c: ScanContext) => unknown)(ctx);
    const parsed = raw === null ? null : ANALYST_TOOLS[entry.tool].input.safeParse(raw);
    if (parsed === null || !parsed.success) {
      plan.skipped.push({ tool: entry.tool, reason: entry.why ?? "its default arguments do not fit this question" });
      continue;
    }
    plan.steps.push({ toolCallId: `scan-${plan.steps.length + 1}`, tool: entry.tool, input: parsed.data });
  }
  return plan;
}

/** How the run context describes one scan step, e.g. "peer_landscape (SUBS) for R1, discovery on, k 6". */
export function describeScanStep(step: ScanStep): string {
  if (step.tool === "peer_landscape") {
    const i = step.input as ToolInput<"peer_landscape">;
    const peers = i.peers.length > 0 ? ` with peers ${i.peers.join(", ")}` : "";
    return `${toolLabel(step.tool)} for ${i.target}${peers}, discovery ${i.discover ? "on" : "off"}, k ${i.k}`;
  }
  return toolLabel(step.tool);
}
