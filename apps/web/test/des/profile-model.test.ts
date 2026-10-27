// The profile's model (N14) from a tearsheet: the words of the key numbers, the lean thresholds, the
// age-span merge behind "Fans lean male and 35–54.", tag families, the neighbour columns, the travel
// rows, the How we know sources, and "No data" whenever a part is missing. Invented entities only (D29).
import { describe, expect, it, vi } from "vitest";
import type { Tearsheet } from "../../components/des/model";
import {
  NEIGHBOUR_ROWS,
  TRAVEL_ROWS,
  ageLean,
  ageSpan,
  buildProfile,
  fansTitle,
  freshText,
  genderLean,
  joinNames,
  parseIndex,
  reachWord,
  signed,
  softCase,
  sourceTitle,
} from "../../components/des/profile-model";
import { stateAbbr } from "../../components/des/us-states";
import { desDeps, OPEN_LIMITS, request } from "./support";

vi.mock("server-only", () => ({}));

const { DesService } = await import("../../server/des/service");

async function sheetOf(name: string): Promise<Tearsheet> {
  const outcome = await new DesService(desDeps(), { limits: OPEN_LIMITS }).describe(request(name));
  if (outcome.kind !== "ready") throw new Error(`no tearsheet for ${name}: ${outcome.kind}`);
  return outcome.sheet;
}

const SHEET = await sheetOf("Juniper Cola");

const row = (label: string, value: number | null) => ({ key: label, label, value });

describe("words and numbers", () => {
  it("signs an index with a true minus and reads a display back", () => {
    expect(signed(0.214)).toBe("+0.21");
    expect(signed(-0.12)).toBe("−0.12");
    expect(signed(0.001)).toBe("0.00");
    expect(parseIndex("+0.59")).toBe(0.59);
    expect(parseIndex("−0.12")).toBe(-0.12);
    expect(parseIndex("0.78")).toBe(0.78);
    expect(parseIndex("not measured")).toBeNull();
  });

  it("words reach as a top share, at least 1%", () => {
    expect(reachWord(0.96)).toBe("Top 4%");
    expect(reachWord(0.78)).toBe("Top 22%");
    expect(reachWord(1)).toBe("Top 1%");
    expect(reachWord(1.4)).toBe("Top 1%");
  });

  it("words the age and gender leans with a 0.05 band around even", () => {
    expect(ageLean(-0.12)).toBe("Leans older");
    expect(ageLean(0.06)).toBe("Leans younger");
    expect(ageLean(0.05)).toBe("Even age mix");
    expect(genderLean(-0.21)).toBe("Leans male");
    expect(genderLean(0.11)).toBe("Leans female");
    expect(genderLean(-0.05)).toBe("Even gender mix");
  });

  it("merges adjacent age groups into one span", () => {
    expect(ageSpan(["35–44", "45–54"])).toBe("35–54");
    expect(ageSpan(["45–54", "55+"])).toBe("45+");
    expect(ageSpan(["≤24", "25–29"])).toBe("under 30");
    expect(ageSpan(["≤24"])).toBe("under 25");
    expect(ageSpan(["30–34"])).toBe("30–34");
    expect(ageSpan([])).toBeNull();
  });

  it("titles who the fans are from the gender lean and the strongest above-average age span", () => {
    const gender = [row("Men", 0.21), row("Women", -0.21)];
    const ages = [row("18–24", -0.15), row("25–34", -0.04), row("35–44", 0.12), row("45–54", 0.14), row("55+", -0.06)];
    expect(fansTitle(gender, ages)).toBe("Fans lean male and 35–54.");
    expect(fansTitle([row("Women", 0.02)], ages)).toBe("Fans skew 35–54.");
    expect(fansTitle([row("Women", 0.3)], [row("18–24", -0.1)])).toBe("Fans lean female.");
    expect(fansTitle([], [])).toBe("Fans look like the average audience.");
  });

  it("joins names, softens tag case, and abbreviates states", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(softCase("Health Conscious")).toBe("health conscious");
    expect(softCase("TV Lover")).toBe("TV lover");
    expect(stateAbbr("Montana")).toBe("MT");
    expect(stateAbbr("north carolina")).toBe("NC");
    expect(stateAbbr("UT")).toBe("UT");
    expect(stateAbbr("Ontario")).toBeNull();
  });

  it("words a request and its freshness", () => {
    expect(sourceTitle({ endpoint: "/search", filterLabel: null, purpose: null })).toBe("Name matched in Qloo");
    expect(sourceTitle({ endpoint: "/v2/insights", filterLabel: "demographics", purpose: null })).toBe("Age and gender of the fans");
    expect(sourceTitle({ endpoint: "/v2/insights", filterLabel: "tv show", purpose: null })).toBe("What their fans like on TV");
    expect(sourceTitle({ endpoint: "/v2/insights", filterLabel: "destination", purpose: null })).toBe("Places their fans travel to");
    expect(sourceTitle({ endpoint: "/entities", filterLabel: null, purpose: null })).toBe("How Qloo describes it");
    expect(freshText({ cache: "hit", cacheLabel: "cached 2h" }, "2026-10-23T09:00:00.000Z")).toBe("Saved copy, 2h old");
    expect(freshText({ cache: "reused", cacheLabel: "cached" }, "2026-10-23T09:00:00.000Z")).toBe("Saved copy");
    expect(freshText({ cache: "miss", cacheLabel: "live" }, "2026-10-23T09:00:00.000Z")).toBe("Fetched live, 23 Oct, 09:00 UTC");
  });
});

describe("buildProfile", () => {
  const profile = buildProfile(SHEET, null);

  it("heads the page with the name, its type, the date and an audience question", () => {
    expect(profile.name).toBe("Juniper Cola");
    expect(profile.labelLine).toMatch(/^Brand · Audience profile · Data as of \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    expect(profile.lookedUpAs).toBeNull();
    expect(profile.askHref).toBe("/ask?q=Who%20is%20the%20Juniper%20Cola%20audience%3F");
    expect(buildProfile(SHEET, "2026-10-23T08:30:00.000Z").labelLine).toContain("Data as of 23 Oct 2026");
  });

  it("words the three key numbers, each with the request behind it", () => {
    expect(profile.keyNumbers.map((k) => [k.id, k.value, k.label])).toEqual([
      ["reach", "Top 22%", "How widely known"],
      ["age", "Leans younger", "Age lean"],
      ["gender", "Leans female", "Gender lean"],
    ]);
    expect(profile.keyNumbers.every((k) => k.receipt !== null)).toBe(true);
  });

  it("reads who the fans are, men first, and the tag families Look, Tone and Lifestyle", () => {
    expect(profile.fans.rows.slice(0, 2).map((r) => r.label)).toEqual(["Men", "Women"]);
    expect(profile.fans.rows).toHaveLength(8);
    expect(profile.fans.title).toBe("Fans lean female and 30–44.");
    expect(profile.tags.families.map((f) => f.label)).toEqual(["Look", "Tone", "Lifestyle"]);
    expect(profile.tags.families.every((f) => f.tags.length > 0 && f.tags.length <= 3)).toBe(true);
    expect(profile.tags.title).toBe("Bold, earnest and busy parent.");
  });

  it("lists five names per domain in Music, Podcasts, TV and Brands, linked to their profiles", () => {
    expect(profile.neighbours.columns.map((c) => c.label)).toEqual(["Music", "Podcasts", "TV", "Brands"]);
    for (const column of profile.neighbours.columns) expect(column.rows).toHaveLength(NEIGHBOUR_ROWS);
    expect(profile.neighbours.columns[0]?.rows[0]).toMatchObject({ rank: 1, name: "Lyric and the Tides", href: "/d/Lyric%20and%20the%20Tides?type=artist" });
    expect(profile.neighbours.columns[1]?.rows.some((r) => r.gem)).toBe(true);
    expect(profile.neighbours.title).toMatch(/^Fans also love .+, .+ and .+\.$/);
  });

  it("ranks five places their fans travel to, the first one named in the title", () => {
    expect(profile.travel.rows).toHaveLength(TRAVEL_ROWS);
    expect(profile.travel.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(profile.travel.rows[0]?.label).toMatch(/, [A-Z]{2}$/);
    const fits = profile.travel.rows.map((r) => r.fit);
    expect([...fits].sort((a, b) => b - a)).toEqual(fits);
    expect(profile.travel.title).toBe(`Their taste travels furthest to ${profile.travel.rows[0]?.label.split(",")[0]}.`);
  });

  it("lists every request for How we know, with what it was for and how fresh it is", () => {
    expect(profile.how.sources).toHaveLength(SHEET.receipts.length);
    expect(profile.how.sources[0]?.title).toBe("Name matched in Qloo");
    expect(profile.how.sources.every((s) => /^(Saved copy|Fetched live)/.test(s.fresh))).toBe(true);
    expect(profile.how.requests).toBe(profile.how.saved + profile.how.live);
    expect(profile.how.matched).toContain("matched exactly");
    expect(buildProfile({ ...SHEET, picked: true }, null).how.matched).toContain("You picked this one");
  });

  it("says No data, never zero, when a part is missing", () => {
    const empty = (gap: string) => ({ status: "empty" as const, figures: [], notes: [], gap });
    const bare: Tearsheet = {
      ...SHEET,
      keyFigures: [],
      sections: { dna: empty("No demographics."), neighbours: empty("No neighbours."), travel: empty("No places.") },
    };
    const p = buildProfile(bare, null);
    expect(p.keyNumbers.map((k) => k.value)).toEqual(["No data", "No data", "No data"]);
    expect(p.keyNumbers.every((k) => k.receipt === null)).toBe(true);
    expect(p.fans.rows).toEqual([]);
    expect(p.fans.gap).toBe("No demographics.");
    expect(p.tags.families).toEqual([]);
    expect(p.neighbours.columns).toEqual([]);
    expect(p.neighbours.gap).toBe("No neighbours.");
    expect(p.travel.rows).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/"0(\.0+)?"/);
  });

  it("carries no Qloo entity id", () => {
    expect(JSON.stringify(profile)).not.toMatch(/mock-ent-|urn:/);
  });
});
