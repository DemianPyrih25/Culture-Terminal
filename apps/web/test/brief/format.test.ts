import { describe, expect, it } from "vitest";
import { ConfidenceRule, Job, JOB_PILLAR, Pillar, Signal, type Metric } from "@ct/contracts";
import { FORMULA_IDS } from "@ct/quant";
import {
  capitalize,
  convictionRuleLabel,
  countWord,
  DESK_LABEL,
  filterLabel,
  flagLabel,
  formatCacheAge,
  formatClock,
  formatDuration,
  formatTrendWindow,
  formatUsd,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcShortDateTime,
  formatUtcTime,
  JOB_HEAD_LABEL,
  JOB_LABEL,
  METRIC_SHORT_LABEL,
  metricDirection,
  metricShortLabel,
  metricWithComparator,
  plural,
  shortRequestId,
  SIGNAL_LABEL,
} from "../../lib/brief";

const metric = (patch: Partial<Metric>): Metric => ({
  id: "M1",
  key: "share.youth_tilt",
  label: "Youth tilt of Juniper Cola",
  subjectRefs: ["R1"],
  value: 0.21,
  reason: null,
  display: "+0.21",
  unit: "delta",
  badge: "MEASURED",
  formulaId: "share.youth_tilt",
  evidenceIds: ["E1"],
  n: 3,
  conf: 0.4,
  comparator: "PEERS",
  window: null,
  ...patch,
});

describe("brief formatters", () => {
  it("shortens request ids to their first and last four characters", () => {
    expect(shortRequestId("req-abcd-0000-1111-wxyz")).toBe("req-…wxyz");
    expect(shortRequestId("abcdef0123456789")).toBe("abcd…6789");
    expect(shortRequestId("short-id")).toBe("short-id");
    expect(shortRequestId(null)).toBe("no response");
  });

  it("formats cache ages, clocks, durations and money", () => {
    expect(formatCacheAge(20_000)).toBe("<1m");
    expect(formatCacheAge(15 * 60_000)).toBe("15m");
    expect(formatCacheAge(2 * 3_600_000 + 5)).toBe("2h");
    expect(formatCacheAge(3 * 86_400_000)).toBe("3d");
    expect(formatClock(21_400)).toBe("00:21");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatDuration(154)).toBe("154 ms");
    expect(formatDuration(1840)).toBe("1.8 s");
    expect(formatDuration(52_000)).toBe("52 s");
    expect(formatUsd(0.06)).toBe("$0.06");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("prints UTC dates and times", () => {
    const iso = "2026-10-14T09:12:04.000Z";
    expect(formatUtcDate(iso)).toBe("14 Oct 2026");
    expect(formatUtcTime(iso)).toBe("09:12:04");
    expect(formatUtcDateTime(iso)).toBe("14 Oct 2026, 09:12");
    expect(formatUtcShortDateTime(iso)).toBe("14 Oct, 09:12");
    // An offset is converted, not dropped.
    expect(formatUtcTime("2026-10-14T11:12:04+02:00")).toBe("09:12:04");
    expect(formatUtcDate("not a date")).toBe("not a date");
  });

  it("prints trend windows as month spans", () => {
    expect(formatTrendWindow({ start: "2025-04-07", end: "2025-09-29" })).toBe("Apr–Sep 2025");
    expect(formatTrendWindow({ start: "2024-11-04", end: "2025-02-24" })).toBe("Nov 2024–Feb 2025");
    expect(formatTrendWindow({ start: "2025-04-07", end: "2025-04-28" })).toBe("Apr 2025");
  });

  it("labels every desk, job and signal", () => {
    for (const p of Pillar.options) expect(DESK_LABEL[p]).toMatch(/^[A-Z][a-z]+$/);
    for (const j of Job.options) {
      expect(JOB_LABEL[j].length).toBeGreaterThan(3);
      expect(JOB_HEAD_LABEL[j].length).toBeGreaterThan(3);
      expect(DESK_LABEL[JOB_PILLAR[j]]).toBeTruthy();
    }
    // One label everywhere (A01, A02, A09, A10); the running head alone is terser for brand_health.
    expect(JOB_LABEL.brand_health).toBe("Real competitors");
    expect(JOB_HEAD_LABEL.brand_health).toBe("Competitors");
    expect(JOB_LABEL.head_to_head).toBe("Compare two brands");
    expect(Job.options.filter((j) => JOB_HEAD_LABEL[j] !== JOB_LABEL[j])).toEqual(["brand_health"]);
    for (const s of Signal.options) expect(SIGNAL_LABEL[s]).toBeTruthy();
    expect(SIGNAL_LABEL.mixed).toBe("Mixed signal");
  });

  it("prints a metric with its comparator, and an UNAVAILABLE one as not measured, never 0", () => {
    expect(metricWithComparator(metric({}))).toBe("+0.21 vs peers");
    expect(metricWithComparator(metric({ comparator: null }))).toBe("+0.21");
    const missing = metric({ value: null, reason: "no_signal", badge: "UNAVAILABLE", display: "0" });
    expect(metricWithComparator(missing)).toBe("not measured (no usable trend in the window)");
    expect(metricWithComparator(missing)).not.toMatch(/\d/);
  });

  it("reads direction only from signed units", () => {
    expect(metricDirection(metric({ value: 0.21 }))).toBe("over");
    expect(metricDirection(metric({ value: -0.1 }))).toBe("under");
    expect(metricDirection(metric({ unit: "lift", value: 1.3 }))).toBe("over");
    expect(metricDirection(metric({ unit: "score", value: 0.9 }))).toBeNull();
    expect(metricDirection(metric({ value: null }))).toBeNull();
  });

  it("names filters, flags and counts the way the brief prints them", () => {
    expect(filterLabel("urn:entity:brand")).toBe("brand");
    expect(filterLabel("urn:demographics")).toBe("demographics");
    expect(filterLabel("urn:entity:tv_show")).toBe("tv show");
    expect(filterLabel(null)).toBeNull();
    expect(flagLabel("SECONDARY_ENTITY_DROPPED")).toBe("Secondary entity dropped");
    expect(countWord(4)).toBe("Four");
    expect(countWord(12)).toBe("12");
    expect(plural(1, "request")).toBe("1 request");
    expect(plural(8, "request")).toBe("8 requests");
    expect(plural(1, "row")).toBe("1 row");
    expect(capitalize("similarity of Brand Alpha")).toBe("Similarity of Brand Alpha");
    expect(capitalize("")).toBe("");
  });

  it("gives every formula a short label, and shortens a label it does not know", () => {
    for (const id of FORMULA_IDS) {
      const label = METRIC_SHORT_LABEL[id];
      expect(label, id).toMatch(/^[A-Z0-9]/);
      // Short enough for a key figure: a few words, no asides.
      expect(label?.length ?? 99, id).toBeLessThanOrEqual(24);
      expect(label, id).not.toMatch(/[()_]/);
    }
    expect(metricShortLabel(metric({}))).toBe("Youth tilt");
    // The key wins over the formula; an unknown one falls back to the label, capitalised and without its aside.
    expect(metricShortLabel(metric({ key: "subs.hub", formulaId: "subs.similarity" }))).toBe("Hub score");
    expect(metricShortLabel(metric({ key: "x.invented", formulaId: "subs.similarity" }))).toBe("Audience overlap");
    expect(metricShortLabel(metric({ key: "x.invented", formulaId: "x.invented", label: "similarity Brand Alpha–Brand Beta (nearest peer)" }))).toBe(
      "Similarity Brand Alpha–Brand Beta",
    );
  });

  it("words every conviction penalty for a reader, counting where it repeats", () => {
    for (const rule of ConfidenceRule.options) {
      for (const count of [1, 3]) {
        const label = convictionRuleLabel(rule, count);
        expect(label, rule).toMatch(/^[A-Z0-9]/);
        // No rule ids, no shouted role names, no ×N.
        expect(label, rule).not.toMatch(/_|\b[A-Z]{4,}\b|×/);
      }
    }
    expect(convictionRuleLabel("insufficient_evidence", 1)).toBe("Signal is insufficient evidence");
    expect(convictionRuleLabel("code_fallback", 1)).toBe("Code fell back to a simpler query");
    expect(convictionRuleLabel("thin_result", 3)).toBe("3 requests returned fewer than five rows");
    expect(convictionRuleLabel("checker_warning", 2)).toBe("2 checker warnings");
    expect(convictionRuleLabel("stale_momentum", 1, { start: "2025-04-07", end: "2025-09-29" })).toBe("Trend window ends Sep 2025; nothing after it is used");
    expect(convictionRuleLabel("stale_momentum", 1)).toBe("Momentum from a historical window only");
  });
});
