import { DEFAULT_RUN_LIMITS, type Phase, type SkillId } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/errors";
import { harness, runScope } from "./support/fakes";

const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} Fixture ${String.fromCharCode(65 + i)}`);
const CLAIMANTS: ReadonlySet<SkillId | null> = new Set<SkillId | null>(["find_tags", "concept_vector", "geo_lift"]);

async function refused(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (err instanceof BudgetError) return err.gate;
    throw err;
  }
}

function reservedRun(active: () => boolean) {
  const phase: { now: Phase } = { now: "followup" };
  const h = harness();
  const run = h.client.forRun(
    runScope({
      limits: { ...DEFAULT_RUN_LIMITS, followupCalls: 8, conceptReserveCalls: 3 },
      phase: () => phase.now,
      reserve: { calls: 3, claims: (tool) => CLAIMANTS.has(tool), active },
    }),
  );
  return { h, run, phase };
}

describe("follow-up reserve for the concept test", () => {
  it("keeps the last 3 follow-up calls from tools that do not claim them", async () => {
    const { run } = reservedRun(() => true);
    const other = run.forTool("call-1", "rank_candidates");
    for (const name of names(5, "Other")) await other.search({ query: name });
    expect(await refused(other.search({ query: "Other Fixture Z" }))).toBe("followup_cap");
    expect(run.followupNetworkUsed()).toBe(5);
    // A bookkeeping call (no tool) is no claimant either.
    expect(await refused(run.forTool(null).search({ query: "Other Fixture Y" }))).toBe("followup_cap");
  });

  it("lets a claimant use the reserved calls up to the follow-up cap", async () => {
    const { run } = reservedRun(() => true);
    for (const name of names(5, "Other")) await run.forTool("call-1", "peer_landscape").search({ query: name });
    const concept = run.forTool("call-2", "find_tags");
    for (const name of names(3, "Concept")) await concept.search({ query: name });
    expect(run.followupNetworkUsed()).toBe(8);
    expect(await refused(concept.search({ query: "Concept Fixture Z" }))).toBe("followup_cap");
  });

  it("releases the reserve once it is no longer active", async () => {
    let active = true;
    const { run } = reservedRun(() => active);
    const other = run.forTool("call-1", "share_of_taste");
    for (const name of names(5, "Other")) await other.search({ query: name });
    active = false;
    for (const name of names(3, "Later")) await other.search({ query: name });
    expect(run.followupNetworkUsed()).toBe(8);
  });

  it("does not apply outside the follow-up phase", async () => {
    const { run, phase } = reservedRun(() => true);
    phase.now = "wave1";
    const other = run.forTool("call-1", "rank_candidates");
    for (const name of names(10, "Wave")) await other.search({ query: name });
    expect(run.networkUsed()).toBe(10);
    expect(run.followupNetworkUsed()).toBe(0);
  });

  it("serves cached answers to anyone, reserve or not", async () => {
    const { run } = reservedRun(() => true);
    const other = run.forTool("call-1", "rank_candidates");
    const list = names(5, "Other");
    for (const name of list) await other.search({ query: name });
    expect((await other.search({ query: list[0] ?? "" })).meta.cache).toBe("hit");
  });
});
