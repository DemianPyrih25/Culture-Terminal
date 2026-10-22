import { describe, expect, it, vi } from "vitest";
import { RUN_EVENT_TYPES, reduceRunEvents, RunEvent, stampEvent, type RunEventType } from "@ct/contracts";
import { summarizeEvent } from "../lib/event-summary";
import { buildFakeScript } from "../server/fake-script";

vi.mock("server-only", () => ({}));

const RUN = "run-fake-script-test";
const startedAt = Date.UTC(2026, 0, 1);
const durationMs = 200_000;
const script = buildFakeScript({ runId: RUN, startedAt, durationMs });
const events: RunEvent[] = [
  ...script.steps.map((step, i) =>
    stampEvent(step.input, { seq: i + 1, ts: new Date(startedAt + step.at * durationMs).toISOString(), runId: RUN }),
  ),
  stampEvent(
    { type: "run.end", status: "completed", elapsedMs: durationMs, reason: null },
    { seq: script.steps.length + 1, ts: new Date(startedAt + durationMs).toISOString(), runId: RUN },
  ),
];

describe("fake run script", () => {
  it("is valid against the contracts, event by event", () => {
    for (const event of events) expect(() => RunEvent.parse(event)).not.toThrow();
  });

  it("is paced across the run and leaves room for run.end", () => {
    const ats = script.steps.map((s) => s.at);
    expect(ats[0]).toBe(0);
    for (let i = 1; i < ats.length; i++) expect(ats[i]).toBeGreaterThan(ats[i - 1] ?? 0);
    expect(ats.at(-1)).toBeLessThan(1);
    // No silent stretch near the 15 s ping interval on the default 200 s run.
    const gaps = ats.slice(1).map((at, i) => (at - (ats[i] ?? 0)) * durationMs);
    expect(Math.max(...gaps)).toBeLessThan(8000);
    expect(events.length).toBeGreaterThan(100);
  });

  it("covers every event type except the ones a fake run never takes", () => {
    const seen = new Set<RunEventType>(events.map((e) => e.type));
    const notInFakeRun: RunEventType[] = ["needs_input", "ghost", "error"];
    for (const type of RUN_EVENT_TYPES) {
      if (!notInFakeRun.includes(type)) expect(seen, type).toContain(type);
    }
    const caches = new Set(events.flatMap((e) => (e.type === "qloo" ? [e.cache] : [])));
    for (const cache of ["hit", "miss", "reused"] as const) expect(caches).toContain(cache);
  });

  it("only refers to ids that were emitted earlier", () => {
    const known = new Set<string>();
    for (const e of events) {
      const refs: string[] = [];
      if (e.type === "pivot") refs.push(e.triggerFindingId);
      if (e.type === "tool.start" && e.triggerFindingId) refs.push(e.triggerFindingId);
      if (e.type === "tool.end") refs.push(...e.evidenceIds, ...e.metricIds, ...e.datasetIds, ...e.findingIds);
      for (const ref of refs) expect(known, `${e.type} #${e.seq} cites ${ref}`).toContain(ref);
      if (e.type === "finding") known.add(e.finding.id);
      if (e.type === "metric") known.add(e.metric.id);
      if (e.type === "evidence") known.add(e.evidence.id);
      if (e.type === "dataset.ready") known.add(e.datasetId);
    }
  });

  it("follows a finding with an ANALYST PIVOT and records a CODE FALLBACK", () => {
    const state = reduceRunEvents(RUN, events);
    expect(state.pivots.length).toBeGreaterThan(0);
    for (const pivot of state.pivots) expect(state.findings.map((f) => f.id)).toContain(pivot.triggerFindingId);
    expect(state.fallbacks).toHaveLength(1);
    expect(state.toolCalls.every((t) => t.status !== "running")).toBe(true);
    expect(state.report?.runId).toBe(RUN);
    expect(state.status).toBe("completed");
  });

  it("keeps the usage counters in step with the Qloo chips and spends nothing on models", () => {
    const state = reduceRunEvents(RUN, events);
    expect(state.usage?.qloo).toEqual({ network: state.qloo.network, cached: state.qloo.cached, reused: state.qloo.reused });
    expect(state.usage?.llmUsd).toBe(0);
    expect(script.report.receipt.qlooNetwork).toBe(state.qloo.network);
    expect(script.report.receipt.usd).toBe(0);
  });

  it("uses invented data only (no UUIDs or real request ids)", () => {
    const text = JSON.stringify(script);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const e of events) if (e.type === "qloo") expect(e.requestId).toMatch(/^synthetic-/);
  });

  it("summarizes every event on one line", () => {
    for (const e of events) {
      const line = summarizeEvent(e);
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain("\n");
    }
  });
});
