import {
  DatasetEnvelope,
  Evidence,
  Finding,
  Flag,
  makeId,
  Metric,
  ProvenanceRequest,
  QlooCallMeta,
  type DatasetId,
  type DatasetInput,
  type Emit,
  type EvidenceId,
  type EvidenceInput,
  type FindingId,
  type FindingInput,
  type IdPrefix,
  type Ledger,
  type MetricId,
  type MetricInput,
} from "@ct/contracts";
import { isFormulaId } from "@ct/quant";
import { z } from "zod";

/**
 * The run ledger (PLAN §6, SPEC §6.1). Every E#, M#, D# and F# of a run is created here, so a skill
 * cannot produce a number that the trace, the database and the CHECKER do not see. A record is
 * stored only after it validates and `onRecord` (persistence) returns, so a refused or unsaved input
 * never burns an id and never reaches the snapshot without its event.
 */

/** Datasets up to this many JSON bytes ride inline on `dataset.ready`; larger ones are fetched on demand. */
export const DATASET_INLINE_MAX_BYTES = 64 * 1024;

/** The ledger's plain-array state: what the run manager persists and the CHECKER and assembler read. */
export interface LedgerSnapshot {
  evidence: Evidence[];
  metrics: Metric[];
  datasets: DatasetEnvelope[];
  findings: Finding[];
}

export interface LedgerRecordMap {
  evidence: Evidence;
  metric: Metric;
  dataset: DatasetEnvelope;
  finding: Finding;
}
export type LedgerRecordKind = keyof LedgerRecordMap;

/** `(kind, record)` pairs, so a callback narrows `record` by checking `kind`. */
export type LedgerRecordArgs = { [K in LedgerRecordKind]: [kind: K, record: LedgerRecordMap[K]] }[LedgerRecordKind];

/** Read access by id, shared by the live ledger and an indexed snapshot. */
export type LedgerLookup = Pick<Ledger, "evidence" | "metric" | "dataset" | "finding">;

export interface RunLedgerOptions {
  emit: Emit;
  /** The provenance request of a Qloo call this run made; null when unknown, which refuses the bundle. */
  provenanceOf: (qlooCallId: string) => ProvenanceRequest | null;
  /**
   * The tool call that findings added through the run ledger itself belong to (default: none).
   * Skills that run in parallel each get `forToolCall(ctx.toolCallId)` instead, so their findings
   * keep their own tool call however the calls interleave.
   */
  toolCallId?: () => string | null;
  /**
   * Called with each new record before it is stored and its event emitted, e.g. to persist it. If it
   * throws, the add throws and leaves no trace: no record, no event, no id used.
   */
  onRecord?: (...args: LedgerRecordArgs) => void;
  inlineMaxBytes?: number;
}

export interface RunLedger extends Ledger {
  snapshot(): LedgerSnapshot;
  /** The same ledger, with `finding` events stamped with this tool call (SkillCtx.ledger of one skill run). */
  forToolCall(toolCallId: string | null): Ledger;
}

/** A refused ledger input: a bug in the calling skill, never a data condition. */
export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

export function createRunLedger(options: RunLedgerOptions): RunLedger {
  const { emit, provenanceOf, onRecord } = options;
  const inlineMaxBytes = options.inlineMaxBytes ?? DATASET_INLINE_MAX_BYTES;
  const evidence = new Map<EvidenceId, Evidence>();
  const metrics = new Map<MetricId, Metric>();
  const datasets = new Map<DatasetId, DatasetEnvelope>();
  const findings = new Map<FindingId, Finding>();

  const nextId = <P extends IdPrefix>(prefix: P, store: ReadonlyMap<unknown, unknown>) =>
    makeId(prefix, store.size + 1);

  const requireEvidence = (ids: readonly string[], what: string): void => {
    const missing = ids.filter((id) => !evidence.has(id as EvidenceId));
    if (missing.length > 0) throw new LedgerError(`${what} cites unknown evidence ${missing.join(", ")}`);
  };

  const requireFormulas = (ids: readonly string[], what: string): void => {
    const unknown = ids.filter((id) => !isFormulaId(id));
    if (unknown.length > 0) throw new LedgerError(`${what} uses formula ids outside FORMULAS: ${unknown.join(", ")}`);
  };

  /** Persists, then stores: a throwing onRecord leaves the store, and so the next id, unchanged. */
  const commit = <K extends LedgerRecordKind>(
    kind: K,
    store: Map<LedgerRecordMap[K]["id"], LedgerRecordMap[K]>,
    record: LedgerRecordMap[K],
  ): void => {
    onRecord?.(...([kind, record] as LedgerRecordArgs));
    store.set(record.id, record);
  };

  const view = (toolCallId: () => string | null): Ledger => ({
    addEvidence(input: EvidenceInput): Evidence {
      const id = nextId("E", evidence);
      const calls = validate(z.array(QlooCallMeta).min(1), input.calls, `${id} calls`);
      const callIds = calls.map((c) => c.qlooCallId);
      if (new Set(callIds).size !== callIds.length) throw new LedgerError(`${id} lists a Qloo call twice`);
      const requests = calls.map((c) => {
        const request = provenanceOf(c.qlooCallId);
        if (request === null) throw new LedgerError(`${id}: no provenance for Qloo call ${c.qlooCallId}`);
        return validate(ProvenanceRequest, request, `${id} provenance of ${c.qlooCallId}`);
      });
      // A stale-on-error response is a data-quality fact of the bundle, whatever the skill reported.
      const flags = new Set<Flag>(validate(z.array(Flag), input.flags, `${id} flags`));
      if (calls.some((c) => c.stale)) flags.add("STALE_CACHE");
      const record = validate(
        Evidence,
        {
          id,
          skill: input.skill,
          purpose: input.purpose,
          status: input.status,
          qlooCallIds: callIds,
          requestIds: calls.map((c) => c.requestId),
          cached: calls.every((c) => c.cache !== "miss"),
          fetchedAt: earliest(calls.map((c) => c.fetchedAt)),
          provenance: { requests },
          summary: input.summary,
          flags: [...flags],
          qualityGateDrops: input.qualityGateDrops ?? 0,
        },
        id,
      );
      commit("evidence", evidence, record);
      emit({ type: "evidence", evidence: record });
      return record;
    },

    addMetric(input: MetricInput): Metric {
      const id = nextId("M", metrics);
      requireFormulas([input.formulaId], id);
      const record = validate(Metric, { ...input, id }, id);
      requireEvidence(record.evidenceIds, id);
      // M# → E# → request id: a number without evidence could not be traced (numbers traced, §7).
      if (record.value !== null && record.evidenceIds.length === 0) {
        throw new LedgerError(`${id} has a value but cites no evidence`);
      }
      commit("metric", metrics, record);
      emit({ type: "metric", metric: record });
      return record;
    },

    addDataset(input: DatasetInput): DatasetEnvelope {
      const id = nextId("D", datasets);
      const record = validate(DatasetEnvelope, { ...input, id }, id);
      requireEvidence(record.evidenceIds, id);
      requireFormulas(record.formulaIds, id);
      commit("dataset", datasets, record);
      const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
      emit({
        type: "dataset.ready",
        datasetId: id,
        kind: record.kind,
        title: record.title,
        bytes,
        inline: bytes <= inlineMaxBytes ? record : null,
      });
      return record;
    },

    addFinding(input: FindingInput): Finding {
      const id = nextId("F", findings);
      const record = validate(Finding, { ...input, id }, id);
      const missing = record.metricIds.filter((m) => !metrics.has(m));
      if (missing.length > 0) throw new LedgerError(`${id} cites unknown metrics ${missing.join(", ")}`);
      commit("finding", findings, record);
      emit({ type: "finding", finding: record, toolCallId: toolCallId() });
      return record;
    },

    evidence: (id) => evidence.get(id),
    metric: (id) => metrics.get(id),
    dataset: (id) => datasets.get(id),
    finding: (id) => findings.get(id),
  });

  return {
    ...view(options.toolCallId ?? (() => null)),
    forToolCall: (toolCallId) => view(() => toolCallId),
    snapshot: () => ({
      evidence: [...evidence.values()],
      metrics: [...metrics.values()],
      datasets: [...datasets.values()],
      findings: [...findings.values()],
    }),
  };
}

/** Id lookups over a snapshot, e.g. one loaded from the database for a replay or a re-check. */
export function indexSnapshot(snapshot: LedgerSnapshot): LedgerLookup {
  const evidence = new Map(snapshot.evidence.map((e) => [e.id, e]));
  const metrics = new Map(snapshot.metrics.map((m) => [m.id, m]));
  const datasets = new Map(snapshot.datasets.map((d) => [d.id, d]));
  const findings = new Map(snapshot.findings.map((f) => [f.id, f]));
  return {
    evidence: (id) => evidence.get(id),
    metric: (id) => metrics.get(id),
    dataset: (id) => datasets.get(id),
    finding: (id) => findings.get(id),
  };
}

function validate<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new LedgerError(`${what} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** The earliest of ISO timestamps that may carry different offsets; the original string is kept. */
function earliest(timestamps: readonly string[]): string {
  return timestamps.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
