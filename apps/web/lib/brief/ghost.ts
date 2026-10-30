import type { GhostDiff, GhostPickCategory, Report, RunState } from "@ct/contracts";
import { GHOST_HONESTY_LINE, GHOST_PICK_CATEGORY_VALUES } from "@ct/contracts/values";

/**
 * The GHOST column (SPEC §6.6, PLAN Part 7): what the same model said with no tools, beside what this
 * brief found in Qloo. From the run's { answer, diff } to what "LLM alone vs Culture Terminal" prints:
 * the diff's header figures, each with what it means; both headlines; per pick category GHOST's names
 * (✓ both, ✗ LLM only with whether the name resolves in Qloo) beside the brief's (✓ both, ★ found only
 * by Qloo); and GHOST's numbers, none of which has a source. The honesty line goes with every view.
 */

export type GhostRun = NonNullable<RunState["ghost"]>;
export type GhostStatus = GhostDiff["items"][number]["status"];
type GhostItem = GhostDiff["items"][number];

/** ✓ both, ★ found only by Qloo, ✗ LLM only. */
const GHOST_MARK: Readonly<Record<GhostStatus, string>> = { both: "✓", qloo_only: "★", llm_only: "✗" };

/** The word every mark carries, so a status never rests on its glyph or its colour. */
const GHOST_STATUS_LABEL: Readonly<Record<GhostStatus, string>> = {
  both: "Found by both",
  qloo_only: "Found only by Qloo",
  llm_only: "LLM only",
};

/** A category's tally: "1 both · 4 only Qloo · 3 LLM only". */
const TALLY_WORD: Readonly<Record<GhostStatus, string>> = { both: "both", qloo_only: "only Qloo", llm_only: "LLM only" };

const GHOST_CATEGORY_LABEL: Readonly<Record<GhostPickCategory, string>> = {
  competitors: "Competitors",
  markets: "Markets",
  neighbourhoods: "Neighbourhoods",
  tenants: "Tenants",
  partners: "Partners",
  creators: "Artists & podcasts",
};

/** One name in a column. */
export interface GhostName {
  name: string;
  status: GhostStatus;
  mark: string;
  word: string;
  /** An LLM-only name: whether it resolves to an entity in Qloo; null for the others, or when it was not looked up. */
  resolves: boolean | null;
  /** "resolves in Qloo: no" for an LLM-only name; null for a name Qloo found. */
  resolvesText: string | null;
}

export interface GhostCategory {
  category: GhostPickCategory;
  label: string;
  /** GHOST's names in its own order, then any diff names left over once every pick has one. */
  ghost: GhostName[];
  /** The names this brief found in Qloo, in the diff's order. */
  qloo: GhostName[];
  tally: string;
}

export interface GhostFigure {
  key: "overlap" | "resolvability" | "unsourced" | "popularity";
  /** "20%", "3", "78th"; "Not measured" when the diff has no value. */
  value: string;
  label: string;
  /** "vs 52nd · this brief"; null when there is nothing to compare. */
  comparator: string | null;
  /** What the number means, in a line. */
  meaning: string;
  measured: boolean;
}

/** GHOST's headline in pieces; `claim` marks a number it states with no source. */
export interface GhostHeadlinePart {
  text: string;
  claim: boolean;
}

export interface GhostView {
  /** GHOST_HONESTY_LINE: printed whenever the section is. */
  honesty: string;
  headline: GhostHeadlinePart[];
  figures: GhostFigure[];
  /** Only the categories either side named something in, in the contract's order. */
  categories: GhostCategory[];
  /** Every number GHOST stated, verbatim. */
  claims: string[];
}

/** The run's GHOST: the `ghost` event's, else the one the final report carries. */
export function ghostOf(state: { ghost?: RunState["ghost"]; report?: Pick<Report, "ghost"> | null }): GhostRun | null {
  return state.ghost ?? state.report?.ghost ?? null;
}

/** Names compare by their letters and digits: "Mesa-Line Trucks" is "mesa line trucks". */
const nameKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function ghostName(name: string, status: GhostStatus, resolves: boolean | null): GhostName {
  const llmOnly = status === "llm_only";
  return {
    name,
    status,
    mark: GHOST_MARK[status],
    word: GHOST_STATUS_LABEL[status],
    resolves: llmOnly ? resolves : null,
    resolvesText: llmOnly ? `resolves in Qloo: ${resolves === null ? "not checked" : resolves ? "yes" : "no"}` : null,
  };
}

/**
 * GHOST's column. Every "both" and "LLM only" item of the diff is one of GHOST's picks, so a pick takes the
 * item that spells it the same way; a pick still without one takes the next unclaimed item in the diff's
 * order (the diff may hold Qloo's spelling of a "both" name), keeping GHOST's own spelling. A pick left
 * over was never checked; an item left over is listed after the picks.
 */
function ghostColumn(picks: readonly string[], named: readonly GhostItem[]): GhostName[] {
  const used = new Set<GhostItem>();
  const take = (match: (item: GhostItem) => boolean) => {
    const item = named.find((i) => !used.has(i) && match(i));
    if (item) used.add(item);
    return item;
  };
  const exact = picks.map((pick) => take((i) => nameKey(i.name) === nameKey(pick)));
  const ghost = picks.map((pick, at) => {
    const item = exact[at] ?? take(() => true);
    return item ? ghostName(pick, item.status, item.resolvesInQloo) : ghostName(pick, "llm_only", null);
  });
  for (const item of named) if (!used.has(item)) ghost.push(ghostName(item.name, item.status, item.resolvesInQloo));
  return ghost;
}

function buildCategory(category: GhostPickCategory, picks: readonly string[], items: GhostDiff["items"]): GhostCategory | null {
  const own = items.filter((i) => i.category === category);
  const ghost = ghostColumn(picks, own.filter((i) => i.status !== "qloo_only"));
  const qloo = own.filter((i) => i.status !== "llm_only").map((i) => ghostName(i.name, i.status, null));
  if (ghost.length === 0 && qloo.length === 0) return null;
  const count = (status: GhostStatus) => (status === "llm_only" ? ghost : qloo).filter((n) => n.status === status).length;
  const tally = (["both", "qloo_only", "llm_only"] as const)
    .map((s) => [s, count(s)] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${TALLY_WORD[s]}`)
    .join(" · ");
  return { category, label: GHOST_CATEGORY_LABEL[category], ghost, qloo, tally };
}

/** "81st", "52nd", "3rd", "11th". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** A popularity percentile, 0–1 as Qloo reports it ("78th"); a value already on 0–100 prints as is. */
const percentile = (popularity: number) => ordinal(Math.round(Math.min(100, Math.max(0, popularity > 1 ? popularity : popularity * 100))));

/** As the brief's own key figures print a metric with no value: in words, never a dash that reads as 0. */
const UNMEASURED = "Not measured";

function buildFigures(diff: GhostDiff): GhostFigure[] {
  const { ghost: ghostPop, qloo: qlooPop } = diff.meanPopularity;
  const unsourced = diff.unsourcedNumericClaims;
  return [
    {
      key: "overlap",
      value: diff.overlapAt5 === null ? UNMEASURED : percent(diff.overlapAt5),
      label: "Overlap@5",
      comparator: null,
      meaning: "Of each top five, the share both lists name",
      measured: diff.overlapAt5 !== null,
    },
    {
      key: "resolvability",
      value: diff.resolvability === null ? UNMEASURED : percent(diff.resolvability),
      label: "Resolvability",
      comparator: null,
      meaning: "GHOST's names that resolve to a Qloo entity",
      measured: diff.resolvability !== null,
    },
    {
      key: "unsourced",
      value: String(unsourced),
      label: "Numbers, no source",
      comparator: null,
      meaning: unsourced === 0 ? "GHOST stated no numbers" : `${unsourced === 1 ? "A number" : "Numbers"} GHOST states with no request behind ${unsourced === 1 ? "it" : "them"}`,
      measured: true,
    },
    {
      key: "popularity",
      value: ghostPop === null ? UNMEASURED : percentile(ghostPop),
      label: "Mean popularity",
      comparator: qlooPop === null ? null : `vs ${percentile(qlooPop)} · this brief`,
      meaning: "Popularity percentile of GHOST's picks; higher is more obvious",
      measured: ghostPop !== null,
    },
  ];
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isDigit = (c: string | undefined) => c !== undefined && /\p{N}/u.test(c);

/**
 * GHOST's headline with each numeric claim marked where it stands verbatim. A claim is matched whole: not
 * inside a longer number or word ("70%" never marks "170%"), and the earliest, then the longest, wins.
 */
export function markClaims(headline: string, claims: readonly string[]): GhostHeadlinePart[] {
  const spans: [number, number][] = [];
  for (const claim of new Set(claims.map((c) => c.trim()).filter((c) => c.length > 0))) {
    for (let at = headline.indexOf(claim); at >= 0; at = headline.indexOf(claim, at + 1)) {
      const end = at + claim.length;
      if (isWordChar(headline[at - 1]) && isWordChar(claim[0])) continue;
      if (isDigit(headline[end]) && isDigit(claim[claim.length - 1])) continue;
      spans.push([at, end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: GhostHeadlinePart[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    if (start > cursor) parts.push({ text: headline.slice(cursor, start), claim: false });
    parts.push({ text: headline.slice(start, end), claim: true });
    cursor = end;
  }
  if (cursor < headline.length) parts.push({ text: headline.slice(cursor), claim: false });
  return parts;
}

/** The section's view, or null when the run has no GHOST: then the brief prints no section at all. */
export function buildGhostView(ghost: GhostRun | null): GhostView | null {
  if (!ghost) return null;
  const { answer, diff } = ghost;
  const categories = GHOST_PICK_CATEGORY_VALUES
    .map((category) => buildCategory(category, answer.picks[category], diff.items))
    .filter((c): c is GhostCategory => c !== null);
  return {
    // The contract pins diff.honestyLine to this literal; the view never depends on a stored copy of it.
    honesty: GHOST_HONESTY_LINE,
    headline: markClaims(answer.headline, answer.numeric_claims),
    figures: buildFigures(diff),
    categories,
    claims: answer.numeric_claims.filter((c) => c.trim().length > 0),
  };
}
