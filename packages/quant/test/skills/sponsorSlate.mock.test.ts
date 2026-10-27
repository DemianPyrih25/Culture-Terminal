// sponsor_slate through the real @ct/qloo client over the synthetic mock transport and the memory
// store: every request passes the allowlist validator (a refused one would surface as a failed call,
// so the test records every error), and the mock answers tag lookups, discovery, the one-scale call
// and the market calls. No network, no key, invented entities only (D29).
import { ModelDigest, QuadrantPayload, SlatePayload, digestFits, type LocalityApi, type MarketId, type QlooApi } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type QlooTool } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { sponsorSlateSkill } from "../../src/skills/sponsorSlate";
import { fakeRun, FakeRegistry } from "./support/fakes";

function mockTool(): QlooTool {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-slate-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  })
    .standalone({ pillar: "marketing" })
    .forTool(null);
}

/** The tool with every thrown error recorded, so a swallowed validation failure still fails the test. */
function watched(tool: QlooTool): { api: QlooApi; errors: unknown[] } {
  const errors: unknown[] = [];
  const watch =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        errors.push(err);
        throw err;
      }
    };
  return {
    api: {
      search: watch(tool.search.bind(tool)),
      entities: watch(tool.entities.bind(tool)),
      tags: watch(tool.tags.bind(tool)),
      audiences: watch(tool.audiences.bind(tool)),
      insights: watch(tool.insights.bind(tool)) as QlooApi["insights"],
      trending: watch(tool.trending.bind(tool)),
    },
    errors,
  };
}

async function firstId(tool: QlooTool, query: string, type: string): Promise<{ id: string; name: string; popularity: number | null }> {
  const hit = (await tool.search({ query, types: [type], take: 5 })).data.results[0]!;
  return { id: hit.entity_id, name: hit.name, popularity: hit.popularity ?? null };
}

describe("sponsor_slate over the mock transport", () => {
  it("makes only allowlisted calls, builds the slate with markets and gets cheaper once cached", async () => {
    const tool = mockTool();
    const registry = new FakeRegistry();
    const seed = await firstId(tool, "Artist Nova", "urn:entity:artist");
    registry.registerEntity({ entityId: seed.id, name: seed.name, type: "artist", popularity: seed.popularity, disambiguation: null, tags: [] });
    const brand = await firstId(tool, "Brand Alpha", "urn:entity:brand");
    registry.registerEntity({ entityId: brand.id, name: brand.name, type: "brand", popularity: brand.popularity, disambiguation: null, tags: [] });
    // What kv would pin for each market: the mock's locality ids, never in git.
    const pins = new Map<MarketId, { entityId: string; label: string }>();
    for (const [market, query] of [["nashville", "Nashville"], ["austin", "Austin"]] as const) {
      pins.set(market, { entityId: (await firstId(tool, query, "urn:entity:locality")).id, label: query });
    }
    const localities: LocalityApi = { market: async (id) => pins.get(id) ?? null };

    const input = sponsorSlateSkill.input.parse({
      seed: "R1",
      categories: ["beer", "energy_drinks", "outdoor_sporting_retail"],
      shortlist: ["R2"],
      markets: ["nashville", "austin"],
      trigger_finding_id: null,
      step_id: null,
    });
    const cold = await sponsorSlateSkill.estimateCalls(input, tool, registry);
    expect(cold).toBe(1 + 2 + 1 + 1 + 2);

    const { api, errors } = watched(tool);
    const run = fakeRun(api, registry);
    Object.assign(run.ctx, { localities });
    const result = await sponsorSlateSkill.run(input, run.ctx);

    expect(errors).toEqual([]);
    expect(["ok", "partial"]).toContain(result.status);
    expect(result.forModel.notices.some((n) => n.startsWith("Some Qloo calls failed"))).toBe(false);
    expect(run.ledger.evidences.map((e) => e.purpose)).toEqual([
      "Category tag lookups for sponsor categories without a probe-verified tag",
      "Sponsor category discovery for Artist Nova",
      "One-scale FIT scoring of the sponsor candidates against the seed",
      "Market alignment of the sponsor slate in Nashville and Austin",
    ]);
    const kinds = run.ledger.datasets.map((d) => d.kind);
    expect(kinds).toEqual(["Slate", "Quadrant", "Slope"]);
    for (const d of run.ledger.datasets) {
      if (d.kind === "Slate") SlatePayload.parse(d.payload);
      if (d.kind === "Quadrant") QuadrantPayload.parse(d.payload);
    }
    const slate = run.ledger.datasets[0];
    if (slate?.kind !== "Slate") throw new Error("expected a Slate dataset");
    expect(slate.payload.rows.filter((r) => r.best !== null).length).toBeGreaterThan(0);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "sponsor_slate", step: null })).toBe(true);
    expect(JSON.stringify(result.forModel)).not.toContain("mock-ent-");

    // Lookups and verified discovery now come from the cache; the rest is still counted as one call each.
    expect(await sponsorSlateSkill.estimateCalls(input, tool, registry)).toBe(1 + 1 + 2);
  });
});
