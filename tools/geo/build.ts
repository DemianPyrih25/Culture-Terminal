// The gazetteer build shared by tools/geo/nyc.ts and tools/geo/zcta.ts (D28): public boundary
// features in, a packages/geo/src/data/<metro>.ts module out. Local only: the inputs are downloaded by
// hand and never committed; the module it writes is what the @ct/geo tests check.
//
// Every polygon operation runs in mapshaper, which keeps a topology, so neighbouring areas share their
// border vertices through each step: clip to the metro outline (ZCTA builds) and repair rings and
// overlaps (-clean) -> dissolve areas into larger groups where a build asks (NYC's community districts)
// -> merge areas under MIN_AREA_KM2 into the neighbour they share the longest border with (-dissolve)
// -> drop polygon parts and holes under MIN_PART_KM2 -> simplify (Visvalingam at a metre interval,
// keep-shapes) and round to 5 decimals. Then, here: orient rings as RFC 7946 asks and
// validate them -> a query ring of at most MAX_WKT_VERTICES points that never self-intersects -> the
// centroid (shapes labelPoint) and geodesic area, exactly as createGeo would compute them.
//
// A module written here is not served until it is wired in: @ct/geo loads each city's polygons only on
// first use, so add a loader for it to GAZETTEER_LOADERS (packages/geo/src/gazetteer.ts), then regenerate
// the polygon-free catalog every metro is matched from, packages/geo/src/catalog.ts, with
// `pnpm --filter @ct/geo test -u` (its test fails while the catalog is stale). The rest of the checklist
// is in the header of tools/geo/zcta.ts. Every build prints WIRE_UP after writing a module.
import mapshaper from "mapshaper";
import type { GazetteerArea } from "../../packages/geo/src/gazetteer";
import { areaKm2 } from "../../packages/geo/src/measure";
import { centroid, labelPoint, MAX_WKT_VERTICES, outline } from "../../packages/geo/src/shapes";

/** GeoJSON shapes as @ct/geo types them (its geojson types are not a root dependency). */
export type Shape = GazetteerArea["geometry"];
type QueryPolygon = NonNullable<GazetteerArea["query"]>;
export type Position = QueryPolygon["coordinates"][number][number];
/** MultiPolygon coordinates: polygons, each an outer ring and then its holes. */
export type Parts = Position[][][];

/** What a build prints after writing a data module: the two steps that make @ct/geo serve it. */
export const WIRE_UP =
  "Next: add the module's loader to GAZETTEER_LOADERS in packages/geo/src/gazetteer.ts, then regenerate " +
  "packages/geo/src/catalog.ts with `pnpm --filter @ct/geo test -u`; the rest is in the header of tools/geo/zcta.ts.";

/** Polygon parts and holes below this are slivers. */
export const MIN_PART_KM2 = 0.02;
/** Areas below this merge into the neighbour they share the longest border with. */
export const MIN_AREA_KM2 = 0.1;
const DP = 5;

/** An area as its source describes it, before any geometry work. */
export interface SourceArea {
  /** The source's code for the area (an NTA or ZCTA code): unique, and every tie-break. */
  key: string;
  /** The data module id; the slug of `name` when absent. */
  id?: string;
  name: string;
  aliases: readonly string[];
  approximateAliases: readonly string[];
  geometry: Shape;
}

/** An area between build steps. */
export interface WorkArea {
  key: string;
  id: string;
  name: string;
  aliases: string[];
  approximateAliases: string[];
  parts: Parts;
}

/** A finished area: a GazetteerArea with every optional field filled in. */
export interface BuiltArea {
  id: string;
  name: string;
  aliases: string[];
  approximateAliases: string[];
  geometry: Shape;
  query: QueryPolygon;
  centroid: { lat: number; lon: number };
  areaKm2: number;
}

export interface ModuleSpec {
  metro: string;
  /** The exported constant, e.g. NYC. */
  constName: string;
  /** Gazetteer.source: the caption attribution, publisher and licence. */
  source: string;
  /** Comment lines that open the module. */
  header: readonly string[];
}

// ---------------------------------------------------------------------------------------------------
// Names

/** "Hell's Kitchen" → hells_kitchen: an id in AreaArg's pattern. */
export function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------------------------------
// mapshaper

interface Collection {
  type: "FeatureCollection";
  features: { type: "Feature"; properties: Record<string, unknown> | null; geometry: Shape | null }[];
}

const toParts = (g: Shape): Parts => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
export const km2 = (parts: Parts): number => areaKm2({ type: "MultiPolygon", coordinates: parts });
const ringKm2 = (ring: Position[]): number => areaKm2({ type: "Polygon", coordinates: [ring] });

function collection(features: readonly { key: string; geometry: Shape }[]): string {
  return JSON.stringify({
    type: "FeatureCollection",
    features: features.map((f) => ({ type: "Feature", properties: { key: f.key }, geometry: f.geometry })),
  });
}

/** Runs mapshaper commands and returns the one GeoJSON layer they write, full precision unless asked. */
async function run(commands: string, input: Readonly<Record<string, string>>, output = ""): Promise<Collection> {
  const out = await mapshaper.applyCommands(`${commands} -o out.json format=geojson${output}`, input);
  const file = out["out.json"];
  if (file === undefined) throw new Error(`mapshaper wrote no output for: ${commands}`);
  return JSON.parse(typeof file === "string" ? file : new TextDecoder().decode(file)) as Collection;
}

/** One area per key: the parts of every feature with that key dissolved together (mapshaper -dissolve). */
async function dissolve(features: readonly { key: string; parts: Parts }[]): Promise<Map<string, Parts>> {
  const input = collection(features.map((f) => ({ key: f.key, geometry: { type: "MultiPolygon" as const, coordinates: f.parts } })));
  return byKey(await run("-i areas.json -dissolve key", { "areas.json": input }));
}

/** Polygon features by their `key` property; an empty geometry counts as missing. */
function byKey(fc: Collection): Map<string, Parts> {
  const map = new Map<string, Parts>();
  for (const f of fc.features) {
    const key = String(f.properties?.key ?? "");
    if (f.geometry === null) continue;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") throw new Error(`mapshaper returned ${String((f.geometry as { type: unknown }).type)} for ${key}`);
    if (map.has(key)) throw new Error(`mapshaper returned ${key} twice`);
    map.set(key, toParts(f.geometry));
  }
  return map;
}

/**
 * Reads a boundary file mapshaper can import (GeoJSON, or a Shapefile as .shp or .zip) as GeoJSON
 * features, keeping only those whose bounding box meets `box` when one is given, so a national file
 * is cut down before any work. The file is data: it is parsed, never run.
 */
export async function readFeatures(file: string, box?: Bbox): Promise<Collection["features"]> {
  const path = file.replaceAll("\\", "/");
  if (path.includes('"')) throw new Error(`readFeatures: a quote in the path ${file}`);
  const filter = box === undefined ? "" : ` -filter "this.bounds[0] <= ${box.maxLon} && this.bounds[2] >= ${box.minLon} && this.bounds[1] <= ${box.maxLat} && this.bounds[3] >= ${box.minLat}"`;
  return (await run(`-i "${path}"${filter}`, {})).features;
}

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function bboxOfShapes(shapes: readonly Shape[]): Bbox {
  const box: Bbox = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const s of shapes) {
    for (const p of toParts(s).flat(2)) {
      box.minLon = Math.min(box.minLon, p[0] as number);
      box.minLat = Math.min(box.minLat, p[1] as number);
      box.maxLon = Math.max(box.maxLon, p[0] as number);
      box.maxLat = Math.max(box.maxLat, p[1] as number);
    }
  }
  return box;
}

// ---------------------------------------------------------------------------------------------------
// Steps

/**
 * Repairs the source areas (rings, and overlaps, which go to the smaller area), clipping them to
 * `clip` first when given. An area with nothing left is dropped and reported; without a clip, an area
 * that lost more than a sliver to the repair is reported too.
 */
export async function prepare(areas: readonly SourceArea[], report: string[], clip?: readonly Shape[]): Promise<WorkArea[]> {
  const keys = new Set<string>();
  for (const a of areas) {
    if (keys.has(a.key)) throw new Error(`prepare: area key ${a.key} repeats`);
    keys.add(a.key);
  }
  const input: Record<string, string> = { "areas.json": collection(areas) };
  let commands = "-i areas.json";
  if (clip !== undefined) {
    input["clip.json"] = collection(clip.map((geometry) => ({ key: "clip", geometry })));
    commands += " -clip clip.json";
  }
  const cleaned = byKey(await run(`${commands} -clean overlap-rule=min-area`, input));
  const out: WorkArea[] = [];
  for (const a of [...areas].sort((x, y) => x.key.localeCompare(y.key))) {
    const parts = cleaned.get(a.key);
    if (parts === undefined) {
      report.push(`${a.key}: nothing left ${clip === undefined ? "after repair" : "inside the clip outline"}, left out`);
      continue;
    }
    const before = areaKm2(a.geometry);
    const after = km2(parts);
    if (clip === undefined && before - after > 1e-4) report.push(`overlap: ${a.key} gave up ${(before - after).toFixed(4)} km2 of ${before.toFixed(3)} km2`);
    out.push({ key: a.key, id: a.id ?? slug(a.name), name: a.name, aliases: [...a.aliases], approximateAliases: [...a.approximateAliases], parts });
  }
  return out;
}

const point = (p: Position): string => `${p[0]},${p[1]}`;

/** Border length between neighbours, from the edges they share (mapshaper writes shared borders once). */
function sharedBorders(work: readonly WorkArea[]): Map<string, Map<string, number>> {
  const owner = new Map<string, string>();
  const borders = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, len: number): void => {
    const row = borders.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + len);
    borders.set(a, row);
  };
  for (const w of work) {
    for (const ring of w.parts.flat()) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i] as Position;
        const b = ring[i + 1] as Position;
        const [p, q] = [point(a), point(b)];
        const edge = p < q ? `${p} ${q}` : `${q} ${p}`;
        const other = owner.get(edge);
        if (other === undefined) {
          owner.set(edge, w.key);
          continue;
        }
        if (other === w.key) continue;
        // Degrees, longitude scaled by the cosine of latitude: enough to rank borders.
        const len = Math.hypot(((b[0] as number) - (a[0] as number)) * Math.cos(((a[1] as number) * Math.PI) / 180), (b[1] as number) - (a[1] as number));
        add(other, w.key, len);
        add(w.key, other, len);
      }
    }
  }
  return borders;
}

/**
 * Merges every area under MIN_AREA_KM2, smallest first, into the neighbour it shares the longest
 * border with (ties: the lower key); the host answers to the merged area's name and aliases too. An
 * area with no neighbour is dropped. Reported either way.
 */
export async function mergeTiny(work: readonly WorkArea[], report: string[]): Promise<WorkArea[]> {
  const size = new Map(work.map((w) => [w.key, km2(w.parts)]));
  const borders = sharedBorders(work);
  const area = new Map(work.map((w) => [w.key, { ...w, aliases: [...w.aliases], approximateAliases: [...w.approximateAliases] }]));
  const members = new Map(work.map((w) => [w.key, [w.key]]));
  const groupOf = new Map(work.map((w) => [w.key, w.key]));
  const groupKm2 = (g: string): number => (members.get(g) ?? []).reduce((s, m) => s + (size.get(m) ?? 0), 0);
  let changed = false;
  for (;;) {
    const tiny = [...members.keys()].filter((g) => groupKm2(g) < MIN_AREA_KM2).sort((a, b) => groupKm2(a) - groupKm2(b) || a.localeCompare(b))[0];
    if (tiny === undefined) break;
    changed = true;
    const shares = new Map<string, number>();
    for (const m of members.get(tiny) ?? []) {
      for (const [n, len] of borders.get(m) ?? []) {
        const g = groupOf.get(n);
        if (g !== undefined && g !== tiny) shares.set(g, (shares.get(g) ?? 0) + len);
      }
    }
    const host = [...shares].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
    const t = area.get(tiny) as WorkArea;
    if (host === undefined) {
      report.push(`tiny: dropped ${tiny} (${groupKm2(tiny).toFixed(3)} km2, no neighbour)`);
      for (const m of members.get(tiny) ?? []) groupOf.delete(m);
      members.delete(tiny);
      continue;
    }
    const h = area.get(host) as WorkArea;
    h.aliases.push(t.name, ...t.aliases);
    h.approximateAliases.push(...t.approximateAliases);
    report.push(`tiny: merged ${tiny} (${groupKm2(tiny).toFixed(3)} km2) into ${host}, name kept as an alias`);
    for (const m of members.get(tiny) ?? []) groupOf.set(m, host);
    members.set(host, [...(members.get(host) ?? []), ...(members.get(tiny) ?? [])]);
    members.delete(tiny);
  }
  if (!changed) return [...work];
  const dissolved = await dissolve(
    work.flatMap((w) => {
      const g = groupOf.get(w.key);
      return g === undefined ? [] : [{ key: g, parts: w.parts }];
    }),
  );
  return [...members.keys()].sort().map((g) => {
    const parts = dissolved.get(g);
    if (parts === undefined) throw new Error(`mergeTiny: mapshaper lost ${g}`);
    return { ...(area.get(g) as WorkArea), parts };
  });
}

/** A larger area made of whole repaired areas, such as a community district of tabulation areas. */
export interface Group {
  key: string;
  /** The data module id; the slug of `name` when absent. */
  id?: string;
  name: string;
  /** The keys of the areas it is made of. */
  members: readonly string[];
}

/** Dissolves repaired areas into their groups: every area belongs to exactly one group, every group has one. */
export async function dissolveGroups(work: readonly WorkArea[], groups: readonly Group[]): Promise<WorkArea[]> {
  const groupOf = new Map<string, string>();
  for (const g of groups) {
    for (const m of g.members) {
      if (groupOf.has(m)) throw new Error(`dissolveGroups: ${m} is in ${groupOf.get(m)} and ${g.key}`);
      groupOf.set(m, g.key);
    }
  }
  const dissolved = await dissolve(
    work.map((w) => {
      const key = groupOf.get(w.key);
      if (key === undefined) throw new Error(`dissolveGroups: ${w.key} is in no group`);
      return { key, parts: w.parts };
    }),
  );
  return [...groups]
    .sort((x, y) => x.key.localeCompare(y.key))
    .map((g) => {
      const parts = dissolved.get(g.key);
      if (parts === undefined) throw new Error(`dissolveGroups: ${g.key} has no area`);
      return { key: g.key, id: g.id ?? slug(g.name), name: g.name, aliases: [], approximateAliases: [], parts };
    });
}

/**
 * Drops parts and holes below MIN_PART_KM2. An area whose every part is that small keeps its largest
 * part. Run after mergeTiny: a hole that small can then hold only parts that small, which go too.
 */
export function dropSlivers(parts: Parts): Parts {
  const kept = parts
    .filter((poly) => poly[0] !== undefined && ringKm2(poly[0]) >= MIN_PART_KM2)
    .map((poly) => [poly[0] as Position[], ...poly.slice(1).filter((hole) => ringKm2(hole) >= MIN_PART_KM2)]);
  const largest = parts.filter((poly) => poly[0] !== undefined).sort((a, b) => ringKm2(b[0] as Position[]) - ringKm2(a[0] as Position[]))[0];
  return kept.length > 0 || largest === undefined ? kept : [[largest[0] as Position[]]];
}

/** Topology-preserving simplification at `interval` metres, rounded to 5 decimals. */
async function simplify(work: readonly WorkArea[], interval: number): Promise<Map<string, Parts>> {
  const features = work.map((w) => ({ key: w.key, geometry: { type: "MultiPolygon" as const, coordinates: w.parts } }));
  const commands = `-i areas.json -clean overlap-rule=min-area -simplify interval=${interval} keep-shapes`;
  return byKey(await run(commands, { "areas.json": collection(features) }, ` precision=${10 ** -DP}`));
}

// ---------------------------------------------------------------------------------------------------
// Rings

const round = (x: number): number => {
  const r = Math.round(x * 10 ** DP) / 10 ** DP;
  return Object.is(r, -0) ? 0 : r;
};
const same = (a: Position, b: Position): boolean => a[0] === b[0] && a[1] === b[1];

function orient(a: Position, b: Position, c: Position): number {
  const v = ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) - ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number));
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Position, b: Position, p: Position): boolean {
  return (
    Math.min(a[0] as number, b[0] as number) <= (p[0] as number) &&
    (p[0] as number) <= Math.max(a[0] as number, b[0] as number) &&
    Math.min(a[1] as number, b[1] as number) <= (p[1] as number) &&
    (p[1] as number) <= Math.max(a[1] as number, b[1] as number)
  );
}

function segmentsMeet(a: Position, b: Position, c: Position, d: Position): boolean {
  const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/** A closed ring with no repeated vertex and no two non-adjacent edges meeting. */
export function isSimple(ring: readonly Position[]): boolean {
  const pts = ring.slice(0, -1);
  const n = pts.length;
  if (n < 3) return false;
  if (new Set(pts.map(point)).size !== n) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(pts[i] as Position, pts[i + 1] as Position, pts[j] as Position, pts[(j + 1) % n] as Position)) return false;
    }
  }
  return true;
}

function signedArea(ring: readonly Position[]): number {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as Position;
    const b = ring[i + 1] as Position;
    s += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return s / 2;
}

/** Rounds, drops repeated points, closes, and orients a ring as RFC 7946 asks (outer CCW, holes CW). */
export function cleanRing(ring: readonly Position[], outer: boolean): Position[] | null {
  const pts: Position[] = [];
  for (const p of ring) {
    const q: Position = [round(p[0] as number), round(p[1] as number)];
    if (pts.length === 0 || !same(pts[pts.length - 1] as Position, q)) pts.push(q);
  }
  if (pts.length > 1 && same(pts[0] as Position, pts[pts.length - 1] as Position)) pts.pop();
  if (pts.length < 3) return null;
  pts.push(pts[0] as Position);
  if (signedArea(pts) === 0) return null;
  if (signedArea(pts) > 0 !== outer) pts.reverse();
  return pts;
}

/**
 * The query ring: Visvalingam–Whyatt down to `max` distinct vertices, never dropping a vertex whose
 * removal would make the ring cross itself. Deterministic: ties drop the earliest vertex.
 */
export function queryRing(ring: readonly Position[], max: number): Position[] {
  const pts = ring.slice(0, -1).map((p) => [p[0] as number, p[1] as number] as Position);
  const n0 = pts.length;
  const weight = (i: number): number => {
    const n = pts.length;
    const a = pts[(i - 1 + n) % n] as Position;
    const b = pts[i] as Position;
    const c = pts[(i + 1) % n] as Position;
    return Math.abs(((a[0] as number) - (c[0] as number)) * ((b[1] as number) - (a[1] as number)) - ((a[0] as number) - (b[0] as number)) * ((c[1] as number) - (a[1] as number)));
  };
  const safeToDrop = (i: number): boolean => {
    const n = pts.length;
    const a = pts[(i - 1 + n) % n] as Position;
    const c = pts[(i + 1) % n] as Position;
    for (let j = 0; j < n; j++) {
      // Skip the two edges the new edge a-c replaces and the edges that touch a or c.
      if (j === (i - 2 + n) % n || j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
      if (segmentsMeet(a, c, pts[j] as Position, pts[(j + 1) % n] as Position)) return false;
    }
    return true;
  };
  while (pts.length > max) {
    const order = pts.map((_, i) => i).sort((x, y) => weight(x) - weight(y) || x - y);
    const drop = order.find((i) => safeToDrop(i));
    if (drop === undefined) throw new Error(`queryRing: cannot simplify below ${pts.length} vertices (from ${n0})`);
    pts.splice(drop, 1);
  }
  const out = cleanRing([...pts, pts[0] as Position], true);
  if (out === null || !isSimple(out)) throw new Error("queryRing: rounding broke the ring");
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Pipeline

/** Valid rings, the query ring, centroid and area of each simplified area, sorted by id. */
function finish(work: readonly WorkArea[], simplified: ReadonlyMap<string, Parts>, report: string[]): BuiltArea[] {
  const built: BuiltArea[] = [];
  for (const w of work) {
    const parts = simplified.get(w.key);
    if (parts === undefined) throw new Error(`finish: no simplified geometry for ${w.key}`);
    const polys: Position[][][] = [];
    for (const poly of parts) {
      const outer = cleanRing(poly[0] ?? [], true);
      if (outer === null || ringKm2(outer) < MIN_PART_KM2) continue;
      const holes = poly
        .slice(1)
        .map((h) => cleanRing(h, false))
        .filter((h): h is Position[] => h !== null && ringKm2(h) >= MIN_PART_KM2);
      for (const r of [outer, ...holes]) if (!isSimple(r)) throw new Error(`finish: ${w.key} has an invalid ring after rounding (${r.length} points)`);
      polys.push([outer, ...holes]);
    }
    if (polys.length === 0) throw new Error(`finish: ${w.key} has no polygon left`);
    polys.sort((x, y) => ringKm2(y[0] as Position[]) - ringKm2(x[0] as Position[]));
    const geometry: Shape = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] as Position[][] } : { type: "MultiPolygon", coordinates: polys };
    const ring = outline(geometry);
    const q = queryRing(ring, MAX_WKT_VERTICES - 1);
    const c = labelPoint(geometry);
    const weighted = centroid(ring);
    if (c.lat !== weighted.lat || c.lon !== weighted.lon) report.push(`centroid: ${w.key}'s area-weighted centroid lies outside it, an interior point is used`);
    const share = ringKm2(q) / ringKm2([...ring]);
    if (share < 0.8 || share > 1.2) report.push(`query: ${w.key}'s query ring covers ${(share * 100).toFixed(0)}% of its outline`);
    const aliases = [...new Set(w.aliases.filter((x) => x !== w.name))];
    built.push({
      id: w.id,
      name: w.name,
      aliases,
      approximateAliases: [...new Set(w.approximateAliases.filter((x) => x !== w.name && !aliases.includes(x)))],
      geometry,
      query: { type: "Polygon", coordinates: [q] },
      centroid: { lat: round(c.lat), lon: round(c.lon) },
      areaKm2: Math.round(areaKm2(geometry) * 1000) / 1000,
    });
  }
  built.sort((x, y) => x.id.localeCompare(y.id));
  for (let i = 1; i < built.length; i++) if (built[i]?.id === built[i - 1]?.id) throw new Error(`finish: id ${built[i]?.id} repeats`);
  return built;
}

/** Repaired areas → merged, sliver-free, simplified at `interval` metres, finished. */
export async function buildAreas(work: readonly WorkArea[], interval: number, report: string[]): Promise<BuiltArea[]> {
  const merged = (await mergeTiny(work, report)).map((w) => ({ ...w, parts: dropSlivers(w.parts) }));
  return finish(merged, await simplify(merged, interval), report);
}

/** The data module: the header, then one object per area with its stored fields. */
export function moduleText(spec: ModuleSpec, built: readonly BuiltArea[]): string {
  const lines = [...spec.header, 'import type { Gazetteer } from "../gazetteer";', "", `export const ${spec.constName}: Gazetteer = {`, `  metro: "${spec.metro}",`, `  source: ${JSON.stringify(spec.source)},`, "  areas: ["];
  for (const b of built) {
    lines.push("    {");
    lines.push(`      id: ${JSON.stringify(b.id)},`);
    lines.push(`      name: ${JSON.stringify(b.name)},`);
    if (b.aliases.length > 0) lines.push(`      aliases: ${JSON.stringify(b.aliases)},`);
    if (b.approximateAliases.length > 0) lines.push(`      approximateAliases: ${JSON.stringify(b.approximateAliases)},`);
    lines.push(`      centroid: { lat: ${b.centroid.lat}, lon: ${b.centroid.lon} },`);
    lines.push(`      areaKm2: ${b.areaKm2},`);
    lines.push(`      query: ${JSON.stringify(b.query)},`);
    lines.push(`      geometry: ${JSON.stringify(b.geometry)},`);
    lines.push("    },");
  }
  lines.push("  ],", "};", "");
  return lines.join("\n");
}

/** One line per area for the build report: id, km², names. */
export function describeAreas(built: readonly BuiltArea[]): string[] {
  return built.map((b) => {
    const names = [
      b.name,
      b.aliases.length > 0 ? `aliases: ${b.aliases.join(", ")}` : "",
      b.approximateAliases.length > 0 ? `approximate: ${b.approximateAliases.join(", ")}` : "",
    ].filter((s) => s !== "");
    return `  ${b.id.padEnd(40)} ${b.areaKm2.toFixed(2).padStart(7)} km2  ${names.join(" | ")}`;
  });
}
