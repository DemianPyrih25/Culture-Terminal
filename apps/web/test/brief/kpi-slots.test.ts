import { describe, expect, it } from "vitest";
import { AgeBucket, Job, type Metric } from "@ct/contracts";
import { KPI_SLOTS as AGENT_KPI_SLOTS } from "../../../../packages/agent/src/report/kpis";
import { KPI_SLOTS, pickMatches, skillForFormula, slotFor } from "../../lib/brief";

/** A metric of this key with these subjects, for the picks' tests. */
const metricOf = (key: string, subjectRefs: string[], formulaId = key): Metric => ({
  id: "M1",
  key,
  label: key,
  subjectRefs,
  value: 0.5,
  reason: null,
  display: "0.50",
  unit: "pct",
  badge: "DERIVED",
  formulaId,
  evidenceIds: [],
  n: null,
  conf: null,
  comparator: null,
  window: null,
});

const AGE: string = AgeBucket.options[0] ?? "";

/** Contexts a pick's test must tell apart: a market, an age bucket and an audience. */
const PROBES = [metricOf("share.pct", ["R1", "nashville"]), metricOf("share.pct", ["R1", AGE]), metricOf("share.pct", ["R1", "urn:audience:example"])];

describe("live key-figure slots", () => {
  it("mirror the agent's KPI slots pick for pick", () => {
    type Pick = { key: string; formula?: string; where?: (m: Metric) => boolean; pair?: boolean };
    // The agent's `requires` is the web's `onlyWith` (D8): a slot shown only when that skill ran.
    const strip = (slots: readonly { picks: readonly Pick[]; count: number; top?: boolean; requires?: string; onlyWith?: string }[]) =>
      slots.map((s) => ({
        count: s.count,
        top: s.top ?? false,
        onlyWith: s.requires ?? s.onlyWith ?? null,
        picks: s.picks.map((p) => ({ key: p.key, formula: p.formula ?? null, pair: p.pair ?? false, where: p.where ? PROBES.map((m) => p.where?.(m)) : null })),
      }));
    for (const job of Job.options) expect(strip(KPI_SLOTS[job]), job).toEqual(strip(AGENT_KPI_SLOTS[job]));
  });

  it("label every slot and know which skill computes every pick", () => {
    for (const job of Job.options) {
      expect(KPI_SLOTS[job].length, job).toBeGreaterThan(0);
      for (const slot of KPI_SLOTS[job]) {
        expect(slot.label.length).toBeGreaterThan(0);
        for (const p of slot.picks) expect(skillForFormula(p.key), p.key).not.toBeNull();
      }
    }
    // Tenant fit is rank_candidates under [site, city] contexts, never Block DNA.
    expect(skillForFormula("tenant.rank_shift")).toBe("rank_candidates");
  });

  it("find the slot a metric fills by its key, formula and context", () => {
    expect(slotFor("market_selection", metricOf("share.pct", ["R1", "nashville"]))?.slot.label).toBe("Market fit");
    expect(slotFor("market_selection", metricOf("share.pct", ["R1", AGE]))).toBeNull();
    expect(slotFor("sponsorship", metricOf("slate.fit", ["R2", "R1"], "slate.best_fit"))?.slot.label).toBe("Best fit");
    expect(slotFor("sponsorship", metricOf("slate.fit", ["R2", "R1"], "pct.within_call"))).toBeNull();
    expect(slotFor("brand_health", metricOf("mom.label", ["R1"]))?.pick.label).toBe("Momentum");
    expect(slotFor(null, metricOf("subs.similarity", ["R1", "R2"]))).toBeNull();
  });

  it("fill Top climber only with a rank shift that rose", () => {
    const shift = (value: number): Metric => ({ ...metricOf("tenant.rank_shift", ["R2", "site", "city"]), value });
    expect(slotFor("tenant_mix", shift(0.25))?.slot.label).toBe("Top climber");
    expect(slotFor("tenant_mix", shift(0))).toBeNull();
    expect(slotFor("area_profile", shift(-0.25))).toBeNull();
  });

  it("take head_to_head's similarity only between the subject and a named peer, when the strip knows them", () => {
    const pick = KPI_SLOTS.head_to_head[0]?.picks[0];
    if (!pick) throw new Error("head_to_head has no overlap pick");
    const focus = { subject: "R1", peers: ["R2"] };
    expect(pickMatches(metricOf("subs.similarity", ["R1", "R2"]), pick, focus)).toBe(true);
    expect(pickMatches(metricOf("subs.similarity", ["R2", "R1"]), pick, focus)).toBe(true);
    // The nearest audience the map discovered is not the duel's overlap.
    expect(pickMatches(metricOf("subs.similarity", ["R1", "R5"]), pick, focus)).toBe(false);
    expect(pickMatches(metricOf("subs.similarity", ["R1", "R2"]), pick, { subject: null, peers: ["R2"] })).toBe(false);
    // Naming a figure the report already chose: no focus, no pair test.
    expect(slotFor("head_to_head", metricOf("subs.similarity", ["R1", "R5"]))?.slot.label).toBe("Audience overlap");
  });
});
