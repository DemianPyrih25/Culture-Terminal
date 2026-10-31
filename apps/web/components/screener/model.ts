import type {
  ScreenerCell,
  ScreenerColumn,
  ScreenerRequestEntry,
  ScreenerRequestPurpose,
  ScreenerResult,
  ScreenerRow,
} from "@ct/contracts";
import { plural, shortRequestId } from "../../lib/brief/format";
import type { CallQuery } from "../drawer/request-copy";
import type { Lookup } from "../drawer/source-row";
import { reasonLabel } from "../figures/format";

/**
 * What the screener page shows of a screen (pure, tested without a browser): the sort order of the
 * table, each cell's words, why an unavailable cell is empty, and each request as the How we know
 * drawer's source row reads it.
 */

export type SortKey = ScreenerColumn | "label";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** The screen's own order: FIT, best first (contracts ScreenerRow.rank). */
export const DEFAULT_SORT: SortState = { key: "fit", dir: "desc" };

/** A new column sorts high to low (A to Z for names); the same column again flips it. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === "desc" ? "asc" : "desc" };
  return { key, dir: key === "label" ? "asc" : "desc" };
}

/**
 * Rows in the sort order. Cells with a value sort by it; unavailable cells always go last in either
 * direction (an absence is not a low score), in the screen's own rank order; ties keep that order too.
 */
export function sortRows(rows: readonly ScreenerRow[], sort: SortState): ScreenerRow[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.key === "label") return sign * a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.rank - b.rank;
    const va = a.cells[sort.key].value;
    const vb = b.cells[sort.key].value;
    if (va === null || vb === null) return va === null ? (vb === null ? a.rank - b.rank : 1) : -1;
    return sign * (va - vb) || a.rank - b.rank;
  });
}

/** The value as printed, or the absence in words ("not scored"), never a 0. */
export function cellText(cell: ScreenerCell): { text: string; missing: boolean } {
  return cell.status === "ok" && cell.display !== null ? { text: cell.display, missing: false } : { text: reasonLabel(cell.reason), missing: true };
}

/** One line under each column head: what the number is. */
export const COLUMN_HINT: Readonly<Record<ScreenerColumn, string>> = {
  fit: "How strongly the category's (or seed's) taste points to the brand, 0–1 within this set.",
  distinctiveness: "1 − similarity to its nearest brand in the taste map, with its rank.",
  next_gen_tilt: "Rank among under-30 audiences minus rank among 55+, −1 to +1.",
  metro_breadth: "Markets that place it in the top half of this set.",
  popularity: "Qloo's 0–1 popularity: breadth of cultural signal, not sales.",
  under_the_radar: "FIT minus popularity: strong taste fit that is not yet widely known.",
};

/**
 * Why a cell is empty, as a sentence for the drawer. A column the screen did not ask for says how to
 * get it; a cell whose requests ran says what those requests left out.
 */
export function absenceText(column: ScreenerColumn, cell: ScreenerCell): string | null {
  if (cell.status === "ok") return null;
  if (cell.reason === "not_measured" && cell.requestIds.length === 0) {
    if (column === "metro_breadth") return "Not measured: this screen picked no market. Add up to 4 markets to read metro breadth.";
    if (column === "distinctiveness") {
      return "Not measured: distinctiveness needs the taste map's similarity calls. Turn on the taste map, or the brand was outside the top 14 the map compares.";
    }
  }
  switch (cell.reason) {
    case "self":
      return "The seed brand is the signal every other brand is scored against, so it has no score of its own here.";
    case "not_scored":
      return "Qloo returned this brand at its shared floor score, which means no relationship to the signal; it is left unscored, not ranked last.";
    case "dropped":
      return "Qloo left this brand out of the request's answer, so there is nothing to rank.";
    case "insufficient_n":
      return "Too few brands were scored in that request to rank any of them.";
    case "budget_truncated":
      return "The request was not made: this screen's Qloo budget ran out first.";
    case "error":
      return "The request failed, so this value could not be measured. Run the screen again to retry it.";
    case "unavailable":
      return "The request could not be made, for example a market whose Qloo locality is not pinned on this server.";
    default:
      return `No value: ${reasonLabel(cell.reason)}.`;
  }
}

export const PURPOSE_LABEL: Readonly<Record<ScreenerRequestPurpose, string>> = {
  resolve: "Finding the category or brand",
  discovery: "The brands screened, scored on one scale",
  scoring: "One-scale scoring",
  age: "Age context",
  market: "Market context",
  taste_map: "Taste map similarities",
};

/** Long entity lists read as a count in the request block; the full list (names, R8) stays in Copy request. */
const ID_LISTS: ReadonlySet<string> = new Set(["filter.results.entities", "signal.interests.entities", "filter.exclude.entities"]);

/** A request as the drawer's SourceRow reads it, with its full query for an exact "Copy request". */
export function requestLookup(entry: ScreenerRequestEntry, now: number): { lookup: Lookup; query: CallQuery } {
  const filterType = entry.request.query["filter.type"] ?? null;
  const params = Object.entries(entry.request.query)
    .filter(([k]) => k !== "filter.type")
    .map(([k, v]): [string, string] => {
      if (!ID_LISTS.has(k)) return [k, v];
      const n = v.split(",").filter(Boolean).length;
      return [k, plural(n, "entity id")];
    });
  const fetched = Date.parse(entry.fetchedAt);
  return {
    lookup: {
      qlooCallId: entry.id,
      endpoint: entry.request.path,
      filterType,
      filterLabel: filterType === null ? null : filterType.replace(/^urn:(?:entity:)?/, "").replace(/_/g, " "),
      refs: [],
      params,
      rows: entry.rows,
      cache: entry.cache,
      cacheAgeMs: entry.cache === "miss" || Number.isNaN(fetched) ? null : Math.max(0, now - fetched),
      at: entry.fetchedAt,
      requestId: entry.requestId,
      shortRequestId: shortRequestId(entry.requestId),
    },
    query: { path: entry.request.path, query: entry.request.query },
  };
}

/** The taste map's source line: its own similarity requests, how many were fetched live, and the cost. */
export function mapSourceText(screen: Pick<ScreenerResult, "requests">): string {
  const calls = screen.requests.filter((r) => r.purpose === "taste_map");
  const live = calls.filter((r) => r.cache === "miss").length;
  const ids = calls.length === 0 ? "" : ` (${calls[0]!.id}${calls.length > 1 ? `–${calls[calls.length - 1]!.id}` : ""})`;
  return `Source: Qloo /v2/insights · ${plural(calls.length, "similarity request")}${ids}, ${live} fetched live · classical MDS in code, no AI model`;
}

/** The requests a cell cites, in screen order. */
export function cellRequests(screen: Pick<ScreenerResult, "requests">, cell: ScreenerCell): ScreenerRequestEntry[] {
  const ids = new Set(cell.requestIds);
  return screen.requests.filter((r) => ids.has(r.id));
}
