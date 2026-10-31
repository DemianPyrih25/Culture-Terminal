import Link from "next/link";
import { cx } from "../ui/cx";
import { Icon, Spinner, type IconName } from "../ui/icons";
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
  stopped: "text-ink-3",
};

export interface AnswerRowProps {
  item: AnswerItem;
  /** "Today", "Yesterday", "26 Oct": relativeDay of the item, worked out by the list. */
  day: string;
  className?: string;
}

/**
 * AnswerRow: one of the visitor's answers, a ruled row of the list, the whole row a link to the run. A
 * status icon, the question with its note under it, the day in mono and a chevron; on phones the day
 * follows the note.
 */
export function AnswerRow({ item, day, className }: AnswerRowProps) {
  const look = STATUS_ICON[item.status];
  return (
    <Link
      href={`/run/${encodeURIComponent(item.runId)}`}
      data-status={item.status}
      className={cx(
        "group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-canvas focus-visible:bg-canvas",
        "max-md:items-start max-md:gap-3",
        className,
      )}
    >
      <span className={cx("flex shrink-0 items-center max-md:pt-0.5", look.className)}>
        {item.status === "working" ? <Spinner size={16} /> : <Icon name={look.icon} size={16} />}
        <span className="sr-only">{look.label}: </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-[14px] leading-5 font-medium text-ink max-md:line-clamp-2 max-md:whitespace-normal">
          {item.question}
        </span>
        <span className={cx("min-w-0 truncate type-caption", NOTE_TONE[item.status])}>
          {item.note}
          <span className="font-normal text-ink-3 md:hidden">{day ? ` · ${day}` : ""}</span>
        </span>
      </span>
      <span className="w-[96px] shrink-0 font-mono text-[12px] leading-4 text-ink-3 tabular-nums max-md:hidden">
        <time dateTime={item.createdAt}>{day}</time>
      </span>
      <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3 transition-colors group-hover:text-ink max-md:mt-0.5" />
    </Link>
  );
}
