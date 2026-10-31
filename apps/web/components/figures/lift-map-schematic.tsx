import type { GeoLiftPayload } from "@ct/contracts";
import { geohashBounds, mercatorY, type Bounds } from "./geohash";
import { cellFills, flagName, flagSize, flagText, focusBounds, overlayBoxes, pinRadius, placeChips, rgbHex, type LiftLabel, type LiftMode, type MapPlace } from "./lift-scale";
import { px } from "./scale";

/**
 * The LiftMap without WebGL: the geohash cells in Web Mercator on a sunken panel, filled on the same
 * ramps as the map, with the numbered ink pins, their flags (name and "1.42× interest"), the few-rivals
 * rings and the venue sample.
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
  places = [],
}: {
  data: GeoLiftPayload;
  mode: LiftMode;
  labels: readonly LiftLabel[];
  width: number;
  height: number;
  label: string;
  hidden?: boolean;
  /** Similar places from OpenStreetMap (R6), when the layer is on. */
  places?: readonly MapPlace[];
}) {
  const { project } = schematicProjection(data, width, height);
  const fills = cellFills(data, mode);
  const placed = labels.filter((l) => l.at !== null);
  const pins = placed.map((l) => {
    const p = project(l.at!.lat, l.at!.lon);
    return { label: l, x: p.x, y: p.y, r: pinRadius(l) };
  });
  const flags = placeChips(
    pins.map((m) => ({ id: m.label.id, x: m.x, y: m.y, r: m.r, ...flagSize(m.label) })),
    { w: width, h: height },
    8,
    overlayBoxes(width, height),
  );
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={label}
      className={`absolute inset-0 h-full w-full font-sans ${hidden ? "hidden" : "block"}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden={hidden || undefined}
      data-schematic={mode}
    >
      <title>{label}</title>
      <desc>{`${data.cells.length} geohash-${data.precision} cells in ${mode} mode, drawn without a basemap. The table view lists every neighbourhood.`}</desc>
      <rect width={width} height={height} className="fill-sunken" />
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
        return <circle key={`s-${i}`} cx={px(at.x)} cy={px(at.y)} r={2.25} className="fill-ink-3 stroke-surface" strokeWidth={1} data-supply="true" />;
      })}
      {places.map((p, i) => {
        const at = project(p.lat, p.lon);
        return <rect key={`o-${i}`} x={px(at.x - 3)} y={px(at.y - 3)} width={6} height={6} rx={1} className="fill-second stroke-surface" strokeWidth={1} data-osm-place="true" />;
      })}
      {pins.map((m) => (
        <g key={`m-${m.label.id}`} data-marker={m.label.id} data-pin={m.label.rank ?? ""}>
          {m.label.fewRivals ? <circle cx={px(m.x)} cy={px(m.y)} r={19} fillOpacity={0.6} className="fill-surface stroke-second" strokeWidth={2} /> : null}
          {m.label.hidden && m.label.rank === undefined && !m.label.named ? (
            <circle cx={px(m.x)} cy={px(m.y)} r={11} className="fill-second stroke-surface" strokeWidth={2} data-hidden-pin={m.label.id} />
          ) : m.label.popular ? (
            <>
              <circle cx={px(m.x)} cy={px(m.y)} r={13} className="fill-surface stroke-ink" strokeWidth={2.5} data-popular-pin={m.label.id} />
              <circle cx={px(m.x)} cy={px(m.y)} r={4} className="fill-ink" />
            </>
          ) : (
            <circle cx={px(m.x)} cy={px(m.y)} r={14} className={m.label.named && m.label.rank === undefined ? "fill-accent" : "fill-ink"} data-named-pin={m.label.named ? m.label.id : undefined} />
          )}
          <text x={px(m.x)} y={px(m.y + 4.5)} textAnchor="middle" fontSize={13} fontWeight={600} className="fill-white">
            {m.label.rank ?? ""}
          </text>
        </g>
      ))}
      {pins.map((m) => {
        const at = flags.get(m.label.id);
        if (!at) return null;
        const size = flagSize(m.label);
        return (
          <g key={`c-${m.label.id}`} data-chip={m.label.id}>
            <rect x={px(at.x)} y={px(at.y)} width={size.w} height={size.h} rx={4} className="fill-surface stroke-line-strong" strokeWidth={1} />
            <text x={px(at.x + 10)} y={px(at.y + 20)} fontSize={13} fontWeight={600} className="fill-ink">
              {flagName(m.label.name)}
            </text>
            <text x={px(at.x + 10)} y={px(at.y + 36)} fontSize={12} className="fill-ink-2">
              {flagText(m.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
