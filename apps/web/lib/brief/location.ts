import type { DatasetId, LocationMethod, MetroId, RunState, ToolCallState } from "@ct/contracts";
import { LOCATION_METHOD_VALUES, METRO_ID_VALUES, METRO_LABEL } from "@ct/contracts/values";

import type { BriefArea, BriefLocation } from "./types";

/** A closed-list check without zod (the client bundle split): the value is one of `values`. */
const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);

/**
 * Where a location brief stands (SPEC §8: the area name and the location method). A Block DNA call
 * reads its area down the ladder POLYGON → POINT → QUERY (SPEC §5.3 S7); each step down is a CODE
 * FALLBACK event, and the figure it drew carries the method it ended on. A lift map reads a whole
 * metro. Everything here comes from the run's own events: the intent, the tool calls' arguments, the
 * datasets and the evidence purposes QUANT wrote ("Tag fingerprint of East Nashville by POINT").
 */

/** How each method reads an area, in a reader's words. */
export const LOCATION_METHOD_LABEL: Readonly<Record<LocationMethod, string>> = {
  POLYGON: "its gazetteer boundary",
  POINT: "a centre point",
  QUERY: "a place-name search",
};

/** One area a Block DNA call read: its name, the method it ended on and its fallback steps (indexes into `state.fallbacks`). */
export interface AreaRead {
  toolCallId: string;
  name: string | null;
  metro: MetroId | null;
  method: LocationMethod | null;
  datasetIds: DatasetId[];
  fallbacks: number[];
}

const FINGERPRINT = /^Tag fingerprint of (.+) by (POLYGON|POINT|QUERY)\b/;
const BLOCK_TITLE = /^Block DNA · (.+) vs .+$/;

function metroOf(value: unknown): MetroId | null {
  return isOneOf(METRO_ID_VALUES, value) ? value : null;
}

/** The metro a location tool call names: geo_lift's `metro`, block_dna's `area.metro`. */
function argMetro(call: ToolCallState): MetroId | null {
  const args = call.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const area = record.area;
  const nested = area !== null && typeof area === "object" && !Array.isArray(area) ? (area as Record<string, unknown>).metro : undefined;
  return metroOf(record.metro) ?? metroOf(nested);
}

/** The areas the run's Block DNA calls read, in call order. */
export function areaReads(state: RunState): AreaRead[] {
  return state.toolCalls
    .filter((t) => t.tool === "block_dna")
    .map((call) => {
      const datasets = call.datasetIds.flatMap((id) => state.datasets[id] ?? []);
      const bars = datasets.find((d) => d.kind === "Bars");
      const payload = bars?.data?.kind === "Bars" ? bars.data.payload : null;
      const fingerprint = call.evidenceIds.map((id) => FINGERPRINT.exec(state.evidence[id]?.purpose ?? "")).find((m) => m !== null) ?? null;
      const fallbacks = state.fallbacks.flatMap((f, i) => (f.toolCallId === call.toolCallId ? [i] : []));
      const lastStep = fallbacks.length > 0 ? state.fallbacks[fallbacks.at(-1) as number]?.to : undefined;
      const method =
        payload?.method ??
        (isOneOf(LOCATION_METHOD_VALUES, fingerprint?.[2]) ? (fingerprint?.[2] as LocationMethod) : undefined) ??
        // Without a figure or a fingerprint yet, the last step down is where the ladder stands.
        (isOneOf(LOCATION_METHOD_VALUES, lastStep) ? (lastStep as LocationMethod) : undefined) ??
        null;
      const name = payload?.series[0]?.label ?? (bars ? BLOCK_TITLE.exec(bars.title)?.[1] : undefined) ?? fingerprint?.[1] ?? null;
      return { toolCallId: call.toolCallId, name, metro: argMetro(call), method, datasetIds: call.datasetIds, fallbacks };
    });
}

/** The city of the brief: the intent's metro, else the first location call's, else a lift map's. */
function cityOf(state: RunState): string | null {
  const intent = state.intent?.geo.metro ?? null;
  if (intent) return METRO_LABEL[intent];
  for (const call of state.toolCalls) {
    if (call.tool !== "geo_lift" && call.tool !== "block_dna") continue;
    const metro = argMetro(call);
    if (metro) return METRO_LABEL[metro];
  }
  for (const d of Object.values(state.datasets)) if (d.data?.kind === "GeoLift") return METRO_LABEL[d.data.payload.metro];
  return null;
}

/**
 * The brief's location: null for a brief that reads no place (no location desk, no lift map, no area).
 * `footnotes` numbers the fallbacks the figures cited, by their index in the run's fallbacks.
 */
export function buildLocation(state: RunState, footnotes: ReadonlyMap<number, number> = new Map()): BriefLocation | null {
  const pillar = state.report?.pillar ?? state.intent?.pillar ?? null;
  const reads = areaReads(state);
  const lifted = state.toolCalls.some((t) => t.tool === "geo_lift") || Object.values(state.datasets).some((d) => d.kind === "GeoLift");
  if (pillar !== "location" && reads.length === 0 && !lifted) return null;

  const city = cityOf(state);
  // An area read twice (a second Block DNA call, another rung) is one area: the method its last read
  // ended on, and every read's fallbacks in order.
  const byName = new Map<string, { method: LocationMethod | null; fallbacks: number[] }>();
  for (const read of reads) {
    const name = read.name ?? state.intent?.geo.area ?? null;
    if (name === null) continue;
    const seen = byName.get(name);
    byName.set(name, { method: read.method ?? seen?.method ?? null, fallbacks: [...(seen?.fallbacks ?? []), ...read.fallbacks] });
  }
  const areas: BriefArea[] = [...byName].map(([name, read]) => ({
    name,
    method: read.method,
    methodLabel: read.method ? LOCATION_METHOD_LABEL[read.method] : null,
    fallbacks: read.fallbacks.flatMap((i) => {
      const f = state.fallbacks[i];
      return f ? [{ from: f.from, to: f.to, reason: f.reason, line: `CODE FALLBACK · ${f.from} → ${f.to}: ${f.reason}`, footnote: footnotes.get(i) ?? null }] : [];
    }),
  }));
  // Before any area is read, the area the question asked about.
  const asked = state.intent?.geo.area ?? null;
  if (areas.length === 0 && asked) areas.push({ name: asked, method: null, methodLabel: null, fallbacks: [] });

  const place = [areas.map((a) => a.name).join(" and "), city].filter((p) => p !== null && p !== "").join(", ") || null;
  return { city, areas, place };
}

/** How a figure's dataset reads its place: a Block DNA figure's area, method and fallbacks; a lift map's metro. */
export interface DatasetPlace {
  place: string | null;
  method: LocationMethod | null;
  /** Indexes into `state.fallbacks`. */
  fallbacks: number[];
}

/** Where a figure reads, or null for a figure that reads no place. `reads` is areaReads(state). */
export function datasetPlace(state: RunState, datasetId: DatasetId, reads: readonly AreaRead[]): DatasetPlace | null {
  const read = reads.find((r) => r.datasetIds.includes(datasetId));
  if (read) return { place: read.name ?? state.intent?.geo.area ?? null, method: read.method, fallbacks: read.fallbacks };
  const dataset = state.datasets[datasetId];
  const kind = dataset?.kind ?? state.report?.exhibits.find((e) => e.datasetId === datasetId)?.kind;
  if (kind !== "GeoLift") return null;
  const metro =
    (dataset?.data?.kind === "GeoLift" ? dataset.data.payload.metro : null) ??
    state.toolCalls
      .filter((t) => t.tool === "geo_lift" && t.datasetIds.includes(datasetId))
      .map(argMetro)
      .find((m): m is MetroId => m !== null) ??
    state.intent?.geo.metro ??
    null;
  return { place: metro ? METRO_LABEL[metro] : null, method: null, fallbacks: [] };
}
