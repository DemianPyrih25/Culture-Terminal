import type { DatasetEnvelope } from "@ct/contracts";
import type { ReactNode } from "react";
import { DivergingBars, type DivergingBarsOptions } from "./diverging-bars";
import { FigureFrame, type FigureMeta } from "./figure-frame";
import { LiftMap, type LiftMapOptions } from "./lift-map";
import { MatrixGrid, type MatrixGridOptions } from "./matrix-grid";
import { MomentumStrip, type MomentumStripOptions } from "./momentum-strip";
import { PositionCard, type PositionCardOptions } from "./position-card";
import { QuadrantScatter, type QuadrantScatterOptions } from "./quadrant-scatter";
import { RankedTable, slateToRanked, type RankedTableOptions } from "./ranked-table";
import { ScorecardTable, type ScorecardOptions } from "./scorecard-table";
import { SlopeChart, type SlopeChartOptions } from "./slope-chart";

/**
 * One exhibit from its dataset envelope: code picks the family by VIZ_COMPAT[kind] (PLAN §10.1),
 * never the model. Every DatasetKind has its family; the switch is exhaustive, so a new kind fails
 * the type check until it is drawn.
 */

/** Display options per dataset kind, e.g. { Bars: { display: "split" } } for a head-to-head. */
export interface ExhibitDisplay {
  Matrix?: MatrixGridOptions;
  Ranked?: RankedTableOptions;
  Slate?: RankedTableOptions;
  Bars?: DivergingBarsOptions;
  Quadrant?: QuadrantScatterOptions;
  Scorecard?: ScorecardOptions;
  Slope?: SlopeChartOptions;
  GeoLift?: LiftMapOptions;
  Momentum?: MomentumStripOptions;
  Position?: PositionCardOptions;
}

export type ExhibitProps = Omit<FigureMeta, "title"> & {
  dataset: DatasetEnvelope;
  /** Defaults to the dataset title; the brief passes the exhibit title (the finding). */
  title?: ReactNode;
  display?: ExhibitDisplay;
};

export function Exhibit({ dataset, display = {}, ...rest }: ExhibitProps) {
  const meta: FigureMeta = {
    ...rest,
    title: rest.title ?? dataset.title,
    formulaId: rest.formulaId === undefined ? (dataset.formulaIds[0] ?? null) : rest.formulaId,
  };
  switch (dataset.kind) {
    case "Matrix":
      return <MatrixGrid {...meta} {...display.Matrix} data={dataset.payload} />;
    case "Ranked":
      return <RankedTable {...meta} {...display.Ranked} data={dataset.payload} />;
    case "Slate":
      return (
        <RankedTable
          variant="table"
          labelHeader="Best fit"
          sublabelHeader="Category"
          {...meta}
          {...display.Slate}
          data={slateToRanked(dataset.payload)}
        />
      );
    case "Bars":
      return <DivergingBars {...meta} {...display.Bars} data={dataset.payload} />;
    case "Quadrant":
      return <QuadrantScatter {...meta} {...display.Quadrant} data={dataset.payload} />;
    case "Scorecard":
      return <ScorecardTable {...meta} {...display.Scorecard} data={dataset.payload} />;
    case "Slope":
      return <SlopeChart {...meta} {...display.Slope} data={dataset.payload} />;
    case "GeoLift":
      return <LiftMap {...meta} {...display.GeoLift} data={dataset.payload} />;
    case "Momentum":
      return <MomentumStrip {...meta} {...display.Momentum} data={dataset.payload} />;
    case "Position":
      return <PositionCard {...meta} {...display.Position} data={dataset.payload} />;
    default: {
      // Exhaustive: a new DatasetKind fails the type check here. At run time (a newer server) it frames a note.
      const unknown: never = dataset;
      return <FigurePending {...meta} note={`${(unknown as DatasetEnvelope).kind} · no figure family for this kind`} />;
    }
  }
}

/** A framed figure whose plot is not drawable yet: a dataset still computing or still loading. */
export function FigurePending({ note, ...meta }: FigureMeta & { note: string }) {
  const box = (
    <div className="flex h-[120px] items-center justify-center bg-canvas" role="status">
      <span className="type-trace text-dim">{note}</span>
    </div>
  );
  return <FigureFrame meta={meta} plot={box} table={null} />;
}
