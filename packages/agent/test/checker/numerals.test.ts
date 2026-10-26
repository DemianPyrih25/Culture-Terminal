import { describe, expect, it } from "vitest";
import { areaAliases, mergedAgeBuckets, numberWords, numeralNames, numeralValues, numeralViolations } from "../../src/report/numerals";

const bare = (text: string, names: readonly string[] = []) => numeralViolations(text, names);

describe("numeralViolations (V3)", () => {
  it.each([
    ["Similarity is 0.62.", ["0.62"]],
    ["It grew .5 points.", [".5"]],
    ["Up 45% on peers.", ["45%"]],
    ["Up 4 percent and 3 pp.", ["4 percent", "3 pp"]],
    ["Over 1,200 venues.", ["1,200"]],
    ["It ranks 11th of 40.", ["11", "40"]],
    ["A 1.5x lift.", ["1.5"]],
    ["Scores of +12 and -15.", ["12", "15"]],
  ])("flags %j", (text, expected) => {
    expect(bare(text)).toEqual(expected);
  });

  it.each([
    "It ranks 3rd of 7 peers.",
    "Ten metros, 10 at most.",
    "Back in 1999 and again in 2025.",
    "Over the window 2025-04-01..2025-09-30.",
    "Ages ≤24, 25–29, 30-34, 35 to 44, 45—54 and 55+ all appear.",
    "Bucket 25_to_29 beats 55_and_older and 24_and_younger.",
    "Ages 55 and older and 24 and younger.",
    "Q3 for Web3 brands; see M12 and H2.",
    "Tokens {{M12}} and [E14] and {{WINDOW}} carry the numbers.",
  ])("allows %j", (text) => {
    expect(bare(text)).toEqual([]);
  });

  it("allows digits only inside registered names, case-insensitively", () => {
    const names = numeralNames(["Studio 54 Lounge", "Brand Alpha", "Route 66 Diner", "Route 66 Diner West"]);
    expect(names).toEqual(["Route 66 Diner West", "Studio 54 Lounge", "Route 66 Diner"]);
    expect(bare("Fans of studio 54 lounge and Route 66 Diner West overlap.", names)).toEqual([]);
    expect(bare("Fans of Studio 54 overlap.", names)).toEqual(["54"]);
  });

  it("does not treat a year-like count outside 1900–2099 as a year", () => {
    expect(bare("About 2150 rows and 1850 cells.")).toEqual(["2150", "1850"]);
  });

  it("ignores malformed tokens, which V2 reports instead", () => {
    expect(bare("See {{ M12 }} and [E14, E15].")).toEqual([]);
  });

  it("allows a ZIP named as a ZIP, not a bare five-digit number", () => {
    expect(bare("ZIP 37206 (East Nashville) leads; ZIP code 37216, zipcode 37207 and the 37208 ZIP trail.")).toEqual([]);
    expect(bare("Over 12,000 cells near ZIP 37206; the 37206 area leads.")).toEqual(["12,000", "37206"]);
    expect(bare("ZIP 372061 is not a ZIP.")).toEqual(["372061"]);
  });

  it("allows digits inside the run metro's area names, however the dash is written", () => {
    const names = numeralNames(areaAliases(["Riverbend", "MLK-183"]));
    expect(bare("MLK-183, MLK 183 and MLK–183 lead.", names)).toEqual([]);
    expect(bare("Route 183 is not an area.", names)).toEqual(["183"]);
    expect(bare("MLK-1830 is not one either.", names)).toEqual(["1830"]);
  });

  it("allows a ZIP area's bare ZIP, short name and full name in its metro only", () => {
    expect(areaAliases(["ZIP 37206 (East Nashville)", "Elm Park"])).toEqual([
      "ZIP 37206 (East Nashville)",
      "ZIP 37206",
      "37206",
      "Elm Park",
      "Elm Park",
    ]);
    const names = numeralNames(areaAliases(["ZIP 37206 (East Nashville)"]));
    expect(bare("37206 leads; ZIP 37206 (East Nashville) again.", names)).toEqual([]);
    expect(bare("37216 trails and 372061 is no ZIP.", names)).toEqual(["37216", "372061"]);
    expect(bare("37206 leads.")).toEqual(["37206"]);
  });

  it("does not stretch age ranges beyond Qloo's buckets: a merged range counts once, as written", () => {
    expect(bare("Ages 25–44 lead.")).toEqual(["25–44"]);
  });

  it.each([
    ["Fans aged 30-44 lead.", ["30-44"]],
    ["Fans 18 to 34 and 35+ trail, as do 18–24.", ["18 to 34", "35+", "18–24"]],
    ["It holds 0.62 for 30–44 and 12 metros.", ["0.62", "30–44", "12"]],
  ])("reads bucket-merging age ranges in place: %j", (text, expected) => {
    expect(bare(text)).toEqual(expected);
  });

  it("counts numbers one by one where bucket edges make no age range", () => {
    expect(bare("A 25–34% band.")).toEqual(["25", "34%"]);
    expect(bare("Scores 45-24 and 30-44.5.")).toEqual(["45", "24", "30", "44.5"]);
  });

  it.each([
    ["It ranks eleventh of twelve.", ["eleventh", "twelve"]],
    ["Last of Twelve in Riverton.", ["Twelve"]],
    ["Twenty-one of forty metros, a dozen of them close.", ["Twenty-one", "forty", "dozen"]],
    ["Ahead in thirty second slots and a hundred venues.", ["thirty second", "hundred"]],
    ["It holds 0.62 in nineteen metros.", ["0.62", "nineteen"]],
  ])("counts a number above ten spelled out like its digits: %j", (text, expected) => {
    expect(bare(text)).toEqual(expected);
  });

  it.each([
    "Third of eight brands, ten at most.",
    "Half a dozen peers trail; dozens and hundreds of fans, thousands of plays.",
    "Seventh place, second tier, first of the ninth.",
  ])("allows number words up to ten, plurals and half a dozen: %j", (text) => {
    expect(bare(text)).toEqual([]);
  });

  it("allows number words inside registered names", () => {
    const names = numeralNames(["Fifteen Elms Market", "Brand Alpha", "Club Twenty-Two"]);
    expect(names).toEqual(["Fifteen Elms Market", "Club Twenty-Two"]);
    expect(bare("Fans of Fifteen Elms Market and club twenty-two overlap.", names)).toEqual([]);
    expect(bare("Fifteen brands overlap.", names)).toEqual(["Fifteen"]);
  });
});

describe("numberWords", () => {
  it("lists the numbers above ten a text spells out, as written", () => {
    expect(numberWords("Last of twelve, ninetieth and Twenty-First.")).toEqual(["twelve", "ninetieth", "Twenty-First"]);
    expect(numberWords("Clear lead in ten metros")).toEqual([]);
  });
});

describe("mergedAgeBuckets", () => {
  it("names the Qloo buckets a range spans when it is no bucket itself", () => {
    expect(mergedAgeBuckets("30–44")).toEqual(["30–34", "35–44"]);
    expect(mergedAgeBuckets("30-44")).toEqual(["30–34", "35–44"]);
    expect(mergedAgeBuckets("18 to 34")).toEqual(["≤24", "25–29", "30–34"]);
    expect(mergedAgeBuckets("18–24")).toEqual(["≤24"]);
    expect(mergedAgeBuckets("35+")).toEqual(["35–44", "45–54", "55+"]);
  });

  it("is null for bucket labels and anything that is not an age range", () => {
    for (const s of ["25–29", "35 to 44", "55+", "45-24", "12", "Q3", "30-40"]) expect(mergedAgeBuckets(s), s).toBeNull();
  });
});

describe("numeralValues", () => {
  it("lists the numbers a metric display shows, digits only", () => {
    expect(numeralValues("+0.56 · rank 1 of 2, youngest first")).toEqual(["0.56", "1", "2"]);
    expect(numeralValues("12 of 20 in the area top 20")).toEqual(["12", "20", "20"]);
    expect(numeralValues("1,200 venues · 45% · gh7")).toEqual(["1200", "45"]);
    expect(numeralValues("eleventh of twelve, twenty-one and a dozen")).toEqual(["11", "12", "21", "12"]);
  });
});
