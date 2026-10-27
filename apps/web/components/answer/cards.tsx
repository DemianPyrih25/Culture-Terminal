"use client";

import { useId, useState, type ReactNode } from "react";
import type { AnswerGhost, AnswerModel, AnswerStep, AnswerVerdict } from "../../lib/answer";
import { STRENGTH_LABEL, type BriefArgument } from "../../lib/brief";
import { Button, Card, CardTitle, ConfidenceChip, cx, Icon, Monogram, Tag, TopicTile, type IconName, type TopicKey } from "../ui";
import { AnswerProse } from "./answer-prose";
import { useHowWeKnow } from "../drawer";

/**
 * The answer's text cards (§2.6): the verdict, next steps, AI alone, what could change this and why we
 * think this. The guesses card is the working view's (components/working), with the finished caption.
 */

/** VerdictCard/answer and /not-enough: padding 28, gap 20. */
export function VerdictCard({ verdict, topic, className }: { verdict: AnswerVerdict; topic: TopicKey | null; className?: string }) {
  const how = useHowWeKnow();
  const method = how.available ? () => how.open({ tab: "method" }) : undefined;
  return (
    <Card padding="lg" aria-labelledby="verdict-title" data-verdict={verdict.kind} className={cx("flex flex-col gap-5", className)}>
      <p className="flex items-center gap-2 type-label text-ink-2">
        {topic ? <TopicTile topic={topic} size={24} /> : null}
        <span>Verdict</span>
      </p>
      <div className="flex flex-col gap-3">
        <h2 id="verdict-title" className="type-display-l text-ink [overflow-wrap:anywhere] max-md:type-display-l-sm">
          {verdict.line}
        </h2>
        {verdict.kind === "not_enough" ? <p className="type-lead text-ink">Here&apos;s what we found.</p> : null}
        {verdict.headline && verdict.headline.length > 0 ? (
          <p className="type-lead text-ink max-md:text-[16px] max-md:leading-6" data-headline="true">
            <AnswerProse inlines={verdict.headline} />
          </p>
        ) : null}
      </div>
      {verdict.confidence || verdict.advice ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {verdict.confidence ? <ConfidenceChip level={verdict.confidence} lowered={verdict.lowered} onFullBreakdown={method} /> : null}
          {verdict.advice ? <p className="type-label text-ink-2">{verdict.advice}</p> : null}
        </div>
      ) : null}
      {verdict.check ? (
        how.available ? (
          // The check line opens How we know (on phones it is the way in: the head's buttons are in the menu).
          <button
            type="button"
            onClick={() => how.open({ tab: "summary" })}
            className="flex min-h-6 items-center gap-2 self-start rounded-sm text-left type-label text-ink-2 hover:text-ink max-md:min-h-11"
            data-check={verdict.check.ok ? "passed" : "partial"}
          >
            <Icon name={verdict.check.ok ? "badge-check" : "triangle-alert"} size={16} className={cx("shrink-0", verdict.check.ok ? "text-good" : "text-caution")} />
            {verdict.check.text}
            <span className="sr-only">: how we know</span>
          </button>
        ) : (
          <p className="flex items-center gap-2 type-label text-ink-2" data-check={verdict.check.ok ? "passed" : "partial"}>
            <Icon name={verdict.check.ok ? "badge-check" : "triangle-alert"} size={16} className={cx("shrink-0", verdict.check.ok ? "text-good" : "text-caution")} />
            {verdict.check.text}
          </p>
        )
      ) : null}
    </Card>
  );
}

const STEP_WORD: Readonly<Record<AnswerStep["word"], string>> = { Now: "text-accent-ink", Next: "text-ink-2", Later: "text-ink-2" };
const STEPS_SHOWN = 3;

export function NextStepsCard({ steps, className }: { steps: readonly AnswerStep[]; className?: string }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const shown = all ? steps : steps.slice(0, STEPS_SHOWN);
  return (
    <Card aria-labelledby={`${listId}-title`} className={cx("flex flex-col", className)}>
      <CardTitle icon="list-checks" id={`${listId}-title`}>
        Next steps
      </CardTitle>
      <ol id={listId} className="flex flex-col gap-4">
        {shown.map((s, i) => (
          <li key={i} className="flex gap-6 max-md:gap-4">
            <span className={cx("w-14 shrink-0 pt-0.5 text-[13px] leading-[18px] font-semibold", STEP_WORD[s.word])}>{s.word}</span>
            <span className="type-body text-ink">{s.text}</span>
          </li>
        ))}
      </ol>
      {steps.length > STEPS_SHOWN ? (
        <div className="mt-auto pt-4">
          <Button variant="quiet" size="sm" aria-expanded={all} aria-controls={listId} trailing={null} icon={all ? "chevron-up" : "chevron-down"} onClick={() => setAll(!all)}>
            {all ? "Fewer steps" : "More steps"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function NameList({ names, icon, heading }: { names: AnswerGhost["ai"]; icon: IconName; heading: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-ink-2">
        <Icon name={icon} size={14} />
        {heading}
      </p>
      <ul className="flex flex-col gap-1.5">
        {names.map((n, i) => (
          <li key={`${n.name}-${i}`} className="flex min-w-0 items-center gap-2.5 max-md:gap-2">
            <Monogram name={n.name} size={24} />
            {/* Phones: two columns are narrow, so a name wraps to a second line at 13 px rather than cut off. */}
            <span className="min-w-0 truncate type-body text-ink max-md:line-clamp-2 max-md:text-[13px] max-md:leading-[18px] max-md:whitespace-normal max-md:[overflow-wrap:anywhere]">
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
      <CardTitle icon="bot" id={id} className="mb-1">
        {ghost.title}
      </CardTitle>
      <p className="type-label text-ink-2">{ghost.subline}</p>
      <div className="mt-5 grid grid-cols-2 gap-6 max-md:gap-4">
        <NameList names={ghost.ai} icon="bot" heading="AI alone" />
        <NameList names={ghost.data} icon="database" heading="From Qloo data" />
      </div>
    </Card>
  );
}

/** ChangeCard: what could change this, and the way to how we checked. */
export function ChangeCard({ changes, className }: { changes: readonly string[]; className?: string }) {
  const id = useId();
  const how = useHowWeKnow();
  return (
    <Card aria-labelledby={id} className={cx("flex flex-col", className)}>
      <CardTitle icon="triangle-alert" iconClassName="text-caution" id={id}>
        What could change this
      </CardTitle>
      {changes.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {changes.map((c, i) => (
            <li key={i} className="flex gap-3 type-body text-ink">
              <span aria-hidden="true" className="mt-[10px] size-[5px] shrink-0 rounded-full bg-ink-3" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">Nothing flagged for this answer.</p>
      )}
      {how.available ? (
        <div className="mt-auto pt-6">
          <Button variant="link" onClick={() => how.open({ tab: "method" })}>
            See how we checked
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const STRENGTH_TONE: Readonly<Record<BriefArgument["strength"], "accent" | "chart" | "second">> = { STRONG: "accent", MODERATE: "chart", THIN: "second" };

function Argument({ argument, n }: { argument: BriefArgument; n: number }) {
  return (
    <li className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] leading-[18px] font-semibold text-ink-2">
          {n}. {argument.sectionLabel}
        </span>
        <Tag tone={STRENGTH_TONE[argument.strength]}>{STRENGTH_LABEL[argument.strength]}</Tag>
      </p>
      <div className="grid gap-3 min-[900px]:grid-cols-2 min-[900px]:gap-6">
        <div className="flex flex-col gap-1">
          <p className="type-label text-ink-2">What the data shows</p>
          <p className="type-body text-ink">
            <AnswerProse inlines={argument.qlooFact} />
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="type-label text-ink-2">What we read from it</p>
          <p className="type-body text-ink">
            <AnswerProse inlines={argument.ourRead} />
          </p>
        </div>
      </div>
    </li>
  );
}

/** WhyRow: a 64 tall disclosure, the thesis and the numbered arguments when open. */
export function WhyRow({ why }: { why: AnswerModel["why"] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (why.count === 0 && (!why.thesis || why.thesis.length === 0)) return null;
  return (
    <Card padding="none" as="section" aria-label="Why we think this">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex min-h-16 w-full items-center gap-2 rounded-card px-6 text-left max-md:px-5"
        >
          <Icon name="message-square-text" size={16} className="shrink-0 text-ink" />
          <span className="text-[15px] leading-6 font-semibold text-ink">Why we think this</span>
          {why.count > 0 ? (
            <span className="type-body text-ink-2">
              {" "}
              · {why.count} {why.count === 1 ? "reason" : "reasons"}
            </span>
          ) : null}
          <Icon name={open ? "chevron-up" : "chevron-down"} size={18} className="ml-auto shrink-0 text-ink-2" />
        </button>
      </h2>
      <div id={panel} hidden={!open} className="flex flex-col gap-4 px-6 pb-6 max-md:px-5 max-md:pb-5">
        {why.thesis && why.thesis.length > 0 ? (
          <p className="type-body text-ink">
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
    </Card>
  );
}

/** A 13/500 ink-2 label with an icon over a group of cards ("More charts"). */
export function GroupLabel({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 type-label text-ink-2">
      <Icon name={icon} size={16} />
      {children}
    </h2>
  );
}
