// TwinCards (S11 in P1): the source and its twin as two cards, mirrored DNA bars over the tags, the
// twin score, shared traits and the key difference, the runners-up, an unmeasured candidate that is
// never drawn as a result, and every tag of every candidate in the table view. The fixture is checked
// against the S11 rules.
import { spearman } from "@ct/quant";
import { describe, expect, it } from "vitest";
import { TwinCards, twinRows } from "../../components/figures";
import { FIXTURE_SOURCES, TWIN_SOURCE_D, tasteTwins } from "../../components/figures/fixtures";
import { plotView, render, rowMarkup, tableHeads, tableRows, tableView, text } from "./markup";

const data = tasteTwins.payload;
const html = render(
  <TwinCards
    data={data}
    number={9}
    title="East Nashville's twin in Austin is Holly"
    source={FIXTURE_SOURCES.twins}
    formulaId="block.rank_delta"
  />,
);
const holly = data.candidates[0]!;

/** Body rows of the plot's own table (the first table in the plot view). */
function plotRows(markup: string): string[][] {
  const plot = plotView(markup);
  return tableRows(plot.slice(0, plot.indexOf("</table>") + "</table>".length));
}

describe("TwinCards", () => {
  it("names both areas on their cards with the twin score between them", () => {
    const plot = plotView(html);
    expect(plot).toContain('data-card="east-nashville"');
    expect(plot).toContain('data-card="holly"');
    expect(text(plot)).toMatch(/SourceEast NashvilleNashville/);
    expect(text(plot)).toMatch(/TwinHollyAustin/);
    expect(plot).toContain('data-rho="0.75"');
    expect(text(plot)).toContain("Twin scoreρ 0.75over 14 tags");
  });

  it("is a real table: the tag heads each row, each area heads its column", () => {
    const plot = plotView(html);
    expect(plot).toContain("<caption class=\"sr-only\">East Nashville&#x27;s twin in Austin is Holly: each tag&#x27;s rank gain over its city, East Nashville against Holly</caption>");
    expect(text(plot)).toContain("East Nashville, rank gain vs Nashville");
    expect(text(plot)).toContain("Holly, rank gain vs Austin");
    expect(plot).toMatch(/<th scope="row"[^>]*>natural wine<span class="sr-only"> \(shared trait\)<\/span><\/th>/);
  });

  it("puts the shared traits first, then the key difference, then the largest deltas, up to ten rows", () => {
    const rows = twinRows(holly, 10);
    expect(rows.map((r) => r.tag.key)).toEqual([
      "natural-wine",
      "live-music",
      "vinyl",
      "roasters",
      "brunch",
      "big-box",
      "sports-bars",
      "fine-dining",
      "cocktails",
      "vintage",
    ]);
    expect(rows.map((r) => r.trait)).toEqual(["shared", "shared", "shared", "shared", "difference", null, null, null, null, null]);
    expect(plotRows(html)).toHaveLength(10);
    expect(plotRows(html)[0]).toEqual(["+21", "natural wine (shared trait)", "+16"]);
    expect(text(plotView(html))).toContain("4 more tags in the table view.");
  });

  it("mirrors the bars: a gain grows outward from each side's centre line, a loss inward", () => {
    const brunch = rowMarkup(plotView(html), "brunch");
    expect(brunch).toContain('data-trait="difference"');
    // Source +17: outward on the left side, so anchored at the centre line's right.
    expect(brunch).toMatch(/class="absolute inset-y-0 bg-data" style="right:50%;width:34\.00%" data-bar="out"/);
    // Holly −12: inward on the right side, so it runs left from the centre line.
    expect(brunch).toMatch(/class="absolute inset-y-0 bg-negative" style="right:50%;width:24\.00%" data-bar="in"/);
    const wine = rowMarkup(plotView(html), "natural-wine");
    expect(wine).toMatch(/style="left:50%;width:32\.00%" data-bar="out"/);
  });

  it("calls out the shared traits in the rows' order, the key difference and the runners-up", () => {
    const plot = plotView(html);
    expect(text(plot)).toContain("Shared traitsnatural wine · live music · vinyl records · coffee roasters");
    expect(text(plot)).toContain("Key differencebrunch: +17 ranks in East Nashville, −12 ranks in Holly");
    expect(text(plot)).toContain("Runners-upGovalle ρ 0.51 · East Cesar Chavez ρ 0.27 · Mueller ρ −0.12 · Zilker ρ −0.55 · Rosedale not fetched (budget)");
  });

  it("draws another candidate against the same source on request, ranked among the scored candidates", () => {
    const ecc = render(<TwinCards data={data} candidateKey="east-cesar-chavez" maxRows={8} title="ECC" />);
    const plot = plotView(ecc);
    expect(plot).toContain('data-twin="east-cesar-chavez"');
    // Rosedale has no twin score, so it takes no rank.
    expect(text(plot)).toContain("#3 of 5");
    expect(text(plot)).toContain("Key differencebrunch: +17 ranks in East Nashville, −8 ranks in East Cesar Chavez; vinyl records: +18 ranks");
    expect(text(plot)).toContain("Other candidatesHolly ρ 0.75");
    expect(plotRows(ecc)).toHaveLength(8);
    // The difference rows follow the callout: brunch, then vinyl records.
    const traits = plotRows(ecc).filter((r) => r[1]!.endsWith("(key difference)")).map((r) => r[1]);
    expect(traits).toEqual(["brunch (key difference)", "vinyl records (key difference)"]);
  });

  it("never draws an unmeasured candidate as a result: no bars, no callouts, only its reason", () => {
    const rosedale = render(<TwinCards data={data} candidateKey="rosedale" title="Rosedale" />);
    const plot = plotView(rosedale);
    expect(text(plot)).toMatch(/Not measuredRosedaleAustin/);
    expect(text(plot)).toContain("Twin scorenot fetched (budget)Not measured");
    expect(text(plot)).not.toContain("over 0 tags");
    expect(plot).not.toContain("<table");
    expect(text(plot)).toContain("Rosedale was not compared with East Nashville: not fetched (budget)");
    expect(plot).not.toContain('data-callout="shared"');
    expect(plot).not.toContain('data-callout="difference"');
    expect(text(plot)).not.toContain("None:");
    expect(text(plot)).toContain("Other candidatesHolly ρ 0.75");
  });

  it("defaults to the first candidate with a twin score, and to the empty state when none has one", () => {
    const rosedale = data.candidates.at(-1)!;
    const late = render(<TwinCards data={{ ...data, candidates: [rosedale, ...data.candidates.slice(0, -1)] }} title="Late" />);
    expect(plotView(late)).toContain('data-twin="holly"');
    expect(text(plotView(late))).toMatch(/TwinHollyAustin/);
    const unmeasured = render(<TwinCards data={{ ...data, candidates: [rosedale] }} title="Unmeasured" />);
    expect(text(plotView(unmeasured))).toContain("No candidate neighbourhood was measured.Rosedale: not fetched (budget)");
    expect(plotView(unmeasured)).not.toContain("<table");
    expect(text(plotView(unmeasured))).not.toContain("Twin");
    const none = render(<TwinCards data={{ ...data, candidates: [] }} title="None" />);
    expect(text(plotView(none))).toContain("No candidate neighbourhood was measured.");
  });

  it("explains a missing value inside a measured comparison, never drawing it", () => {
    const gap = {
      ...data,
      candidates: [{ ...holly, tags: [{ ...holly.tags[0]!, target: { value: null, reason: "not_measured" as const } }] }],
    };
    const markup = render(<TwinCards data={gap} title="Gap" />);
    expect(plotView(markup)).toContain('data-missing="true">not measured<');
  });

  it("keeps its table view out of the reading order until toggled (the plot is the table)", () => {
    expect(html).toMatch(/<div hidden="" class="pt-2" data-view="table">/);
    expect(html).toContain(`data-fixed-caption="true">${data.caption}<`);
  });

  it("lists every tag for every candidate, and the scores, in the table view", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual([
      "Tag",
      "East Nashville (source)",
      "Holly",
      "Govalle",
      "East Cesar Chavez",
      "Mueller",
      "Zilker",
      "Rosedale",
    ]);
    const rows = tableRows(table);
    // The section head is set in capitals, so it spells out ρ.
    expect(rows[0]).toEqual(["Twin score (Spearman rank correlation over the union of tags)"]);
    expect(rows[1]).toEqual(["ρ", "—", "0.75", "0.51", "0.27", "−0.12", "−0.55", "not fetched (budget)"]);
    expect(rows[2]).toEqual(["Tags compared", "—", "14", "14", "14", "14", "14", "0"]);
    const wine = rows.find((r) => r[0] === "natural wine")!;
    expect(wine.slice(0, 4)).toEqual(["natural wine", "+21", "+16 · shared", "+9"]);
    // Rosedale was never measured: its reason, not "not in this comparison".
    expect(wine.at(-1)).toBe("not fetched (budget)");
    const lacking = tableRows(
      tableView(render(<TwinCards data={{ ...data, candidates: [data.candidates[1]!, { ...holly, tags: holly.tags.slice(1) }] }} title="Lacking" />)),
    ).find((r) => r[0] === "natural wine")!;
    expect(lacking.at(-1)).toBe("not in this comparison");
    expect(rows.find((r) => r[0] === "brunch")![2]).toBe("−12 · key difference");
  });

  it("holds a fixture that follows S11: ρ, shared traits and the key difference", () => {
    for (const c of data.candidates) {
      if (c.rho.value === null) {
        expect(c.tags).toEqual([]);
        continue;
      }
      const target = c.tags.map((t) => t.target.value!);
      expect(spearman([...TWIN_SOURCE_D], target)!).toBeCloseTo(c.rho.value, 2);
      expect(c.shared).toEqual(c.tags.filter((t) => t.source.value! >= data.sharedMin && t.target.value! >= data.sharedMin).map((t) => t.key));
      const opposite = c.tags.filter((t) => Math.sign(t.source.value!) * Math.sign(t.target.value!) < 0);
      const gap = (key: string) => {
        const t = c.tags.find((x) => x.key === key)!;
        return Math.abs(t.source.value! - t.target.value!);
      };
      expect(c.difference.length).toBeGreaterThan(0);
      for (const key of c.difference) expect(opposite.map((t) => t.key)).toContain(key);
      expect(gap(c.difference[0]!)).toBe(Math.max(...opposite.map((t) => gap(t.key))));
    }
    const rhos = data.candidates.flatMap((c) => (c.rho.value === null ? [] : [c.rho.value]));
    expect(rhos).toEqual([...rhos].sort((a, b) => b - a));
  });
});
