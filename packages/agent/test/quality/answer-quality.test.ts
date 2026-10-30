// The answer-quality audit (docs/ANSWER_QUALITY.md automated checks, Part 11): auditReport finds each
// problem the owner's list names that code can see, and a clean note of every job has none. The scripted
// end-to-end run of each of the 13 jobs (test/run/jobs.test.ts) asserts an empty Report.audit too.
// Invented ledger and names only (D29).
import { CONFIDENCE_CAP, Job, Report, type DatasetEnvelope, type Limitation } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { assembleReport } from "../../src/assemble";
import { checkReport } from "../../src/checker";
import { auditReport } from "../../src/report/audit";
import { recordScorecard } from "../../src/scorecard";
import { context } from "../assemble/support";
import { honestyLedger, honestyRegistry } from "../checker/honesty-fixtures";
import { brandHealthLedger, plan, validDraft } from "../ledger/fixtures";

/** A clean note on the fixture ledger, for any job, with its ledger. */
function clean(job: Job = "brand_health") {
  const fx = brandHealthLedger();
  const draft = validDraft();
  recordScorecard(fx.ledger, plan(), draft);
  const ledger = fx.ledger.snapshot();
  const check = checkReport({ draft, plan: plan(), ledger, qlooEnabled: true, registry: honestyRegistry() });
  return { report: Report.parse(assembleReport({ ...context(ledger, { job }), check })), ledger };
}

describe("a clean note has no audit issue, on every job", () => {
  it.each(Job.options)("%s", (job) => {
    const { report } = clean(job);
    expect(report.audit).toEqual([]);
    expect(report.receipt.numbersTraced.traced).toBe(report.receipt.numbersTraced.total);
  });
});

describe("auditReport finds each problem", () => {
  const base = clean();
  const audit = (change: (r: Report) => void, ledger = base.ledger) => {
    const r = structuredClone(base.report);
    change(r);
    return auditReport(r, ledger);
  };

  it("§11: a literal escape sequence anywhere in the report", () => {
    expect(audit((r) => (r.verdict.thesis = `${r.verdict.thesis} Range 25\\u201329.`))).toEqual([expect.stringContaining("Literal escape sequence")]);
  });

  it("§11: a name cut with an ellipsis in an exhibit's data", () => {
    const fx = brandHealthLedger();
    fx.ledger.addDataset({
      kind: "Ranked",
      title: "Cut names",
      evidenceIds: ["E5"],
      formulaIds: ["xdom.under_the_radar"],
      payload: {
        columns: [{ key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" }],
        groups: [{ key: "brand", label: "Brands", rows: [{ key: "R9", rank: 1, label: "Lacrosse Footw…", sublabel: null, ref: "R9", tagRef: null, type: "brand", cells: [{ value: 0.9, reason: null }], flags: [], explain: [] }] }],
        caption: null,
      },
    });
    const ledger = fx.ledger.snapshot();
    const cut = ledger.datasets.find((d) => d.title === "Cut names")!;
    expect(audit((r) => r.exhibits.push({ ...r.exhibits[0]!, datasetId: cut.id }), ledger)).toEqual([expect.stringContaining("Name cut with an ellipsis")]);
  });

  it("§10: a noise tag in a tag list", () => {
    const tagged = { id: "D9", kind: "Bars", title: "Tags", evidenceIds: ["E1"], formulaIds: [], payload: { tags: [{ name: "Usa" }, { name: "Indie Rock" }] } } as unknown as DatasetEnvelope;
    const ledger = { ...base.ledger, datasets: [...base.ledger.datasets, tagged] };
    expect(audit((r) => r.exhibits.push({ ...r.exhibits[0]!, datasetId: "D9" }), ledger)).toEqual([expect.stringContaining('Noise tags in D9: "Usa"')]);
  });

  it("§2, §3, R1: a band that does not follow the score, or a score above a fired cap", () => {
    expect(audit((r) => (r.verdict.confidence = { ...r.verdict.confidence, score: 90, band: "LOW", breakdown: [] }))).toEqual([expect.stringContaining("does not match its score")]);
    const capped = audit((r) => {
      r.verdict.confidence = { score: 80, band: "HIGH", breakdown: [{ rule: "signal_mixed", label: "mixed", count: 1, points: 0, cap: CONFIDENCE_CAP.signal_mixed }] };
    });
    expect(capped).toEqual([expect.stringContaining("above the signal_mixed cap of 70")]);
  });

  it("R1, R2: a HIGH lead resting on a thin sample or a category-level read", () => {
    const ledger = honestyLedger();
    const out = audit((r) => {
      r.verdict.headline = "Brand Alpha is the most distinctive {{M13}}";
      r.verdict.confidence = { score: 90, band: "HIGH", breakdown: [] };
    }, ledger);
    expect(out).toEqual([expect.stringContaining("HIGH confidence over a thin or category-level lead: M13")]);
  });

  it("§4: numbers traced short of the total", () => {
    expect(audit((r) => (r.receipt.numbersTraced = { traced: 34, total: 39 }))).toEqual(["Numbers traced 34 of 39: every number shown must trace to its request."]);
  });

  it("§8: the disclosure not first, or not opening the thesis", () => {
    const disclosure: Limitation = { source: "flag", flag: "CONCEPT_NOT_IN_DATA", text: "'kelp tonic' is not in Qloo's data." };
    expect(audit((r) => r.limitations.push(disclosure))).toEqual([
      "The concept-not-in-data limitation is not the first limitation.",
      "The thesis does not open with the concept disclosure.",
    ]);
    expect(
      audit((r) => {
        r.limitations.unshift(disclosure);
        r.verdict.thesis = `${disclosure.text} ${r.verdict.thesis}`;
      }),
    ).toEqual([]);
  });

  it("§5: a ZIP-area comparison row not labelled approximate", () => {
    const fx = brandHealthLedger();
    fx.ledger.addMetric({ key: "econ.population", label: "Population of Example ZIP areas (whole ZIPs)", subjectRefs: ["nashville"], value: 1000, reason: null, display: "1,000", unit: "count", badge: "MEASURED", formulaId: "pct.within_call", evidenceIds: ["E1"], n: null, conf: null, comparator: null, window: null });
    expect(audit(() => {}, fx.ledger.snapshot())).toEqual([expect.stringContaining("ZIP-area row not labelled approximate")]);
  });

  it("R8: a Qloo entity id anywhere in the report, but never a run or request id", () => {
    // Built at runtime, so no UUID literal sits in the repo (D29, pnpm guard).
    const id = ["0f3c2a1b", "1234", "4abc", "9def", "0123456789ab"].join("-");
    expect(audit((r) => (r.verdict.thesis = `${r.verdict.thesis} ${id}`))).toEqual(["A Qloo entity id appears in the report."]);
    expect(audit((r) => (r.runId = id))).toEqual([]);
  });
});
