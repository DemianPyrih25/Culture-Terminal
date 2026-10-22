import { Evidence, RunEventInput, type MetricInput } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { createRunLedger, indexSnapshot, LedgerError } from "../../src/ledger";
import { brandHealthLedger, call, emptyLedger, provenanceOf, WINDOW } from "./fixtures";

const evidenceInput = (calls = [call("qc-01")]) => ({
  skill: "peer_landscape" as const,
  purpose: "Substitution matrix",
  calls,
  status: "ok" as const,
  summary: "Two brands.",
  flags: [],
});

const metricInput = (overrides: Partial<MetricInput> = {}): MetricInput => ({
  key: "subs.similarity",
  label: "Similarity",
  subjectRefs: ["R1"],
  value: 0.5,
  reason: null,
  display: "0.5",
  unit: "similarity",
  badge: "MEASURED",
  formulaId: "subs.similarity",
  evidenceIds: ["E1"],
  n: 4,
  conf: null,
  comparator: null,
  window: null,
  ...overrides,
});

describe("createRunLedger", () => {
  it("assigns ids in order per kind and emits one valid event per record", () => {
    const { ledger, events } = brandHealthLedger();
    const snap = ledger.snapshot();
    expect(snap.evidence.map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect(snap.metrics.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"]);
    expect(snap.datasets.map((d) => d.id)).toEqual(["D1", "D2", "D3"]);
    expect(snap.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(events.map((e) => e.type)).toEqual([
      ...Array(5).fill("evidence"),
      ...Array(10).fill("metric"),
      ...Array(3).fill("dataset.ready"),
      "finding",
    ]);
    for (const e of events) expect(RunEventInput.safeParse(e).success).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "finding", toolCallId: "tc-fixture", finding: { id: "F1" } });
  });

  it("derives call ids, request ids, caching, fetch time and provenance as parallel arrays", () => {
    const { ledger } = emptyLedger();
    const e = ledger.addEvidence(
      evidenceInput([
        call("qc-01", { fetchedAt: "2026-10-20T12:00:00+02:00", cache: "hit" }),
        call("qc-07", { fetchedAt: "2026-10-20T10:30:00.000Z", cache: "reused" }),
      ]),
    );
    expect(e.qlooCallIds).toEqual(["qc-01", "qc-07"]);
    expect(e.requestIds).toEqual(["rq01-fixture", "rq07-fixture"]);
    expect(e.provenance.requests).toEqual([provenanceOf("qc-01"), provenanceOf("qc-07")]);
    // 12:00+02:00 is 10:00Z, earlier than 10:30Z; the original string is kept.
    expect(e.fetchedAt).toBe("2026-10-20T12:00:00+02:00");
    expect(e.cached).toBe(true);
    expect(Evidence.safeParse(e).success).toBe(true);

    const fresh = ledger.addEvidence(evidenceInput([call("qc-02"), call("qc-03", { cache: "miss" })]));
    expect(fresh.cached).toBe(false);
  });

  it("adds STALE_CACHE when a call was served stale, without duplicating it", () => {
    const { ledger } = emptyLedger();
    const e = ledger.addEvidence({ ...evidenceInput([call("qc-01", { cache: "stale", stale: true })]), flags: ["STALE_CACHE", "THIN_RESULT"] });
    expect(e.flags).toEqual(["STALE_CACHE", "THIN_RESULT"]);
    const f = ledger.addEvidence(evidenceInput([call("qc-02", { cache: "stale", stale: true })]));
    expect(f.flags).toEqual(["STALE_CACHE"]);
  });

  it("refuses a bundle with a call it has no provenance for, without burning an id", () => {
    const { ledger, events } = emptyLedger();
    expect(() => ledger.addEvidence(evidenceInput([call("qc-01"), call("qc-unknown")]))).toThrow(LedgerError);
    expect(() => ledger.addEvidence(evidenceInput([]))).toThrow(/calls is invalid/);
    expect(() => ledger.addEvidence(evidenceInput([call("qc-01"), call("qc-01")]))).toThrow(/twice/);
    expect(events).toHaveLength(0);
    expect(ledger.addEvidence(evidenceInput()).id).toBe("E1");
  });

  it("refuses metrics outside FORMULAS, without evidence, or breaking the badge rules", () => {
    const { ledger } = emptyLedger();
    ledger.addEvidence(evidenceInput());
    expect(() => ledger.addMetric(metricInput({ formulaId: "made.up" }))).toThrow(/outside FORMULAS/);
    expect(() => ledger.addMetric(metricInput({ evidenceIds: ["E9"] }))).toThrow(/unknown evidence E9/);
    expect(() => ledger.addMetric(metricInput({ evidenceIds: [] }))).toThrow(/cites no evidence/);
    expect(() => ledger.addMetric(metricInput({ value: null }))).toThrow(LedgerError);
    expect(() => ledger.addMetric(metricInput({ badge: "STALE" }))).toThrow(/window/);
    expect(ledger.addMetric(metricInput({ badge: "STALE", window: WINDOW })).id).toBe("M1");
    const unavailable = ledger.addMetric(
      metricInput({ value: null, reason: "budget_truncated", badge: "UNAVAILABLE", display: "n/a", evidenceIds: [] }),
    );
    expect(unavailable.id).toBe("M2");
  });

  it("validates datasets, counts their bytes and inlines only small ones", () => {
    const events: unknown[] = [];
    const ledger = createRunLedger({ emit: (e) => events.push(e), provenanceOf, inlineMaxBytes: 200 });
    ledger.addEvidence(evidenceInput());
    const payload = { rows: [] };
    expect(() =>
      ledger.addDataset({ kind: "Scorecard", title: "S", evidenceIds: [], formulaIds: ["nope"], payload }),
    ).toThrow(/outside FORMULAS/);
    expect(() =>
      ledger.addDataset({ kind: "Scorecard", title: "S", evidenceIds: ["E2"], formulaIds: [], payload }),
    ).toThrow(/unknown evidence/);
    const small = ledger.addDataset({ kind: "Scorecard", title: "S", evidenceIds: ["E1"], formulaIds: [], payload });
    const big = ledger.addDataset({
      kind: "Scorecard",
      title: "A long title ".repeat(20),
      evidenceIds: ["E1"],
      formulaIds: [],
      payload,
    });
    const ready = events.filter((e) => (e as { type: string }).type === "dataset.ready") as {
      datasetId: string;
      bytes: number;
      inline: unknown;
    }[];
    expect(ready[0]).toMatchObject({ datasetId: small.id, inline: small });
    expect(ready[0]?.bytes).toBe(JSON.stringify(small).length);
    expect(ready[1]).toMatchObject({ datasetId: big.id, inline: null });
  });

  it("refuses findings that cite unknown metrics and stamps a null tool call when none is running", () => {
    const events: unknown[] = [];
    const ledger = createRunLedger({ emit: (e) => events.push(e), provenanceOf });
    const finding = { kind: "EMPTY_RESULT" as const, severity: "low" as const, text: "Nothing.", suggestion: null };
    expect(() => ledger.addFinding({ ...finding, metricIds: ["M1"] })).toThrow(/unknown metrics M1/);
    ledger.addFinding({ ...finding, metricIds: [] });
    expect(events[0]).toMatchObject({ type: "finding", toolCallId: null });
  });

  it("hands each record to onRecord before emitting its event", () => {
    const order: string[] = [];
    const ledger = createRunLedger({
      emit: (e) => order.push(`emit:${e.type}`),
      provenanceOf,
      onRecord: (kind, record) => order.push(`record:${kind}:${record.id}`),
    });
    ledger.addEvidence(evidenceInput());
    ledger.addMetric(metricInput());
    expect(order).toEqual(["record:evidence:E1", "emit:evidence", "record:metric:M1", "emit:metric"]);
  });

  it("leaves no trace of a record whose onRecord throws", () => {
    const events: unknown[] = [];
    let failing = true;
    const ledger = createRunLedger({
      emit: (e) => events.push(e),
      provenanceOf,
      onRecord: () => {
        if (failing) throw new Error("database unavailable");
      },
    });
    expect(() => ledger.addEvidence(evidenceInput())).toThrow("database unavailable");
    expect(ledger.snapshot().evidence).toEqual([]);
    expect(ledger.evidence("E1")).toBeUndefined();
    expect(events).toEqual([]);
    failing = false;
    expect(ledger.addEvidence(evidenceInput()).id).toBe("E1");
    expect(events).toHaveLength(1);
  });

  it("stamps each skill's findings with its own tool call, however the calls interleave", async () => {
    const events: { type: string; toolCallId?: string | null; finding?: { id: string } }[] = [];
    const ledger = createRunLedger({ emit: (e) => events.push(e), provenanceOf });
    const finding = { kind: "EMPTY_RESULT" as const, severity: "low" as const, text: "Nothing.", metricIds: [], suggestion: null };
    const skill = async (scoped: ReturnType<typeof ledger.forToolCall>, delays: number[]) => {
      for (const ms of delays) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        scoped.addFinding(finding);
      }
    };
    await Promise.all([skill(ledger.forToolCall("tc-a"), [5, 20]), skill(ledger.forToolCall("tc-b"), [1, 10])]);
    ledger.addFinding(finding);
    const stamped = events.map((e) => [e.finding?.id, e.toolCallId]);
    expect(stamped.map(([, tc]) => tc)).toEqual(["tc-b", "tc-a", "tc-b", "tc-a", null]);
    expect(stamped.map(([id]) => id)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    // Scoped views share one store: ids stay unique and every record is visible from the run ledger.
    expect(ledger.forToolCall("tc-a").finding("F3")).toBeDefined();
    expect(ledger.snapshot().findings).toHaveLength(5);
  });

  it("looks records up by id, live and from a snapshot", () => {
    const { ledger } = brandHealthLedger();
    expect(ledger.metric("M5")?.badge).toBe("STALE");
    expect(ledger.evidence("E9")).toBeUndefined();
    const index = indexSnapshot(ledger.snapshot());
    expect(index.dataset("D2")?.kind).toBe("Momentum");
    expect(index.finding("F1")?.kind).toBe("NEAR_SUBSTITUTES");
    expect(index.metric("M99")).toBeUndefined();
  });

  it("returns snapshot arrays the caller cannot use to change the ledger", () => {
    const { ledger } = brandHealthLedger();
    const snap = ledger.snapshot();
    snap.metrics.pop();
    expect(ledger.snapshot().metrics).toHaveLength(10);
  });
});
