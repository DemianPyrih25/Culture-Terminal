import { VIZ_COMPAT, type DatasetEnvelope } from "@ct/contracts";
import type { ReactNode } from "react";
import { DivergingBars, type DivergingBarsOptions } from "./diverging-bars";
import { FigureFrame, type FigureMeta } from "./figure-frame";
import { MatrixGrid, type MatrixGridOptions } from "./matrix-grid";
import { QuadrantScatter, type QuadrantScatterOptions } from "./quadrant-scatter";
import { RankedTable, slateToRanked, type RankedTableOptions } from "./ranked-table";
import { ScorecardTable, type ScorecardOptions } from "./scorecard-table";

/**
 * One exhibit from its dataset envelope: code picks the family by VIZ_COMPAT[kind] (PLAN §10.1),
 * never the model. Families not built yet render a framed placeholder that names them.
 */

/** Display options per dataset kind, e.g. { Bars: { display: "split" } } for a head-to-head. */
export interface ExhibitDisplay {
  Matrix?: MatrixGridOptions;
  Ranked?: RankedTableOptions;
  Slate?: RankedTableOptions;
  Bars?: DivergingBarsOptions;
  Quadrant?: QuadrantScatterOptions;
  Scorecard?: ScorecardOptions;
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
    default:
      return <FigurePending {...meta} note={`${VIZ_COMPAT[dataset.kind]} · this figure family is not built yet`} />;
  }
}

/** A framed figure whose plot is not drawable yet: a dataset still computing, or a later family. */
export function FigurePending({ note, ...meta }: FigureMeta & { note: string }) {
  const box = (
    <div className="flex h-[120px] items-center justify-center bg-canvas" role="status">
      <span className="type-trace text-dim">{note}</span>
    </div>
  );
  return <FigureFrame meta={meta} plot={box} table={null} />;
}
