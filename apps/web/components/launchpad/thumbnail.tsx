import type { DatasetKind } from "@ct/contracts";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";

/**
 * The small static figure on a showcase tile (PLAN §8.1): the shape of the brief's first exhibit, drawn
 * from its dataset kind alone. A glyph, not a chart: no value in it comes from Qloo or from the run.
 * Decorative; the tile's finding says what the figure found.
 */

const W = 72;
const H = 48;

// Fills and strokes in the two data colours and the hairline, as the figures draw them.
const DATA = "fill-data";
const DATA_2 = "fill-data-2";
const RULE = "stroke-line-strong";

/** Matrix: a heat grid, darker where the pair is closer. */
function matrixGlyph() {
  const shade = [
    [1, 0.55, 0.3, 0.15],
    [0.55, 1, 0.4, 0.2],
    [0.3, 0.4, 1, 0.6],
    [0.15, 0.2, 0.6, 1],
  ];
  return (
    <>
      {shade.flatMap((row, r) =>
        row.map((o, c) => <rect key={`${r}-${c}`} x={14 + c * 11} y={3 + r * 11} width={10} height={10} className={DATA} opacity={o} />),
      )}
    </>
  );
}

/** Quadrant: two axes and a scatter, a few points standing out. */
function quadrantGlyph() {
  const dots: [number, number, boolean][] = [
    [14, 34, false],
    [22, 30, false],
    [28, 38, false],
    [44, 28, false],
    [50, 34, false],
    [30, 18, false],
    [54, 12, true],
    [60, 18, true],
  ];
  return (
    <>
      <line x1={36} y1={3} x2={36} y2={45} className={RULE} strokeWidth={1} />
      <line x1={6} y1={24} x2={66} y2={24} className={RULE} strokeWidth={1} />
      {dots.map(([x, y, lead]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={lead ? 3 : 2.25} className={lead ? DATA : DATA_2} />
      ))}
    </>
  );
}

/** Bars: diverging bars around a centre line. */
function barsGlyph() {
  const bars = [22, -14, 16, -24, 10];
  return (
    <>
      {bars.map((len, i) => (
        <rect key={i} x={len >= 0 ? 36 : 36 + len} y={5 + i * 8} width={Math.abs(len)} height={5} className={len >= 0 ? DATA : DATA_2} />
      ))}
      <line x1={36} y1={2} x2={36} y2={46} className={RULE} strokeWidth={1} />
    </>
  );
}

/** Slope: two columns joined, one line rising against the rest. */
function slopeGlyph() {
  const lines: [number, number, boolean][] = [
    [14, 30, false],
    [22, 14, false],
    [34, 38, false],
    [38, 8, true],
  ];
  return (
    <>
      <line x1={14} y1={4} x2={14} y2={44} className={RULE} strokeWidth={1} />
      <line x1={58} y1={4} x2={58} y2={44} className={RULE} strokeWidth={1} />
      {lines.map(([from, to, lead]) => (
        <g key={`${from}-${to}`} className={lead ? "fill-data stroke-data" : "fill-data-2 stroke-data-2"}>
          <line x1={14} y1={from} x2={58} y2={to} strokeWidth={lead ? 1.75 : 1.25} />
          <circle cx={14} cy={from} r={2} />
          <circle cx={58} cy={to} r={2} />
        </g>
      ))}
    </>
  );
}

/** GeoLift: map cells, a pocket of lift among them. */
function geoLiftGlyph() {
  const hot = new Map([
    ["3-1", 1],
    ["4-1", 0.7],
    ["3-2", 0.8],
    ["4-2", 0.5],
    ["2-1", 0.45],
    ["5-2", 0.3],
  ]);
  const cells: ReactNode[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 8; c++) {
      const lift = hot.get(`${c}-${r}`);
      cells.push(
        <rect
          key={`${c}-${r}`}
          x={4 + c * 8 + (r % 2) * 4}
          y={5 + r * 10}
          width={7}
          height={9}
          className={lift === undefined ? DATA_2 : DATA}
          opacity={lift ?? 0.3}
        />,
      );
    }
  }
  return <>{cells}</>;
}

/** Ranked: a list of bars, longest first. */
function rankedGlyph() {
  const bars = [52, 44, 36, 30, 22];
  return (
    <>
      {bars.map((len, i) => (
        <rect key={i} x={10} y={5 + i * 8} width={len} height={5} className={i === 0 ? DATA : DATA_2} />
      ))}
      <line x1={10} y1={2} x2={10} y2={46} className={RULE} strokeWidth={1} />
    </>
  );
}

/** Slate: table rows, each with a fit mark along its row. */
function slateGlyph() {
  const marks = [50, 34, 58, 26];
  return (
    <>
      {marks.map((x, i) => (
        <g key={i}>
          <rect x={6} y={6 + i * 10} width={14} height={3} className={DATA_2} />
          <line x1={24} y1={7.5 + i * 10} x2={66} y2={7.5 + i * 10} className={RULE} strokeWidth={1} />
          <circle cx={x} cy={7.5 + i * 10} r={2.75} className={i === 2 ? DATA : DATA_2} />
        </g>
      ))}
    </>
  );
}

/** Momentum: a series against its flat start. */
function momentumGlyph() {
  return (
    <>
      <line x1={6} y1={30} x2={66} y2={30} className={RULE} strokeWidth={1} strokeDasharray="2 2" />
      <polyline
        points="6,30 14,28 22,31 30,25 38,24 46,18 54,19 62,12 66,10"
        fill="none"
        className="stroke-data"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </>
  );
}

/** Scorecard: rows of hypotheses, each with its verdict mark. */
function scorecardGlyph() {
  const rows = [36, 28, 40, 24];
  return (
    <>
      {rows.map((len, i) => (
        <g key={i}>
          <rect x={6} y={6 + i * 10} width={len} height={3} className={DATA_2} />
          <rect x={58} y={5 + i * 10} width={8} height={5} className={i === 1 ? "fill-negative" : DATA} />
        </g>
      ))}
    </>
  );
}

/** Position: a scale with the subject marked against its peers. */
function positionGlyph() {
  return (
    <>
      <line x1={6} y1={26} x2={66} y2={26} className={RULE} strokeWidth={1} />
      {[6, 21, 36, 51, 66].map((x) => (
        <line key={x} x1={x} y1={23} x2={x} y2={29} className={RULE} strokeWidth={1} />
      ))}
      <circle cx={24} cy={26} r={2.5} className={DATA_2} />
      <circle cx={31} cy={26} r={2.5} className={DATA_2} />
      <circle cx={54} cy={26} r={4} className={DATA} />
    </>
  );
}

const GLYPH: Readonly<Record<DatasetKind, () => ReactNode>> = {
  Matrix: matrixGlyph,
  Quadrant: quadrantGlyph,
  Bars: barsGlyph,
  Slope: slopeGlyph,
  GeoLift: geoLiftGlyph,
  Ranked: rankedGlyph,
  Slate: slateGlyph,
  Momentum: momentumGlyph,
  Scorecard: scorecardGlyph,
  Position: positionGlyph,
};

export interface ExhibitThumbnailProps {
  /** The first exhibit's dataset kind; null draws the empty frame of a tile with no brief yet. */
  kind: DatasetKind | null;
  className?: string;
}

/** A 72×48 figure glyph on the plot ground, or an empty dashed frame. */
export function ExhibitThumbnail({ kind, className }: ExhibitThumbnailProps) {
  const frame = cx("block shrink-0 rounded-brief", className);
  if (kind === null) {
    return <span aria-hidden="true" data-thumbnail="none" className={cx(frame, "h-12 w-[72px] border border-dashed border-line-strong")} />;
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-thumbnail={kind}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className={cx(frame, "bg-canvas")}
    >
      {GLYPH[kind]()}
    </svg>
  );
}
