// find_tags through the real Qloo client over the synthetic transport (QLOO_MOCK): the semantic search
// passes the frozen /v2/tags allowlist, returns taxonomy tags only, and is free once cached.
import { digestFits, ModelDigest } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { findTagsSkill } from "../../src/skills/findTags";
import { fakeRun } from "./support/fakes";

function tool() {
  const client = createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "find-tags-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
  return client.standalone({ pillar: "location" }).forTool("toolu_tags_1");
}

describe("find_tags on the synthetic transport", () => {
  it("searches live concepts for taxonomy tags only and serves curated ones free", async () => {
    const qloo = tool();
    const input = findTagsSkill.input.parse({
      concepts: [
        { text: "vinyl listening room", scope: "place" },
        { text: "oat milk", scope: "brand" },
        { text: "coffee shop", scope: "place" },
      ],
      trigger_finding_id: null,
      step_id: "S1",
    });
    expect(await findTagsSkill.estimateCalls(input, qloo, fakeRun(qloo).registry)).toBe(2);

    const run = fakeRun(qloo);
    const result = await findTagsSkill.run(input, run.ctx);
    expect(result.status).toBe("ok");
    expect(run.ledger.evidences).toHaveLength(2);
    const types = new Set(run.registry.tags().map((t) => t.type));
    expect([...types].every((t) => /^urn:tag:(?:genre|category):(?:place|brand)$/.test(t))).toBe(true);
    expect(run.registry.tags().every((t) => t.signalCapable)).toBe(true);
    const uses = (concept: string) => result.forModel.top_rows.filter((r) => r.values.concept === concept).map((r) => r.values.use);
    expect(uses("vinyl listening room").slice(0, 2)).toEqual(["heatmap_signal", "place_filter"]);
    expect(uses("oat milk").every((u) => u === "taste_signal")).toBe(true);
    expect(uses("coffee shop")).toEqual(["place_filter", "heatmap_signal"]);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "find_tags", step: "S1" })).toBe(true);

    expect(await findTagsSkill.estimateCalls(input, qloo, run.registry)).toBe(0);
  });
});
