import { AgeBucket, type EntityRef, type Job, type Metric, type MetricId, type Report, type SkillId } from "@ct/contracts";

/**
 * The KPI strip per job (SPEC §7.2): each job's key figures, picked by metric key (Metric.key), so
 * the strip does not depend on labels and tells apart metrics that share a formula (a slate's best
 * fits from its other fits, a lift map's precision from its neighbourhood confidence). Each slot
 * takes up to `count` metrics with a value from its first alternative that has any. Within a slot,
 * metrics the note cites come first, then the subject's own (the question's primary target), then
 * ledger order; a `top` slot ranks by value instead, highest first, for figures such as the top
 * climbers or the top three lifts.
 */

interface KpiPick {
  key: string;
  /** Only metrics of this formula (the slate's best fits share slate.fit with every other fit). */
  formula?: string;
  /** Only metrics that pass, e.g. a share percentile in a market context rather than an age one. */
  where?: (m: Metric) => boolean;
  /**
   * Only a metric between the subject and one of the question's named peers: head_to_head's
   * similarity is the duel's, not the subject's nearest audience, which may be a discovered brand.
   */
  pair?: boolean;
}

/** What the strip is about: the question's primary target and the peers it names (the gate's). */
export interface KpiFocus {
  subject?: EntityRef | null;
  peers?: readonly EntityRef[];
  /** Skills that put evidence in the note: a slot with `requires` is in the strip only when its skill is among them. */
  ran?: ReadonlySet<SkillId>;
}

interface KpiSlot {
  /** Alternatives in preference order. */
  picks: readonly KpiPick[];
  count: number;
  /** Rank by value, highest first, rather than by citation and subject. */
  top?: boolean;
  /**
   * The slot belongs in the strip only when the run planned and ran this skill (D8 of the Part 9
   * close-out): the reported-revenue slot exists for a listed company, whose company_financials step
   * the scan plans; an unlisted brand's strip has no such slot, so nothing waits on it or reads "not measured".
   */
  requires?: SkillId;
}

const one = (key: string, extra: Omit<KpiPick, "key"> = {}): KpiPick => ({ key, ...extra });

/** A share percentile read in a market context: its second subject ref is a market, not an age bucket or audience. */
const inMarket = (m: Metric): boolean => {
  const context = m.subjectRefs[1];
  return context !== undefined && !AgeBucket.safeParse(context).success && !context.startsWith("urn:");
};

/** A rank shift that rose: a climber slot never shows a shift of zero or less (ANSWER_QUALITY §3). */
const rose = (m: Metric): boolean => (m.value ?? 0) > 0;

const NEXT_GEN: readonly KpiPick[] = [one("share.youth_tilt"), one("dna.youth_index")];

/** The SEC figures a brand note shows beside its taste read when the brand is listed (company_financials). */
const FINANCIALS: readonly KpiPick[] = [one("fin.yoy"), one("fin.revenue")];

export const KPI_SLOTS: Readonly<Record<Job, readonly KpiSlot[]>> = {
  // Nearest audience, distinctiveness rank, next-gen rank, metros won (else the momentum label), reported revenue change when listed.
  brand_health: [
    { picks: [one("subs.similarity")], count: 1 },
    { picks: [one("subs.distinctiveness")], count: 1 },
    { picks: NEXT_GEN, count: 1 },
    { picks: [one("share.metros_won"), one("mom.label")], count: 1 },
    { picks: FINANCIALS, count: 1, requires: "company_financials" },
  ],
  // The pair's similarity (else its fit), metros won A/B, youth tilt A/B.
  head_to_head: [
    { picks: [one("subs.similarity", { pair: true }), one("rank.fit")], count: 1 },
    { picks: [one("share.metros_won")], count: 2 },
    { picks: NEXT_GEN, count: 2 },
  ],
  // Top-3 neighbourhood lifts, the map's precision, the best white space.
  site_selection: [
    { picks: [one("lift.area")], count: 3, top: true },
    { picks: [one("lift.precision")], count: 1 },
    { picks: [one("lift.white_space")], count: 1, top: true },
  ],
  // The best tenant fit, the top climber, NEW tags, the most over-represented tag.
  tenant_mix: [
    { picks: [one("tenant.fit")], count: 1, top: true },
    { picks: [one("tenant.rank_shift", { where: rose })], count: 1, top: true },
    { picks: [one("block.new_tag")], count: 1 },
    { picks: [one("block.rank_delta")], count: 1, top: true },
  ],
  // NEW tags, the two biggest rank gains vs the city, the block's top climber when tenants were ranked.
  area_profile: [
    { picks: [one("block.new_tag")], count: 1 },
    { picks: [one("block.rank_delta")], count: 2, top: true },
    { picks: [one("tenant.rank_shift", { where: rose }), one("xdom.under_the_radar")], count: 1, top: true },
  ],
  // Best fit per category, the UNDER-THE-RADAR count, the strongest market.
  sponsorship: [
    { picks: [one("slate.fit", { formula: "slate.best_fit" })], count: 3 },
    { picks: [one("slate.utr_count")], count: 1 },
    { picks: [one("slate.market_alignment")], count: 1, top: true },
  ],
  // Metros won, the top-3 markets, the best hidden-pocket destination.
  market_selection: [
    { picks: [one("share.metros_won")], count: 1 },
    { picks: [one("share.pct", { where: inMarket }), one("slate.market_alignment")], count: 3, top: true },
    { picks: [one("trvl.hidden_pocket")], count: 1, top: true },
  ],
  // Youth index, distinctive facet tags, under-the-radar picks, the best hidden-pocket destination.
  audience_discovery: [
    { picks: [one("dna.youth_index")], count: 1 },
    { picks: [one("dna.distinctive_tags")], count: 1 },
    { picks: [one("xdom.under_the_radar")], count: 2 },
    { picks: [one("trvl.hidden_pocket")], count: 1, top: true },
  ],
  // The best twins by rho, the shared NEW tags, the source area's resident median income.
  taste_twins: [
    { picks: [one("twin.rho")], count: 2, top: true },
    { picks: [one("twin.shared_new"), one("block.new_tag")], count: 1 },
    { picks: [one("econ.median_hh_income")], count: 1 },
  ],
  // The best-scored partners, the shared audience tags, an under-the-radar partner.
  brand_collab: [
    { picks: [one("rank.fit"), one("xdom.fit")], count: 3, top: true },
    { picks: [one("dna.distinctive_tags")], count: 1 },
    { picks: [one("xdom.under_the_radar")], count: 1 },
  ],
  // The best-scored creators (one per kind where scored), the under-the-radar picks.
  creator_fit: [
    { picks: [one("rank.fit"), one("xdom.fit")], count: 3, top: true },
    { picks: [one("xdom.under_the_radar")], count: 2 },
  ],
  // Analog precision, the kept and vetoed verdicts, the subject's reported revenue change when listed.
  launch_test: [
    { picks: [one("cnpt.precision")], count: 1 },
    { picks: [one("cnpt.verdict")], count: 2 },
    { picks: FINANCIALS, count: 1, requires: "company_financials" },
  ],
  // Each city's share percentile (the named entity's), the cities won, the biggest fingerprint gap.
  city_compare: [
    { picks: [one("share.pct", { where: inMarket })], count: 4, top: true },
    { picks: [one("share.metros_won")], count: 1 },
    { picks: [one("block.rank_delta")], count: 1, top: true },
  ],
};

/** When a job's slots find nothing, the strip shows this many of the note's cited metrics instead. */
const FALLBACK_KPIS = 4;

/** A two-subject metric between the subject and a named peer, in either order. */
function isPair(m: Metric, focus: KpiFocus): boolean {
  const [a, b] = m.subjectRefs;
  const { subject = null, peers = [] } = focus;
  if (m.subjectRefs.length !== 2 || subject === null || a === undefined || b === undefined) return false;
  return (a === subject && peers.includes(b as EntityRef)) || (b === subject && peers.includes(a as EntityRef));
}

const matches = (m: Metric, pick: KpiPick, focus: KpiFocus): boolean =>
  m.key === pick.key &&
  (pick.formula === undefined || m.formulaId === pick.formula) &&
  (pick.where?.(m) ?? true) &&
  (pick.pair !== true || isPair(m, focus));

export function pickKpis(job: Job, metrics: readonly Metric[], cited: readonly MetricId[], focus: KpiFocus = {}): Report["kpis"] {
  const subject = focus.subject ?? null;
  const citedRank = new Map(cited.map((id, i) => [id, i]));
  const order = (m: Metric) => citedRank.get(m.id) ?? cited.length + (m.subjectRefs[0] === subject ? 0 : metrics.length) + metrics.indexOf(m);
  const valued = metrics.filter((m) => m.value !== null);

  const picked: Metric[] = [];
  for (const slot of KPI_SLOTS[job]) {
    if (slot.requires !== undefined && focus.ran !== undefined && !focus.ran.has(slot.requires)) continue;
    for (const pick of slot.picks) {
      const hits = valued.filter((m) => matches(m, pick, focus) && !picked.includes(m));
      if (hits.length === 0) continue;
      hits.sort(slot.top ? (a, b) => (b.value ?? 0) - (a.value ?? 0) || order(a) - order(b) : (a, b) => order(a) - order(b));
      picked.push(...hits.slice(0, slot.count));
      break;
    }
  }
  const strip =
    picked.length > 0
      ? picked
      : cited.flatMap((id) => valued.find((m) => m.id === id) ?? []).slice(0, FALLBACK_KPIS);
  return strip.map((m) => ({ metricId: m.id, label: m.label, comparator: m.comparator }));
}
