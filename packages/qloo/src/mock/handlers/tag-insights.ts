import type { QlooParams } from "@ct/contracts";
import { LOCALITY, recordForName } from "../entities";
import { geohashEncode, wktCentroid } from "../geo";
import { intBetween, round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { type Metro, metroNear, metroOfLocation } from "../metros";
import { applyWindow, readList, readString } from "../params";
import { FINGERPRINT_TAGS } from "../tags";

/**
 * `/v2/insights` with filter.type=urn:tag: the location fingerprint behind Block DNA (G8). A WKT
 * area resolves to the geohash-6 cell of its centroid, so a POINT and a POLYGON around it give
 * byte-identical rows as they did live. Areas inside a metro share the metro's component, so an
 * area row and its city row are correlated and their rank deltas are meaningful.
 */

interface Area {
  key: string;
  metro: Metro | null;
}

function resolveArea(params: QlooParams): Area {
  const location = readString(params, "signal.location");
  if (location !== undefined) {
    const centroid = wktCentroid(location);
    if (centroid) return { key: `area:${geohashEncode(centroid.lat, centroid.lon, 6)}`, metro: metroNear(centroid) };
    return { key: `locality:${location}`, metro: metroOfLocation(location) };
  }
  const query = readString(params, "signal.location.query");
  if (query !== undefined) {
    const locality = recordForName(LOCALITY, query);
    return { key: `locality:${locality.id}`, metro: metroOfLocation(query) };
  }
  return { key: "national", metro: null };
}

export function tagInsights(params: QlooParams): MockReply {
  const area = resolveArea(params);
  const types = readList(params, "filter.tag.types");
  const cityKey = area.metro?.key ?? area.key;
  const ranked = FINGERPRINT_TAGS.filter((t) => types.length === 0 || types.includes(t.type))
    .map((t) => ({ tag: t, score: 0.3 + 0.6 * (0.55 * unit("city-taste", cityKey, t.id) + 0.45 * unit("area-taste", area.key, t.id)) }))
    .sort((a, b) => b.score - a.score || (a.tag.id < b.tag.id ? -1 : 1));

  const tags: JsonObject[] = applyWindow(ranked, params).map(({ tag, score }) => ({
    tag_id: tag.id,
    name: tag.name,
    types: ["urn:entity:place"],
    subtype: tag.type,
    tag_value: tag.id,
    popularity: round(0.2 + 0.75 * unit("tag-popularity", tag.id), 4),
    query: { affinity: round(score, 6) },
  }));
  const panel = { context: intBetween(150_000, 210_000, "panel-context", cityKey), target: intBetween(800, 7_800, "panel-target", area.key) };
  return ok({ success: true, results: { tags }, query: { geospatial: { panel_size: panel } } });
}
