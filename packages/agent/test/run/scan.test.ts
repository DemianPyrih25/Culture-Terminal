// The opening scan table: which skills each job runs in this build, with what default arguments.
import { Job, type EntityRef, type RegisteredEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { isSkillAvailable } from "../../src/run/catalogue";
import { describeScanStep, planScan, SCAN_PEER_K, SCAN_TABLE } from "../../src/run/scan";
import { intentFor } from "./support";

const entity = (n: number, type: RegisteredEntity["type"] = "brand"): RegisteredEntity => ({
  ref: `R${n}` as EntityRef,
  entityId: `synthetic-${n}`,
  name: `Brand ${n}`,
  type,
  popularity: null,
  disambiguation: null,
  tags: [],
});

describe("planScan", () => {
  it("brand_health maps the target with discovery and logs the scan skills this build lacks", () => {
    const plan = planScan("brand_health", { intent: intentFor(), primary: entity(1), peers: [entity(2)] });
    expect(plan.steps).toEqual([
      {
        toolCallId: "scan-1",
        tool: "peer_landscape",
        input: { target: "R1", peers: ["R2"], discover: true, k: SCAN_PEER_K, trigger_finding_id: null, step_id: null },
      },
    ]);
    expect(plan.unavailable).toEqual(["audience_dna", "destination_affinity"]);
    expect(plan.skipped).toEqual([]);
    expect(describeScanStep(plan.steps[0]!)).toBe("peer_landscape (SUBS) for R1 with peers R2, discovery on, k 6");
  });

  it("head_to_head discovers peers unless three or more were named", () => {
    const two = planScan("head_to_head", { intent: intentFor({ job: "head_to_head" }), primary: entity(1), peers: [entity(2), entity(3)] });
    expect(two.steps[0]?.input).toMatchObject({ peers: ["R2", "R3"], discover: true });
    const three = planScan("head_to_head", {
      intent: intentFor({ job: "head_to_head" }),
      primary: entity(1),
      peers: [entity(2), entity(3), entity(4)],
    });
    expect(three.steps[0]?.input).toMatchObject({ peers: ["R2", "R3", "R4"], discover: false });
    expect(three.unavailable).toEqual(["rank_candidates", "share_of_taste", "audience_dna"]);
  });

  it("caps named peers at k − 1 and leaves out peers that are not brands", () => {
    const peers = [entity(2), entity(3, "artist"), entity(4), entity(5), entity(6), entity(7), entity(8)];
    const plan = planScan("brand_health", { intent: intentFor(), primary: entity(1), peers });
    expect(plan.steps[0]?.input).toMatchObject({ peers: ["R2", "R4", "R5", "R6", "R7"] });
  });

  it("skips the map without a brand target", () => {
    expect(planScan("brand_health", { intent: intentFor(), primary: null, peers: [] }).skipped).toEqual([
      { tool: "peer_landscape", reason: "needs a brand as the primary target" },
    ]);
    expect(planScan("brand_health", { intent: intentFor(), primary: entity(1, "artist"), peers: [] }).steps).toEqual([]);
  });

  it("runs nothing yet for the other jobs, naming every scan skill as unavailable", () => {
    for (const job of Job.options.filter((j) => j !== "brand_health" && j !== "head_to_head")) {
      const plan = planScan(job, { intent: intentFor({ job }), primary: entity(1), peers: [] });
      expect(plan.steps).toEqual([]);
      expect(plan.unavailable).toEqual(SCAN_TABLE[job].map((e) => e.tool));
    }
  });

  it("gives every available scan skill a default-input builder", () => {
    for (const job of Job.options) {
      for (const entry of SCAN_TABLE[job]) {
        if (isSkillAvailable(entry.tool)) expect(entry.build, `${job}: ${entry.tool}`).toBeDefined();
      }
    }
  });
});
