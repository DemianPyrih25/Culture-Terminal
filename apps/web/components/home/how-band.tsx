import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";

/** How every answer is made: the three promises beside (or under) the question box. */
export const HOW_ITEMS: readonly { icon: IconName; title: string; line: string }[] = [
  {
    icon: "shield-check",
    title: "Every number checked",
    line: "Computed in code and traced to its source (Qloo, SEC filings, the Census or OpenStreetMap) before you see it.",
  },
  { icon: "bot", title: "Measured against a guess", line: "Each answer shows what AI alone would have said." },
  { icon: "list-checks", title: "Made in the open", line: "Watch each step while the answer is made." },
];

/** The how list: a small accent icon, a title and one line per item, stacked; three columns on mid widths. */
export function HowBand({ className }: { className?: string }) {
  return (
    <ul className={cx("m-0 grid list-none grid-cols-1 gap-5 p-0 md:max-xl:grid-cols-3 md:max-xl:gap-6", className)}>
      {HOW_ITEMS.map((item) => (
        <li key={item.title} className="flex items-start gap-2.5">
          <Icon name={item.icon} size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="type-label text-ink">{item.title}</span>
            <span className="type-caption text-ink-2">{item.line}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
