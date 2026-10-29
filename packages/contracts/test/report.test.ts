import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  compileMnemonic,
  confidenceBand,
  isVerdictTag,
  GhostAnswer,
  Intent,
  normalizeIntent,
  placeSearchMarket,
  Report,
  ReportDraft,
  ReportDraftShape,
  RunEvent,
  StoredIntent,
  strictSchemaViolations,
  structuredOutputSchema,
  SubmitPlanInput,
  SubmitPlanInputShape,
  toStrictJsonSchema,
  VERDICT_TAG_LIMITS,
  verdictTagProblems,
  zodToJsonSchema,
  type JsonSchema,
  type MetricId,
  type StepId,
  type ToolInput,
} from "../src/index";
import { draft, intent, plan, report, RUN_ID, ts } from "./fixtures";

function walk(node: unknown, visit: (n: JsonSchema, path: string) => void, path = "#"): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  const n = node as JsonSchema;
  visit(n, path);
  for (const [k, v] of Object.entries((n.properties as Record<string, unknown>) ?? {})) walk(v, visit, `${path}.${k}`);
  if (n.items) walk(n.items, visit, `${path}[]`);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = n[key];
    if (Array.isArray(list)) list.forEach((v, i) => walk(v, visit, `${path}/${key}/${i}`));
  }
}

describe("ReportDraft (submit_report input)", () => {
  const schema = toStrictJsonSchema(zodToJsonSchema(ReportDraftShape));

  it("has no optional properties anywhere, before or after the strict rewrite", () => {
    for (const s of [zodToJsonSchema(ReportDraft), schema]) {
      walk(s, (n, path) => {
        if (n.type !== "object") return;
        const props = Object.keys((n.properties as object) ?? {});
        expect([...((n.required as string[]) ?? [])].sort(), path).toEqual(props.sort());
      });
    }
  });

  it("has no unions, nullables or optionals", () => {
    const text = JSON.stringify(zodToJsonSchema(ReportDraft));
    expect(text).not.toMatch(/"anyOf"|"oneOf"|"null"/);
    expect(ReportDraftShape.safeParse({ ...draft, headline: undefined }).success).toBe(false);
  });

  it("is in the strict subset", () => {
    expect(strictSchemaViolations(schema)).toEqual([]);
  });

  it("lists the PLAN §7 fields", () => {
    expect(Object.keys(ReportDraftShape.shape).sort()).toEqual(
      [
        "headline",
        "signal",
        "verdict_tag",
        "thesis",
        "hypothesis_verdicts",
        "arguments",
        "exhibits",
        "bear_case",
        "recommendations",
        "next_moves",
        "open_questions",
      ].sort(),
    );
  });

  it("accepts a valid draft and enforces V9 limits only in the limited variant", () => {
    expect(ReportDraft.parse(draft)).toEqual(draft);
    const longHeadline = { ...draft, headline: "x".repeat(121) };
    const twoArguments = { ...draft, arguments: draft.arguments.slice(0, 2) };
    const fiveMoves = { ...draft, next_moves: Array.from({ length: 5 }, () => draft.next_moves[0]!) };
    for (const bad of [longHeadline, twoArguments, fiveMoves]) {
      expect(ReportDraft.safeParse(bad).success).toBe(false);
      expect(ReportDraftShape.safeParse(bad).success).toBe(true);
    }
  });

  it("checks id formats in the limited variant only (CHECKER V1), since strict mode strips patterns", () => {
    const swapped = { ...draft, arguments: [{ ...draft.arguments[0]!, evidence_ids: ["M1"] }, ...draft.arguments.slice(1)] };
    const tokenForm = { ...draft, hypothesis_verdicts: [{ ...draft.hypothesis_verdicts[0]!, metric_ids: ["{{M1}}"] }] };
    for (const bad of [swapped, tokenForm]) {
      expect(ReportDraft.safeParse(bad).success).toBe(false);
      expect(ReportDraftShape.safeParse(bad).success).toBe(true);
    }
  });

  it("limits open questions to 200 characters in the limited variant", () => {
    const long = { ...draft, open_questions: ["x".repeat(201)] };
    expect(ReportDraft.safeParse(long).success).toBe(false);
    expect(ReportDraftShape.safeParse(long).success).toBe(true);
    expect(ReportDraft.safeParse({ ...draft, open_questions: ["x".repeat(200)] }).success).toBe(true);
  });
});

describe("verdict tag (submit_report verdict_tag, Report.verdict.tag)", () => {
  it("takes two to five words, at most 32 characters, no digits or tokens", () => {
    for (const tag of ["Taste island", "Clear lead", "Taste island, nearest to apparel", "  Strong fit  "]) {
      expect(verdictTagProblems(tag), tag).toEqual([]);
      expect(isVerdictTag(tag), tag).toBe(true);
    }
    expect(VERDICT_TAG_LIMITS).toEqual({ wordsMin: 2, wordsMax: 5, chars: 32 });
    expect(verdictTagProblems("")).toEqual(["is empty"]);
    expect(verdictTagProblems("Island")).toEqual(["has 1 word, not 2 to 5"]);
    expect(verdictTagProblems("A taste island far from every soft drink")).toEqual([
      "has 8 words, not 2 to 5",
      "has 40 characters, more than 32",
    ]);
    expect(verdictTagProblems("Top {{M1}} pick")).toEqual(["contains digits", "contains tokens"]);
    // The window token has no digits, and the brief would print it raw.
    expect(verdictTagProblems("Taste island {{WINDOW}}")).toEqual(["contains tokens"]);
    expect(isVerdictTag("Taste island {{WINDOW}}")).toBe(false);
    expect(verdictTagProblems("Taste island [E4]")).toEqual(["contains digits", "contains tokens"]);
    expect(isVerdictTag(null)).toBe(false);
  });

  it("is enforced in the limited variant only, as custom issues on verdict_tag (CHECKER V9)", () => {
    const bad = { ...draft, verdict_tag: "Ranks 3rd of 8 brands in its category" };
    const parsed = ReportDraft.safeParse(bad);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => [i.code, i.path.join("."), i.message])).toEqual([
      ["custom", "verdict_tag", "has 8 words, not 2 to 5"],
      ["custom", "verdict_tag", "has 37 characters, more than 32"],
      ["custom", "verdict_tag", "contains digits"],
    ]);
    expect(ReportDraftShape.safeParse(bad).success).toBe(true);
  });

  it("is required by the strict tool schema and described there, yet old drafts and reports without it still parse", () => {
    const schema = toStrictJsonSchema(zodToJsonSchema(ReportDraftShape));
    const tag = (schema.properties as Record<string, JsonSchema>).verdict_tag;
    expect(schema.required).toContain("verdict_tag");
    expect(tag).toEqual({ type: "string", description: expect.stringMatching(/two to five words.*no digits/) });
    // As stored before the tag existed: JSON leaves the key out.
    const stored: unknown = JSON.parse(JSON.stringify({ ...draft, verdict_tag: undefined }));
    expect(ReportDraftShape.parse(stored).verdict_tag).toBe("");
    const env = { seq: 1, ts: ts(1), runId: RUN_ID };
    expect(RunEvent.safeParse({ ...env, type: "report.draft", draft: stored, attempt: 1 }).success).toBe(true);
    const oldReport: unknown = JSON.parse(JSON.stringify({ ...report, verdict: { ...report.verdict, tag: undefined } }));
    expect(Report.safeParse(oldReport).success).toBe(true);
    expect(Report.safeParse({ ...report, verdict: { ...report.verdict, tag: null } }).success).toBe(true);
  });
});

describe("SubmitPlanInput", () => {
  it("is strict-safe and takes two to four hypotheses", () => {
    expect(strictSchemaViolations(toStrictJsonSchema(zodToJsonSchema(SubmitPlanInput)))).toEqual([]);
    expect(SubmitPlanInput.parse(plan)).toEqual(plan);
    const five = { ...plan, hypotheses: Array.from({ length: 5 }, (_, i) => ({ ...plan.hypotheses[0]!, id: `H${i + 1}` })) };
    const one = { ...plan, hypotheses: plan.hypotheses.slice(0, 1) };
    for (const bad of [five, one]) {
      expect(SubmitPlanInput.safeParse(bad).success).toBe(false);
      expect(SubmitPlanInputShape.safeParse(bad).success).toBe(true);
    }
  });

  it("checks step and hypothesis id formats in the limited variant only", () => {
    const padded = { ...plan, steps: [{ ...plan.steps[0]!, id: "S01" }, ...plan.steps.slice(1)] };
    const lower = { ...plan, hypotheses: [{ ...plan.hypotheses[0]!, id: "h1" }, ...plan.hypotheses.slice(1)] };
    for (const bad of [padded, lower]) {
      expect(SubmitPlanInput.safeParse(bad).success).toBe(false);
      expect(SubmitPlanInputShape.safeParse(bad).success).toBe(true);
    }
  });
});

describe("Shape variants match the strict schema the API enforces", () => {
  /** An instance of a strict JSON schema: first enum value, one item per array, `str` for every free string. */
  function sample(node: JsonSchema, str: string): unknown {
    if (Array.isArray(node.enum)) return node.enum[0];
    if ("const" in node) return node.const;
    switch (node.type) {
      case "string":
        return str;
      case "integer":
      case "number":
        return 0;
      case "boolean":
        return false;
      case "array":
        return [sample(node.items as JsonSchema, str)];
      case "object":
        return Object.fromEntries(
          Object.entries(node.properties as Record<string, JsonSchema>).map(([k, v]) => [k, sample(v, str)]),
        );
      default:
        throw new Error(`unexpected schema node ${JSON.stringify(node)}`);
    }
  }

  it("accepts any input the strict schema allows, including ill-formed ids", () => {
    for (const shape of [SubmitPlanInputShape, ReportDraftShape]) {
      const strict = toStrictJsonSchema(zodToJsonSchema(shape));
      for (const str of ["{{M1}}", "S01", "", "x".repeat(1000)]) {
        expect(shape.safeParse(sample(strict, str)).success, str).toBe(true);
      }
    }
  });

  it("carries the same events whatever the id format", () => {
    const tokenForm = { ...draft, hypothesis_verdicts: [{ ...draft.hypothesis_verdicts[0]!, metric_ids: ["{{M1}}"] }] };
    const padded = { ...plan, steps: [{ ...plan.steps[0]!, id: "S01" }] };
    const env = { seq: 1, ts: ts(1), runId: RUN_ID };
    expect(RunEvent.safeParse({ ...env, type: "report.draft", draft: tokenForm, attempt: 1 }).success).toBe(true);
    expect(RunEvent.safeParse({ ...env, type: "plan", plan: padded, estimates: [] }).success).toBe(true);
  });

  it("types the structural input with plain-string ids and the parsed input with narrow ids", () => {
    expectTypeOf<ReportDraftShape["arguments"][number]["metric_ids"][number]>().toEqualTypeOf<string>();
    expectTypeOf<SubmitPlanInputShape["steps"][number]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<ReportDraft["arguments"][number]["metric_ids"][number]>().toEqualTypeOf<MetricId>();
    expectTypeOf<ToolInput<"submit_plan">>().toEqualTypeOf<SubmitPlanInput>();
    expectTypeOf<SubmitPlanInput["steps"][number]["id"]>().toEqualTypeOf<StepId>();
  });
});

describe("Intent (CLERK structured output)", () => {
  const schema = zodToJsonSchema(Intent, "output");

  it("uses only the structured-output subset, without any rewrite", () => {
    expect(strictSchemaViolations(schema)).toEqual([]);
  });

  it("uses nullable fields instead of optional ones", () => {
    walk(schema, (n, path) => {
      if (n.type !== "object") return;
      expect([...(n.required as string[])].sort(), path).toEqual(Object.keys(n.properties as object).sort());
    });
    expect(JSON.stringify(schema)).toContain('"type":"null"');
  });

  it("reads a stored intent from before Intent.geo carried a market as market null, and requires it from CLERK", () => {
    const legacyGeo = { metro: intent.geo.metro, area: intent.geo.area, unsupported_place: intent.geo.unsupported_place };
    const legacy = { ...intent, geo: legacyGeo };
    expect(Intent.safeParse(legacy).success).toBe(false);
    expect(StoredIntent.parse(legacy)).toEqual({ ...intent, geo: { ...legacyGeo, market: null, target_metro: null, cities: [] } });
    const event = { seq: 2, ts: ts(1), runId: RUN_ID, type: "clerk", intent: legacy, ms: 900 };
    expect(RunEvent.parse(event)).toMatchObject({ type: "clerk", intent: { geo: { market: null } } });
  });

  it("backfills the Part 9 intent fields of a stored intent, and requires them from CLERK", () => {
    const geo: Record<string, unknown> = { ...intent.geo };
    delete geo.target_metro;
    delete geo.cities;
    const constraints: Record<string, unknown> = { ...intent.constraints };
    delete constraints.concept_description;
    const legacy: Record<string, unknown> = { ...intent, geo, constraints };
    delete legacy.read_as;
    expect(Intent.safeParse(legacy).success).toBe(false);
    expect(StoredIntent.parse(legacy)).toEqual(intent);
    // A stored value is kept, never overwritten by the backfill.
    const twin = { ...intent, geo: { ...intent.geo, target_metro: "austin" as const } };
    expect(StoredIntent.parse(twin)).toEqual(twin);
  });

  it("searches a place in the market CLERK named for it, else in the question's map city (D44)", () => {
    const geo = { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] };
    // A venue in another city than the metro is searched in its own city.
    expect(placeSearchMarket({ ...geo, metro: "chicago", market: "portland" })).toBe("portland");
    expect(placeSearchMarket({ ...geo, metro: "chicago" })).toBe("chicago");
    expect(placeSearchMarket({ ...geo, market: "st_louis" })).toBe("st_louis");
    expect(placeSearchMarket({ ...geo, metro: "chicago", market: "Not A Market" })).toBe("chicago");
    expect(placeSearchMarket({ ...geo, market: "Not A Market" })).toBeNull();
    expect(placeSearchMarket(geo)).toBeNull();
  });

  it("parses a fixture and normalises pillar and mnemonic in code", () => {
    expect(Intent.parse(intent)).toEqual(intent);
    const wrongPillar = normalizeIntent({ ...intent, pillar: "location", mnemonic: "whatever" });
    expect(wrongPillar.pillar).toBe("investment");
    expect(wrongPillar.mnemonic).toBe("JUNIPER COLA <BRAND> HLTH");
  });

  it("compiles the mnemonic for every job shape", () => {
    expect(compileMnemonic({ ...intent, job: "head_to_head" })).toBe("JUNIPER COLA VS AURORA FOOTWEAR");
    const geo = { ...intent.geo, metro: "nashville" as const, area: "Marlowe Ridge" };
    expect(compileMnemonic({ ...intent, job: "tenant_mix", geo })).toBe("MARLOWE RIDGE, NASHVILLE TEN");
    const concept = { ...intent.constraints, concepts: ["listening bar"] };
    const site = { ...intent, job: "site_selection" as const, geo, constraints: concept };
    expect(compileMnemonic(site)).toBe("LISTENING BAR SITE NASHVILLE");
    expect(compileMnemonic({ ...intent, job: "taste_twins", geo: { ...geo, target_metro: "austin" } })).toBe(
      "MARLOWE RIDGE, NASHVILLE TWIN AUSTIN",
    );
    expect(compileMnemonic({ ...intent, job: "taste_twins", geo })).toBe("MARLOWE RIDGE, NASHVILLE TWIN <CITY>");
    const cities = { ...intent.geo, cities: ["austin", "nashville", "denver"] };
    expect(compileMnemonic({ ...intent, job: "city_compare", geo: cities })).toBe("AUSTIN VS NASHVILLE VS DENVER CITY");
    expect(compileMnemonic({ ...intent, job: "city_compare", geo: cities, constraints: concept })).toBe(
      "AUSTIN VS NASHVILLE VS DENVER CITY LISTENING BAR",
    );
    expect(compileMnemonic({ ...intent, job: "city_compare" })).toBe("<CITY> VS <CITY> CITY");
    expect(compileMnemonic({ ...intent, job: "launch_test", constraints: concept })).toBe("LISTENING BAR LNCH");
    expect(compileMnemonic({ ...intent, job: "brand_collab" })).toBe("JUNIPER COLA <BRAND> COLLAB");
    expect(compileMnemonic({ ...intent, job: "creator_fit" })).toBe("JUNIPER COLA <BRAND> CRTR");
  });

  it("GhostAnswer is in the structured-output subset too", () => {
    expect(strictSchemaViolations(zodToJsonSchema(GhostAnswer, "output"))).toEqual([]);
  });

  it("keeps enum constraints in the structured-output format", () => {
    const format = structuredOutputSchema(Intent);
    expect(strictSchemaViolations(format)).toEqual([]);
    const job = (format.properties as Record<string, JsonSchema>).job;
    expect(job?.enum).toEqual(expect.arrayContaining(["brand_health", "audience_discovery"]));
  });
});

describe("strictSchemaViolations", () => {
  it("catches each kind of violation", () => {
    const cases: [z.ZodType, RegExp][] = [
      [z.object({ a: z.string().optional() }), /optional/],
      [z.object({ a: z.string().max(3) }), /maxLength/],
      [z.object({ a: z.array(z.string()).max(2) }), /maxItems/],
      [z.object({ a: z.number().min(0) }), /minimum/],
      [z.object({ a: z.record(z.string(), z.string()) }), /additionalProperties|propertyNames/],
      [z.looseObject({ a: z.string() }), /additionalProperties/],
      [z.object({ a: z.string().regex(/^x$/) }), /pattern/],
    ];
    for (const [schema, reason] of cases) {
      expect(strictSchemaViolations(zodToJsonSchema(schema, "output")).join("\n")).toMatch(reason);
    }
  });

  it("refuses to rewrite records into the strict subset", () => {
    expect(() => toStrictJsonSchema(zodToJsonSchema(z.object({ a: z.record(z.string(), z.string()) })))).toThrow();
  });
});

describe("Report", () => {
  it("parses an assembled report", () => {
    expect(Report.parse(report)).toEqual(report);
  });

  it("bands confidence at 75 and 50", () => {
    expect([100, 75, 74, 50, 49, 0].map(confidenceBand)).toEqual(["HIGH", "HIGH", "MED", "MED", "LOW", "LOW"]);
  });
});
