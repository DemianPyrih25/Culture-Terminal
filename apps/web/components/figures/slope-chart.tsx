import type { SlopeLine, SlopePayload, SlopePoint } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableColumn, type TableRow } from "./figure-table";
import { formatNumber, reasonLabel, sentenceCase, type NumberStyle } from "./format";
import { clamp, fitText, linear, niceDomain, px, textWidth } from "./scale";

/**
 * SlopeChart (kind Slope: the tenant slope city → site, sponsor market alignment, a metro rank
 * shift). Hand-written SVG: one vertical axis per context, left to right, and one line per entity
 * joining its points. Climbers (`highlight`) are drawn in the data colour with bold labels, every
 * other line in data-2 grey. Each end carries the name and the value, pushed apart where labels
 * would collide; the right columns hold the shift (last axis against the first, ▲/▼, the comparator
 * named in the head) and the optional per-line score (TenantFit). A missing point breaks the line
 * and its end prints the reason; a line with no point at all is listed under the plot, never drawn.
 */

export interface SlopeChartOptions {
  /** Layout width in px; the SVG draws at this width (a narrow box scrolls, it never shrinks the text). Default 680. */
  width?: number;
  /** Height of the plot area in px. Default: enough for every end label, at least 168. */
  plotHeight?: number;
  /** Lines drawn as climbers. Default: the payload's `highlight` flags. */
  highlightKeys?: readonly string[];
  /** Show the score column when the payload has one. Default true from 480 px. */
  showScore?: boolean;
  numberStyle?: NumberStyle;
}

export type SlopeChartProps = FigureMeta & SlopeChartOptions & { data: SlopePayload };

const HEADER_H = 26;
const LABEL_GAP = 8;
const LABEL_H = 16;
const COL_W = 64;
const NOTE_H = 20;
const HEAD_FONT = { weight: 500 } as const;
/** Every label in the plot: 12 px (the design's 12/16 chart labels). */
const FONT = 12;
/** Above this many lines only climbers and the largest shifts are labelled; the table holds the rest. */
const MAX_LABELLED = 24;

export function SlopeChart(props: SlopeChartProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { leadingZero: props.data.scale === "pct" ? false : undefined, ...props.numberStyle };
  const highlight = slopeHighlight(props.data, props.highlightKeys);
  return (
    <FigureFrame
      meta={props}
      plot={<SlopePlot {...props} label={label} style={style} highlight={highlight} />}
      table={<FigureTable spec={slopeTableSpec(props.data, label, style, highlight)} />}
    />
  );
}

/** The climbers: the caller's keys when given, else the payload's `highlight` flags. Plot and table share it. */
export function slopeHighlight(data: SlopePayload, keys?: readonly string[]): ReadonlySet<string> {
  return new Set(keys ?? data.lines.filter((l) => l.highlight).map((l) => l.key));
}

/**
 * The lines that get end labels: every drawn line up to MAX_LABELLED; above that every climber, then
 * the largest shifts among the rest until MAX_LABELLED lines are labelled.
 */
export function slopeLabelled(drawn: readonly SlopeLine[], highlight: ReadonlySet<string>): Set<string> {
  if (drawn.length <= MAX_LABELLED) return new Set(drawn.map((l) => l.key));
  const climbers = drawn.filter((l) => highlight.has(l.key)).map((l) => l.key);
  const shifts = drawn
    .filter((l) => !highlight.has(l.key) && l.delta !== null)
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!) || (a.key < b.key ? -1 : 1))
    .slice(0, Math.max(0, MAX_LABELLED - climbers.length))
    .map((l) => l.key);
  return new Set([...climbers, ...shifts]);
}

/** A point's plotted value: the value on a pct scale, the rank on a rank scale (1 at the top). */
function plotted(point: SlopePoint | undefined, scale: SlopePayload["scale"]): number | null {
  if (!point || point.value === null) return null;
  return scale === "rank" ? (point.rank ?? point.value) : point.value;
}

/** A point as printed: ".62" on a pct scale, "#3" on a rank scale. */
export function slopeValueText(point: SlopePoint, scale: SlopePayload["scale"], style: NumberStyle): string {
  if (point.value === null) return reasonLabel(point.reason);
  if (scale === "rank") return `#${point.rank ?? point.value}`;
  return formatNumber(point.value, "pct", style);
}

/** Improvement is up: a higher pct, or a lower rank number. Null without a delta. */
export function slopeShift(line: SlopeLine, scale: SlopePayload["scale"]): number | null {
  if (line.delta === null) return null;
  return scale === "rank" ? -line.delta : line.delta;
}

/** "▲ .38", "▼ .63", "= 0" (the shift's magnitude; the arrow says which way). */
export function shiftText(line: SlopeLine, scale: SlopePayload["scale"], style: NumberStyle): string | null {
  const shift = slopeShift(line, scale);
  if (shift === null) return null;
  const digits = scale === "rank" ? 0 : (style.digits ?? 2);
  const body = formatNumber(Math.abs(shift), scale === "rank" ? "rank" : "pct", { ...style, digits, signed: false });
  if (Number(Math.abs(shift).toFixed(digits)) === 0) return `= ${body}`;
  return `${shift > 0 ? "▲" : "▼"} ${body}`;
}

/** The shift column head names its comparator: "Δ vs Austin" (the first axis). */
export function shiftHead(data: SlopePayload): string {
  return `Δ vs ${data.axes[0]?.label ?? "start"}`;
}

function scoreHead(data: SlopePayload): string | null {
  return data.scoreLabel ? data.scoreLabel.replace(/\s*\([^)]*\)\s*$/, "") : null;
}

/**
 * Label positions on one side: each label wants its point's y and keeps LABEL_H from its
 * neighbours, staying inside [top, bottom] where it can. Returns y per line key.
 */
export function spreadLabels(wanted: readonly { key: string; y: number }[], top: number, bottom: number, gap = LABEL_H): Map<string, number> {
  const items = [...wanted].sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : 1)).map((w) => ({ ...w, at: w.y }));
  // Push down from the top, then back up from the bottom, then down again if the block overflows the top.
  for (let i = 0; i < items.length; i += 1) {
    const prev = items[i - 1];
    items[i]!.at = Math.max(items[i]!.at, top, prev ? prev.at + gap : -Infinity);
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const next = items[i + 1];
    items[i]!.at = Math.min(items[i]!.at, next ? next.at - gap : bottom);
  }
  for (let i = 0; i < items.length; i += 1) {
    const prev = items[i - 1];
    if (prev && items[i]!.at < prev.at + gap) items[i]!.at = prev.at + gap;
  }
  return new Map(items.map((i) => [i.key, i.at]));
}

/** Room for a missing end's name: the span it may use minus " · <reason>". */
function missingRoom(span: number, reason: SlopePoint["reason"]): number {
  return span - LABEL_GAP - textWidth(` · ${reasonLabel(reason)}`, FONT) - 4;
}

/** One end label: a line's value at the outer axis, or its reason when that point is missing. */
interface EndLabel {
  line: SlopeLine;
  /** The y the label wants: its point, or for a missing point the line's nearest drawn point. */
  y: number;
  point: SlopePoint;
  /** The drawn point the label belongs to (absent for a missing end). */
  at: { x: number; y: number } | null;
}

function SlopePlot(props: SlopeChartProps & { label: string; style: NumberStyle; highlight: ReadonlySet<string> }) {
  const { data, style, highlight } = props;
  const width = props.width ?? 680;
  const compact = width < 480;
  const scale = data.scale;
  const drawn = data.lines.filter((l) => l.points.some((p) => p.value !== null));
  const unplaced = data.lines.filter((l) => !l.points.some((p) => p.value !== null));
  const nAxes = data.axes.length;
  const last = nAxes - 1;

  // Which lines get end labels: all of them, or climbers and the largest shifts when there are many.
  const labelled = slopeLabelled(drawn, highlight);

  // Columns on the right: the shift, then the score.
  const score = scoreHead(data);
  const showScore = score !== null && (props.showScore ?? !compact);
  const cols = [{ head: shiftHead(data), kind: "shift" as const }, ...(showScore ? [{ head: score!, kind: "score" as const }] : [])];
  const colW = cols.map((c) => Math.max(COL_W, Math.ceil(textWidth(c.head, FONT, HEAD_FONT)) + 8));
  const colsW = colW.reduce((s, w) => s + w, 0);

  // End labels: name and value on both sides; a compact chart names lines on the right only.
  const valueW = scale === "rank" ? 30 : 32;
  const longest = Math.max(40, ...drawn.filter((l) => labelled.has(l.key)).map((l) => textWidth(l.label, FONT, { weight: 600 })));
  const minSpan = compact ? 64 : 120;
  const leftW = compact ? valueW + LABEL_GAP * 2 : clamp(Math.ceil(longest) + valueW + LABEL_GAP * 2, 96, Math.floor((width - colsW - minSpan) / 2));
  const rightW = clamp(Math.ceil(longest) + valueW + LABEL_GAP * 2, 96, width - colsW - leftW - minSpan);
  const nameW = rightW - valueW - LABEL_GAP * 2;
  const x0 = leftW;
  const x1 = width - colsW - rightW;
  const axisX = (i: number) => (nAxes === 1 ? x0 : x0 + ((x1 - x0) * i) / last);

  // Vertical scale.
  const values = drawn.flatMap((l) => l.points.flatMap((p) => (plotted(p, scale) === null ? [] : [plotted(p, scale)!])));
  const domain =
    scale === "rank"
      ? { min: 1, max: Math.max(2, ...values) }
      : values.every((v) => v >= 0 && v <= 1)
        ? { min: 0, max: 1 }
        : niceDomain(Math.min(...values), Math.max(...values), 4);
  const top = HEADER_H + 8;
  const nLabels = Math.max(1, drawn.filter((l) => labelled.has(l.key)).length);
  const plotH = props.plotHeight ?? Math.max(168, nLabels * LABEL_H + 12);
  const bottom = top + plotH;
  const y = scale === "rank" ? linear([domain.min, domain.max], [top, bottom]) : linear([domain.min, domain.max], [bottom, top]);
  const pointsOf = (line: SlopeLine) =>
    line.points.map((p, i) => {
      const v = plotted(p, scale);
      return v === null ? null : { x: axisX(i), y: y(v) };
    });

  // End labels per side, a missing end placed level with the line's nearest drawn point.
  const sides = ([0, last] as const).map((i): EndLabel[] =>
    drawn.flatMap((line): EndLabel[] => {
      if (!labelled.has(line.key)) return [];
      const point = line.points[i];
      if (!point) return [];
      const pts = pointsOf(line);
      const at = pts[i] ?? null;
      if (at) return [{ line, y: at.y, point, at }];
      if (compact && i === 0) return [];
      const nearest = (i === 0 ? pts : [...pts].reverse()).find((p) => p !== null);
      return nearest ? [{ line, y: nearest.y, point, at: null }] : [];
    }),
  );
  const spread = sides.map((labels) =>
    spreadLabels(
      labels.map((l) => ({ key: l.line.key, y: l.y })),
      top - 2,
      bottom + 2,
    ),
  );
  const labelBottom = Math.max(bottom, ...spread.flatMap((m) => [...m.values()]));
  const noteY = labelBottom + 12;
  const height = noteY + (unplaced.length > 0 ? NOTE_H : 0) + 4;
  // Draw grey lines first so climbers sit on top.
  const order = [...drawn].sort((a, b) => Number(highlight.has(a.key)) - Number(highlight.has(b.key)));

  return (
    <div className="pt-1">
      <svg
        viewBox={`0 0 ${width} ${px(height)}`}
        width={width}
        role="img"
        aria-label={props.label}
        className="block h-auto max-w-none font-sans"
      >
        <title>{props.label}</title>
        <desc>{describe(data, highlight)}</desc>

        {data.axes.map((a, i) => {
          const outer = nAxes > 1 && (i === 0 || i === last);
          const room = i === 0 ? leftW + 4 : i === last ? rightW : (x1 - x0) / Math.max(1, last);
          return (
            <g key={`axis-${a.key}`} data-axis={a.key}>
              <text
                x={px(axisX(i))}
                y={15}
                textAnchor={outer ? (i === 0 ? "end" : "start") : "middle"}
                fontSize={FONT}
                fontWeight={500}
                className="fill-ink-2"
              >
                {fitText(sentenceCase(a.label), Math.max(24, room - 4), FONT, HEAD_FONT)}
              </text>
              <line x1={px(axisX(i)) + 0.5} x2={px(axisX(i)) + 0.5} y1={top - 4} y2={bottom + 4} className="stroke-line-strong" />
            </g>
          );
        })}
        {cols.map((c, k) => {
          const right = width - colW.slice(k + 1).reduce((s, w) => s + w, 0);
          return (
            <text key={c.kind} x={right} y={15} textAnchor="end" fontSize={FONT} fontWeight={500} className="fill-ink-2">
              {c.head}
            </text>
          );
        })}
        <line x1={0} x2={width} y1={HEADER_H - 0.5} y2={HEADER_H - 0.5} className="stroke-line" />

        {order.map((line) => {
          const strong = highlight.has(line.key);
          const pts = pointsOf(line);
          const segments: string[] = [];
          for (let i = 1; i < pts.length; i += 1) {
            const a = pts[i - 1];
            const b = pts[i];
            if (a && b) segments.push(`M${px(a.x)} ${px(a.y)}L${px(b.x)} ${px(b.y)}`);
          }
          return (
            <g key={line.key} data-row={line.key} data-tone={strong ? "highlight" : "default"}>
              <title>{lineTitle(line, data, style)}</title>
              {segments.length > 0 ? (
                <path
                  d={segments.join("")}
                  fill="none"
                  strokeWidth={strong ? 2 : 1.25}
                  strokeLinecap="round"
                  className={strong ? "stroke-accent" : "stroke-chart-muted"}
                />
              ) : null}
              {pts.map((p, i) =>
                p ? <circle key={i} cx={px(p.x)} cy={px(p.y)} r={strong ? 3.5 : 2.5} className={strong ? "fill-accent" : "fill-chart-muted"} /> : null,
              )}
            </g>
          );
        })}

        {sides.map((labels, side) =>
          labels.map((l) => {
            const at = spread[side]!.get(l.line.key);
            if (at === undefined) return null;
            const strong = highlight.has(l.line.key);
            const left = side === 0 && nAxes > 1;
            const axis = axisX(side === 0 ? 0 : last);
            const anchorX = left ? axis - LABEL_GAP : axis + LABEL_GAP;
            const name = fitText(l.line.label, nameW, FONT, { weight: strong ? 600 : 400 });
            const nameTone = strong ? "fill-ink" : "fill-ink-2";
            const shift = slopeShift(l.line, scale);
            const shiftLabel = shiftText(l.line, scale, style);
            return (
              <g key={`end-${side}-${l.line.key}`} data-end={side === 0 ? "start" : "end"} data-for={l.line.key}>
                {l.at && Math.abs(at - l.at.y) > 3 ? (
                  <line
                    x1={px(l.at.x + (left ? -3 : 3))}
                    y1={px(l.at.y)}
                    x2={px(anchorX + (left ? 2 : -2))}
                    y2={px(at)}
                    className="stroke-line-strong"
                  />
                ) : null}
                {l.at ? (
                  <text
                    x={px(anchorX)}
                    y={px(at + 4)}
                    textAnchor={left ? "end" : "start"}
                    fontSize={FONT}
                    fontWeight={strong ? 600 : 400}
                    className={`tabular-nums ${strong ? "fill-ink" : "fill-ink-2"}`}
                  >
                    {left ? (
                      <>
                        {compact ? null : <tspan className={nameTone}>{name}</tspan>}
                        <tspan dx={compact ? 0 : 6}>{slopeValueText(l.point, scale, style)}</tspan>
                      </>
                    ) : (
                      <>
                        <tspan>{slopeValueText(l.point, scale, style)}</tspan>
                        <tspan dx={6} className={nameTone}>
                          {name}
                        </tspan>
                      </>
                    )}
                  </text>
                ) : (
                  <text
                    x={px(anchorX)}
                    y={px(at + 4)}
                    textAnchor={left ? "end" : "start"}
                    fontSize={FONT}
                    fontStyle="italic"
                    className="fill-ink-2"
                    data-missing="true"
                  >
                    {`${fitText(l.line.label, Math.max(40, missingRoom(left ? axis : width - (showScore ? colW[1]! : 0) - 18 - anchorX, l.point.reason)), FONT)} · ${reasonLabel(l.point.reason)}`}
                  </text>
                )}
                {side === 1 ? (
                  <>
                    <text
                      x={width - (showScore ? colW[1]! : 0)}
                      y={px(at + 4)}
                      textAnchor="end"
                      fontSize={FONT}
                      fontWeight={strong ? 600 : 400}
                      className={`tabular-nums ${shift === null || shiftLabel?.startsWith("=") ? "fill-ink-2" : shift > 0 ? "fill-accent" : "fill-second"}`}
                    >
                      {shiftLabel ?? "—"}
                    </text>
                    {showScore ? (
                      <text
                        x={width}
                        y={px(at + 4)}
                        textAnchor="end"
                        fontSize={FONT}
                        fontWeight={strong ? 600 : 400}
                        className={`tabular-nums ${l.line.score === null ? "fill-ink-2" : "fill-ink"}`}
                      >
                        {l.line.score === null ? "—" : formatNumber(l.line.score, "score", { digits: 0 })}
                      </text>
                    ) : null}
                  </>
                ) : null}
              </g>
            );
          }),
        )}

        {unplaced.length > 0 ? (
          <text x={0} y={px(noteY + 8)} fontSize={FONT} className="fill-ink-2" data-unplaced="true">
            <tspan fontWeight={600}>Not placed</tspan>
            <tspan dx={6} fontStyle="italic">
              {fitText(
                unplaced.map((l) => `${l.label} (${reasonLabel(l.points.find((p) => p.value === null)?.reason ?? null)})`).join(" · "),
                width - 90,
                FONT,
              )}
            </tspan>
          </text>
        ) : null}
      </svg>
    </div>
  );
}

function describe(data: SlopePayload, highlight: ReadonlySet<string>): string {
  const axes = data.axes.map((a) => a.label).join(" → ");
  const climbers = data.lines.filter((l) => highlight.has(l.key)).map((l) => l.label);
  const what = data.valueLabel.charAt(0).toLowerCase() + data.valueLabel.slice(1);
  return `${data.lines.length} lines of ${what}, ${axes}${climbers.length > 0 ? `; highlighted climbers: ${climbers.join(", ")}` : ""}. The table view lists every value.`;
}

function lineTitle(line: SlopeLine, data: SlopePayload, style: NumberStyle): string {
  const points = line.points.map((p, i) => `${data.axes[i]?.label ?? ""} ${slopeValueText(p, data.scale, style)}`).join(", ");
  const shift = shiftText(line, data.scale, style);
  const score = line.score !== null && data.scoreLabel ? `; ${data.scoreLabel} ${formatNumber(line.score, "score", { digits: 0 })}` : "";
  return `${line.label}: ${points}${shift ? `; ${shift.replace("▲", "up").replace("▼", "down")}` : ""}${score}`;
}

/**
 * The table view: every line with each axis value (and rank) or its reason, the shift, the score and
 * whether the plot draws it as a climber (the same set, so a caller's highlightKeys hold here too).
 */
export function slopeTableSpec(data: SlopePayload, caption: string, style: NumberStyle, highlight = slopeHighlight(data)) {
  const withScore = data.scoreLabel !== null && data.lines.some((l) => l.score !== null);
  const columns: TableColumn[] = [
    { label: "Name" },
    ...data.axes.map((a) => ({ label: data.scale === "rank" ? `${a.label} (rank)` : a.label, numeric: true })),
    { label: `Shift vs ${data.axes[0]?.label ?? "start"}`, numeric: true },
    ...(withScore ? [{ label: data.scoreLabel!, numeric: true }] : []),
    { label: "Climber" },
  ];
  const rows: TableRow[] = data.lines.map((line) => {
    const cells: TableCell[] = [
      line.label,
      ...line.points.map((p): TableCell => {
        if (p.value === null) return { kind: "missing", reason: reasonLabel(p.reason) };
        if (data.scale === "rank") return { kind: "value", text: `#${p.rank ?? p.value}` };
        return { kind: "value", text: `${formatNumber(p.value, "pct", style)}${p.rank !== null ? ` · #${p.rank}` : ""}` };
      }),
      line.delta === null
        ? { kind: "missing", reason: reasonLabel(line.points.find((p) => p.value === null)?.reason ?? null) }
        : {
            kind: "value",
            text:
              data.scale === "rank"
                ? line.delta === 0
                  ? "no change"
                  : `${line.delta < 0 ? "up" : "down"} ${Math.abs(line.delta)} ${Math.abs(line.delta) === 1 ? "place" : "places"}`
                : formatNumber(line.delta, "pct", { ...style, signed: true }),
          },
      ...(withScore
        ? [
            line.score === null
              ? ({ kind: "missing", reason: reasonLabel(null) } as const)
              : formatNumber(line.score, "score", { digits: Number.isInteger(line.score) ? 0 : 1 }),
          ]
        : []),
      highlight.has(line.key) ? "climber" : "",
    ];
    return { key: line.key, cells };
  });
  return { caption, columns, rows };
}
