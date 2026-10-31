// The answer-page plot primitives (components/plots): server markup, bar scales, the Table view builders,
// tags in words, and "No data" (never zero) for missing values and empty plots. Invented rows only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BarList,
  ChartGlyph,
  ColumnChart,
  DivergingPair,
  DivergingRows,
  MiniBarColumns,
  NEIGHBOUR_DOMAINS,
  NO_DATA,
  NeighbourColumns,
  NumberedList,
  RankTrack,
  RankTrackList,
  RankedFitList,
  Scoreboard,
  SlateTable,
  WinnerTable,
  barListTable,
  barShares,
  categoryIcon,
  columnTable,
  distance,
  divergingDisplay,
  divergingPairTable,
  divergingShares,
  divergingTable,
  fitDisplay,
  glyphForDataset,
  miniBarShares,
  miniBarTable,
  neighbourTable,
  numberedListTable,
  pairShares,
  rankText,
  rankTrackTable,
  rankedFitTable,
  signed,
  slateTable,
  tagText,
  times,
  winnerTable,
  type BarListRow,
  type DivergingRow,
  type MiniBarColumn,
  type PairGroup,
} from "../../components/plots";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'");

const MINUS = String.fromCharCode(0x2212);

const bars: BarListRow[] = [
  { label: "Glimmer Soap", sublabel: "personal care", value: 0.84, display: "0.84", tone: "accent", tag: "outside-category" },
  { label: "Brookfall Water", sublabel: "bottled water", value: 0.42, display: "0.42" },
  { label: "Quietfern Tea", value: null, display: "" },
];

describe("format", () => {
  it("signs with the typographic minus and prints lifts with ×", () => {
    expect(signed(0.31)).toBe("+0.31");
    expect(signed(-0.18)).toBe(`${MINUS}0.18`);
    expect(signed(0.001)).toBe("0.00");
    expect(times(2.4)).toBe("2.4×");
    expect(times(1.312, 2)).toBe("1.31×");
  });

  it("measures lifts on a log2 scale, so 0.5× is as far from 1 as 2×", () => {
    expect(distance(2, 1)).toBeCloseTo(1);
    expect(distance(0.5, 1)).toBeCloseTo(1);
    expect(distance(1.3, 1, "linear")).toBeCloseTo(0.3);
    expect(distance(null, 1)).toBeNull();
    expect(distance(0, 1)).toBeNull();
  });
});

describe("BarList", () => {
  const html = render(<BarList label="Closest audiences" rows={bars} max={1} />);

  it("is one image named after the chart, a row per bar, accent only where asked", () => {
    expect(html).toContain('role="img" aria-label="Closest audiences"');
    expect([...html.matchAll(/data-row="/g)]).toHaveLength(3);
    expect(html).toMatch(/data-row="Glimmer Soap" data-tone="accent"/);
    expect(html).toMatch(/data-row="Brookfall Water" data-tone="muted"/);
    expect(text(html)).toContain("Outside the category");
  });

  it("scales bars from zero and draws No data for a missing value, never a zero bar", () => {
    expect(barShares(bars, 1)).toEqual([0.84, 0.42, 0]);
    expect(html).toContain('--f:0.8400');
    const missing = html.slice(html.indexOf('data-row="Quietfern Tea"'));
    expect(missing).toContain('data-missing="true"');
    expect(missing).not.toContain('data-bar="true"');
  });

  it("builds its Table view with the sublabel and note columns only when used", () => {
    const t = barListTable(bars, { label: "Brand", sublabel: "Category", value: "Match" });
    expect(t.columns.map((c) => c.label)).toEqual(["Brand", "Category", "Match", "Note"]);
    expect(t.rows[0]).toEqual(["Glimmer Soap", "personal care", "0.84", "Outside the category"]);
    expect(t.rows[2]).toEqual(["Quietfern Tea", "", NO_DATA, ""]);
    const plain = barListTable([{ label: "Mesa Town", value: 1, display: "#1" }], { label: "Place", value: "Rank" });
    expect(plain.columns.map((c) => c.label)).toEqual(["Place", "Rank"]);
  });

  it("shows the hatch, not an empty box, without rows", () => {
    const empty = render(<BarList label="Empty" rows={[]} emptyLabel="No data yet" />);
    expect(empty).toContain("bg-hatch");
    expect(text(empty)).toBe("No data yet");
  });
});

describe("DivergingRows", () => {
  const rows: DivergingRow[] = [
    { label: "Women", value: 0.31 },
    { label: "Men", value: -0.29 },
    { label: "55+", value: null },
  ];
  const html = render(<DivergingRows label="Who the fans are" rows={rows} />);

  it("puts more to the right in green and less to the left in red, with the direction header", () => {
    expect(html).toMatch(/data-row="Women" data-side="more"/);
    expect(html).toMatch(/data-row="Men" data-side="less"/);
    expect(html).toMatch(/data-row="55\+" data-side="none"/);
    expect(html).toContain('data-bar="more" class="h-3 shrink-0 rounded-r-xs bg-good"');
    expect(html).toContain('data-bar="less" class="h-3 shrink-0 rounded-l-xs bg-danger"');
    expect(text(html)).toContain("Less than averageMore than average");
    expect(text(html)).toContain(`${MINUS}0.29`);
    expect(text(html)).toContain("+0.31");
  });

  it("keeps small values small with a 0.48 floor on the scale", () => {
    expect(divergingShares([{ label: "a", value: 0.12 }])).toEqual([0.25]);
    expect(divergingShares([{ label: "a", value: 0.6 }, { label: "b", value: -0.3 }])).toEqual([1, 0.5]);
    expect(divergingDisplay({ label: "x", value: null })).toBe(NO_DATA);
  });

  it("tabulates every group", () => {
    expect(divergingTable(rows).rows).toEqual([
      ["Women", "+0.31"],
      ["Men", `${MINUS}0.29`],
      ["55+", NO_DATA],
    ]);
  });
});

describe("DivergingPair", () => {
  const groups: PairGroup[] = [
    { label: "Who goes", less: { label: "Families", value: 0.5 }, more: { label: "Artists", value: 2 } },
    { label: "Music", less: { label: "Clubs", value: 0.7 }, more: null },
  ];

  it("draws both sides on one log2 scale with the key over the zero line", () => {
    const shares = pairShares(groups);
    expect(shares[0]!.less).toBeCloseTo(1);
    expect(shares[0]!.more).toBeCloseTo(1);
    expect(shares[1]!.more).toBe(0);
    const html = render(<DivergingPair label="More and less" groups={groups} />);
    expect(text(html)).toContain("Less here");
    expect(text(html)).toContain("More here");
    expect(text(html)).toContain("0.5×");
    expect(html).toContain('data-bar="less"');
  });

  it("tabulates both sides", () => {
    expect(divergingPairTable(groups).rows[1]).toEqual(["Music", "Clubs", "0.7×", "", NO_DATA]);
  });
});

describe("Scoreboard and WinnerTable", () => {
  const a = { name: "Brand Alpha" };
  const b = { name: "Brand Beta" };

  it("prints the score in words for screen readers", () => {
    const html = render(<Scoreboard a={{ ...a, score: 4 }} b={{ ...b, score: 1 }} caption="cities where each ranks first" />);
    // A sentence in the reading order, not an aria-label on a role-less span (axe aria-prohibited-attr).
    expect(html).toContain('<span class="sr-only">Brand Alpha 4, Brand Beta 1</span>');
    expect(html).not.toContain("aria-label=");
    expect(html).toContain("text-accent");
    expect(html).toContain("text-second");
  });

  it("is a real table with the winner as a dot and in words", () => {
    const rows = [
      { label: "Tulsa", winner: "a" as const },
      { label: "25–29", winner: "b" as const },
      { label: "Boise", winner: null },
    ];
    const html = render(<WinnerTable label="Who wins" title="Cities" a={a} b={b} rows={rows} />);
    expect(html).toContain("<table");
    expect(html).toContain('scope="row"');
    expect(html).toContain('<span class="sr-only">Brand Alpha</span>');
    expect([...html.matchAll(/>leads</g)]).toHaveLength(2);
    expect(winnerTable("Cities", a, b, rows).rows).toEqual([
      ["Tulsa", "Brand Alpha"],
      ["25–29", "Brand Beta"],
      ["Boise", NO_DATA],
    ]);
  });
});

describe("RankTrack", () => {
  it("fills the dot at the rank and caps the track at 7", () => {
    const html = render(<RankTrack rank={2} of={12} />);
    expect([...html.matchAll(/rounded-full/g)]).toHaveLength(7);
    expect(html).toContain('data-on="true"');
    expect(text(html)).toBe("#2 of 12");
    expect(rankText(null, 5)).toBe(NO_DATA);
  });

  it("lists markets with their state and tag, and tabulates them", () => {
    const rows = [{ label: "Tulsa", sublabel: "OK", rank: 1, of: 5, tag: "hidden-gem" as const }];
    const html = render(<RankTrackList label="Markets" rows={rows} />);
    expect(text(html)).toContain("TulsaOK");
    expect(text(html)).toContain("Hidden gem");
    expect(rankTrackTable(rows).rows).toEqual([["Tulsa, OK", "#1 of 5", "Hidden gem"]]);
  });
});

describe("MiniBarColumns", () => {
  const columns: MiniBarColumn[] = [
    { label: "More here", tone: "accent", rows: [{ label: "Vinyl", value: 2 }] },
    { label: "Less here", tone: "second", rows: [{ label: "Chains", value: 0.5 }, { label: "Hotels", value: null }] },
  ];

  it("shares one scale across the columns", () => {
    expect(miniBarShares(columns)).toEqual([[1], [1, 0]]);
    const html = render(<MiniBarColumns label="More and less" columns={columns} />);
    expect(html).toContain('data-bar="accent"');
    expect(html).toContain('data-bar="second"');
    expect(text(html)).toContain(NO_DATA);
    expect(miniBarTable(columns).rows).toContainEqual(["Hotels", "Less here", NO_DATA]);
  });
});

describe("RankedFitList", () => {
  it("draws the first bar in accent, the rest muted, and marks climbers in words", () => {
    const rows = [
      { label: "Noodle Bar", value: 91, climbs: true },
      { label: "Bakery", value: 69 },
    ];
    const html = render(<RankedFitList label="Best fit" rows={rows} />);
    expect(html).toContain("<ol");
    expect(html).toMatch(/data-bar="accent"[^>]*style="width:91.00%"/);
    expect(html).toMatch(/data-bar="muted"[^>]*style="width:69.00%"/);
    expect(html).toContain('data-climbs="true"');
    expect(text(html)).toContain("fits better here than citywide");
    expect(fitDisplay({ label: "x", value: 44 })).toBe("44/100");
    expect(rankedFitTable(rows).rows).toEqual([
      ["Noodle Bar", "1", "91/100", "Yes"],
      ["Bakery", "2", "69/100", "No"],
    ]);
  });
});

describe("SlateTable", () => {
  const rows = [
    { category: "Craft beer", name: "Ridge Ale", href: "/d/brand/ridge-ale", fit: 0.9, display: "#1 of 12" },
    { category: "Hard seltzer", name: "Fizzline", fit: 0.7, display: "#1 of 8", tag: "hidden-gem" as const },
    { category: "Pet food", name: null, fit: null, display: "" },
  ];

  it("picks a category icon, falling back to a shopping bag", () => {
    expect(categoryIcon("Craft beer")).toBe("beer");
    expect(categoryIcon("Spirits")).toBe("wine");
    expect(categoryIcon("Outdoor retail")).toBe("tent");
    expect(categoryIcon("Apparel and boots")).toBe("shirt");
    expect(categoryIcon("Quick-service food")).toBe("utensils");
    expect(categoryIcon("Hard seltzer")).toBe("glass-water");
    expect(categoryIcon("Insurance")).toBe("shopping-bag");
  });

  it("is a table on desktop and stacked rows on phones, linking the best fit to its profile", () => {
    const html = render(<SlateTable label="Best fit per category" rows={rows} />);
    expect(html).toContain('<table aria-label="Best fit per category" class="hidden w-full border-collapse md:table"');
    expect(html).toContain("md:hidden");
    expect(html).toContain('href="/d/brand/ridge-ale"');
    expect(text(html)).toContain("Hidden gem");
    expect(text(html)).toContain(NO_DATA);
    expect(slateTable(rows).rows[2]).toEqual(["Pet food", NO_DATA, NO_DATA, ""]);
  });
});

describe("NumberedList and NeighbourColumns", () => {
  it("numbers the list down two columns", () => {
    const items = ["One", "Two", "Three"].map((name) => ({ name: `Brand ${name}` }));
    const html = render(<NumberedList label="Also love" items={items} />);
    expect(html).toContain("--rows:2");
    expect(text(html)).toContain("1BOBrand One");
    expect(numberedListTable(items).rows[2]).toEqual(["Brand Three", "3"]);
  });

  it("heads each domain with its icon and says No data for an empty one", () => {
    const columns = [
      { ...NEIGHBOUR_DOMAINS.music, items: [{ name: "Juniper Rail", href: "/d/artist/juniper-rail", tag: "hidden-gem" as const }] },
      { ...NEIGHBOUR_DOMAINS.tv, items: [] },
    ];
    const html = render(<NeighbourColumns label="What else" columns={columns} />);
    expect(html).toContain('role="group" aria-label="What else"');
    expect(html).toContain('data-icon="music"');
    expect(html).toContain('href="/d/artist/juniper-rail"');
    expect(text(html)).toContain("Hidden gem");
    expect(text(html)).toContain(`TV${NO_DATA}`);
    expect(neighbourTable(columns).rows).toEqual([
      ["Juniper Rail", "Music", "1", "Hidden gem"],
      [NO_DATA, "TV", "", ""],
    ]);
  });
});

describe("ColumnChart", () => {
  it("draws columns from zero, hatches a missing month and the window after the data", () => {
    const points = [
      { label: "Apr", value: 0.5 },
      { label: "May", value: null },
      { label: "Jun", value: 1 },
    ];
    const html = render(<ColumnChart label="Interest" points={points} after="No data after Jun 2025" />);
    expect(html).toMatch(/data-bar="accent"[^>]*style="height:50.00%"/);
    expect(html).toMatch(/data-bar="accent"[^>]*style="height:100.00%"/);
    expect([...html.matchAll(/bg-hatch/g)].length).toBe(2);
    expect(text(html)).toContain("No data after Jun 2025");
    expect(columnTable(points).rows[1]).toEqual(["May", NO_DATA]);
  });
});

describe("glyphs and tags", () => {
  it("picks the More charts glyph by family", () => {
    expect(glyphForDataset("Ranked")).toBe("bars");
    expect(glyphForDataset("Bars")).toBe("diverging");
    expect(glyphForDataset("Momentum")).toBe("columns");
    expect(glyphForDataset("Quadrant")).toBe("dots");
    expect(glyphForDataset("Matrix", { matrixList: true })).toBe("bars");
    expect(glyphForDataset("GeoLift", { mode: "BASE" })).toBe("columns");
    const html = render(<ChartGlyph kind="columns" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-glyph="columns"');
  });

  it("puts tags in words", () => {
    expect(tagText("few-rivals")).toBe("Few rivals nearby");
    expect(tagText({ tone: "accent", label: "Strong" })).toBe("Strong");
    expect(tagText(null)).toBe("");
  });
});
