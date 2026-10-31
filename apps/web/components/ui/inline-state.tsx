import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

export type InlineStateTone = "neutral" | "caution" | "danger";

const TONE: Readonly<Record<InlineStateTone, { box: string; icon: string; defaultIcon: IconName }>> = {
  neutral: { box: "border-line bg-canvas", icon: "text-ink-2", defaultIcon: "circle-pause" },
  caution: { box: "border-caution/25 bg-caution-soft", icon: "text-caution", defaultIcon: "triangle-alert" },
  danger: { box: "border-danger/25 bg-danger-soft", icon: "text-danger", defaultIcon: "circle-x" },
};

export type InlineStateProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  tone?: InlineStateTone;
  /** Default: circle-pause (neutral), triangle-alert (caution), circle-x (danger). */
  icon?: IconName;
  /** The one sentence. */
  children: ReactNode;
  /** The one button: right of the message on desktop, under it on phones. */
  action?: ReactNode;
};

/**
 * InlineState: one line and one button where the reader acts (paused, refused, needs input, partial,
 * failed, reconnecting). A tinted panel with a hairline, r4, padding 12 16, a 16 px icon, the message 15 ink.
 */
export function InlineState({ tone = "neutral", icon, children, action, className, ...rest }: InlineStateProps) {
  const t = TONE[tone];
  return (
    <div
      data-tone={tone}
      className={cx(
        "flex flex-col gap-3 rounded-sm border px-4 py-3 md:flex-row md:items-center",
        t.box,
        className,
      )}
      {...rest}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex h-6 shrink-0 items-center">
          <Icon name={icon ?? t.defaultIcon} size={16} className={t.icon} />
        </span>
        <div className="min-w-0 flex-1 type-body text-ink">{children}</div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:pl-7">{action}</div> : null}
    </div>
  );
}
