import {
  METRO_LABEL,
  type AreaArg,
  type GeoApi,
  type LatLon,
  type LocationMethod,
  type MarketLocality,
  type MetroId,
  type QlooParams,
} from "@ct/contracts";
import { METRO_CENTRES } from "../metros";

/**
 * Where Block DNA reads an area (SPEC §5.3 S7, PROBE consequence 6): the location ladder POLYGON →
 * POINT → QUERY with no radius, and the city side as the metro's pinned Qloo locality. Pure: the
 * request parameters come from the gazetteer, the pins and the input only, so the same area always
 * sends the same requests.
 */

/** One rung of the ladder: its method and the location parameter, or why the rung cannot be formed. */
export type LadderRung =
  | { method: LocationMethod; params: QlooParams; missing: null }
  | { method: LocationMethod; params: null; missing: string };

export interface BlockArea {
  /** The neighbourhood id, or "point": the series key of the dataset. */
  key: string;
  /** Display name: the neighbourhood, or the point and the neighbourhood holding it. */
  name: string;
  metro: MetroId;
  /** Metric subject: the neighbourhood id, or the point as "lon,lat". */
  subject: string;
  /** Rungs from the one the area starts on down to QUERY, in ladder order. */
  rungs: LadderRung[];
  /** Notes for the model about how the area was read. */
  notices: string[];
}

export type AreaResolution = { ok: true; area: BlockArea } | { ok: false; message: string };

/** A point further than this from the metro centre is not in the metro its city side describes. */
export const MAX_POINT_KM = 60;
/** WKT coordinates as the Qloo client canonicalises them (about a metre). */
const COORD_DP = 5;

function coord(x: number): string {
  return String(Number(x.toFixed(COORD_DP)));
}

/** Lon-first WKT, as signal.location takes it. */
export function pointWkt(p: LatLon): string {
  return `POINT(${coord(p.lon)} ${coord(p.lat)})`;
}

/** The "<name>, <city>" place-name search of the last rung (SPEC §5.3 S7). */
export function areaQuery(name: string, metro: MetroId): string {
  return `${name}, ${METRO_LABEL[metro]}`;
}

/**
 * The city side: the metro's pinned locality id (P5, pinned per metro), never `.query`, so a
 * deliberately pinned locality cannot be swapped for a namesake and the cache pins it (D25).
 */
export function cityLocation(locality: MarketLocality): QlooParams {
  return { "signal.location": locality.entityId };
}

/** "east_nashville" → "East Nashville": the name a slug stands for when no gazetteer holds it. */
export function nameFromSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The point of a {kind: "point"} area; AreaArg has already checked the "lon,lat" form and ranges. */
export function parsePoint(ref: string): LatLon {
  const [lon, lat] = ref.split(",").map(Number);
  return { lat: lat ?? Number.NaN, lon: lon ?? Number.NaN };
}

/**
 * The POINT rung of a point area, which needs no gazetteer: estimateCalls probes it exactly. A
 * neighbourhood's rungs need the gazetteer, which estimateCalls does not get.
 */
export function pointAreaLocation(area: Extract<AreaArg, { kind: "point" }>): QlooParams {
  return { "signal.location": pointWkt(parsePoint(area.ref)) };
}

function rung(method: LocationMethod, params: QlooParams | null, missing: string): LadderRung {
  return params === null ? { method, params: null, missing } : { method, params, missing: null };
}

/**
 * The area and its ladder. A neighbourhood starts at its gazetteer boundary, then its centre point,
 * then a place-name search; a metro without neighbourhood boundaries in this build reads the id as
 * a name for the search. A point starts at itself, then searches the name of the neighbourhood
 * holding it, when there is one.
 */
export function resolveArea(input: AreaArg, geo: GeoApi): AreaResolution {
  const { metro } = input;
  const city = METRO_LABEL[metro];

  if (input.kind === "nbhd") {
    const known = geo.neighbourhood(metro, input.ref);
    if (known === null && geo.neighbourhoods(metro).length > 0) {
      return {
        ok: false,
        message: `${input.ref} is not a neighbourhood in the ${city} AREAS list; use one of its ids, or a point as "lon,lat".`,
      };
    }
    if (known === null) {
      const name = nameFromSlug(input.ref);
      return {
        ok: true,
        area: {
          key: input.ref,
          name,
          metro,
          subject: input.ref,
          rungs: [
            rung("POLYGON", null, `no neighbourhood boundaries for ${city} in this build`),
            rung("POINT", null, `no neighbourhood centre for ${city} in this build`),
            rung("QUERY", { "signal.location.query": areaQuery(name, metro) }, ""),
          ],
          notices: [`No neighbourhood boundaries for ${city} in this build: "${name}" is read as a place-name search.`],
        },
      };
    }
    const polygon = geo.polygonWkt(metro, known.id);
    return {
      ok: true,
      area: {
        key: known.id,
        name: known.name,
        metro,
        subject: known.id,
        rungs: [
          rung("POLYGON", polygon === null ? null : { "signal.location": polygon }, "the gazetteer holds no boundary for it"),
          rung("POINT", { "signal.location": pointWkt(known.centroid) }, ""),
          rung("QUERY", { "signal.location.query": areaQuery(known.name, metro) }, ""),
        ],
        notices: [],
      },
    };
  }

  const point = parsePoint(input.ref);
  const km = distanceKm(point, METRO_CENTRES[metro]);
  if (!(km <= MAX_POINT_KM)) {
    return {
      ok: false,
      message: `The point ${input.ref} lies ${Math.round(km)} km from central ${city}; Block DNA compares an area with its own city, so give a point inside ${city}.`,
    };
  }
  const holder = geo.locate(metro, point);
  const holderName = holder === null ? null : (geo.neighbourhood(metro, holder)?.name ?? null);
  return {
    ok: true,
    area: {
      key: "point",
      name: holderName === null ? `point ${input.ref}` : `${holderName} (point)`,
      metro,
      subject: input.ref,
      rungs: [
        rung("POINT", { "signal.location": pointWkt(point) }, ""),
        rung(
          "QUERY",
          holderName === null ? null : { "signal.location.query": areaQuery(holderName, metro) },
          "the point lies in no gazetteer neighbourhood, so there is no name to search",
        ),
      ],
      notices: [],
    },
  };
}
