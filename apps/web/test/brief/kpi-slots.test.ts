import { describe, expect, it } from "vitest";
import { Job } from "@ct/contracts";
import { KPI_SLOTS as AGENT_KPI_SLOTS } from "../../../../packages/agent/src/report/kpis";
import { KPI_SLOTS, skillForFormula } from "../../lib/brief";

describe("live key-figure slots", () => {
  it("mirror the agent's KPI slots formula for formula", () => {
    for (const job of Job.options) {
      const strip = (slots: readonly { formulas: readonly string[]; count: number }[]) =>
        slots.map((s) => ({ formulas: [...s.formulas], count: s.count }));
      expect(strip(KPI_SLOTS[job]), job).toEqual(strip(AGENT_KPI_SLOTS[job]));
    }
  });

  it("know which skill computes every slot formula", () => {
    for (const job of Job.options) {
      for (const slot of KPI_SLOTS[job]) {
        expect(slot.label.length).toBeGreaterThan(0);
        for (const f of slot.formulas) expect(skillForFormula(f), f).not.toBeNull();
      }
    }
  });
});
