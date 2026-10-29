import {
  METRO_LABEL,
  type BarsPayload,
  type DatasetEnvelope,
  type GeoLiftPayload,
  type Job,
  type MatrixPayload,
  type MetricUnit,
  type RankedPayload,
  type SlatePayload,
  type SlopePayload,
} from "@ct/contracts";
import { DEFAULT_DES_TYPE, desHref, isDesType } from "../../components/des/des-href";
import { fewRivals, supplyUnknown } from "../../components/figures/lift-scale";
import { formatTrendWindow, type BriefFigure } from "../brief";
import { formatDollars, formatPeople } from "../brief/format";
import { BLOCK_FAMILY_LABEL, CHART_COPY, DOMAIN_COLUMN, ENTITY_NOUN, SPONSOR_ICON } from "./copy";
import { signed } from "./dna";
import {
  contrastColumns,
  dataRows,
  fingerprintColumns,
  fingerprintOf,
  isEconomics,
  isFinancials,
  isFingerprint,
  isNeighbourhood,
  isScored,
  isTagContrast,
  isTwinPair,
  isTwins,
  isVerdicts,
  scoredBars,
  twinShared,
  twinsChart,
  verdictGroups,
} from "./job-shapes";
import { marketState } from "./markets";
import type { AnswerChart, AnswerDatasets, BarRowData, ChartBody, ChartTableData, MoreChart, PairRowData, WinnerRowData } from "./types";

/**
 * The answer's charts (§2.6–2.10): which figure of the report each job leads with, and each one shaped into
 * the rows its card draws (bars, winners, a map, more and less, fit rows, a slate, lists, diverging rows,
 * rank tracks), with its Table view. Missing data stays missing: a row with no value prints "No data".
 */

/** What the shaping reads besides the figure: the subject's reference and names. */
export interface ChartContext {
  job: Job | null;
  /** The primary subject's ref (R1) and name. */
  subjectRef: string | null;
  subject: string | null;
  /** head_to_head: the second brand's ref and name. */
  secondRef: string | null;
  second: string | null;
  /** The city a place answer reads ("Austin"). */
  city: string | null;
  /** The subject's entity type, for "vs 4 other artists". */
  subjectType: keyof typeof ENTITY_NOUN | null;
}

/** `third`: the public figures beside the taste read (SEC financials, Census economics), on their own row. */
export type ChartSlot = "main" | "second" | "third" | "map";

const NO_DATA = "No data";

/** A figure's dataset: streamed inline, or fetched after the first paint. */
export function datasetOf(figure: BriefFigure, fetched: AnswerDatasets = {}): DatasetEnvelope | null {
  return figure.dataset ?? fetched[figure.datasetId] ?? null;
}

const isBars = (d: DatasetEnvelope | null): d is Extract<DatasetEnvelope, { kind: "Bars" }> => d?.kind === "Bars";

/**
 * How much of the question a lift map answers: the areas it names (the scan's map carries them) count
 * most, then a venue sample or the reason it has none. The answer reads its map, "Your area" and
 * competition from the map that scores highest, the first in report order on a tie, so an ANALYST map
 * made without them (another concept, supply off) never hides what the scan's map measured.
 */
export function liftMapScore(payload: GeoLiftPayload): number {
  return ((payload.focusAreas ?? []).length > 0 ? 2 : 0) + (payload.supply !== null || payload.supplyGap !== undefined ? 1 : 0);
}

/** The lift map the answer reads, among the figures whose data is here, or null. */
export function bestLiftFigure(
  figures: readonly BriefFigure[],
  fetched: AnswerDatasets = {},
  skip: (f: BriefFigure) => boolean = () => false,
): { figure: BriefFigure; data: Extract<DatasetEnvelope, { kind: "GeoLift" }> } | null {
  let best: { figure: BriefFigure; data: Extract<DatasetEnvelope, { kind: "GeoLift" }> } | null = null;
  for (const figure of figures) {
    const d = datasetOf(figure, fetched);
    if (d?.kind !== "GeoLift" || skip(figure)) continue;
    if (best === null || liftMapScore(d.payload) > liftMapScore(best.data.payload)) best = { figure, data: d };
  }
  return best;
}

/** The figures each job's slots take: the first match in report order (a missing figure drops its card). */
export function selectFigures(job: Job | null, figures: readonly BriefFigure[], fetched: AnswerDatasets = {}): Record<ChartSlot, BriefFigure | null> {
  const used = new Set<BriefFigure>();
  const pick = (test: (d: DatasetEnvelope, f: BriefFigure) => boolean): BriefFigure | null => {
    for (const f of figures) {
      if (used.has(f)) continue;
      const d = datasetOf(f, fetched);
      if (d && test(d, f)) {
        used.add(f);
        return f;
      }
    }
    return null;
  };
  const block = (d: DatasetEnvelope) => isBars(d) && d.payload.method !== null;
  const dna = (d: DatasetEnvelope) => isBars(d) && d.payload.method === null;
  const share = (d: DatasetEnvelope) => d.kind === "Matrix" && d.payload.mode === "share";
  const none = { main: null, second: null, third: null, map: null };
  switch (job) {
    case "brand_health":
      // Reported financials sit beside the taste read, never inside it (PLAN §5.5).
      return { ...none, main: pick((d) => d.kind === "Matrix" && d.payload.mode === "similarity"), second: pick(isFinancials) };
    case "head_to_head":
      return {
        ...none,
        main: pick((d) => isBars(d) && d.payload.series.length === 2 && d.payload.display === "split") ?? pick((d) => isBars(d) && d.payload.series.length === 2),
        second: pick(isFinancials),
      };
    case "site_selection": {
      const lift = bestLiftFigure(figures, fetched)?.figure ?? null;
      if (lift) used.add(lift);
      return { map: lift, main: null, second: pick(block), third: pick(isEconomics) };
    }
    case "tenant_mix":
      return { map: null, main: pick((d) => d.kind === "Slope" && d.payload.scoreLabel !== null), second: pick(block), third: pick(isEconomics) };
    case "area_profile":
      return { map: null, main: pick((d) => d.kind === "Slope"), second: pick(block), third: pick(isEconomics) };
    case "sponsorship":
      return { ...none, main: pick((d) => d.kind === "Slate"), second: pick((d) => d.kind === "Ranked") };
    case "market_selection":
      return { ...none, main: pick(share) };
    case "audience_discovery":
      return { ...none, main: pick(dna), second: pick((d) => d.kind === "Ranked" && d.payload.groups.length > 1) ?? pick((d) => d.kind === "Ranked") };
    case "taste_twins":
      return { ...none, main: pick(isTwins), second: pick(isTwinPair), third: pick(isEconomics) };
    case "brand_collab":
      return { ...none, main: pick(isScored) ?? pick(isNeighbourhood), second: pick(isTagContrast) ?? pick(isNeighbourhood) ?? pick(dna) };
    case "creator_fit":
      return { ...none, main: pick(isNeighbourhood) ?? pick(isScored), second: pick(isScored) ?? pick(share) };
    case "launch_test":
      return { ...none, main: pick(isVerdicts), second: pick(share) ?? pick(isNeighbourhood) ?? pick(dna), third: pick(isFinancials) };
    case "city_compare":
      return { ...none, main: pick(isFingerprint), second: pick(share), third: pick(isEconomics) };
    default:
      return none;
  }
}

// Formatting ---------------------------------------------------------------------------------------------

/** A value as its unit prints it: "0.84", "1.48×", "+38", "91/100". */
export function formatValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case "lift":
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "delta":
      return Number.isInteger(value) ? (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0") : signed(value);
    case "index":
      return signed(value);
    case "rank":
      return `#${Math.round(value)}`;
    case "count":
      return String(Math.round(value));
    case "score":
      return value > 1 ? String(Math.round(value)) : value.toFixed(2);
    case "usd":
      return formatDollars(value);
    case "people":
      return formatPeople(value);
    case "years":
      return value.toFixed(1);
    default:
      return value.toFixed(2);
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The series of a two-series payload that is the subject: by ref, else the first. */
function subjectIndex(series: BarsPayload["series"], ctx: ChartContext): number {
  const at = series.findIndex((s) => s.ref !== null && s.ref === ctx.subjectRef);
  if (at >= 0) return at;
  const byName = series.findIndex((s) => ctx.subject !== null && s.label === ctx.subject);
  return byName >= 0 ? byName : 0;
}

// Shapes ----------------------------------------------------------------------------------------------------

function closestAudiences(data: MatrixPayload, ctx: ChartContext): { body: ChartBody; table: ChartTableData } {
  const target = data.targetKey ?? data.rows.find((r) => r.ref !== null && r.ref === ctx.subjectRef)?.key ?? data.rows[0]?.key ?? null;
  const r = data.rows.findIndex((row) => row.key === target);
  const cells = r >= 0 ? (data.cells[r] ?? []) : [];
  const peers = data.cols
    .map((col, c) => ({ col, cell: cells[c] }))
    .filter(({ col, cell }) => col.key !== target && cell !== undefined && cell.reason !== "self")
    .map(({ col, cell }) => ({ label: col.label, value: cell?.value ?? null }))
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
    .slice(0, 5);
  const rows: BarRowData[] = peers.map((p, i) => ({
    label: p.label,
    sublabel: null,
    fraction: p.value === null ? 0 : clamp01(p.value),
    display: p.value === null ? NO_DATA : p.value.toFixed(2),
    // The peers' categories are unknown here (G-A3): the closest is the accent, the rest muted.
    tone: i === 0 ? "accent" : "muted",
    tag: null,
  }));
  return {
    body: { type: "bars", rows },
    table: { columns: [{ label: "Brand" }, { label: "Match", numeric: true }], rows: rows.map((row) => [row.label, row.display]) },
  };
}

const GROUP_TITLE: Readonly<Record<string, string>> = { METRO: "Cities", MARKET: "Cities", AGE: "Age groups", GENDER: "Gender" };
const SCORE_NOUN: Readonly<Record<string, string>> = { METRO: "cities", MARKET: "cities", AGE: "age groups", GENDER: "groups" };

function winnerRows(data: BarsPayload, ctx: ChartContext): { title: string; key: string; rows: WinnerRowData[] }[] {
  const a = subjectIndex(data.series, ctx);
  const b = a === 0 ? 1 : 0;
  const band = data.evenBand ?? 0;
  return data.groups.map((g) => ({
    key: g.key,
    title: GROUP_TITLE[g.key] ?? g.label,
    rows: g.bars.map((bar) => {
      const va = bar.values[a]?.value ?? null;
      const vb = bar.values[b]?.value ?? null;
      const winner = va === null || vb === null ? null : va > vb + band ? "a" : vb > va + band ? "b" : null;
      return { label: bar.label, winner } satisfies WinnerRowData;
    }),
  }));
}

/** Who wins where (head_to_head): the pair's split by city, and by age from the age figure when there is one. */
function whoWinsWhere(data: BarsPayload, ages: BarsPayload | null, ctx: ChartContext): { body: ChartBody; table: ChartTableData } {
  const tables = winnerRows(data, ctx);
  if (ages) for (const t of winnerRows(ages, ctx)) if (!tables.some((x) => x.key === t.key)) tables.push(t);
  const first = tables[0];
  const score = first
    ? {
        a: first.rows.filter((r) => r.winner === "a").length,
        b: first.rows.filter((r) => r.winner === "b").length,
        label: `${SCORE_NOUN[first.key] ?? "groups"} where each ranks first`,
      }
    : null;
  const subject = ctx.subject ?? data.series[subjectIndex(data.series, ctx)]?.label ?? "First";
  const second = ctx.second ?? data.series.find((_, i) => i !== subjectIndex(data.series, ctx))?.label ?? "Second";
  const leader = (w: WinnerRowData["winner"]) => (w === "a" ? subject : w === "b" ? second : "Even");
  return {
    body: { type: "winner", a: subject, b: second, score, tables: tables.map(({ title, rows }) => ({ title, rows })) },
    table: {
      columns: [{ label: "Group" }, { label: "Where" }, { label: "Ranks first" }],
      rows: tables.flatMap((t) => t.rows.map((r) => [t.title, r.label, leader(r.winner)])),
    },
  };
}

function bestAreas(data: GeoLiftPayload): { body: ChartBody; table: ChartTableData } {
  const ranked = data.neighbourhoods
    .filter((n) => n.lift !== null)
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
  const areas = ranked.slice(0, 3).map((n, i) => ({
    rank: i + 1,
    name: n.name,
    display: `${(n.lift ?? 0).toFixed(2)}× interest`,
    fewRivals: fewRivals(n, data),
  }));
  const city = METRO_LABEL[data.metro];
  // Competition reads unknown when similar venues could not be counted, never as no venues.
  const venues =
    supplyUnknown(data) !== null
      ? " Similar venues could not be counted area by area, so competition is unknown."
      : data.supply
        ? " Venues are a sample of Qloo's venues, not every business."
        : "";
  // The boundary credit the licence asks the map to show (the answer drops it from its caveats).
  const caption = `Interest is shared taste vs a typical ${city} ${data.baseline.label.replace(/s$/, "")} area.${venues} Boundaries: ${data.boundarySource.trim().replace(/\.$/, "")}.`;
  return {
    body: { type: "map", data, areas, caption },
    table: {
      columns: [{ label: "Area" }, { label: "Interest", numeric: true }],
      rows: ranked.slice(0, 8).map((n) => [n.name, `${(n.lift ?? 0).toFixed(2)}×`]),
    },
  };
}

interface FlatBar {
  group: string;
  family: string | null;
  label: string;
  value: number | null;
  isNew: boolean;
}

function flatBars(data: BarsPayload, index = 0): FlatBar[] {
  return data.groups.flatMap((g) =>
    g.bars.map((b) => ({ group: g.label, family: g.family, label: b.label, value: b.values[index]?.value ?? null, isNew: b.isNew })),
  );
}

/** More here and less here (site_selection): two mini-bar columns. */
function moreLess(data: BarsPayload): { body: ChartBody; table: ChartTableData } {
  const bars = flatBars(data).filter((b) => b.value !== null);
  const max = Math.max(...bars.map((b) => Math.abs(b.value ?? 0)), 1e-9);
  const row = (b: FlatBar) => ({
    label: b.label,
    display: formatValue(b.value ?? 0, data.unit),
    fraction: clamp01(Math.abs(b.value ?? 0) / max),
    tag: b.isNew ? ("new-here" as const) : null,
  });
  const more = bars.filter((b) => (b.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 5).map(row);
  const less = bars.filter((b) => (b.value ?? 0) < 0).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).slice(0, 5).map(row);
  return {
    body: { type: "more-less", more, less },
    table: {
      columns: [{ label: "Tag" }, { label: "Side" }, { label: data.valueLabel || "Value", numeric: true }],
      rows: [...more.map((m) => [m.label, "More here", m.display]), ...less.map((l) => [l.label, "Less here", l.display])],
    },
  };
}

/** More and less of, by group (tenant_mix, area_profile): the strongest of each side per group. */
function lessMorePairs(data: BarsPayload): { body: ChartBody; table: ChartTableData } {
  const bars = flatBars(data).filter((b) => b.value !== null);
  const max = Math.max(...bars.map((b) => Math.abs(b.value ?? 0)), 1e-9);
  const side = (b: FlatBar | undefined) =>
    b ? { label: b.label, display: formatValue(b.value ?? 0, data.unit), fraction: clamp01(Math.abs(b.value ?? 0) / max) } : null;
  const groupName = (b: FlatBar) => (b.family ? (BLOCK_FAMILY_LABEL[b.family] ?? b.group) : b.group);
  const groups = [...new Set(bars.map(groupName))];
  let rows: PairRowData[];
  if (groups.length > 1) {
    rows = groups.map((g) => {
      const own = bars.filter((b) => groupName(b) === g);
      const more = own.filter((b) => (b.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
      const less = own.filter((b) => (b.value ?? 0) < 0).sort((a, b) => (a.value ?? 0) - (b.value ?? 0))[0];
      return { group: g, less: side(less), more: side(more) };
    });
  } else {
    // One family: its strongest gains and losses, paired by rank.
    const more = bars.filter((b) => (b.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 4);
    const less = bars.filter((b) => (b.value ?? 0) < 0).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).slice(0, 4);
    rows = Array.from({ length: Math.max(more.length, less.length) }, (_, i) => ({
      group: i === 0 ? (groups[0] ?? "") : "",
      less: side(less[i]),
      more: side(more[i]),
    }));
  }
  return {
    body: { type: "pair", rows },
    table: {
      columns: [{ label: "Tag" }, { label: "Side" }, { label: data.valueLabel || "Value", numeric: true }],
      rows: bars
        .slice()
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        .map((b) => [b.label, (b.value ?? 0) > 0 ? "More here" : "Less here", formatValue(b.value ?? 0, data.unit)]),
    },
  };
}

/** Tenant fit (tenant_mix) or who climbs (area_profile): ranked fit rows. */
function fitRows(data: SlopePayload): { body: ChartBody; table: ChartTableData } {
  const climbLabel = data.scoreLabel !== null ? "fits better here than citywide" : "climbs here vs citywide";
  const last = data.axes.length - 1;
  const scored = data.scoreLabel !== null;
  const lines = data.lines.slice().sort((a, b) =>
    scored ? (b.score ?? -Infinity) - (a.score ?? -Infinity) : (a.points[last]?.rank ?? Infinity) - (b.points[last]?.rank ?? Infinity),
  );
  const of = data.lines.length;
  const rows = lines.slice(0, 6).map((l, i) => {
    const here = l.points[last]?.rank ?? null;
    const city = l.points[0]?.rank ?? null;
    const climbs = l.highlight || (here !== null && city !== null && here < city);
    if (scored) {
      const score = l.score;
      return { rank: i + 1, label: l.label, fraction: score === null ? 0 : clamp01(score / 100), display: score === null ? NO_DATA : `${Math.round(score)}/100`, climbs };
    }
    return { rank: i + 1, label: l.label, fraction: here === null ? 0 : clamp01((of - here + 1) / of), display: here === null ? NO_DATA : `#${here} of ${of}`, climbs };
  });
  const cityAxis = data.axes[0]?.label ?? "City";
  const hereAxis = data.axes[last]?.label ?? "Here";
  return {
    body: { type: "fit", rows, climbLabel },
    table: {
      columns: [{ label: "Tenant" }, ...(scored ? [{ label: data.scoreLabel ?? "Fit", numeric: true }] : []), { label: hereAxis, numeric: true }, { label: cityAxis, numeric: true }],
      rows: lines.map((l) => [
        l.label,
        ...(scored ? [l.score === null ? NO_DATA : `${Math.round(l.score)}/100`] : []),
        l.points[last]?.rank ? `#${l.points[last]?.rank}` : NO_DATA,
        l.points[0]?.rank ? `#${l.points[0]?.rank}` : NO_DATA,
      ]),
    },
  };
}

/** A name's profile page, for the types a profile describes; null for any other (a place, a book). */
function profileHref(name: string, type: string | null): string | null {
  return type !== null && isDesType(type) && name.trim() !== "" ? desHref({ name, type }) : null;
}

function slateRows(data: SlatePayload): { body: ChartBody; table: ChartTableData } {
  const rows = data.rows.map((r) => ({
    category: r.label,
    icon: SPONSOR_ICON[r.category] ?? ("shopping-bag" as const),
    best: r.best?.label ?? null,
    // A sponsor's best fit is a brand: its name opens its profile.
    href: r.best ? profileHref(r.best.label, DEFAULT_DES_TYPE) : null,
    fraction: r.best?.fit.value === null || r.best === null ? 0 : clamp01(r.best.fit.value),
    display: r.best?.fit.value === null || r.best === null ? NO_DATA : `${r.best.fit.value.toFixed(2)} fit`,
    gem: r.best?.utr ?? false,
    missing: r.best === null ? NO_DATA : null,
  }));
  return {
    body: { type: "slate", rows },
    table: {
      columns: [{ label: "Category" }, { label: "Best fit" }, { label: "Fit", numeric: true }, { label: "Note" }],
      rows: rows.map((r) => [r.category, r.best ?? NO_DATA, r.display.replace(/ fit$/, ""), r.gem ? "Hidden gem" : ""]),
    },
  };
}

function rankedList(data: RankedPayload, columns: boolean): { body: ChartBody; table: ChartTableData } {
  const table: ChartTableData = {
    columns: [{ label: "Group" }, { label: "Rank", numeric: true }, { label: "Name" }, { label: "Note" }],
    rows: data.groups.flatMap((g) => g.rows.map((r, i) => [g.label, String(r.rank ?? i + 1), r.label, r.flags.includes("UTR") ? "Hidden gem" : ""])),
  };
  if (columns) {
    return {
      body: {
        type: "neighbours",
        columns: data.groups.slice(0, 4).map((g) => {
          const domain = g.rows[0]?.type ?? g.key;
          const head = DOMAIN_COLUMN[domain] ?? DOMAIN_COLUMN[g.key] ?? { label: g.label, icon: "shopping-bag" as const };
          return {
            key: g.key,
            label: head.label,
            icon: head.icon,
            items: g.rows.slice(0, 5).map((r, i) => ({ rank: r.rank ?? i + 1, label: r.label, gem: r.flags.includes("UTR"), href: profileHref(r.label, r.type ?? domain) })),
          };
        }),
      },
      table,
    };
  }
  const rows = data.groups.flatMap((g) => g.rows).slice(0, 8).map((r, i) => ({ rank: i + 1, label: r.label, gem: r.flags.includes("UTR"), href: null }));
  return { body: { type: "numbered", rows }, table };
}

/** Who the fans are (audience_discovery): the subject's indices as diverging rows, gender first. */
function fansRows(data: BarsPayload, ctx: ChartContext): { body: ChartBody; table: ChartTableData } {
  const at = data.series.length > 1 ? subjectIndex(data.series, ctx) : 0;
  const groups = data.groups.slice().sort((a, b) => (a.key === "GENDER" ? -1 : b.key === "GENDER" ? 1 : 0));
  const rows = groups.flatMap((g) =>
    g.bars.map((b) => {
      const value = b.values[at]?.value ?? null;
      return { label: b.label, value, display: value === null ? NO_DATA : formatValue(value, data.unit === "index" ? "index" : data.unit) };
    }),
  );
  const max = Math.max(0.48, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return {
    body: { type: "diverging", rows, max },
    table: { columns: [{ label: "Group" }, { label: "vs average audience", numeric: true }], rows: rows.map((r) => [r.label, r.display]) },
  };
}

/** Where the subject out-draws its peers (market_selection): rank among the set in each market. */
function marketRanks(data: MatrixPayload, ctx: ChartContext): { body: ChartBody; table: ChartTableData } {
  let c = data.cols.findIndex((col) => col.ref !== null && col.ref === ctx.subjectRef);
  if (c < 0) c = data.cols.findIndex((col) => col.key === data.targetKey);
  if (c < 0) c = 0;
  const rows = data.rows
    .map((row, r) => {
      const cells = data.cells[r] ?? [];
      const cell = cells[c];
      const of = cells.filter((x) => x.value !== null).length || data.cols.length;
      const rank = cell?.rank ?? null;
      return { label: row.label, sublabel: marketState(row), rank, of, display: rank === null ? NO_DATA : `#${rank} of ${of}`, gem: false, value: cell?.value ?? null };
    })
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (b.value ?? 0) - (a.value ?? 0));
  return {
    body: { type: "ranks", rows: rows.map((r) => ({ label: r.label, sublabel: r.sublabel, rank: r.rank, of: r.of, display: r.display, gem: r.gem })) },
    table: { columns: [{ label: "Market" }, { label: "Rank", numeric: true }], rows: rows.map((r) => [r.sublabel ? `${r.label}, ${r.sublabel}` : r.label, r.display]) },
  };
}

/** The other Bars figure of a head-to-head (its ages), when the report has one. */
function agesOf(figures: readonly BriefFigure[], used: BriefFigure | null, fetched: AnswerDatasets): BarsPayload | null {
  for (const f of figures) {
    if (f === used) continue;
    const d = datasetOf(f, fetched);
    if (isBars(d) && d.payload.series.length === 2 && d.payload.groups.some((g) => g.key === "AGE")) return d.payload;
  }
  return null;
}

/** The city fingerprints of a city comparison, one per city, in report order. */
export function cityFingerprints(figures: readonly BriefFigure[], fetched: AnswerDatasets): ReturnType<typeof fingerprintOf>[] {
  const out: ReturnType<typeof fingerprintOf>[] = [];
  for (const f of figures) {
    const d = datasetOf(f, fetched);
    if (d?.kind === "Bars" && isFingerprint(d) && !out.some((x) => x.name === d.payload.series[0]?.label)) out.push(fingerprintOf(d));
  }
  return out;
}

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

type RankedShape = Pick<AnswerChart, "kind" | "caption" | "table" | "body"> & { title?: string; stacked?: boolean };

/**
 * The Part 9 Ranked tables, whatever the job: a concept check, twins, SEC financials, Census economics,
 * an audience tag contrast or one-scale scoring. Null for any other Ranked table.
 */
function shapeRanked(dataset: Extract<DatasetEnvelope, { kind: "Ranked" }>, ctx: ChartContext): RankedShape | null {
  const p = dataset.payload;
  if (isVerdicts(dataset)) {
    const { body, table, counts } = verdictGroups(p);
    const checked = counts.keep + counts.veto;
    const sample = checked > 0 ? ` ${checked} AI ${checked === 1 ? "guess was" : "guesses were"} checked.` : " No AI guess could be checked, so only the data's own results are listed.";
    return { kind: CHART_COPY.verdicts.kind, caption: `${CHART_COPY.verdicts.caption}${sample}`, table, body, stacked: true };
  }
  if (isTwins(dataset)) {
    const { body, table, checked } = twinsChart(p);
    const group = p.groups.length === 1 ? (p.groups[0]?.label.trim() ?? "") : "";
    // The skill says how many areas it checked of how many ("6 of 34 Nashville areas checked"): a sample, not every area.
    const sample = /\bchecked\b/i.test(group)
      ? ` ${withStop(group)} Areas not checked are not ranked.`
      : ` Only the ${checked} ${checked === 1 ? "area" : "areas"} with a match are ranked, not every area.`;
    return { kind: CHART_COPY.twins.kind, caption: `${CHART_COPY.twins.caption}${sample}`, table, body, stacked: true };
  }
  if (isFinancials(dataset)) {
    const { body, table } = dataRows(p);
    return { kind: CHART_COPY.financials.kind, caption: CHART_COPY.financials.caption, table, body };
  }
  if (isEconomics(dataset)) {
    const { body, table, comparisons } = dataRows(p);
    const rolled = " Medians for an area are population-weighted averages of its ZIP or tract medians, so they are approximate.";
    const city = comparisons === 1 ? " The last row is the whole city, to compare with." : comparisons > 1 ? " The last rows are the whole cities, to compare with." : "";
    return { kind: CHART_COPY.economics.kind, caption: `${CHART_COPY.economics.caption}${rolled}${city}`, table, body };
  }
  if (isTagContrast(dataset) && ctx.job === "brand_collab") {
    const { body, table } = contrastColumns(p);
    return { kind: "Shared and separate tastes", caption: "Tags each audience has, by presence only: a tag on one side is not a measured difference.", table, body };
  }
  if (isScored(dataset) && (ctx.job === "brand_collab" || ctx.job === "creator_fit" || ctx.job === "launch_test")) {
    const { body, table, scored } = scoredBars(p, ctx.subjectRef);
    const copy = ctx.job === "creator_fit" ? CHART_COPY.creatorsScored : CHART_COPY.partners;
    return { kind: copy.kind, caption: `${copy.caption} ${scored} ${scored === 1 ? "name was" : "names were"} scored.`, table, body };
  }
  return null;
}

/** One slot's chart: its figure shaped for its card, or null when the figure's data is not in. */
export function shapeChart(
  figure: BriefFigure | null,
  ctx: ChartContext,
  figures: readonly BriefFigure[],
  fetched: AnswerDatasets = {},
): AnswerChart | null {
  if (!figure) return null;
  const dataset = datasetOf(figure, fetched);
  if (!dataset) return null;
  const base = { datasetId: figure.datasetId, footnote: figure.footnote, title: figure.title, stacked: false };
  const job = ctx.job;
  switch (dataset.kind) {
    case "Matrix": {
      if (dataset.payload.mode === "similarity") {
        const { body, table } = closestAudiences(dataset.payload, ctx);
        return { ...base, kind: CHART_COPY.closest.kind, caption: CHART_COPY.closest.caption, legend: [], table, body };
      }
      const { body, table } = marketRanks(dataset.payload, ctx);
      const noun = ctx.subjectType ? ENTITY_NOUN[ctx.subjectType] : "peers";
      const others = Math.max(0, dataset.payload.cols.length);
      return {
        ...base,
        kind: ctx.subject ? `Where ${ctx.subject} out-draws other ${noun}` : CHART_COPY.markets.kind,
        caption: `Rank among ${others} ${noun} by fan taste in each market. Not ticket sales.`,
        legend: [],
        table,
        body,
      };
    }
    case "Bars": {
      const p = dataset.payload;
      if (job === "taste_twins" && isTwinPair(dataset)) {
        const { body, table } = twinShared(p);
        return { ...base, kind: CHART_COPY.twinShared.kind, caption: CHART_COPY.twinShared.caption, legend: [], stacked: true, table, body };
      }
      if (job === "city_compare" && isFingerprint(dataset)) {
        // Every city's fingerprint in one card, side by side, in report order.
        const prints = cityFingerprints(figures, fetched);
        const { body, table } = fingerprintColumns(prints);
        return { ...base, kind: CHART_COPY.fingerprints.kind, title: prints.length > 1 ? "Each city's strongest tastes, side by side" : figure.title, caption: CHART_COPY.fingerprints.caption, legend: [], table, body };
      }
      if (job === "head_to_head" && p.series.length === 2) {
        const { body, table } = whoWinsWhere(p, agesOf(figures, figure, fetched), ctx);
        return { ...base, kind: CHART_COPY.winner.kind, caption: CHART_COPY.winner.caption, legend: [], table, body };
      }
      if (p.method !== null && job === "site_selection") {
        const { body, table } = moreLess(p);
        return {
          ...base,
          kind: CHART_COPY.moreLess.kind,
          stacked: true,
          caption: ctx.city ? `Compared with ${ctx.city} overall. Shared taste, not foot traffic.` : "Shared taste, not foot traffic.",
          legend: [],
          table,
          body,
        };
      }
      if (p.method !== null) {
        const { body, table } = lessMorePairs(p);
        return {
          ...base,
          kind: CHART_COPY.moreLess.kind,
          stacked: true,
          caption: ctx.city ? `Compared with ${ctx.city} overall. Shared taste, not foot traffic.` : "Shared taste, not foot traffic.",
          // The pair draws its own "Less here | More here" key.
          legend: [],
          table,
          body,
        };
      }
      const { body, table } = fansRows(p, ctx);
      return { ...base, kind: CHART_COPY.fans.kind, caption: CHART_COPY.fans.caption, legend: [], stacked: true, table, body };
    }
    case "GeoLift": {
      const { body, table } = bestAreas(dataset.payload);
      return { ...base, kind: CHART_COPY.map.kind, title: CHART_COPY.map.title, caption: null, legend: [], table, body };
    }
    case "Slope": {
      const { body, table } = fitRows(dataset.payload);
      const scored = dataset.payload.scoreLabel !== null;
      const copy = scored ? CHART_COPY.fit : CHART_COPY.climbers;
      return {
        ...base,
        kind: copy.kind,
        caption: copy.caption,
        // The fit list draws its own key (an arrow, not a dot) when a row climbs.
        legend: [],
        stacked: true,
        table,
        body,
      };
    }
    case "Slate": {
      const { body, table } = slateRows(dataset.payload);
      return { ...base, kind: CHART_COPY.slate.kind, caption: CHART_COPY.slate.caption, legend: [], table, body };
    }
    case "Ranked": {
      const shaped = shapeRanked(dataset, ctx);
      if (shaped) return { ...base, legend: [], ...shaped };
      const columns = (job === "audience_discovery" || job === "creator_fit" || job === "brand_collab" || job === "launch_test") && dataset.payload.groups.length > 1;
      if (job === "creator_fit") {
        const { body, table } = rankedList(dataset.payload, columns);
        return { ...base, kind: CHART_COPY.creators.kind, caption: CHART_COPY.creators.caption, legend: [], table, body };
      }
      const { body, table } = rankedList(dataset.payload, columns);
      return { ...base, kind: CHART_COPY.alsoLove.kind, caption: CHART_COPY.alsoLove.caption, legend: [], table, body };
    }
    default:
      return null;
  }
}

// More charts --------------------------------------------------------------------------------------------------

const GLYPH: Readonly<Record<DatasetEnvelope["kind"], MoreChart["glyph"]>> = {
  Matrix: "bars",
  Ranked: "bars",
  Slate: "bars",
  Scorecard: "bars",
  Bars: "diverging",
  Position: "diverging",
  Momentum: "columns",
  Slope: "columns",
  Quadrant: "dots",
  GeoLift: "dots",
};

/** A short name for a chart the page links to under "More charts" (G-A5), by its family. */
export function moreChartName(figure: BriefFigure, dataset: DatasetEnvelope | null): string {
  if (!dataset) return figure.title;
  switch (dataset.kind) {
    case "Position":
      return "Where it stands vs its peers";
    case "Momentum":
      return `Interest over ${formatTrendWindow(dataset.payload.window)}`;
    case "Quadrant":
      return dataset.payload.belts.length > 0 || dataset.payload.inset !== null ? "Places their fans travel to" : "Fit vs how well known";
    case "Matrix":
      return dataset.payload.mode === "similarity" ? "Whose fans look alike" : "Who wins each market";
    case "Bars":
      if (isTwinPair(dataset)) return "Two areas side by side";
      if (isFingerprint(dataset) && dataset.payload.comparator === "BASELINE") return `What sets ${dataset.payload.series[0]?.label ?? "the city"} apart`;
      if (dataset.payload.method !== null) return "What each area has more of";
      return dataset.payload.groups.some((g) => g.key === "METRO") ? "Who wins where" : "Who the fans are";
    case "Slope":
      if (dataset.payload.scoreLabel !== null) return "Tenant fit, full list";
      return /alignment/i.test(dataset.title) ? "Market alignment" : "Who climbs here vs citywide";
    case "Ranked":
      if (isVerdicts(dataset)) return "AI guesses, checked";
      if (isTwins(dataset)) return "Closest twin areas";
      if (isFinancials(dataset)) return "Reported financials";
      if (isEconomics(dataset)) return "Who lives there";
      if (isTagContrast(dataset)) return "Shared and separate tastes";
      if (isScored(dataset)) return "Scored on one scale";
      return "What else they love";
    case "Slate":
      return "Best fit per category";
    case "GeoLift":
      return "Where interest is highest";
    case "Scorecard":
      return "Our guesses, scored";
  }
}

/** Every figure not drawn as a main chart, in report order, up to four. */
export function moreCharts(figures: readonly BriefFigure[], used: ReadonlySet<string>, fetched: AnswerDatasets = {}): MoreChart[] {
  const seen = new Set<string>();
  const out: MoreChart[] = [];
  for (const f of figures) {
    if (used.has(f.datasetId) || f.kind === "Scorecard") continue;
    const d = datasetOf(f, fetched);
    let name = moreChartName(f, d);
    if (seen.has(name)) name = f.title;
    seen.add(name);
    out.push({ datasetId: f.datasetId, number: f.number, name, glyph: GLYPH[f.kind] });
    if (out.length === 4) break;
  }
  return out;
}
