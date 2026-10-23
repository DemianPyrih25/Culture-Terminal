import type { BriefFigure, BriefModel, Inline } from "../../lib/brief";

/**
 * The brief's reading rows and the sidenotes each one carries (Concept A, D36). A sidenote sits level
 * with the first row that cites it, once, numbered like its superscript; a finished brief cites in
 * reading order, so the margin reads 1, 2, 3 down the page. Pure: the page and the tests share it.
 */

/** Footnote numbers a block cites, in the order a reader meets them, without repeats. */
export function citedIn(...blocks: ReadonlyArray<readonly Inline[] | null | undefined>): number[] {
  const out: number[] = [];
  for (const block of blocks) {
    for (const piece of block ?? []) {
      if ((piece.kind === "metric" || piece.kind === "cite") && !out.includes(piece.footnote)) out.push(piece.footnote);
    }
  }
  return out;
}

/** A matrix this narrow reads at half the column, so two sit side by side (A05 figures 1–2). */
const COMPACT_MATRIX_COLUMNS = 7;

/** A figure that fits half the reading column: a small similarity matrix. */
export function isCompactFigure(figure: BriefFigure): boolean {
  const data = figure.dataset;
  return data?.kind === "Matrix" && data.payload.mode === "similarity" && data.payload.cols.length <= COMPACT_MATRIX_COLUMNS;
}

/** Figures in display rows: consecutive compact figures pair up, every other figure takes a row. */
export function figureRows(figures: readonly BriefFigure[]): BriefFigure[][] {
  const rows: BriefFigure[][] = [];
  for (const figure of figures) {
    const last = rows.at(-1);
    if (isCompactFigure(figure) && last && last.length === 1 && isCompactFigure(last[0] as BriefFigure)) last.push(figure);
    else rows.push([figure]);
  }
  return rows;
}

/** Row keys, in reading order. */
export const ROW = {
  answer: "answer",
  prior: (id: string) => `prior:${id}`,
  keyFigures: "key-figures",
  figures: (row: readonly BriefFigure[]) => `figures:${row.map((f) => f.number).join("-")}`,
  argument: (id: string) => `argument:${id}`,
  change: (n: number) => `change:${n}`,
  sources: "sources",
} as const;

export interface CitingRow {
  key: string;
  cites: number[];
}

/** Every row that can cite a number, in reading order, with what it cites. */
export function citingRows(model: BriefModel): CitingRow[] {
  const rows: CitingRow[] = [{ key: ROW.answer, cites: citedIn(model.answer.headline, model.answer.thesis) }];
  for (const prior of model.priors.items) rows.push({ key: ROW.prior(prior.id), cites: citedIn(prior.measured) });
  rows.push({
    key: ROW.keyFigures,
    cites: model.evidence.keyFigures.flatMap((k) => (k.footnote === null ? [] : [k.footnote])),
  });
  for (const row of figureRows(model.evidence.figures)) {
    rows.push({ key: ROW.figures(row), cites: row.flatMap((f) => [...citedIn(f.caption), f.footnote]) });
  }
  for (const argument of model.evidence.arguments) {
    rows.push({ key: ROW.argument(argument.id), cites: citedIn(argument.qlooFact, argument.ourRead) });
  }
  for (const change of model.risks.changes) {
    rows.push({ key: ROW.change(change.n), cites: [...citedIn(change.condition), ...(change.now ? [change.now.footnote] : [])] });
  }
  return rows;
}

/**
 * Which sidenotes each row carries: every footnote once, at the first row that cites it, by number (a
 * live brief numbers in arrival order, so a row may cite 2 before 1). A footnote no row cites (none
 * should be) closes the Sources row.
 */
export function placeNotes(model: BriefModel): Map<string, number[]> {
  const placed = new Set<number>();
  const out = new Map<string, number[]>();
  for (const row of citingRows(model)) {
    const fresh = row.cites.filter((n) => !placed.has(n)).sort((a, b) => a - b);
    for (const n of fresh) placed.add(n);
    if (fresh.length > 0) out.set(row.key, fresh);
  }
  const rest = model.footnotes.map((f) => f.n).filter((n) => !placed.has(n));
  if (rest.length > 0) out.set(ROW.sources, rest);
  return out;
}

/** Refs of the rivals the question or the priors named (secondary mentions): drawn grey in ranked figures. */
export function expectedRivalRefs(resolves: readonly { role: string; ref: string | null }[]): string[] {
  return [...new Set(resolves.filter((r) => r.role === "secondary" && r.ref !== null).map((r) => r.ref as string))];
}
