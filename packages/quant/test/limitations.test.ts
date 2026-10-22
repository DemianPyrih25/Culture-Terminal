import { Flag, Limitation, Pillar, SEVERITY_RANK, SkillId } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  DESK_LIMITATIONS,
  FLAG_SEVERITY,
  FLAG_TEXT,
  SKILL_LIMITATIONS,
  buildLimitations,
  flagText,
  orderFlags,
} from "../src/limitations";

const WINDOW = { start: "2024-01-01", end: "2024-06-30" };
/** The guard's decimal rule (tools/guard/no-qloo-data.ts). */
const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;
const ADVICE = /\b(buy|sell|should|guaranteed|undervalued|overvalued|poaching|causes)\b/i;

const allCopy = (): string[] => [
  ...Object.values(FLAG_TEXT),
  ...Object.values(DESK_LIMITATIONS).flat(),
  ...Object.values(SKILL_LIMITATIONS).flat(),
  flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW, asOf: "2025-03-15" }),
];

describe("fixed copy", () => {
  it("has a sentence and a severity for every flag", () => {
    expect(Object.keys(FLAG_TEXT).sort()).toEqual([...Flag.options].sort());
    expect(Object.keys(FLAG_SEVERITY).sort()).toEqual([...Flag.options].sort());
  });

  it("has bullets for every desk and every skill", () => {
    for (const pillar of Pillar.options) expect(DESK_LIMITATIONS[pillar].length).toBeGreaterThan(0);
    for (const skill of SkillId.options) expect(SKILL_LIMITATIONS[skill].length).toBeGreaterThan(0);
  });

  it("is plain sentences with no long decimals and no advice", () => {
    for (const text of allCopy()) {
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toMatch(LONG_DECIMAL);
      expect(text).not.toMatch(ADVICE);
      expect(text).not.toContain("\n");
    }
  });

  it("keeps the SPEC wording for taste similarity and the tenant-fit caveat", () => {
    expect(DESK_LIMITATIONS.investment.join(" ")).toContain("not switching, share or sales");
    expect(DESK_LIMITATIONS.location.join(" ")).toContain("not credit, rent capacity, sales");
  });
});

describe("flagText", () => {
  it("names the trending window and its age", () => {
    const text = flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW, asOf: "2025-03-15T10:00:00Z" });
    expect(text).toContain("2024-01-01..2024-06-30");
    expect(text).toContain("about 8 months before this note");
  });

  it("counts whole months and uses the singular for one", () => {
    expect(flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW, asOf: "2024-07-30" })).toContain(
      "about 1 month before",
    );
    expect(flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW, asOf: "2024-07-29" })).not.toContain("about");
  });

  it("drops the age without a usable date and the window without a window", () => {
    const noAge = flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW, asOf: "not a date" });
    expect(noAge).toContain("2024-01-01..2024-06-30");
    expect(noAge).not.toContain("about");
    expect(flagText("TRENDING_HISTORICAL_WINDOW", { window: WINDOW })).not.toContain("about");
    expect(flagText("TRENDING_HISTORICAL_WINDOW")).toBe(FLAG_TEXT.TRENDING_HISTORICAL_WINDOW);
  });

  it("returns the fixed sentence for every other flag", () => {
    for (const flag of Flag.options.filter((f) => f !== "TRENDING_HISTORICAL_WINDOW")) {
      expect(flagText(flag, { window: WINDOW, asOf: "2025-03-15" })).toBe(FLAG_TEXT[flag]);
    }
  });
});

describe("orderFlags", () => {
  it("deduplicates and puts the most severe first", () => {
    const ordered = orderFlags(["THIN_RESULT", "SENSITIVE_SEGMENT_BLOCKED", "INCOMPLETE_RUN", "THIN_RESULT", "NOT_SCORED"]);
    expect(ordered).toEqual(["INCOMPLETE_RUN", "THIN_RESULT", "NOT_SCORED", "SENSITIVE_SEGMENT_BLOCKED"]);
  });

  it("orders every flag by severity, ties in Flag order, whatever the input order", () => {
    const ordered = orderFlags([...Flag.options].reverse().filter((f) => f !== "CANDIDATES_UNSCORED"));
    const ranks = ordered.map((f) => SEVERITY_RANK[FLAG_SEVERITY[f]]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    for (let i = 1; i < ordered.length; i++) {
      if (ranks[i] === ranks[i - 1]) {
        expect(Flag.options.indexOf(ordered[i]!)).toBeGreaterThan(Flag.options.indexOf(ordered[i - 1]!));
      }
    }
  });

  it("drops the CANDIDATES_UNSCORED umbrella only when a specific flag is present", () => {
    expect(orderFlags(["CANDIDATES_UNSCORED"])).toEqual(["CANDIDATES_UNSCORED"]);
    expect(orderFlags(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES"])).toEqual(["DROPPED_CANDIDATES"]);
    expect(orderFlags(["NOT_SCORED", "CANDIDATES_UNSCORED"])).toEqual(["NOT_SCORED"]);
  });
});

describe("buildLimitations", () => {
  it("orders flags, then desk bullets, then skill bullets, then open questions", () => {
    const out = buildLimitations({
      flags: ["DEMOGRAPHICS_ARE_INDICES", "BUDGET_TRUNCATED"],
      pillar: "marketing",
      openQuestions: ["Which markets respond to a summer launch?"],
      skillLimitations: ["no return on investment is estimated"],
    });
    expect(out.map((l) => l.source)).toEqual(["flag", "flag", "desk", "desk", "desk", "desk", "open_question"]);
    expect(out.slice(0, 2).map((l) => l.flag)).toEqual(["BUDGET_TRUNCATED", "DEMOGRAPHICS_ARE_INDICES"]);
    expect(out.slice(2, 5).map((l) => l.text)).toEqual(DESK_LIMITATIONS.marketing);
    expect(out[5]?.text).toBe("No return on investment is estimated.");
    expect(out[6]).toEqual({ source: "open_question", flag: null, text: "Which markets respond to a summer launch?" });
    expect(Limitation.array().parse(out)).toEqual(out);
  });

  it("covers every flag with its own sentence", () => {
    for (const flag of Flag.options) {
      const [first] = buildLimitations({ flags: [flag], pillar: "audience", openQuestions: [] });
      expect(first).toEqual({ source: "flag", flag, text: FLAG_TEXT[flag] });
    }
  });

  it("removes repeats across groups, ignoring case, spacing and closing punctuation", () => {
    const out = buildLimitations({
      flags: ["DEMOGRAPHICS_ARE_INDICES", "DEMOGRAPHICS_ARE_INDICES"],
      pillar: "location",
      openQuestions: ["  which   tenants fit best? ", "Which tenants fit best", ""],
      skillLimitations: [...SKILL_LIMITATIONS.block_dna, ...SKILL_LIMITATIONS.audience_dna, "   "],
    });
    const texts = out.map((l) => l.text);
    expect(new Set(texts.map((t) => t.toLowerCase())).size).toBe(texts.length);
    expect(texts.filter((t) => t === FLAG_TEXT.DEMOGRAPHICS_ARE_INDICES)).toHaveLength(1);
    expect(out.filter((l) => l.source === "flag")).toHaveLength(1);
    expect(out.filter((l) => l.source === "open_question").map((l) => l.text)).toEqual(["Which tenants fit best?"]);
    // block_dna repeats two location desk bullets; only its compressed-affinity sentence is new.
    expect(out.filter((l) => l.source === "desk")).toHaveLength(DESK_LIMITATIONS.location.length + 2);
  });

  it("drops a skill bullet that only restates a fixed sentence already shown", () => {
    const out = buildLimitations({
      flags: ["SUPPLY_SAMPLE_ONLY"],
      pillar: "investment",
      openQuestions: [],
      skillLimitations: [
        "Audience taste similarity, not switching, share or sales.",
        ...SKILL_LIMITATIONS.geo_lift,
        "Scores are compressed; read ranks rather than raw values.",
      ],
    });
    const texts = out.map((l) => l.text);
    expect(texts).toContain("Peer similarity is audience taste similarity, not switching, share or sales.");
    expect(texts).not.toContain("Audience taste similarity, not switching, share or sales.");
    // The geo_lift supply bullet says less than the SUPPLY_SAMPLE_ONLY flag sentence.
    expect(texts).toContain(FLAG_TEXT.SUPPLY_SAMPLE_ONLY);
    expect(texts).not.toContain("Supply counts venues Qloo indexes, not every business in the area.");
    expect(texts).toContain("Scores are compressed; read ranks rather than raw values.");
  });

  it("keeps a bullet that adds a word or drops a negation", () => {
    const out = buildLimitations({
      flags: [],
      pillar: "investment",
      openQuestions: ["Does peer similarity reflect switching?"],
      skillLimitations: [
        "Audience taste similarity, not switching, share, sales or loyalty.",
        "Peer similarity is audience taste similarity: switching, share or sales.",
      ],
    });
    const skillTexts = out.slice(DESK_LIMITATIONS.investment.length).map((l) => l.text);
    expect(skillTexts).toEqual([
      "Audience taste similarity, not switching, share, sales or loyalty.",
      "Peer similarity is audience taste similarity: switching, share or sales.",
      "Does peer similarity reflect switching?",
    ]);
  });

  it("never drops a flag sentence or an open question for restating", () => {
    const out = buildLimitations({
      flags: ["SUPPLY_SAMPLE_ONLY", "THIN_RESULT"],
      pillar: "location",
      openQuestions: ["Supply counts venues, not every business?"],
    });
    expect(out.filter((l) => l.source === "flag")).toHaveLength(2);
    expect(out.at(-1)).toEqual({ source: "open_question", flag: null, text: "Supply counts venues, not every business?" });
  });

  it("drops no fixed bullet of any desk or skill when no flag is raised", () => {
    const skillLimitations = SkillId.options.flatMap((s) => SKILL_LIMITATIONS[s]);
    for (const pillar of Pillar.options) {
      const texts = new Set(buildLimitations({ flags: [], pillar, openQuestions: [], skillLimitations }).map((l) => l.text));
      for (const text of [...DESK_LIMITATIONS[pillar], ...skillLimitations]) expect(texts).toContain(text);
    }
  });

  it("passes the trending window to the flag sentence", () => {
    const out = buildLimitations({
      flags: ["TRENDING_HISTORICAL_WINDOW"],
      pillar: "investment",
      openQuestions: [],
      window: WINDOW,
      asOf: "2025-06-30",
    });
    expect(out[0]?.text).toContain("2024-01-01..2024-06-30, about 12 months before this note");
  });

  it("gives only desk bullets when there is nothing else", () => {
    const out = buildLimitations({ flags: [], pillar: "audience", openQuestions: [] });
    expect(out).toEqual(DESK_LIMITATIONS.audience.map((text) => ({ source: "desk", flag: null, text })));
  });
});
