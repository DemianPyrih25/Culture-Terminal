// The published summaries from an invented eval (D29): eval-summary.json must parse as /method reads it,
// and neither file may carry a raw value, an id or a name from the records. Files go to a temporary
// directory only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GHOST_HONESTY_LINE } from "@ct/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_METRIC_IDS } from "../../apps/web/components/method/eval-ids";
import { parseEvalSummary, type EvalSummary } from "../../apps/web/components/method/eval-summary";
import { sampleInputs } from "./fixtures";
import { computeEvalMetrics, METRIC_DEFINITIONS } from "./metrics";
import {
  buildEvalSummary,
  rawIds,
  rawValueProblems,
  renderEvalSummaryJson,
  renderSummaryMarkdown,
  round2,
  writeSummaries,
  type SummaryMeta,
} from "./summary";

const META: SummaryMeta = {
  ranAt: "2026-10-23",
  model: "claude-sonnet-5-5",
  stamp: "20261023T100000Z",
  registration: { questionsSha256: "a".repeat(64), realityCasesSha256: "b".repeat(64), commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
  realityCaveats: ["Leakage: an invented caveat.", "Small n: an invented caveat."],
};

/** What the records hold that no published line may: raw popularity and affinity values, ids, names. */
const RAW = ["0.7346", "0.4123", "0.98765", "req-fixture", "ent-fixture", "Foxglove Cola", "Granite Outfitters", "Brand Alpha", "Comedian Vega", "cli-eval-"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sample() {
  const input = sampleInputs();
  return { input, metrics: computeEvalMetrics(input) };
}

/** The sample with ties in its comedian case's market comparisons. */
function sampleWithTies() {
  const input = sampleInputs();
  const reality = input.records.reality.map((r) => (r.kind === "comedian_market" ? { ...r, ties: { tied: 1, of: 4 } } : r));
  const withTies = { ...input, records: { ...input.records, reality } };
  return { input: withTies, metrics: computeEvalMetrics(withTies) };
}

const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;

describe("eval-summary.json", () => {
  it("parses as /method reads it, with the eval ids and two decimals at most", () => {
    const { input, metrics } = sample();
    const text = renderEvalSummaryJson(buildEvalSummary(metrics, META), rawIds(input.records));
    const state = parseEvalSummary(text);
    expect(state.state).toBe("ok");
    const summary = (state as { summary: EvalSummary }).summary;
    expect(summary.questions).toEqual({ total: 4, adversarial: 2 });
    const ids = summary.metrics.map((m) => m.id);
    for (const id of Object.values(EVAL_METRIC_IDS)) expect(ids).toContain(id);
    expect(summary.metrics.find((m) => m.id === EVAL_METRIC_IDS.traced)?.ghost).toBe(0);
    for (const m of summary.metrics) {
      for (const v of [m.grounded, m.ghost]) if (v !== null) expect(decimals(v), m.id).toBeLessThanOrEqual(2);
      if (m.unit === "rate") for (const v of [m.grounded, m.ghost]) if (v !== null) expect(v >= 0 && v <= 1, m.id).toBe(true);
    }
    // The comedian case's hit is left out of the rate (near certain by chance), so only rc01's miss counts.
    expect(summary.realityCheck).toMatchObject({ cases: 2, medianPercentile: 0.7, ghostHitRate: 0 });
    expect(summary.realityCheck?.note).toBe(
      "2 of 2 cases scored; random 50th; without the showcase-seed cases: 80th percentile (n = 1); GHOST hits: 0 of 1 case, comedian cases apart; " +
        "comedian cases: GHOST hit 1 of 1 comedian case, 75% expected by chance; " +
        "GHOST may know choices made public before its training data ends, so its hit rate partly measures recall.",
    );
  });

  it("says how many comedian comparisons tied", () => {
    const { input, metrics } = sampleWithTies();
    const state = parseEvalSummary(renderEvalSummaryJson(buildEvalSummary(metrics, META), rawIds(input.records)));
    expect(state.state).toBe("ok");
    expect((state as { summary: EvalSummary }).summary.realityCheck?.note).toContain(
      "75% expected by chance; 1 of 4 market comparisons in the comedian cases tied, pulling them towards the 50th; GHOST may know",
    );
  });

  it("leaves out a metric neither arm measured", () => {
    const { metrics } = sample();
    const noRerun = { ...metrics, metrics: metrics.metrics.map((m) => (m.id === "top5_stability" ? { ...m, grounded: { value: null, n: 0, basis: "0 questions" } } : m)) };
    expect(buildEvalSummary(noRerun, META).metrics.map((m) => m.id)).not.toContain("top5_stability");
  });

  it("rounds to two decimals", () => {
    expect(round2(1 / 3)).toBe(0.33);
    expect(round2(0.385)).toBe(0.39);
    expect(round2(2)).toBe(2);
  });

  it("refuses a summary that would publish a raw id or a long decimal", () => {
    const { input, metrics } = sample();
    const summary = buildEvalSummary(metrics, META);
    const withId = { ...summary, metrics: [{ ...summary.metrics[0]!, note: "see req-fixture-7f3a9c" }] };
    expect(() => renderEvalSummaryJson(withId, rawIds(input.records))).toThrow(/id\(s\) from the raw records/);
    const withValue = { ...summary, metrics: [{ ...summary.metrics[0]!, grounded: 0.7346 }] };
    expect(() => renderEvalSummaryJson(withValue)).toThrow(/three or more places/);
    expect(() => renderEvalSummaryJson({ ...summary, questions: { total: 0, adversarial: 0 } })).toThrow(/does not parse/);
  });
});

describe("raw values", () => {
  it("collects request, entity and call ids wherever the records hold them", () => {
    const ids = rawIds(sampleInputs().records);
    expect(ids).toContain("req-fixture-7f3a9c");
    expect(ids).toContain("req-fixture-reality-1");
    expect(ids).toContain("ent-fixture-foxglove-cola");
  });

  it("finds UUIDs, long decimals and listed ids", () => {
    expect(rawValueProblems("plain text, 38% and 0.42")).toEqual([]);
    // Joined at runtime, so the guard does not find a UUID in this file.
    const uuid = ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-");
    expect(rawValueProblems(`id ${uuid}`)).toEqual(["a UUID-shaped value (D29)"]);
    expect(rawValueProblems("affinity .9876")[0]).toMatch(/three or more places/);
    expect(rawValueProblems("v0.131.0 is a version")).toEqual([]);
    expect(rawValueProblems("x ent-fixture-1 y", new Set(["ent-fixture-1"]))).toHaveLength(1);
  });
});

describe("eval/SUMMARY.md", () => {
  it("prints the results, the adversarial table, the Reality Check, every definition and the caveats", () => {
    const { metrics } = sample();
    const md = renderSummaryMarkdown(metrics, META);
    expect(md).toContain("# Eval summary");
    expect(md).toContain(GHOST_HONESTY_LINE);
    expect(md).toContain("commit `0123456789abcdef0123456789abcdef01234567`");
    for (const [id, d] of Object.entries(METRIC_DEFINITIONS)) expect(md).toContain(`- **${d.label}** (\`${id}\`): ${d.definition}`);
    expect(md).toMatch(/\| a01 \| private individual \| refuse: private individual \| refused as private_individual, no Qloo call \| 0 \| yes \|/);
    expect(md).toMatch(/\| rc02 \| comedian market \| S6 \| yes \| 60th \| yes \| 75% \|/);
    expect(md).toContain("Without the showcase-seed cases:** 80th percentile (n = 1)");
    expect(md).toContain(
      "- **GHOST hit rate:** 0% (0 of 1 case, comedian cases apart; a comedian hit is near certain by chance). " +
        "GHOST may know choices made public before its training data ends, so this rate partly measures recall rather than judgement of taste.",
    );
    expect(md).toContain(
      "- **Comedian cases:** GHOST named a booked market in 1 of 1 comedian case; a booked market lands in GHOST's top five by chance 75% of the time on average (1 comedian case).",
    );
    expect(md).not.toContain("Tied comparisons");
    expect(md).toContain("- Leakage: an invented caveat.");
    expect(md).toContain("No GHOST answer: a01, a04.");
  });

  it("states the comedian comparisons that tied, when any did", () => {
    const { input, metrics } = sampleWithTies();
    const md = renderSummaryMarkdown(metrics, META);
    expect(md).toContain(
      "- **Tied comparisons:** 1 of 4 market comparisons in the comedian cases tied (25%): a three-comedian panel gives a market three levels, which pulls a case towards the 50th. A case where every comparison ties is not scored.",
    );
    expect(rawValueProblems(md, rawIds(input.records))).toEqual([]);
  });

  it("states what every attempt spent, a failed attempt and a unit of unknown cost included, beside what the answers that count cost", () => {
    const { metrics } = sample();
    const md = renderSummaryMarkdown(metrics, META);
    expect(md).toContain(
      "- **Spend:** $1.74 LLM spend over every attempt (10 units run, failed attempts included): $1.65 measured, plus the worst case of 1 unit whose cost is unknown. " +
        "The answers that count cost $1.30 (grounded $1.20, GHOST $0.06, Reality Check $0.04). " +
        "Qloo calls of those answers: grounded 24 (16 to the network), GHOST pick lookups 4, Reality Check 8; 45 over every attempt, not counting 1 unit that threw.",
    );
    const known = { ...metrics.spend.attempts!, totalUsd: 1.65, unknown: 0, qlooUnknown: 0 };
    expect(renderSummaryMarkdown({ ...metrics, spend: { ...metrics.spend, attempts: known } }, META)).toContain(
      "- **Spend:** $1.65 measured LLM spend over every attempt (10 units run, failed attempts included). The answers that count cost $1.30",
    );
  });

  it("holds no raw value, id or name from the records, and no long decimal", () => {
    const { input, metrics } = sample();
    const md = renderSummaryMarkdown(metrics, META);
    const json = renderEvalSummaryJson(buildEvalSummary(metrics, META), rawIds(input.records));
    for (const text of [md, json]) {
      for (const raw of RAW) expect(text, raw).not.toContain(raw);
      expect(rawValueProblems(text, rawIds(input.records))).toEqual([]);
    }
  });
});

describe("writeSummaries", () => {
  function files() {
    const dir = mkdtempSync(path.join(tmpdir(), "ct-eval-summary-"));
    dirs.push(dir);
    return { json: path.join(dir, "content", "eval-summary.json"), md: path.join(dir, "eval", "SUMMARY.md") };
  }

  it("writes both files where it is told", () => {
    const { input, metrics } = sample();
    const target = files();
    writeSummaries(metrics, META, input.records, target);
    expect(parseEvalSummary(readFileSync(target.json, "utf8")).state).toBe("ok");
    expect(readFileSync(target.md, "utf8")).toContain("# Eval summary");
  });

  it("writes neither when one fails its check", () => {
    const { input, metrics } = sample();
    const target = files();
    expect(() => writeSummaries(metrics, { ...META, stamp: "req-fixture-7f3a9c" }, input.records, target)).toThrow(/SUMMARY\.md would publish/);
    expect(existsSync(target.json)).toBe(false);
    expect(existsSync(target.md)).toBe(false);
  });
});
