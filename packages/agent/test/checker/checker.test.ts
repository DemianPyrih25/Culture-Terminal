import type { EvidenceId, ReportDraft, ReportDraftShape, ValidationIssue, ValidationRule } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { checkReport, repairMessage, REWRITE_TIGHT_SHARE, trimVerdictTag, type CheckReportInput } from "../../src/checker";
import { datasetMeasuresDemographics, demographicEvidence, measuresDemographics } from "../../src/report/demographics";
import { brandHealthLedger, brandHealthRegistry, emptyLedger, plan, validDraft } from "../ledger/fixtures";

const ledger = brandHealthLedger().snapshot();
const registry = brandHealthRegistry();

/**
 * The brand-health ledger plus what a pair's share_of_taste and a block run record (invented values):
 * M11 Brand Alpha's percentile in the 35–44 context, M12 its youth tilt behind a GENERATIONAL_SPLIT
 * finding (F2), M13 a block NEW-tag count, and D4 the pair's who-wins-where split, drawn from the age call E2.
 */
function extendedLedger() {
  const fx = brandHealthLedger();
  const base = { reason: null, n: 2, conf: null, window: null, badge: "DERIVED" } as const;
  fx.ledger.addMetric({ ...base, key: "share.pct", label: "Share-of-Taste percentile of Brand Alpha, age 35–44", subjectRefs: ["R1", "35_to_44"], value: 0, display: "0.00 · 2 of 2", unit: "pct", formulaId: "share.pct", evidenceIds: ["E2"], comparator: "WITHIN_CALL" });
  fx.ledger.addMetric({ ...base, key: "share.youth_tilt", label: "youth tilt of Brand Alpha (≤24 minus 55+)", subjectRefs: ["R1", "24_and_younger", "55_and_older"], value: 1, display: "+1.00 · rank 1 of 2", unit: "delta", formulaId: "share.youth_tilt", evidenceIds: ["E2"], comparator: "PEERS" });
  fx.ledger.addMetric({ ...base, key: "block.new_tag", label: "NEW music tags in Elm Park", subjectRefs: ["elm_park", "nashville"], value: 12, display: "12 of 20 in the area top 20", unit: "count", formulaId: "block.new_tag", evidenceIds: ["E5"], comparator: "CITY", n: 20 });
  fx.ledger.addFinding({ kind: "GENERATIONAL_SPLIT", severity: "medium", text: "Brand Alpha skews clearly younger than its peer set.", metricIds: ["M12"], suggestion: null });
  const pair = (key: string, label: string, first: number) => ({
    key,
    label,
    tagRef: null,
    values: [
      { value: first, reason: null },
      { value: 1 - first, reason: null },
    ],
    isNew: false,
    ranks: null,
  });
  fx.ledger.addDataset({
    kind: "Bars",
    title: "Who wins where · Brand Alpha vs Brand Beta",
    evidenceIds: ["E2"],
    formulaIds: ["share.pair_split", "share.pct"],
    payload: {
      mode: "butterfly",
      display: "split",
      baseline: 0.5,
      evenBand: 0.02,
      comparator: "WITHIN_CALL",
      valueLabel: "Share of taste within the pair: Brand Alpha vs Brand Beta",
      unit: "ratio",
      series: [
        { key: "R1", label: "Brand Alpha", ref: "R1", group: null },
        { key: "R2", label: "Brand Beta", ref: "R2", group: null },
      ],
      groups: [{ key: "age", label: "Age", family: null, bars: [pair("25_to_29", "25–29", 0.6), pair("55_and_older", "55+", 0.4)] }],
      method: null,
      domain: null,
      caption: null,
    },
  });
  return fx.snapshot();
}

function check<D extends ReportDraftShape>(draft: D, extra: Partial<CheckReportInput<D>> = {}) {
  return checkReport({ draft, plan: plan(), ledger, qlooEnabled: true, registry, ...extra });
}

/** A valid draft with one change applied. */
function edit(change: (d: ReportDraft) => void): ReportDraft {
  const d = validDraft();
  change(d);
  return d;
}

const rules = (issues: readonly ValidationIssue[]): ValidationRule[] => [...new Set(issues.map((i) => i.rule))];
const of = (issues: readonly ValidationIssue[], rule: ValidationRule) => issues.filter((i) => i.rule === rule);

describe("checkReport: a clean draft", () => {
  it("passes every rule, traces every number and leaves the draft as written", () => {
    const draft = validDraft();
    const result = check(draft);
    expect(result.issues).toEqual([]);
    expect(result.reject).toBe(false);
    expect(result.forcedSignal).toBeUndefined();
    expect(result.adviceTerms).toBe(0);
    expect(result.patchedDraft).toEqual(draft);
    // headline 1, thesis 3, notes 2, arguments 4, captions 1, bear case 1.
    expect(result.numbersTraced).toEqual({ traced: 12, total: 12 });
  });

  it("never mutates the input draft", () => {
    const draft = edit((d) => {
      d.signal = "strong";
      d.arguments[2]!.qloo_fact = "Momentum was {{M5}} [E3].";
    });
    const before = structuredClone(draft);
    check(draft, { qlooEnabled: false });
    expect(draft).toEqual(before);
  });
});

describe("V1: referenced ids exist", () => {
  it("rejects unknown metrics, evidence, datasets, hypotheses and arguments", () => {
    const draft = edit((d) => {
      d.arguments[0]!.metric_ids = ["M1", "M42"];
      d.arguments[1]!.evidence_ids = ["E2", "E8"];
      d.exhibits[0]!.dataset_id = "D9";
      d.hypothesis_verdicts[1]!.hypothesis_id = "H7";
      d.bear_case[0]!.metric_ids = ["M77"];
      d.recommendations[0]!.argument_ids = ["A1", "A9"];
    });
    const v1 = of(check(draft).issues, "V1");
    expect(v1.map((i) => i.path)).toEqual([
      "hypothesis_verdicts[1].hypothesis_id",
      "arguments[0].metric_ids",
      "arguments[1].evidence_ids",
      "exhibits[0].dataset_id",
      "bear_case[0].metric_ids",
      "recommendations[0].argument_ids",
    ]);
    expect(v1.flatMap((i) => i.subjects)).toEqual(["H7", "M42", "E8", "D9", "M77", "A9"]);
    expect(v1.every((i) => i.action === "reject")).toBe(true);
  });

  it("reports an ill-formed id once, as a format issue", () => {
    const draft: ReportDraftShape = validDraft();
    draft.arguments[0]!.metric_ids = ["m1", "M1"];
    const v1 = of(check(draft).issues, "V1");
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatchObject({ path: "arguments[0].metric_ids[0]", subjects: ["m1"], action: "reject" });
  });

  it("rejects duplicate argument ids and duplicate verdicts", () => {
    const draft = edit((d) => {
      d.arguments[1]!.id = "A1";
      d.hypothesis_verdicts[1]!.hypothesis_id = "H1";
    });
    const messages = of(check(draft).issues, "V1").map((i) => i.message);
    expect(messages.some((m) => m.includes("used by another argument"))).toBe(true);
    expect(messages.some((m) => m.includes("more than one verdict"))).toBe(true);
  });

  it("treats every verdict as unknown when there is no plan", () => {
    const v1 = of(check(validDraft(), { plan: null }).issues, "V1");
    expect(v1.flatMap((i) => i.subjects)).toEqual(["H1", "H2"]);
  });
});

describe("V2: tokens resolve", () => {
  it("rejects metric and evidence tokens that do not resolve", () => {
    const draft = edit((d) => (d.thesis = "Brand Alpha leads {{M1}} [E1] but trails {{M44}} [E9]."));
    const v2 = of(check(draft).issues, "V2");
    expect(v2).toHaveLength(1);
    expect(v2[0]).toMatchObject({ path: "thesis", subjects: ["M44", "E9"], action: "reject" });
  });

  it("rejects malformed tokens instead of counting their digits as numbers", () => {
    const draft = edit((d) => (d.arguments[0]!.qloo_fact = "Similarity is {{ M1 }} [E1, E2] and {M12}."));
    const result = check(draft);
    expect(of(result.issues, "V2")[0]?.subjects).toEqual(["{{ M1 }}", "[E1, E2]", "{M12}"]);
    expect(of(result.issues, "V3")).toEqual([]);
  });

  it("rejects any token in a next move, resolvable or not: the child run has other ids", () => {
    const draft = edit((d) => {
      d.next_moves[0]!.label = "Alpha at {{M4}}";
      d.next_moves[1]!.question = "Does the lead [E2] hold over {{WINDOW}} and {M9}?";
    });
    const v2 = of(check(draft).issues, "V2");
    expect(v2).toEqual([
      expect.objectContaining({ action: "reject", path: "next_moves[0].label", subjects: ["{{M4}}"] }),
      expect.objectContaining({ action: "reject", path: "next_moves[1].question", subjects: ["[E2]", "{{WINDOW}}", "{M9}"] }),
    ]);
    expect(v2[0]?.message).toContain("write it in plain words without tokens");
  });
});

describe("V3: numbers outside tokens", () => {
  it("rejects a single bare number on the first attempt and warns on the repair", () => {
    const draft = edit((d) => (d.thesis = "Brand Alpha sits next to Brand Beta {{M1}} [E1], up 45%."));
    const first = check(draft);
    expect(of(first.issues, "V3")).toEqual([
      {
        rule: "V3",
        action: "reject",
        message: 'thesis: numbers typed outside tokens: "45%"; cite every number as a {{M#}} token.',
        path: "thesis",
        subjects: ["45%"],
      },
    ]);
    expect(first.reject).toBe(true);
    const second = check(draft, { attempt: 2 });
    expect(of(second.issues, "V3")).toEqual([expect.objectContaining({ action: "warn", path: "thesis", subjects: ["45%"] })]);
    expect(second.reject).toBe(false);
  });

  it("rejects a rank or count spelled out in prose like its digits, and names a spelled-out copy of a token", () => {
    const draft = edit((d) => (d.thesis = `${d.thesis} It ranks eleventh of twelve.`));
    expect(of(check(draft).issues, "V3")).toEqual([expect.objectContaining({ action: "reject", path: "thesis", subjects: ["eleventh", "twelve"] })]);
    expect(check(draft, { attempt: 2 }).reject).toBe(false);
    const copy = edit((d) => (d.arguments[1]!.qloo_fact = "Twelve of twenty music tags are new vs the city {{M13}} [E5]."));
    expect(of(check(copy, { ledger: extendedLedger() }).issues, "V3")[0]?.message).toBe(
      'arguments[1].qloo_fact: numbers typed outside tokens: "Twelve", "twenty"; "Twelve", "twenty" repeat what {{M13}} already ' +
        'prints ("12 of 20 in the area top 20"): delete the typed copy.',
    );
  });

  it("rejects bare numbers in every field they appear in", () => {
    const draft = edit((d) => {
      d.thesis = "Brand Alpha scores 0.62 against Brand Beta {{M1}} [E1].";
      d.arguments[1]!.our_read = "Roughly 1,200 venues and 12 metros back it.";
    });
    const result = check(draft);
    const v3 = of(result.issues, "V3");
    expect(v3.map((i) => i.subjects)).toEqual([["0.62"], ["1,200", "12"]]);
    expect(v3.every((i) => i.action === "reject")).toBe(true);
    expect(result.reject).toBe(true);
  });

  it("leaves numbers in next moves alone: they are parameters of a new run", () => {
    const draft = edit((d) => (d.next_moves[1]!.question = "Which of the 12 metros favour Brand Alpha among 25 peers and 40 venues?"));
    const result = check(draft);
    expect(result.issues).toEqual([]);
    expect(result.numbersTraced).toEqual(check(validDraft()).numbersTraced);
  });

  it("allows small integers, years, age labels and digits inside registered names", () => {
    const draft = edit((d) => {
      d.arguments[1]!.our_read =
        "Fans aged 25–29 and 55+ lead, as in 2024; three of 8 metros sit near Studio 54 Lounge since 2025-04-01.";
    });
    expect(of(check(draft).issues, "V3")).toEqual([]);
    expect(of(check(draft, { registry: undefined }).issues, "V3")[0]?.subjects).toEqual(["54"]);
  });

  it("allows Nashville ZIP areas named as ZIPs", () => {
    const draft = edit((d) => (d.arguments[1]!.our_read = "ZIP 37206 leads, ZIP code 37216 follows and the 37207 ZIP trails."));
    expect(of(check(draft).issues, "V3")).toEqual([]);
  });

  it("allows digits inside the area names of the question's metro only", () => {
    const draft = edit((d) => (d.arguments[1]!.our_read = "MLK 183 leads and 37206 follows."));
    expect(of(check(draft, { areas: ["MLK-183", "ZIP 37206 (East Nashville)"] }).issues, "V3")).toEqual([]);
    expect(of(check(draft).issues, "V3")[0]?.subjects).toEqual(["183", "37206"]);
  });

  it("never allows a list size typed beside its token: the token prints it, and the count next to it is Qloo's", () => {
    // M13 shows "12 of 20 in the area top 20": 20 is the code's list size, 12 and the first 20 come from Qloo.
    const ledger = extendedLedger();
    for (const text of ["No new music tags appear in the area top 20 {{M13}} [E5].", "12 of 20 music tags are new vs the city {{M13}} [E5]."]) {
      const result = check(edit((d) => (d.arguments[1]!.qloo_fact = text)), { ledger });
      expect(of(result.issues, "V3"), text).toEqual([expect.objectContaining({ action: "reject", path: "arguments[1].qloo_fact" })]);
    }
  });

  it("names a number the field's own token already prints as a copy to delete", () => {
    const draft = edit((d) => (d.arguments[1]!.qloo_fact = "12 of 20 music tags are new vs the city {{M13}} [E5], a 1.5x lead."));
    const v3 = of(check(draft, { ledger: extendedLedger() }).issues, "V3");
    expect(v3.map((i) => i.subjects)).toEqual([["12", "20", "1.5"]]);
    expect(v3[0]?.message).toBe(
      'arguments[1].qloo_fact: numbers typed outside tokens: "12", "20", "1.5"; "12", "20" repeat what {{M13}} already ' +
        'prints ("12 of 20 in the area top 20"): delete the typed copy; cite every other number as a {{M#}} token.',
    );
  });

  it("names the buckets an age range that merges them spans, once per range", () => {
    // A2 cites the youth tilt M3, so V10 lets the ages stand; only the merged ranges are at issue.
    const draft = edit((d) => (d.arguments[1]!.our_read = "Fans aged 30-44 carry the brand; 18–24 trails, as 30-44 leads."));
    const result = check(draft);
    expect(result.issues).toEqual([
      expect.objectContaining({ rule: "V3", action: "reject", path: "arguments[1].our_read", subjects: ["30-44", "18–24", "30-44"] }),
    ]);
    const message =
      'arguments[1].our_read: numbers typed outside tokens: "30-44", "18–24"; "30-44" is not a Qloo age bucket: name the ' +
      "buckets it spans (30–34 and 35–44), or cite the {{M#}} token of the metric that measures them; \"18–24\" is not a " +
      "Qloo age bucket: name the bucket it spans (≤24), or cite the {{M#}} token of the metric that measures it.";
    expect(result.issues[0]?.message).toBe(message);
    expect(repairMessage(result.issues)).toContain(`- V3 ${message}`);
  });
});

describe("V4: phrase linter", () => {
  const banned: [string, boolean][] = [
    ["We should buy the dip.", true],
    ["Investors should invest now.", true],
    ["No price target is implied.", true],
    ["The brand looks undervalued.", true],
    ["It is underpriced for its taste reach.", true],
    ["Brand Beta is poaching fans.", false],
    ["Growth is guaranteed.", false],
    ["It will definitely grow.", false],
    ["Fully 45% of fans prefer it.", false],
    ["Nearly {{M3}} of residents agree.", false],
    ["Youth taste causes the lift.", false],
    ["Younger fans cause the lift.", false],
    ["The gap was caused by the collab.", false],
    ["Youth taste is the main cause of the lift.", false],
    ["The collab drives sales.", false],
    ["The brand could collapse.", false],
    ["This person loves it.", false],
    ["Residents who visit love it.", false],
  ];

  it.each(banned)("rejects %j", (sentence, advice) => {
    const draft = edit((d) => (d.arguments[0]!.our_read = sentence));
    const result = check(draft);
    const v4 = of(result.issues, "V4");
    expect(v4).toHaveLength(1);
    expect(v4[0]).toMatchObject({ action: "reject", path: "arguments[0].our_read" });
    expect(result.adviceTerms).toBe(advice ? 1 : 0);
  });

  it("does not flag look-alike words", () => {
    const draft = edit((d) => (d.arguments[0]!.our_read = "Because the link is not causal, fans of both brands overlap."));
    expect(of(check(draft).issues, "V4")).toEqual([]);
  });

  it("does not flag the noun cause in a hedge", () => {
    const draft = edit((d) => {
      d.bear_case[0]!.text = "The root cause of the youth tilt {{M3}} is unclear.";
      d.arguments[0]!.our_read = "There is cause for caution in reading the overlap.";
      d.arguments[1]!.our_read = "The root cause remains open; the cause is not in the data.";
    });
    expect(of(check(draft).issues, "V4")).toEqual([]);
  });

  it("reports the verb as written, without the words around it", () => {
    const draft = edit((d) => (d.arguments[0]!.our_read = "Younger fans cause the lift."));
    expect(of(check(draft).issues, "V4")[0]?.subjects).toEqual(["cause"]);
  });

  it("lints next moves too: they show on the note as chips", () => {
    const draft = edit((d) => (d.next_moves[0]!.question = "Should we invest in Brand Alpha now?"));
    const result = check(draft);
    expect(of(result.issues, "V4")).toEqual([
      expect.objectContaining({ action: "reject", path: "next_moves[0].question", subjects: ["invest in"] }),
    ]);
    expect(result.adviceTerms).toBe(1);
  });
});

describe("V5: citation chains", () => {
  it("rejects arguments and verdicts without metrics and recommendations without arguments", () => {
    const draft = edit((d) => {
      d.arguments[1]!.metric_ids = [];
      d.arguments[1]!.qloo_fact = "Youth taste leads [E2].";
      d.hypothesis_verdicts[0]!.metric_ids = [];
      d.hypothesis_verdicts[0]!.note = "Brand Beta is nearest.";
      d.recommendations[0]!.argument_ids = [];
    });
    const v5 = of(check(draft).issues, "V5");
    expect(v5.map((i) => i.path)).toEqual([
      "arguments[1].metric_ids",
      "recommendations[0].argument_ids",
      "hypothesis_verdicts[0].metric_ids",
    ]);
  });

  it("counts a metric token in the prose as a citation", () => {
    const draft = edit((d) => (d.arguments[0]!.metric_ids = []));
    expect(of(check(draft).issues, "V5")).toEqual([]);
  });

  it("rejects planned hypotheses left without a verdict", () => {
    const draft = edit((d) => d.hypothesis_verdicts.pop());
    expect(of(check(draft).issues, "V5")).toEqual([
      expect.objectContaining({ path: "hypothesis_verdicts", subjects: ["H2"], action: "reject" }),
    ]);
  });
});

describe("V6: cross-call raw affinity", () => {
  const v6 = (change: (d: ReportDraft) => void) => of(check(edit(change)).issues, "V6");

  it("rejects an argument comparing raw affinities from different Qloo calls", () => {
    expect(v6((d) => (d.arguments[0]!.our_read = "Artist Nova {{M7}} beats Artist Lumen {{M8}}."))).toEqual([
      expect.objectContaining({ action: "reject", path: "arguments[0]", subjects: ["M7", "M8"] }),
    ]);
  });

  it("judges the whole argument, however the comparison is split", () => {
    const sentences = v6((d) => (d.arguments[0]!.our_read = "Artist Nova scores {{M7}}. Artist Lumen scores {{M8}}."));
    const parts = v6((d) => {
      d.arguments[0]!.qloo_fact = "Artist Nova scores {{M7}} [E1].";
      d.arguments[0]!.our_read = "Artist Lumen trails at {{M8}}.";
    });
    const listed = v6((d) => {
      d.arguments[0]!.our_read = "Artist Nova trails Artist Lumen.";
      d.arguments[0]!.metric_ids = ["M1", "M7", "M8"];
    });
    for (const issues of [sentences, parts, listed]) {
      expect(issues).toEqual([expect.objectContaining({ path: "arguments[0]", subjects: ["M7", "M8"] })]);
    }
  });

  it("judges other claims per field", () => {
    expect(v6((d) => (d.thesis = "Artist Nova scores {{M7}}. Artist Lumen scores {{M8}}."))).toEqual([
      expect.objectContaining({ path: "thesis", subjects: ["M7", "M8"] }),
    ]);
  });

  it("allows raw affinities from the same call, or in different claims", () => {
    expect(v6((d) => (d.arguments[0]!.our_read = "Artist Nova {{M7}} beats Artist Vega {{M9}}."))).toEqual([]);
    const apart = v6((d) => {
      d.arguments[0]!.our_read = "Artist Nova scores {{M7}}.";
      d.arguments[1]!.our_read = "Artist Lumen scores {{M8}}.";
    });
    expect(apart).toEqual([]);
  });
});

describe("V7: forced signal", () => {
  it("forces insufficient_evidence with fewer than three ok bundles", () => {
    const thin = emptyLedger();
    const result = checkReport({ draft: validDraft(), plan: plan(), ledger: thin.snapshot(), qlooEnabled: true });
    expect(result.forcedSignal).toBe("insufficient_evidence");
    expect(result.patchedDraft.signal).toBe("insufficient_evidence");
    expect(of(result.issues, "V7")).toEqual([expect.objectContaining({ action: "forced", subjects: ["mixed"] })]);
  });

  it("drops the verdict tag with the signal it named, and judges it no further", () => {
    const draft = edit((d) => (d.verdict_tag = "Ranks 3rd of 8 brands"));
    const result = check(draft, { qlooEnabled: false });
    expect(result.patchedDraft.verdict_tag).toBe("");
    expect(of(result.issues, "V7")[0]?.message).toMatch(/; verdict_tag "Ranks 3rd of 8 brands" dropped with it\.$/);
    expect(result.issues.filter((i) => i.path === "verdict_tag")).toEqual([]);
    expect(result.reject).toBe(false);
  });

  it("forces insufficient_evidence when Qloo is disabled, and leaves an honest signal alone", () => {
    expect(check(validDraft(), { qlooEnabled: false }).forcedSignal).toBe("insufficient_evidence");
    const honest = edit((d) => (d.signal = "insufficient_evidence"));
    const result = check(honest, { qlooEnabled: false });
    expect(result.forcedSignal).toBeUndefined();
    expect(of(result.issues, "V7")).toEqual([]);
  });
});

describe("V8: STALE metrics carry the window", () => {
  it("injects the window token right after a STALE token in an argument", () => {
    const draft = edit((d) => (d.arguments[2]!.qloo_fact = "Momentum was {{M5}} [E3]."));
    const result = check(draft);
    expect(result.patchedDraft.arguments[2]?.qloo_fact).toBe("Momentum was {{M5}} ({{WINDOW}}) [E3].");
    expect(of(result.issues, "V8")).toEqual([
      expect.objectContaining({ action: "injected", path: "arguments[2].qloo_fact", subjects: ["M5"] }),
    ]);
    expect(result.reject).toBe(false);
  });

  it("appends the window when the STALE metric is cited only in metric_ids", () => {
    const draft = edit((d) => (d.arguments[2]!.qloo_fact = "Momentum is historical [E3]."));
    expect(check(draft).patchedDraft.arguments[2]?.qloo_fact).toBe(
      "Momentum is historical [E3]. (trending window {{WINDOW}})",
    );
  });

  it("accepts a window anywhere in the argument and patches other claims", () => {
    const covered = edit((d) => {
      d.arguments[2]!.qloo_fact = "Momentum was {{M5}} [E3].";
      d.arguments[2]!.our_read = "Read it as {{WINDOW}} only.";
    });
    expect(of(check(covered).issues, "V8")).toEqual([]);

    const thesis = edit((d) => (d.thesis = "Brand Alpha was {{M5}} and sits next to Brand Beta {{M1}}."));
    const result = check(thesis);
    expect(result.patchedDraft.thesis).toBe("Brand Alpha was {{M5}} ({{WINDOW}}) and sits next to Brand Beta {{M1}}.");
    expect(of(result.issues, "V8").map((i) => i.path)).toEqual(["thesis"]);
  });

  it("patches claims only, never titles or next moves", () => {
    const draft = edit((d) => {
      d.exhibits[0]!.title = "Momentum {{M5}}";
      d.next_moves[0]!.question = "Is Brand Alpha still {{M5}}?";
    });
    const result = check(draft);
    expect(result.patchedDraft.exhibits[0]?.title).toBe("Momentum {{M5}}");
    expect(result.patchedDraft.next_moves[0]?.question).toBe("Is Brand Alpha still {{M5}}?");
    expect(of(result.issues, "V8")).toEqual([]);
  });
});

describe("V9: lengths and counts", () => {
  it("rejects over-long text and wrong counts with the actual sizes", () => {
    const draft = edit((d) => {
      d.headline = `Brand Alpha ${"x".repeat(130)}`;
      d.arguments = d.arguments.slice(0, 2);
      d.bear_case = [];
      d.thesis = "";
    });
    const v9 = of(check(draft).issues, "V9");
    expect(v9.map((i) => i.path)).toEqual(["headline", "thesis", "arguments", "bear_case"]);
    expect(v9[0]?.message).toBe("headline has 142 characters; at most 120 are allowed.");
    expect(v9[1]?.message).toBe("thesis is empty.");
    expect(v9[2]?.message).toBe("arguments has 2 items; at least 3 are required.");
    expect(v9.every((i) => i.action === "reject")).toBe(true);
  });

  it("rejects more than five arguments", () => {
    const draft = edit((d) => {
      const extra = d.arguments[0]!;
      d.arguments.push(...[4, 5, 6].map((n) => ({ ...extra, id: `A${n}` as const })));
    });
    expect(of(check(draft).issues, "V9")[0]?.message).toBe("arguments has 6 items; at most 5 are allowed.");
  });
});

describe("V9: the verdict tag", () => {
  it("rejects a tag that breaks its rule once, naming each problem", () => {
    const draft = edit((d) => (d.verdict_tag = "Ranks 3rd of 8 brands in its category"));
    const result = check(draft);
    expect(result.reject).toBe(true);
    expect(of(result.issues, "V9").map((i) => [i.action, i.path, i.message])).toEqual([
      ["reject", "verdict_tag", "verdict_tag has 8 words, not 2 to 5."],
      ["reject", "verdict_tag", "verdict_tag has 37 characters, more than 32."],
      [
        "reject",
        "verdict_tag",
        'verdict_tag contains digits ("3rd", "8"): a tag names the finding in words ("Clear lead", "Taste island"); ' +
          "the headline carries ranks, counts and ages with their {{M#}} tokens.",
      ],
    ]);
    expect(of(check(edit((d) => (d.verdict_tag = ""))).issues, "V9")).toEqual([
      expect.objectContaining({ action: "reject", message: "verdict_tag is empty." }),
    ]);
  });

  it("names the digits of an age range in the tag, as the repair turn shows them", () => {
    // The shape of a live tag that merged two age buckets.
    const result = check(edit((d) => (d.verdict_tag = "Female, 30-44 skew")));
    const v9 = of(result.issues, "V9");
    expect(v9).toEqual([expect.objectContaining({ action: "reject", path: "verdict_tag", subjects: [] })]);
    expect(v9[0]?.message).toMatch(/^verdict_tag contains digits \("30-44"\): a tag names the finding in words/);
    expect(repairMessage(result.issues)).toContain('- V9 verdict_tag contains digits ("30-44")');
  });

  it("rejects a number spelled out in the tag as it rejects digits, on its own V9 line", () => {
    const result = check(edit((d) => (d.verdict_tag = "Last of twelve")));
    expect(result.reject).toBe(true);
    expect(result.issues).toEqual([
      {
        rule: "V9",
        action: "reject",
        message:
          'verdict_tag contains a number ("twelve"): a tag names the finding in words ("Clear lead", "Taste island"); ' +
          "the headline carries ranks, counts and ages with their {{M#}} tokens.",
        path: "verdict_tag",
        subjects: ["twelve"],
      },
    ]);
    // Number words up to ten pass, as numbers up to ten do in prose (V3); only the tag's digits rule reads every digit.
    expect(check(edit((d) => (d.verdict_tag = "Third of eight brands"))).issues).toEqual([]);
  });

  it("drops or trims a tag with a number spelled out on the last attempt, never keeping the number", () => {
    const last = check(edit((d) => (d.verdict_tag = "Last of twelve")), { attempt: 2 });
    expect(last.patchedDraft.verdict_tag).toBe("");
    expect(last.issues).toEqual([
      expect.objectContaining({
        rule: "V9",
        action: "forced",
        message: 'verdict_tag "Last of twelve" contains a number: dropped; the brief prints the signal instead.',
      }),
    ]);
    const qualified = check(edit((d) => (d.verdict_tag = "Clear lead, in eleven metros")), { attempt: 2 });
    expect(qualified.patchedDraft.verdict_tag).toBe("Clear lead");
    expect(trimVerdictTag("Eleventh of twelve, behind rivals")).toBe("");
  });

  it("rejects a token in the tag, which the brief would print raw", () => {
    const result = check(edit((d) => (d.verdict_tag = "Taste island {{WINDOW}}")));
    expect(result.reject).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({ rule: "V9", action: "reject", path: "verdict_tag", message: "verdict_tag contains tokens." }),
    ]);
  });

  it("lints the tag for banned phrases like any label", () => {
    const result = check(edit((d) => (d.verdict_tag = "Undervalued taste island")));
    expect(of(result.issues, "V4")).toEqual([
      expect.objectContaining({ action: "reject", path: "verdict_tag", subjects: ["Undervalued"] }),
    ]);
    expect(result.adviceTerms).toBe(1);
  });

  it("cuts it to its first clause on the last attempt instead: forced, never a warning", () => {
    const draft = edit((d) => (d.verdict_tag = "Taste island, nearest to the apparel brand of 2025"));
    const result = check(draft, { attempt: 2 });
    expect(result.reject).toBe(false);
    expect(result.patchedDraft.verdict_tag).toBe("Taste island");
    expect(result.issues).toEqual([
      {
        rule: "V9",
        action: "forced",
        message:
          'verdict_tag "Taste island, nearest to the apparel brand of 2025" has 9 words, not 2 to 5 and has 50 characters, ' +
          'more than 32 and contains digits: trimmed to "Taste island".',
        path: "verdict_tag",
        subjects: ["Taste island, nearest to the apparel brand of 2025"],
      },
    ]);
  });

  it("drops it on the last attempt when nothing usable is left, or when it uses a banned phrase", () => {
    const empty = check(edit((d) => (d.verdict_tag = "Top {{M1}}")), { attempt: 2 });
    expect(empty.patchedDraft.verdict_tag).toBe("");
    expect(empty.issues).toEqual([
      expect.objectContaining({ rule: "V9", action: "forced", message: expect.stringMatching(/dropped; the brief prints the signal instead\.$/) }),
    ]);
    const advice = check(edit((d) => (d.verdict_tag = "Undervalued taste island")), { attempt: 2 });
    expect(advice.patchedDraft.verdict_tag).toBe("");
    expect(advice.issues).toEqual([expect.objectContaining({ rule: "V4", action: "forced", path: "verdict_tag", subjects: ["Undervalued"] })]);
    expect(advice.adviceTerms).toBe(0);
  });

  it("never splices a tag on the last attempt: one that would lose its meaning is dropped", () => {
    for (const tag of ["No 1 choice for Brand Beta", "Top 3 pick in Austin", "Lead fades after 2027", "Clear lead over rivals is unlikely"]) {
      const result = check(edit((d) => (d.verdict_tag = tag)), { attempt: 2 });
      expect(result.patchedDraft.verdict_tag, tag).toBe("");
      expect(result.issues, tag).toEqual([expect.objectContaining({ rule: "V9", action: "forced", path: "verdict_tag" })]);
    }
    // Without its digit "Invest 2 in craft brands" would read "Invest in": no splice, so no banned phrase either.
    const advice = check(edit((d) => (d.verdict_tag = "Invest 2 in craft brands")), { attempt: 2 });
    expect(advice.patchedDraft.verdict_tag).toBe("");
    expect(advice.issues.map((i) => [i.rule, i.action])).toEqual([["V9", "forced"]]);
  });

  it("keeps a tag that keeps its rule on the last attempt", () => {
    const result = check(validDraft(), { attempt: 2 });
    expect(result.issues).toEqual([]);
    expect(result.patchedDraft.verdict_tag).toBe(validDraft().verdict_tag);
  });

  it("trimVerdictTag: keeps the first clause when it keeps the rule, else nothing", () => {
    expect(trimVerdictTag("Taste island")).toBe("Taste island");
    expect(trimVerdictTag("  Clear   lead  ")).toBe("Clear lead");
    expect(trimVerdictTag("Taste island, nearest to craft beer")).toBe("Taste island");
    expect(trimVerdictTag("Taste island; nearest to craft beer")).toBe("Taste island");
    expect(trimVerdictTag("Taste island - nearest to apparel")).toBe("Taste island");
    expect(trimVerdictTag(`Clear lead${String.fromCharCode(0x2014)}for now`)).toBe("Clear lead");
    expect(trimVerdictTag("Taste island (apart from {{M2}})")).toBe("Taste island");
    // A clause that breaks the rule is dropped whole: never cut at five words or spliced around a number.
    expect(trimVerdictTag("No 1 choice for Brand Beta")).toBe("");
    expect(trimVerdictTag("Top 3 pick in Austin")).toBe("");
    expect(trimVerdictTag("Ranks 3rd of 8 brands")).toBe("");
    expect(trimVerdictTag("Lead fades after 2027")).toBe("");
    expect(trimVerdictTag("Clear lead over rivals is unlikely")).toBe("");
    expect(trimVerdictTag("Clear lead in every one of the metros")).toBe("");
    expect(trimVerdictTag("Taste island {{WINDOW}}")).toBe("");
    expect(trimVerdictTag("Invest 2 in craft brands")).toBe("");
    expect(trimVerdictTag("Undervalued gem, apart from rivals")).toBe("");
    expect(trimVerdictTag("Close to, but behind, rivals")).toBe("");
    expect(trimVerdictTag("Island, apart from rivals")).toBe("");
    expect(trimVerdictTag("Supercalifragilisticexpialidocious-adjacent niche")).toBe("");
  });

  describe("V10: judged with the headline", () => {
    // M3 is a youth tilt with a value; M6 an age index that came back not measured; M1 measures neither.
    it("rejects a demographic tag once when the headline cites no metric that measures it", () => {
      const result = check(edit((d) => (d.verdict_tag = "Gen Z favourite")));
      expect(result.reject).toBe(true);
      expect(of(result.issues, "V10")).toEqual([
        expect.objectContaining({ action: "reject", path: "verdict_tag", subjects: ["Gen Z"] }),
      ]);
      const message = of(result.issues, "V10")[0]?.message ?? "";
      expect(message).toContain("no metric the headline cites measures it");
      expect(repairMessage(result.issues)).toContain('- V10 verdict_tag: "Gen Z" claims an audience');
      const unmeasured = check(
        edit((d) => {
          d.verdict_tag = "Young female crowd";
          d.headline = "Brand Alpha's audience age was looked up {{M6}} [E4]";
        }),
      );
      expect(of(unmeasured.issues, "V10")).toEqual([expect.objectContaining({ path: "verdict_tag", subjects: ["Young", "female"] })]);
    });

    it("passes it when the headline measures the demographic, and never judges a tag without one", () => {
      const measured = edit((d) => {
        d.verdict_tag = "Skews young";
        d.headline = "Brand Alpha skews young {{M3}}";
      });
      expect(of(check(measured).issues, "V10")).toEqual([]);
      expect(of(check(measured, { attempt: 2 }).issues, "V10")).toEqual([]);
      expect(check(measured, { attempt: 2 }).patchedDraft.verdict_tag).toBe("Skews young");
      expect(of(check(edit((d) => (d.verdict_tag = "Young brands lead"))).issues, "V10")).toEqual([]);
    });

    it("drops it on the last attempt: forced, never a warning", () => {
      const result = check(edit((d) => (d.verdict_tag = "Gen Z favourite")), { attempt: 2 });
      expect(result.reject).toBe(false);
      expect(result.patchedDraft.verdict_tag).toBe("");
      expect(result.issues).toEqual([
        {
          rule: "V10",
          action: "forced",
          message:
            'verdict_tag "Gen Z favourite" dropped: "Gen Z" claims an audience\'s age, gender or generation that no metric ' +
            "the headline cites measures; the brief prints the signal instead.",
          path: "verdict_tag",
          subjects: ["Gen Z"],
        },
      ]);
    });
  });
});

describe("V10: audience demographics need a metric that measures them", () => {
  const v10 = (change: (d: ReportDraft) => void, extra: Partial<CheckReportInput<ReportDraft>> = {}) =>
    of(check(edit(change), extra).issues, "V10");
  // The shape of a live headline that named demographics no call measured.
  const unmeasured = "Brand Alpha's taste neighbours are young-male lifestyle brands {{M1}}";

  it("rejects an unmeasured demographic headline once and warns on the repair", () => {
    const draft = edit((d) => (d.headline = unmeasured));
    const first = check(draft);
    expect(of(first.issues, "V10")).toEqual([
      expect.objectContaining({ action: "reject", path: "headline", subjects: ["young", "male"] }),
    ]);
    expect(first.reject).toBe(true);
    const message = of(first.issues, "V10")[0]?.message ?? "";
    expect(message).toContain("remove the claim");
    expect(message).toContain("cite a metric that measures it (audience_dna, or a share_of_taste age context)");
    expect(repairMessage(first.issues)).toContain('- V10 headline: "young", "male" claim an audience\'s age, gender or generation');

    const second = check(draft, { attempt: 2 });
    expect(of(second.issues, "V10")).toEqual([expect.objectContaining({ action: "warn", path: "headline" })]);
    expect(second.reject).toBe(false);
  });

  it("passes negated and limitation sentences", () => {
    // None of these parts cites a metric that measures age or gender.
    const issues = v10((d) => {
      d.arguments[0]!.our_read = "Audience age is unavailable in this build, so we cannot tell whether fans skew young.";
      d.bear_case[0] = { text: "Without demographic data, a younger audience is untested {{M1}}.", metric_ids: ["M1"] };
      d.hypothesis_verdicts[1]!.metric_ids = ["M1"];
      d.hypothesis_verdicts[1]!.note = "The prior that fans skew old could not be tested {{M1}}.";
      d.exhibits[1]!.caption = "Historical window {{WINDOW}}; youth reach was not measured.";
    });
    expect(issues).toEqual([]);
  });

  it("still rejects a plain negation that claims a demographic fact", () => {
    expect(v10((d) => (d.arguments[0]!.our_read = "The audience does not skew female."))).toEqual([
      expect.objectContaining({ path: "arguments[0].our_read", subjects: ["female"] }),
    ]);
  });

  it("passes a part that cites a metric measuring age, anywhere in the same part", () => {
    expect(v10((d) => (d.headline = "Brand Alpha skews young {{M3}}"))).toEqual([]);
    // An argument is one part: a youth-tilt metric in metric_ids covers both of its texts.
    const claim = (d: ReportDraft) => (d.arguments[0]!.our_read = "Its fans skew younger than Brand Beta's.");
    expect(v10(claim)).toEqual([expect.objectContaining({ path: "arguments[0].our_read", subjects: ["younger"] })]);
    expect(
      v10((d) => {
        claim(d);
        d.arguments[0]!.metric_ids = ["M1", "M3"];
      }),
    ).toEqual([]);
    // A recommendation cites what its arguments cite.
    const aim = (ids: ReportDraft["recommendations"][number]["argument_ids"]) => (d: ReportDraft) => {
      d.recommendations[0]!.action = "Aim the co-branded drop at Gen Z fans.";
      d.recommendations[0]!.argument_ids = ids;
    };
    expect(v10(aim(["A2"]))).toEqual([]);
    expect(v10(aim(["A1"]))).toEqual([expect.objectContaining({ path: "recommendations[0].action", subjects: ["Gen Z"] })]);
  });

  it("does not count a demographic metric without a value", () => {
    // M6 is an age index that came back not measured.
    expect(v10((d) => (d.thesis = "Brand Alpha's audience skews older {{M6}} [E4]."))).toEqual([
      expect.objectContaining({ path: "thesis", subjects: ["older"] }),
    ]);
  });

  it("reads age ranges, year-olds and generations, but not dates, data age or brand age", () => {
    expect(v10((d) => (d.arguments[0]!.our_read = "Fans aged 18-24 and 30-year-olds lead; millennials trail."))[0]?.subjects).toEqual([
      "aged 18",
      "30-year-olds",
      "18-24",
      "millennials",
    ]);
    const lookalikes = v10((d) => {
      d.arguments[0]!.our_read = "A youthful brand voice; peers are young brands and women's apparel labels.";
      d.arguments[1]!.our_read = "The older data window ran from 2025-04-01 to 2025-09-30 at 10:30.";
    });
    expect(lookalikes).toEqual([]);
  });

  it("never reads a registered entity or tag name as a claim", () => {
    const withNames = brandHealthRegistry();
    withNames.registerEntity({ entityId: "ent-young-01", name: "Young Ones Cola", type: "brand", popularity: 0.4, disambiguation: null, tags: [] });
    const draft = edit((d) => (d.arguments[0]!.our_read = "Young Ones Cola sits next to Brand Alpha."));
    expect(of(check(draft, { registry: withNames }).issues, "V10")).toEqual([]);
    expect(of(check(draft, { registry: undefined }).issues, "V10")[0]?.subjects).toEqual(["Young"]);
  });

  it("still reads a registered name made only of demographic words as a claim", () => {
    const withTag = brandHealthRegistry();
    withTag.registerTag({ tagId: "urn:tag:lifestyle:invented:gen_z", name: "Gen Z", type: "lifestyle", signalCapable: false });
    const draft = edit((d) => (d.arguments[0]!.our_read = "Gen Z fans sit next to Brand Alpha."));
    expect(of(check(draft, { registry: withTag }).issues, "V10")[0]?.subjects).toEqual(["Gen Z"]);
  });

  it("counts audience_dna indices, the youth tilt and share_of_taste percentiles in an age context only", () => {
    const m = (formulaId: string, key = formulaId, subjectRefs = ["R1"], value: number | null = 0.2) => ({ formulaId, key, subjectRefs, value });
    expect(measuresDemographics(m("dna.gender_index"))).toBe(true);
    expect(measuresDemographics(m("share.youth_tilt"))).toBe(true);
    expect(measuresDemographics(m("share.pct", "share.pct.25_to_29"))).toBe(true);
    expect(measuresDemographics(m("share.pct", "share.pct", ["R1", "55_and_older"]))).toBe(true);
    expect(measuresDemographics(m("share.pct", "share.pct", ["R1", "nashville"]))).toBe(false);
    expect(measuresDemographics(m("dna.age_index", "dna.age_index", ["R1"], null))).toBe(false);
    expect(measuresDemographics(m("dna.distinctive_tags"))).toBe(false);
    expect(datasetMeasuresDemographics({ formulaIds: ["dna.age_index", "dna.gender_index"], evidenceIds: ["E4"] })).toBe(true);
    expect(datasetMeasuresDemographics({ formulaIds: ["subs.similarity", "share.pct"], evidenceIds: ["E1"] })).toBe(false);
  });

  it("counts a dataset drawn from a call that measured age, as a pair's split over age contexts is", () => {
    const m = (formulaId: string, subjectRefs: string[], value: number | null, evidenceIds: EvidenceId[]) => ({ formulaId, key: formulaId, subjectRefs, value, evidenceIds });
    const calls = demographicEvidence([m("share.youth_tilt", ["R1"], 0.2, ["E2"]), m("share.pct", ["R1", "nashville"], 1, ["E6"]), m("share.youth_tilt", ["R2"], null, ["E7"])]);
    expect([...calls]).toEqual(["E2"]);
    const split: { formulaIds: string[]; evidenceIds: EvidenceId[] } = { formulaIds: ["share.pair_split", "share.pct"], evidenceIds: ["E2", "E6"] };
    expect(datasetMeasuresDemographics(split, calls)).toBe(true);
    expect(datasetMeasuresDemographics({ ...split, evidenceIds: ["E6"] }, calls)).toBe(false);
    expect(datasetMeasuresDemographics(split)).toBe(false);
  });

  it("passes every part that cites the youth tilt behind a GENERATIONAL_SPLIT finding, tag included, on both attempts", () => {
    const draft = edit((d) => {
      d.verdict_tag = "Skews younger";
      d.headline = "Brand Alpha skews younger than Brand Beta {{M12}}";
      d.thesis = "Brand Alpha sits next to Brand Beta {{M1}} [E1], and its youth tilt {{M12}} puts the youngest bucket first [E2].";
      d.hypothesis_verdicts[1] = { hypothesis_id: "H2", verdict: "refuted", metric_ids: ["M12"], note: "It skews younger, not older {{M12}}." };
      d.arguments[1]!.metric_ids = ["M12", "M4"];
      d.arguments[1]!.our_read = "Gen Z and younger fans carry the brand.";
      d.recommendations[0]!.argument_ids = ["A2"];
      d.recommendations[0]!.action = "Aim the co-branded drop at younger fans.";
    });
    const ledger = extendedLedger();
    expect(check(draft, { ledger }).issues).toEqual([]);
    const repair = check(draft, { ledger, attempt: 2 });
    expect(repair.issues).toEqual([]);
    expect(repair.patchedDraft.verdict_tag).toBe("Skews younger");
  });

  it("passes an age-bucket claim citing that bucket's percentile, and a caption on the pair's split over age", () => {
    const ledger = extendedLedger();
    const draft = edit((d) => {
      d.thesis = "Brand Beta leads the 35–44 bucket {{M11}} [E2], and Brand Alpha sits next to it {{M1}} [E1].";
      d.exhibits.push({ dataset_id: "D4", title: "Who wins where", caption: "Brand Beta wins the older buckets." });
    });
    expect(check(draft, { ledger }).issues).toEqual([]);
    // The same caption on the Substitution Map, drawn from peer calls only, claims what it does not show.
    const peers = edit((d) => d.exhibits.push({ dataset_id: "D1", title: "Peers", caption: "Brand Beta wins the older buckets." }));
    expect(of(check(peers, { ledger }).issues, "V10")).toEqual([
      expect.objectContaining({ action: "reject", path: "exhibits[2].caption", subjects: ["older"] }),
    ]);
  });

  it("still needs a metric in prose: an evidence token alone does not measure an age claim", () => {
    const draft = edit((d) => (d.thesis = "Brand Alpha sits next to Brand Beta {{M1}} [E1]; Brand Beta leads the 35–44 bucket [E2]."));
    expect(of(check(draft, { ledger: extendedLedger() }).issues, "V10")).toEqual([
      expect.objectContaining({ action: "reject", path: "thesis", subjects: ["35–44"] }),
    ]);
  });

  it("judges claims only: next moves and open questions state no finding", () => {
    const issues = v10((d) => {
      d.next_moves[0]!.question = "How does Brand Alpha rank with Gen Z and older fans?";
      d.open_questions = ["Whether women over-index is open."];
      d.exhibits[0]!.title = "Young fans";
    });
    expect(issues).toEqual([]);
    expect(v10((d) => (d.exhibits[0]!.caption = "Gen Z fans cluster near Brand Beta {{M1}}."))).toEqual([
      expect.objectContaining({ path: "exhibits[0].caption", subjects: ["Gen Z"] }),
    ]);
  });
});

describe("attempt 2 and numbers traced", () => {
  it("downgrades every rejection to a warning after the repair turn", () => {
    const draft = edit((d) => {
      d.thesis = "We should buy: 0.62, 0.71 and 0.58 {{M44}}.";
      d.arguments[0]!.metric_ids = [];
      d.arguments[0]!.qloo_fact = "Similarity is high.";
    });
    const first = check(draft);
    expect(first.reject).toBe(true);
    expect(rules(first.issues)).toEqual(["V2", "V3", "V4", "V5"]);
    const second = check(draft, { attempt: 2 });
    expect(second.reject).toBe(false);
    expect(second.issues.every((i) => i.action === "warn")).toBe(true);
    expect(second.issues).toHaveLength(first.issues.length);
  });

  it("counts bare and unresolved numbers as untraced and skips UNAVAILABLE metrics", () => {
    const draft = edit((d) => {
      d.headline = "Brand Alpha {{M1}} vs {{M6}}";
      d.thesis = "Brand Alpha scores 0.62 {{M1}} and {{M44}}.";
    });
    // Clean draft: 12 traced. Headline: M1 traced, M6 skipped (was M1). Thesis: M1 traced, M44 untraced, 0.62 bare (was 3 traced).
    expect(check(draft).numbersTraced).toEqual({ traced: 10, total: 12 });
  });
});

describe("repairMessage", () => {
  it("lists what to fix and what code already fixed, in plain text", () => {
    const draft = edit((d) => {
      d.signal = "strong";
      d.thesis = "We should buy Brand Alpha {{M1}}.";
      d.arguments[2]!.qloo_fact = "Momentum was {{M5}} [E3].";
    });
    const message = repairMessage(check(draft, { qlooEnabled: false }).issues);
    expect(message).toContain("Call submit_report once more");
    expect(message).toContain('- V4 thesis: "We should buy" is not allowed');
    expect(message).toContain("Code already applied these");
    expect(message).toContain("- V7 signal changed from strong to insufficient_evidence");
    expect(message).toContain("- V8 arguments[2].qloo_fact");
    expect(message).not.toMatch(/\d\.\d{3,}/);
  });

  it("with the draft, restates the tag's rule and the limits of the fields to rewrite near theirs, read from the contracts schema", () => {
    // The shape of a live repair: a headline near its limit and a tag, both rejected for unmeasured demographics.
    const headline = "Brand Alpha wins the young crowd in every market read, ahead of Brand Beta by a clear margin {{M1}}";
    const draft = edit((d) => {
      d.headline = headline;
      d.verdict_tag = "Young crowd";
      d.arguments[1]!.our_read = "Ahead in 30–44 too.";
    });
    const issues = check(draft).issues;
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["headline", "verdict_tag", "arguments[1].our_read"]));
    expect(headline.length).toBeGreaterThanOrEqual(120 * REWRITE_TIGHT_SHARE);
    const message = repairMessage(issues, draft);
    expect(message).toContain("Limits that still hold for what you rewrite (every {{M#}} and [E#] token counts its characters):");
    expect(message).toContain(`- headline: at most 120 characters; it has ${headline.length} now.`);
    expect(message).toContain(
      "- verdict_tag: 2 to 5 words, at most 32 characters, no digits or tokens; words are split at spaces, so a hyphenated compound is one word.",
    );
    // A part with most of its 400 characters left can take the fix.
    expect(message).not.toContain("- arguments[1].our_read: at most");
    // The limits come after what to fix, and only with the draft.
    expect(message.indexOf("Limits that still hold")).toBeGreaterThan(message.indexOf("Fix these issues:"));
    expect(repairMessage(issues)).not.toContain("Limits that still hold");
    // A part near its limit is listed, by the limit the schema gives it.
    const long = edit((d) => (d.arguments[1]!.our_read = `${"Ahead in the middle buckets as well. ".repeat(9)}Ahead in 30–44 too.`));
    expect(repairMessage(check(long).issues, long)).toContain(`- arguments[1].our_read: at most 400 characters; it has ${long.arguments[1]!.our_read.length} now.`);
  });

  it("states no limit twice: a field over its limit already says it, and lists, signals and ids have none", () => {
    const draft = edit((d) => {
      d.headline = `Brand Alpha ${"leads ".repeat(25)}{{M1}}`;
      d.signal = "strong";
      d.arguments[0]!.metric_ids = ["M99"];
    });
    const result = check(draft, { qlooEnabled: false });
    expect(of(result.issues, "V9")).toEqual([expect.objectContaining({ path: "headline" })]);
    const message = repairMessage(result.issues, draft);
    expect(message).not.toContain("- headline: at most");
    expect(message).not.toContain("- arguments[0].metric_ids: at most");
    expect(message).not.toContain("- signal: at most");
    expect(message).not.toContain("Limits that still hold");
  });
});
