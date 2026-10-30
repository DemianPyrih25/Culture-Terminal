import type { DATASET_KIND_VALUES } from "./datasets";

/**
 * The exhibit component families (PLAN §8.4), names frozen: the nine P0 families, TasteMap (Part 10) and
 * SupplyTable (Part 11, OpenStreetMap supply). Zod-free; ../viz-compat.ts builds the schema.
 */
export const VIZ_COMPONENT_VALUES = [
  "ScorecardTable",
  "MatrixGrid",
  "QuadrantScatter",
  "DivergingBars",
  "SlopeChart",
  "LiftMap",
  "RankedTable",
  "MomentumStrip",
  "PositionCard",
  "TasteMap",
  "SupplyTable",
] as const;
type VizComponentV = (typeof VIZ_COMPONENT_VALUES)[number];
type DatasetKindV = (typeof DATASET_KIND_VALUES)[number];

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
  TasteMap: "TasteMap",
  Supply: "SupplyTable",
} as const satisfies Record<DatasetKindV, VizComponentV>;

export function vizFor(kind: DatasetKindV): VizComponentV {
  return VIZ_COMPAT[kind];
}
