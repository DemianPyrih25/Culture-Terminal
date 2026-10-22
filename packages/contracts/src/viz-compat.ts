import { z } from "zod";
import type { DatasetKind } from "./datasets";

/** The nine P0 exhibit component families (PLAN §8.4). Names are frozen. */
export const VizComponent = z.enum([
  "ScorecardTable",
  "MatrixGrid",
  "QuadrantScatter",
  "DivergingBars",
  "SlopeChart",
  "LiftMap",
  "RankedTable",
  "MomentumStrip",
  "PositionCard",
]);
export type VizComponent = z.infer<typeof VizComponent>;

/** Dataset kind → the component that renders it (PLAN §10.1). Code picks the viz; the model never does. */
export const VIZ_COMPAT = {
  Matrix: "MatrixGrid",
  Quadrant: "QuadrantScatter",
  Bars: "DivergingBars",
  Slope: "SlopeChart",
  GeoLift: "LiftMap",
  Ranked: "RankedTable",
  Slate: "RankedTable",
  Momentum: "MomentumStrip",
  Scorecard: "ScorecardTable",
  Position: "PositionCard",
} as const satisfies Record<DatasetKind, VizComponent>;

export type VizFor<K extends DatasetKind> = (typeof VIZ_COMPAT)[K];

export function vizFor(kind: DatasetKind): VizComponent {
  return VIZ_COMPAT[kind];
}
