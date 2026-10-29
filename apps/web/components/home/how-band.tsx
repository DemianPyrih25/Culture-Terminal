import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";

/** The three promises under the question box (N01 how band). */
export const HOW_ITEMS: readonly { icon: IconName; title: string; line: string }[] = [
  { icon: "shield-check", title: "Every number checked", line: "Traced to its source (Qloo, SEC filings or the Census) before you see it." },
  { icon: "bot", title: "Better than a guess", line: "Each answer shows what AI alone would have said." },
  { icon: "clock-4", title: "Ready in about a minute", line: "Watch each step while the answer is made." },
];

/** The how band: three columns of an icon tile (40, sunken, r12), a title and one line; stacked on phones. */
export function HowBand({ className }: { className?: string }) {
  return (
    <ul className={cx("m-0 grid list-none grid-cols-1 gap-5 p-0 md:grid-cols-3 md:gap-6", className)}>
      {HOW_ITEMS.map((item) => (
        <li key={item.title} className="flex items-start gap-4">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-sunken text-ink-2">
            <Icon name={item.icon} size={20} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 pt-px">
            <span className="type-body-strong text-ink">{item.title}</span>
            <span className="type-body text-ink-2">{item.line}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
