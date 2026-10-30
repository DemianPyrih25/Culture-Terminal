// CHECKER V12 (Part 11, R2, R7, D48, D50): concept and area honesty. Invented names only (D29).
import type { ValidationIssue } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { NOT_TESTED_PREFIX } from "../../src/report/honesty";
import { plan } from "../ledger/fixtures";
import { checkHonest, editDraft } from "./honesty-fixtures";

const v12 = (issues: readonly ValidationIssue[]) => issues.filter((i) => i.rule === "V12");

describe("V12 (a): a metric read through a look-alike tag is never cited", () => {
  it("rejects it with the tag and the concept named, and warns on the last attempt (the report then gets category_level)", () => {
    const draft = editDraft((d) => (d.arguments[0]!.qloo_fact = "Brand Beta fits the concept at {{M11}} [E1]."));
    const first = checkHonest(draft);
    expect(v12(first.issues)).toEqual([
      expect.objectContaining({
        action: "reject",
        path: "arguments[0].qloo_fact",
        subjects: ["M11"],
        message:
          "arguments[0].qloo_fact: M11 rests on 'Kelp Snacks', a look-alike tag standing in for 'kelp tonic'. The data has no tag for it: " +
          "use the category-level read or say the concept is not in the data.",
      }),
    ]);
    expect(first.reject).toBe(true);
    expect(first.proxyCited).toBe(true);
    const last = checkHonest(draft, { attempt: 2 });
    expect(v12(last.issues)).toEqual([expect.objectContaining({ action: "warn", subjects: ["M11"] })]);
    expect(last.reject).toBe(false);
    expect(last.proxyCited).toBe(true);
  });

  it("counts a proxy metric cited only in an id list", () => {
    const draft = editDraft((d) => d.bear_case[0]!.metric_ids.push("M11"));
    expect(v12(checkHonest(draft).issues)).toEqual([expect.objectContaining({ path: "bear_case[0].metric_ids", subjects: ["M11"] })]);
  });

  it("leaves a clean draft alone", () => {
    const result = checkHonest(editDraft(() => {}));
    expect(result.issues).toEqual([]);
    expect(result.proxyCited).toBe(false);
  });
});

describe("V12 (b): a category-level read names no winner, keep or veto", () => {
  it("rejects a winner word beside a category metric in the headline", () => {
    const draft = editDraft((d) => (d.headline = "Brand Beta wins the category {{M12}}"));
    expect(v12(checkHonest(draft).issues)).toEqual([
      expect.objectContaining({
        action: "reject",
        path: "headline",
        message: expect.stringContaining("This is a category-level read of 'Sea Snacks', not 'kelp tonic': describe it as the category's fit, with no winner, keep or veto."),
      }),
    ]);
  });

  it("judges the verdict tag with the headline's metrics, and the thesis on its own", () => {
    const tagged = editDraft((d) => {
      d.headline = "Brand Beta fits the category well {{M12}}";
      d.verdict_tag = "Clear winner";
    });
    expect(v12(checkHonest(tagged).issues).map((i) => i.path)).toEqual(["verdict_tag"]);
    const thesis = editDraft((d) => (d.thesis = `${d.thesis} Keep Brand Beta: it fits {{M12}}.`));
    expect(v12(checkHonest(thesis).issues).map((i) => i.path)).toEqual(["thesis"]);
  });

  it("allows a category metric described as the category's fit", () => {
    const draft = editDraft((d) => (d.headline = "Brand Beta fits the broader category {{M12}}"));
    expect(v12(checkHonest(draft).issues)).toEqual([]);
  });
});

describe("V12 (c): a hidden pocket is never the best area in the headline", () => {
  it("rejects 'best' beside a hidden pocket and passes a popular area", () => {
    const hidden = checkHonest(editDraft((d) => (d.headline = "Elm Park is the best pocket for Brand Alpha {{M1}}")));
    expect(v12(hidden.issues)).toEqual([
      expect.objectContaining({
        path: "headline",
        message: "headline: Elm Park is a hidden pocket (it stands out for its size, not where the crowd is). Say so, or name the popular areas beside it.",
      }),
    ]);
    expect(v12(checkHonest(editDraft((d) => (d.headline = "Harbor Row is the best area for Brand Alpha {{M1}}"))).issues)).toEqual([]);
    expect(v12(checkHonest(editDraft((d) => (d.headline = "Elm Park stands out for its size {{M1}}"))).issues)).toEqual([]);
  });
});

describe("V12 (d): a hypothesis that was never really tested is never confirmed or refuted", () => {
  it("forces a verdict resting only on category or proxy reads to inconclusive, note kept and prefixed", () => {
    const draft = editDraft((d) => (d.hypothesis_verdicts[0] = { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M12"], note: "The category fits {{M12}}." }));
    const result = checkHonest(draft);
    expect(v12(result.issues)).toEqual([
      expect.objectContaining({ action: "forced", path: "hypothesis_verdicts[0].verdict", subjects: ["H1"], message: expect.stringContaining("changed from confirmed to inconclusive") }),
    ]);
    expect(result.patchedDraft.hypothesis_verdicts[0]).toMatchObject({ verdict: "inconclusive", note: `${NOT_TESTED_PREFIX}The category fits {{M12}}.` });
    // The model's draft is never edited in place.
    expect(draft.hypothesis_verdicts[0]?.verdict).toBe("confirmed");
    expect(result.reject).toBe(false);
  });

  it("forces one resting only on thin samples", () => {
    const draft = editDraft((d) => (d.hypothesis_verdicts[1] = { hypothesis_id: "H2", verdict: "refuted", metric_ids: ["M13"], note: "Small set {{M13}}." }));
    expect(checkHonest(draft).patchedDraft.hypothesis_verdicts[1]?.verdict).toBe("inconclusive");
  });

  it("forces one whose test tool never returned data and whose metrics come from elsewhere", () => {
    const p = plan();
    p.hypotheses[0]!.test_tool = "geo_lift";
    const result = checkHonest(editDraft(() => {}), { plan: p });
    expect(v12(result.issues)).toEqual([expect.objectContaining({ subjects: ["H1"], message: expect.stringContaining("its test tool geo_lift never returned data") })]);
    // Its own tool's metrics count even when that tool's bundle is not ok.
    expect(v12(checkHonest(editDraft(() => {})).issues)).toEqual([]);
  });

  it("keeps the note within its limit when the prefix is added, cutting at a sentence or word end", () => {
    const long = `${"The category reads well. ".repeat(12)}{{M12}}`;
    const draft = editDraft((d) => (d.hypothesis_verdicts[0] = { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M12"], note: long.slice(0, 300) }));
    const note = checkHonest(draft).patchedDraft.hypothesis_verdicts[0]!.note;
    expect(note.startsWith(NOT_TESTED_PREFIX)).toBe(true);
    expect(note.length).toBeLessThanOrEqual(300);
    expect(note.endsWith(".")).toBe(true);
  });
});

describe("V12 (e): expected candidates are never called named (R3)", () => {
  it("rejects 'named peers' when the question named none, and 'the areas you named' when it named no area", () => {
    const draft = editDraft((d) => {
      d.arguments[0]!.qloo_fact = "Ahead of any named drink peer, Brand Beta fits best at {{M12}} [E1].";
      d.arguments[0]!.our_read = "Of the areas you named, the first is strongest.";
    });
    const issues = v12(checkHonest(draft, { named: { entities: false, areas: false } }).issues);
    expect(issues.map((i) => i.path)).toEqual(["arguments[0].qloo_fact", "arguments[0].our_read"]);
    expect(issues[0]?.message).toContain("the question named no peers or brands; these are expected candidates");
    expect(issues[1]?.message).toContain("the question named no areas");
  });

  it("allows the words when the question did name them, and judges nothing without the input", () => {
    const draft = editDraft((d) => (d.arguments[0]!.qloo_fact = "Among the named peers, Brand Beta fits best at {{M12}} [E1]."));
    expect(v12(checkHonest(draft, { named: { entities: true, areas: false } }).issues).filter((i) => i.message.includes("named no"))).toEqual([]);
    expect(v12(checkHonest(draft).issues).filter((i) => i.message.includes("named no"))).toEqual([]);
  });
});
