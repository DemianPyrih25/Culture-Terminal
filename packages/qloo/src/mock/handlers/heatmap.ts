import { isTaxonomyTag, type QlooParams } from "@ct/contracts";
import { PROBE_FACTS } from "../../allowlist";
import { distanceKm, geohashCellSize, geohashEncode, type LatLon } from "../geo";
import { clamp, round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { DEFAULT_METRO, type Metro, metroOfLocation, type Neighborhood } from "../metros";
import { MockBadRequest, readList, readString } from "../params";

/**
 * `/v2/insights` with filter.type=urn:heatmap: a few hundred cells inside the metro at the metro's
 * geohash precision. Popularity is a fixed surface per metro; affinity mostly tracks it, and every
 * concept other than the pinned baseline plants two pockets of extra affinity, so lift has
 * something to find (D18).
 */

interface BaseCell {
  at: LatLon;
  geohash: string;
  popularity: number;
}

const cellsByMetro = new Map<string, BaseCell[]>();

function popularityAt(metro: Metro, at: LatLon, geohash: string): number {
  const hood = Math.max(...metro.neighborhoods.map((n) => n.weight * Math.exp(-((distanceKm(at, n.at) / 1.6) ** 2))));
  const central = Math.exp(-((distanceKm(at, metro.center) / 5) ** 2));
  return round(clamp(0.06 + 0.62 * hood + 0.2 * central + 0.12 * unit("cell-popularity", geohash), 0.01, 0.99), 6);
}

/** The metro's cell grid, thinned with distance from the centre. Signal-independent, so cached. */
function metroCells(metro: Metro): BaseCell[] {
  const cached = cellsByMetro.get(metro.key);
  if (cached) return cached;
  const size = geohashCellSize(metro.precision);
  const latSpan = metro.radiusKm / 111.32;
  const lonSpan = metro.radiusKm / (111.32 * Math.cos((metro.center.lat * Math.PI) / 180));
  const cells: BaseCell[] = [];
  for (let i = Math.floor((metro.center.lat - latSpan + 90) / size.lat); -90 + i * size.lat < metro.center.lat + latSpan; i++) {
    for (let j = Math.floor((metro.center.lon - lonSpan + 180) / size.lon); -180 + j * size.lon < metro.center.lon + lonSpan; j++) {
      const at = { lat: -90 + (i + 0.5) * size.lat, lon: -180 + (j + 0.5) * size.lon };
      const km = distanceKm(at, metro.center);
      if (km > metro.radiusKm) continue;
      const { peak, scaleKm, floor } = metro.density;
      const geohash = geohashEncode(at.lat, at.lon, metro.precision);
      if (unit("cell-kept", metro.key, geohash) >= Math.min(1, peak * Math.exp(-((km / scaleKm) ** 2)) + floor)) continue;
      cells.push({ at, geohash, popularity: popularityAt(metro, at, geohash) });
    }
  }
  cells.sort((a, b) => (a.geohash < b.geohash ? -1 : 1));
  cellsByMetro.set(metro.key, cells);
  return cells;
}

/** 1 for the highest value, 0 for the lowest; ties broken by position. */
function percentRanks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v || a.i - b.i);
  const ranks = new Array<number>(values.length).fill(1);
  const span = Math.max(values.length - 1, 1);
  order.forEach(({ i }, pos) => {
    ranks[i] = round(1 - pos / span, 4);
  });
  return ranks;
}

function pocketsFor(metro: Metro, key: string): Neighborhood[] {
  return [...metro.neighborhoods].sort((a, b) => unit("pocket", key, a.name) - unit("pocket", key, b.name)).slice(0, 2);
}

export function heatmapInsights(params: QlooParams): MockReply {
  const location = readString(params, "filter.location");
  const metro = (location !== undefined ? metroOfLocation(location) : null) ?? DEFAULT_METRO;
  const tags = readList(params, "signal.interests.tags");
  const entities = readList(params, "signal.interests.entities");
  const operator = readString(params, "operator.signal.interests.tags");
  if (operator !== undefined && operator !== "union" && operator !== "intersection") {
    throw new MockBadRequest(`unknown operator.signal.interests.tags "${operator}"`);
  }
  if (tags.length + entities.length === 0) throw new MockBadRequest("urn:heatmap needs signal.interests.tags or signal.interests.entities");

  const signalTags = tags.filter(isTaxonomyTag).sort();
  // Descriptive *:qloo:* tags alone produced no cells live (G6).
  if (signalTags.length === 0 && entities.length === 0) return ok({ success: true, results: { heatmap: [] } });

  const key = [signalTags.join(","), [...entities].sort().join(","), signalTags.length > 1 ? (operator ?? "union") : ""].join("|");
  const isBaseline = entities.length === 0 && signalTags.length === 1 && signalTags[0] === PROBE_FACTS.heatmapBaselineTag;
  const pockets = isBaseline ? [] : pocketsFor(metro, key);

  const cells = metroCells(metro).filter((c) => unit("cell-dropped", key, c.geohash) >= 0.03);
  const affinities = cells.map((c) => {
    // A sliver of zero-affinity cells, which lift excludes (D18).
    if (unit("cell-zero", key, c.geohash) < 0.01) return 0;
    const pocket = pockets.reduce((s, p) => s + 0.4 * Math.exp(-((distanceKm(c.at, p.at) / metro.pocketKm) ** 2)), 0);
    return round(clamp(0.72 * c.popularity + 0.18 * unit("cell-affinity", key, c.geohash) + pocket, 0, 1), 6);
  });
  const affinityRanks = percentRanks(affinities);
  const tagAffinities = signalTags.length > 0 ? affinities.map((a, i) => round(clamp(0.85 * a + 0.15 * unit("cell-tag", key, cells[i]?.geohash ?? ""), 0, 1), 6)) : null;
  const tagRanks = tagAffinities ? percentRanks(tagAffinities) : null;

  const heatmap: JsonObject[] = cells.map((c, i) => ({
    location: { latitude: round(c.at.lat, 6), longitude: round(c.at.lon, 6), geohash: c.geohash },
    query: {
      affinity: affinities[i] ?? 0,
      affinity_rank: affinityRanks[i] ?? 0,
      popularity: c.popularity,
      tag_affinity: tagAffinities?.[i] ?? null,
      tag_affinity_rank: tagRanks?.[i] ?? null,
    },
  }));
  return ok({ success: true, results: { heatmap } });
}
