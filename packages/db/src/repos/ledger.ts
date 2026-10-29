import type { DatasetEnvelope, Evidence, Finding, Metric } from "@ct/contracts";
import { and, eq } from "drizzle-orm";
import type { Queryable } from "../client";
import {
  type DatasetRow,
  datasets,
  type EvidenceRow,
  evidence,
  type FindingRow,
  findings,
  type MetricRow,
  metrics,
} from "../schema";

/**
 * A run's ledger in the evidence, metrics, datasets and findings tables (PLAN §6, SPEC §3.2). The
 * run manager writes the agent's end-of-run snapshot here; the live trace already streamed each
 * record as an event.
 */

/** The agent's LedgerSnapshot: every E#, M#, D# and F# of one run. */
export interface LedgerSnapshotInput {
  evidence: readonly Evidence[];
  metrics: readonly Metric[];
  datasets: readonly DatasetEnvelope[];
  findings: readonly Finding[];
}

export interface LedgerRows {
  evidence: EvidenceRow[];
  metrics: MetricRow[];
  datasets: DatasetRow[];
  findings: FindingRow[];
}

/** Rows inserted per table; a record already stored for the run is skipped, not counted. */
export interface LedgerInsertCounts {
  evidence: number;
  metrics: number;
  datasets: number;
  findings: number;
}

// Postgres caps a statement at 65,535 bind parameters; the widest row here binds 15.
const INSERT_CHUNK = 500;

/** JSON bytes of a dataset, measured the way the ledger measures it for dataset.ready. */
export function datasetBytes(dataset: DatasetEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(dataset)).length;
}

async function insertChunked<T>(rows: readonly T[], insert: (chunk: T[]) => Promise<unknown[]>): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) inserted += (await insert(rows.slice(i, i + INSERT_CHUNK))).length;
  return inserted;
}

/**
 * Stores a run's ledger in one transaction: all four tables or none. A record whose (run_id, id)
 * already exists is skipped, so a retried write never fails or duplicates. A dataset row keeps the
 * whole envelope (title, evidence and formula ids, payload) with its JSON size in bytes. An evidence
 * row's created_at is the bundle's fetchedAt.
 */
export async function insertLedgerSnapshot(
  db: Queryable,
  runId: string,
  snapshot: LedgerSnapshotInput,
): Promise<LedgerInsertCounts> {
  return db.transaction(async (tx) => ({
    evidence: await insertChunked(snapshot.evidence, (chunk) =>
      tx
        .insert(evidence)
        .values(
          chunk.map((e) => ({
            runId,
            id: e.id,
            // When the bundle's data was fetched (the exhibit's "fetched" line), not when the run ended.
            createdAt: new Date(e.fetchedAt),
            skill: e.skill,
            source: e.source,
            purpose: e.purpose,
            status: e.status,
            qlooCallIds: [...e.qlooCallIds],
            cached: e.cached,
            requestIds: [...e.requestIds],
            provenance: e.provenance,
            summary: e.summary,
            flags: [...e.flags],
            qualityGateDrops: e.qualityGateDrops,
          })),
        )
        .onConflictDoNothing({ target: [evidence.runId, evidence.id] })
        .returning({ id: evidence.id }),
    ),
    metrics: await insertChunked(snapshot.metrics, (chunk) =>
      tx
        .insert(metrics)
        .values(
          chunk.map((m) => ({
            runId,
            id: m.id,
            key: m.key,
            label: m.label,
            subjectRefs: [...m.subjectRefs],
            value: m.value,
            display: m.display,
            unit: m.unit,
            badge: m.badge,
            formulaId: m.formulaId,
            evidenceIds: [...m.evidenceIds],
            n: m.n,
            conf: m.conf,
            reason: m.reason,
            comparator: m.comparator,
            window: m.window,
            period: m.period ?? null,
          })),
        )
        .onConflictDoNothing({ target: [metrics.runId, metrics.id] })
        .returning({ id: metrics.id }),
    ),
    datasets: await insertChunked(snapshot.datasets, (chunk) =>
      tx
        .insert(datasets)
        .values(chunk.map((d) => ({ runId, id: d.id, kind: d.kind, payload: d, bytes: datasetBytes(d) })))
        .onConflictDoNothing({ target: [datasets.runId, datasets.id] })
        .returning({ id: datasets.id }),
    ),
    findings: await insertChunked(snapshot.findings, (chunk) =>
      tx
        .insert(findings)
        .values(
          chunk.map((f) => ({
            runId,
            id: f.id,
            kind: f.kind,
            severity: f.severity,
            text: f.text,
            metricIds: [...f.metricIds],
            suggestion: f.suggestion,
          })),
        )
        .onConflictDoNothing({ target: [findings.runId, findings.id] })
        .returning({ id: findings.id }),
    ),
  }));
}

// Ids are a letter and a counter, so E10 sorts after E9.
const byIdNumber = (a: { id: string }, b: { id: string }) => Number(a.id.slice(1)) - Number(b.id.slice(1));

/** A run's stored ledger rows, each table in id order (E1, E2, … E10). */
/** One stored dataset envelope (D#) of a run, for figures too large to stream inline; null when absent. */
export async function getDatasetEnvelope(db: Queryable, runId: string, datasetId: string): Promise<DatasetEnvelope | null> {
  const rows = await db
    .select({ payload: datasets.payload })
    .from(datasets)
    .where(and(eq(datasets.runId, runId), eq(datasets.id, datasetId)))
    .limit(1);
  return (rows[0]?.payload as DatasetEnvelope | undefined) ?? null;
}

export async function listLedgerRows(db: Queryable, runId: string): Promise<LedgerRows> {
  const [e, m, d, f] = await Promise.all([
    db.select().from(evidence).where(eq(evidence.runId, runId)),
    db.select().from(metrics).where(eq(metrics.runId, runId)),
    db.select().from(datasets).where(eq(datasets.runId, runId)),
    db.select().from(findings).where(eq(findings.runId, runId)),
  ]);
  return { evidence: e.sort(byIdNumber), metrics: m.sort(byIdNumber), datasets: d.sort(byIdNumber), findings: f.sort(byIdNumber) };
}
