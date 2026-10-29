// D2 of the Part 9 close-out: a partly tested concept (concept_partly_tagged), and Q4's input-aware
// rank_candidates bullet. Invented concepts and refs only (D29).
import type { DigestRow } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { conceptDisclosure, conceptLimitation, withConceptDisclosure } from "../../src/report/concept";
import { conceptPartlyTagged, conceptSubstitutes, questionConcepts, unusedRefs, type ConceptCall } from "../../src/run/conceptCoverage";
import { RANK_LOCATION_BULLET, SHARE_METRO_BULLET, SkillsRan } from "../../src/run/tools";

const row = (concept: string, ref: string | null): DigestRow => ({ ref: ref as DigestRow["ref"], name: concept, values: { concept, scope: "place" } });
const search = (concepts: string[], rows: DigestRow[] | null, findingIds: string[] = [], trigger: string | null = null): ConceptCall => ({
  tool: "find_tags",
  input: { concepts: concepts.map((text) => ({ text, scope: "place" })), trigger_finding_id: trigger, step_id: null },
  findingIds,
  rows,
});
const lift = (tags: string[]): ConceptCall => ({
  tool: "geo_lift",
  input: { metro: "nashville", concept_tags: tags, trigger_finding_id: null, step_id: null },
  findingIds: [],
  rows: [],
});
const EMPTY = [{ id: "F1" as const, kind: "EMPTY_RESULT" as const }];

describe("conceptPartlyTagged", () => {
  it("is false when every concept part has a tag another call used", () => {
    const calls = [search(["listening bar", "vinyl shop"], [row("listening bar", "T1"), row("vinyl shop", "T2")]), lift(["T1", "T2"])];
    expect(conceptPartlyTagged({ concepts: ["Listening bar", "vinyl  shop"], calls, findings: [] })).toBe(false);
  });

  it("fires for an empty tag search, unless a retry citing it found a tag that was used", () => {
    const empty = search(["listening bar", "zzq"], [row("listening bar", "T1"), row("zzq", null)], ["F1"]);
    expect(conceptPartlyTagged({ concepts: ["listening bar", "zzq"], calls: [empty, lift(["T1"])], findings: EMPTY })).toBe(true);
    const retry = search(["record store"], [row("record store", "T3")], [], "F1");
    expect(conceptPartlyTagged({ concepts: ["listening bar", "zzq"], calls: [empty, retry, lift(["T1", "T3"])], findings: EMPTY })).toBe(false);
    // A retry whose tag no call used tested nothing.
    expect(conceptPartlyTagged({ concepts: ["listening bar", "zzq"], calls: [empty, retry, lift(["T1"])], findings: EMPTY })).toBe(true);
  });

  it("fires for a part whose tags no call used, a failed search and a part never searched", () => {
    const found = search(["listening bar", "vinyl shop"], [row("listening bar", "T1"), row("vinyl shop", "T2")]);
    expect(conceptPartlyTagged({ concepts: ["listening bar", "vinyl shop"], calls: [found, lift(["T1"])], findings: [] })).toBe(true);
    expect(conceptPartlyTagged({ concepts: ["listening bar"], calls: [search(["listening bar"], null), lift([])], findings: [] })).toBe(true);
    const one = search(["listening bar"], [row("listening bar", "T1")]);
    expect(conceptPartlyTagged({ concepts: ["listening bar", "vinyl shop"], calls: [one, lift(["T1"])], findings: [] })).toBe(true);
  });

  it("does not judge a run that tested no concept by tag, nor a part whose rows were cut from the digest", () => {
    expect(conceptPartlyTagged({ concepts: ["energy drinks"], calls: [lift([])], findings: [] })).toBe(false);
    const cut = search(["listening bar", "vinyl shop"], [row("listening bar", "T1")]);
    expect(conceptPartlyTagged({ concepts: ["listening bar", "vinyl shop"], calls: [cut, lift(["T1"])], findings: [] })).toBe(false);
  });

  it("reads the concept description when CLERK lists no concepts", () => {
    expect(questionConcepts({ constraints: { concepts: [], concept_description: " a spicy oat soda " } as never })).toEqual(["a spicy oat soda"]);
    expect(questionConcepts({ constraints: { concepts: ["oat soda"], concept_description: "x" } as never })).toEqual(["oat soda"]);
  });
});

describe("conceptSubstitutes (the owner's o03 decision)", () => {
  /** A brand search row: a tag (with its use) or a no-match row listing the nearest categories. */
  const tagRow = (concept: string, ref: string, name: string, use = "taste_signal"): DigestRow => ({
    ref: ref as DigestRow["ref"],
    name,
    values: { concept, scope: "brand", use, source: "search", status: "live" },
  });
  const noMatch = (concept: string, nearest: string[], match = "none"): DigestRow => ({
    ref: null,
    name: concept,
    values: { concept, scope: "brand", match, ...(nearest.length > 0 ? { nearest: nearest.join(" | ") } : {}) },
  });
  const brandSearch = (texts: string[], rows: DigestRow[], findingIds: string[] = [], trigger: string | null = null): ConceptCall => ({
    tool: "find_tags",
    input: { concepts: texts.map((text) => ({ text, scope: "brand" })), trigger_finding_id: trigger, step_id: null },
    findingIds,
    rows,
  });
  const vector = (tags: string[]): ConceptCall => ({ tool: "concept_vector", input: { concept_tags: tags, type: "brand", analogs: [] }, findingIds: [] });
  const empty = brandSearch(["Fizzy kelp tonic"], [noMatch("fizzy kelp tonic", ["Sea Snacks", "Soft Drinks"])], ["F1"]);

  it("names the nearest category a later search found and a call used: the scan's retry or the ANALYST's", () => {
    const retry = brandSearch(["Sea Snacks"], [tagRow("Sea Snacks", "T4", "Sea Snacks")]);
    expect(conceptSubstitutes({ concepts: ["Fizzy  kelp tonic"], calls: [empty, retry, vector(["T4"])] })).toEqual([
      { concept: "Fizzy kelp tonic", scope: "brand", categories: ["Sea Snacks"], whole: true },
    ]);
    // A search with another phrase that cites the empty search's finding is its category search too.
    const rescue = brandSearch(["tonic water"], [tagRow("tonic water", "T5", "Tonic Water")], [], "F1");
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [empty, rescue, vector(["T5"])] })[0]?.categories).toEqual(["Tonic Water"]);
  });

  it("says not tested when no category was found or used, and says nothing for a concept with its own tag or a failed search", () => {
    const retry = brandSearch(["Sea Snacks"], [tagRow("Sea Snacks", "T4", "Sea Snacks")]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [empty, retry] })).toEqual([
      { concept: "fizzy kelp tonic", scope: "brand", categories: [], whole: true },
    ]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [empty] })[0]?.categories).toEqual([]);
    // An unrelated later search (not a listed category, no trigger) is not the concept's category.
    const other = brandSearch(["oat crackers"], [tagRow("oat crackers", "T6", "Crackers")]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [empty, other, vector(["T6"])] })[0]?.categories).toEqual([]);
    const own = brandSearch(["fizzy kelp tonic"], [tagRow("fizzy kelp tonic", "T1", "Kelp Tonic")]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [own, vector(["T1"])] })).toEqual([]);
    const failed = brandSearch(["fizzy kelp tonic"], [noMatch("fizzy kelp tonic", [], "error")]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [failed] })).toEqual([]);
    // Only label tags kept: not in the data either.
    const labels = brandSearch(["fizzy kelp tonic"], [tagRow("fizzy kelp tonic", "T2", "Fizzy", "label_only")]);
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic"], calls: [labels] })).toEqual([{ concept: "fizzy kelp tonic", scope: "brand", categories: [], whole: true }]);
    // One part of several is never called the product.
    expect(conceptSubstitutes({ concepts: ["fizzy kelp tonic", "beach look"], calls: [empty] })[0]?.whole).toBe(false);
  });

  it("writes the disclosure that opens the thesis and leads the limitations", () => {
    const tested = [{ concept: "Fizzy kelp tonic", scope: "brand", categories: ["Sea Snacks"] }];
    const sentence = 'The exact product, "Fizzy kelp tonic", is not in the data, so the category "Sea Snacks" was tested instead.';
    expect(conceptDisclosure(tested)).toBe(sentence);
    expect(withConceptDisclosure("Taste leans coastal.", tested)).toBe(`${sentence} Taste leans coastal.`);
    expect(conceptLimitation(tested)).toEqual({ source: "flag", flag: "CONCEPT_NOT_IN_DATA", text: sentence });
    expect(conceptDisclosure([{ concept: 'quiet "listening" room', scope: "place", categories: [] }])).toBe(
      'The exact concept, "quiet listening room", is not in the data, and no close category was found either, so the concept could not be tested at all.',
    );
    expect(conceptDisclosure([{ concept: "kelp tonic", scope: "brand", categories: ["Sea Snacks", "Soft Drinks"] }])).toContain(
      'the categories "Sea Snacks" and "Soft Drinks" were tested instead.',
    );
    expect(conceptDisclosure([{ concept: "beach look", scope: "brand", categories: ["Swim Gear"], whole: false }])).toBe(
      'The part "beach look" is not in the data, so the category "Swim Gear" was tested for it instead.',
    );
    expect(conceptDisclosure([{ concept: "beach look", scope: "brand", categories: [], whole: false }])).toBe(
      'The part "beach look" is not in the data, and no close category was found either, so that part could not be tested at all.',
    );
    expect(conceptDisclosure([])).toBeNull();
    expect(withConceptDisclosure("Unchanged.", [])).toBe("Unchanged.");
  });

  it("finds the refs a lookup returned that no other call used yet (lookupsPending)", () => {
    expect(unusedRefs(["T4", "R2", "T4", "x"], [brandSearch(["a"], []), vector(["T4"])])).toEqual(["R2"]);
    expect(unusedRefs(["T4"], [vector(["T4"])])).toEqual([]);
  });
});

describe("SkillsRan (Q4)", () => {
  it("shows rank_candidates' site or city bullet only when a call ranked under a location context", () => {
    expect(RANK_LOCATION_BULLET).toBeDefined();
    const none = new SkillsRan();
    none.add("rank_candidates", [], { candidates: ["R1", "R2"], contexts: [{ kind: "none" }] });
    expect(none.limitations()).not.toContain(RANK_LOCATION_BULLET);
    expect(none.limitations().length).toBeGreaterThan(0);
    const site = new SkillsRan();
    site.add("rank_candidates", [], { candidates: ["R1", "R2"], contexts: [{ kind: "none" }] });
    site.add("rank_candidates", [], { candidates: ["R1", "R2"], contexts: [{ kind: "city", metro: "nashville" }] });
    expect(site.limitations()).toContain(RANK_LOCATION_BULLET);
  });

  it("shows share_of_taste's metro bullet only when a call read a metro context", () => {
    expect(SHARE_METRO_BULLET).toBeDefined();
    const set = ["R1", "R2"];
    const ages = new SkillsRan();
    ages.add("share_of_taste", [], { type: "brand", set, ages: ["25_to_29"], audiences: [], genders: [], metros: [] });
    expect(ages.limitations()).not.toContain(SHARE_METRO_BULLET);
    expect(ages.limitations().length).toBeGreaterThan(0);
    const metros = new SkillsRan();
    metros.add("share_of_taste", [], { type: "brand", set, ages: [], audiences: [], genders: [], metros: ["m1"] });
    expect(metros.limitations()).toContain(SHARE_METRO_BULLET);
  });
});
