import { describe, expect, it } from "vitest";
import { digitNames, numeralViolations } from "../../src/report/numerals";

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
    const names = digitNames(["Studio 54 Lounge", "Brand Alpha", "Route 66 Diner", "Route 66 Diner West"]);
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

  it("does not stretch age ranges beyond Qloo's buckets", () => {
    expect(bare("Ages 25–44 lead.")).toEqual(["25", "44"]);
  });
});
