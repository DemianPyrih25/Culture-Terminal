// In-memory implementations of the SkillCtx interfaces, with invented entities only (D29). The fake
// ledger validates every write with the contract schemas, so a skill cannot pass a test while
// producing a metric, dataset or finding the real ledger would reject.
import {
  DatasetEnvelope,
  DEFAULT_RUN_LIMITS,
  Evidence,
  Finding,
  makeId,
  Metric,
  type CacheProbe,
  type DatasetInput,
  type EntityRegistry,
  type EventInput,
  type EvidenceInput,
  type FindingInput,
  type GeoApi,
  type InsightsFilterType,
  type InsightsResponse,
  type Ledger,
  type MetricInput,
  type QlooApi,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type QlooPath,
  type QlooResult,
  type QlooSearchEntity,
  type RegisteredEntity,
  type RegisteredTag,
  type RunBudget,
  type SkillCtx,
} from "@ct/contracts";

export const FETCHED_AT = "2026-10-22T00:00:00.000Z";

/** What the Qloo client's budget gates throw. */
export class BudgetError extends Error {
  override name = "BudgetError";
}

export interface RecordedCall {
  method: "search" | "insights";
  filterType: string | null;
  params: QlooParams;
}

export interface FakeQlooOptions {
  search?: (params: QlooParams) => QlooSearchEntity[];
  insights?: (params: QlooParams) => QlooEntity[];
  /** Calls allowed before every further call throws BudgetError (counted in invocation order). */
  budget?: number;
}

export function fakeQloo(options: FakeQlooOptions = {}): { api: QlooApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let attempts = 0;
  const meta = (): QlooCallMeta => ({
    qlooCallId: `qc-${calls.length}`,
    requestId: `req-synthetic-${calls.length}`,
    cache: "miss",
    fetchedAt: FETCHED_AT,
    ms: 5,
    stale: false,
    originRunId: null,
  });
  const gate = () => {
    attempts += 1;
    if (options.budget !== undefined && attempts > options.budget) throw new BudgetError("run cap reached");
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    search: async (params) => {
      gate();
      calls.push({ method: "search", filterType: null, params });
      return { data: { results: options.search?.(params) ?? [] }, meta: meta() };
    },
    insights: async <F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>> => {
      gate();
      calls.push({ method: "insights", filterType, params });
      const data = { results: { entities: options.insights?.(params) ?? [] } };
      return { data: data as unknown as InsightsResponse<F>, meta: meta() };
    },
    entities: unused,
    tags: unused,
    audiences: unused,
    trending: unused,
  };
  return { api, calls };
}

export class FakeLedger implements Ledger {
  readonly evidences: Evidence[] = [];
  readonly metrics: Metric[] = [];
  readonly datasets: DatasetEnvelope[] = [];
  readonly findings: Finding[] = [];

  addEvidence(input: EvidenceInput): Evidence {
    const path: QlooPath = input.skill === "resolve_entities" ? "/search" : "/v2/insights";
    const e = Evidence.parse({
      id: makeId("E", this.evidences.length + 1),
      skill: input.skill,
      purpose: input.purpose,
      status: input.status,
      qlooCallIds: input.calls.map((c) => c.qlooCallId),
      requestIds: input.calls.map((c) => c.requestId),
      cached: input.calls.every((c) => c.cache !== "miss"),
      fetchedAt: input.calls[0]?.fetchedAt ?? FETCHED_AT,
      provenance: { requests: input.calls.map(() => ({ method: "GET", path, query: {} })) },
      summary: input.summary,
      flags: [...input.flags],
    });
    this.evidences.push(e);
    return e;
  }

  addMetric(input: MetricInput): Metric {
    const m = Metric.parse({ id: makeId("M", this.metrics.length + 1), ...input });
    this.metrics.push(m);
    return m;
  }

  addDataset(input: DatasetInput): DatasetEnvelope {
    const d = DatasetEnvelope.parse({ id: makeId("D", this.datasets.length + 1), ...input });
    this.datasets.push(d);
    return d;
  }

  addFinding(input: FindingInput): Finding {
    const f = Finding.parse({ id: makeId("F", this.findings.length + 1), ...input });
    this.findings.push(f);
    return f;
  }

  evidence(id: string) {
    return this.evidences.find((e) => e.id === id);
  }
  metric(id: string) {
    return this.metrics.find((m) => m.id === id);
  }
  dataset(id: string) {
    return this.datasets.find((d) => d.id === id);
  }
  finding(id: string) {
    return this.findings.find((f) => f.id === id);
  }
}

export class FakeRegistry implements EntityRegistry {
  private readonly byRef = new Map<string, RegisteredEntity>();
  private readonly tagsByRef = new Map<string, RegisteredTag>();

  registerEntity(entity: Omit<RegisteredEntity, "ref">): RegisteredEntity {
    const known = this.byEntityId(entity.entityId);
    if (known !== null) return known;
    const registered = { ...entity, ref: makeId("R", this.byRef.size + 1) };
    this.byRef.set(registered.ref, registered);
    return registered;
  }
  registerTag(tag: Omit<RegisteredTag, "ref">): RegisteredTag {
    const known = this.byTagId(tag.tagId);
    if (known !== null) return known;
    const registered = { ...tag, ref: makeId("T", this.tagsByRef.size + 1) };
    this.tagsByRef.set(registered.ref, registered);
    return registered;
  }
  entity(ref: string): RegisteredEntity | null {
    return this.byRef.get(ref) ?? null;
  }
  tag(ref: string): RegisteredTag | null {
    return this.tagsByRef.get(ref) ?? null;
  }
  byEntityId(entityId: string): RegisteredEntity | null {
    return [...this.byRef.values()].find((e) => e.entityId === entityId) ?? null;
  }
  byTagId(tagId: string): RegisteredTag | null {
    return [...this.tagsByRef.values()].find((t) => t.tagId === tagId) ?? null;
  }
  entities(): readonly RegisteredEntity[] {
    return [...this.byRef.values()];
  }
  tags(): readonly RegisteredTag[] {
    return [...this.tagsByRef.values()];
  }
}

const noGeo = (): never => {
  throw new Error("geo is not used by this skill");
};
const geo: GeoApi = {
  metros: noGeo,
  neighbourhoods: noGeo,
  neighbourhood: noGeo,
  matchNeighbourhood: noGeo,
  polygonWkt: noGeo,
  locate: noGeo,
  geohashCentroid: noGeo,
  boundarySource: noGeo,
};

const budget: RunBudget = {
  limits: DEFAULT_RUN_LIMITS,
  qlooNetworkUsed: () => 0,
  qlooNetworkRemaining: () => DEFAULT_RUN_LIMITS.qlooCalls,
  canAfford: () => true,
  elapsedMs: () => 0,
  llmUsd: () => 0,
};

export interface FakeRun {
  ctx: SkillCtx;
  ledger: FakeLedger;
  registry: FakeRegistry;
  events: EventInput[];
}

export function fakeRun(qloo: QlooApi, registry = new FakeRegistry()): FakeRun {
  const ledger = new FakeLedger();
  const events: EventInput[] = [];
  const ctx: SkillCtx = {
    qloo,
    ledger,
    geo,
    localities: null,
    registry,
    emit: (e) => events.push(e),
    budget,
    signal: new AbortController().signal,
    runId: "run-synthetic-1",
    pillar: "investment",
    phase: "wave1",
    toolCallId: "toolu_synthetic_1",
  };
  return { ctx, ledger, registry, events };
}

/** A cache probe that reports the given requests as cached and records every question. */
export function fakeProbe(isCached: (path: QlooPath, params: QlooParams) => boolean): CacheProbe & {
  asked: { path: QlooPath; params: QlooParams }[];
} {
  const asked: { path: QlooPath; params: QlooParams }[] = [];
  return {
    asked,
    has: async (path, params) => {
      asked.push({ path, params });
      return isCached(path, params);
    },
  };
}

// Invented entities ------------------------------------------------------------------------------------

export const CAT_BEVERAGE = "urn:tag:genre:brand:beverage";
export const CAT_SNACK = "urn:tag:genre:brand:snack";

export interface Invented {
  id: string;
  name: string;
  category: string | null;
  popularity?: number;
}

function tagName(category: string): string {
  return category.split(":").pop() ?? category;
}

export function searchResult(e: Invented, type = "urn:entity:brand", disambiguation: string | null = null): QlooSearchEntity {
  return {
    entity_id: e.id,
    name: e.name,
    types: [type],
    popularity: e.popularity ?? 0.8,
    disambiguation,
    tags: e.category === null ? [] : [{ tag_id: e.category, name: tagName(e.category), type: "urn:tag:genre" }],
  };
}

export function insightEntity(e: Invented, affinity: number | undefined): QlooEntity {
  return {
    entity_id: e.id,
    name: e.name,
    type: "urn:entity:brand",
    popularity: e.popularity ?? 0.8,
    tags: e.category === null ? [] : [{ id: e.category, name: tagName(e.category), type: "urn:tag:genre" }],
    ...(affinity === undefined ? {} : { query: { affinity } }),
  };
}

/** Registers an invented brand as if resolve_entities had found it. */
export function registerInvented(registry: FakeRegistry, e: Invented, type: RegisteredEntity["type"] = "brand"): RegisteredEntity {
  return registry.registerEntity({
    entityId: e.id,
    name: e.name,
    type,
    popularity: e.popularity ?? 0.8,
    disambiguation: null,
    tags: e.category === null ? [] : [{ tagId: e.category, name: tagName(e.category), type: "urn:tag:genre" }],
  });
}
