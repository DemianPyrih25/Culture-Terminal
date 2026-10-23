// FigureFrame, FigureTable and Exhibit: the frame every family shares (label, source, ⧉ toggle,
// ⓘ link, fixed caption), the table view's structure, and the dispatch from a dataset envelope to
// its family.
import type { DatasetEnvelope, Evidence } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { Exhibit, FigureFrame, FigurePending, FigureTable, methodHref, sourceFromEvidence } from "../../components/figures";
import {
  FIXTURE_SOURCES,
  SLATE_CAPTION,
  agePeers,
  blockDna,
  domainLists,
  nearestAudiences,
  priorsScorecard,
  shareGrid,
  similarityMap,
  sponsorQuadrant,
  sponsorSlate,
} from "../../components/figures/fixtures";
import { plotView, render, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

describe("FigureFrame", () => {
  const html = render(
    <FigureFrame
      meta={{ number: 4, title: "A finding", caption: "A caption.", source: FIXTURE_SOURCES.insights, formulaId: "share.pct" }}
      plot={<svg role="img" aria-label="A finding" />}
      table={<table />}
      fixedCaption="Taste fit only."
    />,
  );

  it("prints the figure number, the serif title and the caption", () => {
    expect(html).toContain("<figure");
    expect(html).toContain(">FIGURE 4<");
    expect(html).toMatch(/<h3[^>]*>A finding<\/h3>/);
    expect(html).toContain("A caption.");
  });

  it("prints the source line with a short request id that links to its request", () => {
    expect(text(html)).toContain("Source: Qloo /v2/insights · 8 requests");
    expect(html).toMatch(/<a href="#sources" title="Request 0001aaaa0000f001"[^>]*>req 0001…f001<\/a>/);
  });

  it("offers the table toggle and the method link, each named after its figure", () => {
    expect(html).toMatch(/<button type="button" aria-pressed="false" aria-label="Table view: A finding"[^>]*>[\s\S]*Table<\/button>/);
    expect(html).toContain(`href="${methodHref("share.pct")}" aria-label="Method: A finding"`);
    expect(html).toContain('class="sr-only" data-view="table"');
  });

  it("prints a fixed caption under the plot, and nothing for an empty one", () => {
    expect(html).toContain('data-fixed-caption="true">Taste fit only.<');
    const bare = render(<FigureFrame meta={{ title: "Bare" }} plot={<svg />} table={null} fixedCaption="  " />);
    expect(bare).not.toContain("data-fixed-caption");
  });

  it("drops the method link without a formula and the toggle without a table", () => {
    const bare = render(<FigurePending title="Computing" note="Plot · computing in QUANT" formulaId={null} />);
    expect(bare).not.toContain("Method");
    expect(bare).not.toContain("aria-pressed");
    expect(bare).toContain("Plot · computing in QUANT");
  });
});

describe("FigureTable", () => {
  it("gives each section its own row group", () => {
    const html = render(
      <FigureTable
        spec={{
          caption: "Sections",
          columns: [{ label: "Item" }, { label: "Value", numeric: true }],
          rows: [
            { key: "top", cells: ["Ungrouped", "1"] },
            { key: "s-age", section: "Age" },
            { key: "a", cells: ["25–29", "2"] },
            { key: "s-gender", section: "Gender" },
            { key: "b", cells: ["Women", "3"] },
          ],
        }}
      />,
    );
    expect(html.match(/<tbody>/g)).toHaveLength(3);
    expect(html).not.toContain("colgroup");
    expect(html).toContain('<th scope="rowgroup" colSpan="2"');
    expect(html).toMatch(/<tbody><tr[^>]*><th scope="rowgroup"[^>]*>Age<\/th><\/tr><tr[^>]*><th scope="row"[^>]*>25–29<\/th>/);
  });
});

describe("Exhibit", () => {
  it("picks the family from the dataset kind and the formula from the dataset", () => {
    const matrix = render(<Exhibit dataset={similarityMap} number={2} />);
    expect(matrix).toContain('data-cell="self"');
    expect(matrix).toContain(">Substitution Map<");
    expect(matrix).toContain('href="/method#subs.similarity"');
    const slate = render(<Exhibit dataset={sponsorSlate} title="Sponsors" display={{ Slate: { tick: 0.7 } }} />);
    expect(text(plotView(slate))).toContain("UNDER THE RADAR");
    expect(text(plotView(slate))).toContain("Best fit");
  });

  it("carries the Slate's fixed caption", () => {
    const slate = render(<Exhibit dataset={sponsorSlate} />);
    expect(slate).toContain("no fee, availability or ROI data");
    expect(slate).toContain(`data-fixed-caption="true">${SLATE_CAPTION}<`);
  });

  it.each([
    ["Matrix", shareGrid, 'data-target="column"'],
    ["Ranked", nearestAudiences, 'data-tone="highlight"'],
    ["Ranked lists", domainLists, "TV · series"],
    ["Bars", blockDna, "Δ VS CITY"],
    ["Bars, two series", agePeers, "JUNIPER COLA"],
    ["Quadrant", sponsorQuadrant, 'data-quadrant="HIDDEN_POCKET"'],
    ["Scorecard", priorsScorecard, 'data-state="REFUTED"'],
  ] as const)("renders a %s envelope with its family", (_, dataset, marker) => {
    const html = render(<Exhibit dataset={dataset} number={1} display={{ Ranked: { variant: dataset === domainLists ? "lists" : "lollipop" } }} />);
    expect(html).toContain(marker);
    expect(html).toContain(`>${dataset.title}<`);
    if (dataset.formulaIds[0]) expect(html).toContain(`href="${methodHref(dataset.formulaIds[0])}"`);
    expect(html).not.toContain("not built yet");
  });

  it("frames a family that is not built yet without failing", () => {
    const momentum: DatasetEnvelope = {
      id: "D20",
      kind: "Momentum",
      title: "Momentum",
      evidenceIds: [],
      formulaIds: ["mom.mann_kendall"],
      payload: { window: { start: "2026-03-01", end: "2026-08-31" }, badgeText: "HISTORICAL", badge: "STALE", series: [] },
    };
    expect(text(render(<Exhibit dataset={momentum} />))).toContain("MomentumStrip · this figure family is not built yet");
  });
});

describe("sourceFromEvidence", () => {
  it("names endpoints and counts requests from the evidence", () => {
    const evidence = [
      {
        id: "E1",
        skill: "peer_landscape",
        purpose: "map",
        status: "ok",
        qlooCallIds: ["c1", "c2"],
        requestIds: ["0011aaaa0000f011", "0012bbbb0000f012"],
        cached: true,
        fetchedAt: "2026-10-01T09:00:00Z",
        provenance: {
          requests: [
            { method: "GET", path: "/v2/insights", query: {} },
            { method: "GET", path: "/v2/insights", query: {} },
          ],
        },
        summary: "",
        flags: [],
        qualityGateDrops: 0,
      },
    ] as unknown as Evidence[];
    expect(sourceFromEvidence(evidence)).toEqual({
      text: "Source: Qloo /v2/insights · 2 requests · computed in code",
      requestId: "0011aaaa0000f011",
      href: null,
    });
  });
});
