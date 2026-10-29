// The ledger repo against a real Postgres in a throwaway database. Skips when no database is
// reachable. Every entity, id and value is invented (D29).
import type { DatasetEnvelope, Evidence, Finding, Metric } from "@ct/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { datasetBytes, getDatasetEnvelope, insertLedgerSnapshot, type LedgerSnapshotInput, listLedgerRows } from "../src/repos/ledger";
import { createRun, getRun } from "../src/repos/runs";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

function evidenceRecord(n: number): Evidence {
  return {
    id: `E${n}`,
    skill: "peer_landscape",
    source: "qloo",
    purpose: "peer discovery for Brand Alpha",
    status: "ok",
    qlooCallIds: [`qc_alpha_${n}`],
    requestIds: [`synthetic-req-${n}`],
    cached: n % 2 === 0,
    fetchedAt: "2026-10-22T12:00:00.000Z",
    provenance: { requests: [{ method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand" } }] },
    summary: `bundle ${n}`,
    flags: n === 1 ? ["THIN_RESULT"] : [],
    qualityGateDrops: n === 1 ? 2 : 0,
  };
}

function metricRecord(n: number, evidenceId: `E${number}`): Metric {
  return {
    id: `M${n}`,
    key: "subs.similarity",
    label: `Similarity ${n}`,
    subjectRefs: ["R1", "R2"],
    value: n === 3 ? null : n / 10,
    reason: n === 3 ? "not_measured" : null,
    display: n === 3 ? "n/a" : `0.${n}`,
    unit: "affinity",
    badge: n === 3 ? "UNAVAILABLE" : "MEASURED",
    formulaId: "subs.similarity",
    evidenceIds: [evidenceId],
    n: n === 3 ? null : 12,
    conf: n === 3 ? null : 0.5,
    comparator: n === 2 ? "PEERS" : null,
    window: null,
  };
}

const scorecard: DatasetEnvelope = {
  id: "D1",
  kind: "Scorecard",
  title: "Hypothesis Scorecard",
  evidenceIds: ["E1"],
  formulaIds: [],
  payload: { rows: [] },
};

const finding: Finding = {
  id: "F1",
  kind: "TASTE_ISLAND",
  severity: "high",
  text: "Brand Alpha sits apart from its peers.",
  metricIds: ["M1"],
  suggestion: { tool: "audience_dna", reason: "check who the island audience is" },
};

describe.skipIf(!probe.ok)("ledger repo against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  async function newRun(id: string): Promise<string> {
    await createRun(db, { id, question: "Ledger test", questionHash: `h-${id}`, status: "running" });
    return id;
  }

  it("stores every table of a snapshot and reads it back in id order", async () => {
    const runId = await newRun("run-ledger-alpha");
    // Twelve bundles, so E10 to E12 must sort after E9.
    const snapshot: LedgerSnapshotInput = {
      evidence: Array.from({ length: 12 }, (_, i) => evidenceRecord(i + 1)),
      metrics: [metricRecord(1, "E1"), metricRecord(2, "E2"), metricRecord(3, "E3")],
      datasets: [scorecard],
      findings: [finding],
    };
    expect(await insertLedgerSnapshot(db, runId, snapshot)).toEqual({ evidence: 12, metrics: 3, datasets: 1, findings: 1 });

    const rows = await listLedgerRows(db, runId);
    expect(rows.evidence.map((e) => e.id)).toEqual(snapshot.evidence.map((e) => e.id));
    expect(rows.evidence[0]).toMatchObject({
      runId,
      skill: "peer_landscape",
      status: "ok",
      qlooCallIds: ["qc_alpha_1"],
      requestIds: ["synthetic-req-1"],
      cached: false,
      provenance: snapshot.evidence[0]?.provenance,
      flags: ["THIN_RESULT"],
    });
    // created_at carries the bundle's fetch time, not the time the run ended.
    expect(rows.evidence[0]?.createdAt.toISOString()).toBe("2026-10-22T12:00:00.000Z");
    expect(rows.metrics.map((m) => [m.id, m.value, m.badge])).toEqual([
      ["M1", 0.1, "MEASURED"],
      ["M2", 0.2, "MEASURED"],
      ["M3", null, "UNAVAILABLE"],
    ]);
    expect(rows.metrics[0]).toMatchObject({ subjectRefs: ["R1", "R2"], evidenceIds: ["E1"], formulaId: "subs.similarity", n: 12 });
    expect(rows.metrics.map((m) => [m.reason, m.comparator, m.window])).toEqual([
      [null, null, null],
      [null, "PEERS", null],
      ["not_measured", null, null],
    ]);
    expect(rows.evidence.map((e) => e.qualityGateDrops).slice(0, 2)).toEqual([2, 0]);
    expect(rows.datasets).toHaveLength(1);
    expect(rows.datasets[0]).toMatchObject({ id: "D1", kind: "Scorecard", payload: scorecard, bytes: datasetBytes(scorecard) });
    expect(rows.datasets[0]?.bytes).toBe(new TextEncoder().encode(JSON.stringify(scorecard)).length);
    expect(rows.findings[0]).toMatchObject({ id: "F1", kind: "TASTE_ISLAND", severity: "high", metricIds: ["M1"], suggestion: finding.suggestion });
  });

  it("stores an SEC bundle's source and a metric's period", async () => {
    const runId = await newRun("run-ledger-public");
    const sec: Evidence = {
      ...evidenceRecord(1),
      skill: "company_financials",
      source: "sec",
      qlooCallIds: ["pc_alpha_1"],
      requestIds: ["CIK0000000001"],
      provenance: {
        requests: [
          { source: "sec", method: "GET", host: "data.sec.gov", path: "/api/xbrl/companyfacts/CIK0000000001.json", query: {}, reference: "CIK0000000001" },
        ],
      },
    };
    const revenue: Metric = { ...metricRecord(1, "E1"), key: "fin.revenue", unit: "usd", value: 1_000_000, display: "$1.0M", period: "FY2024, 10-K filed 2025-01-15" };
    await insertLedgerSnapshot(db, runId, { evidence: [sec], metrics: [revenue, metricRecord(2, "E1")], datasets: [], findings: [] });
    const rows = await listLedgerRows(db, runId);
    expect(rows.evidence[0]).toMatchObject({ source: "sec", provenance: sec.provenance });
    expect(rows.metrics.map((m) => m.period)).toEqual(["FY2024, 10-K filed 2025-01-15", null]);
  });

  it("reads one stored dataset envelope back, and null for an unknown id or run", async () => {
    const runId = await newRun("run-ledger-dataset");
    await insertLedgerSnapshot(db, runId, { evidence: [], metrics: [], datasets: [scorecard], findings: [] });
    expect(await getDatasetEnvelope(db, runId, "D1")).toEqual(scorecard);
    expect(await getDatasetEnvelope(db, runId, "D2")).toBeNull();
    expect(await getDatasetEnvelope(db, "run-ledger-elsewhere", "D1")).toBeNull();
  });

  it("skips records already stored, so a retried write neither fails nor duplicates", async () => {
    const runId = await newRun("run-ledger-retry");
    const first: LedgerSnapshotInput = { evidence: [evidenceRecord(1)], metrics: [metricRecord(1, "E1")], datasets: [], findings: [] };
    await insertLedgerSnapshot(db, runId, first);
    const again: LedgerSnapshotInput = { ...first, evidence: [evidenceRecord(1), evidenceRecord(2)] };
    expect(await insertLedgerSnapshot(db, runId, again)).toEqual({ evidence: 1, metrics: 0, datasets: 0, findings: 0 });
    expect((await listLedgerRows(db, runId)).evidence.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("writes all tables or none", async () => {
    const runId = await newRun("run-ledger-atomic");
    const broken = { ...finding, kind: null } as unknown as Finding;
    const snapshot: LedgerSnapshotInput = { evidence: [evidenceRecord(1)], metrics: [metricRecord(1, "E1")], datasets: [scorecard], findings: [broken] };
    await expect(insertLedgerSnapshot(db, runId, snapshot)).rejects.toThrow();
    expect(await listLedgerRows(db, runId)).toEqual({ evidence: [], metrics: [], datasets: [], findings: [] });
  });

  it("accepts an empty snapshot and keeps runs apart", async () => {
    const runId = await newRun("run-ledger-empty");
    expect(await insertLedgerSnapshot(db, runId, { evidence: [], metrics: [], datasets: [], findings: [] })).toEqual({
      evidence: 0,
      metrics: 0,
      datasets: 0,
      findings: 0,
    });
    expect((await listLedgerRows(db, runId)).evidence).toEqual([]);
    expect((await listLedgerRows(db, "run-ledger-alpha")).evidence).toHaveLength(12);
  });

  it("goes with its run when the run is deleted", async () => {
    const runId = await newRun("run-ledger-cascade");
    await insertLedgerSnapshot(db, runId, { evidence: [evidenceRecord(1)], metrics: [], datasets: [scorecard], findings: [] });
    await db.$client`delete from runs where id = ${runId}`;
    expect(await getRun(db, runId)).toBeUndefined();
    expect(await listLedgerRows(db, runId)).toEqual({ evidence: [], metrics: [], datasets: [], findings: [] });
  });
});
