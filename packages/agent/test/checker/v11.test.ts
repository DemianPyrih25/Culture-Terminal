// CHECKER V11 (PLAN §6): SEC and Census figures carry their period or vintage, and never explain a taste
// signal or the reverse. Invented ledger and figures (D29).
import type { ReportDraft, ValidationIssue, ValidationRule } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { checkReport } from "../../src/checker";
import { brandHealthRegistry, plan } from "../ledger/fixtures";
import { publicDraft, publicLedger } from "../ledger/publicFixtures";

const ledger = publicLedger().snapshot();

const check = (draft: ReportDraft, attempt: 1 | 2 = 1) =>
  checkReport({ draft, plan: plan(), ledger, qlooEnabled: true, registry: brandHealthRegistry(), attempt });

function edit(change: (d: ReportDraft) => void): ReportDraft {
  const d = publicDraft();
  change(d);
  return d;
}

const of = (issues: readonly ValidationIssue[], rule: ValidationRule) => issues.filter((i) => i.rule === rule);

describe("V11: SEC and Census figures carry their period", () => {
  it("passes a draft that sets every public figure beside its period token", () => {
    const result = check(publicDraft());
    expect(result.issues).toEqual([]);
    expect(result.reject).toBe(false);
    expect(result.patchedDraft).toEqual(publicDraft());
  });

  it("injects the period right after the figure's token, and appends it when only metric_ids cite it", () => {
    const draft = edit((d) => {
      d.thesis = "Brand Alpha sits next to Brand Beta {{M1}} [E1]. Revenue was {{M4}} and area income {{M5}} [E4] [E5].";
      d.arguments[2]!.qloo_fact = "The parent company filed its annual report [E4].";
    });
    const result = check(draft);
    expect(result.patchedDraft.thesis).toBe(
      "Brand Alpha sits next to Brand Beta {{M1}} [E1]. Revenue was {{M4}} ({{PERIOD:M4}}) and area income {{M5}} ({{PERIOD:M5}}) [E4] [E5].",
    );
    expect(result.patchedDraft.arguments[2]?.qloo_fact).toBe("The parent company filed its annual report [E4]. ({{PERIOD:M4}})");
    expect(of(result.issues, "V11")).toEqual([
      expect.objectContaining({ action: "injected", path: "thesis", subjects: ["M4", "M5"] }),
      expect.objectContaining({ action: "injected", path: "arguments[2]", subjects: ["M4"] }),
    ]);
    // Code adds the period, so it never costs a repair turn.
    expect(result.reject).toBe(false);
  });

  it("accepts one period token anywhere in an argument, and leaves Qloo figures without one", () => {
    const covered = edit((d) => {
      d.arguments[2]!.qloo_fact = "Revenue was {{M4}} [E4].";
      d.arguments[2]!.our_read = "Read it for {{PERIOD:M4}} only, beside the taste read.";
    });
    expect(of(check(covered).issues, "V11")).toEqual([]);
  });

  it("removes a period token set on a Qloo figure, and reports one on an unknown metric under V2", () => {
    const stray = edit((d) => (d.headline = "Brand Alpha shares its taste pool with Brand Beta {{M1}} ({{PERIOD:M1}})"));
    const result = check(stray);
    expect(result.patchedDraft.headline).toBe("Brand Alpha shares its taste pool with Brand Beta {{M1}}");
    expect(of(result.issues, "V11")).toEqual([expect.objectContaining({ action: "forced", path: "headline", subjects: ["M1"] })]);
    const unknown = edit((d) => (d.thesis = `${d.thesis} Period {{PERIOD:M99}}.`));
    expect(of(check(unknown).issues, "V2")).toEqual([expect.objectContaining({ path: "thesis", subjects: ["M99"] })]);
  });
});

describe("V11: no causal link between public figures and taste signals", () => {
  it("rejects a claim that explains a financial figure by a taste signal, and warns on the last attempt", () => {
    const draft = edit((d) => (d.arguments[2]!.our_read = "Revenue grew because fans love the brand {{M2}}."));
    const first = check(draft);
    expect(of(first.issues, "V11")).toEqual([
      expect.objectContaining({ action: "reject", path: "arguments[2].our_read", subjects: ["because"] }),
    ]);
    expect(first.reject).toBe(true);
    const last = check(draft, 2);
    expect(of(last.issues, "V11")).toEqual([expect.objectContaining({ action: "warn" })]);
    expect(last.reject).toBe(false);
  });

  it("catches resident figures tied to taste too, by token or in words", () => {
    const draft = edit((d) => (d.thesis = "Higher incomes {{M5}} ({{PERIOD:M5}}) drive the taste for the brand {{M1}} [E5]."));
    expect(of(check(draft).issues, "V11").map((i) => i.subjects)).toEqual([["drive"]]);
  });

  it("allows the two side by side, a stated absence of a link, and causal words in a claim with no public figure", () => {
    const sideBySide = edit((d) => (d.arguments[2]!.our_read = "Revenue and the taste read are separate measures; neither explains the other."));
    expect(of(check(sideBySide).issues, "V11")).toEqual([]);
    const negated = edit((d) => (d.arguments[2]!.our_read = "The taste signal does not explain the revenue figure."));
    expect(of(check(negated).issues, "V11")).toEqual([]);
    const tasteOnly = edit((d) => (d.arguments[0]!.our_read = "Shared fans lead to one taste pool."));
    expect(of(check(tasteOnly).issues, "V11")).toEqual([]);
  });
});

describe("V7 counts Qloo bundles only", () => {
  it("forces insufficient_evidence when the ok bundles beyond two are SEC and Census ones", () => {
    const fx = publicLedger();
    const thin = { ...fx.snapshot(), evidence: fx.snapshot().evidence.filter((e) => e.id !== "E3") };
    const result = checkReport({ draft: publicDraft(), plan: plan(), ledger: thin, qlooEnabled: true });
    expect(result.forcedSignal).toBe("insufficient_evidence");
    expect(of(result.issues, "V7")[0]?.message).toContain("only 2 Qloo evidence bundles are ok");
  });
});
