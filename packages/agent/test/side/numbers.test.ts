import { describe, expect, it } from "vitest";
import { numberProblems, numberWords, unbackedNumbers } from "../../src/side/numbers";
import { cleanText } from "../../src/side/text";

describe("numberProblems (the AI block states no number)", () => {
  it("passes plain words", () => {
    expect(numberProblems("The brand recently opened several stores across the South.")).toEqual([]);
  });

  it("flags digits, separators and decimals as one run", () => {
    expect(numberProblems("It sold 1,200 cases and grew 4.5 times in 2024.")).toEqual(["1,200", "4.5", "2024"]);
  });

  it("flags digits from any script", () => {
    // Arabic-Indic five and Devanagari three, built from char codes.
    const text = `Opened ${String.fromCharCode(0x0665)} and ${String.fromCharCode(0x0969)} shops`;
    expect(numberProblems(text)).toHaveLength(2);
  });

  it("flags percent and currency signs", () => {
    expect(numberProblems("Margins are up % and prices in $ and €, £, ¥")).toEqual(["%", "$", "€", "£", "¥"]);
  });

  it("flags spelled numbers, ordinals and quantity words as whole words, any case", () => {
    expect(numberWords("Three new sites, a Dozen partners, the first store, Half the menu, per cent of sales")).toEqual([
      "three",
      "dozen",
      "first",
      "half",
      "per cent",
    ]);
    expect(numberWords("Hundreds of fans and millions of views; twice the reach")).toEqual(["hundreds", "millions", "twice"]);
  });

  it("does not flag words that merely contain a number word", () => {
    expect(numberWords("Someone often attends; the tone is honest and the network is weighty")).toEqual([]);
  });

  it("exempts 'one of', 'no one' and 'second-hand'", () => {
    expect(numberWords("It is one of the best-known chains; no one disputes its second-hand market.")).toEqual([]);
    expect(numberWords("One store, and one of the chains")).toEqual(["one"]);
  });
});

describe("unbackedNumbers (a web claim's numbers must be in its cited passage)", () => {
  it("accepts a claim whose numbers the passage states, separators ignored", () => {
    expect(unbackedNumbers("The chain opened 1,200 stores in 2025.", "now runs 1200 stores after a 2025 push")).toEqual([]);
  });

  it("rejects a digit run the passage lacks, never matching inside a longer run", () => {
    expect(unbackedNumbers("It has 20 stores.", "founded in 2020 with a few stores")).toEqual(["20"]);
  });

  it("requires signs and number words verbatim", () => {
    expect(unbackedNumbers("Sales rose 12%.", "sales rose 12 points")).toEqual(["%"]);
    expect(unbackedNumbers("It opened three stores.", "it opened 3 stores")).toEqual(["three"]);
    expect(unbackedNumbers("It opened three stores.", "it opened three new stores")).toEqual([]);
  });

  it("accepts a claim with no numbers", () => {
    expect(unbackedNumbers("The brand was acquired by a beverage group.", "unrelated passage")).toEqual([]);
  });
});

describe("cleanText", () => {
  it("removes links, markdown, token syntax and invisible characters", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const raw = `**Bold** [the report](https://example.com/a) see https://example.com/b {{M3}} [E2]${zeroWidth} done\nnext`;
    expect(cleanText(raw)).toBe("Bold the report see M3 E2 done next");
  });
});
