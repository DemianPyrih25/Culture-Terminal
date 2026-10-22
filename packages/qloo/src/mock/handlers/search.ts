import type { QlooParams } from "@ct/contracts";
import { describeRecord, type EntityRecord, recordForName, remember, toSearchEntity } from "../entities";
import { parseLatLon } from "../geo";
import { intBetween } from "../hash";
import { type MockReply, ok } from "../json";
import { metroNear } from "../metros";
import { displayName, normalizeName } from "../names";
import { DEFAULT_TAKE, MockBadRequest, readList, readNumber, readString } from "../params";

/**
 * `/search` and `/entities`. The first search result echoes the query's exact name with the
 * requested type, so the resolution gate (D20) resolves offline; 2–4 near variants follow and never
 * normalise to the query. Queries containing "notfound" return only variants (the picker path) and
 * queries containing "twin" return two exact matches told apart by disambiguation (the ambiguous
 * picker), as "Yellowstone" did live.
 */

const VARIANTS: ReadonlyArray<(name: string) => string> = [
  (n) => `${n} Classic`,
  (n) => `${n} Studio`,
  (n) => `${n} Collective`,
  (n) => `New ${n}`,
];
const TWIN_DISAMBIGUATIONS = ["2004", "2019"];

export function searchEntities(params: QlooParams): MockReply {
  const query = readString(params, "query")?.trim();
  if (!query) throw new MockBadRequest("/search needs query");
  const [type = "urn:entity:brand"] = readList(params, "types");
  if (!/^urn:entity:[a-z_]+$/.test(type)) throw new MockBadRequest(`unknown type "${type}"`);
  const location = readString(params, "filter.location");
  const near = location !== undefined ? parseLatLon(location) : null;
  if (location !== undefined && !near) throw new MockBadRequest("filter.location must be lat,lon");

  const name = displayName(query);
  const lower = query.toLowerCase();
  const located = { metro: near ? metroNear(near) : null, near: near ?? undefined };
  let exact: EntityRecord[] = [recordForName(type, name, located)];
  if (lower.includes("notfound")) exact = [];
  else if (lower.includes("twin")) exact = TWIN_DISAMBIGUATIONS.map((d) => recordForName(type, name, { ...located, disambiguation: d }));
  const variantCount = intBetween(2, 4, "variants", type, normalizeName(query));
  const variants = VARIANTS.slice(0, variantCount).map((v) => recordForName(type, v(name), located));

  const take = Math.trunc(readNumber(params, "take") ?? DEFAULT_TAKE);
  if (take < 1) throw new MockBadRequest("take must be at least 1");
  const results = [...exact, ...variants].slice(0, take);
  remember(results);
  return ok({ results: results.map(toSearchEntity) });
}

/** Batch describe: the same shape as /search, one row per id (unknown ids get invented names). */
export function describeEntities(params: QlooParams): MockReply {
  const ids = readList(params, "entity_ids");
  if (ids.length === 0) throw new MockBadRequest("/entities needs entity_ids");
  return ok({ success: true, results: ids.map((id) => toSearchEntity(describeRecord(id, "urn:entity:brand"))) });
}
