import type { GhostCategory, GhostFigure, GhostHeadlinePart, GhostName, GhostStatus, GhostView, Inline } from "../../lib/brief";
import { BriefRow, SCROLL_ANCHOR_CLASS } from "../layout";
import { cx, SectionHead } from "../ui";
import { BlockKicker } from "./evidence";
import { MarginNote, NoteList } from "./margin";
import { Prose } from "./prose";

/**
 * LLM alone vs Culture Terminal (SPEC §6.6, PLAN Part 7): GHOST, the same model with no tools, beside
 * this brief. The honesty line first, then the diff's four figures with what each means, both headlines,
 * and per pick category GHOST's names next to the brief's: each name with its mark and its word (✓ found
 * by both, ★ found only by Qloo, ✗ LLM only with whether it resolves in Qloo), never colour alone. Then
 * GHOST's numbers, none with a source. The two columns stack below 640 px.
 */

export const GHOST_SECTION_ID = "ghost";
export const GHOST_TITLE = "LLM alone vs Culture Terminal";
/** The outline's label: the rail is 200 px wide. */
export const GHOST_OUTLINE_LABEL = "LLM alone";

const SIDE_LABEL = { ghost: "LLM alone", qloo: "Culture Terminal" } as const;
const SIDE_NOTE = { ghost: "GHOST · no tools", qloo: "this brief · Qloo" } as const;
type Side = keyof typeof SIDE_LABEL;

const STATUS_TONE: Readonly<Record<GhostStatus, string>> = {
  both: "text-accent",
  qloo_only: "text-accent",
  llm_only: "text-negative",
};

const COLUMN_HEAD = "m-0 flex flex-wrap items-baseline gap-x-2 text-[10px] leading-4 font-semibold tracking-[1.1px] text-ink uppercase";
const TWO_COLUMNS = "grid grid-cols-1 gap-x-8 sm:grid-cols-2";

function ColumnHead({ side }: { side: Side }) {
  return (
    <h4 className={COLUMN_HEAD}>
      {SIDE_LABEL[side]}
      <span className="font-medium tracking-[0.4px] text-dim normal-case">{SIDE_NOTE[side]}</span>
    </h4>
  );
}

/** "Agreement is measured against Qloo's taste graph, not outcomes." On screen and on paper, always. */
export function GhostHonesty({ text }: { text: string }) {
  return (
    <p className="m-0 border-l-2 border-accent py-0.5 pl-3 text-[13px] leading-[19px] font-medium text-ink" data-ghost-honesty="true">
      {text}
    </p>
  );
}

/** The diff's header: each figure, what it is, and what it means. Two by two on phones. */
export function GhostFigures({ figures }: { figures: readonly GhostFigure[] }) {
  return (
    <dl className="m-0 grid w-full grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4 sm:gap-x-0" data-ghost-figures={figures.length}>
      {figures.map((f) => (
        <div key={f.key} className="flex min-w-0 flex-col gap-1 sm:border-l sm:border-line sm:px-4 sm:first:border-l-0 sm:first:pl-0" data-ghost-figure={f.key}>
          {/* Read label first, seen number first. */}
          <dt className="order-2 text-[13px] leading-[18px] text-text-2">{f.label}</dt>
          {/* As the brief's key figures print a metric with no value: the words, never a dash. */}
          <dd className={cx("order-1 m-0", f.measured ? "type-key-figure text-ink" : "font-serif text-[20px] leading-[37px] font-medium text-dim")} data-unavailable={f.measured ? undefined : "true"}>
            {f.value}
          </dd>
          {f.comparator ? <dd className="order-3 m-0 text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-dim uppercase">{f.comparator}</dd> : null}
          <dd className="order-4 m-0 text-[12px] leading-[17px] text-dim">{f.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

/** GHOST's headline, each number it states underlined as having no source. */
function GhostHeadlineText({ parts }: { parts: readonly GhostHeadlinePart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.claim ? (
          <span key={i} className="underline decoration-negative decoration-dotted decoration-1 underline-offset-4" data-ghost-unsourced="true">
            {p.text}
            <span className="sr-only"> (no source)</span>
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** Both headlines side by side: GHOST's, and the brief's with its numbers traced (or why it is not written yet). */
export function GhostHeadlines({ view, headline, pending }: { view: GhostView; headline: Inline[] | null; pending: string }) {
  const claimed = view.headline.some((p) => p.claim);
  const text = "m-0 font-serif text-[18px] leading-[26px] text-ink";
  return (
    <div className="flex w-full flex-col" data-ghost-headlines="true">
      <BlockKicker title="Headline" note="the same question, answered twice" />
      <div className={cx(TWO_COLUMNS, "gap-y-5 pt-3")}>
        <div className="flex min-w-0 flex-col gap-2">
          <ColumnHead side="ghost" />
          <p className={text} data-ghost-headline="ghost">
            <GhostHeadlineText parts={view.headline} />
          </p>
          {claimed ? <p className="m-0 text-[11px] leading-4 text-dim">Dotted underline: a number with no source.</p> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ColumnHead side="qloo" />
          {headline ? (
            <p className={text} data-ghost-headline="brief">
              <Prose inlines={headline} />
            </p>
          ) : (
            <p className="m-0 text-[13px] leading-[19px] text-dim" data-ghost-headline="pending">
              {pending}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One name: its rank, its mark, the name, and the mark's word (with "resolves in Qloo" for an LLM-only name). */
function NameItem({ name, rank }: { name: GhostName; rank: number }) {
  const tone = STATUS_TONE[name.status];
  return (
    <li className="flex gap-2.5 border-b border-line py-2" data-ghost-name={name.status} data-resolves={name.resolves === null ? undefined : String(name.resolves)}>
      {/* Seen, not spoken: the list already gives a screen reader the position. */}
      <span aria-hidden="true" className="w-4 shrink-0 font-mono text-[11px] leading-[21px] text-dim tabular-nums">
        {rank}
      </span>
      <span aria-hidden="true" className={cx("w-3.5 shrink-0 text-[14px] leading-[21px] font-semibold", tone)}>
        {name.mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] leading-[21px] text-ink [overflow-wrap:anywhere]">{name.name}</span>
        <span className="text-[10px] leading-4">
          <span className={cx("font-semibold tracking-[1.1px] uppercase", tone)}>{name.word}</span>
          {name.resolvesText ? <span className="text-text-2"> · {name.resolvesText}</span> : null}
        </span>
      </span>
    </li>
  );
}

function NameColumn({ category, side, names }: { category: GhostCategory; side: Side; names: readonly GhostName[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-3" data-ghost-side={side}>
      <ColumnHead side={side} />
      {names.length > 0 ? (
        // A list styled without markers keeps its semantics in Safari only with the role spelled out.
        <ol role="list" aria-label={`${category.label}: ${SIDE_LABEL[side]}`} className="m-0 list-none p-0">
          {names.map((n, i) => (
            <NameItem key={`${n.status}:${n.name}:${i}`} name={n} rank={i + 1} />
          ))}
        </ol>
      ) : (
        <p className="m-0 border-b border-line py-2 text-[13px] leading-[21px] text-dim">{side === "ghost" ? "GHOST named none." : "Qloo found none."}</p>
      )}
    </div>
  );
}

/** A pick category: GHOST's names beside the brief's. */
export function GhostCategoryBlock({ category }: { category: GhostCategory }) {
  return (
    <div className="flex w-full flex-col" data-ghost-category={category.category}>
      <BlockKicker title={category.label} note={category.tally} />
      <div className={cx(TWO_COLUMNS, "gap-y-4")} data-ghost-columns="true">
        <NameColumn category={category} side="ghost" names={category.ghost} />
        <NameColumn category={category} side="qloo" names={category.qloo} />
      </div>
    </div>
  );
}

/** Every number GHOST stated, verbatim: it had no tools, so none has a request behind it. */
export function GhostClaims({ claims }: { claims: readonly string[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="flex w-full flex-col" data-ghost-claims={claims.length}>
      <BlockKicker title="GHOST's numbers" note={`${claims.length} stated · none sourced`} />
      <ul className="m-0 list-none p-0">
        {claims.map((c, i) => (
          <li key={i} className="flex items-baseline gap-4 border-b border-line py-2.5" data-ghost-claim="unsourced">
            <span className="min-w-0 flex-1 text-[14px] leading-[21px] text-ink [overflow-wrap:anywhere]">{c}</span>
            <span className="shrink-0 text-[10px] leading-4 font-semibold tracking-[1.1px] text-negative uppercase">No source</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface GhostSectionProps {
  view: GhostView;
  /** "05": its number on this page. */
  number: string;
  /** The brief's headline once written; null until then. */
  headline: Inline[] | null;
  /** What the brief's column says while its headline is not written: the answer's tag. */
  pending: string;
}

/** The section's rows, for the brief grid: shown only when the run has a GHOST. */
export function GhostSection({ view, number, headline, pending }: GhostSectionProps) {
  return (
    <>
      <BriefRow
        className="pt-10"
        notes={
          <NoteList>
            <MarginNote glyph="◇" trace="GHOST · same model, no tools">
              The same model as this run&apos;s ANALYST, given the question alone: no tools and no Qloo data. Its names are then looked up in Qloo.
            </MarginNote>
          </NoteList>
        }
      >
        <SectionHead
          id={GHOST_SECTION_ID}
          className={SCROLL_ANCHOR_CLASS}
          number={number}
          title={GHOST_TITLE}
          aside={<span className="max-sm:hidden">Same model, no tools</span>}
        />
        <div className="flex flex-col gap-5 pt-4" data-ghost="section">
          <GhostHonesty text={view.honesty} />
          <GhostFigures figures={view.figures} />
        </div>
      </BriefRow>
      <BriefRow className="pt-8">
        <GhostHeadlines view={view} headline={headline} pending={pending} />
      </BriefRow>
      {view.categories.map((c) => (
        <BriefRow key={c.category} className="pt-7">
          <GhostCategoryBlock category={c} />
        </BriefRow>
      ))}
      {view.claims.length > 0 ? (
        <BriefRow className="pt-7">
          <GhostClaims claims={view.claims} />
        </BriefRow>
      ) : null}
    </>
  );
}
