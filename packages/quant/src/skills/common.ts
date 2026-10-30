import type {
  Badge,
  CacheProbe,
  Comparator,
  ConceptMatch,
  EntityRegistry,
  Evidence,
  EvidenceId,
  EvidenceInput,
  Ledger,
  Metric,
  MetricUnit,
  NoValueReason,
  QlooEntity,
  QlooParams,
  QlooPath,
  QlooSearchEntity,
  RegisteredEntity,
} from "@ct/contracts";
import { weakerConceptMatch } from "@ct/contracts";
import { metricConfidence } from "../badges";
import type { FormulaId } from "../formulas";

/** Plumbing every skill shares: budget-aware calls, cache-aware estimates, ledger and registry writes. */

// Qloo calls -------------------------------------------------------------------------------------------

/** The Qloo client's budget gates throw an error named "BudgetError" (§5.1 step 5); skills turn it into BUDGET_TRUNCATED. */
export function isBudgetError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "BudgetError";
}

/** The code a Qloo client error carries ("qloo_unavailable", "qloo_bad_response", …), or null for any other error. */
export function qlooErrorCodeOf(err: unknown): string | null {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^qloo_[a-z_]+$/.test(code) ? code : null;
}

export type Attempt<T> =
  | { kind: "ok"; value: T }
  | { kind: "truncated" }
  | { kind: "skipped" }
  | { kind: "failed"; code: string; error: unknown };

function settle<T>(calls: readonly ((() => Promise<T>) | null)[]): Promise<PromiseSettledResult<Attempt<T>>[]> {
  return Promise.allSettled(
    calls.map(async (call): Promise<Attempt<T>> => (call === null ? { kind: "skipped" } : { kind: "ok", value: await call() })),
  );
}

/**
 * Runs calls concurrently (the client applies the per-run limiter). A budget failure marks that call
 * truncated so the skill can still return what it has; cached calls never hit the budget gate, so
 * the others are still attempted. Any other failure propagates. A null entry is a call not made.
 */
export async function attemptAll<T>(calls: readonly ((() => Promise<T>) | null)[]): Promise<Attempt<T>[]> {
  return (await settle(calls)).map((s) => {
    if (s.status === "fulfilled") return s.value;
    if (isBudgetError(s.reason)) return { kind: "truncated" };
    throw s.reason;
  });
}

/**
 * attemptAll for a skill that has already written evidence: a call the Qloo client failed after its
 * own retries (an error with a qloo_* code) is marked failed instead of failing the whole skill, so
 * the skill can still return that evidence with the gap explained. Once `signal` has fired, and for
 * any error that is not the Qloo client's, the failure still propagates.
 */
export async function attemptAllKeepingFailures<T>(
  calls: readonly ((() => Promise<T>) | null)[],
  signal: AbortSignal,
): Promise<Attempt<T>[]> {
  return (await settle(calls)).map((s) => {
    if (s.status === "fulfilled") return s.value;
    if (isBudgetError(s.reason)) return { kind: "truncated" };
    const code = signal.aborted ? null : qlooErrorCodeOf(s.reason);
    if (code === null) throw s.reason;
    return { kind: "failed", code, error: s.reason };
  });
}

function paramsKey(params: QlooParams): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => {
        const v = params[k];
        return [k, typeof v === "object" ? [...v].sort() : v];
      }),
  );
}

/**
 * Network calls a set of requests would cost now: identical requests count once and cached ones are
 * free. Null entries are requests the skill would not make.
 */
export async function countUncached(
  probe: CacheProbe,
  path: QlooPath,
  requests: readonly (QlooParams | null)[],
): Promise<number> {
  const unique = new Map<string, QlooParams>();
  for (const p of requests) if (p !== null) unique.set(paramsKey(p), p);
  const cached = await Promise.all([...unique.values()].map((p) => probe.has(path, p)));
  return cached.filter((hit) => !hit).length;
}

// Ledger -------------------------------------------------------------------------------------------------

/** A bundle needs at least one call; a phase that made none (all truncated or skipped) records nothing. */
export function addSkillEvidence(ledger: Ledger, input: EvidenceInput): Evidence | null {
  return input.calls.length === 0 ? null : ledger.addEvidence(input);
}

export interface MetricSpec {
  key: string;
  label: string;
  subjectRefs: readonly string[];
  /** Null records an explained absence: the metric is badged UNAVAILABLE with `reason`, never shown as 0. */
  value: number | null;
  reason: NoValueReason;
  /** Display for a present value; an absent one always reads "not measured". */
  display: string;
  unit: MetricUnit;
  /** STALE is not offered: these skills read no trending data, and STALE needs a window. */
  badge: Extract<Badge, "MEASURED" | "DERIVED" | "ESTIMATED">;
  formulaId: FormulaId;
  evidenceIds: readonly EvidenceId[];
  n: number | null;
  comparator: Comparator | null;
  /** The period or vintage of an SEC or Census figure, as {{PERIOD:M#}} renders it (V11). */
  period?: string | null;
  /** R1: the value rests on a thin sample (THIN_SAMPLE). Written only when true. */
  thin?: boolean;
  /** R2: the weakest concept match among the concept tags the call used (conceptReadOf). */
  conceptRead?: ConceptMatch;
  /** V13: a difference inside the about-level band (ABOUT_LEVEL). Written only when true. */
  aboutLevel?: boolean;
}

/** Adds a metric with the UNAVAILABLE invariants and per-metric confidence filled in (§6.4). */
export function addSkillMetric(ledger: Ledger, spec: MetricSpec): Metric {
  const present = spec.value !== null;
  const badge: Badge = present ? spec.badge : "UNAVAILABLE";
  return ledger.addMetric({
    key: spec.key,
    label: spec.label,
    subjectRefs: [...spec.subjectRefs],
    value: spec.value,
    reason: present ? null : spec.reason,
    display: present ? spec.display : "not measured",
    unit: spec.unit,
    badge,
    formulaId: spec.formulaId,
    evidenceIds: [...spec.evidenceIds],
    n: spec.n,
    conf: metricConfidence(badge, spec.n),
    comparator: spec.comparator,
    window: null,
    ...(spec.period === undefined ? {} : { period: spec.period }),
    ...(spec.thin === true && present ? { thin: true } : {}),
    ...(spec.conceptRead === undefined ? {} : { conceptRead: spec.conceptRead }),
    ...(spec.aboutLevel === true && present ? { level: "about_level" as const } : {}),
  });
}

/**
 * The weakest concept match among the tags a call sent (R2, D48): `proxy` < `category` < `exact`, read from
 * the registry by tag id or tag ref; undefined when none of them is a concept tag. Every skill that sends
 * concept tags puts this on its metrics, so the CHECKER (V12) and confidence (category_level) see what the
 * value really measures.
 */
export function conceptReadOf(tags: readonly string[], registry: EntityRegistry): ConceptMatch | undefined {
  let read: ConceptMatch | undefined;
  for (const t of tags) {
    const tag = registry.byTagId(t) ?? registry.tags().find((x) => x.ref === t) ?? null;
    read = weakerConceptMatch(read, tag?.conceptMatch);
  }
  return read;
}

// Registry ---------------------------------------------------------------------------------------------

export type EntityDraft = Omit<RegisteredEntity, "ref">;
export type EntityTagRef = RegisteredEntity["tags"][number];

export interface Registration {
  entity: RegisteredEntity;
  /** False when the registry already knew the entity, so the digest does not list it as new. */
  isNew: boolean;
}

export function registerEntity(registry: EntityRegistry, draft: EntityDraft): Registration {
  const known = registry.byEntityId(draft.entityId);
  return known === null ? { entity: registry.registerEntity(draft), isNew: true } : { entity: known, isNew: false };
}

/** /search tags arrive as {tag_id, name, type}. */
export function searchTags(tags: QlooSearchEntity["tags"]): EntityTagRef[] {
  return (tags ?? []).map((t) => ({ tagId: t.tag_id, name: t.name, type: t.type }));
}

/** Insights tags arrive as {id, name, type}, some with only a type (G15): those are skipped. */
export function insightTags(tags: QlooEntity["tags"]): EntityTagRef[] {
  return (tags ?? []).flatMap((t) =>
    t.id !== undefined && t.name !== undefined ? [{ tagId: t.id, name: t.name, type: t.type ?? "" }] : [],
  );
}

/**
 * R3 (D49): marks every dataset row that names a registered entity (an `R#` ref) with where the entity came
 * from (`source`: user_named or obvious; absent = found by the data), so every exhibit shows the "You named"
 * and "Expected" chips without each skill copying the registry. Rows that already carry a source keep it;
 * objects whose schema has no `source` field drop it on validation. Returns a new value.
 */
export function stampCandidateSources<T>(value: T, registry: Pick<EntityRegistry, "entity">): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    const ref = out.ref;
    if (typeof ref === "string" && /^R\d+$/.test(ref) && out.source === undefined) {
      const candidate = registry.entity(ref as `R${number}`)?.candidate;
      if (candidate === "user_named" || candidate === "obvious") out.source = candidate;
    }
    return out;
  };
  return walk(value) as T;
}
