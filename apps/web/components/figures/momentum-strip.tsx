import type { MomentumPayload, MomentumSeries, MomentumTrend } from "@ct/contracts";
import { formatTrendWindow } from "@/lib/brief/format";
import { NoSignal } from "./no-signal";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableRow } from "./figure-table";
import { formatNumber, reasonLabel, type NumberStyle } from "./format";
import { clamp, fitText, hatchPath, linear, px, textWidth } from "./scale";

/**
 * MomentumStrip (kind Momentum: S4, D19). Small multiples, one row per entity: the step-shaped
 * weekly series of population percentiles on a shared scale, the frozen trending window shaded,
 * ^ carets over winsorised outliers, and the trend label with Δ over 26 weeks and the peer rank.
 * Trending data is historical, so the legend always says "No data after <window end>" and the time
 * after the window is hatched, never a guess. A series without signal is a hatched "No signal" band,
 * never a flat line; one with no data says so.
 */

export interface MomentumStripOptions {
  /** Layout width in px; the SVG draws at this width (a narrow box scrolls, it never shrinks the text). Default 680. */
  width?: number;
  /**
   * The last date the axis reaches, e.g. the snapshot date; the stretch after the window is hatched.
   * Default: the window end plus a fifth of the window's length.
   */
  asOf?: string;
  numberStyle?: NumberStyle;
}

export type MomentumStripProps = FigureMeta & MomentumStripOptions & { data: MomentumPayload };

const HEADER_H = 26;
const ROW_H = 42;
const AXIS_H = 20;
const SPARK_PAD = 6;
const DAY = 86_400_000;
/** Every label in the plot: 12 px (the design's 12/16 chart labels). */
const FONT = 12;
const HEAD_FONT = { weight: 500 } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A trend as the strip prints it, with the arrow that carries its direction. */
export const TREND_TEXT: Readonly<Record<MomentumTrend, { mark: string; word: string; tone: string }>> = {
  rising: { mark: "▲", word: "Rising", tone: "fill-accent" },
  flat: { mark: "–", word: "Flat", tone: "fill-ink-2" },
  declining: { mark: "▼", word: "Declining", tone: "fill-second" },
};

function day(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** "Aug 2026": the month the window ends, for "no signal after …". */
export function windowEndMonth(window: MomentumPayload["window"]): string {
  const end = new Date(day(window.end));
  return `${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

/** The shared percentile scale of the strip, widened to steps of 0.05 around the drawn values. */
export function momentumDomain(series: readonly MomentumSeries[]): { min: number; max: number } {
  const values = series.filter((s) => s.state === "ok").flatMap((s) => s.points.map((p) => p.pct));
  if (values.length === 0) return { min: 0, max: 1 };
  const lo = Math.floor(Math.min(...values) * 20 + 1e-9) / 20;
  const hi = Math.ceil(Math.max(...values) * 20 - 1e-9) / 20;
  return { min: clamp(lo, 0, 1), max: clamp(hi === lo ? lo + 0.05 : hi, 0, 1) };
}

/** The step path of a series: each weekly value holds until the next week starts (step-after). */
export function stepPath(
  points: readonly { date: string; pct: number }[],
  x: (t: number) => number,
  y: (v: number) => number,
  end: number,
): string {
  const parts: string[] = [];
  points.forEach((p, i) => {
    const t = day(p.date);
    const next = points[i + 1];
    const until = next ? day(next.date) : Math.min(t + 7 * DAY, end);
    // The first point starts the path; each later one steps vertically to its value, then runs across.
    parts.push(i === 0 ? `M${px(x(t))} ${px(y(p.pct))}` : `V${px(y(p.pct))}`, `H${px(x(until))}`);
  });
  return parts.join("");
}

export function MomentumStrip(props: MomentumStripProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { leadingZero: false, ...props.numberStyle };
  const { data } = props;
  return (
    <FigureFrame
      meta={props}
      legend={
        <span className="flex flex-wrap items-center gap-x-5 gap-y-1" data-badge={data.badge}>
          <NoSignal label={`No data after ${windowEndMonth(data.window)}`} />
        </span>
      }
      plot={<StripPlot {...props} label={label} style={style} />}
      table={<FigureTable spec={momentumTableSpec(data, label, style)} />}
    />
  );
}

function StripPlot(props: MomentumStripProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const width = props.width ?? 680;
  const compact = width < 480;
  const start = day(data.window.start);
  const windowEnd = day(data.window.end) + DAY;
  const asOf = props.asOf ? day(props.asOf) + DAY : windowEnd + Math.round((windowEnd - start) / 5 / DAY) * DAY;
  const end = Math.max(asOf, windowEnd);

  const labelW = compact ? 96 : 148;
  const cols = compact
    ? [{ key: "trend", head: "Trend", w: 92 }]
    : [
        { key: "trend", head: "Trend", w: 100 },
        { key: "delta", head: "26-wk change", w: 92 },
        { key: "peers", head: "Peers", w: 60 },
      ];
  const colsW = cols.reduce((s, c) => s + c.w, 0);
  const sparkX = labelW + 8;
  // Room after the hatch for the scale's two numbers.
  const sparkW = Math.max(80, width - sparkX - colsW - 40);
  const x = linear([start, end], [sparkX, sparkX + sparkW]);
  const domain = momentumDomain(data.series);
  const rows = data.series;
  const plotBottom = HEADER_H + rows.length * ROW_H;
  const height = plotBottom + AXIS_H;
  const winX0 = px(x(start));
  const winX1 = px(x(windowEnd));
  const tailX1 = px(x(end));
  const colX = (k: number) => width - cols.slice(k + 1).reduce((s, c) => s + c.w, 0);

  // Month ticks inside the axis: the first of each month.
  const ticks: { t: number; text: string }[] = [];
  const first = new Date(start);
  for (let m = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)); m.getTime() < end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    ticks.push({ t: m.getTime(), text: MONTHS[m.getUTCMonth()]! });
  }
  const tickEvery = sparkW / Math.max(1, ticks.length) < 34 ? 2 : 1;

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
        <desc>{describe(data)}</desc>

        <text x={0} y={16} fontSize={FONT} fontWeight={500} className="fill-ink-2">
          Name
        </text>
        <text x={px((winX0 + winX1) / 2)} y={16} textAnchor="middle" fontSize={FONT} fontWeight={500} className="fill-ink-2">
          {windowHead(formatTrendWindow(data.window), winX1 - winX0)}
        </text>
        {cols.map((c, k) => (
          <text key={c.key} x={colX(k)} y={16} textAnchor="end" fontSize={FONT} fontWeight={500} className="fill-ink-2">
            {c.head}
          </text>
        ))}
        <line x1={0} x2={width} y1={HEADER_H - 0.5} y2={HEADER_H - 0.5} className="stroke-line" />

        {/* The window shaded, the stretch after it hatched: no signal after the window. */}
        <rect x={winX0} y={HEADER_H} width={px(winX1 - winX0)} height={px(plotBottom - HEADER_H)} className="fill-sunken" />
        {tailX1 > winX1 + 1 ? (
          <g data-no-signal-after={data.window.end}>
            <path d={hatchPath(winX1, HEADER_H, tailX1 - winX1, plotBottom - HEADER_H, 6)} className="stroke-line-strong" strokeWidth={1} />
            <line x1={winX1 + 0.5} x2={winX1 + 0.5} y1={HEADER_H} y2={plotBottom} className="stroke-ink-3" strokeDasharray="2 2" />
          </g>
        ) : null}

        {rows.map((s, i) => (
          <SeriesRow
            key={s.ref}
            series={s}
            y0={HEADER_H + i * ROW_H}
            x={x}
            domain={domain}
            spark={[winX0, winX1]}
            end={windowEnd}
            labelW={labelW}
            cols={cols}
            colX={colX}
            style={style}
            last={i === rows.length - 1}
            width={width}
          />
        ))}

        {ticks.map((t, k) =>
          k % tickEvery === 0 ? (
            <text key={t.t} x={px(x(t.t))} y={px(plotBottom + 15)} textAnchor="middle" fontSize={FONT} className="fill-ink-2">
              {t.text}
            </text>
          ) : null,
        )}
        {/* The shared scale, once, beside the first row past the hatch, when any series is drawn. */}
        {rows.some((s) => s.state === "ok") ? (
          <g data-scale="true">
            <text x={tailX1 + 4} y={px(HEADER_H + SPARK_PAD + 6)} fontSize={FONT} className="fill-ink-2 font-mono tabular-nums">
              {formatNumber(domain.max, "pct", style)}
            </text>
            <text x={tailX1 + 4} y={px(HEADER_H + ROW_H - SPARK_PAD + 2)} fontSize={FONT} className="fill-ink-2 font-mono tabular-nums">
              {formatNumber(domain.min, "pct", style)}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}

/** The shaded window's head: "Trending window, Mar–Aug 2026", or only the months when that does not fit. */
function windowHead(window: string, room: number): string {
  const full = `Trending window, ${window}`;
  return textWidth(full, FONT, HEAD_FONT) <= room ? full : fitText(window, room, FONT, HEAD_FONT);
}

function SeriesRow({
  series,
  y0,
  x,
  domain,
  spark,
  end,
  labelW,
  cols,
  colX,
  style,
  last,
  width,
}: {
  series: MomentumSeries;
  y0: number;
  x: (t: number) => number;
  domain: { min: number; max: number };
  spark: readonly [number, number];
  end: number;
  labelW: number;
  cols: readonly { key: string; head: string; w: number }[];
  colX: (k: number) => number;
  style: NumberStyle;
  last: boolean;
  width: number;
}) {
  const top = y0 + SPARK_PAD;
  const bottom = y0 + ROW_H - SPARK_PAD;
  const y = linear([domain.min, domain.max], [bottom, top]);
  const name = fitText(series.label, labelW, FONT, { weight: 500 });
  const trend = series.trend ? TREND_TEXT[series.trend] : null;
  return (
    <g data-row={series.ref} data-state={series.state}>
      <title>{seriesTitle(series, style)}</title>
      <text x={0} y={px(y0 + 17)} fontSize={FONT} fontWeight={500} className="fill-ink">
        {name}
      </text>
      <text x={0} y={px(y0 + 33)} fontSize={FONT} className="fill-ink-2">
        {fitText(`${series.type.replace("_", " ")}${series.scaleBreak ? " · scale break" : ""}`, labelW, FONT)}
      </text>

      {series.state === "ok" ? (
        <>
          <path d={stepPath(series.points, x, y, end)} fill="none" strokeWidth={1.5} strokeLinejoin="round" className="stroke-accent" />
          {series.points
            .filter((p) => p.clipped)
            .map((p) => {
              const cx = x(day(p.date) + 3.5 * DAY);
              const cy = y(p.pct) - 4;
              return (
                <path
                  key={`clip-${p.date}`}
                  d={`M${px(cx - 3)} ${px(cy)}L${px(cx)} ${px(cy - 4)}L${px(cx + 3)} ${px(cy)}`}
                  fill="none"
                  strokeWidth={1.25}
                  className="stroke-accent"
                  data-clipped={p.date}
                />
              );
            })}
          {series.points.length > 0 ? (
            <circle cx={px(x(Math.min(day(series.points[series.points.length - 1]!.date) + 7 * DAY, end)))} cy={px(y(series.points[series.points.length - 1]!.pct))} r={2.5} className="fill-accent" />
          ) : null}
        </>
      ) : (
        <g data-hatch={series.state}>
          <rect x={spark[0]} y={top} width={px(spark[1] - spark[0])} height={px(bottom - top)} className="fill-surface stroke-line-strong" />
          <path d={hatchPath(spark[0], top, spark[1] - spark[0], bottom - top, 5)} className="stroke-ink-3" strokeWidth={1} />
          <SignalNote x={(spark[0] + spark[1]) / 2} y={(top + bottom) / 2} text={series.state === "no_signal" ? "No signal" : "Not measured"} />
        </g>
      )}

      {cols.map((c, k) => {
        const right = colX(k);
        const cy = px(y0 + 25);
        if (c.key === "trend") {
          if (!trend) {
            return (
              <text key={c.key} x={right} y={cy} textAnchor="end" fontSize={FONT} className="fill-ink-2">
                {reasonLabel(series.reason)}
              </text>
            );
          }
          return (
            <text key={c.key} x={right} y={cy} textAnchor="end" fontSize={FONT} fontWeight={500} className={trend.tone}>
              {`${trend.mark} ${trend.word}`}
            </text>
          );
        }
        if (c.key === "delta") {
          return (
            <text key={c.key} x={right} y={cy} textAnchor="end" fontSize={FONT} className={`font-mono tabular-nums ${series.delta26w === null ? "fill-ink-2" : "fill-ink"}`}>
              {series.delta26w === null ? "—" : formatNumber(series.delta26w, "pct", { ...style, signed: true })}
            </text>
          );
        }
        return (
          <text key={c.key} x={right} y={cy} textAnchor="end" fontSize={FONT} className="fill-ink-2 font-mono tabular-nums">
            {series.peerRank ? `${series.peerRank.rank} of ${series.peerRank.of}` : "—"}
          </text>
        );
      })}
      {!last ? <line x1={0} x2={width} y1={px(y0 + ROW_H - 0.5)} y2={px(y0 + ROW_H - 0.5)} className="stroke-line" /> : null}
    </g>
  );
}

function SignalNote({ x, y, text }: { x: number; y: number; text: string }) {
  const w = textWidth(text, FONT, { weight: 500 }) + 12;
  return (
    <g>
      <rect x={px(x - w / 2)} y={px(y - 9)} width={px(w)} height={18} rx={9} className="fill-surface" />
      <text x={px(x)} y={px(y + 4)} textAnchor="middle" fontSize={FONT} fontWeight={500} className="fill-ink-2">
        {text}
      </text>
    </g>
  );
}

function describe(data: MomentumPayload): string {
  const ok = data.series.filter((s) => s.state === "ok");
  const without = data.series.length - ok.length;
  return `${data.series.length} weekly series of population percentile over ${formatTrendWindow(data.window)}, historical; ${ok.length} with a trend${without > 0 ? `, ${without} without signal` : ""}; no signal after ${windowEndMonth(data.window)}. The table view lists every week.`;
}

function seriesTitle(s: MomentumSeries, style: NumberStyle): string {
  if (s.state !== "ok") return `${s.label}: ${s.state === "no_signal" ? "no signal" : `not measured (${reasonLabel(s.reason)})`}`;
  const trend = s.trend ? TREND_TEXT[s.trend].word : "no trend";
  const delta = s.delta26w === null ? "" : `, ${formatNumber(s.delta26w, "pct", { ...style, signed: true })} over 26 weeks`;
  const peers = s.peerRank ? `, ${s.peerRank.rank} of ${s.peerRank.of} among peers` : "";
  const cut = s.scaleBreak ? "; scale break, latest segment kept" : "";
  return `${s.label}: ${trend}${delta}${peers}${cut}`;
}

/**
 * The table view: one section per entity with its trend, Δ over 26 weeks, Mann–Kendall τ and p, peer
 * rank, then every week's percentile (clipped outliers marked). A series without signal says why.
 */
export function momentumTableSpec(data: MomentumPayload, caption: string, style: NumberStyle) {
  const rows: TableRow[] = [];
  for (const s of data.series) {
    rows.push({ key: `section-${s.ref}`, section: `${s.label} · ${s.type.replace("_", " ")}` });
    const missing = { kind: "missing", reason: reasonLabel(s.reason) } as const;
    rows.push({ key: `${s.ref}-trend`, cells: ["Trend", s.trend ? TREND_TEXT[s.trend].word : missing, `Historical, ${formatTrendWindow(data.window)}`] });
    if (s.state === "ok") {
      rows.push({
        key: `${s.ref}-delta`,
        cells: ["Δ over 26 weeks", s.delta26w === null ? missing : formatNumber(s.delta26w, "pct", { ...style, signed: true }), "Theil–Sen slope × 26"],
      });
      rows.push({
        key: `${s.ref}-mk`,
        cells: [
          "Mann–Kendall τ, p",
          s.tau === null || s.p === null ? missing : `${formatNumber(s.tau, "stat", { signed: true })}, ${formatNumber(s.p, "stat", { digits: 3 })}`,
          "",
        ],
      });
      rows.push({ key: `${s.ref}-peers`, cells: ["Peer rank", s.peerRank ? `${s.peerRank.rank} of ${s.peerRank.of}` : missing, ""] });
      if (s.scaleBreak) rows.push({ key: `${s.ref}-break`, cells: ["Scale break", "latest segment kept", ""] });
      for (const p of s.points) {
        rows.push({ key: `${s.ref}-${p.date}`, cells: [`Week of ${p.date}`, formatNumber(p.pct, "pct", style), p.clipped ? "winsorised outlier (^)" : ""] });
      }
    }
  }
  return {
    caption,
    columns: [{ label: "Measure" }, { label: "Value", numeric: true }, { label: "Note" }],
    rows,
  };
}
