import type { ScorecardPayload, ScorecardVerdict } from "@ct/contracts";
import type { ReactNode } from "react";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable } from "./figure-table";
import { plainProse, renderProse, type ProseBindings, type ProseRenderer } from "./prose";

/**
 * ScorecardTable (kind Scorecard): the priors written before any data, each judged against the
 * metrics it cites (A/Prior). "We expected: …" in ink, "Measured: …" in dim, the verdict on the
 * right: × REFUTED, ✓ CONFIRMED, – INCONCLUSIVE, and during a live run · AWAITING DATA or CHECK.
 * ScorecardList is the bare list for the Conviction section; ScorecardTable frames it as a figure.
 * The list is already readable HTML, so its table view stays out of the reading order until toggled.
 */

/** A prior's state: a verdict, or still waiting during a live run. */
export type PriorState = ScorecardVerdict | "AWAITING_DATA" | "AWAITING_CHECK";

export const PRIOR_STATE: Readonly<Record<PriorState, { mark: string; word: string; tone: string }>> = {
  REFUTED: { mark: "×", word: "Refuted", tone: "text-second-ink" },
  CONFIRMED: { mark: "✓", word: "Confirmed", tone: "text-accent-ink" },
  INCONCLUSIVE: { mark: "–", word: "Inconclusive", tone: "text-ink-2" },
  AWAITING_DATA: { mark: "·", word: "Awaiting data", tone: "text-ink-2" },
  AWAITING_CHECK: { mark: "·", word: "Awaiting check", tone: "text-ink-2" },
};

/** "We expected: …" without doubling a prefix the statement already has. */
export function expectedText(statement: string): string {
  return /^we expected\b/i.test(statement.trim()) ? statement.trim() : `We expected: ${statement.trim()}`;
}

/** One prior (A/Prior): id, the expectation, what was measured, the verdict. */
export function PriorRow({
  id,
  statement,
  measured,
  state,
}: {
  id: string;
  statement: ReactNode;
  /** "Measured: …" for a verdict; for a waiting prior, e.g. "Written before data · 09:12:04". */
  measured: ReactNode;
  state: PriorState;
}) {
  const s = PRIOR_STATE[state];
  return (
    <li className="flex gap-4 border-b border-line py-3" data-prior={id} data-state={state}>
      <span className="w-6 shrink-0 font-mono text-[12px] leading-[22px] text-ink-2">{id}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="m-0 type-body text-ink">{statement}</p>
        <p className="m-0 font-sans text-[13px] leading-[19px] text-ink-2">{measured}</p>
      </div>
      <span className={`flex w-[140px] shrink-0 items-center justify-end gap-1.5 self-start pt-[3px] ${s.tone}`}>
        <span aria-hidden="true" className="font-sans text-[14px] font-semibold">
          {s.mark}
        </span>
        <span className="type-label">{s.word}</span>
      </span>
    </li>
  );
}

export interface ScorecardOptions {
  /** Renders the note prose; defaults to renderProse with `bindings`. */
  renderProse?: ProseRenderer;
  bindings?: ProseBindings;
  /** Priors still waiting, by hypothesis id; their note is replaced by `waitingNote`. */
  pending?: Readonly<Record<string, "AWAITING_DATA" | "AWAITING_CHECK">>;
  waitingNote?: ReactNode;
}

export function ScorecardList({ data, ...opts }: ScorecardOptions & { data: ScorecardPayload }) {
  const render = opts.renderProse ?? ((text: string) => renderProse(text, opts.bindings));
  return (
    <ol className="m-0 list-none p-0">
      {data.rows.map((row) => {
        const waiting = opts.pending?.[row.hypothesisId];
        return (
          <PriorRow
            key={row.hypothesisId}
            id={row.hypothesisId}
            statement={expectedText(row.statement)}
            measured={waiting ? (opts.waitingNote ?? "Written before data") : <>Measured: {render(row.note)}</>}
            state={waiting ?? row.verdict}
          />
        );
      })}
    </ol>
  );
}

export type ScorecardTableProps = FigureMeta & ScorecardOptions & { data: ScorecardPayload };

export function ScorecardTable(props: ScorecardTableProps) {
  const label = figureLabel(props);
  return (
    <FigureFrame
      meta={props}
      plot={<ScorecardList {...props} />}
      table={<FigureTable spec={scorecardTableSpec(props.data, label, props.bindings, props.pending)} />}
      htmlPlot
    />
  );
}

/** The table view: hypothesis, expectation, the test, the verdict and what was measured, as text. */
export function scorecardTableSpec(
  data: ScorecardPayload,
  caption: string,
  bindings: ProseBindings = {},
  pending: ScorecardOptions["pending"] = {},
) {
  return {
    caption,
    columns: [{ label: "Prior" }, { label: "We expected" }, { label: "Evidence of it" }, { label: "Verdict" }, { label: "Measured" }],
    rows: data.rows.map((row) => {
      const waiting = pending[row.hypothesisId];
      return {
        key: row.hypothesisId,
        cells: [
          row.hypothesisId,
          row.statement,
          row.expectation,
          PRIOR_STATE[waiting ?? row.verdict].word.toLowerCase(),
          waiting ? { kind: "missing" as const, reason: "awaiting" } : plainProse(row.note, bindings),
        ],
      };
    }),
  };
}
