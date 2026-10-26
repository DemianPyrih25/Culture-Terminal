// The figure fixtures are invented (D29) and must stay valid contract data: every one parses with
// the DatasetEnvelope schema, each kind maps to a built family, and values sit on the scale of the
// formula each fixture cites.
import { DatasetEnvelope, RankedPayload, VIZ_COMPAT, VizComponent } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { abbreviateRequestId, slateToRanked } from "../../components/figures";
import {
  ALL_FIXTURES,
  FIXTURE_SOURCES,
  austinLiftMap,
  marketSlope,
  momentumStrip,
  sponsorQuadrant,
  sponsorSlate,
  tastePosition,
  tenantSlope,
} from "../../components/figures/fixtures";

describe("figure fixtures", () => {
  it.each(ALL_FIXTURES.map((f) => [`${f.id} ${f.kind}`, f] as const))("%s parses with DatasetEnvelope", (_, fixture) => {
    expect(() => DatasetEnvelope.parse(fixture)).not.toThrow();
  });

  it("covers every figure family", () => {
    const families = new Set(ALL_FIXTURES.map((f) => VIZ_COMPAT[f.kind]));
    for (const family of VizComponent.options) expect(families.has(family), family).toBe(true);
  });

  it("uses unique dataset ids", () => {
    const ids = ALL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("follows the S6 arithmetic in the lift map: gate, cell lift, geometric mean over 5+ gated cells", () => {
    const { cells, neighbourhoods, precisionFactor } = austinLiftMap.payload;
    for (const c of cells) expect(c.conf).toBe(precisionFactor);
    expect(cells.filter((c) => c.gated).length).toBe(Math.ceil(cells.length / 2));
    for (const n of neighbourhoods) {
      const gated = cells.filter((c) => c.neighbourhood === n.id && c.gated);
      expect(n.n).toBe(gated.length);
      if (n.lift === null) {
        expect(gated.length).toBeLessThan(5);
        expect(n.reason).toBe("insufficient_n");
        continue;
      }
      const mean = Math.exp(gated.reduce((s, c) => s + Math.log(c.lift!), 0) / gated.length);
      expect(n.lift).toBeCloseTo(mean, 2);
      expect(n.conf).toBeCloseTo(Math.min(1, n.n / 12) * precisionFactor, 2);
      expect(n.whiteSpace).toBeCloseTo(n.demandPct! * (1 - n.supplyPct!), 2);
    }
    // Lifts highest first, then the rest.
    const lifts = neighbourhoods.flatMap((n) => (n.lift === null ? [] : [n.lift]));
    expect(lifts).toEqual([...lifts].sort((a, b) => b - a));
  });

  it("follows tenant.fit and the slope delta (last axis minus first)", () => {
    for (const line of [...tenantSlope.payload.lines, ...marketSlope.payload.lines]) {
      const first = line.points[0]!.value;
      const last = line.points.at(-1)!.value;
      expect(line.delta).toBe(first === null || last === null ? null : last - first);
    }
    for (const line of tenantSlope.payload.lines) {
      if (line.score === null) continue;
      const site = line.points[1]!.value!;
      const expected = 100 * (0.6 * site + 0.4 * Math.min(1, Math.max(0, line.delta! + 0.5)));
      expect(line.score).toBeCloseTo(expected, 1);
    }
  });

  it("keeps momentum weekly, inside the window, on percentiles", () => {
    const { window, series } = momentumStrip.payload;
    for (const s of series) {
      for (const p of s.points) {
        expect(p.date >= window.start && p.date <= window.end).toBe(true);
        expect(new Date(`${p.date}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(p.pct).toBeGreaterThanOrEqual(0);
        expect(p.pct).toBeLessThanOrEqual(1);
      }
    }
    expect(momentumStrip.payload.badgeText).toContain(`${window.start}..${window.end}`);
  });

  it("gives the position card no composite: five axes, each with its own badge", () => {
    expect(tastePosition.payload.axes.map((a) => a.badge)).toEqual(["MEASURED", "MEASURED", "DERIVED", "DERIVED", "STALE"]);
    expect(Object.keys(tastePosition.payload)).toEqual(["subject", "peerCount", "axes"]);
  });

  it("gives every not-measured value a reason and never a number", () => {
    const json = JSON.stringify(ALL_FIXTURES);
    expect(json).not.toMatch(/"value":null,"reason":null/);
  });

  it("uses plainly synthetic request ids: counters, never UUID-shaped", () => {
    for (const source of Object.values(FIXTURE_SOURCES)) {
      if (source.requestId === null) continue;
      expect(source.requestId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(abbreviateRequestId(source.requestId)).toMatch(/^000\d…f00\d$/);
    }
  });

  it("keeps DNA indices on the −1 to 1 scale of dna.age_index and dna.gender_index", () => {
    const dna = ALL_FIXTURES.filter((f) => f.kind === "Bars" && f.formulaIds.some((id) => id.startsWith("dna.")));
    expect(dna.length).toBeGreaterThan(0);
    for (const fixture of dna) {
      if (fixture.kind !== "Bars") continue;
      const values = fixture.payload.groups.flatMap((g) => g.bars.flatMap((b) => b.values.flatMap((c) => (c.value === null ? [] : [c.value]))));
      expect(values.every((x) => x >= -1 && x <= 1)).toBe(true);
      expect(values.some((x) => x < 0)).toBe(true);
    }
  });

  it("generates the grey scatter candidates deterministically inside the plot", () => {
    const grey = sponsorQuadrant.payload.points.filter((p) => !p.labelled);
    expect(grey.length).toBe(24);
    for (const p of grey) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0.2);
      expect(p.y).toBeLessThanOrEqual(0.7);
    }
  });

  it("turns a Slate into a valid Ranked payload that keeps the fixed caption", () => {
    const ranked = slateToRanked(sponsorSlate.payload);
    expect(() => RankedPayload.parse(ranked)).not.toThrow();
    expect(ranked.caption).toBe(sponsorSlate.payload.caption);
  });
});
