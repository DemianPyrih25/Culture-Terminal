import type { MetricUnit, RankedPayload, RankedRow, RowFlag, SlatePayload } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableColumn, type TableRow } from "./figure-table";
import { COMPARATOR_PHRASE, cellText, formatNumber, formatTick, reasonLabel, type NumberStyle } from "./format";
import { clamp, fitText, linear, niceDomain, px, textWidth, ticksBetween } from "./scale";

/**
 * RankedTable (kinds Ranked and Slate). Four variants share one payload:
 * - lollipop (A05 figure 1): rank, name, a dot on a guide line, the value; the target highlighted,
 *   comparison rows in data-2 grey, an optional "TOP FIVE ABOVE" divider and axis ticks;
 * - table (A07 figure 1): # · category · best fit · value with a bar and a reference tick · flag;
 * - lists (A08 figure 2): one short ranked list per group, side by side;
 * - bars (A08 figure 3, margin): name and category, a bar from 0 with a baseline tick, the value.
 * Negative values draw left of zero in the negative colour, never as an empty track. The payload's
 * fixed caption prints under the plot.
 */

export type RankedVariant = "lollipop" | "table" | "lists" | "bars";

export interface RankedTableOptions {
  variant?: RankedVariant;
  /** Layout width in px for the SVG variants (lollipop, bars). Default 680 (lollipop) or 300 (bars). */
  width?: number;
  /** The column to plot; default the first. */
  columnKey?: string;
  /** Rows drawn bold in ink. Default: rows flagged TARGET, else the top row. */
  highlightKeys?: readonly string[];
  /** Rows drawn in data-2 grey, e.g. the rivals the priors expected. */
  comparisonKeys?: readonly string[];
  /** A divider under the row ranked `after`, e.g. { after: 5, label: "TOP FIVE ABOVE" }. */
  cut?: { after: number; label: string } | null;
  /** Value axis domain. Default 0 to a nice maximum (0–1 for 0–1 units in the table variant). */
  domain?: { min: number; max: number };
  /**
   * table: the reference tick on each bar (values below it draw grey). bars: the baseline mark;
   * default 1 for a lift or ratio whose values are all positive, otherwise none.
   */
  tick?: number | null;
  /** Column heads of the table variant. */
  labelHeader?: string;
  sublabelHeader?: string;
  /** Footnote numbers printed after a flag word, e.g. { UTR: 5 }. */
  flagNotes?: Partial<Record<RowFlag, number>>;
  numberStyle?: NumberStyle;
}

export type RankedTableProps = FigureMeta & RankedTableOptions & { data: RankedPayload };

/** Flag words in the FLAG column. TARGET is shown by the highlight, not as a word. */
export const FLAG_LABEL: Readonly<Record<RowFlag, string>> = {
  UTR: "UNDER THE RADAR",
  NEW: "NEW",
  LOCAL: "LOCAL",
  TARGET: "TARGET",
  GHOST_PICK: "LLM PICK",
};

const UNIT_INTERVAL: ReadonlySet<MetricUnit> = new Set(["similarity", "pct", "popularity", "affinity"]);
/** Units whose bars mark 1 by default, when every value is positive. */
const BASELINE_ONE: ReadonlySet<MetricUnit> = new Set(["lift", "ratio"]);

export function RankedTable(props: RankedTableProps) {
  const variant = props.variant ?? "lollipop";
  const label = figureLabel(props);
  const style: NumberStyle = {
    leadingZero: variant === "table" ? undefined : false,
    ...props.numberStyle,
  };
  const plot =
    variant === "table" ? (
      <SlateStyleTable {...props} style={style} />
    ) : variant === "lists" ? (
      <RankedLists {...props} style={style} />
    ) : variant === "bars" ? (
      <RankedBars {...props} label={label} style={style} />
    ) : (
      <Lollipop {...props} label={label} style={style} />
    );
  // The caption names the grey rows ("Grey: rivals we expected"), as in A05; the table marks them.
  // The table and lists variants are HTML tables already, so their table view waits for the toggle.
  return (
    <FigureFrame
      meta={props}
      plot={plot}
      table={<FigureTable spec={rankedTableSpec(props.data, label, style, props)} />}
      fixedCaption={props.data.caption}
      htmlPlot={variant === "table" || variant === "lists"}
    />
  );
}

/**
 * A Slate (sponsor slate) as a ranked table: one row per category with its best fit, ranked by fit;
 * a category without a best fit keeps its reason and sorts last.
 */
export function slateToRanked(slate: SlatePayload): RankedPayload {
  const rows = slate.rows
    .map((row, index) => ({ row, index, fit: row.best?.fit.value ?? null }))
    .sort((a, b) => {
      if (a.fit === null || b.fit === null) return a.fit === null ? (b.fit === null ? a.index - b.index : 1) : -1;
      return b.fit - a.fit || a.index - b.index;
    });
  let rank = 0;
  return {
    columns: [{ key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" }],
    groups: [
      {
        key: "slate",
        label: slate.seed.label,
        rows: rows.map(({ row, fit }) => ({
          key: row.category,
          rank: fit === null ? null : (rank += 1),
          label: row.best?.label ?? "No fit found",
          sublabel: row.label,
          ref: row.best?.ref ?? null,
          tagRef: null,
          type: "brand",
          cells: [row.best ? row.best.fit : { value: null, reason: row.reason ?? "not_measured" }],
          flags: row.best?.utr ? ["UTR"] : [],
          explain: [],
        })),
      },
    ],
    caption: slate.caption,
  };
}

function pickColumn(data: RankedPayload, key?: string) {
  const index = Math.max(0, key ? data.columns.findIndex((c) => c.key === key) : 0);
  return data.columns[index] ? { ...data.columns[index], index } : null;
}

function highlightSet(data: RankedPayload, keys?: readonly string[]): Set<string> {
  if (keys) return new Set(keys);
  const rows = data.groups.flatMap((g) => g.rows);
  const targets = rows.filter((r) => r.flags.includes("TARGET")).map((r) => r.key);
  if (targets.length > 0) return new Set(targets);
  const top = rows.find((r) => r.rank === 1) ?? rows[0];
  return new Set(top ? [top.key] : []);
}

/** The value axis: from 0 (or below) to a nice maximum in steps of about a quarter, e.g. 0–0.6 by 0.2. */
function valueDomain(values: readonly number[], unit: MetricUnit, fixed?: { min: number; max: number }, unitInterval = false) {
  if (fixed) return { ...fixed, step: niceDomain(fixed.min, fixed.max, 4).step };
  if (unitInterval && UNIT_INTERVAL.has(unit) && values.every((v) => v >= 0 && v <= 1)) return { min: 0, max: 1, step: 0.25 };
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  return niceDomain(lo, hi === lo ? lo + 1 : hi, 4);
}

// Lollipop (A05 figure 1) ---------------------------------------------------------------------------

const RANK_W = 12;
const GAP = 8;
const ROW_H = 17;
const CUT_H = 11;
const GROUP_H = 18;
const AXIS_H = 16;

type Line =
  | { kind: "row"; row: RankedRow; y: number }
  | { kind: "cut"; label: string; y: number }
  | { kind: "group"; label: string; y: number };

function Lollipop(props: RankedTableProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const width = props.width ?? 680;
  const column = pickColumn(data, props.columnKey);
  const ci = column?.index ?? 0;
  const unit = column?.unit ?? "score";
  const highlight = highlightSet(data, props.highlightKeys);
  const comparison = new Set(props.comparisonKeys ?? []);
  const rows = data.groups.flatMap((g) => g.rows);
  const values = rows.flatMap((r) => (r.cells[ci]?.value == null ? [] : [r.cells[ci]!.value!]));
  const domain = valueDomain(values, unit, props.domain);
  const longest = Math.max(0, ...rows.map((r) => textWidth(r.label, 12, { weight: 600 })));
  const labelW = clamp(Math.ceil(longest) + 4, 96, width >= 560 ? 200 : 120);
  const valueW = Math.max(28, Math.ceil(Math.max(0, ...values.map((v) => textWidth(formatNumber(v, unit, style), 12, { weight: 600 })))) + 2);
  const trackX = RANK_W + GAP + labelW + GAP;
  const trackW = Math.max(40, width - trackX - GAP - valueW);
  const x = linear([domain.min, domain.max], [trackX, trackX + trackW - 1]);
  const ticks = ticksBetween(domain.min, domain.max, domain.step);

  const lines: Line[] = [];
  let y = 0;
  data.groups.forEach((group) => {
    if (data.groups.length > 1) {
      lines.push({ kind: "group", label: group.label, y });
      y += GROUP_H;
    }
    group.rows.forEach((row) => {
      lines.push({ kind: "row", row, y });
      y += ROW_H;
      if (props.cut && row.rank === props.cut.after) {
        lines.push({ kind: "cut", label: props.cut.label, y });
        y += CUT_H;
      }
    });
  });
  const plotH = y;
  const height = plotH + AXIS_H;

  return (
    <div className="pt-1 pb-1.5">
      <svg
        viewBox={`0 0 ${width} ${px(height)}`}
        width="100%"
        role="img"
        aria-label={props.label}
        className="block h-auto font-ui"
        style={{ maxWidth: width }}
      >
        <title>{props.label}</title>
        <desc>{`${rows.length} rows ranked by ${(column?.label ?? "value").toLowerCase()}. The table view lists every value.`}</desc>
        {ticks.map((t) => (
          <line key={`grid-${t}`} x1={px(x(t)) + 0.5} x2={px(x(t)) + 0.5} y1={0} y2={px(plotH)} className="stroke-line" />
        ))}
        {lines.map((line) => {
          if (line.kind === "group") {
            return (
              <text key={`g-${line.y}`} x={0} y={px(line.y + 13)} fontSize={9.5} fontWeight={600} letterSpacing={1} className="fill-dim">
                {line.label.toUpperCase()}
              </text>
            );
          }
          if (line.kind === "cut") {
            return (
              <g key={`cut-${line.y}`}>
                <text x={RANK_W + GAP} y={px(line.y + 8.5)} fontSize={8.5} fontWeight={600} letterSpacing={0.9} className="fill-dim">
                  {line.label.toUpperCase()}
                </text>
                <line x1={trackX} x2={trackX + trackW} y1={px(line.y + 5.5)} y2={px(line.y + 5.5)} className="stroke-faint" />
              </g>
            );
          }
          const { row } = line;
          const cell = row.cells[ci];
          const strong = highlight.has(row.key);
          const grey = !strong && comparison.has(row.key);
          const cy = px(line.y + 8.5);
          const labelClass = strong ? "fill-ink" : grey ? "fill-dim" : "fill-ink";
          const text = cell?.value == null ? null : formatNumber(cell.value, unit, style);
          return (
            <g key={`r-${row.key}`} data-row={row.key} data-tone={strong ? "highlight" : grey ? "comparison" : "default"}>
              <title>{`${row.label}: ${text ?? reasonLabel(cell?.reason ?? null)}`}</title>
              <text x={0} y={px(line.y + 12.5)} fontSize={10} className="fill-dim font-mono">
                {row.rank ?? ""}
              </text>
              <text x={RANK_W + GAP} y={px(line.y + 12.5)} fontSize={12} fontWeight={strong ? 600 : 400} className={labelClass}>
                {fitText(row.label, labelW, 12, { weight: strong ? 600 : 400 })}
              </text>
              {cell?.value == null ? (
                <text x={trackX + 4} y={px(line.y + 12)} fontSize={10} fontStyle="italic" className="fill-dim">
                  {reasonLabel(cell?.reason ?? null)}
                </text>
              ) : (
                <>
                  <line
                    x1={px(x(Math.max(domain.min, Math.min(0, domain.max))))}
                    x2={px(x(cell.value))}
                    y1={cy}
                    y2={cy}
                    strokeOpacity={grey ? 1 : 0.35}
                    className={grey ? "stroke-line-strong" : "stroke-data"}
                  />
                  <circle cx={px(x(cell.value))} cy={cy} r={4} className={grey ? "fill-data-2" : "fill-data"} />
                </>
              )}
              <text
                x={width}
                y={px(line.y + 12.5)}
                textAnchor="end"
                fontSize={12}
                fontWeight={strong ? 600 : 400}
                className={`tabular-nums ${text === null ? "fill-dim" : grey ? "fill-dim" : "fill-ink"}`}
              >
                {text ?? "—"}
              </text>
            </g>
          );
        })}
        {ticks.map((t, i) => (
          <text
            key={`tick-${t}`}
            x={i === 0 ? px(x(t)) : i === ticks.length - 1 ? px(x(t)) + 1 : px(x(t)) + 0.5}
            y={px(plotH + 12)}
            textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
            fontSize={10}
            className="fill-dim tabular-nums"
          >
            {formatTick(t, domain.step, unit)}
          </text>
        ))}
      </svg>
    </div>
  );
}

// Table (A07 figure 1) ------------------------------------------------------------------------------

function SlateStyleTable(props: RankedTableProps & { style: NumberStyle }) {
  const { data, style } = props;
  const column = pickColumn(data, props.columnKey);
  const ci = column?.index ?? 0;
  const unit = column?.unit ?? "score";
  const rows = data.groups.flatMap((g) => g.rows);
  const highlight = highlightSet(data, props.highlightKeys);
  const comparison = new Set(props.comparisonKeys ?? []);
  const values = rows.flatMap((r) => (r.cells[ci]?.value == null ? [] : [r.cells[ci]!.value!]));
  const domain = valueDomain(values, unit, props.domain, true);
  const bar = linear([domain.min, domain.max], [0, 120]);
  const zero = px(clamp(bar(clamp(0, domain.min, domain.max)), 0, 120));
  const withSub = rows.some((r) => r.sublabel !== null);
  const withFlags = rows.some((r) => r.flags.some((f) => f !== "TARGET"));
  const others = data.columns.map((c, i) => ({ ...c, i })).filter((c) => c.i !== ci);
  const head = "px-2 text-left font-ui text-[10px] font-semibold tracking-[1px] text-dim uppercase";
  return (
    <div className="overflow-x-auto pt-2 pb-1">
      <table className="w-full border-collapse font-ui" aria-label={figureLabel(props)}>
        <thead>
          <tr className="h-6 border-b border-line-strong">
            <th scope="col" className={`${head} w-[28px]`}>
              #
            </th>
            {withSub ? (
              <th scope="col" className={`${head} w-[140px]`}>
                {props.sublabelHeader ?? "Category"}
              </th>
            ) : null}
            <th scope="col" className={`${head} w-[200px]`}>
              {props.labelHeader ?? "Name"}
            </th>
            <th scope="col" className={`${head} w-[176px]`}>
              {column?.label ?? "Value"}
            </th>
            {others.map((c) => (
              <th key={c.key} scope="col" className={`${head} text-right`}>
                {c.label}
              </th>
            ))}
            {withFlags ? (
              <th scope="col" className={head}>
                Flag
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const strong = highlight.has(row.key);
            const cell = row.cells[ci];
            const below = cell?.value != null && props.tick != null && cell.value < props.tick;
            const grey = comparison.has(row.key) || below;
            return (
              <tr
                key={row.key}
                data-row={row.key}
                className={`h-[25.5px] border-b border-line ${strong ? "bg-canvas" : ""}`}
              >
                <td className="px-2 text-[11px] text-dim tabular-nums">{row.rank ?? "—"}</td>
                {withSub ? <td className="px-2 text-[13px] text-text-2">{row.sublabel ?? ""}</td> : null}
                <th scope="row" className={`px-2 text-left text-[13px] text-ink ${strong ? "font-semibold" : "font-medium"}`}>
                  {row.label}
                </th>
                <td className="px-2">
                  {cell?.value == null ? (
                    <span className="text-[12px] text-dim italic" data-missing="true">
                      {reasonLabel(cell?.reason ?? null)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2.5">
                      <span className="w-[34px] text-[13px] font-medium text-ink tabular-nums">
                        {formatNumber(cell.value, unit, style)}
                      </span>
                      <svg viewBox="0 0 120 9" width="120" height="9" aria-hidden="true" className="shrink-0">
                        <rect x={0} y={4} width={120} height={1} className="fill-line" />
                        <rect
                          x={Math.min(zero, px(clamp(bar(cell.value), 0, 120)))}
                          y={3}
                          width={px(Math.abs(clamp(bar(cell.value), 0, 120) - zero))}
                          height={3}
                          className={cell.value < 0 ? "fill-negative" : grey ? "fill-data-2" : "fill-data"}
                        />
                        {props.tick != null ? (
                          <rect x={px(clamp(bar(props.tick), 0, 119))} y={1} width={1} height={7} className="fill-faint" />
                        ) : null}
                      </svg>
                    </span>
                  )}
                </td>
                {others.map((c) => {
                  const t = row.cells[c.i];
                  return (
                    <td key={c.key} className="px-2 text-right text-[13px] text-text-2 tabular-nums">
                      {t?.value == null ? (
                        <span className="text-dim italic" data-missing="true">
                          {reasonLabel(t?.reason ?? null)}
                        </span>
                      ) : (
                        formatNumber(t.value, c.unit, style)
                      )}
                    </td>
                  );
                })}
                {withFlags ? (
                  <td className="px-2">
                    <span className="flex flex-wrap gap-x-2">
                      {row.flags
                        .filter((f) => f !== "TARGET")
                        .map((f) => (
                          <span key={f} className="text-[10px] font-semibold tracking-[1px] whitespace-nowrap text-accent">
                            {FLAG_LABEL[f]}
                            {props.flagNotes?.[f] ? <sup className="ml-px text-[8.5px]">{props.flagNotes[f]}</sup> : null}
                          </span>
                        ))}
                    </span>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Lists (A08 figure 2) ------------------------------------------------------------------------------

function RankedLists(props: RankedTableProps & { style: NumberStyle }) {
  const { data, style } = props;
  const column = pickColumn(data, props.columnKey);
  const ci = column?.index ?? 0;
  const unit = column?.unit ?? "score";
  // The value column fits its head ("PERCENTILE"), so the head never runs into the next list.
  const head = column?.label ?? "Value";
  const valueW = clamp(Math.ceil(textWidth(head.toUpperCase(), 10, { weight: 500, tracking: 0.8 })) + 6, 48, 96);
  return (
    <div
      className="grid items-start gap-6 pt-3.5 pb-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, data.groups.length)}, minmax(0, 1fr))` }}
    >
      {data.groups.map((group) => (
        <table key={group.key} className="w-full table-fixed border-collapse font-ui">
          <colgroup>
            <col className="w-5" />
            <col />
            <col style={{ width: valueW }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line-strong">
              <th scope="col" colSpan={2} className="pb-1.5 text-left text-[10px] font-medium tracking-[0.8px] text-dim uppercase">
                {group.label}
              </th>
              <th scope="col" className="pb-1.5 text-right text-[10px] font-medium tracking-[0.8px] text-dim uppercase">
                {head}
              </th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row, i) => {
              const cell = row.cells[ci];
              const first = i === 0;
              const value = cell?.value ?? null;
              const missing = value === null;
              return (
                <tr key={row.key} data-row={row.key} className="h-[24.5px] border-b border-line">
                  <td className="text-[11px] text-dim tabular-nums">{row.rank ?? ""}</td>
                  <th
                    scope="row"
                    className={`truncate text-left text-[13px] ${first ? "font-medium text-ink" : "font-normal text-text-2"}`}
                    title={row.label}
                  >
                    {row.label}
                    {missing ? (
                      <span className="pl-1.5 text-[11px] font-normal text-dim italic" data-missing="true">
                        {reasonLabel(cell?.reason ?? null)}
                      </span>
                    ) : null}
                  </th>
                  <td className={`text-right text-[13px] font-medium tabular-nums ${missing ? "text-dim" : "text-ink"}`}>
                    {missing ? "—" : formatNumber(value, unit, style)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
    </div>
  );
}

// Bars (A08 figure 3, margin) -----------------------------------------------------------------------

const BAR_ROW_H = 18;

function RankedBars(props: RankedTableProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const width = props.width ?? 300;
  const column = pickColumn(data, props.columnKey);
  const ci = column?.index ?? 0;
  const unit = column?.unit ?? "score";
  const rows = data.groups.flatMap((g) => g.rows);
  const highlight = highlightSet(data, props.highlightKeys);
  const values = rows.flatMap((r) => (r.cells[ci]?.value == null ? [] : [r.cells[ci]!.value!]));
  const domain = valueDomain(values, unit, props.domain);
  const baseline =
    props.tick !== undefined
      ? props.tick
      : BASELINE_ONE.has(unit) && values.length > 0 && values.every((v) => v > 0)
        ? 1
        : null;
  const labelW = Math.round(width * 0.45);
  const valueW = 24;
  const trackX = labelW + 8;
  const trackW = Math.max(30, width - trackX - 8 - valueW);
  const x = linear([domain.min, domain.max], [trackX, trackX + trackW]);
  const zero = px(x(clamp(0, domain.min, domain.max)));
  const height = rows.length * BAR_ROW_H;
  return (
    <div className="pt-1.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={props.label}
        className="block h-auto font-ui"
        style={{ maxWidth: width }}
      >
        <title>{props.label}</title>
        <desc>{`${rows.length} bars of ${(column?.label ?? "value").toLowerCase()}${baseline !== null ? `; the paper tick marks ${formatNumber(baseline, unit, { digits: 2 })}` : ""}.`}</desc>
        {rows.map((row, i) => {
          const y = i * BAR_ROW_H;
          const strong = highlight.has(row.key);
          const cell = row.cells[ci];
          const name = fitText(row.label, labelW, 12, { weight: strong ? 500 : 400 });
          const nameW = textWidth(name, 12, { weight: strong ? 500 : 400 });
          const sub = row.sublabel ? fitText(row.sublabel, Math.max(0, labelW - nameW - 6), 11) : "";
          const text = cell?.value == null ? null : formatNumber(cell.value, unit, style);
          return (
            <g key={row.key} data-row={row.key}>
              <title>{`${row.label}: ${text ?? reasonLabel(cell?.reason ?? null)}`}</title>
              <text x={0} y={y + 13} fontSize={12} fontWeight={strong ? 500 : 400} className={strong ? "fill-ink" : "fill-text-2"}>
                {name}
              </text>
              {sub && sub !== "…" ? (
                <text x={px(nameW + 6)} y={y + 13} fontSize={11} className="fill-dim">
                  {sub}
                </text>
              ) : null}
              {cell?.value == null ? (
                <text x={trackX + 2} y={y + 12.5} fontSize={10} fontStyle="italic" className="fill-dim">
                  {reasonLabel(cell?.reason ?? null)}
                </text>
              ) : (
                <rect
                  x={Math.min(zero, px(x(cell.value)))}
                  y={y + 6}
                  width={px(Math.abs(x(cell.value) - zero))}
                  height={6}
                  className={cell.value < 0 ? "fill-negative" : "fill-data"}
                  data-sign={cell.value < 0 ? "negative" : "positive"}
                />
              )}
              {domain.min < 0 ? <rect x={zero} y={y + 3} width={1} height={12} className="fill-faint" /> : null}
              {baseline !== null && baseline > domain.min && baseline < domain.max ? (
                <rect x={px(x(baseline))} y={y + 2} width={1} height={14} className="fill-paper" />
              ) : null}
              <text
                x={width}
                y={y + 13}
                textAnchor="end"
                fontSize={12}
                fontWeight={500}
                className={`tabular-nums ${text === null ? "fill-dim" : "fill-ink"}`}
              >
                {text ?? "—"}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Table view ----------------------------------------------------------------------------------------

/** Every row with its rank, labels, every column's value or reason, and its flags (grey rows read "expected"). */
export function rankedTableSpec(
  data: RankedPayload,
  caption: string,
  style: NumberStyle,
  opts: Pick<RankedTableOptions, "labelHeader" | "sublabelHeader" | "comparisonKeys"> = {},
) {
  const expected = new Set(opts.comparisonKeys ?? []);
  const flagsOf = (row: RankedRow) => [...(expected.has(row.key) ? ["expected"] : []), ...row.flags.map((f) => FLAG_LABEL[f])];
  const withSub = data.groups.some((g) => g.rows.some((r) => r.sublabel !== null));
  const withFlags = data.groups.some((g) => g.rows.some((r) => flagsOf(r).length > 0));
  const columns: TableColumn[] = [
    { label: opts.labelHeader ?? "Name" },
    { label: "Rank", numeric: true },
    ...(withSub ? [{ label: opts.sublabelHeader ?? "Category" }] : []),
    ...data.columns.map((c) => ({ label: c.comparator ? `${c.label} (${COMPARATOR_PHRASE[c.comparator]})` : c.label, numeric: true })),
    ...(withFlags ? [{ label: "Flags" }] : []),
  ];
  const rows: TableRow[] = [];
  for (const group of data.groups) {
    if (data.groups.length > 1) rows.push({ key: `section-${group.key}`, section: group.label });
    for (const row of group.rows) {
      rows.push({
        key: `${group.key}-${row.key}`,
        cells: [
          row.label,
          row.rank === null ? "—" : String(row.rank),
          ...(withSub ? [row.sublabel ?? ""] : []),
          ...row.cells.map((c, i) => cellText(c, data.columns[i]?.unit ?? "score", style)),
          ...(withFlags ? [flagsOf(row).join(", ")] : []),
        ],
      });
    }
  }
  return { caption, columns, rows };
}
