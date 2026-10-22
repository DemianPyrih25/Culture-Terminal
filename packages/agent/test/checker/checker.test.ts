import type { ReportDraft, ReportDraftShape, ValidationIssue, ValidationRule } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { checkReport, repairMessage, type CheckReportInput } from "../../src/checker";
import { datasetMeasuresDemographics, measuresDemographics } from "../../src/report/demographics";
import { brandHealthLedger, brandHealthRegistry, emptyLedger, plan, validDraft } from "../ledger/fixtures";

const ledger = brandHealthLedger().snapshot();
const registry = brandHealthRegistry();

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
  it("warns for up to two bare numbers", () => {
    const draft = edit((d) => (d.thesis = "Brand Alpha scores 0.62 against Brand Beta {{M1}} [E1], up 45%."));
    const v3 = of(check(draft).issues, "V3");
    expect(v3).toEqual([expect.objectContaining({ action: "warn", path: "thesis", subjects: ["0.62", "45%"] })]);
    expect(check(draft).reject).toBe(false);
  });

  it("rejects more than two bare numbers across the report", () => {
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
    expect(datasetMeasuresDemographics({ formulaIds: ["dna.age_index", "dna.gender_index"] })).toBe(true);
    expect(datasetMeasuresDemographics({ formulaIds: ["subs.similarity", "share.pct"] })).toBe(false);
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
});
