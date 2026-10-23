// The synthetic sample runs (server/samples, written by tools/dev/sample-run.ts): what each one holds
// for demos, UI tests and the replay player. Every entity is invented (D29).
import { describe, expect, it, vi } from "vitest";
import { CacheStatus, type RunEvent } from "@ct/contracts";
import { SAMPLE_NAMES, sampleEvents, sampleRunId, sampleState, type SampleName } from "../server/samples";

vi.mock("server-only", () => ({}));

const ofType = <T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

const END: Record<SampleName, string> = {
  "brand-health": "completed",
  "brand-health-incomplete": "incomplete",
  "needs-input": "needs_input",
};

describe("sample runs", () => {
  it.each(SAMPLE_NAMES)("%s is one stamped run, gap-free from run.created to run.end", (name) => {
    const events = sampleEvents(name);
    expect(events[0]?.type).toBe("run.created");
    expect(events.at(-1)).toMatchObject({ type: "run.end", status: END[name] });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set([sampleRunId(name)]));
    const times = events.map((e) => Date.parse(e.ts));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] ?? 0);
    expect(sampleState(name).status).toBe(END[name]);
  });

  it.each(SAMPLE_NAMES)("%s holds invented data only: no UUIDs, synthetic request ids", (name) => {
    const events = sampleEvents(name);
    expect(JSON.stringify(events)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const e of ofType(events, "qloo")) expect(e.requestId).toMatch(/^mock-[0-9a-f]{16}$/);
  });

  it.each(SAMPLE_NAMES)("%s never says its data came from Qloo's dataset", (name) => {
    const events = sampleEvents(name);
    expect(JSON.stringify(events)).not.toMatch(/hackathon dataset/i);
    for (const { report } of ofType(events, "report.final")) {
      const data = report.disclaimers.filter((line) => line.startsWith("Data: "));
      expect(data).toHaveLength(1);
      expect(data[0]).toMatch(/^Data: synthetic sample from the mock Qloo transport and a scripted model; no Qloo or model calls were made/);
    }
  });

  it("brand-health is the finished brief: priors, the scan, an ANALYST PIVOT and a clean CHECKER", () => {
    const events = sampleEvents("brand-health");
    const state = sampleState("brand-health");
    const elapsed = Date.parse(events.at(-1)?.ts ?? "") - Date.parse(events[0]?.ts ?? "");
    expect(elapsed).toBeGreaterThan(30_000);
    expect(elapsed).toBeLessThan(60_000);

    expect(state.plan?.plan.hypotheses.length).toBeGreaterThanOrEqual(3);
    expect(ofType(events, "tool.start").some((e) => e.phase === "scan" && e.tool === "peer_landscape")).toBe(true);
    const outside = state.findings.find((f) => f.kind === "OUTSIDE_CATEGORY_NEIGHBOUR");
    expect(state.findings.map((f) => f.kind)).toContain("TASTE_ISLAND");
    expect(state.pivots).toEqual([expect.objectContaining({ tool: "peer_landscape", triggerFindingId: outside?.id })]);
    expect(ofType(events, "note").length).toBeGreaterThanOrEqual(6);

    const validation = ofType(events, "validation").at(-1);
    expect(validation).toMatchObject({ ok: true, adviceTerms: 0 });
    expect(validation?.issues.some((i) => i.rule === "V10")).toBe(false);
    const report = state.report;
    if (!report) throw new Error("no report");
    expect(report.incomplete).toBe(false);
    expect(report.receipt.numbersTraced.total).toBeGreaterThan(0);
    expect(report.receipt.numbersTraced.traced).toBe(report.receipt.numbersTraced.total);
    expect(new Set(report.scorecard.map((r) => r.verdict))).toEqual(new Set(["REFUTED", "CONFIRMED", "INCONCLUSIVE"]));
    expect(report.kpis.length).toBeGreaterThan(0);
    for (const kpi of report.kpis) expect(state.metrics[kpi.metricId]?.value).not.toBeNull();
    for (const exhibit of report.exhibits) expect(state.datasets[exhibit.datasetId]?.data).toBeTruthy();
    expect(report.exhibits.filter((x) => x.kind === "Matrix").length).toBeGreaterThanOrEqual(2);
    expect(report.bearCase.every((b) => b.metricIds.length > 0)).toBe(true);
    // The prose cites measured numbers only: no metric it names is unavailable.
    const cited = [
      ...report.scorecard.flatMap((r) => r.metricIds),
      ...report.arguments.flatMap((a) => a.metricIds),
      ...report.bearCase.flatMap((b) => b.metricIds),
    ];
    for (const id of cited) expect(state.metrics[id]?.value, id).not.toBeNull();
    expect(report.nextMoves.length).toBeGreaterThanOrEqual(2);
    expect(report.receipt.usd).toBeGreaterThan(0);
  });

  it("brand-health serves Qloo calls every way a brief shows them: network, hit, reused, stale and coalesced", () => {
    const events = sampleEvents("brand-health");
    const runId = sampleRunId("brand-health");
    const calls = ofType(events, "qloo");
    expect(new Set(calls.map((c) => c.cache))).toEqual(new Set(CacheStatus.options));
    for (const c of calls) {
      expect(c.status, `${c.cache} #${c.seq}`).toBe(200);
      switch (c.cache) {
        case "miss":
          expect(c.ms).toBeGreaterThan(0);
          expect(c.cacheAgeMs).toBeNull();
          break;
        case "hit":
          // Left by the Ask preview, which belongs to no run.
          expect(c.cacheAgeMs).toBeGreaterThan(0);
          expect(c.originRunId).toBeNull();
          break;
        case "reused":
          expect(c.cacheAgeMs).toBeGreaterThan(0);
          expect(c.originRunId).not.toBe(runId);
          break;
        case "stale":
          // Retried against a failing Qloo, then answered from an expired copy (older than the 30-day catalogue TTL).
          expect(c.ms).toBeGreaterThan(1_000);
          expect(c.cacheAgeMs).toBeGreaterThan(30 * 86_400_000);
          expect(c.originRunId).not.toBe(runId);
          break;
        case "coalesced":
          // Joined another run's request in flight: answered when that run's was, with a fresh copy.
          expect(c.ms).toBeGreaterThan(0);
          expect(c.cacheAgeMs).toBe(0);
          expect(c.originRunId).not.toBe(runId);
          break;
      }
    }
    const stale = calls.find((c) => c.cache === "stale");
    const flagged = ofType(events, "evidence").filter((e) => e.evidence.flags.includes("STALE_CACHE"));
    expect(flagged.map((e) => e.evidence.qlooCallIds)).toEqual([expect.arrayContaining([stale?.qlooCallId])]);
    const report = sampleState("brand-health").report;
    expect(report?.limitations.some((l) => l.flag === "STALE_CACHE")).toBe(true);
    const count = (...caches: string[]) => calls.filter((c) => caches.includes(c.cache)).length;
    expect(report?.receipt).toMatchObject({
      qlooNetwork: count("miss", "stale"),
      qlooCached: count("hit", "coalesced"),
      qlooReused: count("reused"),
    });
  });

  it("brand-health-incomplete stops at the hard wall clock with the INCOMPLETE evidence digest", () => {
    const events = sampleEvents("brand-health-incomplete");
    const state = sampleState("brand-health-incomplete");
    expect(events.at(-1)).toMatchObject({ type: "run.end", elapsedMs: 180_000 });
    expect(state.report).toMatchObject({ incomplete: true, verdict: { signal: "insufficient_evidence" } });
    expect(state.report?.limitations.some((l) => l.flag === "INCOMPLETE_RUN")).toBe(true);
    expect(ofType(events, "report.draft")).toHaveLength(0);
  });

  it("needs-input ends at the resolution gate with a picker and no report", () => {
    const events = sampleEvents("needs-input");
    const picker = ofType(events, "needs_input")[0];
    expect(picker?.reason).toBe("ambiguous");
    expect(picker?.candidates.length).toBeGreaterThan(1);
    for (const c of picker?.candidates ?? []) expect(c.key).toMatch(/^pk_[0-9a-f]{16}$/);
    expect(sampleState("needs-input").report).toBeNull();
    expect(ofType(events, "plan")).toHaveLength(0);
  });
});
