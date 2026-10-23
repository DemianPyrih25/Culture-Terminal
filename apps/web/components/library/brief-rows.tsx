import Link from "next/link";
import { cx } from "../ui/cx";
import { MiniMeter } from "../ui/mini-meter";
import type { BriefSummary } from "./briefs-client";
import { deskJobText, shortDate, verdictText } from "./format";

/**
 * A/List header and A/Brief rows: the brief lists of Home (A01), Ask (A02) and the library (A09).
 * Home shows question · verdict · conviction · date; the library adds the sources column and tighter
 * rows. Plain markup, so it renders on the server and inside client lists alike. Below 640 px the
 * side columns fold into one line under the question.
 */

export type BriefColumns = "home" | "library";

const COLUMN = {
  home: { gap: "gap-4", pad: "py-[11px]", verdict: "w-[110px]", conviction: "w-24", date: "w-16" },
  library: { gap: "gap-3", pad: "py-[9px]", verdict: "w-[104px]", conviction: "w-20", date: "w-14" },
} as const;

const HEAD = "text-[10px] leading-none font-semibold tracking-[1.1px] text-dim uppercase";

export interface BriefListHeaderProps {
  columns: BriefColumns;
  /** The column the list is sorted by, marked with ↓ (the library). */
  sortedBy?: "date" | "conviction" | null;
  className?: string;
}

/** The column labels over a brief list. Decorative: each row names its own cells. */
export function BriefListHeader({ columns, sortedBy = null, className }: BriefListHeaderProps) {
  const c = COLUMN[columns];
  const mark = (column: "date" | "conviction", text: string) =>
    sortedBy === column ? <span className="text-text-2">{text} ↓</span> : text;
  return (
    <div
      aria-hidden="true"
      className={cx("flex h-[26px] items-center border-b border-line-strong max-sm:hidden", c.gap, HEAD, className)}
    >
      <span className="min-w-0 flex-1">Question</span>
      <span className={cx("shrink-0", c.verdict)}>Verdict</span>
      <span className={cx("shrink-0", c.conviction)}>{mark("conviction", "Conviction")}</span>
      {columns === "library" ? <span className="w-14 shrink-0 text-right">Sources</span> : null}
      <span className={cx("shrink-0 text-right", c.date)}>{mark("date", "Date")}</span>
    </div>
  );
}

export interface BriefRowViewProps {
  brief: BriefSummary;
  columns: BriefColumns;
  /** The current UTC year: dates in it print without the year. */
  year: number;
  /** Library rows print the job and brief id under the question; Home prints desk and job. */
  meta?: string;
  /** The hairline under the row (default true); off when what follows it carries the rule (the library's open verdict). */
  rule?: boolean;
  /** Makes the whole row the link (Home); the library keeps the link on the question. */
  stretched?: boolean;
  onFocus?: () => void;
  className?: string;
  linkClassName?: string;
}

/** A/Brief: question in serif with its desk and job, verdict, conviction meter and score, date. */
export function BriefRowView({
  brief,
  columns,
  year,
  meta,
  rule = true,
  stretched = true,
  onFocus,
  className,
  linkClassName,
}: BriefRowViewProps) {
  const c = COLUMN[columns];
  const score = brief.confidence?.score ?? null;
  const verdict = verdictText(brief);
  const date = shortDate(brief.createdAt, year);
  return (
    <div className={cx("relative", rule && "border-b border-line", className)}>
      <div className={cx("flex items-center", c.gap, c.pad)}>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <Link
            href={`/run/${brief.runId}`}
            onFocus={onFocus}
            data-brief-link={brief.runId}
            className={cx(
              "font-serif text-[16px] leading-[22px] text-ink hover:underline hover:decoration-line-strong hover:underline-offset-4",
              stretched && "after:absolute after:inset-0 after:content-['']",
              linkClassName,
            )}
          >
            {brief.question}
          </Link>
          <p className="truncate text-[11px] leading-3 text-dim">{meta ?? deskJobText(brief)}</p>
          <p className="text-[12px] text-dim sm:hidden">
            <span className="font-medium text-ink">{verdict}</span>
            {score !== null ? ` · Conviction ${score}` : null}
            {date ? ` · ${date}` : null}
          </p>
        </div>
        <span className={cx("shrink-0 text-[13px] leading-4 font-medium text-ink max-sm:hidden", c.verdict)}>
          <span className="sr-only">Verdict: </span>
          {verdict}
        </span>
        <span className={cx("flex shrink-0 items-center gap-2 max-sm:hidden", c.conviction)}>
          {score !== null ? (
            <MiniMeter value={score} label="Conviction" width={36} markerHeight={0} />
          ) : (
            // A listed brief is finished: no score means none will come, so the meter's "pending" would mislead.
            <>
              <span aria-hidden="true">
                <MiniMeter value={null} label="Conviction" width={36} markerHeight={0} />
              </span>
              <span className="sr-only">Conviction: not scored</span>
            </>
          )}
          <span className="text-[13px] leading-4 font-medium text-ink" aria-hidden="true">
            {score ?? "–"}
          </span>
        </span>
        {columns === "library" ? (
          <span className="w-14 shrink-0 text-right text-[13px] leading-4 text-dim tabular-nums max-sm:hidden">
            <span className="sr-only">Sources: </span>
            {brief.sources}
          </span>
        ) : null}
        <span className={cx("shrink-0 text-right text-[13px] leading-4 text-dim tabular-nums max-sm:hidden", c.date)}>
          <time dateTime={brief.createdAt}>{date}</time>
        </span>
      </div>
    </div>
  );
}
