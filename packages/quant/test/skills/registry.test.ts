import { ANALYST_TOOLS, DATA_NOTICE, digestFits, ModelDigest, SkillId, TOOL_MNEMONIC, type DigestRow, type EntityRegistry } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { buildSkillDigest, fitSkillDigest, orderedFlags, skillErrorResult, SKILLS, unavailableSkill } from "../../src/skills/index";
import { fakeProbe, fakeQloo, fakeRun } from "./support/fakes";

describe("SKILLS", () => {
  it("has one skill per SkillId, wired to its tool spec", () => {
    expect(Object.keys(SKILLS).sort()).toEqual([...SkillId.options].sort());
    for (const id of SkillId.options) {
      const skill = SKILLS[id];
      expect(skill.id).toBe(id);
      expect(skill.mnemonic).toBe(TOOL_MNEMONIC[id]);
      expect(skill.kitWorkflows).toEqual(ANALYST_TOOLS[id].kitWorkflows);
      expect(skill.input).toBe(ANALYST_TOOLS[id].input);
    }
  });

  it("ships S0 and S1; every other tool is a placeholder that costs nothing", async () => {
    const built = SkillId.options.filter((id) => SKILLS[id].limitations(["BUDGET_TRUNCATED"]).length > 0);
    expect(built.sort()).toEqual(["peer_landscape", "resolve_entities"]);
    const probe = fakeProbe(() => false);
    const input = SKILLS.find_tags.input.parse({
      concepts: [{ text: "listening bar", scope: "place" }],
      trigger_finding_id: null,
      step_id: null,
    });
    expect(await SKILLS.find_tags.estimateCalls(input, probe, {} as EntityRegistry)).toBe(0);
    expect(probe.asked).toHaveLength(0);
  });
});

describe("unavailableSkill", () => {
  it("answers an error digest without touching Qloo, the ledger or the registry", async () => {
    const { api, calls } = fakeQloo();
    const run = fakeRun(api);
    const skill = unavailableSkill("momentum");
    const result = await skill.run(skill.input.parse({ entities: ["R1"], type: "brand", trigger_finding_id: null, step_id: "S3" }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices).toEqual(["momentum is not available in this build; use another tool."]);
    expect(ModelDigest.parse(result.forModel).evidence_ids).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.events).toHaveLength(0);
    expect(skill.limitations(["BUDGET_TRUNCATED"])).toEqual([]);
  });
});

describe("digest helpers", () => {
  const base = {
    status: "ok" as const,
    evidenceIds: ["E1" as const],
    datasetIds: [],
    metrics: [],
    findings: [],
    registered: [],
  };

  it("orders and deduplicates flags by the Flag enum", () => {
    expect(orderedFlags(["NOT_SCORED", "BUDGET_TRUNCATED", "NOT_SCORED", "CANDIDATES_UNSCORED"])).toEqual([
      "CANDIDATES_UNSCORED",
      "BUDGET_TRUNCATED",
      "NOT_SCORED",
    ]);
  });

  it("caps rows at twelve and trims rows, then notices, until the digest fits, saying how many rows went", () => {
    const rows: DigestRow[] = Array.from({ length: 20 }, (_, i) => ({
      ref: `R${i + 1}` as const,
      name: `Brand ${i}`,
      values: { note: "x".repeat(600) },
    }));
    const digest = buildSkillDigest({ ...base, rows, flags: [], notices: ["keep me"] });
    expect(digest._data_notice).toBe(DATA_NOTICE);
    expect(digest.top_rows).toHaveLength(12);
    const target = { tool: "peer_landscape" as const, step: "S1" as const };
    expect(digestFits(digest, target)).toBe(false);
    const fitted = fitSkillDigest(digest, target, rows.length);
    expect(digestFits(fitted, target)).toBe(true);
    expect(fitted.top_rows.length).toBeLessThan(12);
    expect(fitted.notices).toEqual([`${20 - fitted.top_rows.length} of 20 rows left out to fit this result.`, "keep me"]);
    expect(digest.top_rows).toHaveLength(12);
  });

  it("points the omission notice at the dataset that holds the full table", () => {
    const rows: DigestRow[] = Array.from({ length: 8 }, (_, i) => ({ ref: `R${i + 1}` as const, name: `Brand ${i}`, values: { note: "x".repeat(900) } }));
    const digest = buildSkillDigest({ ...base, datasetIds: ["D1"], rows, flags: [], notices: [] });
    const fitted = fitSkillDigest(digest, { tool: "peer_landscape", step: null });
    expect(fitted.notices[0]).toBe(`${8 - fitted.top_rows.length} of 8 rows left out to fit this result; the full table is in D1.`);
  });

  it("shortens labels, finding texts and names rather than fail once rows and notices are gone", () => {
    const metrics = Array.from({ length: 24 }, (_, i) => ({ id: `M${i + 1}` as const, label: "y".repeat(200), display: "0.50", badge: "DERIVED" as const }));
    const digest = { ...buildSkillDigest({ ...base, rows: [], flags: [], notices: ["dropped first"] }), metrics };
    const target = { tool: "peer_landscape" as const, step: null };
    expect(digestFits({ ...digest, notices: [] }, target)).toBe(false);
    const fitted = fitSkillDigest(digest, target);
    expect(digestFits(fitted, target)).toBe(true);
    expect(fitted.metrics.map((m) => m.id)).toEqual(metrics.map((m) => m.id));
    expect(fitted.metrics.every((m) => m.label.length === 60 && m.label.endsWith("…"))).toBe(true);
    expect(fitted.notices).toEqual([]);
  });

  it("refuses a digest that cannot fit even shortened", () => {
    const metrics = Array.from({ length: 60 }, (_, i) => ({ id: `M${i + 1}` as const, label: "y".repeat(120), display: "0.50", badge: "DERIVED" as const }));
    const digest = { ...buildSkillDigest({ ...base, rows: [], flags: [], notices: [] }), metrics };
    expect(() => fitSkillDigest(digest, { tool: "peer_landscape", step: null })).toThrow(/token budget/);
  });

  it("builds an error result with nothing in it but the reason", () => {
    const result = skillErrorResult({ tool: "peer_landscape", step: null }, "R9 is not in the registry.");
    expect(result).toMatchObject({ status: "error", evidenceIds: [], metricIds: [], datasetIds: [], findingIds: [], flags: [] });
    expect(result.forModel.notices).toEqual(["R9 is not in the registry."]);
  });
});
