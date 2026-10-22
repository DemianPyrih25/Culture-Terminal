import { describe, expect, it } from "vitest";
import type { RunRecord } from "./analyst-run";
import type { BenchConfigId } from "./config";
import { decide, DECISION_RULE, formatTable, summarize, type ConfigSummary } from "./summary";

function runRecord(config: BenchConfigId, run: number, wallSeconds: number, usd: number, partial: Partial<RunRecord> = {}): RunRecord {
  const submitted = { submitted: true, structural: true, limits: true, issues: [], input: {} };
  return {
    config,
    model: config.startsWith("haiku") ? "claude-haiku-5-5" : "claude-sonnet-5-5",
    effort: config.endsWith("low") ? "low" : "medium",
    thinkingDisplay: "updates",
    run,
    outcome: "completed",
    reason: null,
    error: null,
    refusal: null,
    wallMs: wallSeconds * 1000,
    usd,
    estimatedChargesUsd: 0,
    usage: { input: 1000, output: 4000, cacheCreation: 20_000, cacheRead: 30_000 },
    responses: 3,
    turnReached: 3,
    nudges: { plan: false, report: false },
    plan: submitted,
    report: submitted,
    quality: null,
    firstRequestCacheRead: run > 1 ? 18_000 : 0,
    thinkingNonEmpty: true,
    turns: [],
    ...partial,
  };
}

const summaries = (runs: RunRecord[]): ConfigSummary[] =>
  (["sonnet-medium", "sonnet-low", "haiku-medium"] as const).map((c) => summarize(c, runs));

describe("decide (PLAN §4.2 rule)", () => {
  it("picks sonnet-medium when its p50 is within 100 s and $0.30 per run", () => {
    const d = decide(summaries([runRecord("sonnet-medium", 1, 80, 0.2), runRecord("sonnet-medium", 2, 90, 0.24)]));
    expect(d.pick).toBe("sonnet-medium");
    expect(d.reason).toContain("85.0 s");
  });

  it("accepts the exact limits", () => {
    const d = decide(summaries([runRecord("sonnet-medium", 1, DECISION_RULE.maxP50Seconds, DECISION_RULE.maxUsdPerRun)]));
    expect(d.pick).toBe("sonnet-medium");
  });

  it("picks sonnet-low when the p50 of two runs is over 100 s even if one run was fast", () => {
    const d = decide(summaries([runRecord("sonnet-medium", 1, 90, 0.2), runRecord("sonnet-medium", 2, 120, 0.2)]));
    expect(d.pick).toBe("sonnet-low");
    expect(d.reason).toContain("too slow");
  });

  it("picks sonnet-low when sonnet-medium costs more than $0.30 per run", () => {
    const d = decide(summaries([runRecord("sonnet-medium", 1, 60, 0.31), runRecord("sonnet-medium", 2, 60, 0.33)]));
    expect(d.pick).toBe("sonnet-low");
    expect(d.reason).toContain("too costly");
    expect(d.reason).not.toContain("too slow");
  });

  it("names both failures when sonnet-medium is slow and costly", () => {
    expect(decide(summaries([runRecord("sonnet-medium", 1, 150, 0.5)])).reason).toContain("too slow and too costly");
  });

  it("falls back to sonnet-low when no sonnet-medium run finished", () => {
    const d = decide(
      summaries([
        runRecord("sonnet-medium", 1, 10, 0.01, { outcome: "failed" }),
        runRecord("sonnet-medium", 2, 0, 0, { outcome: "budget_stopped" }),
        runRecord("sonnet-low", 1, 50, 0.1),
      ]),
    );
    expect(d.pick).toBe("sonnet-low");
    expect(d.reason).toMatch(/no finished sonnet-medium run/);
  });

  it("measures incomplete runs too: they still cost time and money", () => {
    const s = summarize("sonnet-medium", [runRecord("sonnet-medium", 1, 130, 0.4, { outcome: "incomplete" })]);
    expect(s.finished).toBe(1);
    expect(s.completed).toBe(0);
    expect(decide([s]).pick).toBe("sonnet-low");
  });

  it("warns when a later run read nothing from the cache or a report was invalid", () => {
    const d = decide(
      summaries([
        runRecord("sonnet-medium", 1, 60, 0.2),
        runRecord("sonnet-medium", 2, 60, 0.2, {
          firstRequestCacheRead: 0,
          report: { submitted: true, structural: false, limits: false, issues: [], input: {} },
        }),
      ]),
    );
    expect(d.pick).toBe("sonnet-medium");
    expect(d.warnings.join("\n")).toMatch(/cache_read_input_tokens was 0/);
    expect(d.warnings.join("\n")).toMatch(/1 of 2 runs without a schema-valid submit_report/);
  });

  it("decides on measured cost only and warns when a run also carries estimated charges", () => {
    const d = decide(
      summaries([
        runRecord("sonnet-medium", 1, 60, 0.16, { estimatedChargesUsd: 0.37 }),
        runRecord("sonnet-medium", 2, 60, 0.16),
      ]),
    );
    expect(d.pick).toBe("sonnet-medium");
    expect(d.reason).toContain("$0.1600 per run");
    expect(d.warnings.join("\n")).toMatch(/sonnet-medium: 1 finished run\(s\) had a failed request that may have been billed.*\$0\.3700/);
  });

  it("warns when a request's prompt was larger than the budget estimate assumed", () => {
    const turn = { estimateShortfallTokens: 120 } as RunRecord["turns"][number];
    const d = decide(summaries([runRecord("sonnet-medium", 1, 60, 0.2, { turns: [turn] })]));
    expect(d.warnings.join("\n")).toMatch(/sonnet-medium: 1 request\(s\) had a larger prompt than the budget estimate assumed/);
  });
});

describe("summarize", () => {
  it("collects p50s, second-run cache reads and validity counts per config", () => {
    const s = summarize("sonnet-low", [
      runRecord("sonnet-low", 1, 40, 0.1),
      runRecord("sonnet-low", 2, 60, 0.14, { nudges: { plan: true, report: false }, thinkingNonEmpty: false }),
      runRecord("sonnet-medium", 1, 999, 9),
    ]);
    expect(s.runs).toBe(2);
    expect(s.p50WallSeconds).toBe(50);
    expect(s.p50UsdPerRun).toBeCloseTo(0.12, 10);
    expect(s.secondRunCacheRead).toEqual([18_000]);
    expect(s.thinkingNonEmpty).toBe(1);
    expect(s.nudges).toBe(1);
    expect(s.outcomes).toEqual({ completed: 2 });
  });
});

describe("formatTable", () => {
  it("prints one row per config with the headline columns", () => {
    const table = formatTable(summaries([runRecord("sonnet-medium", 1, 80, 0.2), runRecord("sonnet-medium", 2, 90, 0.24)]));
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^config\s+finished\s+p50 wall s\s+p50 \$\/run/);
    expect(lines[1]).toMatch(/^sonnet-medium\s+2\/2\s+85\.0\s+\$0\.2200/);
    expect(lines[3]).toMatch(/^haiku-medium\s+0\/0\s+n\/a/);
  });
});
