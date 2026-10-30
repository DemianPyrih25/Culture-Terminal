import type { TasteMapPayload, TasteMapPoint } from "@ct/contracts";
import { FigureFrame, Legend, figureLabel, type FigureMeta, type LegendItem } from "./figure-frame";
import { FigureTable, type TableColumn, type TableRow } from "./figure-table";
import { formatNumber, reasonLabel } from "./format";
import { fitText, niceStep, px, textWidth } from "./scale";

/**
 * TasteMap (kind TasteMap: the Category Taste Map, SPEC §5.3 S1 P1 extension). The classical-MDS
 * positions of up to 14 entities on one scale for both axes, so map distance reads as taste distance
 * (1 − similarity) and nothing else: no axes, no ticks, a scale bar instead. The subject is the accent
 * dot with a ring; dot size is the hub score when it was measured (larger = close to many). Every
 * point is labelled where a label fits; the table view lists every point with its nearest neighbour on
 * the map. Three points are listed, not drawn: any three distances fit a flat map exactly. The caption
 * gives the stress, and unscored pairs and unplaced entities are spelled out under the plot.
 */

/** Fewest points drawn as a map (quant TASTE_MAP_DRAW_MIN_K): three always fit exactly and show nothing. */
export const TASTE_MAP_DRAW_MIN = 4;

export interface TasteMapOptions {
  /** Layout width of the wide plot in px (md and up). Default 680. */
  width?: number;
}

export type TasteMapProps = FigureMeta & TasteMapOptions & { data: TasteMapPayload };

/** The narrow plot drawn below md: laid out at a phone's content width, so its 12 px labels stay 12 px. */
const NARROW = { width: 340, height: 320 } as const;
const WIDE_HEIGHT = 340;
const FONT = 12;
/** Inner margin that keeps dots and their rings inside the plot. */
const PAD = 14;
/** Room under the plot for the scale bar. */
const FOOT = 26;

/** Kruskal's reading of stress-1, as the caption words it. */
export function stressText(stress: number): string {
  const value = stress.toFixed(2);
  if (stress <= 0.05) return `stress ${value} (good fit)`;
  if (stress <= 0.1) return `stress ${value} (fair fit)`;
  if (stress <= 0.2) return `stress ${value} (rough fit: read close pairs, not exact positions)`;
  return `stress ${value} (poor fit: two dimensions distort these distances; rely on the table, not the positions)`;
}

/** The fixed caption under the plot. */
export function tasteMapCaption(data: TasteMapPayload): string {
  const lead = "Positions show audience taste similarity (relative, not sales or switching)";
  return data.k < TASTE_MAP_DRAW_MIN ? `${lead}; ${data.k} entities are too few to map.` : `${lead}; ${stressText(data.stress)}.`;
}

export function TasteMap(props: TasteMapProps) {
  const label = figureLabel(props);
  const { data } = props;
  const drawable = data.k >= TASTE_MAP_DRAW_MIN;
  const legend = drawable ? <TasteMapLegend data={data} /> : null;
  return (
    <FigureFrame
      meta={props}
      legend={legend}
      plot={<TasteMapPlot data={data} label={label} width={props.width ?? 680} />}
      table={<FigureTable spec={tasteMapTableSpec(data, label)} />}
      fixedCaption={tasteMapCaption(data)}
    />
  );
}

function TasteMapLegend({ data }: { data: TasteMapPayload }) {
  const items: LegendItem[] = [
    ...(data.points.some((p) => p.target) ? [{ label: "Subject", swatch: "data" as const }] : []),
    { label: data.source === "screener" ? "Screened brands" : "Peers", swatch: "data-2" },
  ];
  const sized = data.points.some((p) => p.hub !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <Legend items={items} />
      {sized ? <span className="type-label text-ink-2">Larger dot: hub, close to many · smaller: niche</span> : null}
    </div>
  );
}

function TasteMapPlot({ data, label, width }: { data: TasteMapPayload; label: string; width: number }) {
  const notes = (
    <>
      {data.imputedPairs.length > 0 ? (
        <p className="m-0 type-caption text-ink-2">
          <span className="font-semibold">Unscored pairs, drawn at the largest scored distance: </span>
          {data.imputedPairs.map(([a, b]) => `${labelOf(data, a)} – ${labelOf(data, b)}`).join(" · ")}
        </p>
      ) : null}
      {data.omitted.length > 0 ? (
        <p className="m-0 type-caption text-ink-2">
          <span className="font-semibold">Not placed: </span>
          {data.omitted.map((o, i) => (
            <span key={`${o.label}-${i}`}>
              {i > 0 ? " · " : ""}
              {o.label} <span className="italic">({reasonLabel(o.reason)})</span>
            </span>
          ))}
        </p>
      ) : null}
      <p className="m-0 type-caption text-ink-2">{data.method}</p>
    </>
  );
  if (data.k < TASTE_MAP_DRAW_MIN) {
    return (
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="flex min-h-[120px] items-center justify-center bg-sunken px-4 py-6" role="status">
          <span className="type-caption text-center text-ink-2">
            {`Only ${data.k} entities could be placed. Any ${data.k} distances fit a flat map exactly, so a map would add nothing; the table lists them.`}
          </span>
        </div>
        {notes}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="max-md:hidden" data-layout="wide">
        <MapSvg model={tasteMapModel(data, { width, height: WIDE_HEIGHT })} data={data} label={label} />
      </div>
      <div className="md:hidden" data-layout="narrow">
        <MapSvg model={tasteMapModel(data, NARROW)} data={data} label={label} />
      </div>
      {notes}
    </div>
  );
}

function MapSvg({ model, data, label }: { model: TasteMapModel; data: TasteMapPayload; label: string }) {
  const target = data.points.find((p) => p.target);
  return (
    <svg
      viewBox={`0 0 ${model.width} ${model.height}`}
      width="100%"
      role="img"
      aria-label={label}
      className="block h-auto font-sans"
      style={{ maxWidth: model.width }}
    >
      <title>{label}</title>
      <desc>
        {`${data.k} entities placed by audience taste similarity${target ? `, ${target.label} highlighted` : ""}. Nearby points share audience taste; the axes have no meaning. The table view lists every point with its nearest neighbour.`}
      </desc>
      <rect x={0.5} y={0.5} width={model.width - 1} height={model.plotBottom} rx={4} className="fill-none stroke-line" />
      {model.points
        .filter((p) => !p.target)
        .map((p) => (
          <circle key={p.key} cx={p.cx} cy={p.cy} r={p.r} strokeWidth={1} className="fill-chart-muted stroke-line-strong" data-point={p.key}>
            <title>{p.title}</title>
          </circle>
        ))}
      {model.points
        .filter((p) => p.target)
        .map((p) => (
          <g key={p.key} data-point={p.key} data-tone="target">
            <title>{p.title}</title>
            <circle cx={p.cx} cy={p.cy} r={p.r + 4} strokeWidth={1} className="fill-none stroke-accent" />
            <circle cx={p.cx} cy={p.cy} r={p.r} strokeWidth={1.5} className="fill-accent stroke-surface" />
          </g>
        ))}
      {model.labels.map((l) => (
        <text
          key={`l-${l.key}`}
          x={l.x}
          y={l.y}
          textAnchor={l.anchor}
          fontSize={FONT}
          fontWeight={l.target ? 600 : 400}
          strokeWidth={3}
          paintOrder="stroke"
          className={`${l.target ? "fill-accent" : "fill-ink-2"} stroke-surface`}
        >
          {l.text}
        </text>
      ))}
      {model.scaleBar ? (
        <g data-scale-bar="true">
          <line
            x1={model.scaleBar.x}
            x2={px(model.scaleBar.x + model.scaleBar.length)}
            y1={model.scaleBar.y}
            y2={model.scaleBar.y}
            strokeWidth={1.5}
            className="stroke-ink-2"
          />
          <line x1={model.scaleBar.x} x2={model.scaleBar.x} y1={model.scaleBar.y - 3} y2={model.scaleBar.y + 3} className="stroke-ink-2" />
          <line
            x1={px(model.scaleBar.x + model.scaleBar.length)}
            x2={px(model.scaleBar.x + model.scaleBar.length)}
            y1={model.scaleBar.y - 3}
            y2={model.scaleBar.y + 3}
            className="stroke-ink-2"
          />
          <text x={px(model.scaleBar.x + model.scaleBar.length + 6)} y={model.scaleBar.y + 4} fontSize={FONT} className="fill-ink-2">
            {model.scaleBar.text}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

// Model ----------------------------------------------------------------------------------------------

export interface TasteMapModelPoint {
  key: string;
  cx: number;
  cy: number;
  r: number;
  target: boolean;
  title: string;
}

export interface TasteMapModelLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  target: boolean;
}

export interface TasteMapModel {
  width: number;
  height: number;
  /** Bottom edge of the plot frame; the scale bar sits below it. */
  plotBottom: number;
  /** Pixels per unit of taste distance, the same on both axes. */
  scale: number;
  points: TasteMapModelPoint[];
  labels: TasteMapModelLabel[];
  /** A nice taste distance drawn to scale, e.g. "0.10 less similar"; null when every point coincides. */
  scaleBar: { x: number; y: number; length: number; text: string } | null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Dot radius: the hub score (0–1) from 3.5 to 7.5 px when measured, 4.5 otherwise. */
export function dotRadius(hub: number | null): number {
  return hub === null ? 4.5 : px(3.5 + 4 * Math.min(1, Math.max(0, hub)));
}

/** Map distance between two points of the payload. */
function mapDistance(a: TasteMapPoint, b: TasteMapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Each point's nearest neighbour on the map (ties: the first in payload order). */
export function nearestOnMap(data: TasteMapPayload): Map<string, { point: TasteMapPoint; distance: number }> {
  const out = new Map<string, { point: TasteMapPoint; distance: number }>();
  for (const p of data.points) {
    let best: { point: TasteMapPoint; distance: number } | null = null;
    for (const q of data.points) {
      if (q.key === p.key) continue;
      const distance = mapDistance(p, q);
      if (best === null || distance < best.distance) best = { point: q, distance };
    }
    if (best) out.set(p.key, best);
  }
  return out;
}

/**
 * The plot's geometry at one layout size: one scale for both axes (a distance means the same in any
 * direction), the data centred in the frame with room for labels at the sides, y up. Labels are placed
 * greedily and deterministically, the subject first, then by hub and key: right, left, above, below,
 * else no label (the dot keeps its tooltip and its table row).
 */
export function tasteMapModel(data: TasteMapPayload, size: { width: number; height: number }): TasteMapModel {
  const { width, height } = size;
  const plotBottom = height - FOOT;
  const xs = data.points.map((p) => p.x);
  const ys = data.points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  // Labels need room beside the outermost dots; a narrow plot gives them less.
  const sideRoom = Math.min(96, width * 0.2);
  const innerW = width - 2 * (PAD + sideRoom);
  const innerH = plotBottom - 2 * (PAD + FONT);
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const scale = spanX === 0 && spanY === 0 ? 0 : Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const sx = (x: number) => px(width / 2 + (x - midX) * scale);
  const sy = (y: number) => px(plotBottom / 2 - (y - midY) * scale);

  const nearest = nearestOnMap(data);
  const points: TasteMapModelPoint[] = data.points.map((p) => {
    const near = nearest.get(p.key);
    const hub = p.hub === null ? "" : ` · hub ${formatNumber(p.hub, "stat")}`;
    return {
      key: p.key,
      cx: sx(p.x),
      cy: sy(p.y),
      r: dotRadius(p.hub),
      target: p.target,
      title: `${p.label}${near ? `: nearest on the map ${near.point.label}` : ""}${hub}`,
    };
  });

  const taken: Box[] = points.map((p) => ({ x: p.cx - p.r - 1, y: p.cy - p.r - 1, w: 2 * p.r + 2, h: 2 * p.r + 2 }));
  const order = [...data.points].sort(
    (a, b) => Number(b.target) - Number(a.target) || (b.hub ?? -1) - (a.hub ?? -1) || a.key.localeCompare(b.key),
  );
  const labels: TasteMapModelLabel[] = [];
  const maxLabel = Math.min(150, width * 0.38);
  for (const p of order) {
    const dot = points.find((q) => q.key === p.key)!;
    const weight = p.target ? 600 : 400;
    const text = fitText(p.label, maxLabel, FONT, { weight });
    const w = textWidth(text, FONT, { weight });
    const h = FONT + 2;
    const gap = dot.r + (p.target ? 7 : 4);
    const { cx, cy } = dot;
    const candidates: { box: Box; x: number; y: number; anchor: TasteMapModelLabel["anchor"] }[] = [
      { box: { x: cx + gap, y: cy - h / 2 - 1, w, h }, x: cx + gap, y: cy + 4, anchor: "start" },
      { box: { x: cx - gap - w, y: cy - h / 2 - 1, w, h }, x: cx - gap, y: cy + 4, anchor: "end" },
      { box: { x: cx - w / 2, y: cy - gap - h, w, h }, x: cx, y: cy - gap - 2, anchor: "middle" },
      { box: { x: cx - w / 2, y: cy + gap, w, h }, x: cx, y: cy + gap + h - 2, anchor: "middle" },
    ];
    const own = taken[points.indexOf(dot)];
    const fit = candidates.find(
      (c) =>
        c.box.x >= 4 &&
        c.box.x + c.box.w <= width - 4 &&
        c.box.y >= 2 &&
        c.box.y + c.box.h <= plotBottom - 2 &&
        !taken.some((t) => t !== own && overlaps(t, c.box)),
    );
    if (!fit) continue;
    taken.push(fit.box);
    labels.push({ key: p.key, text, x: px(fit.x), y: px(fit.y), anchor: fit.anchor, target: p.target });
  }

  let scaleBar: TasteMapModel["scaleBar"] = null;
  if (scale > 0) {
    // About a fifth of the plot width, at a 1-2-2.5-5 step of taste distance.
    const step = niceStep(width / 5 / scale, 1);
    scaleBar = { x: 8, y: plotBottom + 15, length: px(step * scale), text: `${formatNumber(step, "stat")} less similar` };
  }
  return { width, height, plotBottom, scale, points, labels, scaleBar };
}

function labelOf(data: TasteMapPayload, key: string): string {
  return data.points.find((p) => p.key === key)?.label ?? key;
}

/**
 * The table view: every placed point, the subject first and then by distance to it (or by nearest
 * distance without a subject), with its nearest neighbour on the map, its hub score and its map
 * coordinates; then every entity that was not placed, with the reason.
 */
export function tasteMapTableSpec(data: TasteMapPayload, caption: string) {
  const target = data.points.find((p) => p.target) ?? null;
  const nearest = nearestOnMap(data);
  const withHub = data.points.some((p) => p.hub !== null);
  const columns: TableColumn[] = [
    { label: "Name" },
    ...(target ? [{ label: `Map distance to ${target.label}`, numeric: true }] : []),
    { label: "Nearest on the map" },
    { label: "Map distance to nearest", numeric: true },
    ...(withHub ? [{ label: "Hub score", numeric: true }] : []),
    { label: "x", numeric: true },
    { label: "y", numeric: true },
  ];
  const sortKey = (p: TasteMapPoint) => (target ? mapDistance(p, target) : (nearest.get(p.key)?.distance ?? 0));
  const sorted = [...data.points].sort((a, b) => Number(b.target) - Number(a.target) || sortKey(a) - sortKey(b) || a.key.localeCompare(b.key));
  const num = (v: number) => formatNumber(v, "stat");
  const rows: TableRow[] = sorted.map((p) => {
    const near = nearest.get(p.key);
    return {
      key: p.key,
      cells: [
        p.target ? `${p.label} (subject)` : p.label,
        ...(target ? [p.target ? "—" : num(mapDistance(p, target))] : []),
        near ? near.point.label : "—",
        near ? num(near.distance) : "—",
        ...(withHub ? [p.hub === null ? { kind: "missing" as const, reason: reasonLabel("not_measured") } : num(p.hub)] : []),
        num(p.x),
        num(p.y),
      ],
    };
  });
  data.omitted.forEach((o, i) => {
    const missing = { kind: "missing" as const, reason: reasonLabel(o.reason) };
    rows.push({
      key: `omitted-${i}`,
      cells: [o.label, ...(target ? [missing] : []), "not placed", missing, ...(withHub ? [""] : []), "", ""],
    });
  });
  return { caption, columns, rows };
}
