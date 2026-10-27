import { METRO_LABEL, type BarsPayload, type GeoLiftPayload } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableRow } from "./figure-table";
import { reasonLabel } from "./format";
import { outlinesUrl } from "./lift-outlines";
import { areaSupply, formatLift, mapPins, namedAreas, supplyUnknown, THIN_SUPPLY_LABEL, type LiftMode } from "./lift-scale";
import { LiftMapView } from "./lift-map-view";

/**
 * LiftMap (kind GeoLift: S6). Where a concept's taste over-indexes against the pinned baseline: geohash
 * cells on the map ramp (map-1..5) with confidence as alpha, the top areas outlined and pinned (numbered
 * ink pins with flags, a second-colour ring where rivals are few), the venue sample, the ramp legend and
 * the "Extra interest | All interest" switch. The server renders a static schematic of the same cells;
 * the WebGL map loads in the browser only. The table view lists every neighbourhood with its lift or the
 * reason it has none; the caption names the boundary source.
 */

export interface LiftMapOptions {
  /** The layer shown first. Default LIFT (extra interest); a coarse map opens on RAW. */
  initialMode?: LiftMode;
  /** Layout box of the map in px; narrower columns keep its aspect ratio. Default 760 × 400. */
  width?: number;
  height?: number;
  /** Areas pinned on the map, most extra interest first. Default 3. */
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
  const width = props.width ?? 760;
  const height = props.height ?? 400;
  return (
    <FigureFrame
      meta={props}
      plot={
        <LiftMapView
          data={data}
          labels={mapPins(data, props.maxLabels ?? 3)}
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
  LATENT_OPEN: "Few rivals nearby",
  PROVEN_CROWDED: "Proven, busy with rivals",
  SATURATED: "Busy with rivals",
  COLD: "Little interest",
};

/**
 * The table view: one row per neighbourhood, the areas the question names first with their rank, then
 * lifts highest first, with confidence, gated cells, demand and supply percentiles, venues and white
 * space; a neighbourhood without a lift says why. Supply follows the supply-label rule (lift-scale
 * areaSupply): a count that was not taken reads "Unknown" with the map's supplyGap, never "not
 * measured" or 0, and a count too thin for a label reads "Not enough venue data". Then a summary row for
 * the cells and the precision.
 */
export function liftTableSpec(data: GeoLiftPayload, caption: string) {
  // A supply gap (or a stored sample too thin to read) shows the supply columns as unknown, never as 0 venues.
  const gap = supplyUnknown(data);
  const unknown = gap !== null;
  const supply = data.supply !== null || unknown;
  const unknownWhy = data.supplyGap ? `Unknown: ${data.supplyGap}` : "Unknown";
  const pct = (v: number | null, reason: string): TableCell =>
    v === null ? { kind: "missing", reason } : { kind: "value", text: v.toFixed(2) };
  const named = new Map(namedAreas(data).map((a) => [a.id, a]));
  const ordered = [...data.neighbourhoods.filter((n) => named.has(n.id)), ...data.neighbourhoods.filter((n) => !named.has(n.id))];
  const rows: TableRow[] = ordered.map((n) => {
    const why = reasonLabel(n.reason);
    const mine = named.get(n.id);
    const cells: TableCell[] = [
      mine === undefined ? n.name : `${n.name} · Your area${mine.rank === null ? "" : ` · #${mine.rank[0]} of ${mine.rank[1]}`}`,
      n.lift === null ? { kind: "missing", reason: why } : { kind: "value", text: formatLift(n.lift) },
      n.conf === null ? { kind: "missing", reason: why } : { kind: "value", text: n.conf.toFixed(2) },
      String(n.n),
      pct(n.demandPct, n.lift === null ? why : reasonLabel("not_measured")),
    ];
    if (supply) cells.push(...supplyCells(areaSupply(n, data), n, mine === undefined ? "Unknown" : unknownWhy));
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
      ...(supply ? ["", data.supply && !unknown ? `${data.supply.points.length}${data.supply.capped ? " (capped)" : ""}` : unknownWhy, "", ""] : []),
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

/** Supply pctl, Venues, White space and Quadrant for one area, by its supply read. */
function supplyCells(read: ReturnType<typeof areaSupply>, n: GeoLiftPayload["neighbourhoods"][number], unknownText: string): TableCell[] {
  const missing = (reason: string): TableCell => ({ kind: "missing", reason });
  switch (read.kind) {
    case "unknown":
      return [missing("Unknown"), missing(unknownText), missing("Unknown"), "Unknown"];
    case "thin":
      return [
        missing(THIN_SUPPLY_LABEL),
        read.cappedZero ? missing("Unknown: none in a capped sample") : String(read.count),
        missing(THIN_SUPPLY_LABEL),
        THIN_SUPPLY_LABEL,
      ];
    case "label":
      return [
        n.supplyPct === null ? missing(reasonLabel("not_measured")) : { kind: "value", text: n.supplyPct.toFixed(2) },
        String(read.count),
        n.whiteSpace === null ? missing(reasonLabel("not_measured")) : { kind: "value", text: n.whiteSpace.toFixed(2) },
        QUADRANT_TEXT[read.quadrant],
      ];
    case "count":
      return [missing(reasonLabel("not_measured")), String(read.count), missing(reasonLabel("not_measured")), ""];
    case "none":
      return [missing(reasonLabel("not_measured")), missing(reasonLabel("not_measured")), missing(reasonLabel("not_measured")), ""];
  }
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
