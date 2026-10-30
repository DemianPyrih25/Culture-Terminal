import { createHash } from "node:crypto";
import type { OsmShape } from "@ct/contracts";
import type { PublicRequest } from "../api";

/**
 * Synthetic Overpass answers for the mock transport (QLOO_MOCK=1), in the live JSON shape, so the client's
 * parsing, caching and provenance run unchanged. Every value is invented and a pure function of the
 * request: counts come from a hash of shape and type scaled by the shape's area, places are "Example
 * Cafe 1", "Example Cafe 2", … with invented element ids (9 000 000 000 and up) placed inside the shape.
 * `timestamp_osm_base` is fixed, so a mock reference never passes for a live one.
 */

export const MOCK_OSM_BASE = "2026-01-01T00:00:00Z";
/** Area the mock gives a county union, per county (km²). */
const MOCK_COUNTY_KM2 = 1_200;

const unit = (...parts: readonly (string | number)[]): number =>
  Number.parseInt(createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 13), 16) / 2 ** 52;

/** Rough area of a shape in km² (shoelace on an equirectangular projection for a polygon). */
function areaKm2(shape: OsmShape): number {
  if (shape.kind === "around") return (Math.PI * shape.radiusM * shape.radiusM) / 1e6;
  if (shape.kind === "admin") return MOCK_COUNTY_KM2 * shape.wikidata.length;
  const ring = shape.ring;
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as readonly [number, number];
    const b = ring[(i + 1) % ring.length] as readonly [number, number];
    sum += a[1] * kx * (b[0] * ky) - b[1] * kx * (a[0] * ky);
  }
  return Math.max(0.05, Math.abs(sum) / 2);
}

function centre(shape: OsmShape): { lat: number; lon: number; spread: number } {
  if (shape.kind === "around") return { lat: shape.lat, lon: shape.lon, spread: shape.radiusM / 111_000 / 2 };
  if (shape.kind === "admin") return { lat: 36.16, lon: -86.78, spread: 0.1 };
  const lats = shape.ring.map((p) => p[0]);
  const lons = shape.ring.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  return { lat, lon, spread: Math.max(0.001, (Math.max(...lats) - Math.min(...lats)) / 6) };
}

/** Invented places per km² of a type: street activity is dense, a specialty type sparse. */
function density(typeKey: string): number {
  if (typeKey === "activity") return 20 + unit("osm-density", typeKey) * 60;
  return 0.2 + unit("osm-density", typeKey) * 4;
}

export function mockCount(shape: OsmShape, typeKey: string): number {
  const local = 0.4 + unit("osm-local", shape.id, typeKey) * 1.4;
  return Math.max(0, Math.round(areaKm2(shape) * density(typeKey) * local));
}

const title = (key: string): string => key.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The Overpass answer to a request that carries its plan; null when it carries none (a 400, as live for a bad query). */
export function osmAnswer(request: PublicRequest): { status: number; body: string } {
  const plan = request.osm;
  if (plan === undefined || request.method !== "POST" || !request.body) return { status: 400, body: "Error: no query" };
  const head = { version: 0.6, generator: "Culture Terminal mock Overpass", osm3s: { timestamp_osm_base: MOCK_OSM_BASE, copyright: "Invented mock data." } };
  if (plan.kind === "counts") {
    const elements = plan.pairs.map((pair) => {
      const total = mockCount(pair.shape, pair.typeKey);
      const ways = Math.floor(total * 0.3);
      return { type: "count", id: 0, tags: { nodes: String(total - ways), ways: String(ways), relations: "0", areas: "0", total: String(total) } };
    });
    return { status: 200, body: JSON.stringify({ ...head, elements }) };
  }
  const at = centre(plan.shape);
  const elements: unknown[] = [];
  for (const type of plan.types) {
    const n = Math.min(plan.limit, Math.max(1, Math.round(mockCount(plan.shape, type.key) * 0.6)));
    for (let i = 1; i <= n && elements.length < plan.limit; i++) {
      // One tag set matching the type's first group, so the client's own matching assigns the type.
      const tags: Record<string, string> = { name: `Example ${title(type.key)} ${i}` };
      for (const f of type.groups[0] ?? []) {
        if (f.op === "eq") tags[f.key] = f.value ?? "";
        else if (f.op === "exists") tags[f.key] = "yes";
        else tags[f.key] = sampleFor(f.value ?? "");
      }
      if (i % 4 === 0) tags.brand = `Example Brand ${title(type.key)}`;
      const id = 9_000_000_000 + Math.floor(unit("osm-id", plan.shape.id, type.key, i) * 999_999_999);
      const lat = at.lat + (unit("osm-lat", plan.shape.id, type.key, i) - 0.5) * at.spread;
      const lon = at.lon + (unit("osm-lon", plan.shape.id, type.key, i) - 0.5) * at.spread;
      elements.push(
        i % 3 === 0
          ? { type: "way", id, center: { lat: round(lat), lon: round(lon) }, tags }
          : { type: "node", id, lat: round(lat), lon: round(lon), tags },
      );
    }
  }
  return { status: 200, body: JSON.stringify({ ...head, elements }) };
}

const round = (n: number): number => Number(n.toFixed(7));

/** A value matching one of the config's regex shapes: `^(a|b)$` or the list form `(^|;) *(a|b) *(;|$)`. */
function sampleFor(pattern: string): string {
  const m = /\(([a-z0-9_|]+)\)/.exec(pattern.replace("(^|;)", "").replace("(;|$)", ""));
  return m?.[1]?.split("|")[0] ?? "yes";
}
