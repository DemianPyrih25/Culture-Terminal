import type { DatasetKind } from "@ct/contracts";
import { cx } from "../ui/cx";

/**
 * The decorative drawings in a "More charts" link's render box (232 × 64, sunken, r8): bars, diverging,
 * columns or dots, by the figure's family. Hidden from screen readers: the link's name says what it is.
 */

export type GlyphKind = "bars" | "diverging" | "columns" | "dots";

/** The glyph of a dataset's family (spec §2.6, "Glyph by viz family"). */
export function glyphForDataset(kind: DatasetKind, opts: { mode?: "RAW" | "BASE" | "LIFT"; matrixList?: boolean } = {}): GlyphKind {
  switch (kind) {
    case "Ranked":
    case "Slate":
    case "Scorecard":
      return "bars";
    case "Matrix":
      return opts.matrixList ? "bars" : "dots";
    case "Bars":
    case "Position":
      return "diverging";
    case "Momentum":
    case "Slope":
      return "columns";
    case "GeoLift":
      return opts.mode === "RAW" ? "bars" : opts.mode === "BASE" ? "columns" : "dots";
    case "Quadrant":
      return "dots";
    default:
      return "bars";
  }
}

const W = 232;
const H = 64;

function Bars() {
  return (
    <>
      <rect x="14" y="14" width="128" height="5" rx="2" className="fill-accent" />
      <rect x="14" y="25" width="104" height="5" rx="2" className="fill-chart-muted" />
      <rect x="14" y="36" width="86" height="5" rx="2" className="fill-chart-muted" />
      <rect x="14" y="47" width="62" height="5" rx="2" className="fill-chart-muted" />
    </>
  );
}

function Diverging() {
  return (
    <>
      <rect x="115" y="10" width="1.5" height="44" className="fill-ink-3" />
      <rect x="116.5" y="14" width="40" height="5" rx="1" className="fill-accent" />
      <rect x="86" y="24" width="29" height="5" rx="1" className="fill-chart-muted" />
      <rect x="116.5" y="34" width="24" height="5" rx="1" className="fill-accent" />
      <rect x="98" y="44" width="17" height="5" rx="1" className="fill-chart-muted" />
    </>
  );
}

function Columns() {
  const heights = [12, 18, 22, 28, 32, 40];
  return (
    <>
      {heights.map((h, i) => (
        <rect
          key={h}
          x={70 + i * 16}
          y={54 - h}
          width="10"
          height={h}
          rx="1.5"
          className={i === heights.length - 1 ? "fill-accent" : "fill-chart-muted"}
        />
      ))}
    </>
  );
}

function Dots() {
  const dots: readonly (readonly [number, number, boolean])[] = [
    [42, 20, false],
    [66, 38, false],
    [92, 24, true],
    [118, 44, false],
    [140, 18, false],
    [160, 36, true],
    [184, 48, false],
  ];
  return (
    <>
      {dots.map(([x, y, on]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="3.5" className={on ? "fill-accent" : "fill-chart-muted"} />
      ))}
    </>
  );
}

export function ChartGlyph({ kind, className }: { kind: GlyphKind; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      focusable="false"
      data-glyph={kind}
      className={cx("block h-16 w-full", className)}
      preserveAspectRatio="xMinYMid meet"
    >
      {kind === "bars" ? <Bars /> : kind === "diverging" ? <Diverging /> : kind === "columns" ? <Columns /> : <Dots />}
    </svg>
  );
}
