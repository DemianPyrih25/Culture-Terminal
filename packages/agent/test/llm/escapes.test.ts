import { describe, expect, it } from "vitest";
import { decodeInputEscapes, decodeTypedEscapes } from "../../src/llm/escapes";
import { numeralViolations } from "../../src/report/numerals";

// Built from char codes, so this file holds no raw non-ASCII character and no escape the editor resolves.
const BS = String.fromCharCode(92);
const typed = (hex: string): string => `${BS}u${hex}`;
const EN_DASH = String.fromCharCode(0x2013);
const LE = String.fromCharCode(0x2264);

describe("decodeTypedEscapes", () => {
  it("turns an escape the model typed into its character", () => {
    expect(decodeTypedEscapes(`35${typed("2013")}44 and ${typed("2264")}24`)).toBe(`35${EN_DASH}44 and ${LE}24`);
    expect(decodeTypedEscapes(`${typed("00e9")}t${typed("00C9")}`)).toBe(`${String.fromCharCode(0xe9)}t${String.fromCharCode(0xc9)}`);
  });

  it("joins a surrogate pair written as two escapes", () => {
    expect(decodeTypedEscapes(`a ${typed("d83c")}${typed("df0a")} b`)).toBe(`a ${String.fromCodePoint(0x1f30a)} b`);
  });

  it("never brings back a control, invisible, bidi or lone surrogate character", () => {
    for (const hex of ["0000", "001b", "0085", "200b", "202e", "2066", "feff", "d83c", "2028"]) {
      expect(decodeTypedEscapes(`x${typed(hex)}y`)).toBe("x y");
    }
  });

  it("leaves text without a typed escape alone, and a backslash that starts no escape", () => {
    expect(decodeTypedEscapes("plain text 35-44")).toBe("plain text 35-44");
    expect(decodeTypedEscapes(`a ${BS}u12 b ${BS}n`)).toBe(`a ${BS}u12 b ${BS}n`);
  });

  it("keeps V3 from reading the digits of a typed escape as numbers", () => {
    const text = `Flesh peaks at 35${typed("2013")}44 {{M23}}.`;
    expect(numeralViolations(text, [])).toEqual(["35"]);
    expect(numeralViolations(decodeTypedEscapes(text), [])).toEqual([]);
  });
});

describe("decodeInputEscapes", () => {
  it("decodes every string of a nested input and leaves keys, numbers and nulls alone", () => {
    const input = { thesis: `a${typed("2013")}b`, arguments: [{ qloo_fact: `${typed("2264")}24`, metric_ids: ["M1"] }], n: 2, none: null };
    expect(decodeInputEscapes(input)).toEqual({
      thesis: `a${EN_DASH}b`,
      arguments: [{ qloo_fact: `${LE}24`, metric_ids: ["M1"] }],
      n: 2,
      none: null,
    });
  });
});
