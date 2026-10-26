import { METRO_LABEL, type BarsPayload, type GeoLiftPayload } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableRow } from "./figure-table";
import { reasonLabel } from "./format";
import { outlinesUrl } from "./lift-outlines";
import { formatLift, liftLabels, type LiftMode } from "./lift-scale";
import { LiftMapView } from "./lift-map-view";

/**
 * LiftMap (kind GeoLift: S6; A06 figure 1). Where a concept's taste over-indexes against the pinned
 * baseline, cell by cell and neighbourhood by neighbourhood: geohash cells on the log2 lift ramp
 * with confidence as alpha, gazetteer outlines, markers sized by lift with ×lift chips, the venue
 * sample, RAW / BASE / LIFT on keys 1/2/3 and the precision badge. The server renders a static
 * schematic of the same cells; the WebGL map loads in the browser only. The table view lists every
 * neighbourhood with its lift or the reason it has none; the caption names the boundary source.
 */

export interface LiftMapOptions {
  /**
   * The mode shown first. Default LIFT (the finding); a coarse map opens on RAW, since its cells carry
   * no confidence and LIFT is drawn faint. A replay can start on RAW and flip.
   */
  initialMode?: LiftMode;
  /** Layout box of the map in px; narrower columns keep its aspect ratio. Default 680 × 260 (A06). */
  width?: number;
  height?: number;
  /** Neighbourhoods labelled on the map, highest lifts first plus the lowest for contrast. Default 7. */
  maxLabels?: number;
  /** Where the outlines come from; null draws no outlines. Default /api/geo/<metro>. */
  outlinesUrl?: string | null;
  /** false keeps the static schematic and never loads the map code (thumbnails, print, tests). Default true. */
  interactive?: boolean;
}

export type LiftMapProps = FigureMeta & LiftMapOptions & { data: GeoLiftPayload };

export function LiftMap(props: LiftMapProps) {
  const { data } = props;
  const label = figureLabel(props);
  const compact = (props.width ?? 680) < 480;
  const width = props.width ?? 680;
  const height = props.height ?? (compact ? 220 : 260);
  return (
    <FigureFrame
      meta={props}
      plot={
        <LiftMapView
          data={data}
          labels={liftLabels(data, props.maxLabels ?? (compact ? 4 : 7))}
          label={label}
          initialMode={props.initialMode ?? (data.coarse ? "RAW" : "LIFT")}
          width={width}
          height={height}
          outlinesUrl={props.outlinesUrl === undefined ? outlinesUrl(data.metro) : props.outlinesUrl}
          interactive={props.interactive ?? true}
        />
      }
      table={<FigureTable spec={liftTableSpec(data, label)} />}
      fixedCaption={liftCaption(data)}
    />
  );
}

/** The fixed caption with the boundary source, which the licence asks to show. */
export function liftCaption(data: GeoLiftPayload): string {
  const caption = data.caption.trim().replace(/\.$/, "");
  return `${caption}. Boundaries: ${data.boundarySource}.`;
}

const QUADRANT_TEXT: Readonly<Record<NonNullable<GeoLiftPayload["neighbourhoods"][number]["quadrant"]>, string>> = {
  LATENT_OPEN: "Latent & open",
  PROVEN_CROWDED: "Proven & crowded",
  SATURATED: "Saturated",
  COLD: "Cold",
};

/**
 * The table view: one row per neighbourhood, lifts highest first, with confidence, gated cells,
 * demand and supply percentiles, venues and white space; a neighbourhood without a lift says why.
 * Then a summary row for the cells and the precision.
 */
export function liftTableSpec(data: GeoLiftPayload, caption: string) {
  const supply = data.supply !== null;
  const pct = (v: number | null, reason: string): TableCell =>
    v === null ? { kind: "missing", reason } : { kind: "value", text: v.toFixed(2) };
  const rows: TableRow[] = data.neighbourhoods.map((n) => {
    const why = reasonLabel(n.reason);
    const cells: TableCell[] = [
      n.name,
      n.lift === null ? { kind: "missing", reason: why } : { kind: "value", text: formatLift(n.lift) },
      n.conf === null ? { kind: "missing", reason: why } : { kind: "value", text: n.conf.toFixed(2) },
      String(n.n),
      pct(n.demandPct, n.lift === null ? why : reasonLabel("not_measured")),
    ];
    if (supply) {
      cells.push(
        pct(n.supplyPct, reasonLabel("not_measured")),
        n.supplyCount === null ? { kind: "missing", reason: reasonLabel("not_measured") } : String(n.supplyCount),
        pct(n.whiteSpace, reasonLabel("not_measured")),
        n.quadrant ? QUADRANT_TEXT[n.quadrant] : "",
      );
    }
    return { key: n.id, cells };
  });
  const gated = data.cells.filter((c) => c.gated).length;
  rows.push({ key: "section-cells", section: "Cells" });
  rows.push({
    key: "cells",
    cells: [
      `${data.cells.length} geohash-${data.precision} cells, ${gated} past the gate`,
      `precision ${data.precisionFactor.toFixed(2)}${data.coarse ? " (coarse)" : ""}`,
      "",
      "",
      "",
      ...(supply ? ["", data.supply ? `${data.supply.points.length}${data.supply.capped ? " (capped)" : ""}` : "", "", ""] : []),
    ],
  });
  return {
    caption: `${caption} · ${data.concept.label} vs ${data.baseline.label}, ${METRO_LABEL[data.metro]}`,
    columns: [
      { label: "Neighbourhood" },
      { label: `Lift vs ${data.baseline.label}`, numeric: true },
      { label: "Confidence", numeric: true },
      { label: "Gated cells", numeric: true },
      { label: "Demand pctl", numeric: true },
      ...(supply
        ? [
            { label: "Supply pctl", numeric: true },
            { label: "Venues", numeric: true },
            { label: "White space", numeric: true },
            { label: "Quadrant" },
          ]
        : []),
    ],
    rows,
  };
}

/**
 * Neighbourhood lifts as a one-series Bars payload around the 1.00 baseline (A06 figure 2): drawn by
 * DivergingBars as a dot plot (display "dumbbell"), highest first; neighbourhoods without a lift
 * keep their reason. A coarse map makes no neighbourhood claims, so it gives no rows.
 */
export function geoLiftBars(data: GeoLiftPayload): BarsPayload {
  return {
    mode: "diverging",
    comparator: "BASELINE",
    valueLabel: `Lift vs ${data.baseline.label}`,
    unit: "lift",
    series: [{ key: "concept", label: data.concept.label, ref: null, group: null }],
    groups: [
      {
        key: "neighbourhoods",
        label: "Neighbourhood",
        family: null,
        bars: data.coarse
          ? []
          : data.neighbourhoods.map((n) => ({
              key: n.id,
              label: n.name,
              tagRef: null,
              values: [n.lift === null ? { value: null, reason: n.reason ?? "not_measured" } : { value: n.lift, reason: null }],
              isNew: false,
              ranks: null,
            })),
      },
    ],
    method: null,
    domain: null,
    caption: null,
    baseline: 1,
  };
}
