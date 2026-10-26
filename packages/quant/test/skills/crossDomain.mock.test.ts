// S9 cross_domain through the real Qloo client over the synthetic transport (QLOO_MOCK): the
// allowlist, the value rules, the cache and the run budget all apply as in live mode, with no
// network and invented entities only (D29). Seeds are resolved by S0 first, as a run does.
import {
  DATASET_PAYLOADS,
  DEFAULT_RUN_LIMITS,
  digestFits,
  ModelDigest,
  type DatasetOf,
  type Domain,
  type RunLimits,
} from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { isFormulaId } from "../../src/formulas";
import { crossDomainSkill } from "../../src/skills/crossDomain";
import { isExplainabilityEdge } from "../../src/skills/crossDomain/neighbourhood";
import { resolveEntitiesSkill } from "../../src/skills/resolve";
import { categoryTagOf } from "../../src/skills/peerSelection";
import { median } from "../../src/stats";
import { fakeRun } from "./support/fakes";

const ALL_DOMAINS: Domain[] = ["artist", "podcast", "tv_show", "movie", "brand"];
const INDIE = "urn:tag:genre:music:mock_indie_rock";
const CAP = 0.9;

function mockClient(): QlooClient {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "xdom-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

/** A run on the client: S0 resolves the two seeds and the seed tag is registered as find_tags would. */
async function seededRun(client: QlooClient, limits: RunLimits = DEFAULT_RUN_LIMITS) {
  const qloo = client.forRun({ runId: "run-xdom-mock", lane: "public", pillar: "audience", limits, phase: () => "wave1" }).forTool("toolu_xdom_1");
  const run = fakeRun(qloo);
  const resolved = await resolveEntitiesSkill.run(
    resolveEntitiesSkill.input.parse({
      mentions: [
        { text: "Brand Alpha", type: "brand", metro: null },
        { text: "Artist Nova", type: "artist", metro: null },
      ],
      trigger_finding_id: null,
      step_id: null,
    }),
    run.ctx,
  );
  expect(resolved.status).toBe("ok");
  run.registry.registerTag({ tagId: INDIE, name: "Indie Rock", type: "urn:tag:genre:music", signalCapable: true });
  return { ...run, qloo };
}

function input(domains: Domain[] = ALL_DOMAINS) {
  return crossDomainSkill.input.parse({
    seeds: ["R1", "R2"],
    seed_tags: ["T1"],
    domains,
    popularity_max: CAP,
    trigger_finding_id: null,
    step_id: "S2",
  });
}

function ranked(datasets: readonly { kind: string }[]): DatasetOf<"Ranked"> {
  const d = datasets.find((x) => x.kind === "Ranked");
  if (d === undefined) throw new Error("expected a Ranked dataset");
  return d as DatasetOf<"Ranked">;
}

describe("cross_domain on the mock transport", () => {
  it("sends only allowlisted requests and builds the five-domain neighbourhood", async () => {
    const client = mockClient();
    const run = await seededRun(client);
    const result = await crossDomainSkill.run(input(), run.ctx);

    expect(result.status).toBe("ok");
    const xdomEvidence = run.ledger.evidences.filter((e) => e.skill === "cross_domain");
    expect(xdomEvidence).toHaveLength(5);

    const d = ranked(run.ledger.datasets);
    expect(DATASET_PAYLOADS.Ranked.parse(d.payload)).toEqual(d.payload);
    expect(d.payload.groups.map((g) => g.key)).toEqual(ALL_DOMAINS);
    for (const g of d.payload.groups) {
      expect(g.rows).toHaveLength(15);
      for (const row of g.rows) {
        // The cap holds on every domain (P5), and a missing value always carries its reason.
        const popularity = row.cells[1]?.value;
        if (popularity !== null && popularity !== undefined) expect(popularity).toBeLessThanOrEqual(CAP);
        for (const c of row.cells) expect(c.value === null).toBe(c.reason !== null);
        for (const e of row.explain) expect(isExplainabilityEdge(e.share, 2)).toBe(true);
      }
      // A flagged pick clears the bar read off the dataset itself: FIT at or above the median FIT,
      // popularity below the median popularity, over the rows that have both.
      const flagged = g.rows.filter((r) => r.flags.includes("UTR"));
      expect(flagged.length).toBeLessThanOrEqual(1);
      const measured = g.rows.filter((r) => r.cells[0]?.value != null && r.cells[1]?.value != null);
      const medianFit = median(measured.map((r) => r.cells[0]?.value ?? 0)) ?? 0;
      const medianPopularity = median(measured.map((r) => r.cells[1]?.value ?? 0)) ?? 0;
      for (const r of flagged) {
        expect(r.cells[0]?.value ?? -1).toBeGreaterThanOrEqual(medianFit - 1e-9);
        expect(r.cells[1]?.value ?? 2).toBeLessThan(medianPopularity);
        expect(r.cells[2]?.value ?? 0).toBeGreaterThan(0);
      }
    }

    // The brand list leaves out Brand Alpha's own category.
    const alpha = run.registry.entity("R1");
    const category = alpha === null ? null : categoryTagOf(alpha);
    expect(category).not.toBeNull();
    const brandRows = d.payload.groups.find((g) => g.key === "brand")?.rows ?? [];
    expect(brandRows.some((r) => r.sublabel === category?.name)).toBe(false);

    const edges = d.payload.groups.flatMap((g) => g.rows).filter((r) => r.explain.length > 0).length;
    expect(run.ledger.metrics.find((m) => m.key === "xdom.edge")?.value).toBe(edges);
    for (const m of run.ledger.metrics) expect(isFormulaId(m.formulaId)).toBe(true);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "cross_domain", step: "S2" })).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("mock-ent-");
    // Every domain's top row leads the digest, so trimming can never drop a domain.
    expect(digest.top_rows.slice(0, 5).map((r) => [r.values.domain, r.values.rank])).toEqual(ALL_DOMAINS.map((d) => [d, 1]));
    expect(digest.notices.some((n) => n.includes("rows left out"))).toBe(false);
  });

  it("estimates one call per domain cold and none once the run has warmed the cache", async () => {
    const client = mockClient();
    const run = await seededRun(client);
    expect(await crossDomainSkill.estimateCalls(input(), run.qloo, run.registry)).toBe(5);
    await crossDomainSkill.run(input(["artist", "brand"]), run.ctx);
    expect(await crossDomainSkill.estimateCalls(input(), run.qloo, run.registry)).toBe(3);
    await crossDomainSkill.run(input(), run.ctx);
    expect(await crossDomainSkill.estimateCalls(input(), run.qloo, run.registry)).toBe(0);
  });

  it("serves a repeat from the cache and stops at the run budget with the gap explained", async () => {
    const client = mockClient();
    // The two /search calls leave room for two of the five domain calls.
    const tight = await seededRun(client, { ...DEFAULT_RUN_LIMITS, qlooCalls: 4, qlooWarnAt: 3 });
    const result = await crossDomainSkill.run(input(), tight.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(tight.ledger.evidences.filter((e) => e.skill === "cross_domain")).toHaveLength(2);
    expect(result.forModel.notices.filter((n) => n.includes("was not made (run budget)"))).toHaveLength(3);
    const gaps = ranked(tight.ledger.datasets).payload.groups.filter((g) => g.rows[0]?.cells[0]?.reason === "budget_truncated");
    expect(gaps).toHaveLength(3);

    // A new run on the same client finds every answered domain cached: those calls are free.
    const next = await seededRun(client);
    expect(await crossDomainSkill.estimateCalls(input(), next.qloo, next.registry)).toBe(3);
  });
});
