// The screener page's model and table (PLAN §5.5, §8.3): sorting with absences always last, every empty
// cell said in words (never 0) with why, requests as the drawer's source rows read them, and the table
// rendered with sortable heads and a button per cell. Invented brands only (D29).
import { ScreenerColumn, type ScreenerCell, type ScreenerRequestEntry, type ScreenerRow } from "@ct/contracts";
import { SCREENER_COLUMNS } from "@ct/quant";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { tasteMap } from "../../components/figures/fixtures";
import { ScreenerMapSlot } from "../../components/screener/map-slot";
import { absenceText, cellText, DEFAULT_SORT, mapSourceText, nextSort, requestLookup, sortRows } from "../../components/screener/model";
import { ScreenerTable } from "../../components/screener/screener-table";
import { isDailyLimit } from "../../components/screener/screener-view";

const ok = (value: number, display = value.toFixed(2)): ScreenerCell => ({ status: "ok", value, reason: null, display, requestIds: ["Q2"] });
const gap = (reason: ScreenerCell["reason"], requestIds: ScreenerCell["requestIds"] = []): ScreenerCell => ({ status: "unavailable", value: null, reason, display: null, requestIds });

function row(key: string, rank: number, label: string, fit: ScreenerCell, popularity: ScreenerCell, flags: ScreenerRow["flags"] = []): ScreenerRow {
  const cells = Object.fromEntries(ScreenerColumn.options.map((c) => [c, gap("not_measured")])) as ScreenerRow["cells"];
  return { key, rank, label, disambiguation: null, flags, cells: { ...cells, fit, popularity } };
}

const ROWS: ScreenerRow[] = [
  row("b2", 1, "Kestrel Tonic", ok(1), ok(0.3), ["UTR"]),
  row("b3", 2, "Larkspur Soda", ok(0.5), ok(0.6)),
  row("b4", 3, "Moraine Fizz", gap("not_scored", ["Q2"]), ok(0.2)),
  row("b1", 4, "Juniper Cola", gap("self", ["Q2"]), ok(0.9), ["SEED"]),
];

describe("sorting", () => {
  it("keeps the screen's FIT order by default and puts absences last in either direction", () => {
    expect(sortRows(ROWS, DEFAULT_SORT).map((r) => r.key)).toEqual(["b2", "b3", "b4", "b1"]);
    expect(sortRows(ROWS, { key: "fit", dir: "asc" }).map((r) => r.key)).toEqual(["b3", "b2", "b4", "b1"]);
    expect(sortRows(ROWS, { key: "popularity", dir: "desc" }).map((r) => r.label)).toEqual(["Juniper Cola", "Larkspur Soda", "Kestrel Tonic", "Moraine Fizz"]);
    expect(sortRows(ROWS, { key: "label", dir: "asc" }).map((r) => r.label)[0]).toBe("Juniper Cola");
  });

  it("flips the same column and starts a new one high to low (names A to Z)", () => {
    expect(nextSort(DEFAULT_SORT, "fit")).toEqual({ key: "fit", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "popularity")).toEqual({ key: "popularity", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "label")).toEqual({ key: "label", dir: "asc" });
  });
});

describe("cells", () => {
  it("prints a value as displayed and an absence as words, never 0", () => {
    expect(cellText(ok(0.82))).toEqual({ text: "0.82", missing: false });
    expect(cellText(gap("not_scored"))).toEqual({ text: "not scored", missing: true });
    expect(cellText(gap("error"))).toEqual({ text: "request failed", missing: true });
  });

  it("says why a cell is empty, and how to get a column the screen did not ask for", () => {
    expect(absenceText("fit", ok(0.5))).toBeNull();
    expect(absenceText("metro_breadth", gap("not_measured"))).toMatch(/picked no market/);
    expect(absenceText("distinctiveness", gap("not_measured"))).toMatch(/taste map/);
    expect(absenceText("fit", gap("self"))).toMatch(/seed brand/);
    expect(absenceText("next_gen_tilt", gap("unavailable", ["Q3"]))).toMatch(/could not be made/);
  });
});

describe("requests", () => {
  const entry: ScreenerRequestEntry = {
    id: "Q3",
    purpose: "age",
    context: "≤24",
    request: { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", "filter.results.entities": "ent-a,ent-b,ent-c", "signal.demographics.age": "24_and_younger", take: "3" } },
    requestId: "req-abcdef123456",
    cache: "hit",
    fetchedAt: "2026-10-28T10:00:00.000Z",
    rows: 3,
    error: null,
  };

  it("reads as a source row: endpoint, filter, id lists as counts, the full query kept for the curl", () => {
    const { lookup, query } = requestLookup(entry, Date.parse("2026-10-28T12:00:00.000Z"));
    expect(lookup).toMatchObject({ endpoint: "/v2/insights", filterType: "urn:entity:brand", filterLabel: "brand", rows: 3, cacheAgeMs: 2 * 3600_000, shortRequestId: "req-…3456" });
    expect(lookup.params).toContainEqual(["filter.results.entities", "3 entity ids"]);
    expect(lookup.params.some(([k]) => k === "filter.type")).toBe(false);
    expect(query.query["filter.results.entities"]).toBe("ent-a,ent-b,ent-c");
  });

  it("tells the day's budget apart from a short wait, so only the day's limit links to the plan", () => {
    expect(isDailyLimit("Today's Qloo requests are used up. The screener resumes at 00:00 UTC; screens already run still open.")).toBe(true);
    expect(isDailyLimit("You have run several new screens in a short time. Try again in 40 s; screens already run still open.")).toBe(false);
    expect(isDailyLimit("The screener is busy right now. Try again in 12 minutes.")).toBe(false);
  });
});

describe("the taste map", () => {
  const sim = (id: string, cache: ScreenerRequestEntry["cache"]): ScreenerRequestEntry => ({
    id,
    purpose: "taste_map",
    context: "similarity row",
    request: { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand" } },
    requestId: `req-${id}`,
    cache,
    fetchedAt: "2026-10-28T10:00:00.000Z",
    rows: 4,
    error: null,
  });
  const requests = [sim("Q7", "miss"), sim("Q8", "hit"), sim("Q9", "miss")];

  it("names its own similarity requests, how many were live, and that no AI model ran", () => {
    expect(mapSourceText({ requests })).toBe("Source: Qloo /v2/insights · 3 similarity requests (Q7–Q9), 2 fetched live · classical MDS in code, no AI model");
  });

  it("draws the map under the table with its method link and source line", () => {
    const html = renderToStaticMarkup(<ScreenerMapSlot map={tasteMap.payload} screen={{ requests }} />);
    expect(html).toContain("Category Taste Map");
    expect(html).toContain("/method#taste_map_mds");
    expect(html).toContain("3 similarity requests (Q7–Q9)");
  });
});

describe("the table", () => {
  it("renders sortable heads, a button per cell, flags as words and absences as reasons", () => {
    const html = renderToStaticMarkup(
      <ScreenerTable caption="Category screen" columns={SCREENER_COLUMNS} rows={ROWS} sort={DEFAULT_SORT} onSort={() => undefined} onCell={() => undefined} selected={null} />,
    );
    expect(html).toContain('aria-sort="descending"');
    expect((html.match(/data-cell=/g) ?? []).length).toBe(ROWS.length * SCREENER_COLUMNS.length);
    expect(html).toContain("Under the radar");
    expect(html).toContain("Seed");
    expect(html).toContain("not scored");
    expect(html).toContain("same entity");
    expect(html).not.toMatch(/data-cell="fit"[^>]*>0<\/button>/);
    expect(html).toContain('href="/method#pct.within_call"');
  });
});
