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

export interface AnswerRowProps {
  item: AnswerItem;
  /** "Today", "Yesterday", "26 Oct": relativeDay of the item, worked out by the list. */
  day: string;
  className?: string;
}

/**
 * AnswerRow (N13): one of the visitor's answers, 64 tall, the whole row a link to the run. A status icon,
 * the question, the verdict or the status in words, the day and a chevron; on phones the verdict and the
 * day go under the question.
 */
export function AnswerRow({ item, day, className }: AnswerRowProps) {
  const look = STATUS_ICON[item.status];
  return (
    <Link
      href={`/run/${encodeURIComponent(item.runId)}`}
      data-status={item.status}
      className={cx(
        "flex min-h-16 items-center gap-4 rounded-control border border-line bg-surface px-5 shadow-xs transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md",
        "max-md:gap-3 max-md:px-4 max-md:py-3",
        className,
      )}
    >
      <span className={cx("flex shrink-0 items-center self-center max-md:self-start max-md:pt-[3px]", look.className)}>
        {item.status === "working" ? <Spinner size={18} /> : <Icon name={look.icon} size={18} />}
        <span className="sr-only">{look.label}: </span>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-4 max-md:flex-col max-md:items-start max-md:gap-0.5">
        <span className="min-w-0 truncate type-body-strong text-ink md:w-[560px] md:shrink-0 max-md:w-full max-md:whitespace-normal max-md:line-clamp-2">
          {item.question}
        </span>
        <span className="min-w-0 truncate type-label text-ink-2 md:w-[240px] md:shrink-0 max-md:w-full">
          {item.note}
          <span className="md:hidden">{day ? ` · ${day}` : ""}</span>
        </span>
        <span className="ml-auto shrink-0 text-right type-label text-ink-2 tabular-nums max-md:hidden">
          <time dateTime={item.createdAt}>{day}</time>
        </span>
      </span>
      <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3" />
    </Link>
  );
}
