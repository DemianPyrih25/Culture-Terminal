import type { Job, Metric, MetricId, Report } from "@ct/contracts";
import type { FormulaId } from "@ct/quant";

/**
 * The KPI strip per job (SPEC §7.2), picked by formula id so it does not depend on metric labels.
 * Each slot takes up to `count` metrics with a value from the first formula that has any, preferring
 * metrics the note cites. Audience discovery has no strip.
 */

interface KpiSlot {
  /** Alternatives in preference order. */
  formulas: readonly FormulaId[];
  count: number;
}

const LOCATION_DNA: readonly KpiSlot[] = [
  { formulas: ["tenant.rank_shift"], count: 1 },
  { formulas: ["block.new_tag"], count: 1 },
  { formulas: ["block.rank_delta"], count: 1 },
];

export const KPI_SLOTS: Readonly<Record<Job, readonly KpiSlot[]>> = {
  // Nearest audience, distinctiveness rank, next-gen rank, metros won.
  brand_health: [
    { formulas: ["subs.similarity"], count: 1 },
    { formulas: ["subs.distinctiveness"], count: 1 },
    { formulas: ["share.youth_tilt", "dna.youth_index"], count: 1 },
    { formulas: ["share.metros_won"], count: 1 },
  ],
  // Similarity, metros won A/B, youth tilt A/B.
  head_to_head: [
    { formulas: ["subs.similarity"], count: 1 },
    { formulas: ["share.metros_won"], count: 2 },
    { formulas: ["share.youth_tilt", "dna.youth_index"], count: 2 },
  ],
  // Top-3 neighbourhood lifts, precision.
  site_selection: [
    { formulas: ["lift.area"], count: 3 },
    { formulas: ["lift.confidence"], count: 1 },
  ],
  // Top climbers, NEW tags, over-represented categories.
  tenant_mix: LOCATION_DNA,
  area_profile: LOCATION_DNA,
  // Best fit per category, UNDER-THE-RADAR count.
  sponsorship: [
    { formulas: ["slate.best_fit"], count: 3 },
    { formulas: ["slate.under_the_radar"], count: 1 },
  ],
  // Metros won, top-3 markets.
  market_selection: [
    { formulas: ["share.metros_won"], count: 1 },
    { formulas: ["share.pct", "slate.market_alignment"], count: 3 },
  ],
  audience_discovery: [],
};

/** When a job's slots find nothing, the strip shows this many of the note's cited metrics instead. */
const FALLBACK_KPIS = 4;

export function pickKpis(job: Job, metrics: readonly Metric[], cited: readonly MetricId[]): Report["kpis"] {
  const slots = KPI_SLOTS[job];
  if (slots.length === 0) return [];
  const citedRank = new Map(cited.map((id, i) => [id, i]));
  const rank = (m: Metric) => citedRank.get(m.id) ?? cited.length + metrics.indexOf(m);
  const valued = metrics.filter((m) => m.value !== null);

  const picked: Metric[] = [];
  for (const slot of slots) {
    for (const formula of slot.formulas) {
      const hits = valued.filter((m) => m.formulaId === formula && !picked.includes(m)).sort((a, b) => rank(a) - rank(b));
      if (hits.length === 0) continue;
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
