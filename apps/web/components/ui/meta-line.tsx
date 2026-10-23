import { Fragment, type ReactNode } from "react";
import { cx } from "./cx";

export interface MetaLineProps {
  /** The desk (pillar), e.g. "Investment": accent small caps. */
  desk: string;
  /** The job, e.g. "Compare two brands": dim small caps. */
  job?: string;
  /** e.g. "Brief 0001". */
  briefId?: string;
  /** e.g. "6 Jul 2026". */
  date?: string;
  /** Further plain parts after the date. */
  extra?: readonly ReactNode[];
  className?: string;
}

/** A/Meta line: INVESTMENT · COMPARE TWO BRANDS · Brief 0001 · 6 Jul 2026. */
export function MetaLine({ desk, job, briefId, date, extra = [], className }: MetaLineProps) {
  const parts: ReactNode[] = [
    <span key="desk" className="font-semibold tracking-[1.3px] text-accent uppercase">
      {desk}
    </span>,
  ];
  if (job) {
    parts.push(
      <span key="job" className="font-semibold tracking-[1.3px] text-dim uppercase">
        {job}
      </span>,
    );
  }
  if (briefId) parts.push(<span key="brief">{briefId}</span>);
  if (date) parts.push(<span key="date">{date}</span>);
  extra.forEach((part, i) => parts.push(<span key={`extra-${i}`}>{part}</span>));
  return (
    <p className={cx("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-[14px] text-dim", className)}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </p>
  );
}
