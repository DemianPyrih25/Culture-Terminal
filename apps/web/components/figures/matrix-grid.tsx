import type { MatrixCell, MatrixPayload, MetricUnit } from "@ct/contracts";
import { CANDIDATE_SOURCE_LABEL } from "@ct/contracts/values";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableRow } from "./figure-table";
import { axisCodes, cellText, formatNumber, reasonLabel, sentenceCase, type NumberStyle } from "./format";
import { clamp, fitText, hatchPath, px, stepDigits, textWidth } from "./scale";

/**
 * MatrixGrid (kind Matrix: SUBS similarity and SHARE grids; A05 figure 2). A pairwise heatmap on a
 * paper-to-data ramp with value labels, abbreviated row and column codes with a key, the target row
 * outlined, a dash on the diagonal and hatched cells where a pair was not measured. Options add a
 * rank-in-row glyph and the hub margin. Annotations are numbered where they point: beside a column
 * head, beside a row head or in a cell's corner; a note whose keys do not resolve is dropped.
 */

export interface MatrixGridOptions {
  /** Layout width in px; the SVG scales with its viewBox. Default: the grid's natural width (39 px cells). */
  width?: number;
  /** Print the value in each cell. Default true. */
  showValues?: boolean;
  /** "rank" adds each cell's rank within its row (1 = top). Default "none". */
  glyph?: "none" | "rank";
  /** Codes per axis key, overriding the payload's AxisItem.code and the generated ones. */
  codes?: Readonly<Record<string, string>>;
  /** Row heads as codes (similarity default) or full labels (share default). */
  rowLabels?: "code" | "label";
  /** The code key under the grid. Default true. */
  showKey?: boolean;
  /** The per-column margin (hub score) under the grid. Default true when the payload has one. */
  showMargin?: boolean;
  /** Colour domain. Default 0–1 for 0–1 units, otherwise the data range. */
  domain?: { min: number; max: number };
  numberStyle?: NumberStyle;
}

export type MatrixGridProps = FigureMeta & MatrixGridOptions & { data: MatrixPayload };

const CELL_H = 20;
const GAP = 1;
const HEAD_H = 16;
const GROUP_H = 16;
const SECTION_H = 20;
const CODE_W = 32;
const MARGIN_H = 26;
const RAMP_H = 16;
const CODE_FONT = { weight: 600 } as const;
/** Labels outside the cells: 12 px (the design's 12/16 chart labels). Cell values stay 11 to fit a 20 px cell. */
const FONT = 12;
/** Room for an annotation mark at the end of the row-head column. */
const ROW_NOTE_W = 11;
/**
 * Ink share from which a value prints white: where white and text-2 have equal contrast on the
 * data ramp (about 3.2:1 each), so mid-ramp labels keep the better of the two.
 */
const WHITE_TEXT_FROM = 0.57;

/** Units whose values live on 0–1, so the ramp can use the value itself as the ink share. */
const UNIT_SCALE_UNITS: ReadonlySet<MetricUnit> = new Set(["similarity", "pct", "popularity", "affinity"]);

export function MatrixGrid(props: MatrixGridProps) {
  const { data } = props;
  const label = figureLabel(props);
  const style: NumberStyle = { leadingZero: false, ...props.numberStyle };
  return (
    <FigureFrame
      meta={props}
      plot={<MatrixPlot {...props} label={label} style={style} />}
      table={<FigureTable spec={matrixTableSpec(data, label, style, props.glyph === "rank")} />}
    />
  );
}

/**
 * Short codes for the axes, unique across rows and columns: the caller's `codes` first, then each
 * item's own AxisItem.code, then codes derived from the labels.
 */
export function matrixCodes(data: MatrixPayload, codes?: Readonly<Record<string, string>>): Map<string, string> {
  const items = [...data.cols, ...data.rows.filter((r) => !data.cols.some((c) => c.key === r.key))];
  const own = Object.fromEntries(items.flatMap((i) => (i.code ? [[i.key, i.code]] : [])));
  return axisCodes(items, { ...own, ...codes });
}

/** The 0–1 ink share of the data colour for a value, and the matching domain for the legend. */
export function matrixRamp(
  data: MatrixPayload,
  domain?: { min: number; max: number },
): { alpha: (v: number) => number; min: number; max: number } {
  const values = data.cells.flatMap((r) => r.flatMap((c) => (c.value === null ? [] : [c.value])));
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 1;
  if (!domain && UNIT_SCALE_UNITS.has(data.unit) && lo >= 0 && hi <= 1) {
    // The value is the ink share: 0.81 prints at 81% of the data colour over paper.
    const round = (v: number) => Math.round(v * 10) / 10;
    const min = round(lo);
    const max = Math.max(round(hi), min + 0.1);
    return { alpha: (v) => clamp(v, 0.04, 0.95), min, max };
  }
  const min = domain?.min ?? lo;
  const max = domain?.max ?? hi;
  const span = max - min;
  return { alpha: (v) => (span === 0 ? 0.5 : 0.12 + 0.76 * clamp((v - min) / span, 0, 1)), min, max };
}

function MatrixPlot(props: MatrixGridProps & { label: string; style: NumberStyle }) {
  const { data, style } = props;
  const showValues = props.showValues ?? true;
  const rankGlyph = props.glyph === "rank";
  const codes = matrixCodes(data, props.codes);
  const rowMode = props.rowLabels ?? (data.mode === "similarity" ? "code" : "label");
  const annotations = resolveAnnotations(data);
  const rowNoteW = annotations.some((a) => a.kind === "row") ? ROW_NOTE_W : 0;
  const labelW =
    (rowMode === "code"
      ? CODE_W
      : clamp(Math.max(...data.rows.map((r) => textWidth(r.label, FONT))) + 10, 48, 160)) + rowNoteW;
  const nCols = Math.max(1, data.cols.length);
  const cellW = props.width ? clamp(Math.floor((props.width - labelW) / nCols) - GAP, 22, 72) : 39;
  const gridW = nCols * (cellW + GAP);
  const width = Math.max(props.width ?? 0, labelW + gridW);
  const cellX = (j: number) => labelW + GAP + j * (cellW + GAP);
  const ramp = matrixRamp(data, props.domain);
  const targetRow = data.rows.findIndex((r) => r.key === data.targetKey);
  const targetCol = data.cols.findIndex((c) => c.key === data.targetKey);

  const colGroups = groupRuns(data.cols.map((c) => c.group));
  const top = colGroups.some((g) => g.group !== null) ? GROUP_H : 0;

  // Row positions, with a section line before each new row group.
  let y = top + HEAD_H + GAP;
  const sections: { label: string; y: number }[] = [];
  const rowY: number[] = [];
  data.rows.forEach((row, i) => {
    if (row.group !== null && row.group !== (data.rows[i - 1]?.group ?? null)) {
      sections.push({ label: row.group, y });
      y += SECTION_H;
    }
    rowY.push(y);
    y += CELL_H + GAP;
  });
  const showMargin = (props.showMargin ?? true) && data.margin !== null;
  const marginY = y + 3;
  if (showMargin) y = marginY + MARGIN_H;
  const rampY = y + 6;
  const hasMissing = data.cells.some((r) => r.some((c) => c.value === null && c.reason !== "self"));
  const height = rampY + RAMP_H;

  const rowName = (i: number) => data.rows[i]?.label ?? "";
  const colName = (j: number) => data.cols[j]?.label ?? "";
  const keyItems = [...codes].filter(([key, code]) => {
    const item = data.cols.find((c) => c.key === key) ?? data.rows.find((r) => r.key === key);
    return item !== undefined && item.label !== code && (rowMode === "code" || data.cols.some((c) => c.key === key));
  });

  return (
    <div className="flex flex-col gap-2 pt-1 pb-1.5">
      <svg
        viewBox={`0 0 ${px(width)} ${px(height)}`}
        width={px(width)}
        role="img"
        aria-label={props.label}
        className="block h-auto max-w-none overflow-visible font-sans"
      >
        <title>{props.label}</title>
        <desc>
          {`${data.rows.length} by ${data.cols.length} grid of ${data.valueLabel.toLowerCase()}`}
          {targetRow >= 0 ? `; the ${rowName(targetRow)} row is outlined` : ""}
          {hasMissing ? "; hatched cells were not measured" : ""}. The table view lists every value.
        </desc>

        {colGroups
          .filter((g) => g.group !== null)
          .map((g) => (
            <text
              key={`g-${g.start}`}
              x={px(cellX(g.start))}
              y={12}
              fontSize={FONT}
              fontWeight={500}
              className="fill-ink-2"
            >
              {fitText(sentenceCase(g.group!), g.length * (cellW + GAP) - 4, FONT, { weight: 500 })}
            </text>
          ))}

        {data.cols.map((c, j) => {
          const target = j === targetCol;
          const note = annotations.find((a) => a.kind === "col" && a.colKey === c.key);
          const code = codes.get(c.key) ?? c.label;
          return (
            <g key={`c-${c.key}`}>
              <text
                x={px(cellX(j) + cellW / 2)}
                y={top + 11.5}
                textAnchor="middle"
                fontSize={11}
                fontWeight={target ? 700 : 600}
                className={target ? "fill-ink" : "fill-ink-2"}
              >
                <title>{c.label}</title>
                {fitText(code, cellW + 2, 11, CODE_FONT)}
              </text>
              {note ? (
                <AnnotationMark n={note.n} x={cellX(j) + cellW / 2 + textWidth(code, 11, CODE_FONT) / 2 + 5} y={top + 5} />
              ) : null}
            </g>
          );
        })}

        {sections.map((s) => (
          <text key={`s-${s.y}`} x={0} y={px(s.y + 14)} fontSize={FONT} fontWeight={500} className="fill-ink-2">
            {fitText(sentenceCase(s.label), width, FONT, { weight: 500 })}
          </text>
        ))}

        {data.rows.map((row, i) => {
          const ry = rowY[i]!;
          const target = i === targetRow;
          const head =
            rowMode === "code"
              ? fitText(codes.get(row.key) ?? row.label, labelW - rowNoteW - 2, 11, CODE_FONT)
              : fitText(row.label, labelW - rowNoteW - 8, FONT);
          const note = annotations.find((a) => a.kind === "row" && a.rowKey === row.key);
          return (
            <g key={`r-${row.key}`}>
              <text
                x={0}
                y={px(ry + 13.5)}
                fontSize={rowMode === "code" ? 11 : FONT}
                fontWeight={rowMode === "code" ? (target ? 700 : 600) : target ? 600 : 400}
                className={target ? "fill-ink" : "fill-ink-2"}
              >
                <title>{row.label}</title>
                {head}
              </text>
              {note ? <AnnotationMark n={note.n} x={labelW - ROW_NOTE_W / 2} y={ry + CELL_H / 2} /> : null}
              {(data.cells[i] ?? []).map((cell, j) => (
                <Cell
                  key={`${row.key}-${data.cols[j]?.key ?? j}`}
                  cell={cell}
                  x={cellX(j)}
                  y={ry}
                  w={cellW}
                  alpha={ramp.alpha}
                  unit={data.unit}
                  style={style}
                  showValue={showValues}
                  rankGlyph={rankGlyph}
                  bold={target}
                  title={`${row.label} × ${colName(j)}`}
                />
              ))}
            </g>
          );
        })}

        {targetRow >= 0 ? (
          <rect
            x={px(cellX(0) - 0.75)}
            y={px(rowY[targetRow]! - 0.75)}
            width={px(gridW - GAP + 1.5)}
            height={CELL_H + 1.5}
            strokeWidth={1.5}
            className="fill-none stroke-ink"
            data-target="row"
          />
        ) : targetCol >= 0 && rowY.length > 0 ? (
          // A share grid has the subject as a column: outline the column instead.
          <rect
            x={px(cellX(targetCol) - 0.75)}
            y={px(rowY[0]! - 0.75)}
            width={px(cellW + 1.5)}
            height={px(rowY[rowY.length - 1]! + CELL_H - rowY[0]! + 1.5)}
            strokeWidth={1.5}
            className="fill-none stroke-ink"
            data-target="column"
          />
        ) : null}

        {annotations
          .filter((a) => a.kind === "cell")
          .map((a) => {
            const i = data.rows.findIndex((r) => r.key === a.rowKey);
            const j = data.cols.findIndex((c) => c.key === a.colKey);
            // The mark takes the corner the rank glyph does not use.
            const markX = rankGlyph ? cellX(j) + 1 : cellX(j) + cellW - 1;
            return (
              <g key={`a-${a.n}`}>
                <rect
                  x={px(cellX(j) + 0.75)}
                  y={px(rowY[i]! + 0.75)}
                  width={px(cellW - 1.5)}
                  height={CELL_H - 1.5}
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  className="fill-none stroke-accent"
                />
                <AnnotationMark n={a.n} x={markX} y={rowY[i]! + 1} />
              </g>
            );
          })}

        {showMargin && data.margin ? (
          <MarginRow
            margin={data.margin}
            y={marginY}
            labelW={labelW}
            cellW={cellW}
            cellX={cellX}
            unit={data.unit}
            style={style}
            colNames={data.cols.map((c) => c.label)}
          />
        ) : null}

        <RampLegend
          x={labelW + GAP}
          y={rampY}
          min={ramp.min}
          max={ramp.max}
          alpha={ramp.alpha}
          unit={data.unit}
          hatch={hasMissing}
        />
      </svg>

      {annotations.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0 type-caption text-accent-ink">
          {annotations.map((a) => (
            <li key={a.n} className="flex gap-1.5">
              <span className="font-semibold">{a.kind === "note" ? "·" : a.n}</span>
              <span>{a.text}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {(props.showKey ?? true) && keyItems.length > 0 ? (
        <p className="m-0 type-caption text-ink-2">
          {keyItems.map(([key, code], n) => {
            const item = data.cols.find((c) => c.key === key) ?? data.rows.find((r) => r.key === key);
            return (
              <span key={key}>
                {n > 0 ? " · " : ""}
                <span className="font-semibold text-ink-2">{code}</span> {item?.label}
              </span>
            );
          })}
        </p>
      ) : null}
    </div>
  );
}

function Cell({
  cell,
  x,
  y,
  w,
  alpha,
  unit,
  style,
  showValue,
  rankGlyph,
  bold,
  title,
}: {
  cell: MatrixCell;
  x: number;
  y: number;
  w: number;
  alpha: (v: number) => number;
  unit: MetricUnit;
  style: NumberStyle;
  showValue: boolean;
  rankGlyph: boolean;
  bold: boolean;
  title: string;
}) {
  const cx = px(x + w / 2);
  if (cell.value === null) {
    if (cell.reason === "self") {
      return (
        <g data-cell="self">
          <title>{`${title}: ${reasonLabel(cell.reason)}`}</title>
          <rect x={px(x)} y={px(y)} width={px(w)} height={CELL_H} className="fill-sunken" />
          <text x={cx} y={px(y + 14)} textAnchor="middle" fontSize={11} className="fill-ink-2">
            {"—"}
          </text>
        </g>
      );
    }
    return (
      <g data-cell="missing">
        <title>{`${title}: ${reasonLabel(cell.reason)}`}</title>
        <rect x={px(x + 0.5)} y={px(y + 0.5)} width={px(w - 1)} height={CELL_H - 1} className="fill-surface stroke-line-strong" />
        <path d={hatchPath(x + 1, y + 1, w - 2, CELL_H - 2, 5)} strokeWidth={1} className="stroke-line-strong" />
      </g>
    );
  }
  const a = alpha(cell.value);
  const dark = a >= WHITE_TEXT_FROM;
  const text = formatNumber(cell.value, unit, style);
  return (
    <g data-cell="value">
      <title>{`${title}: ${text}${cell.rank !== null ? ` (rank ${cell.rank} in row)` : ""}`}</title>
      <rect x={px(x)} y={px(y)} width={px(w)} height={CELL_H} fillOpacity={px(a)} className="fill-accent" />
      {showValue ? (
        <text
          x={cx}
          y={px(y + 14)}
          textAnchor="middle"
          fontSize={11}
          fontWeight={bold ? 600 : 400}
          className={`tabular-nums ${dark ? "fill-white" : "fill-ink-2"}`}
        >
          {text}
        </text>
      ) : null}
      {rankGlyph && cell.rank !== null ? (
        <text
          x={showValue ? px(x + w - 2.5) : cx}
          y={showValue ? px(y + 7.5) : px(y + 14)}
          textAnchor={showValue ? "end" : "middle"}
          fontSize={showValue ? 7 : 11}
          fontWeight={600}
          data-glyph="rank"
          className={dark ? "fill-white" : "fill-ink-2"}
          opacity={showValue ? 0.85 : 1}
        >
          {showValue ? cell.rank : `#${cell.rank}`}
        </text>
      ) : null}
    </g>
  );
}

function AnnotationMark({ n, x, y }: { n: number; x: number; y: number }) {
  return (
    <g aria-hidden="true" data-annotation={n}>
      <circle cx={px(x)} cy={px(y)} r={4.5} className="fill-accent" />
      <text x={px(x)} y={px(y + 2.6)} textAnchor="middle" fontSize={7} fontWeight={700} className="fill-white">
        {n}
      </text>
    </g>
  );
}

function MarginRow({
  margin,
  y,
  labelW,
  cellW,
  cellX,
  unit,
  style,
  colNames,
}: {
  margin: NonNullable<MatrixPayload["margin"]>;
  y: number;
  labelW: number;
  cellW: number;
  cellX: (j: number) => number;
  unit: MetricUnit;
  style: NumberStyle;
  colNames: readonly string[];
}) {
  const values = margin.values.flatMap((v) => (v.value === null ? [] : [Math.abs(v.value)]));
  const max = values.length > 0 ? Math.max(...values) : 1;
  const head = margin.label.split(/\s+/)[0] ?? margin.label;
  return (
    <g data-margin="true">
      <line x1={px(cellX(0))} x2={px(cellX(colNames.length - 1) + cellW)} y1={y - 1} y2={y - 1} className="stroke-line" />
      <text x={0} y={px(y + 13)} fontSize={FONT} fontWeight={500} className="fill-ink-2">
        <title>{margin.label}</title>
        {fitText(head, labelW - 2, FONT, { weight: 500 })}
      </text>
      {margin.values.map((v, j) => {
        const x = cellX(j);
        const name = `${margin.label}, ${colNames[j] ?? ""}`;
        if (v.value === null) {
          return (
            <text key={j} x={px(x + cellW / 2)} y={px(y + 12)} textAnchor="middle" fontSize={10} className="fill-ink-2">
              <title>{`${name}: ${reasonLabel(v.reason)}`}</title>
              {"—"}
            </text>
          );
        }
        const text = formatNumber(v.value, unit, style);
        return (
          <g key={j}>
            <title>{`${name}: ${text}`}</title>
            <text x={px(x + cellW / 2)} y={px(y + 12)} textAnchor="middle" fontSize={10} className="fill-ink-2 tabular-nums">
              {text}
            </text>
            <rect
              x={px(x + 3)}
              y={px(y + 17)}
              width={px(Math.max(1, ((cellW - 6) * Math.abs(v.value)) / max))}
              height={2.5}
              className="fill-accent"
            />
          </g>
        );
      })}
    </g>
  );
}

function RampLegend({
  x,
  y,
  min,
  max,
  alpha,
  unit,
  hatch,
}: {
  x: number;
  y: number;
  min: number;
  max: number;
  alpha: (v: number) => number;
  unit: MetricUnit;
  /** Add the hatched "not measured" key after the ramp. */
  hatch: boolean;
}) {
  const digits = Math.min(2, Math.max(stepDigits(min), stepDigits(max)));
  const lo = formatNumber(min, unit, { digits });
  const hi = formatNumber(max, unit, { digits });
  const steps = [0, 1, 2, 3, 4].map((k) => min + ((max - min) * k) / 4);
  const stepsX = x + textWidth(lo, FONT) + 4;
  const hiX = stepsX + 5 * 20;
  const hatchX = hiX + textWidth(hi, FONT) + 14;
  return (
    <g aria-hidden="true">
      <text x={px(x)} y={px(y + 11)} fontSize={FONT} className="fill-ink-2 tabular-nums">
        {lo}
      </text>
      {steps.map((v, k) => (
        <rect key={k} x={px(stepsX + k * 20)} y={px(y + 4)} width={16} height={6} fillOpacity={px(alpha(v))} className="fill-accent" />
      ))}
      <text x={px(hiX)} y={px(y + 11)} fontSize={FONT} className="fill-ink-2 tabular-nums">
        {hi}
      </text>
      {hatch ? (
        <g data-legend="not-measured">
          <rect x={px(hatchX + 0.5)} y={px(y + 2.5)} width={13} height={8} className="fill-surface stroke-line-strong" />
          <path d={hatchPath(hatchX + 1, y + 3, 12, 7, 4)} strokeWidth={1} className="stroke-ink-3" />
          <text x={px(hatchX + 18)} y={px(y + 11)} fontSize={FONT} className="fill-ink-2">
            not measured
          </text>
        </g>
      ) : null}
    </g>
  );
}

type Annotation = MatrixPayload["annotations"][number];

/** An annotation with where it points and its number (general notes keep a number but no mark). */
interface PlacedAnnotation extends Annotation {
  kind: "col" | "row" | "cell" | "note";
  n: number;
}

/** Annotations whose keys resolve, numbered in order; one naming a missing row or column is dropped. */
function resolveAnnotations(data: MatrixPayload): PlacedAnnotation[] {
  const hasRow = (key: string) => data.rows.some((r) => r.key === key);
  const hasCol = (key: string) => data.cols.some((c) => c.key === key);
  const out: PlacedAnnotation[] = [];
  for (const a of data.annotations) {
    if ((a.rowKey !== null && !hasRow(a.rowKey)) || (a.colKey !== null && !hasCol(a.colKey))) continue;
    const kind = a.rowKey !== null ? (a.colKey !== null ? "cell" : "row") : a.colKey !== null ? "col" : "note";
    out.push({ ...a, kind, n: out.length + 1 });
  }
  return out;
}

/** Consecutive runs of equal group names. */
function groupRuns(groups: readonly (string | null)[]): { group: string | null; start: number; length: number }[] {
  const runs: { group: string | null; start: number; length: number }[] = [];
  groups.forEach((g, i) => {
    const last = runs[runs.length - 1];
    if (last && last.group === g) last.length += 1;
    else runs.push({ group: g, start: i, length: 1 });
  });
  return runs;
}

/** The table view: one row per matrix row, every cell's value or its reason, then the margin. */
export function matrixTableSpec(data: MatrixPayload, caption: string, style: NumberStyle, withRank: boolean) {
  const rows: TableRow[] = [];
  data.rows.forEach((row, i) => {
    if (row.group !== null && row.group !== (data.rows[i - 1]?.group ?? null)) {
      rows.push({ key: `section-${i}`, section: row.group });
    }
    // R3: a name the question gave or a specialist would check first says so ("You named", "Expected").
    const chip = row.source ? CANDIDATE_SOURCE_LABEL[row.source] : null;
    const name = [row.key === data.targetKey ? `${row.label} (target)` : row.label, chip].filter(Boolean).join(" · ");
    rows.push({
      key: row.key,
      cells: [
        name,
        ...(data.cells[i] ?? []).map((c) => {
          const t = cellText(c, data.unit, style);
          return t.kind === "value" && withRank && c.rank !== null ? { kind: "value" as const, text: `${t.text} · #${c.rank}` } : t;
        }),
      ],
    });
  });
  if (data.margin) {
    rows.push({
      key: "margin",
      cells: [data.margin.label, ...data.margin.values.map((v) => cellText(v, data.unit, style))],
    });
  }
  return {
    caption: `${caption}: ${data.valueLabel}`,
    columns: [
      { label: data.mode === "share" ? "Row" : "Entity" },
      ...data.cols.map((c) => ({ label: c.source && CANDIDATE_SOURCE_LABEL[c.source] ? `${c.label} · ${CANDIDATE_SOURCE_LABEL[c.source]}` : c.label, numeric: true })),
    ],
    rows,
  };
}
