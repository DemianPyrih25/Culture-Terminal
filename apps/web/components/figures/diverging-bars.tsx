import type { Bar, BarsPayload, MetricUnit } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableColumn, type TableRow } from "./figure-table";
import {
  COMPARATOR_NOUN,
  cellText,
  comparatorHead,
  formatNumber,
  formatTick,
  reasonLabel,
  sentenceCase,
  type NumberStyle,
} from "./format";
import { fitText, linear, niceDomain, px, symmetricDomain, textWidth, ticksBetween } from "./scale";

/**
 * DivergingBars (kind Bars: BLOCK, DNA and head-to-head splits). Four displays of one payload:
 * - diverging: one series of deltas around the comparator, over in the Ledger good green, under in the
 *   danger red (the lift palette), with NEW notches (Block DNA);
 * - split (A04 figure 1): two shares around an even split, the bar is the lead of the first share
 *   within the pair, the shaded band (±.02 by default) reads as even, both value columns; a row
 *   missing either share gets its reason, never a lead;
 * - dumbbell (A04 figure 2, A08 figure 1): one dot per series on an index axis around the
 *   baseline, joined by the gap; optionally a delta column against the second series;
 * - butterfly: two series mirrored around a centre label column (head-to-head DNA), signed: each
 *   panel has its own zero line, values below it point back toward the centre.
 *
 * The payload may say how to draw it (display, baseline, evenBand); an option the caller passes
 * wins over the payload. Otherwise the baseline is 0, or 1 for a lift or ratio with every value
 * positive. DNA indices (dna.age_index, dna.gender_index) run from −1 to 1 around 0. A one-series
 * dumbbell (a dot plot, e.g. neighbourhood lift around 1.00) draws dots below the baseline in the
 * negative colour.
 */

export type BarsDisplay = "diverging" | "split" | "dumbbell" | "butterfly";

export interface DivergingBarsOptions {
  /** Default: the payload's display, else butterfly for a two-series payload, diverging for one series. */
  display?: BarsDisplay;
  /** Layout width in px; the SVG scales with its viewBox. Default 680. */
  width?: number;
  /** Width of the label column. Default 120. */
  labelWidth?: number;
  /**
   * The centre value. Default: the payload's baseline, else 0.5 for a split; 1 for a lift or ratio
   * whose values are all positive; 0 otherwise (deltas, and indices such as dna.age_index on −1 to 1).
   */
  baseline?: number;
  /** Half-width of the "reads as even" band in a split; null hides it. Default: the payload's evenBand, else 0.02. */
  band?: number | null;
  /** Head of the label column, e.g. "Metro" or "Age". */
  labelHeader?: string;
  /** Text either side of the centre, e.g. ["← Brand B ahead", "Brand A ahead →"]; null hides them. */
  directionLabels?: readonly [string, string] | null;
  /** dumbbell with two series: show the first series and its delta to the second, ▲/▼. */
  deltaColumn?: boolean;
  /** Head of the delta column; default "VS <second series>". */
  deltaHeader?: string;
  /** Tick label at the baseline, e.g. "0 = avg". */
  baselineLabel?: string;
  numberStyle?: NumberStyle;
}

export type DivergingBarsProps = FigureMeta & DivergingBarsOptions & { data: BarsPayload };

const HEADER_H = 24;
const GROUP_H = 20;
const AXIS_H = 20;
const VALUE_W = 68;
const VALUE_GAP = 32;
const PAD = 16;
/** Units that centre on 1, but only when every value is positive. */
const BASELINE_ONE: ReadonlySet<MetricUnit> = new Set(["lift", "ratio"]);
const INTEGER_UNITS: ReadonlySet<MetricUnit> = new Set(["delta", "rank", "count"]);
const HEAD_FONT = { weight: 500 } as const;

export function DivergingBars(props: DivergingBarsProps) {
  const label = figureLabel(props);
  const display = resolveDisplay(props);
  // Whole-number deltas (rank gains) print without decimals: "+14", not "+14.00".
  const whole =
    INTEGER_UNITS.has(props.data.unit) &&
    props.data.groups.every((g) => g.bars.every((b) => b.values.every((c) => c.value === null || Number.isInteger(c.value))));
  const style: NumberStyle = {
    leadingZero: display === "split" ? false : undefined,
    digits: whole ? 0 : undefined,
    ...props.numberStyle,
  };
  const method = props.data.method;
  return (
    <FigureFrame
      meta={props}
      fixedCaption={props.data.caption}
      legend={
        method ? (
          <span className="type-label text-ink-2">
            Location method · {method}
          </span>
        ) : null
      }
      plot={<BarsPlot {...props} display={display} label={label} style={style} />}
      table={<FigureTable spec={barsTableSpec(props.data, label, display, style, props)} />}
    />
  );
}

function resolveDisplay(props: DivergingBarsProps): BarsDisplay {
  const two = props.data.series.length === 2;
  const wanted = props.display ?? props.data.display ?? (two ? "butterfly" : "diverging");
  // Two-series displays need the second series; a one-series payload falls back to its own displays.
  if (!two && (wanted === "split" || wanted === "butterfly")) return "diverging";
  return wanted;
}

function allValues(data: BarsPayload): number[] {
  return data.groups.flatMap((g) => g.bars.flatMap((b) => b.values.flatMap((c) => (c.value === null ? [] : [c.value]))));
}

function baselineFor(display: BarsDisplay, data: BarsPayload, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (data.baseline !== undefined) return data.baseline;
  if (display === "split") return 0.5;
  const values = allValues(data);
  return BASELINE_ONE.has(data.unit) && values.length > 0 && values.every((x) => x > 0) ? 1 : 0;
}

/** The "reads as even" half-width: the option, else the payload's evenBand, else 0.02; null hides it. */
function evenBandFor(props: Pick<DivergingBarsProps, "band" | "data">): number | null {
  if (props.band !== undefined) return props.band;
  return props.data.evenBand ?? 0.02;
}

/**
 * A split's lead: the first share of the pair minus the even split. Computed within the pair, so it
 * holds when the two shares do not sum to 1; null when either share is missing.
 */
function splitLead(bar: Bar, even: number): number | null {
  const a = bar.values[0]?.value ?? null;
  const b = bar.values[1]?.value ?? null;
  if (a === null || b === null) return null;
  return a + b > 0 ? a / (a + b) - even : 0;
}

/** Why a row has no value to draw: the reason of its first missing value. */
function missingReason(bar: Bar): Bar["values"][number]["reason"] {
  return bar.values.find((c) => c.value === null)?.reason ?? null;
}

type Line = { kind: "group"; label: string; y: number } | { kind: "bar"; bar: Bar; y: number };

function layoutLines(data: BarsPayload, rowH: number): { lines: Line[]; height: number } {
  const lines: Line[] = [];
  let y = HEADER_H;
  for (const group of data.groups) {
    if (data.groups.length > 1) {
      lines.push({ kind: "group", label: group.label, y });
      y += GROUP_H;
    }
    for (const bar of group.bars) {
      lines.push({ kind: "bar", bar, y });
      y += rowH;
    }
  }
  return { lines, height: y };
}

function BarsPlot(props: DivergingBarsProps & { display: BarsDisplay; label: string; style: NumberStyle }) {
  if (props.display === "butterfly") return <Butterfly {...props} />;
  const { data, display, style } = props;
  const width = props.width ?? 680;
  const labelW = props.labelWidth ?? 120;
  const [s0, s1] = data.series;
  const two = s1 !== undefined;
  const nCols = display === "diverging" || (display === "dumbbell" && !two) ? 1 : 2;
  const trackX = labelW;
  const baseline = baselineFor(display, data, props.baseline);
  const evenBand = evenBandFor(props);
  const band = display === "split" ? evenBand : null;
  const rowH = display === "dumbbell" ? (props.deltaColumn ? 24 : 22) : 19;
  const { lines, height: plotBottom } = layoutLines(data, rowH);
  const height = plotBottom + AXIS_H;

  const bars = data.groups.flatMap((g) => g.bars);
  const noun = COMPARATOR_NOUN[data.comparator];
  const heads: { text: string; swatch: "data" | "data-2" | null }[] =
    display === "diverging"
      ? [{ text: comparatorHead(data.comparator), swatch: null }]
      : display === "dumbbell" && props.deltaColumn && two
        ? [
            { text: data.unit.charAt(0).toUpperCase() + data.unit.slice(1), swatch: null },
            { text: props.deltaHeader ?? `vs ${s1.label}`, swatch: null },
          ]
        : [
            { text: s0?.label ?? "", swatch: "data" },
            ...(two ? [{ text: s1.label, swatch: "data-2" as const }] : []),
          ];
  // Value columns are 68 px (A04) unless a series name needs more, up to 112 px.
  const valueW = Math.min(
    112,
    Math.max(VALUE_W, ...heads.map((h) => Math.ceil(textWidth(h.text, 12, HEAD_FONT)) + (h.swatch ? 16 : 4))),
  );
  const trackW = width - labelW - VALUE_GAP - nCols * valueW;
  // Values on the axis: leads for a split, raw values otherwise. A payload domain sets the same axis.
  const axisValues = bars.flatMap((b) => {
    if (display === "split") {
      const lead = splitLead(b, baseline);
      return lead === null ? [] : [lead];
    }
    return b.values.flatMap((c) => (c.value === null ? [] : [c.value]));
  });
  const centre = display === "split" ? 0 : baseline;
  const domain = data.domain
    ? { ...data.domain, step: niceDomain(data.domain.min, data.domain.max, 6).step }
    : symmetricDomain(axisValues, centre, 3);
  const x = linear([domain.min, domain.max], [trackX + PAD, trackX + trackW - PAD]);
  const ticks = ticksBetween(domain.min, domain.max, domain.step);
  const cx = px(x(centre));

  const colX = (k: number) => width - (nCols - 1 - k) * valueW;
  const direction =
    props.directionLabels === null || (display === "dumbbell" && props.deltaColumn)
      ? null
      : (props.directionLabels ??
        (display === "split"
          ? ([`← ${s1?.label ?? ""} ahead`, `${s0?.label ?? ""} ahead →`] as const)
          : display === "dumbbell"
            ? ([`← Below ${noun}`, "Above →"] as const)
            : ([`← Below ${noun}`, `Above ${noun} →`] as const)));
  const dot = display === "dumbbell";

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
        <desc>{describe(data, display, baseline)}</desc>

        {/* Header: label head, direction or legend over the track, value column heads. */}
        <text x={0} y={15} fontSize={12} fontWeight={500} className="fill-ink-2">
          {sentenceCase(props.labelHeader ?? "")}
        </text>
        {direction ? (
          <>
            <text x={cx - 8} y={15} textAnchor="end" fontSize={12} fontWeight={500} className="fill-ink-2">
              {fitText(direction[0], cx - trackX - 8, 12, HEAD_FONT)}
            </text>
            <text x={cx + 8} y={15} fontSize={12} fontWeight={500} className="fill-ink-2">
              {fitText(direction[1], trackX + trackW - cx - 8, 12, HEAD_FONT)}
            </text>
          </>
        ) : display === "dumbbell" && two ? (
          <HeaderLegend x={trackX + PAD} names={[s0!.label, s1.label]} />
        ) : null}
        {heads.map((h, k) => {
          const right = colX(k);
          const text = fitText(h.text, valueW - (h.swatch ? 16 : 2), 12, HEAD_FONT);
          const w = textWidth(text, 12, HEAD_FONT);
          return (
            <g key={`h-${k}`}>
              {h.swatch ? (
                dot ? (
                  <circle cx={px(right - w - 10)} cy={11.5} r={4} className={h.swatch === "data" ? "fill-accent" : "fill-chart-muted"} />
                ) : (
                  <rect x={px(right - w - 14)} y={7.5} width={8} height={8} className={h.swatch === "data" ? "fill-accent" : "fill-chart-muted"} />
                )
              ) : null}
              <text x={right} y={15} textAnchor="end" fontSize={12} fontWeight={500} className="fill-ink-2">
                {text}
              </text>
            </g>
          );
        })}
        <line x1={0} x2={width} y1={HEADER_H - 0.5} y2={HEADER_H - 0.5} className="stroke-line" />

        {lines.map((line) => {
          if (line.kind === "group") {
            return (
              <text key={`g-${line.y}`} x={0} y={px(line.y + 14)} fontSize={12} fontWeight={500} className="fill-ink-2">
                {sentenceCase(line.label)}
              </text>
            );
          }
          const { bar, y } = line;
          const mid = y + rowH / 2;
          const v0 = bar.values[0]?.value ?? null;
          const v1 = bar.values[1]?.value ?? null;
          const labelText = fitText(bar.label, labelW - (bar.isNew ? 44 : 10), 12);
          return (
            <g key={`b-${bar.key}`} data-row={bar.key}>
              <title>{barTitle(bar, data, display, style, baseline)}</title>
              {band !== null ? (
                <rect x={px(x(-band))} y={y} width={px(x(band) - x(-band))} height={rowH} className="fill-sunken" />
              ) : null}
              {ticks
                .filter((t) => Math.abs(t - centre) > 1e-9)
                .map((t) => (
                  <line key={t} x1={px(x(t)) + 0.5} x2={px(x(t)) + 0.5} y1={y} y2={y + rowH} className="stroke-chart-grid" />
                ))}
              <text x={0} y={px(mid + 4)} fontSize={12} className="fill-ink-2">
                {labelText}
              </text>
              {bar.isNew ? (
                <text x={labelW - 10} y={px(mid + 3.5)} textAnchor="end" fontSize={12} fontWeight={600} className="fill-accent-ink">
                  New
                </text>
              ) : null}

              {display === "split" ? (
                <SplitBar x={x} cx={cx} mid={mid} lead={splitLead(bar, baseline)} reason={missingReason(bar)} />
              ) : display === "diverging" ? (
                v0 === null ? (
                  <MissingNote x={cx + 6} y={mid} reason={bar.values[0]?.reason ?? null} />
                ) : (
                  <rect
                    x={px(Math.min(cx, x(v0)))}
                    y={px(mid - 4.5)}
                    width={px(Math.abs(x(v0) - cx))}
                    height={9}
                    className={v0 >= baseline ? "fill-good" : "fill-danger"}
                  />
                )
              ) : (
                <Dumbbell
                  x={x}
                  cx={cx}
                  span={[trackX + 4, trackX + trackW - 4]}
                  mid={mid}
                  v0={v0}
                  v1={two ? v1 : baseline}
                  hasSecond={two}
                  below={!two && v0 !== null && v0 < baseline}
                  reason={bar.values[0]?.reason ?? null}
                />
              )}

              <line x1={cx + 0.5} x2={cx + 0.5} y1={y} y2={y + rowH} className="stroke-ink-3" />

              <ValueColumns
                display={display}
                bar={bar}
                unit={data.unit}
                style={style}
                band={display === "split" ? (band ?? 0) : (evenBand ?? 0.02)}
                deltaColumn={display === "dumbbell" && two && Boolean(props.deltaColumn)}
                colX={colX}
                y={mid + 4}
                baseline={baseline}
              />
            </g>
          );
        })}

        {ticks.map((t) => {
          const atCentre = Math.abs(t - centre) < 1e-9;
          const text =
            atCentre && props.baselineLabel
              ? props.baselineLabel
              : formatTick(t, domain.step, data.unit, {
                  leadingZero: display === "split" ? false : undefined,
                  absolute: display === "split",
                  minDigits: display === "dumbbell" ? 2 : 0,
                });
          return (
            <text
              key={`t-${t}`}
              x={px(x(t)) + 0.5}
              y={px(plotBottom + 14)}
              textAnchor="middle"
              fontSize={12}
              fontWeight={atCentre && display === "dumbbell" ? 500 : 400}
              className={`font-mono tabular-nums ${atCentre && display === "dumbbell" ? "fill-ink" : "fill-ink-2"}`}
            >
              {text}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function HeaderLegend({ x, names }: { x: number; names: readonly [string, string] }) {
  const first = textWidth(names[0], 12) + 14 + 18;
  return (
    <g>
      <circle cx={x + 4} cy={11.5} r={4} className="fill-accent" />
      <text x={x + 14} y={15.5} fontSize={12} className="fill-ink-2">
        {names[0]}
      </text>
      <circle cx={px(x + first + 4)} cy={11.5} r={4} className="fill-chart-muted" />
      <text x={px(x + first + 14)} y={15.5} fontSize={12} className="fill-ink-2">
        {names[1]}
      </text>
    </g>
  );
}

function SplitBar({
  x,
  cx,
  mid,
  lead,
  reason,
}: {
  x: (v: number) => number;
  cx: number;
  mid: number;
  lead: number | null;
  reason: Bar["values"][number]["reason"];
}) {
  if (lead === null) return <MissingNote x={cx + 6} y={mid} reason={reason} />;
  return (
    <rect
      x={px(Math.min(x(0), x(lead)))}
      y={px(mid - 4.5)}
      width={px(Math.abs(x(lead) - x(0)))}
      height={9}
      className={lead >= 0 ? "fill-accent" : "fill-chart-muted"}
    />
  );
}

function Dumbbell({
  x,
  cx,
  span,
  mid,
  v0,
  v1,
  hasSecond,
  below = false,
  reason,
}: {
  x: (v: number) => number;
  cx: number;
  /** Track edges, for the reason note when only the second series has a value. */
  span: readonly [number, number];
  mid: number;
  v0: number | null;
  v1: number | null;
  hasSecond: boolean;
  /** A one-series dot below the baseline: drawn in the negative colour. */
  below?: boolean;
  reason: Bar["values"][number]["reason"];
}) {
  if (v0 === null && (v1 === null || !hasSecond)) return <MissingNote x={cx + 6} y={mid} reason={reason} />;
  return (
    <g>
      {v0 !== null && v1 !== null ? (
        <rect
          x={px(Math.min(x(v0), x(v1)))}
          y={px(mid - 1)}
          width={px(Math.abs(x(v0) - x(v1)))}
          height={2}
          className="fill-line-strong"
        />
      ) : null}
      {hasSecond && v1 !== null ? <circle cx={px(x(v1))} cy={px(mid)} r={4.5} className="fill-chart-muted" /> : null}
      {v0 !== null ? (
        <circle cx={px(x(v0))} cy={px(mid)} r={4.75} className={below ? "fill-second" : "fill-accent"} />
      ) : v1 !== null && x(v1) >= cx ? (
        <MissingNote x={span[0]} y={mid} reason={reason} />
      ) : (
        <MissingNote x={span[1]} y={mid} reason={reason} anchor="end" />
      )}
    </g>
  );
}

function MissingNote({
  x,
  y,
  reason,
  anchor = "start",
}: {
  x: number;
  y: number;
  reason: Bar["values"][number]["reason"];
  anchor?: "start" | "end";
}) {
  return (
    <text x={px(x)} y={px(y + 3.5)} textAnchor={anchor} fontSize={12} fontStyle="italic" className="fill-ink-2">
      {reasonLabel(reason)}
    </text>
  );
}

function ValueColumns({
  display,
  bar,
  unit,
  style,
  band,
  deltaColumn,
  colX,
  y,
  baseline,
}: {
  display: BarsDisplay;
  bar: Bar;
  unit: MetricUnit;
  style: NumberStyle;
  band: number;
  deltaColumn: boolean;
  colX: (k: number) => number;
  y: number;
  baseline: number;
}) {
  const v0 = bar.values[0]?.value ?? null;
  const v1 = bar.values[1]?.value ?? null;
  const missing = (k: number) => (
    <text key={k} x={colX(k)} y={px(y)} textAnchor="end" fontSize={12} className="fill-ink-2">
      {"—"}
    </text>
  );
  if (display === "diverging") {
    if (v0 === null) return missing(0);
    return (
      <text
        x={colX(0)}
        y={px(y)}
        textAnchor="end"
        fontSize={12}
        fontWeight={500}
        className={`font-mono tabular-nums ${v0 < baseline ? "fill-danger-ink" : "fill-ink"}`}
      >
        {formatNumber(v0, unit, { signed: true, ...style })}
      </text>
    );
  }
  if (deltaColumn) {
    const delta = v0 !== null && v1 !== null ? v0 - v1 : null;
    const flat = delta !== null && Number(Math.abs(delta).toFixed(style.digits ?? 2)) === 0;
    return (
      <>
        {v0 === null ? (
          missing(0)
        ) : (
          <text x={colX(0)} y={px(y)} textAnchor="end" fontSize={12} fontWeight={500} className="fill-ink font-mono tabular-nums">
            {formatNumber(v0, unit, style)}
          </text>
        )}
        {delta === null ? (
          missing(1)
        ) : (
          <text
            x={colX(1)}
            y={px(y)}
            textAnchor="end"
            fontSize={12}
            className={`font-mono tabular-nums ${flat ? "fill-ink-2" : delta > 0 ? "fill-accent" : "fill-second"}`}
          >
            {`${flat ? "=" : delta > 0 ? "▲" : "▼"} ${formatNumber(Math.abs(delta), unit, { ...style, signed: false })}`}
          </text>
        )}
      </>
    );
  }
  // Two value columns: the clear leader in bold ink, the other dim; inside the band, or with one
  // value missing, both regular.
  const lead = v0 !== null && v1 !== null ? (display === "split" ? splitLead(bar, baseline) : v0 - v1) : null;
  const clear = lead !== null && Math.abs(lead) > band + 1e-9;
  const cols = display === "dumbbell" && bar.values.length === 1 ? [v0] : [v0, v1];
  return (
    <>
      {cols.map((v, k) => {
        if (v === null) return missing(k);
        const leads = lead === null ? true : k === 0 ? lead > 0 : lead < 0;
        const tone = cols.length === 1 ? "fill-ink" : clear ? (leads ? "fill-ink" : "fill-ink-2") : leads ? "fill-ink-2" : "fill-ink-2";
        return (
          <text
            key={k}
            x={colX(k)}
            y={px(y)}
            textAnchor="end"
            fontSize={12}
            fontWeight={clear && leads ? 600 : 400}
            className={`font-mono tabular-nums ${tone}`}
          >
            {formatNumber(v, unit, style)}
          </text>
        );
      })}
    </>
  );
}

// Butterfly ---------------------------------------------------------------------------------------

const VALUE_ROOM = 40;

function Butterfly(props: DivergingBarsProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const width = props.width ?? 680;
  const labelW = props.labelWidth ?? 120;
  const [s0, s1] = data.series;
  const rowH = 19;
  const { lines, height: plotBottom } = layoutLines(data, rowH);
  const height = plotBottom + 6;
  const half = (width - labelW) / 2;
  const baseline = baselineFor("butterfly", data, props.baseline);
  const values = allValues(data);
  const lo = Math.min(0, baseline, ...values);
  const hi = Math.max(0, baseline, ...values);
  const nice = data.domain ?? niceDomain(lo, hi === lo ? lo + 1 : hi, 3);
  // Each panel reads outward from its own zero line. With values below zero the zero line moves
  // out from the centre, so a negative bar points back toward the centre, with room for its value.
  const dMin = Math.min(0, nice.min);
  const dMax = Math.max(0, nice.max);
  const signed = dMin < 0;
  const inner = signed ? VALUE_ROOM : 0;
  const reach = linear([dMin, dMax], [0, half - 4 - inner - VALUE_ROOM]);
  const sides = [
    { series: s0, k: 0, sign: -1, edge: half - 4, fill: "fill-accent" },
    { series: s1, k: 1, sign: 1, edge: half + labelW + 4, fill: "fill-chart-muted" },
  ] as const;
  /** The x of a value in a panel: outward from the panel's inner edge. */
  const at = (side: (typeof sides)[number], value: number) => side.edge + side.sign * (inner + reach(value));
  const markBaseline = baseline !== 0 && baseline >= dMin && baseline <= dMax;

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
        <desc>{describe(data, "butterfly", baseline, signed)}</desc>
        {sides.map((s) => (
          <g key={`h-${s.k}`}>
            <rect x={px(s.sign < 0 ? s.edge - 8 : s.edge)} y={7.5} width={8} height={8} className={s.fill} />
            <text
              x={px(s.sign < 0 ? s.edge - 14 : s.edge + 14)}
              y={15}
              textAnchor={s.sign < 0 ? "end" : "start"}
              fontSize={12}
              fontWeight={500}
             
              className="fill-ink-2"
            >
              {fitText(s.series?.label ?? "", half - 30, 12, HEAD_FONT)}
            </text>
          </g>
        ))}
        <text x={px(width / 2)} y={15} textAnchor="middle" fontSize={12} fontWeight={500} className="fill-ink-2">
          {sentenceCase(props.labelHeader ?? "")}
        </text>
        <line x1={0} x2={width} y1={HEADER_H - 0.5} y2={HEADER_H - 0.5} className="stroke-line" />
        {lines.map((line) => {
          if (line.kind === "group") {
            return (
              <text key={`g-${line.y}`} x={px(width / 2)} y={px(line.y + 14)} textAnchor="middle" fontSize={12} fontWeight={500} className="fill-ink-2">
                {sentenceCase(line.label)}
              </text>
            );
          }
          const { bar, y } = line;
          const mid = y + rowH / 2;
          return (
            <g key={`b-${bar.key}`} data-row={bar.key}>
              <title>{barTitle(bar, data, "butterfly", style, baseline)}</title>
              <text x={px(width / 2)} y={px(mid + 4)} textAnchor="middle" fontSize={12} className="fill-ink-2">
                {fitText(bar.label, labelW - 8, 12)}
              </text>
              {signed
                ? sides.map((s) => (
                    <line
                      key={`zero-${s.k}`}
                      x1={px(at(s, 0)) + 0.5}
                      x2={px(at(s, 0)) + 0.5}
                      y1={y}
                      y2={y + rowH}
                      className="stroke-ink-3"
                      data-zero={s.k}
                    />
                  ))
                : null}
              {sides.map((s) => {
                const cell = bar.values[s.k];
                const zero = at(s, 0);
                if (!cell || cell.value === null) {
                  return (
                    <text
                      key={s.k}
                      x={px(zero + s.sign * 4)}
                      y={px(mid + 3.5)}
                      textAnchor={s.sign < 0 ? "end" : "start"}
                      fontSize={12}
                      fontStyle="italic"
                      className="fill-ink-2"
                    >
                      {reasonLabel(cell?.reason ?? null)}
                    </text>
                  );
                }
                const end = at(s, cell.value);
                return (
                  <rect
                    key={s.k}
                    x={px(Math.min(zero, end))}
                    y={px(mid - 4.5)}
                    width={px(Math.abs(end - zero))}
                    height={9}
                    className={cell.value < 0 ? "fill-second" : s.fill}
                    data-sign={cell.value < 0 ? "negative" : "positive"}
                  />
                );
              })}
              {markBaseline
                ? sides.map((s) => (
                    <line
                      key={`base-${s.k}`}
                      x1={px(at(s, baseline)) + 0.5}
                      x2={px(at(s, baseline)) + 0.5}
                      y1={y + 1}
                      y2={y + rowH - 1}
                      strokeDasharray="2 2"
                      className="stroke-ink-3"
                    />
                  ))
                : null}
              {sides.map((s) => {
                const cell = bar.values[s.k];
                if (!cell || cell.value === null) return null;
                const end = at(s, cell.value);
                // Above zero the value sits past the bar's outer end; below zero, past its inner end.
                const outward = cell.value >= 0;
                const dir = outward ? s.sign : -s.sign;
                // A paper halo keeps the value legible where it crosses a dashed baseline.
                return (
                  <text
                    key={`v-${s.k}`}
                    x={px(end + dir * 4)}
                    y={px(mid + 3.5)}
                    textAnchor={dir < 0 ? "end" : "start"}
                    fontSize={12}
                    strokeWidth={3}
                    paintOrder="stroke"
                    className={`stroke-surface font-mono tabular-nums ${outward ? "fill-ink-2" : "fill-second"}`}
                  >
                    {formatNumber(cell.value, data.unit, style)}
                  </text>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Text ----------------------------------------------------------------------------------------------

function describe(data: BarsPayload, display: BarsDisplay, baseline: number, signed = false): string {
  const n = data.groups.reduce((s, g) => s + g.bars.length, 0);
  const names = data.series.map((s) => s.label).join(" and ");
  const what = data.valueLabel.toLowerCase();
  switch (display) {
    case "split":
      return `${n} rows of ${what} for ${names}; each bar is the first share's lead over an even split of ${baseline} within the pair. The table view lists every value.`;
    case "dumbbell":
      return `${n} rows of ${what} for ${names} against the ${baseline} baseline. The table view lists every value.`;
    case "butterfly":
      return `${n} rows of ${what}, ${names} mirrored${signed ? "; bars point outward above zero and toward the centre below it" : ""}. The table view lists every value.`;
    default:
      return `${n} bars of ${what}, ${comparatorHead(data.comparator)}. The table view lists every value.`;
  }
}

function barTitle(bar: Bar, data: BarsPayload, display: BarsDisplay, style: NumberStyle, baseline: number): string {
  const parts = bar.values.map((c, k) => {
    const name = data.series[k]?.label ?? "";
    const t = cellText(c, data.unit, display === "diverging" ? { signed: true, ...style } : style);
    return `${name} ${t.kind === "value" ? t.text : t.reason}`;
  });
  const splitBy = display === "split" ? splitLead(bar, baseline) : null;
  const lead = splitBy === null ? "" : `; lead ${formatNumber(splitBy, data.unit, { ...style, signed: true })}`;
  return `${bar.label}: ${parts.join(", ")}${lead}${bar.isNew ? " (new)" : ""}`;
}

/** The table view: one row per bar with every series value or its reason, plus lead, delta and ranks. */
export function barsTableSpec(
  data: BarsPayload,
  caption: string,
  display: BarsDisplay,
  style: NumberStyle,
  opts: Pick<DivergingBarsOptions, "labelHeader" | "baseline" | "deltaColumn" | "deltaHeader"> = {},
) {
  const baseline = baselineFor(display, data, opts.baseline);
  const bars = data.groups.flatMap((g) => g.bars);
  const withRanks = bars.some((b) => b.ranks !== null);
  const withNew = bars.some((b) => b.isNew);
  const two = data.series.length === 2;
  const valueStyle = display === "diverging" ? { signed: true, ...style } : style;
  const columns: TableColumn[] = [
    { label: opts.labelHeader || "Item" },
    ...data.series.map((s) => ({
      label: display === "diverging" ? `${s.label} (${comparatorHead(data.comparator)})` : s.label,
      numeric: true,
    })),
    ...(display === "split" ? [{ label: `Lead over ${formatNumber(baseline, data.unit, { digits: 2 })}`, numeric: true }] : []),
    ...(two && display !== "split" ? [{ label: opts.deltaHeader ?? `Gap vs ${data.series[1]!.label}`, numeric: true }] : []),
    ...(withRanks ? [{ label: "Rank here", numeric: true }, { label: `Rank in ${COMPARATOR_NOUN[data.comparator]}`, numeric: true }] : []),
    ...(withNew ? [{ label: "New" }] : []),
  ];
  const rows: TableRow[] = [];
  for (const group of data.groups) {
    if (data.groups.length > 1) rows.push({ key: `section-${group.key}`, section: group.label });
    for (const bar of group.bars) {
      const v0 = bar.values[0]?.value ?? null;
      const v1 = bar.values[1]?.value ?? null;
      const cells: TableCell[] = [bar.label, ...bar.values.map((c) => cellText(c, data.unit, valueStyle))];
      if (display === "split") {
        const lead = splitLead(bar, baseline);
        cells.push(
          lead === null
            ? { kind: "missing", reason: reasonLabel(missingReason(bar)) }
            : { kind: "value", text: formatNumber(lead, data.unit, { ...style, signed: true }) },
        );
      }
      if (two && display !== "split") {
        cells.push(
          v0 === null || v1 === null
            ? { kind: "missing", reason: reasonLabel((v0 === null ? bar.values[0] : bar.values[1])?.reason ?? null) }
            : { kind: "value", text: formatNumber(v0 - v1, data.unit, { ...style, signed: true }) },
        );
      }
      if (withRanks) {
        cells.push(bar.ranks?.subject == null ? "—" : String(bar.ranks.subject));
        cells.push(bar.ranks?.comparator == null ? "—" : String(bar.ranks.comparator));
      }
      if (withNew) cells.push(bar.isNew ? "new" : "");
      rows.push({ key: `${group.key}-${bar.key}`, cells });
    }
  }
  return { caption, columns, rows };
}
