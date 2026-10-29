// Key-figure text per metric key: the number is the head of the metric's own display, the rest of the
// display and what it is measured against go underneath, and the label is short. The labels below follow
// the templates the skills in @ct/quant write (invented names, D29).
import { describe, expect, it } from "vitest";
import { initialRunState, type Metric, type RunState } from "@ct/contracts";
import { buildLedger, buildNextMoves, keyFigureLabel, keyFigureText, nextMoveDesk, nextMoveLabel, type Ledger } from "../../lib/brief";

const metric = (over: Partial<Metric> & Pick<Metric, "key" | "label" | "display">): Metric => ({
  id: "M1",
  subjectRefs: ["R1"],
  value: 1,
  reason: null,
  unit: "score",
  badge: "DERIVED",
  formulaId: over.key,
  evidenceIds: [],
  n: null,
  conf: null,
  comparator: null,
  window: null,
  ...over,
});

const ledgerWith = (names: Record<string, string>): Ledger => {
  const state: RunState = {
    ...initialRunState("run-key-figures"),
    resolves: Object.entries(names).map(([ref, name]) => ({
      mention: name,
      role: "primary" as const,
      entityType: "brand" as const,
      match: "exact" as const,
      ref: ref as `R${number}`,
      name,
      popularity: null,
      disambiguation: null,
      alternatives: [],
      source: "gate" as const,
    })),
  };
  return buildLedger(state);
};

const LEDGER = ledgerWith({ R1: "Juniper Cola", R2: "Lantern Hi-Fi Bar", R3: "Harrow Pale Lager" });

describe("keyFigureText", () => {
  it("prints the head of the display and moves the rest underneath, without the inspector's aside", () => {
    const shift = metric({
      key: "tenant.rank_shift",
      label: "rank shift of Lantern Hi-Fi Bar, ZIP 37206 vs Nashville",
      subjectRefs: ["R2", "zcta_37206", "nashville"],
      display: "+0.75 · site 1 of 5 · city 4 of 5, among the 5 ranked at both",
      unit: "delta",
      comparator: "CITY",
    });
    expect(keyFigureText(LEDGER, "tenant_mix", shift, shift.label, "CITY")).toEqual({
      value: "+0.75",
      label: "Top climber · Lantern Hi-Fi Bar",
      comparator: "site 1 of 5 · city 4 of 5",
    });
  });

  it("names a tag, its city and NEW from a Block DNA label", () => {
    const tag = metric({ key: "block.rank_delta", label: "rank gain vs Nashville: Listening room (WHO venue-goer taste tag, East Nashville)", subjectRefs: ["T9", "east", "nashville"], display: "+42 · NEW", unit: "delta", comparator: "CITY" });
    expect(keyFigureText(LEDGER, "tenant_mix", tag, null, "CITY")).toEqual({ value: "+42", label: "Listening room", comparator: "new here · rank vs Nashville" });
    const fresh = metric({ key: "block.new_tag", label: "NEW SOUND music tags in East Nashville (area music top 20, absent from the Nashville music top 50)", subjectRefs: ["east", "nashville"], display: "6 of 20 in the area music top 20", unit: "count", comparator: "CITY" });
    expect(keyFigureText(LEDGER, "area_profile", fresh, null, "CITY")).toEqual({ value: "6 of 20", label: "New music tags", comparator: "vs Nashville" });
  });

  it("names a neighbourhood's lift and its baseline, and keeps the slot for the metro-wide one", () => {
    const lift = metric({ key: "lift.area", label: "lift of Holly vs the restaurant baseline (lowest in the metro)", subjectRefs: ["holly", "T1"], display: "0.82×", unit: "lift", comparator: "BASELINE" });
    expect(keyFigureText(LEDGER, "site_selection", lift, null, "BASELINE")).toEqual({ value: "0.82×", label: "Holly", comparator: "vs restaurant baseline" });
    const none = metric({ key: "lift.area", label: "neighbourhood lift in Austin vs the restaurant baseline", subjectRefs: ["austin", "T1"], display: "", value: null, reason: "insufficient_n", badge: "UNAVAILABLE", unit: "lift", comparator: "BASELINE" });
    // Not measured, never 0, with the slot's label rather than the metro's name.
    expect(keyFigureText(LEDGER, "site_selection", none, null, "BASELINE")).toEqual({ value: "not measured", label: "Area lift", comparator: "vs restaurant baseline" });
    const precision = metric({ key: "lift.precision", formulaId: "lift.confidence", label: "map precision factor in Austin", subjectRefs: ["austin"], display: "gh5 · 0.50 · coarse, no neighbourhood claims", unit: "ratio" });
    expect(keyFigureText(LEDGER, "site_selection", precision, null, null)).toEqual({ value: "0.50", label: "Map precision", comparator: "geohash 5 grid · coarse, no neighbourhood claims" });
  });

  it("names a slate's category and brand, and the market of an alignment", () => {
    const fit = metric({ key: "slate.fit", formulaId: "slate.best_fit", label: "FIT · Harrow Pale Lager · Beer best fit, under the radar", subjectRefs: ["R3", "R1"], display: "0.94 · 1 of 24", unit: "pct", comparator: "WITHIN_CALL" });
    expect(keyFigureText(LEDGER, "sponsorship", fit, fit.label, "WITHIN_CALL")).toEqual({ value: "0.94", label: "Best fit · beer", comparator: "Harrow Pale Lager" });
    const market = metric({ key: "slate.market_alignment", label: "Harrow Pale Lager · strongest market", subjectRefs: ["R3", "nashville"], display: "+0.14 in Nashville", unit: "delta", comparator: "BASELINE" });
    expect(keyFigureText(LEDGER, "sponsorship", market, market.label, "BASELINE")).toEqual({ value: "+0.14", label: "Top market · Nashville", comparator: "Harrow Pale Lager · vs national" });
  });

  it("keeps a short report label and a metric's own display when no spec applies", () => {
    const sim = metric({ key: "subs.similarity", label: "similarity Juniper Cola–Lantern Hi-Fi Bar (nearest peer)", subjectRefs: ["R1", "R2"], display: "0.70", unit: "similarity" });
    expect(keyFigureText(LEDGER, "brand_health", sim, sim.label, null)).toEqual({ value: "0.70", label: "Nearest audience", comparator: "with Lantern Hi-Fi Bar" });
    expect(keyFigureText(LEDGER, "brand_health", sim, "Overlap", null).label).toBe("Overlap");
    // Concept tags, areas and markets among the subjects are never read as the brand it is measured with.
    const lifted = metric({ key: "rank.fit", formulaId: "pct.within_call", label: "FIT of Juniper Cola, Nashville", subjectRefs: ["R1", "T4", "nashville"], display: "0.81 · 2 of 9", unit: "pct", comparator: "WITHIN_CALL" });
    expect(keyFigureText(LEDGER, "head_to_head", lifted, null, "WITHIN_CALL").comparator).toBe("rank 2 of 9 · within call");
  });

  it("shortens the metric's own label even when a short brand name makes it short, live and final alike", () => {
    const kit = ledgerWith({ R1: "Kit" });
    // The agent passes each figure's metric label as its KPI label (pickKpis).
    const youth = metric({ key: "dna.youth_index", label: "Kit youth index (Y)", display: "+0.31", unit: "index", comparator: "BASELINE" });
    expect(keyFigureText(kit, "brand_health", youth, youth.label, "BASELINE").label).toBe("Youth index");
    expect(keyFigureText(kit, "brand_health", youth, null, "BASELINE").label).toBe("Youth index");
    const ages = metric({ key: "dna.age_index", label: "Kit age index 25–29", subjectRefs: ["R1", "25_to_29"], display: "+0.42", unit: "index", comparator: "BASELINE" });
    expect(keyFigureText(kit, "audience_discovery", ages, ages.label, "BASELINE").label).toBe("Index, ages 25–29");
    expect(keyFigureLabel("audience_discovery", youth, youth.label)).toBe("Youth index");
  });

  it("names each brand's youth index in a head-to-head, never as the share tilt", () => {
    const pair = ledgerWith({ R1: "Juniper Cola", R2: "Foxglove Cola" });
    const youth = (ref: "R1" | "R2", name: string, display: string) =>
      metric({ key: "dna.youth_index", label: `${name} youth index (Y)`, subjectRefs: [ref], display, unit: "index", comparator: "BASELINE" });
    const figures = [youth("R1", "Juniper Cola", "+0.31 · 1 of 2"), youth("R2", "Foxglove Cola", "−0.12 · 2 of 2")].map((m) => keyFigureText(pair, "head_to_head", m, m.label, "BASELINE"));
    expect(figures).toEqual([
      { value: "+0.31", label: "Youth index · Juniper Cola", comparator: "rank 1 of 2 · 0 = average" },
      { value: "−0.12", label: "Youth index · Foxglove Cola", comparator: "rank 2 of 2 · 0 = average" },
    ]);
  });
});

describe("nextMoveDesk", () => {
  it("reads the desk from a typed command, then the label, then the question", () => {
    expect(nextMoveDesk({ label: "Block", question: "EAST NASHVILLE, NASHVILLE TEN" }, "marketing")).toBe("location");
    expect(nextMoveDesk({ label: "Sponsor fit", question: "Which artists fit the Juniper Cola audience?" }, "investment")).toBe("marketing");
    expect(nextMoveDesk({ label: "Audience", question: "Who is the Juniper Cola audience beyond beverages?" }, "investment")).toBe("audience");
    expect(nextMoveDesk({ label: "Head to head", question: "Juniper Cola vs Foxglove Cola: same customer?" }, "audience")).toBe("investment");
    expect(nextMoveDesk({ label: "Next", question: "Which East Nashville block fits the after-party pop-up?" }, "marketing")).toBe("location");
    expect(nextMoveDesk({ label: "Next", question: "Which cities should Juniper Cola launch in?" }, "investment")).toBe("marketing");
    // No desk words: the brief's own desk.
    expect(nextMoveDesk({ label: "More", question: "What else?" }, "audience")).toBe("audience");
  });

  it("reads place words whole, never inside a longer word", () => {
    expect(nextMoveDesk({ label: "Next", question: "Who else buys streetwear like this?" }, "audience")).toBe("audience");
    expect(nextMoveDesk({ label: "Next", question: "Is the brand a cornerstone of its category?" }, "investment")).toBe("investment");
    expect(nextMoveDesk({ label: "Next", question: "Which zipper brands share the audience?" }, "investment")).toBe("audience");
    // The whole words still place a question.
    expect(nextMoveDesk({ label: "Next", question: "Which street corner fits a pop-up?" }, "audience")).toBe("location");
    expect(nextMoveDesk({ label: "Next", question: "Which zip codes over-index?" }, "audience")).toBe("location");
  });

  it("takes the desk the ANALYST put in front of a label, and leaves it off the chip's words", () => {
    // Its words alone read as audience; the prefix the director prompt asks for decides.
    const move = { label: "LOCATION · Where the fans gather", question: "Which East Nashville streets do Juniper Cola fans favour?" };
    expect(nextMoveDesk({ ...move, question: "Who are the Juniper Cola fans?" }, "investment")).toBe("location");
    expect(buildNextMoves([move], "run-1", "investment")[0]).toMatchObject({ label: "Where the fans gather", pillar: "location", deskLabel: "Location" });
    expect(nextMoveLabel("Marketing: Tour cities")).toBe("Tour cities");
    expect(nextMoveLabel("AUDIENCE - Who they are")).toBe("Who they are");
    // A desk word that opens a label without a separator is no prefix.
    expect(nextMoveLabel("Audience-first brands")).toBe("Audience-first brands");
    expect(nextMoveLabel("Audience")).toBe("Audience");
  });
});
