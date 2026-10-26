import Link from "next/link";
import { askHref } from "../ask/ask-href";
import { cx } from "../ui/cx";
import { CheckIcon } from "../ui/icons";
import type { EvalSummary } from "../method/eval-summary";
import { SectionHead } from "../ui/section-head";
import { evalAsOfText, evalFigures } from "./eval-summary";
import { coveredWorkflows, DIRECT_REST_REASON, KIT_ROWS, kitRowText } from "./kit-workflows";
import { ACTION_LINK, noteHref, TRUST_HREF } from "./links";

export interface ProofStripProps {
  /** Numbers traced across the pinned showcase briefs (showcasesTraced); null leaves the line out. */
  traced: { traced: number; total: number; briefs: number } | null;
  /** The eval's aggregates (content/eval-summary.json); null leaves the figures out. */
  evalSummary: EvalSummary | null;
  /** The trust example's question (config/showcases.json). */
  trustQuestion: string;
  /** Its pinned refusal run (the trust-refusal slug), opened as its note at no cost; null while not pinned. */
  trustRunId?: string | null;
  className?: string;
}

const KICKER = "m-0 text-[11px] leading-4 font-semibold tracking-[1.2px] text-ink uppercase";

/** The eval's figures in the key-figure style of a brief: the number in serif, what it measures, against what. */
function EvalFigures({ summary }: { summary: EvalSummary }) {
  const figures = evalFigures(summary);
  if (figures.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-eval-figures={figures.length}>
      <div className="grid w-full grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        {figures.map((f) => (
          <div key={f.key} data-eval-figure={f.key} className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-3">
            <span className="type-key-figure text-ink">{f.value}</span>
            <p className="m-0 text-[13px] leading-[18px] text-text-2">{f.label}</p>
            <p className="m-0 text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-dim uppercase">{f.note}</p>
          </div>
        ))}
      </div>
      <p className="m-0 text-[11px] leading-4 text-dim">{evalAsOfText(summary)} · aggregates only · pre-registered questions and cases</p>
    </div>
  );
}

export interface TrustTileProps {
  question: string;
  /** The pinned refusal run: "See the refusal" opens its note, $0. Without one the tile links the trust page and asking it. */
  runId?: string | null;
  className?: string;
}

/**
 * A trust tile (SPEC §8.1): the refusal demo, a question refused before any request, with a group-level
 * reframe. Asking it again is a live CLERK read, so the pinned refusal comes first when there is one.
 */
export function TrustTile({ question, runId = null, className }: TrustTileProps) {
  return (
    <aside
      aria-labelledby="trust-tile"
      className={cx("flex flex-col gap-3 self-start rounded-brief bg-canvas p-5", className)}
      data-trust-tile="true"
    >
      <h3 id="trust-tile" className={KICKER}>
        What we refuse
      </h3>
      <p className="m-0 font-serif text-[16px] leading-[22px] text-ink">“{question}”</p>
      <p className="m-0 text-[13px] leading-[19px] text-text-2">
        Refused before any Qloo request: no political targeting, and no person is profiled, named or looked up. The refusal
        card offers a group-level question instead.
      </p>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
        {runId ? (
          <Link href={noteHref(runId)} className={ACTION_LINK} data-trust-run="true">
            See the refusal
          </Link>
        ) : null}
        <Link href={TRUST_HREF} className={ACTION_LINK}>
          Trust and safety
        </Link>
        <Link href={askHref(question)} className={ACTION_LINK}>
          Ask it yourself
        </Link>
      </p>
    </aside>
  );
}

/** The kit-workflow table: each data tool, its mnemonic and the kit workflows it covers. */
function KitTable({ className }: { className?: string }) {
  const workflows = coveredWorkflows();
  return (
    <div className={cx("flex flex-col gap-3", className)} data-kit-table={workflows.length}>
      <div className="flex w-full flex-wrap items-end justify-between gap-x-4 border-b border-ink pb-0.5">
        <h3 className={KICKER}>Built on Qloo’s {workflows.length} kit workflows + direct REST</h3>
        <span className="text-[12px] leading-4 text-dim">{KIT_ROWS.length} tools · every call a GET</span>
      </div>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Each tool of the agent and the Qloo kit workflows it covers</caption>
        <thead className="max-sm:hidden">
          <tr className="border-b border-line-strong text-[10px] leading-none font-semibold tracking-[1.1px] text-dim uppercase">
            <th scope="col" className="h-[26px] pr-4 font-semibold">
              Tool
            </th>
            <th scope="col" className="h-[26px] w-20 pr-4 font-semibold">
              Code
            </th>
            <th scope="col" className="h-[26px] font-semibold">
              Kit workflow
            </th>
          </tr>
        </thead>
        <tbody>
          {KIT_ROWS.map((row) => {
            const text = kitRowText(row);
            return (
              <tr key={row.tool} className="border-b border-line align-baseline" data-kit-tool={row.tool}>
                <th scope="row" className="py-[5px] pr-4 text-[13px] leading-[18px] font-medium text-ink">
                  {text.skill}
                </th>
                <td className="w-20 py-[5px] pr-4 font-mono text-[11px] leading-[18px] text-dim">{text.mnemonic}</td>
                <td className="py-[5px] font-mono text-[11px] leading-[18px] text-text-2">
                  {text.workflows}
                  {row.note ? <span className="font-sans text-[12px] text-dim"> · {row.note}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="m-0 text-[12px] leading-[17px] text-dim">{DIRECT_REST_REASON}</p>
    </div>
  );
}

/**
 * The proof strip (PLAN §8.1): "Every number has a receipt" with the numbers traced across the showcases,
 * the eval and Reality Check aggregates when the eval has run, the trust tile, and the kit-workflow table.
 */
export function ProofStrip({ traced, evalSummary, trustQuestion, trustRunId = null, className }: ProofStripProps) {
  return (
    <section aria-label="Proof" className={cx("flex w-full flex-col", className)}>
      <SectionHead title="Proof" aside="Aggregates only · no Qloo values in this strip" />
      <div className="grid w-full grid-cols-1 gap-x-10 gap-y-8 pt-5 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h3 className="m-0 type-figure-title text-ink">Every number has a receipt</h3>
            <p className="m-0 type-body text-text-2">
              Code computes every figure from Qloo responses; the model writes around the numbers and never types one. Before a
              brief is shown, the checker recomputes each number and traces it to the request that produced it.
            </p>
            {traced ? (
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-[13px] leading-[18px]" data-traced="true">
                <CheckIcon size={14} className="text-accent" />
                <span className="font-medium text-ink">
                  {`${traced.traced.toLocaleString("en-US")} / ${traced.total.toLocaleString("en-US")} numbers traced`}
                </span>
                <span className="text-dim">{`across ${traced.briefs} showcase ${traced.briefs === 1 ? "brief" : "briefs"} · Checker`}</span>
              </p>
            ) : null}
          </div>
          {evalSummary ? <EvalFigures summary={evalSummary} /> : null}
        </div>
        <TrustTile question={trustQuestion} runId={trustRunId} />
      </div>
      <KitTable className="pt-10" />
    </section>
  );
}
