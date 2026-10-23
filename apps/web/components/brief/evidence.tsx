import type { Strength } from "@ct/contracts";
import { countWord, type BriefArgument, type BriefKeyFigure, type BriefRecommendation } from "../../lib/brief";
import { cx, NoSignal } from "../ui";
import { NoteTrigger } from "./note-ref";
import { sentenceCase } from "./note-text";
import { Prose } from "./prose";

/**
 * 03 Evidence (A/Key figure): the key figures, then (in ./figure-row) the figures, then each argument
 * as QLOO DATA and OUR READ with its strength, then the recommendations.
 */

/**
 * A/Key figure: the number (a button to its request), its label and what it is measured against. A figure
 * still to come shows placeholder rules where its number goes. `live`: the run is still being written, so
 * its note reads lighter (A03); once it has ended, one that never came says why in full.
 */
function KeyFigure({ figure, live }: { figure: BriefKeyFigure; live: boolean }) {
  const item = "flex min-w-[132px] flex-1 flex-col gap-1.5 border-l border-line px-4 py-0.5 first:border-l-0 first:pl-0";
  const metric = figure.metric;
  if (figure.state === "pending" || !metric || figure.footnote === null) {
    return (
      <div className={item} data-key-figure="pending">
        <div aria-hidden="true" className="flex h-[37px] flex-col justify-center gap-2">
          <span className="h-px w-[72px] bg-line-strong" />
          <span className="h-px w-11 bg-line-strong" />
        </div>
        <p className="m-0 text-[13px] leading-[18px] text-dim">{sentenceCase(figure.label)}</p>
        <p className={cx("m-0 text-[10px] leading-[14px] tracking-[0.8px] text-dim uppercase", live ? "font-medium" : "font-semibold")}>{figure.pendingNote}</p>
      </div>
    );
  }
  return (
    <div className={item} data-key-figure={metric.id}>
      <NoteTrigger
        n={figure.footnote}
        label={`${metric.unavailable ? "Not measured" : metric.text}, note ${figure.footnote}: open its source`}
        className="group flex items-start gap-0.5 self-start rounded-brief text-left"
      >
        {metric.unavailable ? (
          <span className="font-serif text-[20px] leading-[37px] font-medium text-dim group-hover:underline group-hover:underline-offset-4" data-unavailable="true">
            Not measured
          </span>
        ) : (
          <span className="type-key-figure text-ink decoration-1 underline-offset-4 group-hover:underline">{metric.text}</span>
        )}
        <span className="text-[11px] leading-4 font-semibold text-accent">{figure.footnote}</span>
      </NoteTrigger>
      <p className="m-0 text-[13px] leading-[18px] text-text-2">{sentenceCase(figure.label)}</p>
      {metric.unavailable ? (
        metric.reason === "no_signal" ? (
          <NoSignal after={metric.window ?? undefined} />
        ) : (
          <p className="m-0 text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-dim uppercase">{metric.reasonLabel}</p>
        )
      ) : figure.comparator ? (
        <p className="m-0 text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-dim uppercase">{figure.comparator}</p>
      ) : null}
    </div>
  );
}

export function KeyFigures({ figures, live = false }: { figures: readonly BriefKeyFigure[]; live?: boolean }) {
  if (figures.length === 0) return null;
  return (
    <div className="flex w-full flex-wrap gap-y-5" data-key-figures={figures.length}>
      {figures.map((f) => (
        <KeyFigure key={f.key} figure={f} live={live} />
      ))}
    </div>
  );
}

const STRENGTH_DOTS: Readonly<Record<Strength, number>> = { STRONG: 3, MODERATE: 2, THIN: 1 };

/** A kicker over a block of rows: ink small caps on an ink rule, a dim note on the right. */
export function BlockKicker({ title, note }: { title: string; note?: string | null }) {
  return (
    <div className="flex w-full flex-wrap items-end justify-between gap-x-4 border-b border-ink pb-0.5">
      <h3 className="m-0 text-[11px] leading-4 font-semibold tracking-[1.2px] text-ink uppercase">{title}</h3>
      {note ? <span className="text-[12px] leading-4 text-dim">{note}</span> : null}
    </div>
  );
}

/** "Three arguments · Qloo data, then our read". */
export function argumentsKicker(count: number): string {
  return `${countWord(count)} ${count === 1 ? "argument" : "arguments"} · Qloo data, then our read`;
}

/** One argument: what Qloo measured, then what we make of it, and how strong it is. */
export function ArgumentItem({ argument }: { argument: BriefArgument }) {
  const dots = STRENGTH_DOTS[argument.strength];
  return (
    <article className="flex w-full flex-col gap-2 border-b border-line py-3" data-argument={argument.id} aria-label={`${argument.id} · ${argument.sectionLabel}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-dim">{argument.id}</span>
        <span className="text-[11px] leading-none font-semibold tracking-[1.3px] text-text-2 uppercase">{argument.sectionLabel}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[1.1px] text-dim uppercase">
          {argument.strengthLabel}
          <span aria-hidden="true" className="inline-flex gap-[3px]">
            {[1, 2, 3].map((i) => (
              <span key={i} className={cx("size-[5px] rounded-full", i <= dots ? "bg-accent" : "bg-line-strong")} />
            ))}
          </span>
        </span>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[84px_minmax(0,1fr)]">
        <dt className="pt-1 text-[10px] leading-4 font-semibold tracking-[1.1px] text-accent uppercase">Qloo data</dt>
        <dd className="m-0 type-body text-ink">
          <Prose inlines={argument.qlooFact} />
        </dd>
        <dt className="pt-1 text-[10px] leading-4 font-semibold tracking-[1.1px] text-dim uppercase">Our read</dt>
        <dd className="m-0 type-body text-text-2">
          <Prose inlines={argument.ourRead} />
        </dd>
      </dl>
    </article>
  );
}

/** What the brief suggests doing, by priority, with the arguments behind each. */
export function Recommendations({ items }: { items: readonly BriefRecommendation[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex w-full flex-col">
      <BlockKicker title="What we would test next" />
      <ul className="m-0 list-none p-0">
        {items.map((r, i) => (
          <li key={i} className="flex gap-4 border-b border-line py-2.5" data-recommendation={r.priority}>
            <span className="w-12 shrink-0 pt-[3px] text-[10px] leading-4 font-semibold tracking-[1.1px] text-accent uppercase">{r.priorityLabel}</span>
            <span className="min-w-0 flex-1 type-body text-ink">{r.action}</span>
            {r.argumentIds.length > 0 ? (
              <span className="shrink-0 pt-[3px] font-mono text-[10.5px] text-dim">{r.argumentIds.join(", ")}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
