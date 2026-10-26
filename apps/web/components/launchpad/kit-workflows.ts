import { TOOL_MNEMONIC, type ToolName } from "@ct/contracts";
import { TOOL_LABEL } from "../../lib/brief/format";

/**
 * "Built on Qloo's kit workflows + direct REST" (SPEC §4.3, §12.1): each data tool of the agent and the
 * Qloo hackathon-kit workflows it covers. The calls go to the REST API directly, for what the workflows
 * hide. Plan and report make no Qloo request, so they are not listed.
 */

/** The nine workflows of the Qloo kit. */
export const KIT_WORKFLOWS = [
  "describe",
  "find_tags",
  "recommend",
  "rank",
  "where_popular",
  "compare_audiences",
  "entity_tags",
  "audience_demographics",
  "trends",
] as const;
export type KitWorkflow = (typeof KIT_WORKFLOWS)[number];

export interface KitRow {
  tool: Exclude<ToolName, "submit_plan" | "submit_report">;
  workflows: readonly KitWorkflow[];
  /** What direct REST adds over the workflow, when it adds something worth naming. */
  note?: string;
}

export const KIT_ROWS: readonly KitRow[] = [
  { tool: "resolve_entities", workflows: ["describe"] },
  { tool: "find_tags", workflows: ["find_tags"] },
  { tool: "rank_candidates", workflows: ["rank"], note: "with tag signals" },
  { tool: "peer_landscape", workflows: ["recommend", "rank"] },
  { tool: "share_of_taste", workflows: ["rank"] },
  { tool: "audience_dna", workflows: ["audience_demographics", "entity_tags", "compare_audiences"] },
  { tool: "momentum", workflows: ["trends"] },
  { tool: "destination_affinity", workflows: ["recommend"] },
  { tool: "geo_lift", workflows: ["where_popular"], note: "every cell, not 20" },
  { tool: "block_dna", workflows: ["entity_tags", "recommend"], note: "with a location polygon" },
  { tool: "cross_domain", workflows: ["recommend"], note: "with explainability" },
  { tool: "sponsor_slate", workflows: ["recommend", "rank"] },
];

/** A table row as printed: "Substitution map", "SUBS", "recommend · rank". */
export function kitRowText(row: KitRow): { skill: string; mnemonic: string; workflows: string } {
  return { skill: TOOL_LABEL[row.tool], mnemonic: TOOL_MNEMONIC[row.tool], workflows: row.workflows.join(" · ") };
}

/** The kit workflows the tools cover, in KIT_WORKFLOWS order. */
export function coveredWorkflows(rows: readonly KitRow[] = KIT_ROWS): KitWorkflow[] {
  const used = new Set(rows.flatMap((r) => r.workflows));
  return KIT_WORKFLOWS.filter((w) => used.has(w));
}

/** Why the calls go direct (SPEC §12.1). */
export const DIRECT_REST_REASON =
  "Direct REST where the workflows stop short: where_popular truncates to 20 cells, rank omits tag signals, and the workflows hide location polygons, popularity filters, paging and explainability.";
