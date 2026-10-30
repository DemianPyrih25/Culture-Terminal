import type { CandidateSource, DatasetEnvelope, MarketId } from "@ct/contracts";
import { CANDIDATE_SOURCE_LABEL, PRESENCE_CHIP_LABEL } from "@ct/contracts/values";
import { marketIdOf } from "./markets";
import type { ChartBody, ChartTableData } from "./types";

/**
 * Row chips on the answer's charts. R3 (D49): a name or area the question gave reads "You named", one a
 * specialist would check first reads "Expected" (both come from the dataset's `source`). R4 (D45): a market
 * row the AI context says the subject already operates in reads "Already there (AI knowledge, not
 * verified)". Chips never move a row: the ranking stays the data's. Pure.
 */

const key = (label: string) => label.trim().toLowerCase();

function add(marks: Map<string, string[]>, label: string, chip: string) {
  const k = key(label);
  const list = marks.get(k) ?? [];
  if (!list.includes(chip)) list.push(chip);
  marks.set(k, list);
}

const sourceChip = (source: CandidateSource | undefined): string | null => (source ? CANDIDATE_SOURCE_LABEL[source] : null);

/** Chips by row label (lower case) for one dataset; `presence` marks only rows keyed by a market id. */
export function datasetMarks(dataset: DatasetEnvelope, presence: readonly MarketId[] = []): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  const here = new Set<string>(presence);
  const item = (it: { key: string; label: string; source?: CandidateSource }) => {
    const chip = sourceChip(it.source);
    if (chip) add(marks, it.label, chip);
    const market = marketIdOf(it.key);
    if (market && here.has(market)) add(marks, it.label, PRESENCE_CHIP_LABEL);
  };
  switch (dataset.kind) {
    case "Matrix":
      dataset.payload.rows.forEach(item);
      dataset.payload.cols.forEach(item);
      break;
    case "Bars":
      dataset.payload.series.forEach(item);
      break;
    case "Ranked":
      for (const g of dataset.payload.groups) for (const r of g.rows) item(r);
      break;
    case "Slate":
      for (const r of dataset.payload.rows) {
        for (const e of [r.best, r.runnerUp]) {
          const chip = e ? sourceChip(e.source ?? r.source) : null;
          if (e && chip) add(marks, e.label, chip);
        }
      }
      for (const m of dataset.payload.markets) if (here.has(m.id)) add(marks, m.label, PRESENCE_CHIP_LABEL);
      break;
    case "Slope":
      for (const l of dataset.payload.lines) item(l);
      break;
    case "Quadrant":
    case "TasteMap":
      break;
    default:
      break;
  }
  return marks;
}

const marksOf = (marks: ReadonlyMap<string, string[]>, label: string | null) => (label === null ? undefined : marks.get(key(label)));

/** The chart body with its rows' chips; a body without matching rows comes back as it was. */
export function markBody(body: ChartBody, marks: ReadonlyMap<string, string[]>): ChartBody {
  if (marks.size === 0) return body;
  const withMarks = <T extends { marks?: string[] }>(row: T, label: string | null): T => {
    const m = marksOf(marks, label);
    return m && m.length > 0 ? { ...row, marks: [...m] } : row;
  };
  switch (body.type) {
    case "bars":
      return { ...body, rows: body.rows.map((r) => withMarks(r, r.label)) };
    case "ranks":
      return { ...body, rows: body.rows.map((r) => withMarks(r, r.label)) };
    case "numbered":
      return { ...body, rows: body.rows.map((r) => withMarks(r, r.label)) };
    case "neighbours":
      return { ...body, columns: body.columns.map((c) => ({ ...c, items: c.items.map((r) => withMarks(r, r.label)) })) };
    case "slate":
      return { ...body, rows: body.rows.map((r) => withMarks(r, r.best)) };
    default:
      return body;
  }
}

/** The Table view with a "Note" cell for marked rows (first column matched by label). */
export function markTable(table: ChartTableData | null, marks: ReadonlyMap<string, string[]>): ChartTableData | null {
  if (!table || marks.size === 0) return table;
  const noted = table.rows.map((row) => marksOf(marks, (row[0] ?? "").replace(/,\s*[A-Z]{2}$/, ""))?.join(" · ") ?? "");
  if (noted.every((n) => n === "")) return table;
  return { columns: [...table.columns, { label: "Marked" }], rows: table.rows.map((row, i) => [...row, noted[i] ?? ""]) };
}
