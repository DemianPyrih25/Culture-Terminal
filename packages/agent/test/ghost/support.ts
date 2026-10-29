// Fakes for the GHOST tests: a scripted /search, a small gazetteer and market list, and builders for
// the datasets the diff reads. Every name, id and number is invented (D29).
import {
  DatasetEnvelope,
  PositionAxis,
  type DatasetId,
  type EntityRef,
  type GhostAnswer,
  type Job,
  type MetroId,
  type Neighbourhood,
  type QlooParams,
  type QlooResult,
  type QlooSearchEntity,
  type QlooSearchResponse,
  type SponsorCategory,
} from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import type { GazetteerLike, GhostMarket } from "../../src/ghost/places";
import { createEntityRegistry, type RunRegistry } from "../../src/registry";

// Answers ------------------------------------------------------------------------------------------

const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] };

export function answer(picks: Partial<GhostAnswer["picks"]> = {}, numericClaims: string[] = [], headline = "Brand Alpha is a niche."): GhostAnswer {
  return { headline, picks: { ...NO_PICKS, ...picks }, numeric_claims: numericClaims };
}

// Search -------------------------------------------------------------------------------------------

export const entity = (entityId: string, name: string, type = "urn:entity:brand", extra: Partial<QlooSearchEntity> = {}): QlooSearchEntity => ({
  entity_id: entityId,
  name,
  types: [type],
  ...extra,
});

/**
 * A scripted cached /search: results per query (case-insensitive), the same for any type. It records
 * every request; a query listed in `fail` rejects.
 */
export class FakeSearch {
  readonly calls: QlooParams[] = [];
  readonly #results: Readonly<Record<string, readonly QlooSearchEntity[]>>;
  readonly #fail: ReadonlySet<string>;

  constructor(results: Readonly<Record<string, readonly QlooSearchEntity[]>> = {}, fail: ReadonlySet<string> = new Set()) {
    this.#results = results;
    this.#fail = fail;
  }

  readonly search = async (params: QlooParams): Promise<QlooResult<QlooSearchResponse>> => {
    this.calls.push(params);
    const query = String(params.query ?? "");
    if (this.#fail.has(query)) throw new Error(`synthetic search failure for ${query}`);
    const key = Object.keys(this.#results).find((k) => k.toLowerCase() === query.toLowerCase());
    return {
      data: { results: [...(key === undefined ? [] : (this.#results[key] ?? []))] },
      meta: {
        qlooCallId: `qc-${this.calls.length}`,
        requestId: `req-fake-${this.calls.length}`,
        cache: "hit",
        fetchedAt: "2026-01-05T10:00:00.000Z",
        ms: 1,
        stale: false,
        originRunId: null,
      },
    };
  };

  queries(): string[] {
    return this.calls.map((c) => String(c.query));
  }
}

// Places -------------------------------------------------------------------------------------------

const area = (metro: MetroId, id: string, name: string): Neighbourhood => ({ id, name, metro, centroid: { lat: 0, lon: 0 }, areaKm2: 1 });

/** Invented areas; "Old Town" exists in both metros. */
const AREAS: readonly Neighbourhood[] = [
  area("nashville", "lantern_row", "Lantern Row"),
  area("nashville", "mill_quarter", "Mill Quarter"),
  area("nashville", "old_town_n", "Old Town"),
  area("austin", "cedar_bend", "Cedar Bend"),
  area("austin", "old_town_a", "Old Town"),
];

export const FAKE_GEO: GazetteerLike = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: (metro) => AREAS.filter((a) => a.metro === metro),
  matchNeighbourhood: (metro, text) => AREAS.find((a) => a.metro === metro && normaliseName(a.name) === normaliseName(text)) ?? null,
  neighbourhood: (metro, id) => AREAS.find((a) => a.metro === metro && a.id === id) ?? null,
};

/** Invented markets; two share the city name Riverton. */
export const FAKE_MARKETS: readonly GhostMarket[] = [
  { id: "harbor_city", label: "Harbor City", state: "QA", query: "Harbor City", stateName: "Quillan" },
  { id: "riverton_q", label: "Riverton", state: "QA", query: "Riverton", stateName: "Quillan" },
  { id: "riverton_b", label: "Riverton", state: "QB", query: "Riverton", stateName: "Brevia" },
  { id: "nashville", label: "Nashville", state: "TN", query: "Nashville", stateName: "Tennessee" },
];

// Registry -----------------------------------------------------------------------------------------

/** A registry holding the given brands, refs R1, R2, … in order, each with entity id `ent-<slug>`. */
export function registryOf(brands: readonly [name: string, popularity: number | null][]): { registry: RunRegistry; ref: (name: string) => EntityRef } {
  const registry = createEntityRegistry();
  const refs = new Map<string, EntityRef>();
  for (const [name, popularity] of brands) {
    const r = registry.registerEntity({ entityId: entityIdOf(name), name, type: "brand", popularity, disambiguation: null, tags: [] });
    refs.set(name, r.ref);
  }
  return {
    registry,
    ref: (name) => {
      const r = refs.get(name);
      if (r === undefined) throw new Error(`no ref for ${name}`);
      return r;
    },
  };
}

export const entityIdOf = (name: string): string => `ent-${normaliseName(name).replace(/ /g, "-")}`;

// Datasets -----------------------------------------------------------------------------------------

const base = (id: DatasetId, title: string, formulaIds: string[]) => ({ id, title, evidenceIds: ["E1" as const], formulaIds });
const axis = (key: string, label: string, ref: EntityRef | null, group: string | null = null) => ({ key, label, ref, group });
const scored = (value: number) => ({ value, reason: null, rank: null });
const self = { value: null, reason: "self" as const, rank: null };
const unscored = { value: null, reason: "not_scored" as const, rank: null };

/** A Substitution Map: the target's row holds the given similarities (null: not scored). */
export function subsMap(id: DatasetId, target: [EntityRef, string], peers: readonly [EntityRef, string, number | null][]): DatasetEnvelope {
  const members = [target, ...peers.map(([r, l]) => [r, l] as [EntityRef, string])];
  const axes = members.map(([r, l]) => axis(r, l, r));
  const cells = members.map((_, i) =>
    members.map((__, j) => {
      if (i === j) return self;
      if (i !== 0) return scored(0.5);
      const sim = peers[j - 1]?.[2] ?? null;
      return sim === null ? unscored : scored(sim);
    }),
  );
  return DatasetEnvelope.parse({
    ...base(id, `Substitution Map · ${target[1]}`, ["subs.similarity", "subs.rank_in_row", "subs.hub"]),
    kind: "Matrix",
    payload: {
      mode: "similarity",
      valueLabel: "Audience taste similarity",
      unit: "similarity",
      comparator: "PEERS",
      rows: axes,
      cols: axes,
      cells,
      margin: null,
      targetKey: target[0],
      annotations: [],
    },
  });
}

/** A Share of Taste grid: the subject's within-call percentile per market (null: not scored), plus one age row. */
export function shareGrid(id: DatasetId, subject: [EntityRef, string], others: readonly [EntityRef, string][], markets: readonly [string, string, number | null][]): DatasetEnvelope {
  const cols = [subject, ...others].map(([r, l]) => axis(r, l, r));
  const rows = [axis("age:25_to_29", "25–29", null, "AGE"), ...markets.map(([m, label]) => axis(`metro:${m}`, label, null, "METRO"))];
  const cells = rows.map((_, i) =>
    cols.map((__, j) => {
      if (j !== 0) return scored(0.5);
      if (i === 0) return scored(0.99); // the age row outranks every market and must be ignored
      const pct = markets[i - 1]?.[2] ?? null;
      return pct === null ? unscored : scored(pct);
    }),
  );
  return DatasetEnvelope.parse({
    ...base(id, `Share of Taste · ${subject[1]}`, ["share.pct"]),
    kind: "Matrix",
    payload: {
      mode: "share",
      valueLabel: "Share-of-Taste percentile (within call)",
      unit: "pct",
      comparator: "WITHIN_CALL",
      rows,
      cols,
      cells,
      margin: null,
      targetKey: subject[0],
      annotations: [],
    },
  });
}

/** A travel-taste Quadrant: [label, ref, popularity, fit]. */
export function travelQuadrant(id: DatasetId, points: readonly [string, EntityRef | null, number, number][]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Travel taste · Brand Alpha", ["trvl.quadrant", "trvl.hidden_pocket", "popularity", "quality_gate"]),
    kind: "Quadrant",
    payload: {
      xLabel: "Popularity",
      yLabel: "Travel-taste FIT (within-call percentile)",
      xUnit: "popularity",
      yUnit: "pct",
      xSplit: 0.5,
      ySplit: 0.5,
      quadrantLabels: { HEARTLAND: "H", HIDDEN_POCKET: "P", MASS: "M", COLD: "C" },
      points: points.map(([label, ref, x, y], i) => ({
        key: ref ?? `dest-${i + 1}`,
        label,
        ref,
        x,
        y,
        quadrant: "HEARTLAND",
        score: null,
        labelled: true,
        group: null,
        utr: false,
        geo: null,
      })),
      omitted: [],
      belts: [],
      inset: "us_dots",
      caption: "Travel taste.",
    },
  });
}

/** A Lift Map over gazetteer areas: [id, name, lift] (null: insufficient cells). */
export function liftMap(id: DatasetId, metro: MetroId, areas: readonly [string, string, number | null][], coarse = false): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Lift Map · ramen in Nashville", ["lift.cell", "lift.area", "lift.confidence"]),
    kind: "GeoLift",
    payload: {
      metro,
      precision: coarse ? 4 : 6,
      precisionFactor: coarse ? 0 : 0.8,
      coarse,
      concept: { label: "ramen", tagRefs: [], entityRefs: [] },
      baseline: { label: "restaurants", tag: "urn:tag:genre:place:restaurant" },
      cells: [],
      neighbourhoods: areas.map(([areaId, name, lift]) => ({
        id: areaId,
        name,
        n: 6,
        lift,
        conf: lift === null ? null : 0.5,
        demandPct: null,
        supplyPct: null,
        supplyCount: null,
        whiteSpace: null,
        quadrant: null,
        reason: lift === null ? "insufficient_n" : null,
      })),
      supply: null,
      boundarySource: "Invented boundaries.",
      caption: "Lift.",
    },
  });
}

/** Block DNA Bars for one area (key: the gazetteer id, or "point"). */
export function blockBars(id: DatasetId, areaKey: string, label: string): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, `Block DNA · ${label} vs Nashville`, ["block.rank_delta", "block.new_tag"]),
    kind: "Bars",
    payload: {
      mode: "diverging",
      comparator: "CITY",
      valueLabel: "Tag rank gain vs Nashville",
      unit: "delta",
      series: [axis(areaKey, label, null)],
      groups: [],
      method: "POLYGON",
      domain: null,
      caption: null,
    },
  });
}

/** A tenant-fit Slope (city → site): [ref, label, TenantFit] (null: not ranked at both). */
export function tenantSlope(id: DatasetId, lines: readonly [EntityRef, string, number | null][]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Tenant fit · Lantern Row vs Nashville (city)", ["pct.within_call", "tenant.rank_shift", "tenant.fit"]),
    kind: "Slope",
    payload: {
      axes: [
        { key: "city:nashville", label: "Nashville (city)" },
        { key: "site:nashville:lantern_row", label: "Lantern Row" },
      ],
      scale: "pct",
      comparator: "CITY",
      valueLabel: "FIT",
      scoreLabel: "Tenant fit (0–100)",
      lines: lines.map(([ref, label, score]) => ({
        key: ref,
        label,
        ref,
        points: [scored(0.5), scored(0.5)],
        delta: 0,
        highlight: false,
        score,
      })),
    },
  });
}

const rankedRow = (key: string, rank: number | null, label: string, ref: EntityRef | null, cells: { value: number | null; reason: null | "not_measured" }[]) => ({
  key,
  rank,
  label,
  sublabel: null,
  ref,
  tagRef: null,
  type: "brand" as const,
  cells,
  flags: [],
  explain: [],
});

/** Local brands of a block, in rank order: [ref, label, popularity]. */
export function localBrands(id: DatasetId, rows: readonly [EntityRef | null, string, number][]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Local brands · Lantern Row vs Nashville", ["block.rank_delta", "popularity"]),
    kind: "Ranked",
    payload: {
      columns: [
        { key: "delta", label: "Rank gain", unit: "delta", comparator: "CITY" },
        { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
      ],
      groups: [{ key: "local", label: "Local", rows: rows.map(([ref, label, pop], i) => rankedRow(`local-${i + 1}`, i + 1, label, ref, [{ value: 3, reason: null }, { value: pop, reason: null }])) }],
      caption: null,
    },
  });
}

/** A cultural neighbourhood with one brand group, in rank order: [ref, label, popularity]. */
export function crossDomain(id: DatasetId, brands: readonly [EntityRef | null, string, number][]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Cultural neighbourhood · Artist Nova", ["pct.within_call", "popularity", "xdom.under_the_radar"]),
    kind: "Ranked",
    payload: {
      columns: [
        { key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" },
        { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
      ],
      groups: [
        { key: "artist", label: "Music", rows: [rankedRow("artist-1", 1, "Band Zeta", null, [{ value: 0.9, reason: null }, { value: 0.4, reason: null }])] },
        { key: "brand", label: "Brands", rows: brands.map(([ref, label, pop], i) => rankedRow(`brand-${i + 1}`, i + 1, label, ref, [{ value: 0.8, reason: null }, { value: pop, reason: null }])) },
      ],
      caption: null,
    },
  });
}

/** A one-context rank at a site, in rank order. */
export function siteRanked(id: DatasetId, rows: readonly [EntityRef, string][]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, "Ranked · Lantern Row", ["pct.within_call", "popularity"]),
    kind: "Ranked",
    payload: {
      columns: [
        { key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" },
        { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
      ],
      groups: [{ key: "site:nashville:lantern_row", label: "Lantern Row", rows: rows.map(([ref, label], i) => rankedRow(ref, i + 1, label, ref, [{ value: 0.7, reason: null }, { value: null, reason: "not_measured" }])) }],
      caption: null,
    },
  });
}

type SlateEntryInput = [ref: EntityRef, label: string, fit: number, popularity: number];

/** A sponsor slate: per category its best fit and runner-up. */
export function slate(id: DatasetId, seed: [EntityRef, string], rows: readonly { category: SponsorCategory; best: SlateEntryInput; runnerUp: SlateEntryInput | null }[]): DatasetEnvelope {
  const entry = ([ref, label, fit, popularity]: SlateEntryInput) => ({ ref, label, fit: { value: fit, reason: null }, popularity, utr: false, topMarkets: [] });
  return DatasetEnvelope.parse({
    ...base(id, `Sponsor slate · ${seed[1]}`, ["slate.best_fit", "pct.within_call"]),
    kind: "Slate",
    payload: {
      seed: { ref: seed[0], label: seed[1] },
      rows: rows.map((r) => ({ category: r.category, label: r.category, best: entry(r.best), runnerUp: r.runnerUp === null ? null : entry(r.runnerUp), reason: null })),
      markets: [],
      caption: "taste fit only; no fee, availability or ROI data",
    },
  });
}

/** A Taste Position card about `subject`, every axis unmeasured. */
export function positionCard(id: DatasetId, subject: [EntityRef, string]): DatasetEnvelope {
  return DatasetEnvelope.parse({
    ...base(id, `Taste Position · ${subject[1]}`, []),
    kind: "Position",
    payload: {
      subject: { ref: subject[0], label: subject[1] },
      peerCount: 0,
      axes: PositionAxis.options.map((a) => ({
        axis: a,
        label: a,
        display: "Not measured",
        value: null,
        reason: "not_measured",
        badge: "UNAVAILABLE",
        peerRank: null,
        note: null,
        metricId: null,
        datasetId: null,
      })),
    },
  });
}

/** The report fields the diff reads. */
export function report(job: Job, datasets: readonly DatasetEnvelope[], question = "How healthy is Brand Alpha?") {
  return { job, question, exhibits: datasets.map((d) => ({ datasetId: d.id })) };
}
