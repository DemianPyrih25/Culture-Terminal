import { AgeBucket, type Job, type Metric, type SkillId } from "@ct/contracts";

/**
 * The key-figure strip per job, all thirteen, so a live brief can show which figures are in and which are
 * still pending before report.final names them, and every figure gets a short label. This mirrors
 * KPI_SLOTS in packages/agent/src/report/kpis.ts (the agent cannot be imported into browser code): each
 * slot takes up to `count` metrics with a value from its first pick that has any, a pick matching a
 * metric key (Metric.key), optionally its formula and a test; a `top` slot ranks by value, highest
 * first. test/brief/kpi-slots.test.ts keeps the two equal. The labels are the brief's own: what a
 * pending slot shows, and what a figure is called when the report's label is too long to print.
 */

export interface KpiPick {
  key: string;
  /** Only metrics of this formula (a slate's best fits share slate.fit with its other fits). */
  formula?: string;
  /** Only metrics that pass, e.g. a share percentile in a market context rather than an age one. */
  where?: (m: Metric) => boolean;
  /** The figure's short label when this pick fills the slot; the slot's label otherwise. */
  label?: string;
  /** Only a metric between the subject and one of the question's named peers (the agent's KpiPick.pair). */
  pair?: boolean;
}

/** What the strip is about: the question's primary target and the peers it names (the resolve event's). */
export interface KpiFocus {
  subject: string | null;
  peers: readonly string[];
}

export interface KpiSlot {
  /** Alternatives in preference order. */
  picks: readonly KpiPick[];
  count: number;
  /** Rank by value, highest first, rather than by arrival and subject. */
  top?: boolean;
  /** A/Key figure label: "Nearest audience". */
  label: string;
}

const one = (key: string, extra: Omit<KpiPick, "key"> = {}): KpiPick => ({ key, ...extra });

/** A share percentile read in a market context: its second subject ref is a market, not an age bucket or audience. */
export const inMarket = (m: Metric): boolean => {
  const context = m.subjectRefs[1];
  return context !== undefined && !AgeBucket.safeParse(context).success && !context.startsWith("urn:");
};

/** A rank shift that rose: "Top climber" never shows a shift of zero or less (ANSWER_QUALITY §3). */
const rose = (m: Metric): boolean => (m.value ?? 0) > 0;

// A youth index is its own measure (−1..1 around the average audience, D38), not the share tilt the slot is named after.
const NEXT_GEN: readonly KpiPick[] = [one("share.youth_tilt"), one("dna.youth_index", { label: "Youth index" })];

/** The SEC figures a brand note shows beside its taste read when the brand is listed (company_financials). */
const FINANCIALS: readonly KpiPick[] = [
  one("fin.yoy", { label: "Revenue vs a year before" }),
  one("fin.revenue", { label: "Reported revenue" }),
];

export const KPI_SLOTS: Readonly<Record<Job, readonly KpiSlot[]>> = {
  brand_health: [
    { picks: [one("subs.similarity")], count: 1, label: "Nearest audience" },
    { picks: [one("subs.distinctiveness")], count: 1, label: "Distinctiveness" },
    { picks: NEXT_GEN, count: 1, label: "Youth tilt" },
    { picks: [one("share.metros_won"), one("mom.label", { label: "Momentum" })], count: 1, label: "Metros won" },
    { picks: FINANCIALS, count: 1, label: "Reported revenue" },
  ],
  head_to_head: [
    { picks: [one("subs.similarity", { pair: true }), one("rank.fit", { label: "Fit" })], count: 1, label: "Audience overlap" },
    { picks: [one("share.metros_won")], count: 2, label: "Metros won" },
    { picks: NEXT_GEN, count: 2, label: "Youth tilt" },
  ],
  site_selection: [
    { picks: [one("lift.area")], count: 3, top: true, label: "Area lift" },
    { picks: [one("lift.precision")], count: 1, label: "Map precision" },
    { picks: [one("lift.white_space")], count: 1, top: true, label: "White space" },
  ],
  tenant_mix: [
    { picks: [one("tenant.fit")], count: 1, top: true, label: "Tenant fit" },
    { picks: [one("tenant.rank_shift", { where: rose })], count: 1, top: true, label: "Top climber" },
    { picks: [one("block.new_tag")], count: 1, label: "New tags" },
    { picks: [one("block.rank_delta")], count: 1, top: true, label: "Over-represented" },
  ],
  area_profile: [
    { picks: [one("block.new_tag")], count: 1, label: "New tags" },
    { picks: [one("block.rank_delta")], count: 2, top: true, label: "Over-represented" },
    { picks: [one("tenant.rank_shift", { where: rose }), one("xdom.under_the_radar", { label: "Under the radar" })], count: 1, top: true, label: "Top climber" },
  ],
  sponsorship: [
    { picks: [one("slate.fit", { formula: "slate.best_fit" })], count: 3, label: "Best fit" },
    { picks: [one("slate.utr_count")], count: 1, label: "Under-the-radar fits" },
    { picks: [one("slate.market_alignment")], count: 1, top: true, label: "Top market" },
  ],
  market_selection: [
    { picks: [one("share.metros_won")], count: 1, label: "Metros won" },
    { picks: [one("share.pct", { where: inMarket }), one("slate.market_alignment")], count: 3, top: true, label: "Market fit" },
    { picks: [one("trvl.hidden_pocket")], count: 1, top: true, label: "Hidden pocket" },
  ],
  audience_discovery: [
    { picks: [one("dna.youth_index")], count: 1, label: "Youth index" },
    { picks: [one("dna.distinctive_tags")], count: 1, label: "Distinctive tags" },
    { picks: [one("xdom.under_the_radar")], count: 2, label: "Under the radar" },
    { picks: [one("trvl.hidden_pocket")], count: 1, top: true, label: "Hidden pocket" },
  ],
  taste_twins: [
    { picks: [one("twin.rho")], count: 2, top: true, label: "Twin match" },
    { picks: [one("twin.shared_new"), one("block.new_tag", { label: "New tags" })], count: 1, label: "Shared new tastes" },
    { picks: [one("econ.median_hh_income")], count: 1, label: "Median household income" },
  ],
  brand_collab: [
    { picks: [one("rank.fit"), one("xdom.fit")], count: 3, top: true, label: "Partner fit" },
    { picks: [one("dna.distinctive_tags")], count: 1, label: "Distinctive tags" },
    { picks: [one("xdom.under_the_radar")], count: 1, label: "Under the radar" },
  ],
  creator_fit: [
    { picks: [one("rank.fit"), one("xdom.fit")], count: 3, top: true, label: "Creator fit" },
    { picks: [one("xdom.under_the_radar")], count: 2, label: "Under the radar" },
  ],
  launch_test: [
    { picks: [one("cnpt.precision")], count: 1, label: "AI guesses kept" },
    { picks: [one("cnpt.verdict")], count: 2, label: "Kept or dropped" },
    { picks: FINANCIALS, count: 1, label: "Reported revenue" },
  ],
  city_compare: [
    { picks: [one("share.pct", { where: inMarket })], count: 4, top: true, label: "City fit" },
    { picks: [one("share.metros_won")], count: 1, label: "Cities won" },
    { picks: [one("block.rank_delta")], count: 1, top: true, label: "Stands out for" },
  ],
};

/** A two-subject metric between the subject and a named peer, in either order. */
function isPair(m: Metric, { subject, peers }: KpiFocus): boolean {
  const [a, b] = m.subjectRefs;
  if (m.subjectRefs.length !== 2 || subject === null || a === undefined || b === undefined) return false;
  return (a === subject && peers.includes(b)) || (b === subject && peers.includes(a));
}

/**
 * Whether a metric fills a pick: its key, and its formula and test when the pick names them. A `pair`
 * pick also needs the strip's focus; without one (naming a figure the report already chose) it is not tested.
 */
export function pickMatches(m: Metric, pick: KpiPick, focus?: KpiFocus): boolean {
  return (
    m.key === pick.key &&
    (pick.formula === undefined || m.formulaId === pick.formula) &&
    (pick.where?.(m) ?? true) &&
    (pick.pair !== true || focus === undefined || isPair(m, focus))
  );
}

/** The job's slot and pick a metric would fill, or null when it fills none. */
export function slotFor(job: Job | null | undefined, metric: Metric): { slot: KpiSlot; pick: KpiPick } | null {
  if (!job) return null;
  for (const slot of KPI_SLOTS[job]) {
    const pick = slot.picks.find((p) => pickMatches(metric, p));
    if (pick) return { slot, pick };
  }
  return null;
}

/** Which skill computes a metric key or formula, from its family prefix; null for report-level ones. */
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
      return "block_dna";
    // Tenant fit is rank_candidates under [site, city] contexts (SPEC §5.3 S8).
    case "tenant":
    case "rank":
      return "rank_candidates";
    case "xdom":
      return "cross_domain";
    case "slate":
      return "sponsor_slate";
    case "resolve":
      return "resolve_entities";
    case "twin":
      return "taste_twins";
    case "cnpt":
      return "concept_vector";
    case "fin":
      return "company_financials";
    case "econ":
      return "area_economics";
    default:
      return null;
  }
}
