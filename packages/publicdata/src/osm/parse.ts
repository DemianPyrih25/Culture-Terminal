import type { OsmCounts, OsmPlace, OsmTypeQuery } from "@ct/contracts";
import { z } from "zod";
import type { OsmRequestPlan } from "../api";
import { matchesType } from "./query";

/**
 * Overpass JSON answers (shapes checked live): `{version, generator, osm3s: {timestamp_osm_base, …},
 * remark?, elements: [...]}`. `out count` gives one `{type: "count", id: 0, tags: {nodes, ways,
 * relations, areas?, total}}` element per statement, in statement order; `out center tags` gives nodes
 * with lat/lon and ways or relations with `center: {lat, lon}`, each with its tags. A query that runs out
 * of time or memory still answers HTTP 200, with a `remark` ("runtime error: …") and partial elements:
 * that is a failure, never data.
 */

const Body = z.object({
  osm3s: z.object({ timestamp_osm_base: z.string().optional() }).loose().optional(),
  remark: z.string().optional(),
  elements: z.array(z.unknown()),
});

const CountElement = z.object({
  type: z.literal("count"),
  tags: z.object({ total: z.union([z.string(), z.number()]) }).loose(),
});

const Tags = z.record(z.string(), z.string());
const Point = z.object({ lat: z.number(), lon: z.number() });
const PlaceElement = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int().positive(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: Point.optional(),
  tags: Tags.optional(),
});

/** What the cache keeps of a counts answer. */
export const KeptCounts = z.object({ osmBase: z.string().nullable(), counts: z.record(z.string(), z.record(z.string(), z.int().nonnegative())) });
/** What the cache keeps of a places answer. */
export const KeptPlaces = z.object({
  osmBase: z.string().nullable(),
  places: z.array(
    z.object({
      name: z.string(),
      brand: z.string().nullable(),
      lat: z.number(),
      lon: z.number(),
      typeKey: z.string(),
      osmType: z.enum(["node", "way", "relation"]),
      osmId: z.number().int().positive(),
    }),
  ),
});

/** Thrown for an answer Overpass marked as failed; the client reports it as unavailable. */
export class OverpassRuntimeError extends Error {
  override readonly name = "OverpassRuntimeError";
}

/** The answer's envelope; throws OverpassRuntimeError on a runtime-error remark, Error on a wrong shape. */
export function parseEnvelope(json: unknown): { osmBase: string | null; elements: unknown[] } {
  const body = Body.parse(json);
  if (body.remark !== undefined && /error/i.test(body.remark)) {
    throw new OverpassRuntimeError(`Overpass reported: ${body.remark.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const base = body.osm3s?.timestamp_osm_base;
  const osmBase = base !== undefined && !Number.isNaN(Date.parse(base)) ? new Date(base).toISOString() : null;
  return { osmBase, elements: body.elements };
}

/** `osm-<timestamp_osm_base>`: the reference a reader can trace a count to (the database state it read). */
export const osmReference = (osmBase: string | null): string => (osmBase === null ? "osm-unknown" : `osm-${osmBase.replace(/\.000Z$/, "Z")}`);

/** counts[shape][type] from an `out count` answer, mapped back by statement order. */
export function parseCounts(json: unknown, plan: Extract<OsmRequestPlan, { kind: "counts" }>): OsmCounts {
  const { osmBase, elements } = parseEnvelope(json);
  const counts = elements.filter((e) => (e as { type?: unknown } | null)?.type === "count");
  if (counts.length !== plan.pairs.length) {
    throw new Error(`expected ${plan.pairs.length} count elements, got ${counts.length}`);
  }
  const out: Record<string, Record<string, number>> = {};
  plan.pairs.forEach((pair, i) => {
    const el = CountElement.parse(counts[i]);
    const total = Number(el.tags.total);
    if (!Number.isInteger(total) || total < 0) throw new Error(`count ${i} is not a whole number`);
    (out[pair.shape.id] ??= {})[pair.typeKey] = total;
  });
  return { counts: out, osmBase };
}

/**
 * Named places from an `out center tags` answer: each element's type is the first of `types` (in the
 * order given) whose filters it matches; elements without a name, a position or a matching type are
 * dropped, and each element is listed once.
 */
export function parsePlaces(json: unknown, types: readonly OsmTypeQuery[]): { osmBase: string | null; places: OsmPlace[] } {
  const { osmBase, elements } = parseEnvelope(json);
  const places: OsmPlace[] = [];
  const seen = new Set<string>();
  for (const raw of elements) {
    const parsed = PlaceElement.safeParse(raw);
    if (!parsed.success) continue;
    const el = parsed.data;
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    if (!name) continue;
    const at = el.type === "node" ? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null) : (el.center ?? null);
    if (at === null) continue;
    const type = types.find((t) => matchesType(tags, t));
    if (type === undefined) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    places.push({
      name: name.slice(0, 200),
      brand: tags.brand?.trim().slice(0, 200) || null,
      lat: at.lat,
      lon: at.lon,
      typeKey: type.key,
      osmType: el.type,
      osmId: el.id,
    });
  }
  return { osmBase, places };
}

/** The OpenStreetMap page of an element. */
export const osmElementUrl = (place: Pick<OsmPlace, "osmType" | "osmId">): string => `https://www.openstreetmap.org/${place.osmType}/${place.osmId}`;
