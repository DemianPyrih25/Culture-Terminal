// CHECKER V13 (Part 11, ANSWER_QUALITY §3), the V9 disclosure rule (Part 9 open issue 3) and the V7
// subject extension (SUBJECT_NO_DATA). Invented names only (D29).
import type { ValidationIssue } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { checkHonest, editDraft } from "./honesty-fixtures";

const of = (issues: readonly ValidationIssue[], rule: ValidationIssue["rule"]) => issues.filter((i) => i.rule === rule);

describe("V13: an about-level difference never leads the answer", () => {
  it("rejects an about-level metric in the headline and in the thesis's first sentence", () => {
    const headline = checkHonest(editDraft((d) => (d.headline = "Brand Alpha leans younger {{M14}}")));
    expect(of(headline.issues, "V13")).toEqual([
      expect.objectContaining({ action: "reject", path: "headline", subjects: ["M14"], message: "headline: M14 is about level (a small difference): it cannot lead the answer." }),
    ]);
    const thesis = checkHonest(editDraft((d) => (d.thesis = `Its audience is about level in age {{M14}} [E2]. ${d.thesis}`)));
    expect(of(thesis.issues, "V13").map((i) => i.path)).toEqual(["thesis"]);
  });

  it("allows it later in the thesis and in the arguments, and warns on the last attempt", () => {
    const later = checkHonest(editDraft((d) => (d.thesis = `${d.thesis} By age it is about level {{M14}}.`)));
    expect(of(later.issues, "V13")).toEqual([]);
    const last = checkHonest(editDraft((d) => (d.headline = "Brand Alpha leans younger {{M14}}")), { attempt: 2 });
    expect(of(last.issues, "V13")).toEqual([expect.objectContaining({ action: "warn" })]);
  });
});

describe("V9: the thesis never restates the top-of-answer disclosure", () => {
  const restated = editDraft((d) => (d.thesis = `${d.thesis} The exact product has no tag of its own, so its broader category was tested.`));

  it("rejects the restating sentence once when a concept disclosure opens the answer", () => {
    const first = checkHonest(restated, { disclosure: { concept: true, readAs: false } });
    expect(of(first.issues, "V9")).toEqual([
      expect.objectContaining({ action: "reject", path: "thesis", message: expect.stringContaining("restates what the page already says at the top") }),
    ]);
    // Without a disclosure the same words are the thesis's own business.
    expect(of(checkHonest(restated).issues, "V9")).toEqual([]);
  });

  it("drops it on the last attempt (forced) and keeps the rest of the thesis", () => {
    const last = checkHonest(restated, { disclosure: { concept: true, readAs: false }, attempt: 2 });
    expect(of(last.issues, "V9")).toEqual([expect.objectContaining({ action: "forced", path: "thesis" })]);
    expect(last.patchedDraft.thesis).not.toContain("broader category");
    expect(last.patchedDraft.thesis).toContain("Brand Alpha sits next to Brand Beta");
  });

  it("reads a nearest-job restatement only when the question was read as its nearest job", () => {
    const nearest = editDraft((d) => (d.thesis = `${d.thesis} The note answers the nearest question the data can measure.`));
    expect(of(checkHonest(nearest, { disclosure: { concept: false, readAs: true } }).issues, "V9")).toHaveLength(1);
    expect(of(checkHonest(nearest, { disclosure: { concept: true, readAs: false } }).issues, "V9")).toEqual([]);
  });
});

describe("V7: a resolved subject Qloo returned nothing for", () => {
  it("forces insufficient_evidence even with enough ok bundles, and drops the tag", () => {
    const result = checkHonest(editDraft(() => {}), { subjectNoData: "Brand Alpha" });
    expect(result.forcedSignal).toBe("insufficient_evidence");
    expect(result.patchedDraft.verdict_tag).toBe("");
    expect(of(result.issues, "V7")).toEqual([
      expect.objectContaining({ action: "forced", message: expect.stringContaining("Qloo returned no data for Brand Alpha, the question's subject, and no look-alike stands in for it") }),
    ]);
    expect(checkHonest(editDraft(() => {}), { subjectNoData: null }).forcedSignal).toBeUndefined();
  });
});
