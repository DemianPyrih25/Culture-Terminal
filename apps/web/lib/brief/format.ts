import type {
  ArgumentSection,
  Badge,
  CacheStatus,
  Comparator,
  ConfidenceBand,
  ConfidenceRule,
  Flag,
  Job,
  MatchClass,
  Metric,
  NoValueReason,
  Pillar,
  Priority,
  SafetyCategory,
  Signal,
  Strength,
  ToolName,
  TrendWindow,
} from "@ct/contracts";

/**
 * Formatters and labels for the brief (Concept A, D36). Pure and framework-free, so the server
 * (read-only notes) and the browser (live runs) print the same text. Times and dates are UTC.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function utc(iso: string | number): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const monthOf = (d: Date) => MONTHS[d.getUTCMonth()] ?? "";

/** "14 Oct 2026". Invalid input comes back unchanged. */
export function formatUtcDate(iso: string | number): string {
  const d = utc(iso);
  return d ? `${d.getUTCDate()} ${monthOf(d)} ${d.getUTCFullYear()}` : String(iso);
}

/** "09:12:04". */
export function formatUtcTime(iso: string | number): string {
  const d = utc(iso);
  return d ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` : String(iso);
}

/** "14 Oct 2026, 09:12": the checker line. */
export function formatUtcDateTime(iso: string | number): string {
  const d = utc(iso);
  return d ? `${formatUtcDate(iso)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : String(iso);
}

/** "13 Oct, 09:13": a live fetch on a sidenote. */
export function formatUtcShortDateTime(iso: string | number): string {
  const d = utc(iso);
  return d ? `${d.getUTCDate()} ${monthOf(d)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : String(iso);
}

/** The trending window as a month span: "Apr–Sep 2025", or "Nov 2024–Feb 2025" across a year. */
export function formatTrendWindow(window: TrendWindow): string {
  const start = utc(`${window.start}T00:00:00Z`);
  const end = utc(`${window.end}T00:00:00Z`);
  if (!start || !end) return `${window.start}–${window.end}`;
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return start.getUTCMonth() === end.getUTCMonth()
      ? `${monthOf(start)} ${start.getUTCFullYear()}`
      : `${monthOf(start)}–${monthOf(end)} ${end.getUTCFullYear()}`;
  }
  return `${monthOf(start)} ${start.getUTCFullYear()}–${monthOf(end)} ${end.getUTCFullYear()}`;
}

/** A timer: "00:21", "12:05", or "1:02:03" past an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** The working view's short timer: "0:06", "1:12", "12:05", or "1:02:03" past an hour. */
export function formatClockShort(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** A request or step duration: "154 ms", "1.8 s", "42 s", "2 min". */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)} s`;
  if (v < 120_000) return `${Math.round(v / 1000)} s`;
  return `${Math.round(v / 60_000)} min`;
}

/** A cache age: "<1m", "15m", "3h", "2d". */
export function formatCacheAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Model cost: "$0.06", "<$0.01" for a non-zero cent fraction, "$0.00" for nothing. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${Math.max(0, usd).toFixed(2)}`;
}

/**
 * A reported dollar amount (SEC filings, Census incomes) in a reader's words: "$1.2B", "$845.0M",
 * "$72.4K", "$950", with the typographic minus for a loss ("−$31.5M").
 */
export function formatDollars(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  const scaled = (n: number, suffix: string) => `${sign}$${n.toFixed(1)}${suffix}`;
  if (abs >= 1e12) return scaled(abs / 1e12, "T");
  if (abs >= 1e9) return scaled(abs / 1e9, "B");
  if (abs >= 1e6) return scaled(abs / 1e6, "M");
  if (abs >= 1e4) return scaled(abs / 1e3, "K");
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/** A head count with thousands separators: "12,480". */
export function formatPeople(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * A request id shortened to its first and last four characters, "ab12…cd34", so it can be matched
 * against the ledger without printing the whole id. Short ids are returned whole.
 */
export function shortRequestId(requestId: string | null): string {
  if (requestId === null || requestId === "") return "no response";
  return requestId.length > 10 ? `${requestId.slice(0, 4)}…${requestId.slice(-4)}` : requestId;
}

/** "1 request", "8 requests". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "similarity of Juniper Cola" → "Similarity of Juniper Cola": a label opens on a capital. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"] as const;

/** "Four" for 4, the digits past ten. */
export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

// Desks, jobs and signals ---------------------------------------------------------------------------

/** Desk names as the running head and the library print them (uppercased by CSS in the head). */
export const DESK_LABEL: Readonly<Record<Pillar, string>> = {
  investment: "Investment",
  location: "Location",
  marketing: "Marketing",
  audience: "Audience",
};

/**
 * What each job answers, in the reader's words: the A01 starters, the A02 "Understood as" row, the
 * A09 library and A10. The one table for the whole app, browser and server alike.
 */
export const JOB_LABEL: Readonly<Record<Job, string>> = {
  brand_health: "Real competitors",
  head_to_head: "Compare two brands",
  site_selection: "Where to open",
  area_profile: "Read a neighbourhood",
  tenant_mix: "Best tenant for a space",
  sponsorship: "Sponsor fit",
  market_selection: "Launch & tour cities",
  audience_discovery: "Who they are",
  taste_twins: "Find an area's twin",
  brand_collab: "Brand collaborations",
  creator_fit: "Artists & podcasts who fit",
  launch_test: "Test a new product",
  city_compare: "Compare cities",
};

/** The brief's running head is terser where the full label would crowd it (A05: "INVESTMENT · COMPETITORS"). */
export const JOB_HEAD_LABEL: Readonly<Record<Job, string>> = {
  ...JOB_LABEL,
  brand_health: "Competitors",
};

export const SIGNAL_LABEL: Readonly<Record<Signal, string>> = {
  strong: "Strong signal",
  mixed: "Mixed signal",
  weak: "Weak signal",
  insufficient_evidence: "Insufficient evidence",
};

export const CONVICTION_BAND_LABEL: Readonly<Record<ConfidenceBand, string>> = {
  HIGH: "High",
  MED: "Medium",
  LOW: "Low",
};

/**
 * "Why 80": each conviction penalty in a reader's words. The run's own breakdown labels are QUANT's
 * hover text ("CODE FALLBACK", "Signal is insufficient_evidence (V7, …)"); the brief prints these.
 */
export function convictionRuleLabel(rule: ConfidenceRule, count: number, window: TrendWindow | null = null): string {
  const many = count > 1;
  switch (rule) {
    case "dropped_entity":
      return many ? `${count} names dropped or not matched` : "A name was dropped or not matched";
    case "code_fallback":
      return many ? `Code fell back to a simpler query ${count} times` : "Code fell back to a simpler query";
    case "coarse_geohash":
      return "Lift map on a coarse grid";
    case "stale_momentum": {
      const end = window ? utc(`${window.end}T00:00:00Z`) : null;
      return end ? `Trend window ends ${monthOf(end)} ${end.getUTCFullYear()}; nothing after it is used` : "Momentum from a historical window only";
    }
    case "thin_result":
      return many ? `${count} requests returned fewer than five rows` : "A request returned fewer than five rows";
    case "quality_gate_drop":
      return many ? `${count} results fell below the quality gate` : "A result fell below the quality gate";
    case "checker_warning":
      return many ? `${count} checker warnings` : "A checker warning";
    case "insufficient_evidence":
      return "Signal is insufficient evidence";
    case "read_as_nearest_job":
      return "Answered as the closest question we cover";
    case "concept_partly_tagged":
      return "Part of the concept was not tested";
  }
}

export const STRENGTH_LABEL: Readonly<Record<Strength, string>> = {
  STRONG: "Strong",
  MODERATE: "Moderate",
  THIN: "Thin",
};

export const SECTION_LABEL: Readonly<Record<ArgumentSection, string>> = {
  audience: "Audience",
  competition: "Competition",
  geography: "Geography",
  momentum: "Momentum",
  opportunity: "Opportunity",
  risk: "Risk",
};

export const PRIORITY_LABEL: Readonly<Record<Priority, string>> = { now: "Now", next: "Next", later: "Later" };

/** What every delta is measured against, as prose: "vs peers". */
export const COMPARATOR_TEXT: Readonly<Record<Comparator, string>> = {
  CITY: "vs city",
  PEERS: "vs peers",
  BASELINE: "vs baseline",
  WITHIN_CALL: "within call",
};

export const BADGE_LABEL: Readonly<Record<Badge, string>> = {
  MEASURED: "Measured",
  DERIVED: "Derived",
  ESTIMATED: "Estimated",
  STALE: "Historical",
  UNAVAILABLE: "Not measured",
};

/** Why a value is missing, in a reader's words. UNAVAILABLE is shown with this, never as 0. */
export const NO_VALUE_LABEL: Readonly<Record<NoValueReason, string>> = {
  not_scored: "not scored: tied at the floor of its row",
  dropped: "left out of the results by Qloo",
  not_measured: "no data for this entity",
  no_signal: "no usable trend in the window",
  unavailable: "Qloo has no data of this kind for this type",
  quality_gate: "below the quality gate",
  budget_truncated: "not requested: the run's budget ran out",
  insufficient_n: "too few cells to measure",
  coarse: "location data too coarse",
  self: "same entity",
  error: "the request failed",
  not_listed: "not a listed company: no public filings to read",
  not_reported: "not in the company's filings",
  suppressed: "withheld by the Census for privacy or a small sample",
  not_configured: "the public source is not configured on this server",
};

export const CACHE_LABEL: Readonly<Record<CacheStatus, string>> = {
  hit: "cached",
  miss: "live",
  stale: "stale cache",
  coalesced: "shared",
  reused: "reused",
};

export const MATCH_LABEL: Readonly<Record<MatchClass, string>> = {
  exact: "matched exactly",
  ambiguous: "ambiguous",
  inexact: "no exact match",
  not_found: "not found",
};

export const SAFETY_LABEL: Readonly<Record<SafetyCategory, string>> = {
  private_individual: "Private individuals",
  sensitive_inference: "Sensitive traits",
  political_targeting: "Political targeting",
  eligibility: "Eligibility decisions",
  residential_screening: "Residential screening",
  injection: "Instructions inside the question",
  financial_advice: "Financial advice",
  out_of_scope: "Out of scope",
};

/** Tool names for the method steps. */
export const TOOL_LABEL: Readonly<Record<ToolName, string>> = {
  submit_plan: "Plan",
  resolve_entities: "Name matching",
  find_tags: "Taste tags",
  rank_candidates: "Ranking",
  peer_landscape: "Substitution map",
  share_of_taste: "Share of taste",
  audience_dna: "Audience DNA",
  momentum: "Momentum",
  destination_affinity: "Travel taste",
  geo_lift: "Lift map",
  block_dna: "Block DNA",
  cross_domain: "Cultural neighbourhood",
  sponsor_slate: "Sponsor slate",
  taste_twins: "Taste twins",
  concept_vector: "Concept check",
  company_financials: "Company filings",
  area_economics: "Area census",
  submit_report: "Report",
};

/** The data each tool brings, for live lines such as "age data in" or "taste tags arriving". */
export const TOOL_DATA_LABEL: Readonly<Record<ToolName, string>> = {
  submit_plan: "the plan",
  resolve_entities: "name matches",
  find_tags: "taste tags",
  rank_candidates: "rank data",
  peer_landscape: "similarity data",
  share_of_taste: "share data",
  audience_dna: "age data",
  momentum: "trend data",
  destination_affinity: "travel data",
  geo_lift: "lift data",
  block_dna: "block data",
  cross_domain: "neighbour data",
  sponsor_slate: "sponsor data",
  taste_twins: "twin data",
  concept_vector: "concept data",
  company_financials: "filing data",
  area_economics: "census data",
  submit_report: "the report",
};

/** "SECONDARY_ENTITY_DROPPED" → "Secondary entity dropped". */
export function flagLabel(flag: Flag): string {
  const words = flag.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A filter type as the sidenotes print it: "urn:entity:brand" → "brand", "urn:demographics" → "demographics". */
export function filterLabel(filterType: string | null): string | null {
  if (filterType === null || filterType === "") return null;
  return filterType.replace(/^urn:(?:entity:)?/, "").replace(/_/g, " ");
}

// Metrics -------------------------------------------------------------------------------------------

/** What a {{M#}} token prints. UNAVAILABLE prints "not measured", never the number 0. */
export const NOT_MEASURED = "not measured";

/**
 * Absences that are a known fact about a public (SEC or Census) value, not a gap in measuring: the company
 * is not listed, its filings do not report the line, the Census withheld the cell, or the source is not
 * configured on this server. The value shows its own reason in their place, never "not measured" (Q8).
 */
const KNOWN_ABSENCE: Readonly<Partial<Record<NoValueReason, string>>> = {
  not_listed: "not a listed company",
  not_reported: "not reported in filings",
  suppressed: "withheld by the Census",
  not_configured: "not configured on this server",
};

/** Whether an absent value's reason is a known fact (a public value's), shown in place of "not measured". */
export function isKnownAbsence(reason: NoValueReason | null): boolean {
  return reason !== null && KNOWN_ABSENCE[reason] !== undefined;
}

/** What an absent value prints: its known reason ("not reported in filings"), else "not measured". */
export function absentText(reason: NoValueReason | null): string {
  return (reason !== null ? KNOWN_ABSENCE[reason] : undefined) ?? NOT_MEASURED;
}

/** Over or under: only for signed units, where the sign is the reading. */
export function metricDirection(metric: Pick<Metric, "value" | "unit">): "over" | "under" | null {
  if (metric.value === null) return null;
  if (metric.unit === "delta") return metric.value > 0 ? "over" : metric.value < 0 ? "under" : null;
  if (metric.unit === "lift") return metric.value > 1 ? "over" : metric.value < 1 ? "under" : null;
  return null;
}

/**
 * Short metric labels by metric key or formula id (the FORMULAS ids in @ct/quant; test/brief/format.test.ts
 * keeps them covered): what a key figure and a margin note print. The run's own labels ("distinctiveness
 * rank of Juniper Cola among 6 brands (1 = most distinctive)") stay for the request inspector.
 */
export const METRIC_SHORT_LABEL: Readonly<Record<string, string>> = {
  "pct.within_call": "Within-call percentile",
  quality_gate: "Quality gate",
  popularity: "Popularity",
  "resolve.exact_match": "Name match",
  "subs.similarity": "Audience overlap",
  "subs.rank_in_row": "Rank in row",
  "subs.hub": "Hub score",
  "subs.distinctiveness": "Distinctiveness",
  "subs.near_substitutes": "Near substitutes",
  "subs.taste_island": "Taste island",
  "share.pct": "Share of taste",
  "share.youth_tilt": "Youth tilt",
  "share.metros_won": "Metros won",
  "share.pair_split": "Who wins where",
  "dna.age_index": "Age index",
  "dna.gender_index": "Gender index",
  "dna.youth_index": "Youth index",
  "dna.distinctive_tags": "Distinctive tags",
  "mom.delta_26w": "26-week momentum",
  "mom.mann_kendall": "Trend test",
  "mom.label": "Momentum",
  "mom.freshness": "Freshness",
  "trvl.quadrant": "Travel taste",
  "trvl.hidden_pocket": "Hidden pocket",
  "lift.cell": "Cell lift",
  "lift.area": "Area lift",
  "lift.confidence": "Map precision",
  "lift.white_space": "White space",
  "block.rank_delta": "Over-represented",
  "block.new_tag": "New tags",
  "block.panel_rank": "City panel rank",
  "block.concept_rank": "Concept tag rank",
  "block.panel_size": "Cities compared",
  "xdom.partners_one_category": "Partners in one category",
  "tenant.rank_shift": "Rank shift",
  "tenant.fit": "Tenant fit",
  "rank.shift": "Rank shift",
  "rank.fit": "Fit",
  "xdom.fit": "Fit",
  "xdom.under_the_radar": "Under the radar",
  "xdom.edge": "Seed link",
  "slate.best_fit": "Best fit",
  "slate.under_the_radar": "Under-the-radar fit",
  "slate.market_alignment": "Market fit",
  "twin.rho": "Twin match",
  "twin.shared_new": "Shared new tastes",
  "cnpt.s50": "The concept's bar",
  "cnpt.verdict": "Kept or dropped",
  "cnpt.analog_affinity_vs_s50": "Against the bar",
  "cnpt.precision": "AI guesses kept",
  "fin.revenue": "Revenue",
  "fin.gross_margin": "Gross margin",
  "fin.operating_margin": "Operating margin",
  "fin.yoy": "Revenue vs a year before",
  "econ.population": "Residents",
  "econ.median_age": "Median age",
  "econ.median_hh_income": "Median household income",
  "econ.households": "Households",
  "econ.commute_share": "Commute share",
  "econ.count": "Census count",
  "econ.median": "Census median",
  "econ.share": "Census share",
  "fin.margin": "Margin",
  "confidence.run": "Conviction",
  "confidence.metric": "Metric confidence",
};

/**
 * "Distinctiveness": a metric's short label from its key, else its formula, else its own label
 * capitalised without a closing aside ("similarity A–B (nearest peer)" → "Similarity A–B").
 */
export function metricShortLabel(metric: Pick<Metric, "key" | "formulaId" | "label">): string {
  const known = METRIC_SHORT_LABEL[metric.key] ?? METRIC_SHORT_LABEL[metric.formulaId];
  if (known) return known;
  const bare = metric.label.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return capitalize(bare || metric.label);
}

/** "+0.21 vs peers": a metric's display text with its comparator, or "not measured (no usable trend in the window)". */
export function metricWithComparator(metric: Metric): string {
  if (metric.badge === "UNAVAILABLE" || metric.value === null) {
    if (isKnownAbsence(metric.reason)) return absentText(metric.reason);
    return metric.reason ? `${NOT_MEASURED} (${NO_VALUE_LABEL[metric.reason]})` : NOT_MEASURED;
  }
  return metric.comparator ? `${metric.display} ${COMPARATOR_TEXT[metric.comparator]}` : metric.display;
}
