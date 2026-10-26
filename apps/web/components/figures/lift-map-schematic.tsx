import type { GeoLiftPayload } from "@ct/contracts";
import { geohashBounds, mercatorY, type Bounds } from "./geohash";
import {
  TOKEN_RGB,
  cellFills,
  chipSize,
  focusBounds,
  formatLift,
  liftRadius,
  placeChips,
  rgbHex,
  type LiftLabel,
  type LiftMode,
} from "./lift-scale";
import { px } from "./scale";

/**
 * The LiftMap without WebGL: the geohash cells in Web Mercator on paper, filled on the same ramps
 * as the map, with the neighbourhood markers sized by lift, their label chips and the venue sample.
 * It is what the server renders, what a browser without WebGL keeps, and what shows while the map
 * code loads, so the figure never depends on a canvas to be read.
 */

/** A Mercator fit of the map's focus (see focusBounds) into a width × height box with a margin. */
export function schematicProjection(data: Pick<GeoLiftPayload, "cells">, width: number, height: number, margin = 14) {
  const box: Bounds = focusBounds(data) ?? [-1, -1, 1, 1];
  const toX = (lon: number) => (lon * Math.PI) / 180;
  const x0 = toX(box[0]);
  const x1 = toX(box[2]);
  const y0 = mercatorY(box[1]);
  const y1 = mercatorY(box[3]);
  const k = Math.min((width - margin * 2) / Math.max(1e-9, x1 - x0), (height - margin * 2) / Math.max(1e-9, y1 - y0));
  const offX = (width - (x1 - x0) * k) / 2;
  const offY = (height - (y1 - y0) * k) / 2;
  const project = (lat: number, lon: number) => ({ x: offX + (toX(lon) - x0) * k, y: height - offY - (mercatorY(lat) - y0) * k });
  return { project, box };
}

export function LiftSchematic({
  data,
  mode,
  labels,
  width,
  height,
  label,
  hidden = false,
}: {
  data: GeoLiftPayload;
  mode: LiftMode;
  labels: readonly LiftLabel[];
  width: number;
  height: number;
  label: string;
  hidden?: boolean;
}) {
  const { project } = schematicProjection(data, width, height);
  const fills = cellFills(data, mode);
  const lift = mode === "LIFT";
  const placed = labels.filter((l) => l.at !== null);
  const markers = placed.map((l) => {
    const p = project(l.at!.lat, l.at!.lon);
    return { label: l, x: p.x, y: p.y, r: lift ? liftRadius(l.lift) : 3 };
  });
  const chips = placeChips(
    markers.map((m) => ({ id: m.label.id, x: m.x, y: m.y, r: m.r, ...chipSize(m.label, lift) })),
    { w: width, h: height },
  );
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={label}
      className={`absolute inset-0 h-full w-full font-ui ${hidden ? "hidden" : "block"}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden={hidden || undefined}
      data-schematic={mode}
    >
      <title>{label}</title>
      <desc>{`${data.cells.length} geohash-${data.precision} cells in ${mode} mode, drawn without a basemap. The table view lists every neighbourhood.`}</desc>
      <rect width={width} height={height} className="fill-canvas" />
      {data.cells.map((c) => {
        const fill = fills.get(c.geohash);
        const b = geohashBounds(c.geohash);
        if (!fill || !b) return null;
        const nw = project(b[3], b[0]);
        const se = project(b[1], b[2]);
        return (
          <rect
            key={c.geohash}
            x={px(nw.x)}
            y={px(nw.y)}
            width={px(Math.max(0.5, se.x - nw.x - 0.5))}
            height={px(Math.max(0.5, se.y - nw.y - 0.5))}
            fill={rgbHex(fill.rgb)}
            fillOpacity={Number(fill.alpha.toFixed(2))}
            data-cell={c.geohash}
          />
        );
      })}
      {data.supply?.points.map((p, i) => {
        const at = project(p.lat, p.lon);
        return <circle key={`s-${i}`} cx={px(at.x)} cy={px(at.y)} r={2.25} className="fill-ink stroke-paper" strokeWidth={1} data-supply="true" />;
      })}
      {markers.map((m) => {
        const tone = rgbHex(m.label.lift >= 1 ? TOKEN_RGB.data : TOKEN_RGB.negative);
        return (
          <g key={`m-${m.label.id}`} data-marker={m.label.id}>
            {lift && m.label.top ? <circle cx={px(m.x)} cy={px(m.y)} r={px(m.r + 5)} fill="none" stroke={tone} strokeWidth={1} /> : null}
            <circle
              cx={px(m.x)}
              cy={px(m.y)}
              r={px(m.r)}
              fill={lift ? tone : rgbHex(TOKEN_RGB.ink)}
              fillOpacity={lift ? 0.35 : 0.8}
              stroke={lift ? tone : "none"}
              strokeWidth={1.5}
            />
          </g>
        );
      })}
      {markers.map((m) => {
        const at = chips.get(m.label.id);
        if (!at) return null;
        const size = chipSize(m.label, lift);
        const tone = m.label.lift >= 1 ? "fill-data" : "fill-negative";
        return (
          <g key={`c-${m.label.id}`} data-chip={m.label.id}>
            <rect x={px(at.x)} y={px(at.y)} width={size.w} height={size.h} rx={2} className="stroke-line" fill="#ffffff" fillOpacity={0.92} />
            <text x={px(at.x + 6)} y={px(at.y + 12.5)} fontSize={11} fontWeight={m.label.top ? 600 : 500} className="fill-ink">
              {m.label.name}
              {lift ? (
                <tspan dx={5} fontWeight={500} className={tone}>
                  {formatLift(m.label.lift)}
                </tspan>
              ) : null}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
