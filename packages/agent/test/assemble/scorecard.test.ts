import { ScorecardPayload, type ReportDraft, type SubmitPlanInputShape } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { buildScorecard, NO_VERDICT_NOTE, recordScorecard, SCORECARD_TITLE, UNBACKED_VERDICT_NOTE } from "../../src/scorecard";
import { brandHealthLedger, emptyLedger, plan, validDraft } from "../ledger/fixtures";

const ledger = brandHealthLedger().snapshot();

describe("buildScorecard", () => {
  it("turns each planned prior into a row with the model's verdict and cited metrics", () => {
    const payload = buildScorecard(plan(), validDraft(), ledger);
    expect(ScorecardPayload.safeParse(payload).success).toBe(true);
    expect(payload.rows).toEqual([
      {
        hypothesisId: "H1",
        statement: "Brand Beta is the nearest peer of Brand Alpha.",
        expectation: "Brand Beta ranks first in the Brand Alpha row.",
        testTool: "peer_landscape",
        verdict: "CONFIRMED",
        metricIds: ["M1"],
        evidenceIds: ["E1"],
        note: "Brand Beta is the nearest peer {{M1}}.",
      },
      expect.objectContaining({ hypothesisId: "H2", verdict: "REFUTED", metricIds: ["M3"], evidenceIds: ["E2"] }),
    ]);
  });

  it("marks a prior without a verdict INCONCLUSIVE", () => {
    const draft = validDraft();
    draft.hypothesis_verdicts.pop();
    const row = buildScorecard(plan(), draft, ledger).rows[1];
    expect(row).toMatchObject({ hypothesisId: "H2", verdict: "INCONCLUSIVE", metricIds: [], evidenceIds: [], note: NO_VERDICT_NOTE });
  });

  it("downgrades a CONFIRMED or REFUTED verdict that no measured metric backs", () => {
    const draft: ReportDraft = validDraft();
    draft.hypothesis_verdicts[0] = { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M6", "M42"], note: "Not measured {{M6}}." };
    const row = buildScorecard(plan(), draft, ledger).rows[0];
    expect(row).toMatchObject({ verdict: "INCONCLUSIVE", metricIds: ["M6"], evidenceIds: ["E4"] });
    expect(row?.note).toBe(`${UNBACKED_VERDICT_NOTE} Not measured {{M6}}.`);
  });

  it("keeps an INCONCLUSIVE verdict as written and adds evidence cited in the note", () => {
    const draft = validDraft();
    draft.hypothesis_verdicts[1] = { hypothesis_id: "H2", verdict: "inconclusive", metric_ids: ["M3"], note: "Mixed {{M3}} [E5] [E9]." };
    expect(buildScorecard(plan(), draft, ledger).rows[1]).toMatchObject({
      verdict: "INCONCLUSIVE",
      evidenceIds: ["E2", "E5"],
      note: "Mixed {{M3}} [E5] [E9].",
    });
  });

  it("is empty without a plan and renumbers ill-formed hypothesis ids", () => {
    expect(buildScorecard(null, validDraft(), ledger).rows).toEqual([]);
    const loose: SubmitPlanInputShape = { ...plan(), hypotheses: plan().hypotheses.map((h, i) => ({ ...h, id: `hyp-${i}` })) };
    expect(buildScorecard(loose, null, ledger).rows.map((r) => r.hypothesisId)).toEqual(["H1", "H2"]);
  });
});

describe("recordScorecard", () => {
  it("adds the Scorecard as a dataset and streams it", () => {
    const fx = brandHealthLedger();
    const dataset = recordScorecard(fx.ledger, plan(), validDraft());
    expect(dataset).toMatchObject({ id: "D4", kind: "Scorecard", title: SCORECARD_TITLE, evidenceIds: ["E1", "E2"] });
    expect(fx.events.at(-1)).toMatchObject({ type: "dataset.ready", datasetId: "D4", kind: "Scorecard" });
  });

  it("records nothing without hypotheses", () => {
    const fx = emptyLedger();
    expect(recordScorecard(fx.ledger, null, null)).toBeNull();
    expect(fx.events).toEqual([]);
  });
});
