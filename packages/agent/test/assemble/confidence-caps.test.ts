// R1 (D47): ASSEMBLE hands computeConfidence the final signal, whether the lead rests on a thin sample and
// whether the concept was read only at category level; the receipt carries the side-call costs and the
// report the context blocks. computeConfidence is spied so these inputs are tested on their own; the caps
// themselves are quant's (packages/quant/test/confidence.test.ts). Invented ledger and names only (D29).
import * as quant from "@ct/quant";
import { Report, type AiContextBlock, type ReportDraft, type WebContextBlock } from "@ct/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleReport, buildIncompleteReport, type ReportContext } from "../../src/assemble";
import { checkReport } from "../../src/checker";
import { recordScorecard } from "../../src/scorecard";
import { honestyLedger, honestyRegistry } from "../checker/honesty-fixtures";
import { brandHealthLedger, plan, validDraft } from "../ledger/fixtures";
import { context } from "./support";

vi.mock("@ct/quant", async (importActual) => {
  const actual = await importActual<typeof import("@ct/quant")>();
  return { ...actual, computeConfidence: vi.fn(actual.computeConfidence) };
});

const spy = vi.mocked(quant.computeConfidence);
afterEach(() => spy.mockClear());

/** The input computeConfidence received for the last report. */
const lastInput = () => spy.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;

function assemble(change: (d: ReportDraft) => void = () => {}, overrides: Partial<ReportContext> = {}, attempt: 1 | 2 = 1) {
  // The honesty ledger already holds D1–D3 and a lift map; the Scorecard joins it.
  const fx = brandHealthLedger();
  const draft = validDraft();
  change(draft);
  recordScorecard(fx.ledger, plan(), draft);
  const base = honestyLedger();
  const ledger = { ...base, datasets: [...base.datasets, ...fx.ledger.snapshot().datasets.filter((d) => d.kind === "Scorecard")] };
  const check = checkReport({ draft, plan: plan(), ledger, qlooEnabled: true, registry: honestyRegistry(), concepts: ["kelp tonic"], attempt });
  return Report.parse(assembleReport({ ...context(ledger, overrides), check }));
}

describe("R1: the confidence inputs ASSEMBLE passes", () => {
  it("passes the final signal, and no thin or category flag on a clean note", () => {
    assemble();
    expect(lastInput()).toMatchObject({ signal: "mixed", thinSample: false, categoryLevel: false });
    assemble((d) => (d.signal = "weak"));
    expect(lastInput()).toMatchObject({ signal: "weak" });
  });

  it("marks a thin sample behind the headline, the thesis or a decided hypothesis, but not behind an argument alone", () => {
    assemble((d) => (d.headline = "Brand Alpha is the most distinctive {{M13}}"));
    expect(lastInput()).toMatchObject({ thinSample: true });
    assemble((d) => (d.hypothesis_verdicts[1] = { hypothesis_id: "H2", verdict: "refuted", metric_ids: ["M3", "M13"], note: "Young {{M3}}." }));
    expect(lastInput()).toMatchObject({ thinSample: true });
    assemble((d) => (d.arguments[0]!.metric_ids = ["M1", "M13"]));
    expect(lastInput()).toMatchObject({ thinSample: false });
  });

  it("marks a category-level read when a cited metric reads a category, the run flags one, or a look-alike survives the repair", () => {
    assemble((d) => (d.arguments[0]!.qloo_fact = "The category fits {{M12}} [E1]."));
    expect(lastInput()).toMatchObject({ categoryLevel: true });
    assemble(() => {}, { runFlags: ["CATEGORY_LEVEL_READ"] });
    expect(lastInput()).toMatchObject({ categoryLevel: true });
    assemble((d) => (d.arguments[0]!.qloo_fact = "Brand Beta fits {{M11}} [E1]."), {}, 2);
    expect(lastInput()).toMatchObject({ categoryLevel: true });
  });

  it("passes insufficient_evidence and no thin sample for an evidence digest", () => {
    const fx = brandHealthLedger();
    recordScorecard(fx.ledger, plan(), null);
    buildIncompleteReport({ ...context(fx.ledger.snapshot()), reason: "hard time limit reached" });
    expect(lastInput()).toMatchObject({ signal: "insufficient_evidence", thinSample: false, insufficientEvidence: true });
  });
});

describe("R4/R5: context blocks and their costs", () => {
  const ai: AiContextBlock = {
    status: "ok",
    items: [{ topic: "Ownership", text: "Brand Alpha is owned by an invented holding group.", kind: "deal" }],
    presenceMarkets: ["austin"],
    model: "claude-sonnet-5-5",
    generatedAt: "2026-10-21T09:00:00.000Z",
    cached: false,
    note: null,
    droppedForNumbers: 0,
  };
  const web: WebContextBlock = { status: "empty", items: [], model: "claude-haiku-5-5", searches: 2, retrievedAt: "2026-10-21T09:00:00.000Z", cached: false, note: "The web search found nothing citable.", droppedForNumbers: 0 };

  it("puts both blocks in the report and the side costs in the receipt, beside the measured answer", () => {
    const report = assemble(() => {}, {
      aiContext: ai,
      webContext: web,
      sideCost: { aiUsd: 0.01, webUsd: 0.03, webSearches: 2 },
      models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null, context: "claude-sonnet-5-5", web: "claude-haiku-5-5" },
    });
    expect(report.aiContext).toEqual(ai);
    expect(report.webContext).toEqual(web);
    expect(report.receipt.context).toEqual({ aiUsd: 0.01, webUsd: 0.03, webSearches: 2 });
    expect(report.receipt.models).toMatchObject({ context: "claude-sonnet-5-5", web: "claude-haiku-5-5" });
    // The blocks change nothing measured.
    const plain = assemble();
    expect(report.verdict).toEqual(plain.verdict);
    expect(report.kpis).toEqual(plain.kpis);
  });

  it("leaves both out for a run without side calls (stored runs render nothing)", () => {
    const report = assemble();
    expect(report.aiContext).toBeUndefined();
    expect(report.webContext).toBeUndefined();
    expect(report.receipt.context).toBeUndefined();
  });
});

describe("flag limitations with their own text", () => {
  it("lists them after the concept and nearest-job lines, once, and never repeats their flag generically", () => {
    const text = "Brand Gamma is part of Invented Holdings. SEC filings report Invented Holdings as a whole, so no Brand Gamma figures are shown.";
    const report = assemble(() => {}, {
      flagLimitations: [
        { source: "flag", flag: "NOT_SEPARATELY_REPORTED", text },
        { source: "flag", flag: "NOT_SEPARATELY_REPORTED", text },
      ],
      runFlags: ["NOT_SEPARATELY_REPORTED"],
      runLimitations: ["No OpenStreetMap tag for 'kelp tonic': only overall street activity (shops, food and drink places) was counted for it."],
    });
    const own = report.limitations.filter((l) => l.source === "flag" && l.flag === "NOT_SEPARATELY_REPORTED");
    expect(own).toEqual([{ source: "flag", flag: "NOT_SEPARATELY_REPORTED", text }]);
    expect(report.limitations.map((l) => l.text)).toContain(
      "No OpenStreetMap tag for 'kelp tonic': only overall street activity (shops, food and drink places) was counted for it.",
    );
  });
});
