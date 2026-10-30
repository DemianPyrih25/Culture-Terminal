import type { AiContextBlock, DatasetEnvelope, GeoLiftNeighbourhood, GeoLiftPayload, RunEvent, SupplyPayload, WebContextBlock } from "@ct/contracts";

/**
 * Variants of the synthetic job runs for the /dev/brief viewer: "notenough" turns the finished report's
 * signal to insufficient evidence, so the answer page's "Not enough data" verdict can be checked.
 * "part11" adds what Part 11 draws, all invented: the two context blocks (as `context.ai` and `context.web`
 * events and in the report, with links on reserved .test domains), popular and hidden areas on any lift map (R7), and an
 * OpenStreetMap supply read of the lift map's first areas with invented place names (R6), so the phone
 * check and the dev viewer show every new card without a key. Every event still passes the RunEvent schema.
 */

export const VARIANTS = ["notenough", "part11"] as const;
export type Variant = (typeof VARIANTS)[number];

export function isVariant(value: string | null): value is Variant {
  return value !== null && (VARIANTS as readonly string[]).includes(value);
}

export function variantEvents(events: readonly RunEvent[], variant: Variant): RunEvent[] {
  if (variant === "part11") return part11Events(events);
  return events.map((e) => {
    if (e.type !== "report.final") return e;
    return { ...e, report: { ...e.report, verdict: { ...e.report.verdict, signal: "insufficient_evidence", tag: null } } } as RunEvent;
  });
}

// part11 ------------------------------------------------------------------------------------------------

function aiBlock(at: string): AiContextBlock {
  return {
    status: "ok",
    items: [
      { topic: "Ownership", text: "Described as an independent, founder-led company (invented for this sample).", kind: "deal" },
      { topic: "Where it operates", text: "Said to be strongest in the South, with a few stores in larger cities.", kind: "footprint" },
      { topic: "Brand safety", text: "No widely reported controversy is known for this invented brand.", kind: "risk" },
    ],
    presenceMarkets: ["nashville", "austin"],
    model: "claude-sonnet-5-5",
    generatedAt: at,
    cached: false,
    note: null,
    droppedForNumbers: 0,
  };
}

function webBlock(at: string): WebContextBlock {
  return {
    status: "ok",
    items: [
      {
        claim: "A local food site reported that the brand opened a tasting room this autumn (invented sample).",
        url: "https://news.invented-site.test/sample-tasting-room",
        title: "A tasting room opens (invented test page)",
        publisher: "news.invented-site.test",
        published: "October 2, 2026",
        publishedIso: "2026-10-02",
        retrievedAt: at,
        citedText: "the brand opened a tasting room this autumn",
      },
      {
        claim: "A trade newsletter said the company is testing a lower-sugar line (invented sample).",
        url: "https://trade.invented-site.test/sample-new-line",
        title: "A new line on test (invented test page)",
        publisher: "trade.invented-site.test",
        published: null,
        publishedIso: null,
        retrievedAt: at,
        citedText: "testing a lower-sugar line",
      },
    ],
    model: "claude-haiku-5-5",
    searches: 2,
    retrievedAt: at,
    cached: false,
    note: null,
    droppedForNumbers: 0,
  };
}

/** Invented raw interest per area, ranked into rawPct, and the STANDING rule (0.75 / 0.5) applied. */
function withStanding(payload: GeoLiftPayload): GeoLiftPayload {
  const areas = payload.neighbourhoods;
  const n = areas.length;
  if (n === 0 || payload.coarse) return payload;
  const raw = areas.map((a, i) => ({ id: a.id, raw: Number((0.2 + ((n - i) % n) / n / 2 + (i % 3) * 0.05).toFixed(3)) }));
  const order = [...raw].sort((a, b) => a.raw - b.raw);
  const pct = new Map(order.map((r, i) => [r.id, n > 1 ? i / (n - 1) : 1]));
  const next: GeoLiftNeighbourhood[] = areas.map((a, i) => {
    const rawPct = n >= 3 ? Number((pct.get(a.id) ?? 0).toFixed(3)) : null;
    const demand = a.demandPct;
    const standing =
      rawPct === null
        ? null
        : rawPct >= 0.75 && demand !== null && demand >= 0.75
          ? ("popular_distinct" as const)
          : rawPct >= 0.75
            ? ("popular" as const)
            : demand !== null && demand >= 0.75 && rawPct < 0.5
              ? ("hidden" as const)
              : null;
    return { ...a, raw: raw[i]?.raw ?? null, rawPct, standing };
  });
  return {
    ...payload,
    neighbourhoods: next,
    popular: next.filter((a) => a.standing === "popular" || a.standing === "popular_distinct").sort((a, b) => (b.rawPct ?? 0) - (a.rawPct ?? 0)).slice(0, 3).map((a) => a.id),
    hidden: next.filter((a) => a.standing === "hidden").sort((a, b) => (b.demandPct ?? 0) - (a.demandPct ?? 0)).slice(0, 3).map((a) => a.id),
  };
}

/** An invented OpenStreetMap read of the map's first three areas: cafés and street activity, two places. */
function supplyOf(geo: GeoLiftPayload): SupplyPayload | null {
  const areas = geo.neighbourhoods.slice(0, 3);
  const at = geo.cells.find((c) => c.neighbourhood === areas[0]?.id);
  if (areas.length === 0) return null;
  const centre = at ? { lat: 30.26, lon: -97.74 } : { lat: 30.26, lon: -97.74 };
  return {
    source: "osm",
    attribution: "© OpenStreetMap contributors",
    licence: "ODbL-1.0",
    licenceUrl: "https://www.openstreetmap.org/copyright",
    osmBase: "2026-10-28T06:00:00Z",
    scope: "areas",
    metro: geo.metro,
    market: null,
    radiusKm: null,
    types: [{ key: "cafe", label: "Cafés and coffee shops", tags: ["amenity=cafe"] }],
    rows: areas.map((a, i) => ({
      id: a.id,
      name: a.name,
      areaKm2: 3 + i,
      counts: { cafe: [14, 5, 8][i] ?? 0 },
      perKm2: { cafe: [4.7, 1.25, 1.6][i] ?? 0 },
      index: { cafe: [2.2, 0.6, 0.95][i] ?? null },
      activity: [120, 35, 60][i] ?? null,
      activityPerKm2: [40, 9, 12][i] ?? null,
    })),
    city: { label: "The city (approximate area)", areaKm2: 700, approximate: true, counts: { cafe: 1500 }, perKm2: { cafe: 2.14 }, activityPerKm2: 11 },
    mix: null,
    places: [
      { name: "Example Café 1", brand: null, lat: centre.lat, lon: centre.lon, typeKey: "cafe", area: areas[0]?.id ?? null, osmUrl: "https://www.openstreetmap.org/node/1000000001" },
      { name: "Example Café 2", brand: null, lat: centre.lat + 0.004, lon: centre.lon + 0.003, typeKey: "cafe", area: areas[0]?.id ?? null, osmUrl: "https://www.openstreetmap.org/node/1000000002" },
    ],
    completeness: "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.",
    caption: "Invented sample: places counted in each area's outline, against the city's level.",
  };
}

function part11Events(events: readonly RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  let supply: DatasetEnvelope | null = null;
  const usedIds = new Set(events.flatMap((e) => (e.type === "dataset.ready" ? [e.datasetId] : [])));
  let nextId = 1;
  while (usedIds.has(`D${nextId}` as `D${number}`)) nextId += 1;
  for (const e of events) {
    if (e.type === "dataset.ready" && e.inline?.kind === "GeoLift") {
      const payload = withStanding(e.inline.payload);
      out.push({ ...e, inline: { ...e.inline, payload } } as RunEvent);
      const read: SupplyPayload | null = supply === null ? supplyOf(payload) : null;
      if (read) {
        supply = { id: `D${nextId}`, kind: "Supply", title: "Cafés already in the areas (invented sample)", evidenceIds: e.inline.evidenceIds.slice(0, 1), formulaIds: ["osm.count", "osm.density"], payload: read };
        out.push({ ...e, type: "dataset.ready", datasetId: supply.id, kind: "Supply", title: supply.title, bytes: 2000, inline: supply } as RunEvent);
      }
      continue;
    }
    if (e.type === "report.final") {
      const at = e.ts;
      out.push({ ...e, type: "context.ai", block: aiBlock(at), usd: 0, ms: 0 } as unknown as RunEvent);
      out.push({ ...e, type: "context.web", block: webBlock(at), usd: 0, ms: 0 } as unknown as RunEvent);
      const exhibits = supply
        ? [
            ...e.report.exhibits,
            {
              datasetId: supply.id,
              kind: "Supply" as const,
              viz: "SupplyTable" as const,
              title: supply.title,
              caption: "Counts are a floor.",
              badges: ["MEASURED" as const],
              sourceLine: "Source: OpenStreetMap via Overpass API · © OpenStreetMap contributors (ODbL)",
              evidenceIds: supply.evidenceIds,
            },
          ]
        : e.report.exhibits;
      out.push({ ...e, report: { ...e.report, exhibits, aiContext: aiBlock(at), webContext: webBlock(at) } } as RunEvent);
      continue;
    }
    out.push(e);
  }
  // The inserted events take the next sequence numbers; strip the copied payload keys of the source event.
  return out.map((e, i) => clean({ ...e, seq: i + 1 } as RunEvent));
}

/** An inserted event keeps only its own keys (the envelope plus its payload). */
function clean(e: RunEvent): RunEvent {
  const base = { seq: e.seq, ts: e.ts, runId: e.runId, type: e.type };
  const rec = e as unknown as Record<string, unknown>;
  if (e.type === "context.ai" || e.type === "context.web") return { ...base, block: rec.block, usd: rec.usd, ms: rec.ms } as unknown as RunEvent;
  if (e.type === "dataset.ready" && rec.kind === "Supply") {
    return { ...base, datasetId: rec.datasetId, kind: rec.kind, title: rec.title, bytes: rec.bytes, inline: rec.inline } as unknown as RunEvent;
  }
  return e;
}
