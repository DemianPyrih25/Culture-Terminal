import type { BarsPayload, DatasetEnvelope, DatasetId, MetricUnit, NoValueReason, RankedPayload, RankedRow, RowFlag } from "@ct/contracts";
import { desHref, isDesType } from "../../components/des/des-href";
import { formatDollars, formatPeople } from "../brief/format";
import { signed } from "./dna";
import type { BarRowData, ChartBody, ChartTableData, DataRowData, ListItemData, MiniBarData, VerdictGroupData, VerdictKind } from "./types";

/**
 * The Part 9 jobs' charts (taste_twins, brand_collab, creator_fit, launch_test, city_compare) and the
 * public figures beside the taste read (SEC financials, Census economics): which dataset is which, and
 * each one shaped into the rows its card draws. A dataset is known by its formula family first (the
 * skill names it), then by its shape, so a dataset from another skill never takes the wrong card.
 * Missing values stay missing, with their reason in words.
 */

type Bars = Extract<DatasetEnvelope, { kind: "Bars" }>;

const NO_DATA = "No data";

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Whether a dataset names a formula of this family ("twin" holds "twin.rho"). */
const ofFamily = (d: DatasetEnvelope, family: string) => d.formulaIds.some((id) => id === family || id.startsWith(`${family}.`));

const rowsOf = (p: RankedPayload): RankedRow[] => p.groups.flatMap((g) => g.rows);

const VERDICT_FLAGS: ReadonlySet<RowFlag> = new Set<RowFlag>(["KEEP", "VETO", "ADD", "CATEGORY"]);

/** A rank change in places: "+31", "−17" (whole numbers stay whole). */
const places = (v: number) => (Number.isInteger(v) ? (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0") : signed(v));

// Which dataset is which ---------------------------------------------------------------------------------

/** S12 concept check: a Ranked table whose rows carry KEEP, VETO or ADD. */
export function isVerdicts(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && (ofFamily(d, "cnpt") || rowsOf(d.payload).some((r) => r.flags.some((f) => VERDICT_FLAGS.has(f))));
}

/** S11 twins: target areas ranked by their match with the source area. */
export function isTwins(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && (ofFamily(d, "twin") || d.payload.columns.some((c) => c.unit === "similarity" && c.comparator === "CITY"));
}

/** S14 area economics: Census rows per area, a head count among the columns. */
export function isEconomics(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && (ofFamily(d, "econ") || d.payload.columns.some((c) => c.unit === "people"));
}

/** S13 company financials: SEC periods with dollar columns (and no head count, which is Census). */
export function isFinancials(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && !isEconomics(d) && (ofFamily(d, "fin") || d.payload.columns.some((c) => c.unit === "usd"));
}

/** A Block DNA fingerprint with one series: an area against its city, or a city against the other map cities. */
export function isFingerprint(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Bars" && d.payload.series.length === 1 && d.payload.groups.some((g) => g.family !== null);
}

/** Two areas' Block DNA side by side (the source area and its top twin). */
export function isTwinPair(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Bars" && d.payload.series.length === 2 && (ofFamily(d, "twin") || d.payload.groups.some((g) => g.family !== null));
}

/** One-scale scoring (rank_candidates): names ranked by fit within one request. */
export function isScored(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && !isVerdicts(d) && !ofFamily(d, "xdom") && d.formulaIds.includes("pct.within_call");
}

/** Tags only on A, on both and only on B (audience_dna compare). */
export function isTagContrast(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && d.payload.groups.some((g) => g.key === "shared") && d.payload.groups.some((g) => g.key === "a_only" || g.key === "b_only");
}

/** The cultural neighbourhood (cross_domain): one group per domain. */
export function isNeighbourhood(d: DatasetEnvelope | null): boolean {
  return d?.kind === "Ranked" && ofFamily(d, "xdom");
}

// Values -------------------------------------------------------------------------------------------------

/** Why a cell has no value, in a few words. */
export const MISSING_TEXT: Readonly<Record<NoValueReason, string>> = {
  not_scored: "Not scored",
  dropped: "Dropped",
  not_measured: NO_DATA,
  no_signal: "No signal",
  unavailable: NO_DATA,
  quality_gate: "Below the quality bar",
  budget_truncated: "Not fetched",
  insufficient_n: "Too few readings",
  coarse: "Too coarse",
  self: "Same name",
  error: "Request failed",
  not_listed: "Not a listed company",
  not_reported: "Not reported",
  suppressed: "Withheld by the Census",
  not_configured: "Not configured on this server",
};

/**
 * A cell as its unit prints it in a table of public figures: "$1.2B", "38.4%", "12,480", "34.5". A pct
 * value is always a 0–1 share: QUANT computes every public percent itself (a margin is profit over
 * revenue, revenue growth is the change over the prior period, a commute share is mode workers over all
 * workers), so revenue that tripled (2.0) prints as "200.0%", never as "2.0%".
 */
export function unitText(value: number, unit: MetricUnit): string {
  switch (unit) {
    case "usd":
      return formatDollars(value);
    case "people":
    case "count":
      return formatPeople(value);
    case "years":
      return value.toFixed(1);
    case "pct": {
      const points = value * 100;
      return `${points < 0 ? "−" : ""}${Math.abs(points).toFixed(1)}%`;
    }
    case "lift":
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "delta":
    case "index":
      return signed(value);
    case "rank":
      return `#${Math.round(value)}`;
    case "score":
      return value > 1 ? String(Math.round(value)) : value.toFixed(2);
    default:
      return value.toFixed(2);
  }
}

/** A Ranked payload printed as a table: each row's cells by their column's unit, comparator rows last. */
/** A comparator row: flagged as one, or in the whole city's group (area_economics puts the city in group "city"). */
const COMPARISON_GROUPS: ReadonlySet<string> = new Set(["city", "metro", "comparison"]);

/**
 * The whole-city comparison row of area economics when it is built from whole ZIP areas (ANSWER_QUALITY
 * §5): "ZIP areas touching Nashville (approximate: whole ZIP areas, not the city itself)". Runs stored
 * before the label changed ("Nashville ZIP areas (whole ZIPs)") read the same; any other label stays.
 */
export function zipCityLabel(label: string): string {
  const old = /^(.+?) ZIP areas \(whole ZIPs\)$/.exec(label.trim());
  return old ? `ZIP areas touching ${old[1]} (approximate: whole ZIP areas, not the city itself)` : label;
}

export function dataRows(p: RankedPayload): { body: Extract<ChartBody, { type: "rows" }>; table: ChartTableData; comparisons: number } {
  const tagged = p.groups.flatMap((g) => g.rows.map((r) => ({ r, comparison: r.comparison === true || COMPARISON_GROUPS.has(g.key) })));
  const ordered = [...tagged.filter((x) => !x.comparison), ...tagged.filter((x) => x.comparison)];
  const shaped: DataRowData[] = ordered.map(({ r, comparison }) => ({
    label: comparison ? zipCityLabel(r.label) : r.label,
    sublabel: r.sublabel,
    comparison,
    cells: p.columns.map((col, c) => {
      const cell = r.cells[c];
      if (!cell || cell.value === null) return cell?.reason ? MISSING_TEXT[cell.reason] : NO_DATA;
      return unitText(cell.value, col.unit);
    }),
  }));
  const columns = p.columns.map((c) => ({ label: c.label, numeric: true }));
  return {
    comparisons: shaped.filter((r) => r.comparison).length,
    body: { type: "rows", columns, rows: shaped },
    table: {
      columns: [{ label: "Row" }, ...columns],
      rows: shaped.map((r) => [r.sublabel ? `${r.label} (${r.sublabel})` : r.label, ...r.cells]),
    },
  };
}

// Twins (S11) --------------------------------------------------------------------------------------------

export interface TwinRow {
  label: string;
  /** Spearman ρ of the two areas' differences from their own cities; null when not measured. */
  rho: number | null;
  reason: NoValueReason | null;
  /** Tags new to both areas' city lists that both areas share; null when the dataset has no such column. */
  sharedNew: number | null;
}

/** The twins table's rows, best match first, unmeasured last; `checked` counts the areas with a match. */
export function twinRows(p: RankedPayload): { rows: TwinRow[]; checked: number } {
  const rhoAt = Math.max(
    0,
    p.columns.findIndex((c) => c.unit === "similarity" || /rho|ρ|match/i.test(`${c.key} ${c.label}`)),
  );
  const newAt = p.columns.findIndex((c, i) => i !== rhoAt && c.unit === "count");
  const rows = rowsOf(p)
    .filter((r) => r.comparison !== true)
    .map((r): TwinRow => {
      const cell = r.cells[rhoAt];
      const shared = newAt >= 0 ? (r.cells[newAt]?.value ?? null) : null;
      return { label: r.label, rho: cell?.value ?? null, reason: cell?.reason ?? null, sharedNew: shared === null ? null : Math.round(shared) };
    })
    .sort((a, b) => (b.rho ?? -Infinity) - (a.rho ?? -Infinity));
  return { rows, checked: rows.filter((r) => r.rho !== null).length };
}

/** "0.71": a match as printed. */
export const rhoText = (rho: number) => (rho < 0 ? `−${Math.abs(rho).toFixed(2)}` : rho.toFixed(2));

/** How close a match is, in words: the thresholds of the twins' caption. */
export function rhoWord(rho: number): string {
  if (rho >= 0.6) return "a close match";
  if (rho >= 0.3) return "a partial match";
  if (rho > 0) return "a weak match";
  return "no match";
}

export function twinsChart(p: RankedPayload): { body: ChartBody; table: ChartTableData; checked: number } {
  const { rows, checked } = twinRows(p);
  const bars: BarRowData[] = rows.slice(0, 8).map((r, i) => ({
    label: r.label,
    sublabel: r.sharedNew !== null && r.sharedNew > 0 ? `${r.sharedNew} shared ${r.sharedNew === 1 ? "taste" : "tastes"} new to both cities` : null,
    // A negative match draws no bar: the areas differ from their cities in opposite ways.
    fraction: r.rho === null ? 0 : clamp01(r.rho),
    display: r.rho === null ? (r.reason ? MISSING_TEXT[r.reason] : NO_DATA) : rhoText(r.rho),
    tone: i === 0 && r.rho !== null && r.rho > 0 ? "accent" : "muted",
    tag: null,
  }));
  return {
    body: { type: "bars", rows: bars },
    checked,
    table: {
      columns: [{ label: "Area" }, { label: "Match (ρ)", numeric: true }, { label: "In words" }, { label: "Shared new tastes", numeric: true }],
      rows: rows.map((r) => [r.label, r.rho === null ? NO_DATA : rhoText(r.rho), r.rho === null ? "" : rhoWord(r.rho), r.sharedNew === null ? "" : String(r.sharedNew)]),
    },
  };
}

/**
 * What the source area and its twin share (a two-series Block DNA): the tags both rank higher than their
 * own city, and the tags both rank lower. A tag only one side over-indexes is in the Table view only.
 */
export function twinShared(p: BarsPayload): { body: ChartBody; table: ChartTableData } {
  const tags = p.groups.flatMap((g) =>
    g.bars.map((b) => ({ label: b.label, a: b.values[0]?.value ?? null, b: b.values[1]?.value ?? null, isNew: b.isNew })),
  );
  const both = tags.filter((t): t is { label: string; a: number; b: number; isNew: boolean } => t.a !== null && t.b !== null);
  const max = Math.max(1e-9, ...both.map((t) => Math.min(Math.abs(t.a), Math.abs(t.b))));
  const row = (t: { label: string; a: number; b: number; isNew: boolean }): MiniBarData => ({
    label: t.label,
    display: `${places(t.a)} / ${places(t.b)}`,
    fraction: clamp01(Math.min(Math.abs(t.a), Math.abs(t.b)) / max),
    tag: t.isNew ? "new-here" : null,
  });
  const strength = (t: { a: number; b: number }) => Math.min(Math.abs(t.a), Math.abs(t.b));
  const more = both.filter((t) => t.a > 0 && t.b > 0).sort((x, y) => strength(y) - strength(x)).slice(0, 5).map(row);
  const less = both.filter((t) => t.a < 0 && t.b < 0).sort((x, y) => strength(y) - strength(x)).slice(0, 5).map(row);
  const [a, b] = [p.series[0]?.label ?? "Source", p.series[1]?.label ?? "Twin"];
  const cell = (v: number | null) => (v === null ? NO_DATA : places(v));
  return {
    body: { type: "more-less", more, less, heads: ["Both have more of", "Both have less of"] },
    table: {
      columns: [{ label: "Taste" }, { label: a, numeric: true }, { label: b, numeric: true }],
      rows: tags.map((t) => [t.label, cell(t.a), cell(t.b)]),
    },
  };
}

// Concept check (S12) ------------------------------------------------------------------------------------

const VERDICT_TITLE: Readonly<Record<VerdictKind, string>> = {
  keep: "Kept: the data backs these",
  add: "Found in the data, not guessed",
  veto: "Dropped: the data does not back these",
  unscored: "Not scored",
  category: "Measured against the category only: no keep or veto",
};

const VERDICT_ORDER: readonly VerdictKind[] = ["keep", "add", "veto", "category", "unscored"];

/** A CATEGORY row (R2) is never kept or dropped, whatever else it carries. */
const verdictOf = (r: RankedRow): VerdictKind =>
  r.flags.includes("CATEGORY") ? "category" : r.flags.includes("KEEP") ? "keep" : r.flags.includes("VETO") ? "veto" : r.flags.includes("ADD") ? "add" : "unscored";

const profile = (r: RankedRow) => (r.type !== null && isDesType(r.type) && r.label.trim() !== "" ? desHref({ name: r.label, type: r.type }) : null);

/** The analogs checked against the concept: kept, found, dropped (struck, never a pick) and unscored, each in words. */
export function verdictGroups(p: RankedPayload): { body: ChartBody; table: ChartTableData; counts: Record<VerdictKind, number> } {
  const gapAt = p.columns.findIndex((c) => c.unit === "delta" || c.unit === "affinity");
  const rankAt = p.columns.findIndex((c) => c.unit === "rank");
  const rows = rowsOf(p).filter((r) => r.comparison !== true);
  // In words, from what the row holds: its gap to the bar, else its rank for the concept, else the skill's own words.
  const display = (r: RankedRow, kind: VerdictKind): string => {
    const gap = gapAt >= 0 ? (r.cells[gapAt]?.value ?? null) : null;
    if (gap !== null && (kind === "keep" || kind === "veto")) return `${Math.abs(gap).toFixed(2)} ${kind === "keep" ? "above" : "below"} the bar`;
    const rank = rankAt >= 0 ? (r.cells[rankAt]?.value ?? null) : null;
    if (kind === "category") return rank !== null ? `#${Math.round(rank)} for the category` : "fit with the category, not the concept";
    if (rank !== null && kind !== "veto") return `#${Math.round(rank)} for the concept`;
    if (kind === "add" && r.rank !== null) return `#${r.rank} for the concept`;
    const said = r.sublabel?.trim();
    if (said) return said;
    return kind === "keep" ? "at or above the bar" : kind === "veto" ? "below the bar" : kind === "add" ? "a top result for the concept" : "not scored";
  };
  const groups: VerdictGroupData[] = VERDICT_ORDER.map((verdict) => ({
    verdict,
    title: VERDICT_TITLE[verdict],
    rows: rows
      .filter((r) => verdictOf(r) === verdict)
      .map((r) => ({ label: r.label, display: display(r, verdict), href: verdict === "veto" ? null : profile(r) })),
  })).filter((g) => g.rows.length > 0);
  const counts = { keep: 0, add: 0, veto: 0, unscored: 0, category: 0 } as Record<VerdictKind, number>;
  for (const r of rows) counts[verdictOf(r)] += 1;
  return {
    body: { type: "verdicts", groups },
    counts,
    table: {
      columns: [{ label: "Name" }, { label: "Verdict" }, { label: "Against the bar" }],
      rows: groups.flatMap((g) => g.rows.map((r) => [r.label, g.title.split(":")[0] ?? g.title, r.display])),
    },
  };
}

// One-scale scoring --------------------------------------------------------------------------------------

/** A fit as printed: "92/100" (a within-call percentile, 0–1 or 0–100). */
export const fitText = (fit: number) => `${Math.round(fit > 1 ? fit : fit * 100)}/100`;

/** Names scored on one scale, best first: the subject itself (when scored) stays in the list for scale. */
export function scoredBars(p: RankedPayload, subjectRef: string | null): { body: ChartBody; table: ChartTableData; scored: number } {
  const fitAt = Math.max(0, p.columns.findIndex((c) => c.key === "fit" || c.unit === "pct"));
  const rows = rowsOf(p)
    .map((r) => ({ r, fit: r.cells[fitAt]?.value ?? null, reason: r.cells[fitAt]?.reason ?? null }))
    .sort((a, b) => (b.fit ?? -Infinity) - (a.fit ?? -Infinity));
  const others = rows.filter((x) => x.r.ref === null || x.r.ref !== subjectRef);
  const own = rows.find((x) => x.r.ref !== null && x.r.ref === subjectRef);
  const top = others.slice(0, own ? 7 : 8);
  const shown = own ? [...top, own] : top;
  const bars: BarRowData[] = shown.map((x, i) => ({
    label: x.r.label,
    sublabel: x === own ? "your brand, for scale" : null,
    fraction: x.fit === null ? 0 : clamp01(x.fit > 1 ? x.fit / 100 : x.fit),
    display: x.fit === null ? (x.reason ? MISSING_TEXT[x.reason] : NO_DATA) : fitText(x.fit),
    tone: i === 0 && x !== own && x.fit !== null ? "accent" : "muted",
    tag: x.r.flags.includes("UTR") ? "hidden-gem" : null,
  }));
  return {
    body: { type: "bars", rows: bars },
    scored: rows.filter((x) => x.fit !== null).length,
    table: {
      columns: [{ label: "Name" }, { label: "Fit (0–100)", numeric: true }],
      rows: rows.map((x) => [x.r.label, x.fit === null ? (x.reason ? MISSING_TEXT[x.reason] : NO_DATA) : fitText(x.fit)]),
    },
  };
}

// Tag contrast and city fingerprints -----------------------------------------------------------------------

/** "Only Brand A", "Both", "Only Brand B": the audience tags as three name columns. */
export function contrastColumns(p: RankedPayload): { body: ChartBody; table: ChartTableData; shared: number; total: number } {
  const order = ["a_only", "shared", "b_only"];
  const groups = order.flatMap((k) => p.groups.filter((g) => g.key === k));
  const columns = groups.map((g) => ({
    key: g.key,
    label: g.key === "shared" ? "Both audiences" : g.label,
    icon: g.key === "shared" ? ("users" as const) : ("user-round" as const),
    items: g.rows.slice(0, 6).map((r, i): ListItemData => ({ rank: i + 1, label: r.label, gem: false, href: null })),
  }));
  const shared = p.groups.find((g) => g.key === "shared")?.rows.length ?? 0;
  return {
    body: { type: "neighbours", columns },
    shared,
    total: rowsOf(p).length,
    table: { columns: [{ label: "Group" }, { label: "Tag" }], rows: groups.flatMap((g) => g.rows.map((r) => [g.label, r.label])) },
  };
}

export interface Fingerprint {
  datasetId: DatasetId;
  /** The city (or area) the fingerprint reads. */
  name: string;
  /** Its tags it ranks higher than its comparator, strongest first. */
  top: { label: string; value: number; isNew: boolean }[];
}

/** A fingerprint's over-represented tags, strongest first. */
export function fingerprintOf(d: Bars): Fingerprint {
  const name = d.payload.series[0]?.label ?? d.title;
  const top = d.payload.groups
    .flatMap((g) => g.bars.map((b) => ({ label: b.label, value: b.values[0]?.value ?? null, isNew: b.isNew })))
    .filter((b): b is { label: string; value: number; isNew: boolean } => b.value !== null && b.value > 0)
    .sort((a, b) => b.value - a.value);
  return { datasetId: d.id, name, top };
}

/** Cities side by side: one column per city of the tags it ranks higher than the other map cities. */
export function fingerprintColumns(prints: readonly Fingerprint[]): { body: ChartBody; table: ChartTableData } {
  return {
    body: {
      type: "neighbours",
      columns: prints.slice(0, 4).map((f) => ({
        key: f.datasetId,
        label: f.name,
        icon: "map-pin" as const,
        items: f.top.slice(0, 5).map((t, i): ListItemData => ({ rank: i + 1, label: t.label, gem: false, href: null })),
      })),
    },
    table: {
      columns: [{ label: "City" }, { label: "Taste" }, { label: "Ranks higher than the other map cities by", numeric: true }],
      rows: prints.flatMap((f) => f.top.slice(0, 8).map((t) => [f.name, t.label, `${Math.round(t.value)} places`])),
    },
  };
}

