import { DEFAULT_RUN_LIMITS, type EventInput, type Intent } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { memoryIo } from "./io";
import { createTracePrinter, formatEvent, newTraceState } from "./trace";

// Invented entities and synthetic request ids only (D29).
const INTENT: Intent = {
  pillar: "investment",
  job: "brand_health",
  mentions: [{ text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false }],
  geo: { metro: null, area: null, unsupported_place: null, market: null },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
  safety: { allowed: true, category: null, reframe: null },
  assumptions: [],
  mnemonic: "BRAND ALPHA <BRAND> HLTH",
};

const lines = (event: EventInput, state = newTraceState()) => formatEvent(event, state);

describe("formatEvent", () => {
  it("shows the CLERK reading with the compiled mnemonic", () => {
    const [line] = lines({ type: "clerk", intent: INTENT, ms: 812 });
    expect(line).toMatch(/^CLERK\s+brand_health \(investment\) · BRAND ALPHA <BRAND> \w+ · Brand Alpha <brand, primary> · 812 ms$/);
  });

  it("prints resolve chips: refs for exact matches, the match class otherwise", () => {
    const [line] = lines({
      type: "resolve",
      entities: [
        { mention: "Brand Alpha", role: "primary", entityType: "brand", match: "exact", ref: "R1", name: "Brand Alpha", popularity: 0.5, disambiguation: null, alternatives: [], source: "gate" },
        {
          mention: "Brand Twin",
          role: "peer",
          entityType: "brand",
          match: "ambiguous",
          ref: null,
          name: null,
          popularity: null,
          disambiguation: null,
          alternatives: [
            { name: "Brand Twin", disambiguation: "2004", popularity: null },
            { name: "Brand Twin", disambiguation: "2019", popularity: null },
          ],
          source: "gate",
        },
      ],
    });
    expect(line).toBe("RESOLVE  Brand Alpha → R1 (exact, pop 0.50) · Brand Twin ✗ ambiguous (2 candidates)");
  });

  it("prints the plan with one line per hypothesis and per step", () => {
    const out = lines({
      type: "plan",
      plan: {
        restated_question: "How healthy is Brand Alpha's taste signal?",
        hypotheses: [
          { id: "H1", statement: "Brand Alpha is a taste island.", expectation: "Last in most rows.", test_tool: "peer_landscape", metric_hint: "rank in rows" },
          { id: "H2", statement: "Its audience skews young.", expectation: "Youth tilt above zero.", test_tool: "share_of_taste", metric_hint: "youth tilt" },
        ],
        steps: [{ id: "S1", tool: "peer_landscape", purpose: "Map the peers." }],
        assumptions: [],
      },
      estimates: [{ stepId: "S1", calls: 7 }],
    });
    expect(out).toEqual([
      "PLAN     How healthy is Brand Alpha's taste signal?",
      "         H1 Brand Alpha is a taste island. → peer_landscape",
      "         H2 Its audience skews young. → share_of_taste",
      "         S1 peer_landscape (~7 calls): Map the peers.",
    ]);
  });

  it("names the tool on each Qloo chip and shows its cache status and request id", () => {
    const state = newTraceState();
    lines(
      { type: "tool.start", toolCallId: "toolu_1", tool: "peer_landscape", phase: "wave1", args: {}, stepId: "S1", triggerFindingId: null, estimatedCalls: 7 },
      state,
    );
    const chip = lines(
      {
        type: "qloo",
        qlooCallId: "qc_1",
        toolCallId: "toolu_1",
        endpoint: "/v2/insights",
        filterType: "urn:entity:brand",
        paramsRedacted: {},
        cache: "reused",
        ms: 4,
        requestId: "req-synthetic-7",
        status: 200,
        rows: 20,
        cacheAgeMs: 1000,
        originRunId: "run-synthetic-0",
        error: null,
      },
      state,
    );
    expect(chip).toEqual(["  qloo [peer_landscape] /v2/insights brand REUSED 4 ms req req-synthetic-7 · 20 rows"]);
  });

  it("prints the CHECKER line with every issue under it", () => {
    expect(lines({ type: "validation", ok: true, attempt: 1, issues: [], numbersTraced: { traced: 12, total: 12 }, adviceTerms: 0 })).toEqual([
      "CHECKER  ✓ 12/12 numbers traced (attempt 1)",
    ]);
    const failed = lines({
      type: "validation",
      ok: false,
      attempt: 1,
      issues: [{ rule: "V2", action: "reject", message: "unknown metric M99", path: "thesis", subjects: ["M99"] }],
      numbersTraced: { traced: 11, total: 12 },
      adviceTerms: 0,
    });
    expect(failed).toEqual(["CHECKER  ✗ 11/12 numbers traced (attempt 1)", "         V2 reject: unknown metric M99 (thesis)"]);
  });

  it("marks pivots and findings with their suggested follow-up", () => {
    expect(lines({ type: "pivot", triggerFindingId: "F2", tool: "cross_domain", args: {}, toolCallId: "toolu_9" })).toEqual([
      "ANALYST PIVOT F2 → cross_domain (toolu_9)",
    ]);
    const [finding] = lines({
      type: "finding",
      toolCallId: "toolu_1",
      finding: { id: "F2", kind: "TASTE_ISLAND", severity: "high", text: "Brand Alpha ranks last in 4 of 4 rows.", metricIds: ["M3"], suggestion: { tool: "cross_domain", reason: "Find where its taste lives." } },
    });
    expect(finding).toBe("◆ F2 TASTE_ISLAND (high) Brand Alpha ranks last in 4 of 4 rows. → cross_domain");
  });

  it("prints nothing for metric and evidence events", () => {
    expect(
      lines({
        type: "metric",
        metric: {
          id: "M1",
          key: "popularity",
          label: "popularity Brand Alpha",
          subjectRefs: ["R1"],
          value: 0.5,
          reason: null,
          display: "0.50",
          unit: "popularity",
          badge: "MEASURED",
          formulaId: "popularity",
          evidenceIds: ["E1"],
          n: null,
          conf: null,
          comparator: null,
          window: null,
        },
      }),
    ).toEqual([]);
  });

  it("prints the running usage totals", () => {
    const [line] = lines({
      type: "usage",
      llmUsd: 0.1234,
      tokens: { input: 1000, output: 200, cacheRead: 5000, cacheCreation: 0 },
      qloo: { network: 6, cached: 2, reused: 1 },
      elapsedMs: 4200,
    });
    expect(line).toBe("usage    $0.12 · in 1,000 · out 200 · cache read 5,000 · cache write 0 · Qloo 6 network / 2 cached / 1 reused · 4.2 s");
  });
});

describe("createTracePrinter", () => {
  it("stamps the first line of an event with the seconds since the start and indents the rest", () => {
    const io = memoryIo();
    let t = 1_000;
    const trace = createTracePrinter(io, () => t);
    t = 3_500;
    trace.emit({ type: "run.created", question: "q", mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" });
    trace.emit({ type: "validation", ok: true, attempt: 1, issues: [{ rule: "V3", action: "warn", message: "w", path: null, subjects: [] }], numbersTraced: { traced: 1, total: 1 }, adviceTerms: 0 });
    expect(io.stdout[0]).toBe("   2.5s RUN      claude-sonnet-5-5 · live · lane public · caps 40 Qloo calls, $0.60 LLM");
    expect(io.stdout[2]).toBe("                 V3 warn: w");
  });

  it("keeps the needs_input picker", () => {
    const io = memoryIo();
    const trace = createTracePrinter(io, () => 0);
    trace.emit({ type: "needs_input", mention: "Brand Twin", entityType: "brand", reason: "ambiguous", candidates: [{ key: "c1", name: "Brand Twin", disambiguation: "2004", popularity: 0.4 }] });
    expect(trace.needsInput()?.mention).toBe("Brand Twin");
    expect(io.stdout[0]).toContain("NEEDS    'Brand Twin' (brand) is ambiguous: Brand Twin, 2004, pop 0.40");
  });

  it("prints model text as one clean line, with no escape sequence left in it", () => {
    const [line] = lines({ type: "note", text: "peers \u001b]52;c;ZXZpbA==\u0007first\r\n\u001b[2Jthen" });
    expect(line).toBe("note     peers ]52;c;ZXZpbA==first [2Jthen");
  });
});
