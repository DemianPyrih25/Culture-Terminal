// Audience DNA in words (lib/answer/dna): lean words outside the ±0.1 about-level band (R1, V13), the age peak, and the
// adjacent over-indexing bands merged into one span.
import { describe, expect, it } from "vitest";
import { ageLeanWord, fansLeanTitle, genderLeanWord, peakAge, positiveAgeSpan, signed } from "../../lib/answer";

const bands = (values: (number | null)[]) => ["≤24", "25–29", "30–34", "35–44", "45–54", "55+"].map((label, i) => ({ label, value: values[i] ?? null }));

describe("lean words", () => {
  it("leans past the about-level band, reads about average inside it, and says nothing without a value", () => {
    expect(ageLeanWord(0.31)).toBe("Leans younger");
    expect(ageLeanWord(-0.12)).toBe("Leans older");
    expect(ageLeanWord(0.05)).toBe("About average on age");
    expect(ageLeanWord(0.09)).toBe("About average on age");
    // A metric the code marked about level never leans, whatever its value.
    expect(ageLeanWord(0.31, true)).toBe("About average on age");
    expect(ageLeanWord(null)).toBeNull();
    expect(genderLeanWord(0.31)).toBe("Leans female");
    expect(genderLeanWord(-0.2)).toBe("Leans male");
    expect(genderLeanWord(-0.04)).toBe("About average on gender");
  });

  it("signs values with a true minus, and never prints −0.00", () => {
    expect(signed(0.31)).toBe("+0.31");
    expect(signed(-0.18)).toBe("−0.18");
    expect(signed(-0.001)).toBe("0.00");
  });
});

describe("age span", () => {
  it("finds the peak and merges the adjacent bands that over-index", () => {
    const b = bands([0.02, 0.31, 0.24, 0.12, -0.12, -0.27]);
    expect(peakAge(b)?.label).toBe("25–29");
    expect(positiveAgeSpan(b)).toBe("25–44");
  });

  it("opens the span at the top band, and gives one band alone as is", () => {
    expect(positiveAgeSpan(bands([-0.2, -0.1, 0, 0.02, 0.1, 0.2]))).toBe("45+");
    expect(positiveAgeSpan(bands([0.01, 0.2, 0.01, 0, 0, 0]))).toBe("25–29");
    expect(positiveAgeSpan(bands([0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(positiveAgeSpan(bands([0.3, 0.2, null, 0, 0, 0]))).toBe("under 30");
  });

  it("titles the fans chart from the lean and the span", () => {
    expect(fansLeanTitle("Leans female", "35–44")).toBe("Fans lean female and 35–44.");
    expect(fansLeanTitle(null, "25–34")).toBe("Fans peak at 25–34.");
    expect(fansLeanTitle("About average on gender", null)).toBeNull();
  });
});
