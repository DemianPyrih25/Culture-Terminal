// FigureFrame, FigureTable and Exhibit: the ChartCard frame every family shares (kind, title, Chart | Table,
// Source, captions, the method link), the table view's structure, and the dispatch from a dataset envelope to
// its family.
import { DatasetKind, VIZ_COMPAT, type DatasetEnvelope, type Evidence } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { Exhibit, FigureFrame, FigurePending, FigureTable, methodHref, sourceFromEvidence } from "../../components/figures";
import {
  FIXTURE_SOURCES,
  SLATE_CAPTION,
  agePeers,
  austinLiftMap,
  blockDna,
  domainLists,
  marketSlope,
  momentumStrip,
  nearestAudiences,
  priorsScorecard,
  shareGrid,
  similarityMap,
  sponsorQuadrant,
  sponsorSlate,
  supplyAreas,
  tasteMap,
  tastePosition,
  tenantSlope,
} from "../../components/figures/fixtures";
import { plotView, render, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

describe("FigureFrame", () => {
  const html = render(
    <FigureFrame
      meta={{ kind: "Closest audiences", title: "A finding", caption: "A caption.", source: FIXTURE_SOURCES.insights, formulaId: "share.pct" }}
      plot={<svg role="img" aria-label="A finding" />}
      table={<table />}
      fixedCaption="Taste fit only."
    />,
  );

  it("draws a ChartCard: the kind line, the title and the caption under the plot", () => {
    expect(html).toContain("<figure");
    expect(html).toMatch(/<figure[^>]*class="[^"]*rounded-card/);
    expect(html).toMatch(/<p class="m-0 type-overline text-ink-3">Closest audiences<\/p>/);
    expect(html).toMatch(/<h3[^>]*type-title[^>]*>A finding<\/h3>/);
    expect(html.indexOf("A caption.")).toBeGreaterThan(html.indexOf('data-view="plot"'));
    expect(html).not.toContain("FIGURE");
  });

  it("drops the card for a figure inside another surface", () => {
    const plain = render(<FigureFrame meta={{ title: "Plain", chrome: "plain" }} plot={<svg />} table={null} />);
    expect(plain).not.toContain("rounded-card");
  });

  it("prints the source line with a short request id that links to its request", () => {
    expect(text(html)).toContain("Source: Qloo /v2/insights · 8 requests");
    expect(html).toMatch(/<a href="#sources" title="Request 0001aaaa0000f001"[^>]*>req 0001…f001<\/a>/);
  });

  it("offers the table toggle and the method link, each named after its figure", () => {
    expect(html).toContain('role="radiogroup" aria-label="View: A finding"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Chart<\/button>/);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Table<\/button>/);
    expect(html).toContain(`href="${methodHref("share.pct")}" aria-label="How it&#x27;s calculated: A finding"`);
    expect(html).toContain('class="sr-only" data-view="table"');
  });

  it("prints a fixed caption under the plot, and nothing for an empty one", () => {
    expect(html).toContain('data-fixed-caption="true">Taste fit only.<');
    const bare = render(<FigureFrame meta={{ title: "Bare" }} plot={<svg />} table={null} fixedCaption="  " />);
    expect(bare).not.toContain("data-fixed-caption");
  });

  it("drops the method link without a formula and the toggle without a table", () => {
    const bare = render(<FigurePending title="Computing" note="Plot · computing in QUANT" formulaId={null} />);
    expect(bare).not.toContain("calculated");
    expect(bare).not.toContain("radiogroup");
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
    const matrix = render(<Exhibit dataset={similarityMap} />);
    expect(matrix).toContain('data-cell="self"');
    expect(matrix).toContain(">Substitution Map<");
    expect(matrix).toContain('href="/method#subs.similarity"');
    const slate = render(<Exhibit dataset={sponsorSlate} title="Sponsors" display={{ Slate: { tick: 0.7 } }} />);
    expect(text(plotView(slate))).toContain("Under the radar");
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
    ["Bars", blockDna, "Δ vs city"],
    ["Bars, two series", agePeers, "Juniper Cola"],
    ["Quadrant", sponsorQuadrant, 'data-quadrant="HIDDEN_POCKET"'],
    ["Scorecard", priorsScorecard, 'data-state="REFUTED"'],
    ["Slope", tenantSlope, 'data-tone="highlight"'],
    ["Slope, three contexts", marketSlope, 'data-axis="nashville"'],
    ["GeoLift", austinLiftMap, 'data-schematic="LIFT"'],
    ["Momentum", momentumStrip, 'data-badge="STALE"'],
    ["Position", tastePosition, 'data-axis="next_gen_tilt"'],
    ["TasteMap", tasteMap, 'data-tone="target"'],
    ["Supply", supplyAreas, 'data-supply-scope="areas"'],
  ] as const)("renders a %s envelope with its family", (_, dataset, marker) => {
    const html = render(<Exhibit dataset={dataset} display={{ Ranked: { variant: dataset === domainLists ? "lists" : "lollipop" } }} />);
    expect(html).toContain(marker);
    expect(html).toContain(`>${dataset.title}<`);
    if (dataset.formulaIds[0]) expect(html).toContain(`href="${methodHref(dataset.formulaIds[0])}"`);
    expect(html).not.toContain("not built yet");
  });

  it("has a family for every dataset kind", () => {
    const shown = new Set([similarityMap, sponsorQuadrant, blockDna, tenantSlope, austinLiftMap, nearestAudiences, sponsorSlate, momentumStrip, priorsScorecard, tastePosition, tasteMap, supplyAreas].map((d) => d.kind));
    expect([...shown].sort()).toEqual([...DatasetKind.options].sort());
    expect(new Set(Object.values(VIZ_COMPAT)).size).toBe(11);
  });

  it("frames an empty momentum strip without failing", () => {
    const momentum: DatasetEnvelope = {
      id: "D20",
      kind: "Momentum",
      title: "Momentum",
      evidenceIds: [],
      formulaIds: ["mom.mann_kendall"],
      payload: { window: { start: "2026-03-01", end: "2026-08-31" }, badgeText: "HISTORICAL", badge: "STALE", series: [] },
    };
    const html = text(render(<Exhibit dataset={momentum} />));
    expect(html).toContain("No data after Aug 2026");
    expect(html).not.toContain("not built yet");
  });

  it("passes display options to the new families", () => {
    const map = render(<Exhibit dataset={austinLiftMap} display={{ GeoLift: { initialMode: "BASE", interactive: false } }} />);
    expect(map).toContain('data-schematic="BASE"');
    const slope = render(<Exhibit dataset={tenantSlope} display={{ Slope: { width: 328 } }} />);
    expect(text(slope)).not.toContain("TENANT FIT");
    const card = render(<Exhibit dataset={tastePosition} display={{ Position: { figureHrefs: { D1: "#figure-2" } } }} />);
    expect(card).toContain('href="#figure-2"');
  });

  it("frames a kind it does not know (a newer server) instead of failing", () => {
    const future = { ...similarityMap, kind: "Constellation" } as unknown as DatasetEnvelope;
    expect(text(render(<Exhibit dataset={future} />))).toContain("Constellation · no figure family for this kind");
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
