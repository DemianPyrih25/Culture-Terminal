// Part 9 close-out on the page: the shared tag-noise filter at display time (Q2), plain words for QUANT's
// shorthand (Q1), a public value's known absence (Q8) and the SEC revenue slot rule (D8). Invented names only.
import type { DatasetEnvelope, Metric } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { absentText, isKnownAbsence, KPI_SLOTS, metricWithComparator, plainDisplay, plainWords } from "../../lib/brief";
import { plainBeforeMetric } from "../../lib/brief/plain";
import { withoutNoiseTags } from "../../lib/tag-noise";

const MUSIC = "urn:tag:genre:music";

const bar = (key: string, label: string, value = 10) => ({ key, label, tagRef: null, values: [{ value, reason: null }], isNew: false, ranks: null });
const row = (key: string, label: string) => ({ key, rank: null, label, sublabel: null, ref: null, tagRef: null, type: null, cells: [{ value: 1, reason: null }], flags: [], explain: [] });

function barsOf(groups: { key: string; family: string | null; bars: ReturnType<typeof bar>[] }[]): DatasetEnvelope {
  return { id: "D1", kind: "Bars", title: "Block DNA", payload: { groups: groups.map((g) => ({ ...g, label: g.key })) } } as unknown as DatasetEnvelope;
}

describe("withoutNoiseTags (ANSWER_QUALITY §10, at display time)", () => {
  it("drops place names and, for music tags, nationalities and generic words; keeps real tags and non-tag rows", () => {
    const data = barsOf([
      { key: "SOUND", family: "SOUND", bars: [bar(`${MUSIC}:usa`, "Usa"), bar(`${MUSIC}:american`, "american"), bar(`${MUSIC}:dream_pop`, "Dream pop")] },
      { key: "WHAT", family: "WHAT", bars: [bar("urn:tag:genre:place:restaurant:american", "American"), bar("urn:tag:genre:place:austin", "austin")] },
      { key: "AGE", family: null, bars: [bar("age-25", "25–29")] },
    ]);
    const out = withoutNoiseTags(data);
    if (out.kind !== "Bars") throw new Error("kind changed");
    expect(out.payload.groups.map((g) => [g.key, g.bars.map((b) => b.label)])).toEqual([
      ["SOUND", ["Dream pop"]],
      ["WHAT", ["American"]],
      ["AGE", ["25–29"]],
    ]);
    // Memoised: the same stored dataset gives the same cleaned object.
    expect(withoutNoiseTags(data)).toBe(out);
  });

  it("keeps a tag contrast's groups, even emptied, and leaves a clean dataset as it was", () => {
    const contrast = {
      id: "D2",
      kind: "Ranked",
      title: "Facet tags",
      payload: {
        columns: [],
        groups: [
          { key: "a_only", label: "Only A", rows: [row("urn:tag:lifestyle:qloo:texas", "Texas")] },
          { key: "shared", label: "Both", rows: [row("urn:tag:lifestyle:qloo:outdoors", "Outdoors")] },
          { key: "b_only", label: "Only B", rows: [row("R4", "Usa")] },
        ],
      },
    } as unknown as DatasetEnvelope;
    const out = withoutNoiseTags(contrast);
    if (out.kind !== "Ranked") throw new Error("kind changed");
    // A row keyed by an entity (R4) is not a tag, whatever its name.
    expect(out.payload.groups.map((g) => [g.key, g.rows.map((r) => r.label)])).toEqual([
      ["a_only", []],
      ["shared", ["Outdoors"]],
      ["b_only", ["Usa"]],
    ]);
    const clean = barsOf([{ key: "VIBE", family: "VIBE", bars: [bar("urn:tag:ambience:qloo:cozy", "Cozy")] }]);
    expect(withoutNoiseTags(clean)).toBe(clean);
    expect(withoutNoiseTags(null)).toBeNull();
  });
});

describe("plain words (Q1)", () => {
  it("rewrites display pieces, never the numbers", () => {
    expect(plainDisplay({ display: "+42 · NEW" })).toBe("+42 · new here");
    expect(plainDisplay({ display: "−40 · not ranked here" })).toBe("−40 · not in the top tags here");
    expect(plainDisplay({ display: "6 of 20 in the area top 20" })).toBe("6 of the top 20 tags new here");
    expect(plainDisplay({ display: "0.62 · Latent & open" })).toBe("0.62 · strong interest, few rivals");
    expect(plainDisplay({ display: "1.48×" })).toBe("1.48×");
  });

  it("rewrites labels and prose: badges in parentheses, EMPTY_RESULT, family codes, τ and p", () => {
    expect(plainWords("NEW SOUND music tags in East Hollow (area music top 20)")).toBe("New music tags in East Hollow (area music top 20)");
    expect(plainWords("rank gain vs Riverton: Lo-fi (SOUND music tag, Old Mill)")).toBe("rank gain vs Riverton: Lo-fi (music tag, Old Mill)");
    expect(plainWords("Map precision 1.00 (DERIVED) and a tag search came back EMPTY_RESULT.")).toBe("Map precision 1.00 and a tag search came back no results.");
    expect(plainWords("Mann–Kendall τ of Wildcomb Honey's weekly series")).toBe("Trend strength (Mann–Kendall τ) of Wildcomb Honey's weekly series");
    expect(plainBeforeMetric("The trend held (τ ", { key: "mom.mann_kendall_tau" })).toBe("The trend held (trend strength ");
    expect(plainBeforeMetric("with p ", { key: "mom.mann_kendall_p" })).toBe("with p-value ");
    expect(plainBeforeMetric("with p ", { key: "share.pct" })).toBe("with p ");
  });
});

describe("a public value's absence (Q8)", () => {
  const absent = (reason: Metric["reason"]): Metric => ({
    id: "M1",
    key: "fin.revenue",
    label: "reported revenue",
    subjectRefs: ["R1"],
    value: null,
    reason,
    display: "",
    unit: "usd",
    badge: "UNAVAILABLE",
    formulaId: "fin.revenue",
    evidenceIds: [],
    n: null,
    conf: null,
    comparator: null,
    window: null,
  });

  it("shows its known reason, never 'not measured'", () => {
    expect(metricWithComparator(absent("not_reported"))).toBe("not reported in filings");
    expect(metricWithComparator(absent("suppressed"))).toBe("withheld by the Census");
    expect(metricWithComparator(absent("not_configured"))).toBe("not configured on this server");
    expect(isKnownAbsence("not_listed")).toBe(true);
    // A Qloo gap still reads as not measured, with its reason.
    expect(isKnownAbsence("no_signal")).toBe(false);
    expect(absentText("no_signal")).toBe("not measured");
    expect(metricWithComparator(absent("no_signal"))).toMatch(/^not measured \(/);
  });
});

describe("the SEC revenue slot (D8)", () => {
  it("shows only when company_financials is planned", () => {
    for (const job of ["brand_health", "launch_test"] as const) {
      const fin = KPI_SLOTS[job].find((s) => s.picks.some((p) => p.key.startsWith("fin.")));
      expect(fin?.onlyWith, job).toBe("company_financials");
    }
  });
});
