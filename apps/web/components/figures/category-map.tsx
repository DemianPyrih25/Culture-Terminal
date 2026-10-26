import type { MetricUnit, NoValueReason } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableColumn, type TableRow } from "./figure-table";
import { axisCodes, formatNumber, reasonLabel, type NumberStyle } from "./format";
import { niceStep, px, stepDigits, textWidth } from "./scale";

/**
 * CategoryMap, the Category Taste Map (S1 peer_landscape, P1 extension; SPEC §5.3 S1): up to 14
 * entities of a category placed by classical MDS on 1 − similarity (@ct/quant mds.ts), so entities
 * that share an audience sit close together. Both axes share one scale and carry no meaning of their
 * own: only distance does, read off the scale bar. The subject is ringed in the accent, near-
 * substitute pairs are joined, and the map's Kruskal stress is printed on it, because a flat map of
 * a high-dimensional taste space always bends some distances; pairs that were never scored, and so
 * sit at the largest distance, are counted beside it. Labels are placed greedily around each point,
 * never nearer another dot than their own, then further out with a leader, then as a short code;
 * anything still unlabelled is listed under the map. Each point is a keyboard stop that names its
 * nearest peer by similarity: a line to the peer, the value beside it and the peer lifted out of
 * the dimming.
 */

/** One entity on the map. */
export interface TasteMapPoint {
  key: string;
  label: string;
  ref: string | null;
  /** Short code used when the full label finds no room; derived from the label when absent. */
  code?: string;
  /** MDS coordinates, in units of 1 − similarity. */
  x: number;
  y: number;
  /** The subject, drawn in the accent. */
  target: boolean;
  /** Average-linkage cluster (S1 ordering), or null. */
  group: string | null;
  /** The most similar scored entity by the input similarity, not by map distance. */
  nearest: { key: string; value: number } | null;
}

/** The Category Taste Map payload (a proposed TasteMap dataset kind). */
export interface TasteMapPayload {
  /** What the distances come from, e.g. "Audience taste similarity". */
  valueLabel: string;
  unit: MetricUnit;
  points: TasteMapPoint[];
  /** Near-substitute pairs (mutual rank 1 and similarity ≥ p90), joined on the map. */
  links: { a: string; b: string; value: number }[];
  /** Entities that could not be placed, with the reason. */
  omitted: { label: string; ref: string | null; reason: NoValueReason }[];
  /** Kruskal stress-1 of the map against 1 − similarity. */
  stress: number;
  /** Mardia's fit of the two axes, 0–1: their positive eigenvalues over the absolute mass of all. */
  explained: number;
  /** Placed pairs with no score, set to the largest scored distance before MDS (and in the stress). */
  imputed: number;
  caption: string;
}

export interface CategoryMapOptions {
  /** Layout width in px. Default 680; at 480 or more a compact 358 px map takes over below sm. */
  width?: number;
  /** Height of the map in px. Default 340 (280 compact). */
  height?: number;
  numberStyle?: NumberStyle;
}

export type CategoryMapProps = FigureMeta & CategoryMapOptions & { data: TasteMapPayload };

const COMPACT_W = 358;
const WIDE_MIN = 480;
const BADGE_FONT = { weight: 600, tracking: 1 } as const;

/** Kruskal's (1964) verbal reading of stress-1. */
export function stressReading(stress: number): string {
  if (stress <= 0.025) return "excellent";
  if (stress <= 0.05) return "good";
  if (stress <= 0.1) return "fair";
  if (stress <= 0.2) return "poor";
  return "unreliable";
}

/** How many placed pairs were never scored: "2 pairs", "1 pair". */
const pairCount = (n: number) => (n === 1 ? "1 pair" : `${formatNumber(n, "count")} pairs`);

export function CategoryMap(props: CategoryMapProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { ...props.numberStyle };
  const width = props.width ?? 680;
  const wide = width >= WIDE_MIN;
  const { data } = props;
  const draw = (w: number, h: number, compact: boolean) => {
    const layout = layoutCategoryMap(data, w, h, compact, style);
    return (
      <>
        <MapSvg layout={layout} data={data} label={label} style={style} />
        <LabelNote layout={layout} />
      </>
    );
  };
  return (
    <FigureFrame
      meta={props}
      legend={<MapLegend data={data} />}
      plot={
        <div className="flex flex-col gap-1.5 pt-1">
          {wide ? (
            <>
              <div className="hidden sm:block" data-layout="wide">
                {draw(width, props.height ?? 340, false)}
              </div>
              <div className="sm:hidden" data-layout="compact">
                {draw(COMPACT_W, 280, true)}
              </div>
            </>
          ) : (
            <div data-layout="compact">{draw(width, props.height ?? 280, true)}</div>
          )}
          <p className="m-0 font-ui text-[11px] leading-[16px] text-dim" data-stress={formatNumber(data.stress, "stat", { digits: 2 })}>
            {`Stress ${formatNumber(data.stress, "stat", { digits: 2 })} (Kruskal: ${stressReading(data.stress)}); the two axes hold ${formatNumber(data.explained * 100, "count", { digits: 0 })}% of the variance${
              data.imputed > 0
                ? `; ${pairCount(data.imputed)} ${data.imputed === 1 ? "was not scored and sits" : "were not scored and sit"} at the largest distance`
                : ""
            }. The axes have no units: only the distance between two points carries meaning.`}
          </p>
          {data.omitted.length > 0 ? (
            <p className="m-0 font-ui text-[11px] leading-[16px] text-dim">
              <span className="font-semibold text-text-2">Not placed: </span>
              {data.omitted.map((o, i) => (
                <span key={`${o.label}-${i}`}>
                  {i > 0 ? " · " : ""}
                  {o.label} <span className="italic">({reasonLabel(o.reason)})</span>
                </span>
              ))}
            </p>
          ) : null}
        </div>
      }
      table={<FigureTable spec={categoryMapTableSpec(data, label, style)} />}
      fixedCaption={data.caption}
    />
  );
}

// Layout -----------------------------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Distance from a point to the nearest edge of a box (0 inside it). */
export function boxDistance(box: Box, p: { x: number; y: number }): number {
  const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
  const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/** A label beside its dot sits at least this much nearer its own dot than any other, or it reads as the other's. */
const ATTACH_MARGIN = 3;

/** Whether a line segment passes through a box (sampled every 2 px, which is finer than any label). */
function segmentHitsBox(seg: { x1: number; y1: number; x2: number; y2: number }, box: Box): boolean {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  const steps = Math.max(1, Math.ceil(len / 2));
  for (let k = 0; k <= steps; k++) {
    const x = seg.x1 + ((seg.x2 - seg.x1) * k) / steps;
    const y = seg.y1 + ((seg.y2 - seg.y1) * k) / steps;
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return true;
  }
  return false;
}

interface MapLabel {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  /** A leader line from the point to the label, when the label sits further out. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  /** The label is the short code, not the full name. */
  coded: boolean;
}

interface PlacedPoint {
  point: TasteMapPoint;
  px: number;
  py: number;
  label: MapLabel | null;
  /** The label shown while the point is focused: the full name, placed against the dots only. */
  focusLabel: MapLabel | null;
  /**
   * The nearest peer while focused: its position, the value's baseline clear of every label and dot,
   * and the peer's own label, redrawn at full strength over the dimmed map.
   */
  nearest: {
    x: number;
    y: number;
    value: number;
    label: string;
    target: boolean;
    text: { x: number; y: number };
    peerLabel: MapLabel | null;
  } | null;
}

interface MapLayout {
  width: number;
  height: number;
  compact: boolean;
  fontSize: number;
  points: PlacedPoint[];
  links: { a: string; b: string; x1: number; y1: number; x2: number; y2: number }[];
  scale: { x: number; y: number; length: number; text: string };
  badge: { x: number; y: number; text: string };
  /** Points that kept no label at all: listed under the map. */
  unlabelled: string[];
  frame: { x: number; y: number; w: number; h: number };
}

/** Places the points on one shared scale, centred in the frame, then labels them. */
export function layoutCategoryMap(data: TasteMapPayload, width: number, height: number, compact: boolean, style: NumberStyle = {}): MapLayout {
  const fontSize = compact ? 10.5 : 11;
  const frame = { x: 0.5, y: 0.5, w: width - 1, h: height - 1 };
  const padX = compact ? 46 : 84;
  const padTop = 26;
  const padBottom = 34;
  const box = { x0: padX, x1: width - padX, y0: padTop, y1: height - padBottom };
  const xs = data.points.map((p) => p.x);
  const ys = data.points.map((p) => p.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 0);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // One scale for both axes, or the distances would lie.
  const k = Math.min(spanX > 0 ? (box.x1 - box.x0) / spanX : Infinity, spanY > 0 ? (box.y1 - box.y0) / spanY : Infinity);
  const unit = Number.isFinite(k) ? k : 1;
  const ox = (box.x0 + box.x1) / 2 - ((minX + maxX) / 2) * unit;
  // Map y grows upward, like any scatter; SVG y grows downward.
  const oy = (box.y0 + box.y1) / 2 + ((minY + maxY) / 2) * unit;
  const at = (p: { x: number; y: number }) => ({ x: ox + p.x * unit, y: oy - p.y * unit });

  const codes = axisCodes(
    data.points.map((p) => ({ key: p.key, label: p.label })),
    Object.fromEntries(data.points.flatMap((p) => (p.code ? [[p.key, p.code]] : []))),
  );
  const pos = new Map(data.points.map((p) => [p.key, at(p)]));

  // Scale bar: a 1-2-2.5-5 step near a quarter of the wider span, bottom left.
  const step = niceStep(Math.max(spanX, spanY, 1e-6), 4);
  const scaleLen = step * unit;
  const scale = {
    x: 10,
    y: height - 12,
    length: scaleLen,
    text: `${formatNumber(step, "stat", { digits: stepDigits(step) })} of 1 − similarity`,
  };
  const badgeText = `STRESS ${formatNumber(data.stress, "stat", { digits: 2 })} · ${stressReading(data.stress).toUpperCase()}`;
  const badge = { x: width - 10, y: 17, text: badgeText };
  const reserved: Box[] = [
    { x: scale.x - 2, y: scale.y - 14, w: Math.max(scaleLen, textWidth(scale.text, 9.5)) + 8, h: 18 },
    { x: badge.x - textWidth(badgeText, 9.5, BADGE_FONT) - 4, y: badge.y - 10, w: textWidth(badgeText, 9.5, BADGE_FONT) + 8, h: 13 },
  ];
  const bounds = { x0: 4, y0: 4, x1: width - 4, y1: height - 4 };
  const dots = data.points.map((p) => {
    const q = pos.get(p.key)!;
    const r = p.target ? 9 : 5.5;
    return { key: p.key, box: { x: q.x - r, y: q.y - r, w: r * 2, h: r * 2 } };
  });

  // Near-substitute links: drawn between the two points, and labels keep off them.
  const links = data.links.flatMap((l) => {
    const a = pos.get(l.a);
    const b = pos.get(l.b);
    return a && b ? [{ a: l.a, b: l.b, x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : [];
  });
  // Crowded points choose first; the subject always first.
  const crowd = (p: TasteMapPoint) => {
    const q = pos.get(p.key)!;
    return data.points.filter((o) => o.key !== p.key && Math.hypot(pos.get(o.key)!.x - q.x, pos.get(o.key)!.y - q.y) < 48).length;
  };
  const order = [...data.points].sort((a, b) => Number(b.target) - Number(a.target) || crowd(b) - crowd(a) || a.key.localeCompare(b.key));
  const inside = (b: Box) => b.x >= bounds.x0 && b.x + b.w <= bounds.x1 && b.y >= bounds.y0 && b.y + b.h <= bounds.y1;
  // A label beside its dot (no leader) must read as that dot's: clearly nearer it than any other.
  const ambiguous = (own: string, { box: b, label }: { box: Box; label: MapLabel }) => {
    if (label.leader !== null) return false;
    const mine = boxDistance(b, pos.get(own)!);
    return data.points.some((o) => o.key !== own && boxDistance(b, pos.get(o.key)!) < mine + ATTACH_MARGIN);
  };
  const taken: Box[] = [...reserved];
  const labels = new Map<string, { box: Box; label: MapLabel }>();
  for (const p of order) {
    const q = pos.get(p.key)!;
    const own = p.key;
    const blocked = (c: { box: Box; label: MapLabel }) =>
      !inside(c.box) ||
      taken.some((t) => overlaps(t, c.box)) ||
      dots.some((d) => d.key !== own && overlaps(d.box, c.box)) ||
      links.some((seg) => segmentHitsBox(seg, c.box)) ||
      ambiguous(own, c) ||
      // A leader must not run through another point.
      (c.label.leader !== null && dots.some((d) => d.key !== own && segmentHitsBox(c.label.leader!, d.box)));
    const full = candidates(q, p.label, fontSize, p.target, false).find((c) => !blocked(c));
    const coded = full ?? candidates(q, codes.get(p.key) ?? p.label, fontSize - 1, p.target, true).find((c) => !blocked(c));
    if (!coded) continue;
    taken.push(coded.box);
    labels.set(p.key, coded);
  }

  const byKey = new Map(data.points.map((p) => [p.key, p]));
  const points: PlacedPoint[] = data.points.map((p) => {
    const q = pos.get(p.key)!;
    const n = p.nearest ? byKey.get(p.nearest.key) : undefined;
    const nq = n ? pos.get(n.key)! : null;
    // The focused name: the default label when it is the full name (no jump); otherwise the full name
    // beside its own dot, clear of the other (dimmed) labels where it can be, else against the dots only.
    const mine = labels.get(p.key);
    const others = [...labels].flatMap(([key, l]) => (key === p.key ? [] : [l.box]));
    const fits = (c: { box: Box; label: MapLabel }) =>
      inside(c.box) && !reserved.some((t) => overlaps(t, c.box)) && !dots.some((d) => d.key !== p.key && overlaps(d.box, c.box));
    const around = candidates(q, p.label, fontSize, p.target, false);
    const focus =
      mine && !mine.label.coded
        ? mine
        : (around.find((c) => fits(c) && !ambiguous(p.key, c) && !others.some((o) => overlaps(o, c.box))) ??
          around.find((c) => fits(c) && !ambiguous(p.key, c)) ??
          around.find(fits));
    const nearest =
      n && nq && p.nearest
        ? {
            x: nq.x,
            y: nq.y,
            value: p.nearest.value,
            label: n.label,
            target: n.target,
            text: nearestValueAt(q, nq, formatNumber(p.nearest.value, data.unit, style), [
              ...taken,
              ...(focus ? [focus.box] : []),
              ...dots.map((d) => d.box),
            ], inside),
            peerLabel: labels.get(n.key)?.label ?? null,
          }
        : null;
    return { point: p, px: q.x, py: q.y, label: labels.get(p.key)?.label ?? null, focusLabel: focus?.label ?? null, nearest };
  });

  const unlabelled = points.filter((p) => p.label === null).map((p) => p.point.label);
  return { width, height, compact, fontSize, points, links, scale, badge, unlabelled, frame };
}

/** The nearest-peer value's baseline: beside the dashed line, clear of every label and dot, else at its midpoint. */
function nearestValueAt(
  a: { x: number; y: number },
  b: { x: number; y: number },
  text: string,
  obstacles: readonly Box[],
  inside: (box: Box) => boolean,
): { x: number; y: number } {
  const w = textWidth(text, 10, { weight: 600 });
  const h = 11;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // The unit normal to the line, the side up the page first.
  const flip = b.x - a.x < 0 ? -1 : 1;
  const ux = (flip * (a.y - b.y)) / len;
  const uy = (flip * (b.x - a.x)) / len;
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    for (const off of [-8, 8, -14, 14]) {
      const cx = a.x + (b.x - a.x) * t + ux * off;
      const cy = a.y + (b.y - a.y) * t + uy * off;
      const box = { x: cx - w / 2, y: cy - h / 2, w, h };
      if (inside(box) && !obstacles.some((o) => overlaps(o, box))) return { x: cx, y: cy + 3.5 };
    }
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4 };
}

/**
 * Label positions around a point, nearest first: right, left, the four diagonals, above, below; then
 * the same four sides further out with a leader line.
 */
function candidates(
  q: { x: number; y: number },
  text: string,
  size: number,
  target: boolean,
  coded: boolean,
): { box: Box; label: MapLabel }[] {
  const weight = target ? 600 : 400;
  const w = textWidth(text, size, { weight });
  const h = size + 1;
  const g = target ? 12 : 7;
  const make = (bx: number, by: number, tx: number, ty: number, anchor: MapLabel["anchor"], leader: MapLabel["leader"]) => ({
    box: { x: bx, y: by, w, h },
    label: { text, x: tx, y: ty, anchor, leader, coded },
  });
  const near = [
    make(q.x + g, q.y - h / 2 - 1, q.x + g, q.y + 3.5, "start", null),
    make(q.x - g - w, q.y - h / 2 - 1, q.x - g, q.y + 3.5, "end", null),
    make(q.x + g * 0.7, q.y - g * 0.7 - h, q.x + g * 0.7, q.y - g * 0.7 - 2, "start", null),
    make(q.x - g * 0.7 - w, q.y - g * 0.7 - h, q.x - g * 0.7, q.y - g * 0.7 - 2, "end", null),
    make(q.x + g * 0.7, q.y + g * 0.7, q.x + g * 0.7, q.y + g * 0.7 + h - 2, "start", null),
    make(q.x - g * 0.7 - w, q.y + g * 0.7, q.x - g * 0.7, q.y + g * 0.7 + h - 2, "end", null),
    make(q.x - w / 2, q.y - g - h, q.x, q.y - g - 2, "middle", null),
    make(q.x - w / 2, q.y + g, q.x, q.y + g + h - 2, "middle", null),
  ];
  if (coded) return near;
  const far = g + 16;
  const lead = (x2: number, y2: number) => ({ x1: q.x, y1: q.y, x2, y2 });
  return [
    ...near,
    make(q.x + far, q.y - h / 2 - 1, q.x + far, q.y + 3.5, "start", lead(q.x + far - 3, q.y)),
    make(q.x - far - w, q.y - h / 2 - 1, q.x - far, q.y + 3.5, "end", lead(q.x - far + 3, q.y)),
    make(q.x - w / 2, q.y - far - h, q.x, q.y - far - 2, "middle", lead(q.x, q.y - far + 1)),
    make(q.x - w / 2, q.y + far, q.x, q.y + far + h - 2, "middle", lead(q.x, q.y + far - 1)),
  ];
}

// Drawing ----------------------------------------------------------------------------------------------

function pointSummary(p: PlacedPoint, data: TasteMapPayload, style: NumberStyle): string {
  const nearest = p.nearest
    ? `nearest by ${data.valueLabel.toLowerCase()}: ${p.nearest.label}, ${formatNumber(p.nearest.value, data.unit, style)}`
    : "no scored peer";
  const group = p.point.group ? `; cluster ${p.point.group}` : "";
  return `${p.point.label}${p.point.target ? " (subject)" : ""}: ${nearest}${group}.`;
}

function MapSvg({ layout, data, label, style }: { layout: MapLayout; data: TasteMapPayload; label: string; style: NumberStyle }) {
  const L = layout;
  return (
    <svg
      viewBox={`0 0 ${L.width} ${L.height}`}
      width="100%"
      role="group"
      aria-label={label}
      className="group/map block h-auto font-ui"
      style={{ maxWidth: L.width }}
      data-category-map={L.compact ? "compact" : "wide"}
    >
      <title>{label}</title>
      <desc>
        {`${data.points.length} entities placed by classical MDS on 1 − ${data.valueLabel.toLowerCase()}: nearer means more similar. Stress ${formatNumber(data.stress, "stat", { digits: 2 })}. Each point is one keyboard stop and names its nearest peer. The table view lists every entity.`}
      </desc>
      <rect x={L.frame.x} y={L.frame.y} width={L.frame.w} height={L.frame.h} className="fill-canvas stroke-line" />

      {L.links.map((l) => (
        <line key={`${l.a}-${l.b}`} x1={px(l.x1)} y1={px(l.y1)} x2={px(l.x2)} y2={px(l.y2)} strokeWidth={1.5} className="stroke-data" data-link={`${l.a}-${l.b}`} />
      ))}

      {L.points.map((p) => (
        <g
          key={p.point.key}
          data-point={p.point.key}
          data-tone={p.point.target ? "target" : "peer"}
          tabIndex={0}
          role="img"
          aria-label={pointSummary(p, data, style)}
          className="group cursor-default outline-none transition-opacity duration-150 group-has-[[data-point]:focus]/map:opacity-35 group-has-[[data-point]:hover]/map:opacity-35 hover:opacity-100! focus:opacity-100!"
        >
          <title>{pointSummary(p, data, style)}</title>
          {p.nearest ? (
            <g className="opacity-0 group-hover:opacity-100 group-focus:opacity-100" data-nearest="true">
              <line x1={px(p.px)} y1={px(p.py)} x2={px(p.nearest.x)} y2={px(p.nearest.y)} strokeDasharray="3 2" className="stroke-accent" />
              {/* The peer, lifted out of the dimming: a ring and its own label at full strength. */}
              <circle cx={px(p.nearest.x)} cy={px(p.nearest.y)} r={p.nearest.target ? 11.5 : 8} className="fill-none stroke-accent" data-peer="true" />
              {p.nearest.peerLabel ? <MapText label={p.nearest.peerLabel} size={L.fontSize} target={p.nearest.target} /> : null}
              <text
                x={px(p.nearest.text.x)}
                y={px(p.nearest.text.y)}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                strokeWidth={3}
                paintOrder="stroke"
                className="fill-accent stroke-canvas tabular-nums"
                data-nearest-value="true"
              >
                {formatNumber(p.nearest.value, data.unit, style)}
              </text>
            </g>
          ) : null}
          <circle cx={px(p.px)} cy={px(p.py)} r={12} className="fill-none stroke-accent opacity-0 group-focus-visible:opacity-100" data-focus-ring="true" />
          {p.point.target ? <circle cx={px(p.px)} cy={px(p.py)} r={8.5} className="fill-none stroke-accent" /> : null}
          <circle
            cx={px(p.px)}
            cy={px(p.py)}
            r={p.point.target ? 5 : 4}
            strokeWidth={1.5}
            className={`stroke-canvas ${p.point.target ? "fill-accent" : "fill-data"}`}
          />
          <g className={p.focusLabel ? "group-hover:opacity-0 group-focus:opacity-0" : undefined}>
            {p.label ? <MapText label={p.label} size={L.fontSize} target={p.point.target} /> : null}
          </g>
          {p.focusLabel ? (
            <g className="opacity-0 group-hover:opacity-100 group-focus:opacity-100" aria-hidden="true">
              <MapText label={p.focusLabel} size={L.fontSize} target={p.point.target} />
            </g>
          ) : null}
        </g>
      ))}

      <g aria-hidden="true">
        <line x1={px(L.scale.x)} x2={px(L.scale.x + L.scale.length)} y1={px(L.scale.y - 9)} y2={px(L.scale.y - 9)} className="stroke-dim" />
        <line x1={px(L.scale.x)} x2={px(L.scale.x)} y1={px(L.scale.y - 12)} y2={px(L.scale.y - 6)} className="stroke-dim" />
        <line
          x1={px(L.scale.x + L.scale.length)}
          x2={px(L.scale.x + L.scale.length)}
          y1={px(L.scale.y - 12)}
          y2={px(L.scale.y - 6)}
          className="stroke-dim"
        />
        <text x={px(L.scale.x)} y={px(L.scale.y + 2)} fontSize={9.5} className="fill-dim tabular-nums">
          {L.scale.text}
        </text>
        <text
          x={px(L.badge.x)}
          y={px(L.badge.y)}
          textAnchor="end"
          fontSize={9.5}
          fontWeight={600}
          letterSpacing={1}
          className={data.stress > 0.2 ? "fill-negative" : "fill-dim"}
          data-badge="stress"
        >
          {L.badge.text}
        </text>
      </g>
    </svg>
  );
}

/** The key to the coded labels and the points left unlabelled, under the layout that needed them. */
function LabelNote({ layout }: { layout: MapLayout }) {
  const coded = layout.points.filter((p) => p.label?.coded);
  if (coded.length === 0 && layout.unlabelled.length === 0) return null;
  return (
    <p className="m-0 pt-1.5 font-ui text-[11px] leading-[16px] text-dim" data-label-note="true">
      {coded.length > 0 ? (
        <>
          <span className="font-semibold text-text-2">Codes: </span>
          {coded.map((p) => `${p.label!.text} ${p.point.label}`).join(" · ")}
          {layout.unlabelled.length > 0 ? ". " : ""}
        </>
      ) : null}
      {layout.unlabelled.length > 0 ? (
        <>
          <span className="font-semibold text-text-2">Unlabelled: </span>
          {layout.unlabelled.join(" · ")} (focus a point, or see the table)
        </>
      ) : null}
    </p>
  );
}

function MapText({ label, size, target }: { label: MapLabel; size: number; target: boolean }) {
  return (
    <>
      {label.leader ? (
        <line x1={px(label.leader.x1)} y1={px(label.leader.y1)} x2={px(label.leader.x2)} y2={px(label.leader.y2)} className="stroke-faint" />
      ) : null}
      <text
        x={px(label.x)}
        y={px(label.y)}
        textAnchor={label.anchor}
        fontSize={label.coded ? size - 1 : size}
        fontWeight={target ? 600 : label.coded ? 600 : 400}
        letterSpacing={label.coded ? 0.6 : 0}
        strokeWidth={3}
        paintOrder="stroke"
        className={`stroke-canvas ${target ? "fill-accent" : "fill-text-2"}`}
        data-coded={label.coded ? "true" : undefined}
      >
        {label.text}
      </text>
    </>
  );
}

function MapLegend({ data }: { data: TasteMapPayload }) {
  const subject = data.points.find((p) => p.target);
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-[18px] gap-y-1 p-0 font-ui text-[12px] text-text-2">
      {subject ? (
        <li className="flex items-center gap-1.5">
          <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
            <circle cx="7" cy="7" r="6" className="fill-none stroke-accent" />
            <circle cx="7" cy="7" r="3" className="fill-accent" />
          </svg>
          {subject.label}
        </li>
      ) : null}
      <li className="flex items-center gap-1.5">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <circle cx="5" cy="5" r="4" className="fill-data" />
        </svg>
        Peers
      </li>
      {data.links.length > 0 ? (
        <li className="flex items-center gap-1.5">
          <svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true">
            <line x1="1" x2="15" y1="5" y2="5" strokeWidth="1.5" className="stroke-data" />
          </svg>
          Near-substitutes
        </li>
      ) : null}
      <li className="text-[11.5px] text-dim">Nearer = more similar audiences</li>
    </ul>
  );
}

// Table ------------------------------------------------------------------------------------------------

/**
 * The table view: every entity with its nearest peer by similarity, its cluster and its map
 * position; then the near-substitute pairs and the entities that could not be placed.
 */
export function categoryMapTableSpec(data: TasteMapPayload, caption: string, style: NumberStyle) {
  const byKey = new Map(data.points.map((p) => [p.key, p]));
  const withGroup = data.points.some((p) => p.group !== null);
  const columns: TableColumn[] = [
    { label: "Entity" },
    { label: "Nearest peer" },
    { label: data.valueLabel, numeric: true },
    ...(withGroup ? [{ label: "Cluster" }] : []),
    { label: "Map x", numeric: true },
    { label: "Map y", numeric: true },
  ];
  const blank = withGroup ? ["", "", ""] : ["", ""];
  const rows: TableRow[] = [
    {
      key: "section-map",
      section: `Map stress ${formatNumber(data.stress, "stat", { digits: 2 })} (${stressReading(data.stress)}) · two axes hold ${formatNumber(data.explained * 100, "count", { digits: 0 })}%${
        data.imputed > 0 ? ` · ${pairCount(data.imputed)} not scored, at the largest distance` : ""
      }`,
    },
  ];
  const sorted = [...data.points].sort((a, b) => Number(b.target) - Number(a.target) || a.label.localeCompare(b.label));
  for (const p of sorted) {
    const nearest = p.nearest ? byKey.get(p.nearest.key) : undefined;
    rows.push({
      key: p.key,
      cells: [
        p.target ? `${p.label} (subject)` : p.label,
        nearest?.label ?? { kind: "missing", reason: "no scored peer" },
        p.nearest ? formatNumber(p.nearest.value, data.unit, style) : { kind: "missing", reason: reasonLabel("not_scored") },
        ...(withGroup ? [p.group ?? ""] : []),
        formatNumber(p.x, "stat", { digits: 2 }),
        formatNumber(p.y, "stat", { digits: 2 }),
      ],
    });
  }
  if (data.links.length > 0) {
    rows.push({ key: "section-links", section: "Near-substitutes" });
    for (const l of data.links) {
      rows.push({
        key: `link-${l.a}-${l.b}`,
        cells: [`${byKey.get(l.a)?.label ?? l.a} ↔ ${byKey.get(l.b)?.label ?? l.b}`, "mutual nearest", formatNumber(l.value, data.unit, style), ...blank],
      });
    }
  }
  if (data.omitted.length > 0) {
    rows.push({ key: "section-omitted", section: "Not placed" });
    data.omitted.forEach((o, i) => {
      const missing = { kind: "missing" as const, reason: reasonLabel(o.reason) };
      rows.push({ key: `omitted-${i}`, cells: [o.label, missing, missing, ...(withGroup ? [""] : []), "", ""] });
    });
  }
  return { caption, columns, rows };
}

/** How each point is labelled in a layout: its full name, its code, or not at all. */
export function mapLabelKinds(layout: MapLayout): Record<string, "full" | "code" | "none"> {
  return Object.fromEntries(layout.points.map((p) => [p.point.key, p.label === null ? "none" : p.label.coded ? "code" : "full"]));
}
