import type {
  Bar,
  BarsPayload,
  DatasetEnvelope,
  GeoLiftPayload,
  MatrixPayload,
  MomentumPayload,
  PositionPayload,
  QuadrantPayload,
  RankedPayload,
  SlatePayload,
  SlopePayload,
} from "@ct/contracts";
import { formatTrendWindow, NOT_MEASURED, shortCodes } from "../brief";
import { cardLabel, cardText } from "./text";

/**
 * The share card's mini viz (SPEC §8.6): a figure's dataset drawn small, in the few shapes next/og
 * draws well (bars and dots on a track, a heat grid, a scatter, lines). Plain data on a 0–1 frame
 * (x left to right, y top to bottom), so the card's renderer only scales it. It prints labels and
 * the payload's own display text, never a number it formats itself; the key figures under it carry
 * the brief's numbers. Each kind follows its full figure in components/figures.
 */

export type MiniTone = "data" | "data2" | "negative";

export interface MiniLegend {
  label: string;
  tone: MiniTone;
}

/** One row on a 0–1 track: a bar, dots (two are joined, a dumbbell), and the payload's display text. */
export interface MiniRow {
  label: string;
  bar: { from: number; to: number; tone: MiniTone } | null;
  dots: { at: number; tone: MiniTone }[];
  /** The payload's own text for the row ("1 of 6", "Beer"), or "not measured"; null when the row has none. */
  value: string | null;
}

export type MiniViz =
  /** Bars, dumbbells or ranks per row; `centre` is the baseline's place on the track, null for bars from zero. */
  | { kind: "rows"; rows: MiniRow[]; centre: number | null; legend: MiniLegend[]; note: string | null }
  /** A heat grid; cells are 0–1 intensities, null when not measured. */
  | { kind: "grid"; cols: string[]; rows: { label: string; cells: (number | null)[]; target: boolean }[]; targetCol: number | null; note: string | null }
  | { kind: "scatter"; points: { x: number; y: number; tone: MiniTone }[]; split: { x: number; y: number }; xLabel: string; yLabel: string; note: string | null }
  /** Lines across axes (a slope chart) or time (a momentum strip); a null point breaks the line. */
  | { kind: "lines"; axes: string[]; lines: { points: ({ x: number; y: number } | null)[]; tone: MiniTone }[]; legend: MiniLegend[]; note: string | null };

/** Rows a mini viz shows at most, and the length of a row label. */
export const MINI_ROWS = 6;
const LABEL_MAX = 24;
const AXIS_MAX = 12;
const NOTE_MAX = 64;
const SCATTER_MAX = 60;
const LINES_MAX = 8;
const GRID_MAX = 6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A scale that puts `centre` mid-track and the largest distance from it near an end. */
function around(centre: number, values: readonly number[]): (v: number) => number {
  const half = Math.max(1e-9, ...values.map((v) => Math.abs(v - centre)));
  return (v) => clamp01(0.5 + ((v - centre) / half) * 0.46);
}

/** A scale from zero to the largest value, for bars that all start at zero. */
function fromZero(values: readonly number[]): (v: number) => number {
  const max = Math.max(1e-9, ...values);
  return (v) => clamp01((v / max) * 0.96);
}

/** A 0–1 scale over the values' range, a little inset; constant values sit mid-way. */
function span(values: readonly number[], inset = 0.06): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(max > min)) return () => 0.5;
  return (v) => inset + ((v - min) / (max - min)) * (1 - 2 * inset);
}

/** At most `max` items: all of them, or the `max` that weigh most, kept in their own order. */
function pick<T>(items: readonly T[], max: number, weight: (item: T) => number): T[] {
  if (items.length <= max) return [...items];
  const keep = new Set(
    items
      .map((item, i) => ({ i, w: weight(item) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, max)
      .map((x) => x.i),
  );
  return items.filter((_, i) => keep.has(i));
}

/** A caption under the plot when it fits whole: a sentence cut short reads worse than none. */
const note = (text: string | null | undefined) => {
  const t = cardText(text);
  return t !== "" && t.length <= NOTE_MAX ? t : null;
};
const legendOf = (labels: readonly (string | null | undefined)[], tones: readonly MiniTone[]): MiniLegend[] =>
  labels.flatMap((label, i) => {
    const text = cardLabel(label, LABEL_MAX);
    const tone = tones[i];
    return text && tone ? [{ label: text, tone }] : [];
  });

/** Drops rows whose label printed nothing (an id, or characters the card cannot draw). */
const labelled = <T extends { label: string }>(rows: T[]): T[] => rows.filter((r) => r.label !== "");

// Bars: DivergingBars -----------------------------------------------------------------------------

/** Units whose values sit around 1 rather than 0 (components/figures/diverging-bars.tsx). */
const BASELINE_ONE = new Set(["lift", "ratio"]);

function barsDisplay(p: BarsPayload): "diverging" | "split" | "dumbbell" | "butterfly" {
  const two = p.series.length === 2;
  const wanted = p.display ?? (two ? "butterfly" : "diverging");
  return !two && (wanted === "split" || wanted === "butterfly") ? "diverging" : wanted;
}

function splitLead(bar: Bar, even: number): number | null {
  const a = bar.values[0]?.value ?? null;
  const b = bar.values[1]?.value ?? null;
  if (a === null || b === null) return null;
  return a + b > 0 ? a / (a + b) - even : 0;
}

function barsViz(p: BarsPayload): MiniViz | null {
  const display = barsDisplay(p);
  const all = p.groups.flatMap((g) => g.bars);
  const values = all.flatMap((b) => b.values.flatMap((c) => (c.value === null ? [] : [c.value])));
  const baseline =
    p.baseline ?? (display === "split" ? 0.5 : BASELINE_ONE.has(p.unit) && values.length > 0 && values.every((v) => v > 0) ? 1 : 0);
  const legend = p.series.length === 2 ? legendOf(p.series.map((s) => s.label), ["data", "data2"]) : [];
  const caption = note(p.caption);

  if (display === "split") {
    const leads = all.map((b) => splitLead(b, baseline));
    const shown = pick(all, MINI_ROWS, (b) => Math.abs(splitLead(b, baseline) ?? 0));
    const x = around(0, leads.flatMap((l) => (l === null ? [] : [l])));
    const rows = shown.map((b): MiniRow => {
      const lead = splitLead(b, baseline);
      return {
        label: cardLabel(b.label, LABEL_MAX),
        bar: lead === null ? null : { from: x(0), to: x(lead), tone: lead >= 0 ? "data" : "data2" },
        dots: [],
        value: lead === null ? NOT_MEASURED : null,
      };
    });
    return { kind: "rows", rows: labelled(rows), centre: 0.5, legend, note: caption };
  }

  const x = around(baseline, values);
  const v = (b: Bar, i: number) => b.values[i]?.value ?? null;
  const shown = pick(all, MINI_ROWS, (b) => Math.max(...b.values.map((c) => (c.value === null ? 0 : Math.abs(c.value - baseline)))));
  const rows = shown.map((b): MiniRow => {
    const first = v(b, 0);
    const label = cardLabel(b.label, LABEL_MAX);
    if (first === null) return { label, bar: null, dots: [], value: NOT_MEASURED };
    if (display === "diverging") return { label, bar: { from: x(baseline), to: x(first), tone: first >= baseline ? "data" : "negative" }, dots: [], value: null };
    const second = p.series.length === 2 ? v(b, 1) : null;
    const dots: MiniRow["dots"] =
      second === null
        ? [{ at: x(first), tone: first >= baseline ? "data" : "negative" }]
        : [
            { at: x(second), tone: "data2" },
            { at: x(first), tone: "data" },
          ];
    return { label, bar: null, dots, value: null };
  });
  return { kind: "rows", rows: labelled(rows), centre: 0.5, legend, note: caption };
}

// Ranked and Slate: RankedTable ---------------------------------------------------------------------

function rankedViz(p: RankedPayload): MiniViz | null {
  const column = p.columns.findIndex((c) => c.unit !== "rank");
  if (column < 0) return null;
  const rows = p.groups
    .flatMap((g) => g.rows)
    .flatMap((r) => {
      const value = r.cells[column]?.value ?? null;
      return value === null ? [] : [{ row: r, value }];
    })
    .slice(0, MINI_ROWS);
  if (rows.length === 0) return null;
  const values = rows.map((r) => r.value);
  const signed = values.some((v) => v < 0);
  const x = signed ? around(0, values) : fromZero(values);
  const zero = signed ? 0.5 : 0;
  const out = rows.map(({ row, value }): MiniRow => ({
    label: cardLabel(row.label, LABEL_MAX),
    bar: { from: zero, to: x(value), tone: row.comparison ? "data2" : value < 0 ? "negative" : "data" },
    dots: [],
    value: null,
  }));
  return { kind: "rows", rows: labelled(out), centre: signed ? 0.5 : null, legend: [], note: note(p.columns[column]?.label) };
}

function slateViz(p: SlatePayload): MiniViz | null {
  const rows = p.rows.flatMap((r) => (r.best && r.best.fit.value !== null ? [{ row: r, best: r.best, fit: r.best.fit.value }] : [])).slice(0, MINI_ROWS);
  if (rows.length === 0) return null;
  const x = fromZero(rows.map((r) => r.fit));
  const out = rows.map(({ row, best, fit }): MiniRow => ({
    label: cardLabel(best.label, LABEL_MAX),
    bar: { from: 0, to: x(fit), tone: "data" },
    dots: [],
    value: cardLabel(row.label, AXIS_MAX) || null,
  }));
  return { kind: "rows", rows: labelled(out), centre: null, legend: [], note: note(p.caption) };
}

// GeoLift: LiftMap, as its neighbourhoods ranked by lift ----------------------------------------------

function geoLiftViz(p: GeoLiftPayload): MiniViz | null {
  const lifted = p.neighbourhoods.flatMap((n) => (n.lift === null ? [] : [{ n, lift: n.lift }]));
  if (lifted.length === 0) return null;
  const shown = [...lifted].sort((a, b) => b.lift - a.lift).slice(0, MINI_ROWS);
  const x = around(1, shown.map((s) => s.lift));
  const rows = shown.map(({ n, lift }): MiniRow => ({
    label: cardLabel(n.name, LABEL_MAX),
    bar: { from: x(1), to: x(lift), tone: lift >= 1 ? "data" : "negative" },
    dots: [],
    value: null,
  }));
  return { kind: "rows", rows: labelled(rows), centre: 0.5, legend: [], note: note(`Lift vs ${cardText(p.baseline.label)} baseline`) };
}

// Position: PositionCard ------------------------------------------------------------------------------

function positionViz(p: PositionPayload): MiniViz | null {
  const rows = p.axes.map((a): MiniRow => {
    const rank = a.peerRank;
    const at = rank && rank.of > 1 ? 0.04 + (1 - (rank.rank - 1) / (rank.of - 1)) * 0.92 : null;
    return {
      label: cardLabel(a.label, LABEL_MAX),
      bar: null,
      dots: at === null ? [] : [{ at, tone: "data" }],
      value: a.value === null ? NOT_MEASURED : cardLabel(a.display, AXIS_MAX) || null,
    };
  });
  return { kind: "rows", rows: labelled(rows), centre: null, legend: [], note: note(p.peerCount > 0 ? "Rank among peers, best at right" : null) };
}

// Matrix: MatrixGrid -----------------------------------------------------------------------------------

function matrixViz(p: MatrixPayload): MiniViz | null {
  const keepIndex = (items: readonly { key: string }[]) => {
    const target = items.findIndex((i) => i.key === p.targetKey);
    const idx = items.map((_, i) => i);
    if (idx.length <= GRID_MAX) return idx;
    const rest = idx.filter((i) => i !== target).slice(0, target >= 0 ? GRID_MAX - 1 : GRID_MAX);
    return (target >= 0 ? [target, ...rest] : rest).sort((a, b) => a - b);
  };
  const rowIdx = keepIndex(p.rows);
  const colIdx = keepIndex(p.cols);
  const values = rowIdx.flatMap((r) => colIdx.flatMap((c) => {
    const v = p.cells[r]?.[c]?.value;
    return v === null || v === undefined ? [] : [v];
  }));
  if (values.length === 0) return null;
  const x = span(values, 0);
  const allCodes = shortCodes(p.cols.map((c) => c.label));
  const cols = colIdx.map((c) => cardText(p.cols[c]?.code ?? allCodes[c] ?? "") || "·");
  const rows = rowIdx.map((r) => ({
    label: cardLabel(p.rows[r]?.label, LABEL_MAX),
    cells: colIdx.map((c) => {
      const v = p.cells[r]?.[c]?.value;
      return v === null || v === undefined ? null : x(v);
    }),
    target: p.rows[r]?.key === p.targetKey,
  }));
  const targetCol = colIdx.findIndex((c) => p.cols[c]?.key === p.targetKey);
  return { kind: "grid", cols, rows: labelled(rows), targetCol: targetCol >= 0 ? targetCol : null, note: note(p.valueLabel) };
}

// Quadrant: QuadrantScatter -----------------------------------------------------------------------------

function quadrantViz(p: QuadrantPayload): MiniViz | null {
  if (p.points.length === 0) return null;
  const shown = pick(p.points, SCATTER_MAX, (pt) => (pt.utr ? 2 : 0) + (pt.labelled ? 1 : 0));
  const x = span([...shown.map((pt) => pt.x), p.xSplit]);
  const y = span([...shown.map((pt) => pt.y), p.ySplit]);
  return {
    kind: "scatter",
    points: shown.map((pt) => ({ x: x(pt.x), y: 1 - y(pt.y), tone: pt.utr ? "data" : "data2" })),
    split: { x: x(p.xSplit), y: 1 - y(p.ySplit) },
    xLabel: cardLabel(p.xLabel, LABEL_MAX),
    yLabel: cardLabel(p.yLabel, LABEL_MAX),
    note: note(p.quadrantLabels.HIDDEN_POCKET),
  };
}

// Slope and Momentum: SlopeChart, MomentumStrip ------------------------------------------------------------

function slopeViz(p: SlopePayload): MiniViz | null {
  const lines = pick(p.lines, LINES_MAX, (l) => (l.highlight ? 1e9 : 0) + Math.abs(l.delta ?? 0));
  const points = lines.flatMap((l) => l.points.flatMap((pt) => (p.scale === "rank" ? (pt.rank === null ? [] : [pt.rank]) : pt.value === null ? [] : [pt.value])));
  if (points.length === 0) return null;
  // Rank 1 sits on top; a share or percentile rises with its value.
  const y = span(points);
  const last = Math.max(1, p.axes.length - 1);
  return {
    kind: "lines",
    axes: p.axes.map((a) => cardLabel(a.label, AXIS_MAX)),
    lines: lines.map((l) => ({
      points: l.points.map((pt, i) => {
        const v = p.scale === "rank" ? pt.rank : pt.value;
        return v === null ? null : { x: i / last, y: p.scale === "rank" ? y(v) : 1 - y(v) };
      }),
      tone: l.highlight ? "data" : "data2",
    })),
    legend: legendOf(lines.filter((l) => l.highlight).slice(0, 2).map((l) => l.label), ["data", "data"]),
    note: null,
  };
}

function momentumViz(p: MomentumPayload): MiniViz | null {
  const series = p.series.filter((s) => s.state === "ok" && s.points.length > 1).slice(0, 3);
  if (series.length === 0) return null;
  const times = series.flatMap((s) => s.points.map((pt) => Date.parse(pt.date)));
  const x = span(times, 0);
  const y = span(series.flatMap((s) => s.points.map((pt) => pt.pct)));
  const tones: MiniTone[] = series.map((_, i) => (i === 0 ? "data" : "data2"));
  return {
    kind: "lines",
    axes: [],
    lines: series.map((s, i) => ({ points: s.points.map((pt) => ({ x: x(Date.parse(pt.date)), y: 1 - y(pt.pct) })), tone: tones[i] ?? "data2" })),
    legend: legendOf(series.slice(0, 2).map((s) => s.label), tones),
    note: note(`Historical · ${formatTrendWindow(p.window)}`),
  };
}

/** The mini viz of a figure's dataset, or null when it has nothing the card can draw. */
export function miniViz(dataset: DatasetEnvelope | null): MiniViz | null {
  if (!dataset) return null;
  let viz: MiniViz | null;
  switch (dataset.kind) {
    case "Bars":
      viz = barsViz(dataset.payload);
      break;
    case "Ranked":
      viz = rankedViz(dataset.payload);
      break;
    case "Slate":
      viz = slateViz(dataset.payload);
      break;
    case "GeoLift":
      viz = geoLiftViz(dataset.payload);
      break;
    case "Position":
      viz = positionViz(dataset.payload);
      break;
    case "Matrix":
      viz = matrixViz(dataset.payload);
      break;
    case "Quadrant":
      viz = quadrantViz(dataset.payload);
      break;
    case "Slope":
      viz = slopeViz(dataset.payload);
      break;
    case "Momentum":
      viz = momentumViz(dataset.payload);
      break;
    case "Scorecard":
      viz = null;
      break;
    // A taste map's axes mean nothing (only distances do); the card's scatter draws a split and axis
    // labels, so it would read as a quadrant. The card shows its key figures instead.
    case "TasteMap":
      viz = null;
      break;
    // OpenStreetMap counts are context beside the taste read, with an attribution a card cannot carry.
    case "Supply":
      viz = null;
      break;
  }
  if (viz === null) return null;
  // A viz whose every label was an id or undrawable text has nothing to show.
  if ((viz.kind === "rows" || viz.kind === "grid") && viz.rows.length === 0) return null;
  return viz;
}
