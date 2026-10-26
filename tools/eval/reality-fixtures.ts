// An invented Qloo world for the Reality Check tests (D29: every name, id and value here is made up).
// A scripted transport answers behind the real client, so every request passes the frozen allowlist
// and its value rules, and is canonicalised, cached and logged as in a live run, with no network.
import { MetroId, type GeoApi, type Neighbourhood, type QlooHeatmapCell, type QlooParams } from "@ct/contracts";
import { createMemoryQlooStore, createQlooClient, type CanonicalRequest, type QlooClient, type TransportResponse } from "@ct/qloo";

export interface WorldEntity {
  id: string;
  name: string;
  type: "brand" | "artist" | "person";
  popularity: number | null;
}

export interface World {
  entities: readonly WorldEntity[];
  /** The brands a discovery call returns (no candidate list), by its signal entity's id: a Reality Check pool is the choice's. */
  pools: Readonly<Record<string, readonly string[]>>;
  /** A candidate's affinity under a seed's taste, by seed id; a candidate missing here is dropped from the response. */
  affinity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** A person's affinity in a locality's rank call, by locality id. */
  localities: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Heatmap cells by `${filter.location}|${signal}`, the signal an entity id or a tag URN. */
  heatmaps: Readonly<Record<string, readonly QlooHeatmapCell[]>>;
}

const list = (params: QlooParams, key: string): string[] => {
  const value = params[key];
  return value === undefined ? [] : Array.isArray(value) ? [...value] : String(value).split(",");
};

const text = (params: QlooParams, key: string): string => String(params[key] ?? "");

function entityRow(e: WorldEntity, affinity: number | undefined) {
  return {
    entity_id: e.id,
    name: e.name,
    type: `urn:entity:${e.type}`,
    popularity: e.popularity,
    ...(affinity === undefined ? {} : { query: { affinity } }),
  };
}

/** The body Qloo would send for a request in this world. */
export function answer(world: World, request: CanonicalRequest): unknown {
  const { params } = request;
  const byId = new Map(world.entities.map((e) => [e.id, e]));
  if (request.path === "/search") {
    // A name and the names that extend it, of the requested type: "Brand Kappa" also finds "Brand Kappa Classic".
    const query = text(params, "query").toLowerCase();
    const type = text(params, "types");
    const results = world.entities
      .filter((e) => `urn:entity:${e.type}` === type && e.name.toLowerCase().startsWith(query))
      .map((e) => ({ entity_id: e.id, name: e.name, types: [type], ...(e.popularity === null ? {} : { popularity: e.popularity }) }));
    return { results };
  }
  if (request.path !== "/v2/insights") throw new Error(`the test world does not answer ${request.path}`);
  if (request.filterType === "urn:heatmap") {
    const signal = [...list(params, "signal.interests.entities"), ...list(params, "signal.interests.tags")].join(",");
    return { success: true, results: { heatmap: world.heatmaps[`${text(params, "filter.location")}|${signal}`] ?? [] } };
  }
  const candidates = list(params, "filter.results.entities");
  if (request.filterType === "urn:entity:person") {
    const scores = world.localities[text(params, "signal.location")] ?? {};
    const rows = candidates.flatMap((id) => {
      const e = byId.get(id);
      return e === undefined || scores[id] === undefined ? [] : [entityRow(e, scores[id])];
    });
    return { success: true, results: { entities: rows } };
  }
  const [seed = ""] = list(params, "signal.interests.entities");
  const scores = world.affinity[seed] ?? {};
  const ids = candidates.length > 0 ? candidates.filter((id) => scores[id] !== undefined) : (world.pools[seed] ?? []);
  const rows = ids.flatMap((id) => {
    const e = byId.get(id);
    return e === undefined ? [] : [entityRow(e, scores[id])];
  });
  return { success: true, results: { entities: rows } };
}

const encoder = new TextEncoder();

/** The real Qloo client over the world, with every request the transport received. */
export function worldClient(world: World): { client: QlooClient; requests: CanonicalRequest[] } {
  const requests: CanonicalRequest[] = [];
  const transport = async (request: CanonicalRequest): Promise<TransportResponse> => {
    requests.push(request);
    return {
      status: 200,
      body: encoder.encode(JSON.stringify(answer(world, request))),
      headers: {
        requestId: null,
        monthLimit: 50_000,
        monthRemaining: 45_000,
        monthReset: 3_600,
        secondLimit: 10,
        secondRemaining: 9,
        secondReset: null,
      },
      ms: 1,
    };
  };
  const client = createQlooClient({
    transport,
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "reality-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
  return { client, requests };
}

// A gazetteer of invented areas. Each cell's geohash carries its area in its fourth character, which
// the fake centroid turns into a latitude that locate() reads back.

/** Fourth geohash character per area index (valid geohash letters). */
const AREA_CHARS = "bcdefghjkmnp";
const CELL_CHARS = "0123456789";

export interface FakeArea {
  id: string;
  name: string;
}

export function gridGeo(metro: MetroId, areas: readonly FakeArea[]): GeoApi {
  const unused = (): never => {
    throw new Error("unused geo call");
  };
  const hoods: Neighbourhood[] = areas.map((a, i) => ({ id: a.id, name: a.name, metro, centroid: { lat: i, lon: 0 }, areaKm2: 1 }));
  return {
    metros: () => MetroId.options,
    neighbourhoods: (m) => (m === metro ? hoods : []),
    neighbourhood: (m, id) => (m === metro ? (hoods.find((h) => h.id === id) ?? null) : null),
    matchNeighbourhood: (m, name) => (m === metro ? (hoods.find((h) => h.name.toLowerCase() === name.trim().toLowerCase()) ?? null) : null),
    polygonWkt: unused,
    locate: (m, p) => (m === metro ? (hoods[p.lat]?.id ?? null) : null),
    geohashCentroid: (g) => ({ lat: AREA_CHARS.indexOf(g[3] ?? ""), lon: 0 }),
    boundarySource: () => "Invented test boundaries",
  };
}

/** `n` cells of area `index`, all with one affinity (and a popularity, for a baseline map). */
export function areaCells(index: number, n: number, affinity: number, popularity: number | null = null): QlooHeatmapCell[] {
  return Array.from({ length: n }, (_, j) => {
    const geohash = `9v6${AREA_CHARS[index]}${CELL_CHARS[j]}zz`;
    return {
      location: { latitude: index, longitude: j, geohash },
      query: { affinity, ...(popularity === null ? {} : { popularity }) },
    };
  });
}
