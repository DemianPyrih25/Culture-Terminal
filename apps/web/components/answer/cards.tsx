"use client";

import { useId, useState, type ReactNode } from "react";
import type { AnswerGhost, AnswerModel, AnswerReadAs, AnswerStep, AnswerVerdict } from "../../lib/answer";
import { STRENGTH_LABEL, type BriefArgument } from "../../lib/brief";
import { Button, Card, ConfidenceChip, cx, Icon, Monogram, Tag, TopicTile, type IconName, type TopicKey } from "../ui";
import { AnswerProse } from "./answer-prose";
import { useHowWeKnow } from "../drawer";

/**
 * The answer's text cards (§2.6): the verdict, next steps, AI alone, what could change this and why we
 * think this. The guesses card is the working view's (components/working), with the finished caption.
 */

/** The small-caps section label of the Ledger direction (11 px, tracked, ink-3), over each block of the answer. */
export const SECTION_LABEL = "text-[11px] leading-4 font-semibold uppercase tracking-[0.12em] text-ink-3";

/**
 * The verdict block (redesign-v3 xU0kc): not a card but the head of the reading column, ruled off below.
 * The label row with the confidence, the serif verdict line, the headline prose, then the cap and the check.
 */
export function VerdictCard({ verdict, topic, className }: { verdict: AnswerVerdict; topic: TopicKey | null; className?: string }) {
  const how = useHowWeKnow();
  const method = how.available ? () => how.open({ tab: "method" }) : undefined;
  return (
    <section aria-labelledby="verdict-title" data-verdict={verdict.kind} className={cx("flex flex-col gap-6 border-b border-ink pb-8 max-md:gap-5 max-md:pb-6", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className={cx("flex items-center gap-2", SECTION_LABEL)}>
          {topic ? <TopicTile topic={topic} size={20} /> : null}
          <span>Verdict</span>
        </p>
        {verdict.confidence ? <ConfidenceChip level={verdict.confidence} lowered={verdict.lowered} onFullBreakdown={method} /> : null}
      </div>
      <div className="flex flex-col gap-4">
        <h2 id="verdict-title" className="max-w-[720px] font-display text-[34px] leading-[40px] font-medium tracking-[-0.015em] text-ink [overflow-wrap:anywhere] max-md:text-[28px] max-md:leading-[34px]">
          {verdict.line}
        </h2>
        {verdict.kind === "not_enough" ? <p className="type-lead text-ink">Here&apos;s what we found.</p> : null}
        {verdict.headline && verdict.headline.length > 0 ? (
          <p className="max-w-[680px] text-[16px] leading-[26px] text-ink" data-headline="true">
            <AnswerProse inlines={verdict.headline} />
          </p>
        ) : null}
      </div>
      {verdict.advice || verdict.capLine || verdict.check ? (
        <div className="flex flex-col gap-2">
          {verdict.capLine ? (
            <p className="flex items-start gap-2 text-[13px] leading-5 text-ink-2" data-confidence-cap="true">
              <Icon name="triangle-alert" size={14} className="mt-[3px] shrink-0 text-caution" />
              {verdict.capLine}
            </p>
          ) : null}
          {verdict.advice ? <p className="text-[13px] leading-5 text-ink-2">{verdict.advice}</p> : null}
          {verdict.check ? (
            how.available ? (
              // The check line opens How we know (on phones it is the way in: the head's buttons are in the menu).
              <button
                type="button"
                onClick={() => how.open({ tab: "summary" })}
                className="flex min-h-6 items-center gap-2 self-start rounded-sm text-left text-[13px] leading-5 font-medium text-accent hover:underline hover:underline-offset-4 max-md:min-h-11"
                data-check={verdict.check.ok ? "passed" : "partial"}
              >
                <Icon name={verdict.check.ok ? "badge-check" : "triangle-alert"} size={14} className={cx("shrink-0", verdict.check.ok ? "text-good" : "text-caution")} />
                {verdict.check.text}
                <span className="sr-only">: how we know</span>
              </button>
            ) : (
              <p className="flex items-center gap-2 text-[13px] leading-5 text-ink-2" data-check={verdict.check.ok ? "passed" : "partial"}>
                <Icon name={verdict.check.ok ? "badge-check" : "triangle-alert"} size={14} className={cx("shrink-0", verdict.check.ok ? "text-good" : "text-caution")} />
                {verdict.check.text}
              </p>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const STEP_WORD: Readonly<Record<AnswerStep["word"], string>> = { Now: "text-accent", Next: "text-ink-3", Later: "text-ink-3" };
const STEPS_SHOWN = 3;

/** Next steps: a serif title and ruled rows, each with its NOW / NEXT / LATER word in mono. */
export function NextStepsCard({ steps, className }: { steps: readonly AnswerStep[]; className?: string }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const shown = all ? steps : steps.slice(0, STEPS_SHOWN);
  return (
    <section aria-labelledby={`${listId}-title`} className={cx("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-4 pb-2.5">
        <h2 id={`${listId}-title`} className="font-display text-[20px] leading-7 font-medium text-ink">
          Next steps
        </h2>
        {steps.length > STEPS_SHOWN ? (
          <Button variant="link" size="sm" aria-expanded={all} aria-controls={listId} trailing={null} icon={all ? "chevron-up" : "chevron-down"} onClick={() => setAll(!all)}>
            {all ? "Fewer steps" : "More steps"}
          </Button>
        ) : null}
      </div>
      <ol id={listId} className="flex flex-col">
        {shown.map((s, i) => (
          <li key={i} className="flex gap-4 border-t border-line py-3">
            <span className={cx("w-14 shrink-0 pt-[3px] font-mono text-[11px] leading-[18px] font-medium tracking-[0.06em] uppercase", STEP_WORD[s.word])}>{s.word}</span>
            <span className="type-body text-ink">{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function NameList({ names, icon, heading }: { names: AnswerGhost["ai"]; icon: IconName; heading: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className={cx("flex items-center gap-1.5", SECTION_LABEL)}>
        <Icon name={icon} size={13} />
        {heading}
      </p>
      <ul className="flex flex-col gap-1.5">
        {names.map((n, i) => (
          <li key={`${n.name}-${i}`} className="flex min-w-0 items-center gap-2.5 max-md:gap-2">
            <Monogram name={n.name} size={24} />
            {/* Long names wrap; a card never cuts a name with an ellipsis (ANSWER_QUALITY §11). Phones use 13 px. */}
            <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere] max-md:text-[13px] max-md:leading-[18px]">
              {n.name}
            </span>
            {n.both ? (
              <>
                <Icon name="check" size={14} className="shrink-0 text-good-ink" />
                <span className="sr-only">(in both lists)</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** AIAloneCard (GHOST): the same AI with no data beside what the data found. */
export function AIAloneCard({ ghost, className }: { ghost: AnswerGhost; className?: string }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className={cx("flex flex-col", className)} data-ghost={ghost.category}>
      <h2 id={id} className="font-display text-[20px] leading-7 font-medium text-ink">
        {ghost.title}
      </h2>
      <p className="mt-1 type-label font-normal text-ink-2">{ghost.subline}</p>
      <div className="mt-5 grid grid-cols-2 gap-6 border-t border-line pt-4 max-md:gap-4">
        <NameList names={ghost.ai} icon="bot" heading="AI alone" />
        <NameList names={ghost.data} icon="database" heading="From Qloo data" />
      </div>
    </Card>
  );
}

/** ChangeCard: what could change this, on the caution tint, and the way to how we checked. */
export function ChangeCard({ changes, className }: { changes: readonly string[]; className?: string }) {
  const id = useId();
  const how = useHowWeKnow();
  return (
    <section aria-labelledby={id} className={cx("flex flex-col gap-4 rounded-card bg-caution-soft p-6 max-md:p-5", className)}>
      <h2 id={id} className="text-[11px] leading-4 font-semibold tracking-[0.12em] text-caution-ink uppercase">
        What could change this
      </h2>
      {changes.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {changes.map((c, i) => (
            <li key={i} className="flex gap-3 type-body text-ink">
              <span aria-hidden="true" className="shrink-0 text-caution">
                &mdash;
              </span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">Nothing flagged for this answer.</p>
      )}
      {how.available ? (
        <div className="mt-auto pt-2">
          <Button variant="link" trailing="arrow-right" onClick={() => how.open({ tab: "method" })}>
            See how we checked
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const STRENGTH_TONE: Readonly<Record<BriefArgument["strength"], "accent" | "chart" | "second">> = { STRONG: "accent", MODERATE: "chart", THIN: "second" };

function Argument({ argument, n }: { argument: BriefArgument; n: number }) {
  return (
    <li className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="type-body-strong text-ink">
          <span className="mr-2 font-mono text-[13px] font-medium text-ink-3">{n}</span>
          {argument.sectionLabel}
        </span>
        <Tag tone={STRENGTH_TONE[argument.strength]}>{STRENGTH_LABEL[argument.strength]}</Tag>
      </p>
      <div className="grid gap-3 min-[900px]:grid-cols-2 min-[900px]:gap-6">
        <div className="flex flex-col gap-1">
          <p className={SECTION_LABEL}>What the data shows</p>
          <p className="type-body text-ink">
            <AnswerProse inlines={argument.qlooFact} />
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <p className={SECTION_LABEL}>What we read from it</p>
          <p className="type-body text-ink">
            <AnswerProse inlines={argument.ourRead} />
          </p>
        </div>
      </div>
    </li>
  );
}

/** WhyRow: a ruled disclosure row, the thesis and the numbered arguments when open. */
export function WhyRow({ why }: { why: AnswerModel["why"] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (why.count === 0 && (!why.thesis || why.thesis.length === 0)) return null;
  return (
    <section aria-label="Why we think this" className="border-y border-line">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex min-h-14 w-full items-center gap-2 text-left"
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} className="shrink-0 text-ink" />
          <span className="font-display text-[20px] leading-7 font-medium text-ink">Why we think this</span>
          {why.count > 0 ? (
            <span className="type-body text-ink-3">
              {" "}
              · {why.count} {why.count === 1 ? "reason" : "reasons"}
            </span>
          ) : null}
        </button>
      </h2>
      <div id={panel} hidden={!open} className="flex flex-col gap-4 pb-6">
        {why.thesis && why.thesis.length > 0 ? (
          <p className="max-w-[720px] type-body text-ink-2">
            <AnswerProse inlines={why.thesis} />
          </p>
        ) : null}
        {why.arguments.length > 0 ? (
          <ol className="flex flex-col gap-4">
            {why.arguments.map((a, i) => (
              <Argument key={a.id} argument={a} n={i + 1} />
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

/** A serif group title over a group of cards ("More charts"); the icon stays for callers but is quiet. */
export function GroupLabel({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-display text-[20px] leading-7 font-medium text-ink">
      <Icon name={icon} size={16} className="text-ink-3" />
      {children}
    </h2>
  );
}

/**
 * The concept note (the owner's o03 decision; R2, D48): the product or concept asked about is not in the
 * data, so the answer says first, before the verdict, which category was read instead ("Category-level
 * read": no winner, keep or veto for the concept itself), or that it could not be tested. A note strip
 * like the nearest-job one: one chip and the agent's plain sentence.
 */
export function ConceptNote({ text, level = null, className }: { text: string; level?: "category" | "missing" | null; className?: string }) {
  return (
    <section
      aria-label="What was tested"
      data-concept-note={level ?? "true"}
      className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-caution-soft px-4 py-3", className)}
    >
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-chip bg-surface px-2.5 text-[13px] leading-[18px] font-semibold text-ink">
        <Icon name="corner-down-right" size={14} className="text-ink-2" />
        {level === "category" ? "Category-level read" : "Not in the data"}
      </span>
      <p className="min-w-0 flex-1 type-body text-caution-ink [overflow-wrap:anywhere]">{text}</p>
    </section>
  );
}

/** The unlisted note's sentence (D31): who can open a reader's own answer, and what a shared link shows. */
export const UNLISTED_TEXT = "Only people with this link can open this answer. Search engines don't list it, and a shared link shows no preview image.";

/**
 * A reader's own answer, not a curated showcase (D31): a note strip under the page head that says the
 * page is unlisted. One chip and one plain sentence, as the read-as note.
 */
export function UnlistedNote({ className }: { className?: string }) {
  return (
    <section
      aria-label="Unlisted answer"
      data-unlisted="true"
      className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-sunken px-4 py-3", className)}
    >
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-chip bg-surface px-2.5 text-[13px] leading-[18px] font-semibold text-ink">
        <Icon name="link" size={14} className="text-ink-2" />
        Unlisted · user question
      </span>
      <p className="min-w-0 flex-1 type-body text-ink-2 [overflow-wrap:anywhere]">{UNLISTED_TEXT}</p>
    </section>
  );
}

/**
 * The nearest-job note (D41, ANSWER_QUALITY §8): the question asked for more than any job covers, so the
 * answer says at the top, before the verdict, which job it was read as and what it leaves out. A note
 * strip, not a card: one chip and one plain sentence.
 */
export function ReadAsNote({ readAs, className }: { readAs: AnswerReadAs; className?: string }) {
  return (
    <section
      aria-label="How we read your question"
      data-read-as="true"
      className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-caution-soft px-4 py-3", className)}
    >
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-chip bg-surface px-2.5 text-[13px] leading-[18px] font-semibold text-ink">
        <Icon name="corner-down-right" size={14} className="text-ink-2" />
        Read as: {readAs.jobLabel}
      </span>
      <p className="min-w-0 flex-1 type-body text-caution-ink [overflow-wrap:anywhere]">{readAs.text}</p>
    </section>
  );
}
