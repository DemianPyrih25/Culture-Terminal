import type { RankedPayload, RankedRow } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableColumn, type TableRow } from "./figure-table";
import { COMPARATOR_PHRASE, axisCodes, cellText, formatNumber, reasonLabel, type NumberStyle } from "./format";
import { FLAG_LABEL } from "./ranked-table";
import { clamp, fitText, px, textWidth } from "./scale";

/**
 * Constellation (S9 cross_domain, P1; SPEC §8.4): the cultural neighbourhood as a radial graph. The
 * seeds sit in the centre, each domain takes one sector, and a result's distance from the centre is
 * 1 − its FIT, so the strongest affinities ring the seeds. With two or more seeds a line joins a
 * result to the seed it leans on (the G15 edge rule, xdom.edge); otherwise faint spokes carry the
 * distance, and a note says when the payload's edges could not be drawn because it does not name
 * the seeds. The under-the-radar pick is ringed and labelled with its FIT; each domain labels its
 * top results and greys the rest. A domain is one keyboard stop: focusing or hovering it lifts its
 * sector, labels every result that fits beside its dot, lists the rest on the line under the plot
 * (which otherwise says how to name a domain), dims the other domains and hides their labels; its
 * accessible name lists every result. Rows without a FIT are listed under the plot, never drawn. Below the sm
 * breakpoint a compact layout replaces the wide one, so labels keep their size on a phone.
 * Hand-written SVG like every family.
 */

/** A seed at the centre: the ref its explainability edges name, and its label. */
export interface ConstellationSeed {
  ref: string;
  label: string;
}

type DomainGroup = RankedPayload["groups"][number] & {
  /** The S9 halo: the domain's top tags, printed under its name. */
  halo?: readonly string[];
};

/**
 * S9's Ranked dataset (one group per domain, FIT · popularity · under the radar). `seeds` and each
 * group's `halo` are optional extras the payload may carry; the props can pass both instead.
 */
export interface ConstellationData extends Omit<RankedPayload, "groups" | "seeds"> {
  groups: readonly DomainGroup[];
  seeds?: readonly ConstellationSeed[];
}

export interface ConstellationOptions {
  /** Layout width in px. Default 680; at 480 or more a compact 358 px layout takes over below sm. */
  width?: number;
  /** The seeds at the centre. Default: the payload's seeds. */
  seeds?: readonly ConstellationSeed[];
  /** The FIT column (0–1): distance from the centre. Default the column keyed "fit", else the first. */
  fitKey?: string;
  /** Results named per domain besides its under-the-radar pick. Default 3 (1 in the compact layout). */
  labelsPerDomain?: number;
  /** Top tags per domain key, printed under the domain name. Default: each group's halo. */
  halo?: Readonly<Record<string, readonly string[]>>;
  numberStyle?: NumberStyle;
}

export type ConstellationProps = FigureMeta & ConstellationOptions & { data: ConstellationData };

const COMPACT_W = 358;
/** At this width or more the figure draws the wide layout and adds the compact one for phones. */
const WIDE_MIN = 480;
const TITLE_FONT = { weight: 600, tracking: 1 } as const;
/** Golden-ratio step: spreads a domain's results over its sector without clumping. */
const GOLDEN = 0.6180339887;

export function Constellation(props: ConstellationProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { ...props.numberStyle };
  const seeds = props.seeds ?? props.data.seeds ?? [];
  const width = props.width ?? 680;
  const fit = fitColumn(props.data, props.fitKey);
  const halo = haloOf(props.data, props.halo);
  const draw = (w: number, compact: boolean) => (
    <ConstellationSvg
      layout={layoutConstellation(props.data, seeds, fit, halo, w, compact, props.labelsPerDomain ?? (compact ? 1 : 3), style)}
      data={props.data}
      label={label}
      style={style}
    />
  );
  const wide = width >= WIDE_MIN;
  const omitted = omittedRows(props.data, fit);
  const edges = hasEdges(props.data, seeds);
  const unnamed = unnamedSeedEdges(props.data, seeds);
  return (
    <FigureFrame
      meta={props}
      legend={<SeedLegend seeds={seeds} edges={edges} />}
      plot={
        <div className="flex flex-col gap-1.5 pt-1">
          {wide ? (
            <>
              <div className="hidden sm:block" data-layout="wide">
                {draw(width, false)}
              </div>
              <div className="sm:hidden" data-layout="compact">
                {draw(COMPACT_W, true)}
              </div>
            </>
          ) : (
            <div data-layout="compact">{draw(width, true)}</div>
          )}
          {unnamed ? (
            <p className="m-0 font-ui text-[11px] leading-[16px] text-dim" data-edges="unnamed">
              {edges
                ? "Some seed lines are not drawn: the dataset does not name the seed they lean on."
                : "Seed lines are not drawn: the dataset does not name its seeds, so spokes carry the distance."}
            </p>
          ) : null}
          {omitted.length > 0 ? (
            <p className="m-0 font-ui text-[11px] leading-[16px] text-dim">
              <span className="font-semibold text-text-2">Not placed: </span>
              {omitted.map((o, i) => (
                <span key={o.key}>
                  {i > 0 ? " · " : ""}
                  {o.label} <span className="italic">({o.why})</span>
                </span>
              ))}
            </p>
          ) : null}
        </div>
      }
      table={<FigureTable spec={constellationTableSpec(props.data, label, style, { seeds, halo })} />}
      fixedCaption={props.data.caption}
    />
  );
}

// Data -------------------------------------------------------------------------------------------------

/** Index of the FIT column. */
function fitColumn(data: ConstellationData, key?: string): number {
  const wanted = key ?? "fit";
  const at = data.columns.findIndex((c) => c.key === wanted);
  return at >= 0 ? at : 0;
}

function haloOf(data: ConstellationData, halo?: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, readonly string[]> {
  return new Map(data.groups.map((g) => [g.key, halo?.[g.key] ?? g.halo ?? []]));
}

function fitOf(row: RankedRow, fit: number): number | null {
  return row.cells[fit]?.value ?? null;
}

/** Edges are drawn only with two or more seeds and at least one kept edge to a named seed (xdom.edge). */
function hasEdges(data: ConstellationData, seeds: readonly ConstellationSeed[]): boolean {
  const named = new Set(seeds.map((s) => s.ref));
  return seeds.length >= 2 && data.groups.some((g) => g.rows.some((r) => r.explain.some((e) => named.has(e.seedRef))));
}

/** Whether a kept edge cannot be drawn: it leans on a seed the figure does not name (or there are too few seeds). */
function unnamedSeedEdges(data: ConstellationData, seeds: readonly ConstellationSeed[]): boolean {
  const named = new Set(seeds.length >= 2 ? seeds.map((s) => s.ref) : []);
  return data.groups.some((g) => g.rows.some((r) => r.explain.some((e) => !named.has(e.seedRef))));
}

/**
 * Rows the plot cannot place, with the reason. A domain whose call failed or came back empty keeps a
 * single explained row (S9's gap row: no ref, no rank), so it is named once, by its domain.
 */
function omittedRows(data: ConstellationData, fit: number): { key: string; label: string; why: string }[] {
  const out: { key: string; label: string; why: string }[] = [];
  for (const group of data.groups) {
    const missing = group.rows.filter((r) => fitOf(r, fit) === null);
    if (missing.length === 0) continue;
    if (group.rows.length === 1 && missing.length === 1 && missing[0]!.ref === null && missing[0]!.rank === null) {
      const first = missing[0]!;
      out.push({ key: group.key, label: group.label, why: first.sublabel ?? reasonLabel(first.cells[fit]?.reason ?? null) });
      continue;
    }
    for (const row of missing) {
      out.push({ key: `${group.key}-${row.key}`, label: row.label, why: `${group.label}, ${reasonLabel(row.cells[fit]?.reason ?? null)}` });
    }
  }
  return out;
}

// Layout -----------------------------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

interface Label {
  key: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  featured: boolean;
  /** A leader from the dot to a label set further out. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
}

interface Node {
  key: string;
  row: RankedRow;
  fit: number;
  x: number;
  y: number;
  /** Named by default (top results and the pick); the rest are grey dots. */
  named: boolean;
  pick: boolean;
  /** Seed positions this result's kept edges run to, with their shares. */
  edges: { x: number; y: number; share: number }[];
}

interface Sector {
  key: string;
  label: string;
  /** The domain name split at " · " into at most two lines, and the halo line. */
  title: { lines: string[]; halo: string | null; x: number; y: number; anchor: "start" | "end" | "middle"; lineH: number };
  wedge: string;
  nodes: Node[];
  /** Labels in the default view and in the focused view (every result that fits beside its dot). */
  labels: Label[];
  focusLabels: Label[];
  /** The focused view's line under the plot: the results it could not label, wrapped; empty when all fit. */
  overflow: { lines: string[]; prefix: string; names: string[] };
  /** The accessible name of the domain's keyboard stop. */
  summary: string;
  empty: boolean;
}

interface Layout {
  width: number;
  height: number;
  cx: number;
  cy: number;
  r0: number;
  r1: number;
  compact: boolean;
  fontSize: number;
  sectors: Sector[];
  boundaries: { x1: number; y1: number; x2: number; y2: number }[];
  /** FIT rings from 1 − step down to the outer edge (outer: true), each labelled on the top boundary. */
  rings: { r: number; text: string; x: number; y: number; outer: boolean }[];
  seeds: { ref: string; label: string; code: string; x: number; y: number }[];
  spokes: boolean;
  /** The text line(s) under the plot: the focused domain's unlabelled results, or the hint. */
  strip: { x: number; y: number; lineH: number; fontSize: number; hint: string };
}

const polar = (cx: number, cy: number, r: number, a: number) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });

/** An annular sector from angle a0 to a1 (radians, clockwise), or the whole annulus. */
function wedgePath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const full = a1 - a0 >= Math.PI * 2 - 1e-9;
  if (full) {
    const ring = (r: number, sweep: 0 | 1) =>
      `M${px(cx + r)} ${px(cy)}A${px(r)} ${px(r)} 0 1 ${sweep} ${px(cx - r)} ${px(cy)}A${px(r)} ${px(r)} 0 1 ${sweep} ${px(cx + r)} ${px(cy)}Z`;
    return `${ring(r1, 1)}${ring(r0, 0)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => {
    const q = polar(cx, cy, r, a);
    return `${px(q.x)} ${px(q.y)}`;
  };
  return `M${p(r0, a0)}L${p(r1, a0)}A${px(r1)} ${px(r1)} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${px(r0)} ${px(r0)} 0 ${large} 0 ${p(r0, a0)}Z`;
}

/**
 * The FIT at the outer edge and the ring step: 0 with rings every .25 when the results span more
 * than half the scale (S9 returns 15 per domain, so usually 0 to 1), else the .1 step under the
 * lowest FIT, so a short list still fills the plot.
 */
export function radialDomain(fits: readonly number[]): { lo: number; step: number } {
  const min = fits.length > 0 ? clamp(Math.min(...fits), 0, 1) : 0;
  const step = 1 - min <= 0.5 ? 0.1 : 0.25;
  const lo = Number((Math.floor(min / step + 1e-9) * step).toFixed(2));
  return { lo: lo >= 1 ? Number((1 - step).toFixed(2)) : lo, step };
}

/** Results by FIT, highest first; equal FIT keeps rank, then key order. */
function byFit(rows: readonly { row: RankedRow; fit: number }[]) {
  return [...rows].sort((a, b) => b.fit - a.fit || (a.row.rank ?? Infinity) - (b.row.rank ?? Infinity) || a.row.key.localeCompare(b.row.key));
}

/**
 * The whole drawing at one width, computed up front and deterministic: geometry, every node, the
 * default labels (across domains) and each domain's focused labels.
 */
export function layoutConstellation(
  data: ConstellationData,
  seedList: readonly ConstellationSeed[],
  fit: number,
  halo: ReadonlyMap<string, readonly string[]>,
  width: number,
  compact: boolean,
  perDomain: number,
  style: NumberStyle,
): Layout {
  const side = compact ? 80 : 158;
  const r1 = clamp(width / 2 - side, 60, 182);
  const r0 = Math.round(r1 * 0.26);
  const margin = compact ? 46 : 56;
  const plotHeight = Math.round(2 * (r1 + margin));
  const cx = width / 2;
  const cy = plotHeight / 2;
  const fontSize = compact ? 10.5 : 11;
  const n = Math.max(1, data.groups.length);
  const span = (Math.PI * 2) / n;
  const start = -Math.PI / 2;
  const pad = Math.min(span * 0.12, (8 * Math.PI) / 180);
  const fits = data.groups.flatMap((g) => g.rows.flatMap((r) => (fitOf(r, fit) === null ? [] : [fitOf(r, fit)!])));
  const { lo, step } = radialDomain(fits);
  const radius = (f: number) => r0 + ((1 - clamp(f, lo, 1)) / (1 - lo)) * (r1 - r0);
  const edges = hasEdges(data, seedList);

  // Seeds: one in the centre (named in the legend); two or more on a small circle, coded.
  const codes = axisCodes(seedList.map((s) => ({ key: s.ref, label: s.label })));
  const rs = seedList.length > 1 ? r0 * 0.5 : 0;
  const seeds = seedList.map((s, i) => {
    const a = Math.PI + (i * Math.PI * 2) / Math.max(1, seedList.length);
    const at = polar(cx, cy, rs, a);
    return { ref: s.ref, label: s.label, code: codes.get(s.ref) ?? "?", x: at.x, y: at.y };
  });
  const seedAt = new Map(seeds.map((s) => [s.ref, s]));

  // Fixed obstacles: the seed disc and codes, the ring values on the top boundary, the domain titles.
  const reserved: Box[] = [{ x: cx - r0 * 0.75, y: cy - r0 * 0.75, w: r0 * 1.5, h: r0 * 1.5 }];
  for (const s of seeds) {
    const w = textWidth(s.code, 8.5, { weight: 600, tracking: 0.6 });
    reserved.push({ x: s.x - 8, y: s.y - 8, w: 16, h: 16 }, { x: s.x - w / 2, y: s.y - 17, w, h: 10 });
  }
  const ringValues: number[] = [];
  for (let k = 1; 1 - k * step >= lo - 1e-9; k++) ringValues.push(Number((1 - k * step).toFixed(2)));
  const rings = ringValues.map((f) => {
    const r = radius(f);
    return { r, text: formatNumber(f, "pct", { leadingZero: false }), x: cx + 3, y: cy - r - 2.5, outer: Math.abs(f - lo) < 1e-9 };
  });
  for (const ring of rings) reserved.push({ x: ring.x, y: ring.y - 8, w: textWidth(ring.text, 9) + 2, h: 10 });

  const boundaries =
    n > 1
      ? data.groups.map((_, i) => {
          const a = start + i * span;
          const p0 = polar(cx, cy, r0, a);
          const p1 = polar(cx, cy, r1, a);
          return { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y };
        })
      : [];

  const sectors: Sector[] = data.groups.map((group, i) => {
    const a0 = start + i * span;
    const mid = a0 + span / 2;
    const placed = group.rows.flatMap((row) => {
      const f = fitOf(row, fit);
      return f === null ? [] : [{ row, fit: f }];
    });
    const ordered = byFit(placed);
    const named = new Set(ordered.slice(0, perDomain).map((p) => p.row.key));
    const nodes: Node[] = ordered.map(({ row, fit: f }, j) => {
      const t = (0.5 + j * GOLDEN) % 1;
      const a = n === 1 ? start + t * Math.PI * 2 : a0 + pad + t * (span - 2 * pad);
      const at = polar(cx, cy, radius(f), a);
      const pick = row.flags.includes("UTR");
      return {
        key: row.key,
        row,
        fit: f,
        x: at.x,
        y: at.y,
        named: named.has(row.key) || pick,
        pick,
        edges: edges
          ? row.explain.flatMap((e) => {
              const s = seedAt.get(e.seedRef);
              return s ? [{ x: s.x, y: s.y, share: e.share }] : [];
            })
          : [],
      };
    });
    const title = sectorTitle(group, halo.get(group.key) ?? [], cx, cy, r1, mid, compact, width);
    reserved.push(...titleBoxes(title));
    return {
      key: group.key,
      label: group.label,
      title,
      wedge: wedgePath(cx, cy, r0 - 4, r1 + 6, a0, a0 + span),
      nodes,
      labels: [],
      focusLabels: [],
      overflow: { lines: [], prefix: "", names: [] },
      summary: sectorSummary(group.label, ordered, style),
      empty: nodes.length === 0,
    };
  });

  const bounds = { x0: 2, y0: 2, x1: width - 2, y1: plotHeight - 2 };
  const allDots = sectors.flatMap((s) => s.nodes);
  // Default view: picks first, then the named results by FIT, across every domain.
  const defaults = allDots.filter((d) => d.named).sort((a, b) => Number(b.pick) - Number(a.pick) || b.fit - a.fit || a.key.localeCompare(b.key));
  const placed = placeLabels(defaults, allDots, reserved, bounds, { x: cx, y: cy }, fontSize, style);
  const stripFont = compact ? 10.5 : 11;
  const stripX = 8;
  for (const sector of sectors) {
    const own = new Set(sector.nodes.map((d) => d.key));
    sector.labels = placed.filter((l) => own.has(l.key));
    // Focused view: every result of the domain, against its own dots and the fixed marks only.
    const focusOrder = [...sector.nodes].sort((a, b) => Number(b.pick) - Number(a.pick) || b.fit - a.fit || a.key.localeCompare(b.key));
    sector.focusLabels = placeLabels(focusOrder, sector.nodes, reserved, bounds, { x: cx, y: cy }, fontSize, style);
    // What found no room beside its dot goes on the line under the plot, so focus names every result.
    const labelled = new Set(sector.focusLabels.map((l) => l.key));
    const names = focusOrder.filter((d) => !labelled.has(d.key)).map((d) => `${d.row.label} ${formatNumber(d.fit, "pct", style)}`);
    const prefix = `Also in ${sector.label}: `;
    sector.overflow = { prefix, names, lines: names.length > 0 ? wrapList(prefix, names, width - 2 * stripX, stripFont) : [] };
  }

  // One line under the plot at least: the hint by default, a focused domain's unlabelled results on focus.
  const lineH = compact ? 13 : 14;
  const lines = Math.max(1, ...sectors.map((s) => s.overflow.lines.length));
  const height = plotHeight + 4 + lines * lineH;
  const strip = { x: stripX, y: plotHeight + lineH - 1, lineH, fontSize: stripFont, hint: "Focus, hover or tap a domain to name every result in it." };
  return { width, height, cx, cy, r0, r1, compact, fontSize, sectors, boundaries, rings, seeds, spokes: !edges, strip };
}

/**
 * A list wrapped greedily to a width: the prefix (set semibold) opens the first line, " · " joins the
 * items and closes every line but the last; an item too long for a line of its own is cut.
 */
export function wrapList(prefix: string, items: readonly string[], room: number, size: number): string[] {
  const bold = textWidth(prefix, size, { weight: 600 }) - textWidth(prefix, size);
  const width = (line: string, first: boolean) => textWidth(line, size) + (first ? bold : 0);
  const lines: string[] = [];
  let line = prefix;
  let empty = true;
  for (const item of items) {
    const next = empty ? `${line}${item}` : `${line} · ${item}`;
    if (!empty && width(`${next} ·`, lines.length === 0) > room) {
      lines.push(`${line} ·`);
      line = item;
    } else {
      line = next;
    }
    empty = false;
  }
  lines.push(line);
  return lines.map((l, k) => (width(l, k === 0) > room ? fitText(l, room - (k === 0 ? bold : 0), size) : l));
}

function sectorTitle(
  group: DomainGroup,
  halo: readonly string[],
  cx: number,
  cy: number,
  r1: number,
  mid: number,
  compact: boolean,
  width: number,
): Sector["title"] {
  const at = polar(cx, cy, r1 + (compact ? 10 : 14), mid);
  const cos = Math.cos(mid);
  const sin = Math.sin(mid);
  const anchor: "start" | "end" | "middle" = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
  const room = anchor === "start" ? width - at.x - 4 : anchor === "end" ? at.x - 4 : Math.min(at.x, width - at.x) * 2 - 8;
  // One line when the name fits, else split at its first " · ".
  const name = group.label.toUpperCase();
  const parts = name.split(/\s+·\s+/);
  const split = textWidth(name, 9.5, TITLE_FONT) > room && parts.length > 1;
  const lines = (split ? [parts[0]!, parts.slice(1).join(" · ")] : [name]).map((l) => fitText(l, room, 9.5, TITLE_FONT));
  const haloText = !compact && halo.length > 0 ? fitText(halo.join(" · "), Math.min(room, 170), 10) : null;
  const lineH = 12;
  const count = lines.length + (haloText ? 1 : 0);
  // Above the plot the block grows upward, below it downward, at the sides it centres on the angle.
  const top = sin < -0.3 ? at.y - (count - 1) * lineH : sin > 0.3 ? at.y + 8 : at.y - ((count - 1) * lineH) / 2 + 3.5;
  return { lines, halo: haloText, x: at.x, y: top, anchor, lineH };
}

function titleBoxes(title: Sector["title"]): Box[] {
  const texts = [...title.lines.map((l) => ({ w: textWidth(l, 9.5, TITLE_FONT) })), ...(title.halo ? [{ w: textWidth(title.halo, 10) }] : [])];
  return texts.map((t, k) => {
    const x = title.anchor === "start" ? title.x : title.anchor === "end" ? title.x - t.w : title.x - t.w / 2;
    return { x, y: title.y + k * title.lineH - 9, w: t.w, h: 11 };
  });
}

/**
 * Greedy, deterministic label placement: next to the dot (outward from the centre, above, below,
 * inward), then further out on a leader, twice as far for a pick; else no label (the focused view
 * and the table still name it).
 */
function placeLabels(
  order: readonly Node[],
  dots: readonly Node[],
  reserved: readonly Box[],
  bounds: { x0: number; y0: number; x1: number; y1: number },
  centre: { x: number; y: number },
  fontSize: number,
  style: NumberStyle,
): Label[] {
  const { x: cx, y: cy } = centre;
  const taken: Box[] = [...reserved];
  // The first reserved box is the seed disc.
  const hub = reserved[0] ?? { x: cx, y: cy, w: 0, h: 0 };
  const dotBoxes = dots.map((d) => ({ key: d.key, box: { x: d.x - 5, y: d.y - 5, w: 10, h: 10 } }));
  const namedBoxes = dotBoxes.filter((_, i) => dots[i]!.named);
  const out: Label[] = [];
  for (const node of order) {
    const size = node.pick ? fontSize + 0.5 : fontSize;
    const weight = node.pick ? 600 : 400;
    const h = size + 1;
    const ring = node.pick ? 7.5 : 4;
    // The ray from the centre through the dot: where its sector widens.
    const len = Math.hypot(node.x - cx, node.y - cy) || 1;
    const ux = (node.x - cx) / len;
    const uy = (node.y - cy) / len;
    const near = node.pick ? 10 : 6;
    const candidatesFor = (text: string): Candidate[] => {
      const w = textWidth(text, size, { weight });
      const around = (gap: number): Candidate[] => {
        const lead = gap > near;
        const leader = (x2: number, y2: number) => (lead ? { x1: node.x, y1: node.y, x2, y2 } : null);
        const at = (x: number, y: number, anchor: Label["anchor"], lx: number, ly: number): Candidate => ({
          text,
          box: { x: anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2, y: y - h + 2.5, w, h },
          x,
          y,
          anchor,
          leader: leader(lx, ly),
        });
        const right = at(node.x + gap, node.y + 3.5, "start", node.x + gap - 2, node.y);
        const left = at(node.x - gap, node.y + 3.5, "end", node.x - gap + 2, node.y);
        const rx = node.x + ux * gap;
        const ry = node.y + uy * gap;
        const radial = at(rx + (ux >= 0 ? 1 : -1), ry + 3.5, ux >= 0 ? "start" : "end", rx, ry);
        const above = at(node.x, node.y - gap - 2, "middle", node.x, node.y - gap + 1);
        const below = at(node.x, node.y + gap + h - 2, "middle", node.x, node.y + gap - 1);
        return node.x >= cx ? [right, radial, above, below, left] : [left, radial, above, below, right];
      };
      return [...around(near), ...around(near + 16), ...around(near + 30), ...(node.pick ? [...around(near + 46), ...around(near + 62)] : [])];
    };
    const free = (c: Candidate, obstacles: readonly { key: string; box: Box }[]) =>
      c.box.x >= bounds.x0 &&
      c.box.x + c.box.w <= bounds.x1 &&
      c.box.y >= bounds.y0 &&
      c.box.y + c.box.h <= bounds.y1 &&
      !taken.some((t) => overlaps(t, c.box)) &&
      !obstacles.some((d) => d.key !== node.key && overlaps(d.box, c.box)) &&
      // A leader crosses neither another dot nor the seeds on its way out.
      (c.leader === null ||
        (!segmentHitsBox(c.leader, hub, ring) && !obstacles.some((d) => d.key !== node.key && segmentHitsBox(c.leader!, d.box, ring))));
    // A pick is always named, with its FIT where it fits and by name alone where not; failing that
    // it may cover grey (unnamed) dots, then any dot but its own. It never covers another label.
    const full = candidatesFor(node.pick ? `${node.row.label} · ${formatNumber(node.fit, "pct", style)}` : node.row.label);
    const bare = node.pick ? candidatesFor(node.row.label) : [];
    const fit =
      full.find((c) => free(c, dotBoxes)) ??
      bare.find((c) => free(c, dotBoxes)) ??
      full.find((c) => free(c, namedBoxes)) ??
      bare.find((c) => free(c, namedBoxes)) ??
      bare.find((c) => free(c, []));
    if (!fit) continue;
    taken.push(fit.box);
    out.push({ key: node.key, text: fit.text, x: fit.x, y: fit.y, anchor: fit.anchor, featured: node.pick, leader: fit.leader });
  }
  return out;
}

interface Candidate {
  text: string;
  box: Box;
  x: number;
  y: number;
  anchor: Label["anchor"];
  leader: Label["leader"];
}

/** Whether a leader (from a dot's centre, past its own mark of radius `skip`) passes through a box. */
function segmentHitsBox(seg: { x1: number; y1: number; x2: number; y2: number }, box: Box, skip: number): boolean {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  for (let d = skip; d <= len; d += 2) {
    const x = seg.x1 + ((seg.x2 - seg.x1) * d) / len;
    const y = seg.y1 + ((seg.y2 - seg.y1) * d) / len;
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return true;
  }
  return false;
}

// Text -------------------------------------------------------------------------------------------------

/** The seed(s) a result leans on, by name; a seed the figure does not name reads "a seed", never its ref. */
function leanText(row: RankedRow, seeds: ReadonlyMap<string, string>, style: NumberStyle): string {
  const pct = (share: number) => `${formatNumber(share * 100, "count", { ...style, digits: 0 })}%`;
  const name = (ref: string) => seeds.get(ref) ?? "a seed";
  if (row.explain.length > 0) return row.explain.map((e) => `${name(e.seedRef)} (${pct(e.share)})`).join(", ");
  if (row.shares && row.shares.length > 0) return `no clear lean (${row.shares.map((s) => `${name(s.seedRef)} ${pct(s.share)}`).join(", ")})`;
  return "";
}

/** The domain stop's accessible name: every result by fit, then the pick. */
function sectorSummary(label: string, ordered: readonly { row: RankedRow; fit: number }[], style: NumberStyle): string {
  if (ordered.length === 0) return `${label}: not measured.`;
  const names = ordered.map(({ row, fit }) => `${row.label} ${formatNumber(fit, "pct", style)}`);
  const pick = ordered.find((o) => o.row.flags.includes("UTR"));
  const utr = pick ? ` Under the radar: ${pick.row.label}.` : "";
  return `${label}: ${ordered.length} result${ordered.length === 1 ? "" : "s"} by fit, ${names.join(", ")}.${utr}`;
}

function nodeTitle(node: Node, domain: string, data: ConstellationData, style: NumberStyle, seeds: ReadonlyMap<string, string>): string {
  const values = data.columns
    .map((c, i) => {
      const t = cellText(node.row.cells[i] ?? { value: null, reason: null }, c.unit, style);
      return `${c.label} ${t.kind === "value" ? t.text : t.reason}`;
    })
    .join(", ");
  const lean = seeds.size > 0 ? leanText(node.row, seeds, style) : "";
  return `${node.row.label} · ${domain}: ${values}${lean ? ` · leans on ${lean}` : ""}${node.pick ? " · under the radar" : ""}`;
}

// Drawing ----------------------------------------------------------------------------------------------

function ConstellationSvg({ layout, data, label, style }: { layout: Layout; data: ConstellationData; label: string; style: NumberStyle }) {
  const L = layout;
  const seedNames = new Map(L.seeds.map((s) => [s.ref, s.label]));
  const placedCount = L.sectors.reduce((s, x) => s + x.nodes.length, 0);
  return (
    <svg
      viewBox={`0 0 ${L.width} ${L.height}`}
      width="100%"
      role="group"
      aria-label={label}
      className="group/constellation block h-auto font-ui"
      style={{ maxWidth: L.width }}
      data-constellation={L.compact ? "compact" : "wide"}
    >
      <title>{label}</title>
      <desc>
        {`${placedCount} results in ${L.sectors.length} domains around ${L.seeds.length === 0 ? "the seeds" : L.seeds.length === 1 ? L.seeds[0]!.label : `${L.seeds.length} seeds`}; nearer the centre is a higher fit. Each domain is one stop for the keyboard. The table view lists every result.`}
      </desc>

      {/* Fit rings and the sector boundaries. */}
      <circle cx={px(L.cx)} cy={px(L.cy)} r={px(L.r1)} className="fill-none stroke-line-strong" />
      {L.rings
        .filter((ring) => !ring.outer)
        .map((ring) => (
          <circle key={ring.text} cx={px(L.cx)} cy={px(L.cy)} r={px(ring.r)} strokeDasharray="2 3" className="fill-none stroke-line-strong" />
        ))}
      <circle cx={px(L.cx)} cy={px(L.cy)} r={px(L.r0)} className="fill-canvas stroke-line" />
      {L.boundaries.map((b, i) => (
        <line key={`b-${i}`} x1={px(b.x1)} y1={px(b.y1)} x2={px(b.x2)} y2={px(b.y2)} className="stroke-line" />
      ))}

      {L.sectors.map((sector) => (
        <g
          key={sector.key}
          data-domain={sector.key}
          tabIndex={0}
          role="img"
          aria-label={sector.summary}
          className="group cursor-default outline-none transition-opacity duration-150 group-has-[[data-domain]:focus]/constellation:opacity-30 group-has-[[data-domain]:hover]/constellation:opacity-30 hover:opacity-100! focus:opacity-100!"
        >
          <path d={sector.wedge} className="fill-accent-soft opacity-0 group-hover:opacity-100 group-focus:opacity-100" />
          <path
            d={sector.wedge}
            strokeWidth={1.5}
            className="fill-none stroke-accent opacity-0 group-focus-visible:opacity-100"
            data-focus-ring="true"
          />
          {sector.nodes.map((node) =>
            L.spokes ? (
              <line
                key={`s-${node.key}`}
                x1={px(L.cx)}
                y1={px(L.cy)}
                x2={px(node.x)}
                y2={px(node.y)}
                className="stroke-line group-hover:stroke-line-strong group-focus:stroke-line-strong"
              />
            ) : (
              node.edges.map((e, k) => (
                <line
                  key={`e-${node.key}-${k}`}
                  x1={px(e.x)}
                  y1={px(e.y)}
                  x2={px(node.x)}
                  y2={px(node.y)}
                  strokeWidth={px(0.5 + e.share * 1.5)}
                  className="stroke-line-strong group-hover:stroke-accent group-focus:stroke-accent"
                  data-edge={node.key}
                />
              ))
            ),
          )}
          {sector.nodes.map((node) => (
            <g key={node.key} data-node={node.key} data-tone={node.pick ? "featured" : node.named ? "named" : "other"}>
              <title>{nodeTitle(node, sector.label, data, style, seedNames)}</title>
              {node.pick ? <circle cx={px(node.x)} cy={px(node.y)} r={7.5} className="fill-none stroke-data" /> : null}
              <circle
                cx={px(node.x)}
                cy={px(node.y)}
                r={node.named ? 4 : 3}
                strokeWidth={node.named ? 1.5 : 1}
                className={`stroke-paper ${node.named ? "fill-data" : "fill-data-2 group-hover:fill-data group-focus:fill-data"}`}
              />
            </g>
          ))}
          {/* While any domain is focused or hovered, only its labels show: the others' would sit under its own. */}
          <g
            className="group-has-[[data-domain]:focus]/constellation:opacity-0 group-has-[[data-domain]:hover]/constellation:opacity-0"
            data-labels="default"
          >
            {sector.labels.map((l) => (
              <NodeLabel key={l.key} label={l} size={L.fontSize} />
            ))}
          </g>
          <g className="opacity-0 group-hover:opacity-100 group-focus:opacity-100" data-labels="focus" aria-hidden="true">
            {sector.focusLabels.map((l) => (
              <NodeLabel key={l.key} label={l} size={L.fontSize} />
            ))}
            {sector.overflow.lines.map((line, k) => (
              <text key={`o-${k}`} x={px(L.strip.x)} y={px(L.strip.y + k * L.strip.lineH)} fontSize={L.strip.fontSize} className="fill-text-2" data-overflow={sector.key}>
                {k === 0 ? (
                  <>
                    <tspan fontWeight={600} className="fill-dim">
                      {sector.overflow.prefix.trimEnd()}
                    </tspan>{" "}
                    {line.slice(sector.overflow.prefix.length)}
                  </>
                ) : (
                  line
                )}
              </text>
            ))}
          </g>
        </g>
      ))}
      <text
        x={px(L.strip.x)}
        y={px(L.strip.y)}
        fontSize={L.strip.fontSize}
        className="fill-dim transition-opacity duration-150 group-has-[[data-domain]:focus]/constellation:opacity-0 group-has-[[data-domain]:hover]/constellation:opacity-0"
        aria-hidden="true"
        data-hint="true"
      >
        {L.strip.hint}
      </text>

      {/* Ring values on the top boundary, the domain names, then the seeds above everything. */}
      {L.rings.map((ring) => (
        <text
          key={`rt-${ring.text}`}
          x={px(ring.x)}
          y={px(ring.y)}
          fontSize={9}
          strokeWidth={3}
          paintOrder="stroke"
          className="fill-faint stroke-paper tabular-nums"
          aria-hidden="true"
        >
          {ring.text}
        </text>
      ))}
      {L.sectors.map((sector) => (
        <g key={`t-${sector.key}`} aria-hidden="true">
          {sector.title.lines.map((line, k) => (
            <text
              key={k}
              x={px(sector.title.x)}
              y={px(sector.title.y + k * sector.title.lineH)}
              textAnchor={sector.title.anchor}
              fontSize={9.5}
              fontWeight={600}
              letterSpacing={1}
              className={sector.empty ? "fill-faint" : "fill-dim"}
            >
              {line}
            </text>
          ))}
          {sector.title.halo ? (
            <text
              x={px(sector.title.x)}
              y={px(sector.title.y + sector.title.lines.length * sector.title.lineH)}
              textAnchor={sector.title.anchor}
              fontSize={10}
              fontStyle="italic"
              className="fill-dim"
            >
              {sector.title.halo}
            </text>
          ) : null}
          {sector.empty ? (
            <text
              x={px(sector.title.x)}
              y={px(sector.title.y + sector.title.lines.length * sector.title.lineH)}
              textAnchor={sector.title.anchor}
              fontSize={10}
              fontStyle="italic"
              className="fill-dim"
            >
              not measured
            </text>
          ) : null}
        </g>
      ))}
      {L.seeds.map((s) => (
        <g key={s.ref} data-seed={s.ref} aria-hidden="true">
          <circle cx={px(s.x)} cy={px(s.y)} r={L.seeds.length > 1 ? 4.5 : 6} strokeWidth={2} className="fill-ink stroke-paper" />
          {L.seeds.length > 1 ? (
            <text
              x={px(s.x)}
              y={px(s.y + (s.y > L.cy + 0.5 ? 14 : -8))}
              textAnchor="middle"
              fontSize={8.5}
              fontWeight={600}
              letterSpacing={0.6}
              strokeWidth={3}
              paintOrder="stroke"
              className="fill-ink stroke-canvas"
            >
              {s.code}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function NodeLabel({ label, size }: { label: Label; size: number }) {
  return (
    <>
      {label.leader ? (
        <line
          x1={px(label.leader.x1)}
          y1={px(label.leader.y1)}
          x2={px(label.leader.x2)}
          y2={px(label.leader.y2)}
          className={label.featured ? "stroke-accent" : "stroke-faint"}
        />
      ) : null}
      <text
        x={px(label.x)}
        y={px(label.y)}
        textAnchor={label.anchor}
        fontSize={label.featured ? size + 0.5 : size}
        fontWeight={label.featured ? 600 : 400}
        strokeWidth={3}
        paintOrder="stroke"
        className={`stroke-paper ${label.featured ? "fill-accent" : "fill-text-2"}`}
      >
        {label.text}
      </text>
    </>
  );
}

/** Seeds and how to read the distance, above the plot. */
function SeedLegend({ seeds, edges }: { seeds: readonly ConstellationSeed[]; edges: boolean }) {
  const codes = axisCodes(seeds.map((s) => ({ key: s.ref, label: s.label })));
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-[18px] gap-y-1 p-0 font-ui text-[12px] text-text-2">
      {seeds.map((s) => (
        <li key={s.ref} className="flex items-center gap-1.5">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" className="fill-ink" />
          </svg>
          {seeds.length > 1 ? <span className="text-[10.5px] font-semibold tracking-[0.6px] text-ink">{codes.get(s.ref)}</span> : null}
          <span>
            {seeds.length > 1 ? "" : "Seed: "}
            {s.label}
          </span>
        </li>
      ))}
      <li className="text-[11.5px] text-dim">
        {edges ? "Nearer the centre = higher fit · a line = the seed a result leans on" : "Nearer the centre = higher fit"}
      </li>
    </ul>
  );
}

// Table ------------------------------------------------------------------------------------------------

/**
 * The table view: every result by domain (the halo in the domain heading), with rank, genre, every
 * column of the payload, the seed it leans on and its flags; a result without a value says why.
 */
export function constellationTableSpec(
  data: ConstellationData,
  caption: string,
  style: NumberStyle,
  opts: { seeds?: readonly ConstellationSeed[]; halo?: ReadonlyMap<string, readonly string[]> } = {},
) {
  const seeds = new Map((opts.seeds ?? data.seeds ?? []).map((s) => [s.ref, s.label]));
  const rows = data.groups.flatMap((g) => g.rows);
  const withSub = rows.some((r) => r.sublabel !== null);
  // Leans are named by seed; without the seeds' names the column would print bare refs, so it is left out.
  const withLean = seeds.size > 0 && rows.some((r) => r.explain.length > 0 || (r.shares?.length ?? 0) > 0);
  const withFlags = rows.some((r) => r.flags.length > 0);
  const columns: TableColumn[] = [
    { label: "Result" },
    { label: "Rank", numeric: true },
    ...(withSub ? [{ label: "Genre" }] : []),
    ...data.columns.map((c) => ({ label: c.comparator ? `${c.label} (${COMPARATOR_PHRASE[c.comparator]})` : c.label, numeric: true })),
    ...(withLean ? [{ label: "Leans on" }] : []),
    ...(withFlags ? [{ label: "Flags" }] : []),
  ];
  const out: TableRow[] = [];
  for (const group of data.groups) {
    const tags = opts.halo?.get(group.key) ?? group.halo ?? [];
    out.push({ key: `section-${group.key}`, section: tags.length > 0 ? `${group.label} · top tags: ${tags.join(", ")}` : group.label });
    for (const row of group.rows) {
      const cells: TableCell[] = [
        row.label,
        row.rank === null ? "—" : String(row.rank),
        ...(withSub ? [row.sublabel ?? ""] : []),
        ...row.cells.map((c, i) => cellText(c, data.columns[i]?.unit ?? "score", style)),
        ...(withLean ? [leanText(row, seeds, style)] : []),
        ...(withFlags ? [row.flags.map((f) => FLAG_LABEL[f]).join(", ")] : []),
      ];
      out.push({ key: `${group.key}-${row.key}`, cells });
    }
  }
  return { caption, columns, rows: out };
}
