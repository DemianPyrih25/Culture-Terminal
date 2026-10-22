import { describe, expect, it } from "vitest";
import {
  compareIds,
  EvidenceIdSchema,
  extractEvidenceIds,
  extractMetricIds,
  findMalformedTokens,
  idNumber,
  isId,
  makeId,
  METRIC_TOKEN_RE,
  MetricIdSchema,
  nextId,
  stripTokens,
  tokenizeProse,
  EVIDENCE_TOKEN_RE,
} from "../src/index";

describe("ids", () => {
  it("accepts prefix + positive integer without leading zeros", () => {
    expect(MetricIdSchema.safeParse("M12").success).toBe(true);
    for (const bad of ["M0", "M012", "E12", "m12", "M", "M1.5", " M1"]) {
      expect(MetricIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(EvidenceIdSchema.safeParse("E4").success).toBe(true);
  });

  it("makes, reads, orders and allocates ids", () => {
    expect(makeId("D", 3)).toBe("D3");
    expect(() => makeId("D", 0)).toThrow();
    expect(idNumber("F10")).toBe(10);
    expect(idNumber("X1")).toBeNull();
    expect(isId("R", "R2")).toBe(true);
    expect(isId("R", "T2")).toBe(false);
    expect(["M10", "E2", "M2", "M1"].sort(compareIds)).toEqual(["E2", "M1", "M2", "M10"]);
    expect(nextId("M", [])).toBe("M1");
    expect(nextId("M", ["M1", "M7", "E9", "M3"])).toBe("M8");
  });
});

describe("prose tokens (D6)", () => {
  const prose = "Similarity is {{M12}} [E4], up from {{M3}} over {{WINDOW}}; see [E4] and [E10].";

  it("tokenizes metric, evidence and window tokens in order", () => {
    expect(tokenizeProse(prose)).toEqual([
      { kind: "text", text: "Similarity is " },
      { kind: "metric", id: "M12" },
      { kind: "text", text: " " },
      { kind: "evidence", id: "E4" },
      { kind: "text", text: ", up from " },
      { kind: "metric", id: "M3" },
      { kind: "text", text: " over " },
      { kind: "window" },
      { kind: "text", text: "; see " },
      { kind: "evidence", id: "E4" },
      { kind: "text", text: " and " },
      { kind: "evidence", id: "E10" },
      { kind: "text", text: "." },
    ]);
    expect(tokenizeProse("")).toEqual([]);
  });

  it("extracts unique ids and strips tokens", () => {
    expect(extractMetricIds(prose)).toEqual(["M12", "M3"]);
    expect(extractEvidenceIds(prose)).toEqual(["E4", "E10"]);
    expect(stripTokens(prose)).not.toMatch(/\d/);
  });

  it("exports non-global regexes that are safe to reuse", () => {
    expect(METRIC_TOKEN_RE.global).toBe(false);
    expect(METRIC_TOKEN_RE.test("{{M1}}")).toBe(true);
    expect(METRIC_TOKEN_RE.test("{{M1}}")).toBe(true);
    expect(EVIDENCE_TOKEN_RE.test("[M1]")).toBe(false);
  });

  it("flags token-like text that is not a token", () => {
    expect(findMalformedTokens("ok {{M1}} [E2] {{WINDOW}}")).toEqual([]);
    expect(findMalformedTokens("bad {{ M12 }} {{m3}} {M3} [M4] [E04] {{E5}}")).toEqual([
      "{{ M12 }}",
      "{{m3}}",
      "{M3}",
      "[M4]",
      "[E04]",
      "{{E5}}",
    ]);
  });

  it("flags bracketed citation lists and ranges, but not adjacent tokens or plain brackets", () => {
    const lists = ["[E4, E5]", "[E4,E5]", "[E4; E5]", "[E4-E6]", "[E4-6]", "[E12, E13]", "[E4 and E5]"];
    expect(findMalformedTokens(`high overlap ${lists.join(" ")}.`)).toEqual(lists);
    for (const list of lists) {
      expect(extractEvidenceIds(list), list).toEqual([]);
      expect(stripTokens(list), list).toBe(list);
    }
    expect(findMalformedTokens("ok [E4][E5] in [Q3 2024] [sic]")).toEqual([]);
  });
});
