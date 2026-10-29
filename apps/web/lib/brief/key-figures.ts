import { MetroId, type Comparator, type Job, type Metric } from "@ct/contracts";
import { capitalize, COMPARATOR_TEXT, metricShortLabel } from "./format";
import { slotFor } from "./kpi-slots";
import { metricView, type Ledger } from "./ledger";
import { plainPiece } from "./plain";

/**
 * A/Key figure text per metric key (Concept A, D36): the number, a short label and the line under it,
 * for every job's slots (KPI_SLOTS). The number is the head of the metric's own display ("+0.34" of
 * "+0.34 · site 1 of 8 · city 5 of 8, among the 8 ranked at both"); the rest of the display moves to the
 * line under it, so nothing the run printed is lost and no number is made up. Names come from the
 * run's registry or the metric's own label (QUANT writes each key's label from one template).
 */

export interface KeyFigureText {
  /** The number as the run displayed it, or "not measured". */
  value: string;
  label: string;
  comparator: string | null;
}

/** A/Key figure labels are short: a report label longer than this gives way to the slot's or the metric's short label. */
export const KEY_FIGURE_LABEL_MAX = 24;

/**
 * A short label the report chose on purpose, capitalized, or "". The agent passes each figure's own
 * metric label (pickKpis), which the specs and slots shorten: a short entity name makes that label
 * short too ("Kit youth index (Y)"), and it must not slip past them.
 */
function curatedLabel(metric: Metric, given: string | null): string {
  const label = given?.trim() ?? "";
  return label !== "" && label !== metric.label.trim() && label.length <= KEY_FIGURE_LABEL_MAX ? capitalize(label) : "";
}

/** Pair measures read "with" the other brand; any other measure of two subjects reads "vs" it. */
const PAIR_FORMULAS: ReadonlySet<string> = new Set(["subs.similarity", "subs.near_substitutes"]);

/** What one key's spec sees: the metric, its display split at " · ", the slot and the names it is about. */
interface Context {
  metric: Metric;
  /** The display's first piece: the number. */
  head: string;
  /** The display's other pieces, in order. */
  rest: string[];
  /** The job's slot label for this metric's formula, or null. */
  slot: string | null;
  /** The slot holds more than one figure ("Metros won" ×2 in a head-to-head), so each names its subject. */
  several: boolean;
  /** The first subject's name (an entity, a tag), when the registry knows it. */
  subject: string | null;
  /** The other R# subjects' names. */
  others: string[];
}

interface KeySpec {
  /** The number, from the display's pieces; the head by default. */
  value?: (c: Context) => string;
  /** The pieces of the display that go under the number; `rest` by default. */
  detail?: (c: Context) => string[];
  label?: (c: Context) => string | null;
  /** What the number is measured against, in place of the comparator's words. */
  versus?: (c: Context) => string | null;
}

/** The first group of a pattern in the metric's label, trimmed; null without a match. */
function fromLabel(metric: Metric, pattern: RegExp): string | null {
  const found = pattern.exec(metric.label)?.[1]?.trim();
  return found ? found : null;
}

/** "Top climber · Juniper Cola": the slot's label (or the key's own) with what the figure is about, when known. */
function named(c: Context, name: string | null, fallback: string): string {
  const label = c.slot ?? fallback;
  return name ? `${label} · ${name}` : label;
}

/** "2 of 6" alone means a rank: under a number it reads "rank 2 of 6". */
const rankWords = (piece: string) => (/^\d+(?:\.\d)? of \d+$/.test(piece) ? `rank ${piece}` : piece);

/** ", among the 8 ranked at both" closes a rank shift's display; the inspector keeps it. */
const withoutAmong = (piece: string) => piece.replace(/,\s*among the .*$/, "");

/** The centre of the audience index scale (D38). */
const AVERAGE = "0 = average";

/** Block DNA family words, from the metric's label ("NEW SOUND music tags in …"). */
const FAMILY_WORD: Readonly<Record<string, string>> = { WHO: "venue-goer", VIBE: "vibe", WHAT: "place", SOUND: "music" };

/** The city a Block DNA metric compares against, from its label ("rank gain vs Nashville: …"). */
const blockCity = (m: Metric) => fromLabel(m, /\bvs (.+?):/) ?? fromLabel(m, /absent from the (.+?) (?:music )?top \d+/);

/**
 * Per metric key, how its key figure reads (the jobs' KPI slots and the keys the skills print beside
 * them). Keys without a spec print the head of their display, the slot's label and their comparator.
 */
export const KEY_FIGURE_SPECS: Readonly<Record<string, KeySpec>> = {
  // Share of Taste: "wins 3 of 8 · top half in 5 of 8", "+0.31 · rank 1 of 2", "0.82 · 2 of 6".
  "share.metros_won": {
    value: (c) => c.head.replace(/^wins\s+/, ""),
    label: (c) => (c.several ? named(c, c.subject, "Metros won") : (c.slot ?? "Metros won")),
  },
  "share.youth_tilt": { label: (c) => (c.several ? named(c, c.subject, "Youth tilt") : (c.slot ?? "Youth tilt")) },
  "share.pct": {
    label: (c) => named(c, fromLabel(c.metric, /, (?:metro|age|audience) (.+?)(?: \((?:best|worst) context\))?$/), "Share of taste"),
    versus: () => COMPARATOR_TEXT.WITHIN_CALL,
  },
  // Audience DNA: "Juniper Cola age index 25–29", "… gender index, women". Indices sit on Qloo's −1..1
  // scale around the average audience (D38), so the line names the centre, never a US 1.00.
  "dna.age_index": {
    label: (c) => {
      const ages = fromLabel(c.metric, /age index (.+)$/);
      return ages ? `Index, ages ${ages}` : "Age index";
    },
    versus: () => AVERAGE,
  },
  "dna.gender_index": { label: (c) => `Index, ${fromLabel(c.metric, /gender index, (.+)$/) ?? "gender"}`, versus: () => AVERAGE },
  // A youth index is not share.youth_tilt's measure: it keeps its own name, and names its brand beside another's.
  "dna.youth_index": { label: (c) => (c.several ? named(c, c.subject, "Youth index") : (c.slot ?? "Youth index")), versus: () => AVERAGE },
  // Lift map: "1.48×" vs the named baseline; the map's precision "gh7 · 1.00"; white space "0.62 · Latent & open".
  "lift.area": {
    // A neighbourhood's lift names it; the metro-wide "not measured" one keeps the slot's label.
    label: (c) => fromLabel(c.metric, /^lift of (.+?) vs the /) ?? (MetroId.safeParse(c.metric.subjectRefs[0]).success ? null : c.subject) ?? c.slot ?? "Area lift",
    versus: (c) => {
      const baseline = fromLabel(c.metric, / vs the (.+?baseline)/);
      return baseline ? `vs ${baseline}` : COMPARATOR_TEXT.BASELINE;
    },
  },
  "lift.precision": {
    value: (c) => c.rest[0] ?? c.head,
    detail: (c) => [`${c.head} grid`.replace(/^gh(\d+) grid$/, "geohash $1 grid"), ...c.rest.slice(1)],
  },
  "lift.confidence": { label: (c) => named(c, fromLabel(c.metric, /^confidence of the (.+?) lift/), "Lift confidence") },
  "lift.white_space": { label: (c) => named(c, fromLabel(c.metric, /^white space in (.+?) \(/), "White space") },
  // Block DNA: "+42 · NEW" for a tag vs the city; "4 of 12 in the area top 20" NEW tags of a family.
  "block.rank_delta": {
    label: (c) => {
      const tag = c.subject ?? fromLabel(c.metric, /:\s*(.+?) \([^()]*\)$/);
      return tag ? capitalize(tag) : (c.slot ?? "Rank vs city");
    },
    versus: (c) => {
      const city = blockCity(c.metric);
      return city ? `rank vs ${city}` : COMPARATOR_TEXT.CITY;
    },
  },
  "block.new_tag": {
    value: (c) => c.head.replace(/ in the area .*$/, ""),
    // "6 of 20" under "New music tags · vs Nashville": "in the area top 20" misreads for a whole city (Q1).
    detail: () => [],
    label: (c) => {
      const family = FAMILY_WORD[fromLabel(c.metric, /^NEW (WHO|VIBE|WHAT|SOUND)\b/) ?? ""];
      return family ? `New ${family} tags` : (c.slot ?? "New tags");
    },
    versus: (c) => {
      const city = blockCity(c.metric);
      return city ? `vs ${city}` : COMPARATOR_TEXT.CITY;
    },
  },
  // Tenant fit and rank shifts: "+0.34 · site 1 of 8 · city 5 of 8, among the 8 ranked at both".
  "tenant.rank_shift": {
    label: (c) => named(c, c.subject, "Rank shift"),
    detail: (c) => c.rest.map(withoutAmong),
    versus: () => null,
  },
  "tenant.fit": {
    label: (c) => named(c, c.subject, "Tenant fit"),
    detail: (c) => c.rest.map(withoutAmong),
    versus: () => null,
  },
  "rank.shift": { label: (c) => named(c, c.subject, "Rank shift"), detail: (c) => c.rest.map(withoutAmong) },
  "rank.fit": { label: (c) => named(c, c.subject, "Fit") },
  // Sponsor slate: "FIT · Copperline Lager · Beer best fit, under the radar", "0.94 · 1 of 24".
  "slate.fit": {
    label: (c) => {
      const category = fromLabel(c.metric, /· ([^·]+?) best fit/);
      return category ? `Best fit · ${category.toLowerCase()}` : named(c, c.subject, "Fit");
    },
    // The brand alone: the strip is four narrow columns, and its rank and flag are the slate table's.
    detail: (c) => (c.subject && /best fit/.test(c.metric.label) ? [c.subject] : c.rest),
    versus: () => null,
  },
  "slate.utr_count": { versus: () => "of the best fits" },
  "slate.market_alignment": {
    value: (c) => c.head.replace(/ in .*$/, ""),
    label: (c) => named(c, / in (.+)$/.exec(c.head)?.[1] ?? null, "Top market"),
    detail: (c) => [...(c.subject ? [c.subject] : [])],
    versus: () => "vs national",
  },
  // Travel taste: "1.42 · popularity 0.31, median 0.55" for a destination above what popularity predicts.
  "trvl.hidden_pocket": { label: (c) => named(c, c.subject, "Hidden pocket") },
  // Cultural neighbourhood: "0.42 · fit 0.81 − popularity 0.39"; facet tags "7 of 31 facet tags, vs 5 peers of the same type".
  "xdom.under_the_radar": { label: (c) => named(c, c.subject, "Under the radar") },
  "dna.distinctive_tags": {
    value: (c) => /^(\d+ of \d+)/.exec(c.head)?.[1] ?? c.head,
    detail: (c) => {
      const m = /^\d+ of \d+ (.+?), (vs \d+ peers?)/.exec(c.head);
      return m ? [m[1] as string, m[2] as string] : [];
    },
    versus: () => null,
  },
  // Momentum and the rest: their displays are already short.
  "mom.label": { label: (c) => named(c, c.several ? c.subject : null, "Momentum") },
};

/** "Audience overlap": a short label the report chose, else the job's slot label, else the metric's short label. */
export function keyFigureLabel(job: Job | null | undefined, metric: Metric, given: string | null): string {
  const curated = curatedLabel(metric, given);
  if (curated !== "") return curated;
  const filled = slotFor(job, metric);
  return filled ? (filled.pick.label ?? filled.slot.label) : metricShortLabel(metric);
}

/**
 * The number, label and line under one key figure. `given` is the report's KPI label (null while live:
 * the slot names it), `comparator` the report's (or the metric's) comparator.
 */
export function keyFigureText(ledger: Ledger, job: Job | null | undefined, metric: Metric, given: string | null, comparator: Comparator | null): KeyFigureText {
  const view = metricView(metric, ledger.window);
  const filled = slotFor(job, metric);
  const [head = "", ...rest] = metric.display
    .split(" · ")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const names = metric.subjectRefs.map((ref) => ledger.refNames.get(ref) ?? ledger.placeNames.get(ref) ?? null);
  // "with" or "vs" names other entities only: a metric's other subjects can be concept tags, areas or markets.
  const others = metric.subjectRefs.slice(1).flatMap((ref) => (/^R[1-9]\d*$/.test(ref) ? (ledger.refNames.get(ref) ?? []) : []));
  const context: Context = {
    metric,
    head,
    rest,
    slot: filled ? (filled.pick.label ?? filled.slot.label) : null,
    several: (filled?.slot.count ?? 1) > 1,
    subject: names[0] ?? null,
    others: others.slice(0, 2),
  };
  const spec = KEY_FIGURE_SPECS[metric.key];
  // A short label the report chose stands; a spec names the figure otherwise, live and final alike.
  const curated = curatedLabel(metric, given);
  const label = curated !== "" ? curated : (spec?.label?.(context) ?? keyFigureLabel(job, metric, null));

  const versus =
    spec?.versus !== undefined
      ? spec.versus(context)
      : [
          context.others.length > 0 ? `${PAIR_FORMULAS.has(metric.formulaId) ? "with" : "vs"} ${context.others.join(", ")}` : null,
          comparator ? COMPARATOR_TEXT[comparator] : null,
        ]
          .filter((p): p is string => p !== null)
          .join(" · ") || null;
  const detail = view.unavailable ? [] : (spec?.detail?.(context) ?? rest).map(plainPiece).map(rankWords);
  const parts = [...detail, versus, view.window ? `${view.window} only` : null].filter((p): p is string => p !== null && p !== "");
  return {
    value: view.unavailable ? view.text : (spec?.value?.(context) ?? head) || view.text,
    label,
    comparator: parts.length > 0 ? parts.join(" · ") : null,
  };
}
