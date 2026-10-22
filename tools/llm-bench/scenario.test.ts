import { describe, expect, it } from "vitest";
import { analystPrefix } from "./analyst-run";
import { approxTokens, ANALYST_TOOL_NAMES, digestFits, MODEL_DIGEST_MAX_TOKENS, ModelDigest, parseToolInput, SkillId, wrapQlooData } from "./deps";
import { toolUse } from "./fakes";
import { ANALYST_SYSTEM_PROMPT, CLERK_SYSTEM_PROMPT, SMOKE_SYSTEM_PROMPT } from "./prompts";
import {
  answerSkillCall,
  buildScenario,
  collectRefs,
  Ledger,
  QUESTION,
  Registry,
  sampleInputs,
  scriptedDigest,
  type DigestContext,
} from "./scenario";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function ctxWith(brands: number): DigestContext {
  const registry = new Registry();
  for (let i = 1; i <= brands; i++) registry.add(`Fixture Brand ${i}`, "brand");
  return { ledger: new Ledger(), registry };
}

describe("the frozen prompts", () => {
  it("give the ANALYST a system prompt of realistic size (about 6k tokens)", () => {
    const tokens = approxTokens(ANALYST_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThan(5500);
    expect(tokens).toBeLessThan(7500);
  });

  it("carry no dates, UUIDs or run data that would break the cached prefix", () => {
    for (const p of [ANALYST_SYSTEM_PROMPT, SMOKE_SYSTEM_PROMPT, CLERK_SYSTEM_PROMPT]) {
      expect(p).not.toMatch(ISO_DATE);
      expect(p).not.toMatch(UUID);
      expect(p).not.toMatch(/\bR\d+\b|\bE\d+\b/);
    }
  });

  it("use the 14 real tools, sorted by name", () => {
    const tools = analystPrefix().tools.map((t) => ("name" in t ? t.name : ""));
    expect(tools).toHaveLength(14);
    expect(tools).toEqual([...ANALYST_TOOL_NAMES]);
    expect(tools).toEqual([...tools].sort());
  });

  it("put the system prompt in one block with its own cache breakpoint", () => {
    expect(analystPrefix().system).toEqual([{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  });
});

describe("buildScenario", () => {
  it("is deterministic, so two runs send byte-identical prefixes", () => {
    const a = buildScenario();
    const b = buildScenario();
    expect(a.runContext).toBe(b.runContext);
    expect(a.scan).toEqual(b.scan);
    expect(JSON.stringify(analystPrefix())).toBe(JSON.stringify(analystPrefix()));
  });

  it("puts the question, registry and lists only in the first user message", () => {
    const s = buildScenario();
    expect(s.runContext).toContain(`<user_question>${QUESTION}</user_question>`);
    expect(s.runContext).toContain("| R1 | Juniper Cola | brand | exact |");
    expect(s.runContext).toContain("| R2 | Marlowe Ridge Sparkling | brand | exact |");
    // Refs the opening scan discovers arrive with its digests, not before the plan.
    expect(s.runContext).not.toContain("| R3 |");
    expect(s.runContext).toMatch(/MARKETS: nashville, austin/);
    expect(s.runContext).toMatch(/AUDIENCES: urn:audience:/);
    expect(s.runContext).not.toMatch(ISO_DATE);
  });

  it("issues the opening scan first: three digests within budget, with F1 to follow up on", () => {
    const s = buildScenario();
    expect(s.scan).toHaveLength(3);
    for (const wrapped of s.scan) {
      expect(approxTokens(wrapped)).toBeLessThanOrEqual(MODEL_DIGEST_MAX_TOKENS);
      expect(wrapped).not.toMatch(UUID);
    }
    expect(s.ledger.findings.get("F1")).toBe("OUTSIDE_CATEGORY_NEIGHBOUR");
    expect(s.ledger.evidence).toEqual(["E1", "E2", "E3"]);
    expect(s.registry.entities().length).toBeGreaterThan(2);
  });
});

describe("scripted digests", () => {
  const samples = sampleInputs();

  it("has a valid sample input for every skill", () => {
    for (const skill of SkillId.options) expect(parseToolInput(skill, samples[skill]).ok, skill).toBe(true);
  });

  it("produce schema-valid digests within the 1.5k-token budget for every skill", () => {
    for (const skill of SkillId.options) {
      const digest = scriptedDigest(skill, samples[skill], { ...buildScenario() });
      expect(ModelDigest.safeParse(digest).success, skill).toBe(true);
      expect(digestFits(digest, { tool: skill, step: "S1" }), `${skill} ≈ ${approxTokens(wrapQlooData(digest, { tool: skill, step: "S1" }))} tokens`).toBe(true);
    }
  });

  // SPEC §4.2: realistic 1.5k-token digests, so the bench's cost and latency are not biased low.
  it("are realistic in size: the main data digests and the opening scan carry at least 1.1k tokens", () => {
    const main = ["peer_landscape", "share_of_taste", "audience_dna", "destination_affinity", "cross_domain"] as const;
    for (const skill of main) {
      const wrapped = wrapQlooData(scriptedDigest(skill, samples[skill], { ...buildScenario() }), { tool: skill, step: "S1" });
      expect(approxTokens(wrapped), skill).toBeGreaterThanOrEqual(1100);
    }
    for (const wrapped of buildScenario().scan) expect(approxTokens(wrapped)).toBeGreaterThanOrEqual(1100);
  });

  it("stay within budget at the largest inputs the schemas allow", () => {
    const ctx = ctxWith(50);
    const refs = ctx.registry.entities().map((e) => e.ref);
    const meta = { trigger_finding_id: null, step_id: null };
    const big = [
      scriptedDigest("rank_candidates", {
        type: "brand",
        candidates: refs,
        signal_entities: refs.slice(0, 3),
        signal_tags: [],
        contexts: [{ kind: "none" }, { kind: "city", metro: "austin" }, { kind: "age", age: "55_and_older" }],
        ...meta,
      }, ctx),
      scriptedDigest("share_of_taste", { ...samples.share_of_taste, set: refs.slice(0, 8), ...meta }, ctx),
      scriptedDigest("audience_dna", { set: refs.slice(0, 12), compare_with: refs[12] ?? null, ...meta }, ctx),
      scriptedDigest("peer_landscape", { target: refs[0]!, peers: refs.slice(1, 7), discover: true, k: 7, ...meta }, ctx),
      scriptedDigest("momentum", { entities: refs.slice(0, 4), type: "brand", ...meta }, ctx),
      scriptedDigest("cross_domain", { ...samples.cross_domain, seeds: refs.slice(0, 3), ...meta }, ctx),
      scriptedDigest("find_tags", { concepts: ["a", "b", "c", "d"].map((t) => ({ text: `concept ${t} with a long name`, scope: "place" as const })), ...meta }, ctx),
    ];
    for (const digest of big) {
      expect(ModelDigest.safeParse(digest).success).toBe(true);
      expect(digest.top_rows.length).toBeLessThanOrEqual(12);
      expect(digestFits(digest, { tool: "share_of_taste", step: "S12" })).toBe(true);
    }
  });

  it("flag what the real skills flag: dropped candidates, stale momentum, indices", () => {
    const ctx = ctxWith(12);
    const refs = ctx.registry.entities().map((e) => e.ref);
    const meta = { trigger_finding_id: null, step_id: null };
    const ranked = scriptedDigest("rank_candidates", { type: "brand", candidates: refs, signal_entities: [], signal_tags: [], contexts: [{ kind: "age", age: "25_to_29" }], ...meta }, ctx);
    expect(ranked.flags).toContain("DROPPED_CANDIDATES");
    expect(ranked.status).toBe("partial");
    const mom = scriptedDigest("momentum", { entities: refs.slice(0, 2), type: "brand", ...meta }, ctx);
    expect(mom.flags).toEqual(expect.arrayContaining(["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"]));
    expect(mom.metrics.every((m) => m.badge === "STALE")).toBe(true);
    expect(scriptedDigest("audience_dna", { set: refs.slice(0, 2), compare_with: null, ...meta }, ctx).flags).toContain("DEMOGRAPHICS_ARE_INDICES");
  });

  it("register discovered entities so later calls may use them", () => {
    const s = buildScenario();
    const before = s.registry.entities().length;
    const digest = scriptedDigest("cross_domain", { seeds: ["R1"], seed_tags: [], domains: ["artist"], popularity_max: 0.8, trigger_finding_id: null, step_id: null }, s);
    expect(digest.registered.length).toBeGreaterThan(0);
    expect(s.registry.entities().length).toBe(before + digest.registered.length);
  });
});

describe("answerSkillCall", () => {
  const use = (input: unknown, name = "audience_dna") => toolUse("t1", name, input);
  const dna = (trigger: string | null) => ({ set: ["R1"], compare_with: null, trigger_finding_id: trigger, step_id: "S3" });

  it("wraps a valid call's digest with its mnemonic and step", () => {
    const { result, ok } = answerSkillCall(use(dna(null)), "wave1", buildScenario());
    expect(ok).toBe(true);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toMatch(/^<qloo_data tool="DNA" step="S3">/);
  });

  it("turns every rule break into an is_error result", () => {
    const s = buildScenario();
    const cases: Array<[ReturnType<typeof use>, Parameters<typeof answerSkillCall>[1], RegExp]> = [
      [use({}, "web_fetch"), "wave1", /^UNKNOWN_TOOL/],
      [use(dna("F1")), "final", /^INVESTIGATION_BUDGET_EXHAUSTED/],
      [use({}, "submit_plan"), "followup", /^WRONG_TURN/],
      [use({ set: [] }), "wave1", /^INVALID_INPUT/],
      [use({ ...dna(null), set: ["R404"] }), "wave1", /^UNKNOWN_REF: R404/],
      [use(dna(null)), "followup", /^TRIGGER_REQUIRED/],
      [use(dna("F404")), "followup", /^UNKNOWN_FINDING: F404/],
    ];
    for (const [call, phase, pattern] of cases) {
      const { result, ok } = answerSkillCall(call, phase, s);
      expect(ok).toBe(false);
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(pattern);
    }
  });
});

describe("collectRefs", () => {
  it("finds entity and tag refs anywhere in an input", () => {
    expect(collectRefs({ a: "R1", b: ["T2", { c: "R10" }], d: "S1", e: "R0", f: 3, g: null })).toEqual(["R1", "T2", "R10"]);
  });
});
