// Shared fixtures for the Part 11 CHECKER rules (V12, V13, V9 disclosure, V7 subject): the brand-health
// ledger plus metrics read through a look-alike tag, a category tag, a thin sample and an about-level
// difference, and a lift map with a hidden pocket. Invented names and values only (D29).
import type { DatasetEnvelope, ReportDraft, ReportDraftShape } from "@ct/contracts";
import { checkReport, type CheckReportInput } from "../../src/checker";
import type { LedgerSnapshot } from "../../src/ledger";
import { brandHealthLedger, brandHealthRegistry, plan, validDraft } from "../ledger/fixtures";

/**
 * M11 rests on the look-alike tag T1 "Kelp Snacks" (proxy), M12 on the category tag T2 "Sea Snacks"
 * (category), M13 on a thin sample, M14 is an about-level youth tilt; D4 is a lift map where Elm Park is a
 * hidden pocket and Harbor Row is already popular.
 */
export function honestyLedger(): LedgerSnapshot {
  const fx = brandHealthLedger();
  const base = { reason: null, n: 6, conf: null, window: null, badge: "DERIVED", comparator: null, unit: "pct" } as const;
  fx.ledger.addMetric({ ...base, key: "cnpt.fit", label: "Fit of Brand Beta to the concept", subjectRefs: ["R2", "T1"], value: 0.8, display: "0.80", formulaId: "pct.within_call", evidenceIds: ["E1"], conceptRead: "proxy" });
  fx.ledger.addMetric({ ...base, key: "cnpt.fit", label: "Fit of Brand Beta to the category", subjectRefs: ["R2", "T2"], value: 0.7, display: "0.70", formulaId: "pct.within_call", evidenceIds: ["E1"], conceptRead: "category" });
  fx.ledger.addMetric({ ...base, key: "subs.distinctiveness", label: "Distinctiveness in a small set", subjectRefs: ["R1"], value: 1, display: "1 of 3", unit: "rank", formulaId: "subs.distinctiveness", evidenceIds: ["E1"], thin: true });
  fx.ledger.addMetric({ ...base, key: "share.youth_tilt", label: "Youth tilt (small)", subjectRefs: ["R1"], value: 0.04, display: "+0.04 · about level", unit: "delta", formulaId: "share.youth_tilt", evidenceIds: ["E2"], level: "about_level" });
  const snapshot = fx.snapshot();
  const lift = {
    id: "D4",
    kind: "GeoLift",
    title: "Lift map",
    evidenceIds: ["E1"],
    formulaIds: [],
    payload: {
      metro: "nashville",
      neighbourhoods: [
        { id: "elm_park", name: "Elm Park", standing: "hidden" },
        { id: "harbor_row", name: "Harbor Row", standing: "popular" },
      ],
    },
  } as unknown as DatasetEnvelope;
  return { ...snapshot, datasets: [...snapshot.datasets, lift] };
}

/** The brand-health registry plus the concept tags behind M11 and M12. */
export function honestyRegistry() {
  const registry = brandHealthRegistry();
  registry.registerTag({ tagId: "urn:tag:genre:brand:kelp_snacks", name: "Kelp Snacks", type: "urn:tag:genre:brand", signalCapable: true, conceptMatch: "proxy" });
  registry.registerTag({ tagId: "urn:tag:genre:brand:sea_snacks", name: "Sea Snacks", type: "urn:tag:genre:brand", signalCapable: true, conceptMatch: "category" });
  return registry;
}

export const honestyLedgerSnapshot = honestyLedger();

export function checkHonest<D extends ReportDraftShape>(draft: D, extra: Partial<CheckReportInput<D>> = {}) {
  return checkReport({
    draft,
    plan: plan(),
    ledger: honestyLedgerSnapshot,
    qlooEnabled: true,
    registry: honestyRegistry(),
    concepts: ["kelp tonic"],
    ...extra,
  });
}

/** A valid draft with one change applied. */
export function editDraft(change: (d: ReportDraft) => void): ReportDraft {
  const d = validDraft();
  change(d);
  return d;
}
