import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { Monogram } from "../ui/monogram";
import { Skeleton } from "../ui/skeleton";
import { TopicTile, type TopicKey } from "../ui/topic";

export interface PageHeadProps {
  /** The topic tile; null shows a tile skeleton (a live run before the question is read). */
  topic: TopicKey | null;
  /** "Brands & investing · Real competitors · Data as of 23 Oct 2026". */
  eyebrow: ReactNode;
  /** The phone eyebrow ("Brands & investing · 23 Oct 2026"); default `eyebrow`. */
  mobileEyebrow?: ReactNode;
  /** The question, a serif title in ink. */
  question: ReactNode;
  /** The question's element (default h1: one per page). */
  questionAs?: "h1" | "h2" | "p";
  /** Right of the eyebrow on desktop (gap 12): How we know, Share, the ellipsis menu; or Stop. */
  actions?: ReactNode;
  /** On phones, right of the eyebrow (e.g. Stop on a live run). Answer pages have none. */
  mobileActions?: ReactNode;
  /** Compare: subject and second monograms (32) with "vs" before the question. */
  compare?: { subject: string; second: string };
  className?: string;
}

/**
 * C/PageHead (Ledger): not sticky. A 40 px top row (topic tile and the muted eyebrow left, actions right),
 * then the question as the serif page title in ink (max 900). Variants: answer, working (Stop only), compare (monograms), phone. Between 768
 * and 899 px the eyebrow wraps and the actions move under it, so the date is never cut.
 */
export function PageHead({
  topic,
  eyebrow,
  mobileEyebrow,
  question,
  questionAs: Question = "h1",
  actions,
  mobileActions,
  compare,
  className,
}: PageHeadProps) {
  return (
    <div className={cx("flex flex-col gap-3 max-md:gap-2", className)}>
      <div className="flex min-h-10 items-center justify-between gap-3 md:max-[900px]:flex-wrap md:max-[900px]:gap-y-2">
        <p className="flex min-w-0 items-center gap-2.5 type-label text-ink-2 max-md:text-[12px] max-md:leading-4">
          {topic ? (
            <>
              <TopicTile topic={topic} size={24} className="max-md:hidden" />
              <TopicTile topic={topic} size={20} className="md:hidden" />
            </>
          ) : (
            <Skeleton className="size-6 max-md:size-5" />
          )}
          <span className={cx("min-w-0 [overflow-wrap:anywhere]", mobileEyebrow !== undefined && "max-md:hidden")}>{eyebrow}</span>
          {mobileEyebrow !== undefined ? <span className="min-w-0 [overflow-wrap:anywhere] md:hidden">{mobileEyebrow}</span> : null}
        </p>
        {actions ? <div className="flex shrink-0 items-center gap-3 max-md:hidden">{actions}</div> : null}
        {mobileActions ? <div className="flex shrink-0 items-center gap-2 md:hidden">{mobileActions}</div> : null}
      </div>
      <div className="flex items-center gap-3">
        {compare ? (
          <span className="flex shrink-0 items-center gap-2 type-label text-ink-2">
            <Monogram name={compare.subject} size={32} palette="subject" />
            vs
            <Monogram name={compare.second} size={32} palette="second" />
          </span>
        ) : null}
        <Question className="max-w-[900px] type-title-l text-pretty text-ink max-md:type-title-l-sm">{question}</Question>
      </div>
    </div>
  );
}
