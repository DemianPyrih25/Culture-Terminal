import { describe, expect, it, vi } from "vitest";
import { SCAN_TABLE } from "@ct/agent";
import {
  CacheStatus,
  RUN_EVENT_TYPES,
  reduceRunEvents,
  RunEvent,
  stampEvent,
  unstampEvent,
  type RunEventType,
} from "@ct/contracts";
import { buildFakeScript, FAKE_MODEL, FAKE_QUESTION } from "../server/fake-script";
import { sampleEvents } from "../server/samples";

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
    // The brand-health sample's scan runs every scan skill that applies and walks no location ladder, so it has
    // no CODE FALLBACK. Its brand is invented and not a listed company, so no SEC or Census call (`public`) is made.
    const notInFakeRun: RunEventType[] = ["needs_input", "ghost", "error", "fallback", "public"];
    for (const type of RUN_EVENT_TYPES) {
      if (!notInFakeRun.includes(type)) expect(seen, type).toContain(type);
    }
    const caches = new Set(events.flatMap((e) => (e.type === "qloo" ? [e.cache] : [])));
    expect(caches).toEqual(new Set(CacheStatus.options));
    // Evidence with a data-quality flag, so the brief's flagged states are reachable from a test run.
    expect(events.some((e) => e.type === "evidence" && e.evidence.flags.includes("STALE_CACHE"))).toBe(true);
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

  it("follows a finding with an ANALYST PIVOT, with no CODE FALLBACK", () => {
    const state = reduceRunEvents(RUN, events);
    expect(state.pivots.length).toBeGreaterThan(0);
    for (const pivot of state.pivots) expect(state.findings.map((f) => f.id)).toContain(pivot.triggerFindingId);
    expect(state.fallbacks).toHaveLength(0);
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
    // The mock transport's request ids: derived from the request, never UUID-shaped (D29).
    for (const e of events) if (e.type === "qloo") expect(e.requestId).toMatch(/^mock-[0-9a-f]{16}$/);
  });
});

describe("fake run script: the brand-health sample replayed as a test run", () => {
  const sample = sampleEvents("brand-health");
  const sampleReport = sample.find((e) => e.type === "report.final");
  if (sampleReport?.type !== "report.final") throw new Error("the brand-health sample has no report.final");

  it("replays the sample's events in order, adding none", () => {
    expect(script.steps.map((s) => s.input.type)).toEqual(sample.slice(0, -1).map((e) => e.type));
  });

  it("replays a sample whose opening scan ran every scan skill of its job that applies", () => {
    // company_financials joins only for a brand in config/listed_companies.json; the sample's brand is invented.
    const planned = SCAN_TABLE.brand_health.map((entry) => entry.tool).filter((tool) => tool !== "company_financials");
    const ran = sample.flatMap((e) => (e.type === "tool.start" && e.phase === "scan" ? [e.tool] : []));
    expect(ran).toEqual(planned);
  });

  it("asks the test question as the fake model, keeping the sample's trace", () => {
    const created = script.steps[0]?.input;
    expect(created).toMatchObject({ type: "run.created", question: FAKE_QUESTION, model: FAKE_MODEL, parentRunId: null });
    expect(FAKE_QUESTION.startsWith("Test run:")).toBe(true);
    const sampleQloo = sample.flatMap((e) => (e.type === "qloo" ? [unstampEvent(e).input] : []));
    expect(script.steps.flatMap((s) => (s.input.type === "qloo" ? [s.input] : []))).toEqual(sampleQloo);
    const pivot = script.steps.find((s) => s.input.type === "pivot")?.input;
    const finding = script.steps.find((s) => s.input.type === "finding" && s.input.finding.kind === "OUTSIDE_CATEGORY_NEIGHBOUR")?.input;
    expect(pivot?.type === "pivot" && finding?.type === "finding" && pivot.triggerFindingId === finding.finding.id).toBe(true);
  });

  it("ends with a zero-spend synthetic receipt and the sample's confidence", () => {
    const { report } = script;
    expect(report).toMatchObject({ runId: RUN, question: FAKE_QUESTION, incomplete: false });
    expect(script.steps.find((s) => s.input.type === "report.final")?.input).toEqual({ type: "report.final", report });
    expect(report.receipt).toMatchObject({
      usd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      models: { clerk: null, analyst: null, ghost: null },
      ms: durationMs,
    });
    expect(report.receipt.numbersTraced).toEqual(sampleReport.report.receipt.numbersTraced);
    expect(report.receipt.numbersTraced.traced).toBe(report.receipt.numbersTraced.total);
    expect(report.disclaimers.at(-1)).toMatch(/^Data: synthetic test data/);
    expect(report.disclaimers.filter((d) => d.startsWith("Data: "))).toHaveLength(1);
    expect(report.verdict.confidence).toEqual(sampleReport.report.verdict.confidence);
    for (const s of script.steps) if (s.input.type === "usage") expect(s.input).toMatchObject({ llmUsd: 0, tokens: { input: 0, output: 0 } });
  });

  it("moves the sample's timestamps onto the test run, keeping the age of cached data", () => {
    const { report } = script;
    const created = Date.parse(report.createdAt);
    expect(created).toBeGreaterThan(startedAt);
    expect(created).toBeLessThanOrEqual(startedAt + durationMs);
    const from = Date.parse(report.dataFreshness.fetchedFrom ?? "");
    const sampleStart = Date.parse(sample[0]?.ts ?? "");
    const sampleFrom = Date.parse(sampleReport.report.dataFreshness.fetchedFrom ?? "");
    // Data fetched before the sample run started (a reused response) keeps its age.
    expect(from - startedAt).toBe(sampleFrom - sampleStart);
    for (const s of script.steps) {
      if (s.input.type === "evidence") expect(Date.parse(s.input.evidence.fetchedAt)).toBeLessThanOrEqual(startedAt + s.at * durationMs);
    }
    for (const exhibit of report.exhibits) expect(exhibit.sourceLine).not.toContain(sample[0]?.ts.slice(0, 10) ?? "-");
  });

  it("is the same script for the same run", () => {
    expect(buildFakeScript({ runId: RUN, startedAt, durationMs })).toEqual(script);
  });
});
