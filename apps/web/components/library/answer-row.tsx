import type { ConfidenceBand } from "@ct/contracts";
import Link from "next/link";
import { cx } from "../ui/cx";
import { Icon, Spinner, type IconName } from "../ui/icons";
import { topicForPillar } from "../ui/topic";
import type { AnswerItem, AnswerStatus } from "./answers";

const STATUS_ICON: Readonly<Record<AnswerStatus, { icon: IconName; className: string; label: string }>> = {
  done: { icon: "circle-check", className: "text-good", label: "Done" },
  partial: { icon: "triangle-alert", className: "text-caution", label: "Partial" },
  working: { icon: "loader-circle", className: "text-accent", label: "Working" },
  stopped: { icon: "circle-x", className: "text-ink-3", label: "Stopped" },
};

/** The note's colour: a verdict reads in ink-2, an unfinished state in its status colour. */
const NOTE_TONE: Readonly<Record<AnswerStatus, string>> = {
  done: "font-medium text-ink-2",
  partial: "text-caution-ink",
  working: "text-accent",
  stopped: "text-ink-2",
};

/** The confidence badge: a three-bar meter in the band's colour on its tint. */
const BAND: Readonly<Record<ConfidenceBand, { label: string; bars: number; tile: string; bar: string; text: string }>> = {
  HIGH: { label: "High", bars: 3, tile: "bg-good-soft", bar: "bg-good", text: "text-good-ink" },
  MED: { label: "Medium", bars: 2, tile: "bg-caution-soft", bar: "bg-caution", text: "text-caution-ink" },
  LOW: { label: "Low", bars: 1, tile: "bg-danger-soft", bar: "bg-danger", text: "text-danger-ink" },
};

/** The confidence cell: a small badge for a rated answer, else "Not rated". */
export function ConfidenceBadge({ band }: { band: ConfidenceBand | null | undefined }) {
  if (!band) return <span className="text-[12px] leading-4 text-ink-3">Not rated</span>;
  const look = BAND[band];
  return (
    <span className={cx("inline-flex h-6 items-center gap-[7px] rounded-sm px-2", look.tile)}>
      <span aria-hidden="true" className="flex items-end gap-[2px]">
        {[6, 9, 12].map((h, i) => (
          <span key={h} className={cx("w-[3px] rounded-[1px]", i < look.bars ? look.bar : "bg-ink/10")} style={{ height: h }} />
        ))}
      </span>
      <span className={cx("text-[11px] leading-4 font-semibold tracking-[0.1em] uppercase", look.text)}>
        <span className="sr-only">Confidence </span>
        {look.label}
      </span>
    </span>
  );
}

export interface AnswerRowProps {
  item: AnswerItem;
  /** "Today", "Yesterday", "26 Oct": relativeDay of the item, worked out by the list. */
  day: string;
  className?: string;
}

/**
 * AnswerRow: one of the visitor's answers, a ruled row of the list, the whole row a link to the run. A
 * status icon, the question with its desk and note under it, the confidence badge, the day in mono and a
 * chevron; on phones the day follows the note.
 */
export function AnswerRow({ item, day, className }: AnswerRowProps) {
  const look = STATUS_ICON[item.status];
  const desk = item.pillar ? topicForPillar(item.pillar).label : null;
  return (
    <Link
      href={`/run/${encodeURIComponent(item.runId)}`}
      data-status={item.status}
      className={cx(
        "group flex items-center gap-4 bg-surface px-4 py-3.5 transition-colors duration-150 hover:bg-canvas focus-visible:bg-canvas active:bg-sunken",
        "max-md:items-start max-md:gap-3",
        className,
      )}
    >
      <span className={cx("flex shrink-0 items-center max-md:pt-0.5", look.className)}>
        {item.status === "working" ? <Spinner size={16} /> : <Icon name={look.icon} size={16} />}
        <span className="sr-only">{look.label}: </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="min-w-0 truncate text-[14px] leading-5 font-medium text-ink max-md:line-clamp-2 max-md:whitespace-normal">
          {item.question}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4">
          {desk ? (
            <>
              <span className="shrink-0 text-ink-2">{desk}</span>
              <span aria-hidden="true" className="size-[3px] shrink-0 rounded-full bg-line-strong" />
            </>
          ) : null}
          <span className={cx("min-w-0 truncate", NOTE_TONE[item.status])}>
            {item.note}
            <span className="font-normal text-ink-3 md:hidden">{day ? ` · ${day}` : ""}</span>
          </span>
        </span>
      </span>
      <span className="w-[100px] shrink-0 max-md:hidden">
        <ConfidenceBadge band={item.status === "done" ? item.confidence : null} />
      </span>
      <span className="w-[90px] shrink-0 font-mono text-[12px] leading-4 text-ink-2 tabular-nums max-md:hidden">
        <time dateTime={item.createdAt}>{day}</time>
      </span>
      <span className="flex w-[108px] shrink-0 justify-end max-md:w-auto">
        <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3 transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-ink max-md:mt-0.5" />
      </span>
    </Link>
  );
}
