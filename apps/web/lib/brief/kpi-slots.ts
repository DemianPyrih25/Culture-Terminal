import type { Job, SkillId } from "@ct/contracts";

/**
 * The key-figure strip per job, so a live brief can show which figures are in and which are still
 * pending before report.final names them. This mirrors KPI_SLOTS in packages/agent/src/report/kpis.ts
 * (the agent cannot be imported into browser code); test/brief/kpi-slots.test.ts keeps the two equal.
 * `label` is what a pending slot shows until its metric arrives.
 */

export interface KpiSlot {
  /** FORMULAS ids in preference order. */
  formulas: readonly string[];
  count: number;
  label: string;
}

const LOCATION_DNA: readonly KpiSlot[] = [
  { formulas: ["tenant.rank_shift"], count: 1, label: "Top climber" },
  { formulas: ["block.new_tag"], count: 1, label: "New tags" },
  { formulas: ["block.rank_delta"], count: 1, label: "Over-represented" },
];

export const KPI_SLOTS: Readonly<Record<Job, readonly KpiSlot[]>> = {
  brand_health: [
    { formulas: ["subs.similarity"], count: 1, label: "Nearest audience" },
    { formulas: ["subs.distinctiveness"], count: 1, label: "Distinctiveness" },
    { formulas: ["share.youth_tilt", "dna.youth_index"], count: 1, label: "Youth tilt" },
    { formulas: ["share.metros_won"], count: 1, label: "Metros won" },
  ],
  head_to_head: [
    { formulas: ["subs.similarity"], count: 1, label: "Audience overlap" },
    { formulas: ["share.metros_won"], count: 2, label: "Metros won" },
    { formulas: ["share.youth_tilt", "dna.youth_index"], count: 2, label: "Youth tilt" },
  ],
  site_selection: [
    { formulas: ["lift.area"], count: 3, label: "Area lift" },
    { formulas: ["lift.confidence"], count: 1, label: "Map precision" },
  ],
  tenant_mix: LOCATION_DNA,
  area_profile: LOCATION_DNA,
  sponsorship: [
    { formulas: ["slate.best_fit"], count: 3, label: "Best fit" },
    { formulas: ["slate.under_the_radar"], count: 1, label: "Under-the-radar fits" },
  ],
  market_selection: [
    { formulas: ["share.metros_won"], count: 1, label: "Metros won" },
    { formulas: ["share.pct", "slate.market_alignment"], count: 3, label: "Market fit" },
  ],
  audience_discovery: [],
};

/** Which skill computes a formula, from its family prefix; null for report-level formulas. */
export function skillForFormula(formulaId: string): SkillId | null {
  const family = formulaId.split(".")[0] ?? "";
  switch (family) {
    case "subs":
      return "peer_landscape";
    case "share":
      return "share_of_taste";
    case "dna":
      return "audience_dna";
    case "mom":
      return "momentum";
    case "trvl":
      return "destination_affinity";
    case "lift":
      return "geo_lift";
    case "block":
    case "tenant":
      return "block_dna";
    case "xdom":
      return "cross_domain";
    case "slate":
      return "sponsor_slate";
    case "resolve":
      return "resolve_entities";
    default:
      return null;
  }
}
