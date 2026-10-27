import type { MetricUnit, QuadrantName, QuadrantPayload, QuadrantPoint } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableColumn, type TableRow } from "./figure-table";
import { formatNumber, formatTick, reasonLabel, sentenceCase, type NumberStyle } from "./format";
import { fitText, linear, niceDomain, px, textWidth, ticksBetween } from "./scale";

/**
 * QuadrantScatter (kind Quadrant: TRVL and SLATE; A07 figure 2). FIT against popularity, split at
 * the within-set medians (D17). The high-fit, low-popularity quadrant is tinted; highlighted points
 * are labelled in ink, the featured under-the-radar pick gets a ring and an accent label with its
 * value; every other candidate is a grey dot. Points Qloo could not place are listed, never drawn.
 * Popularity on 0–1 reads as a percentile on the axis, in the tooltips and in the table view alike;
 * the payload's fixed caption prints under the plot.
 */

export interface QuadrantScatterOptions {
  /** Layout width in px; the SVG draws at this width (a narrow box scrolls). Default 680. */
  width?: number;
  /** Height of the plot area in px. Default 168. */
  plotHeight?: number;
  /** Points drawn in the data colour with a label. Default: the payload's labelled points. */
  highlightKeys?: readonly string[];
  /** Points that get the ring and the accent label with their y value. Default: labelled under-the-radar points. */
  featuredKeys?: readonly string[];
  xDomain?: { min: number; max: number };
  yDomain?: { min: number; max: number };
  numberStyle?: NumberStyle;
}

export type QuadrantScatterProps = FigureMeta & QuadrantScatterOptions & { data: QuadrantPayload };

const Y_TITLE_W = 16;
const Y_TICK_W = 30;
/** Every label in the plot: 12 px (the design's 12/16 chart labels). */
const FONT = 12;
const QUADRANT_FONT = { weight: 500 } as const;

/** Quadrant placement: HIDDEN POCKET top-left (high fit, low popularity), HEARTLAND top-right, COLD and MASS below. */
const CORNER: Readonly<Record<QuadrantName, { top: boolean; left: boolean }>> = {
  HIDDEN_POCKET: { top: true, left: true },
  HEARTLAND: { top: true, left: false },
  COLD: { top: false, left: true },
  MASS: { top: false, left: false },
};

const PERCENTILE_UNITS: ReadonlySet<MetricUnit> = new Set(["popularity", "pct"]);

export function QuadrantScatter(props: QuadrantScatterProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { ...props.numberStyle };
  return (
    <FigureFrame
      meta={props}
      plot={<ScatterPlot {...props} label={label} style={style} />}
      table={<FigureTable spec={quadrantTableSpec(props.data, label, style, { xDomain: props.xDomain })} />}
      fixedCaption={props.data.caption}
    />
  );
}

/** Whether x reads as a percentile: a 0–1 popularity (or pct) axis with no fixed domain. */
function xAsPercentile(data: QuadrantPayload, fixed?: { min: number; max: number }): boolean {
  return (
    fixed === undefined &&
    PERCENTILE_UNITS.has(data.xUnit) &&
    [...data.points.map((p) => p.x), data.xSplit].every((v) => v >= 0 && v <= 1)
  );
}

/** 1st, 2nd, 3rd, 4th, 11th, 22nd … */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** An x value as the axis reads it: "22nd pctl" on a percentile axis, otherwise the number. */
function xText(x: number, data: QuadrantPayload, style: NumberStyle, percentile: boolean): string {
  return percentile ? `${ordinal(Math.round(x * 100))} pctl` : formatNumber(x, data.xUnit, style);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** An axis that holds every value and the split. Popularity on 0–1 reads as percentiles 0–100 (x only). */
function axisDomain(
  values: readonly number[],
  split: number,
  fixed: { min: number; max: number } | undefined,
  count: number,
  asPercentile: boolean,
) {
  if (fixed) return { ...fixed, step: niceDomain(fixed.min, fixed.max, count).step, percentile: false };
  if (asPercentile) return { min: 0, max: 1, step: 0.25, percentile: true };
  const all = [...values, split];
  return { ...niceDomain(Math.min(...all), Math.max(...all), count), percentile: false };
}

function ScatterPlot(props: QuadrantScatterProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const width = props.width ?? 680;
  const plotH = props.plotHeight ?? 168;
  const left = Y_TITLE_W + Y_TICK_W + 6;
  const right = width - 8;
  const top = 8;
  const bottom = top + plotH;
  const height = bottom + 40;
  const xd = axisDomain(data.points.map((p) => p.x), data.xSplit, props.xDomain, 4, xAsPercentile(data, props.xDomain));
  const yd = axisDomain(data.points.map((p) => p.y), data.ySplit, props.yDomain, 5, false);
  const sx = linear([xd.min, xd.max], [left, right]);
  const sy = linear([yd.min, yd.max], [bottom, top]);
  const xTicks = ticksBetween(xd.min, xd.max, xd.step);
  const yTicks = ticksBetween(yd.min, yd.max, yd.step);
  const splitX = px(sx(data.xSplit));
  const splitY = px(sy(data.ySplit));

  const highlight = new Set(props.highlightKeys ?? data.points.filter((p) => p.labelled).map((p) => p.key));
  const featured = new Set(props.featuredKeys ?? data.points.filter((p) => p.labelled && p.utr).map((p) => p.key));
  const others = data.points.filter((p) => !highlight.has(p.key) && !featured.has(p.key));
  const marked = data.points.filter((p) => highlight.has(p.key) || featured.has(p.key));

  // Quadrant labels sit in the plot corners; their boxes keep point labels away from them.
  const quadrants = (Object.keys(CORNER) as QuadrantName[]).map((q) => {
    const c = CORNER[q];
    const room = (c.left ? splitX - left : right - splitX) - 12;
    const text = fitText(sentenceCase(data.quadrantLabels[q]), room, FONT, QUADRANT_FONT);
    const w = textWidth(text, FONT, QUADRANT_FONT);
    const x = c.left ? left + 6 : right - 6;
    const y = c.top ? top + 15 : bottom - 6;
    const anchor: "start" | "end" = c.left ? "start" : "end";
    return { q, text, x, y, anchor, box: { x: c.left ? x : x - w, y: y - 11, w, h: 14 } };
  });

  const placed = placeLabels(
    marked,
    featured,
    sx,
    sy,
    { left, right, top, bottom },
    quadrants.map((q) => q.box),
    { right: splitX, bottom: splitY },
    data,
    style,
  );

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        role="img"
        aria-label={props.label}
        className="block h-auto max-w-none font-sans"
      >
        <title>{props.label}</title>
        <desc>
          {`${data.points.length} points: ${data.yLabel.toLowerCase()} against ${data.xLabel.toLowerCase()}, split at the medians. ${marked.length} highlighted; grey dots are the other candidates. The table view lists every point.`}
        </desc>

        <rect
          x={left}
          y={top}
          width={px(Math.max(0, splitX - left))}
          height={px(Math.max(0, splitY - top))}
          className="fill-accent-soft"
          data-quadrant="HIDDEN_POCKET"
        />
        {yTicks.map((t, i) =>
          i === 0 ? null : <line key={`gy-${t}`} x1={left} x2={right} y1={px(sy(t)) + 0.5} y2={px(sy(t)) + 0.5} className="stroke-line" />,
        )}
        <line x1={left} x2={right} y1={bottom + 0.5} y2={bottom + 0.5} className="stroke-line-strong" />
        <line x1={left} x2={right} y1={splitY + 0.5} y2={splitY + 0.5} className="stroke-line-strong" />
        <line x1={splitX + 0.5} x2={splitX + 0.5} y1={top} y2={bottom} className="stroke-line-strong" />

        {yTicks.map((t) => (
          <text key={`ty-${t}`} x={left - 8} y={px(sy(t) + 4)} textAnchor="end" fontSize={FONT} className="fill-ink-2 tabular-nums">
            {formatTick(t, yd.step, data.yUnit, { minDigits: 1 })}
          </text>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={`tx-${t}`}
            x={px(sx(t))}
            y={bottom + 17}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize={FONT}
            className="fill-ink-2 tabular-nums"
          >
            {xd.percentile
              ? `${Math.round(t * 100)}${i === xTicks.length - 1 ? "th pctl" : ""}`
              : formatTick(t, xd.step, data.xUnit)}
          </text>
        ))}
        <text x={right} y={bottom + 35} textAnchor="end" fontSize={FONT} fontWeight={500} className="fill-ink-2">
          {`${sentenceCase(data.xLabel)} →`}
        </text>
        <text
          transform={`translate(${Y_TITLE_W - 4} ${px((top + bottom) / 2)}) rotate(-90)`}
          textAnchor="middle"
          fontSize={FONT}
          fontWeight={500}
          className="fill-ink-2"
        >
          {`${fitText(sentenceCase(data.yLabel), plotH - 8, FONT, QUADRANT_FONT)} →`}
        </text>

        {quadrants.map((q) => (
          <text
            key={q.q}
            x={q.x}
            y={q.y}
            textAnchor={q.anchor}
            fontSize={FONT}
            fontWeight={500}
            strokeWidth={3}
            paintOrder="stroke"
            className={q.q === "HIDDEN_POCKET" ? "fill-accent-ink stroke-accent-soft" : "fill-ink-2 stroke-surface"}
          >
            {q.text}
          </text>
        ))}

        {others.map((p) => (
          <circle key={p.key} cx={px(sx(p.x))} cy={px(sy(p.y))} r={3} className="fill-chart-muted" data-point={p.key}>
            <title>{pointTitle(p, data, style, xd.percentile)}</title>
          </circle>
        ))}
        {marked.map((p) => (
          <g key={p.key} data-point={p.key} data-tone={featured.has(p.key) ? "featured" : "highlight"}>
            <title>{pointTitle(p, data, style, xd.percentile)}</title>
            {featured.has(p.key) ? (
              <circle cx={px(sx(p.x))} cy={px(sy(p.y))} r={8} strokeWidth={1} className="fill-none stroke-accent" />
            ) : null}
            <circle cx={px(sx(p.x))} cy={px(sy(p.y))} r={4} strokeWidth={1.5} className="fill-accent stroke-surface" />
          </g>
        ))}
        {placed.map((l) => (
          <text
            key={`l-${l.key}`}
            x={px(l.x)}
            y={px(l.y)}
            textAnchor={l.anchor}
            fontSize={FONT}
            fontWeight={l.featured ? 600 : 400}
            strokeWidth={3}
            paintOrder="stroke"
            className={`${l.featured ? "fill-accent" : "fill-ink-2"} ${l.inTint ? "stroke-accent-soft" : "stroke-surface"}`}
          >
            {l.text}
          </text>
        ))}
      </svg>
      {data.omitted.length > 0 ? (
        <p className="m-0 type-caption text-ink-2">
          <span className="font-semibold text-ink-2">Not placed: </span>
          {data.omitted.map((o, i) => (
            <span key={`${o.label}-${i}`}>
              {i > 0 ? " · " : ""}
              {o.label} <span className="text-ink-2 italic">({reasonLabel(o.reason)})</span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  featured: boolean;
  /** Sits on the tinted under-the-radar quadrant, so its halo takes the tint. */
  inTint: boolean;
}

/** Greedy, deterministic label placement: featured first, then by fit; right, left, above, below, else no label. */
function placeLabels(
  points: readonly QuadrantPoint[],
  featured: ReadonlySet<string>,
  sx: (v: number) => number,
  sy: (v: number) => number,
  plot: { left: number; right: number; top: number; bottom: number },
  reserved: readonly Box[],
  tint: { right: number; bottom: number },
  data: QuadrantPayload,
  style: NumberStyle,
): PlacedLabel[] {
  const taken: Box[] = [...reserved];
  // Every marked dot keeps a small clear area, so labels never sit on another highlight.
  const dots: Box[] = points.map((p) => ({ x: sx(p.x) - 5, y: sy(p.y) - 5, w: 10, h: 10 }));
  const order = [...points].sort(
    (a, b) => Number(featured.has(b.key)) - Number(featured.has(a.key)) || b.y - a.y || a.key.localeCompare(b.key),
  );
  const out: PlacedLabel[] = [];
  for (const p of order) {
    const isFeatured = featured.has(p.key);
    const size = FONT;
    const weight = isFeatured ? 600 : 400;
    const text = isFeatured ? `${p.label} · ${formatNumber(p.y, data.yUnit, style)}` : p.label;
    const w = textWidth(text, size, { weight });
    const h = size + 2;
    const cx = sx(p.x);
    const cy = sy(p.y);
    const gap = isFeatured ? 12 : 7;
    const candidates: { box: Box; x: number; y: number; anchor: PlacedLabel["anchor"] }[] = [
      { box: { x: cx + gap, y: cy - h / 2 - 1, w, h }, x: cx + gap, y: cy + 4, anchor: "start" },
      { box: { x: cx - gap - w, y: cy - h / 2 - 1, w, h }, x: cx - gap, y: cy + 4, anchor: "end" },
      { box: { x: cx - w / 2, y: cy - gap - h, w, h }, x: cx, y: cy - gap - 2, anchor: "middle" },
      { box: { x: cx - w / 2, y: cy + gap, w, h }, x: cx, y: cy + gap + h - 2, anchor: "middle" },
    ];
    const own = dots[points.indexOf(p)];
    const fit = candidates.find(
      (c) =>
        c.box.x >= plot.left + 2 &&
        c.box.x + c.box.w <= plot.right - 2 &&
        c.box.y >= plot.top &&
        c.box.y + c.box.h <= plot.bottom - 1 &&
        !taken.some((t) => overlaps(t, c.box)) &&
        !dots.some((d) => d !== own && overlaps(d, c.box)),
    );
    if (!fit) continue;
    taken.push(fit.box);
    const inTint = fit.box.x + fit.box.w <= tint.right && fit.box.y + fit.box.h <= tint.bottom;
    out.push({ key: p.key, text, x: fit.x, y: fit.y, anchor: fit.anchor, featured: isFeatured, inTint });
  }
  return out;
}

function pointTitle(p: QuadrantPoint, data: QuadrantPayload, style: NumberStyle, percentile: boolean): string {
  return `${p.label}: ${data.yLabel} ${formatNumber(p.y, data.yUnit, style)}, ${data.xLabel} ${xText(p.x, data, style, percentile)} · ${sentenceCase(data.quadrantLabels[p.quadrant])}`;
}

/**
 * The table view: every placed point with both coordinates and its quadrant, then the omitted ones.
 * x prints on the plot's scale: a percentile (0–100) when the axis reads as one.
 */
export function quadrantTableSpec(
  data: QuadrantPayload,
  caption: string,
  style: NumberStyle,
  opts: Pick<QuadrantScatterOptions, "xDomain"> = {},
) {
  const percentile = xAsPercentile(data, opts.xDomain);
  const withGroup = data.points.some((p) => p.group !== null);
  const withScore = data.points.some((p) => p.score !== null);
  const columns: TableColumn[] = [
    { label: "Name" },
    { label: data.yLabel, numeric: true },
    { label: percentile ? `${data.xLabel} (percentile)` : data.xLabel, numeric: true },
    { label: "Quadrant" },
    ...(withGroup ? [{ label: "Group" }] : []),
    ...(withScore ? [{ label: "Score", numeric: true }] : []),
    { label: "Flags" },
  ];
  const sorted = [...data.points].sort((a, b) => b.y - a.y || a.key.localeCompare(b.key));
  const rows: TableRow[] = sorted.map((p) => ({
    key: p.key,
    cells: [
      p.label,
      formatNumber(p.y, data.yUnit, style),
      percentile ? String(Math.round(p.x * 100)) : formatNumber(p.x, data.xUnit, style),
      sentenceCase(data.quadrantLabels[p.quadrant]),
      ...(withGroup ? [p.group ?? ""] : []),
      ...(withScore ? [p.score === null ? "—" : formatNumber(p.score, "stat", style)] : []),
      p.utr ? "under the radar" : "",
    ],
  }));
  data.omitted.forEach((o, i) => {
    const missing = { kind: "missing" as const, reason: reasonLabel(o.reason) };
    rows.push({
      key: `omitted-${i}`,
      cells: [o.label, missing, missing, "not placed", ...(withGroup ? [""] : []), ...(withScore ? [""] : []), ""],
    });
  });
  return { caption, columns, rows };
}
