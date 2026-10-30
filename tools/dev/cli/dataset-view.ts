// A one-line summary per dataset (D#) for the dev CLIs: its kind, title, shape, the formula ids its
// exhibit links to /method, the evidence behind it and its JSON size, so a skill's exhibits can be
// checked from the terminal without the web app.
import type { DatasetEnvelope } from "@ct/contracts";
import { formatBytes, idList } from "./format";
import { renderTable } from "./table";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the payload holds, e.g. "6×6 similarity" or "3 groups · 24 bars · 1 series". */
export function datasetShape(d: DatasetEnvelope): string {
  switch (d.kind) {
    case "Matrix":
      return `${d.payload.rows.length}×${d.payload.cols.length} ${d.payload.mode}`;
    case "Quadrant":
      return `${count(d.payload.points.length, "point")} · ${d.payload.omitted.length} omitted`;
    case "Bars": {
      const bars = d.payload.groups.reduce((n, g) => n + g.bars.length, 0);
      return `${count(d.payload.groups.length, "group")} · ${count(bars, "bar")} · ${d.payload.mode}`;
    }
    case "Slope":
      return `${count(d.payload.lines.length, "line")} × ${count(d.payload.axes.length, "axis", "axes")}`;
    case "GeoLift": {
      const supply = d.payload.supply === null ? "no supply" : count(d.payload.supply.points.length, "venue");
      return `${d.payload.metro} gh${d.payload.precision} · ${count(d.payload.cells.length, "cell")} · ${count(d.payload.neighbourhoods.length, "area")} · ${supply}`;
    }
    case "Ranked": {
      const rows = d.payload.groups.reduce((n, g) => n + g.rows.length, 0);
      return `${count(rows, "row")} in ${count(d.payload.groups.length, "group")} × ${count(d.payload.columns.length, "column")}`;
    }
    case "Slate": {
      const filled = d.payload.rows.filter((r) => r.best !== null).length;
      return `${filled} of ${count(d.payload.rows.length, "category", "categories")} filled · ${count(d.payload.markets.length, "market")}`;
    }
    case "Momentum": {
      const ok = d.payload.series.filter((s) => s.state === "ok").length;
      return `${ok} of ${count(d.payload.series.length, "series", "series")} with signal · ${d.payload.window.start}…${d.payload.window.end}`;
    }
    case "Scorecard":
      return count(d.payload.rows.length, "hypothesis", "hypotheses");
    case "Position": {
      const valued = d.payload.axes.filter((a) => a.value !== null).length;
      return `${valued} of ${d.payload.axes.length} axes · ${count(d.payload.peerCount, "peer")}`;
    }
    case "TasteMap":
      return `${count(d.payload.k, "point")} · stress ${d.payload.stress.toFixed(2)} · ${count(d.payload.imputedPairs.length, "imputed pair")}`;
    case "Supply": {
      const where = d.payload.scope === "market" ? `${d.payload.market ?? "market"} r${d.payload.radiusKm ?? "?"} km` : (d.payload.metro ?? "areas");
      return `${where} · ${count(d.payload.rows.length, "area")} × ${count(d.payload.types.length, "type")} · ${count(d.payload.places.length, "place")}${d.payload.city === null ? " · no city reference" : ""}`;
    }
  }
}

export function renderDatasets(datasets: readonly DatasetEnvelope[], indent = "  "): string[] {
  if (datasets.length === 0) return [`${indent}(none)`];
  return renderTable(
    [
      { header: "id" },
      { header: "kind" },
      { header: "title", max: 48 },
      { header: "shape", max: 60 },
      { header: "formulas", max: 40 },
      { header: "evidence" },
      { header: "json", align: "right" },
    ],
    datasets.map((d) => [
      d.id,
      d.kind,
      d.title,
      datasetShape(d),
      idList(d.formulaIds),
      idList(d.evidenceIds),
      formatBytes(Buffer.byteLength(JSON.stringify(d.payload), "utf8")),
    ]),
    { indent },
  );
}
