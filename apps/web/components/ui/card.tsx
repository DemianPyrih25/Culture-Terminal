import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

/** default: 24 (20 on phones). lg: 28 (verdict, progress). sm: 20 (key numbers). none: no padding. */
export type CardPadding = "default" | "lg" | "sm" | "none";

const PADDING: Readonly<Record<CardPadding, string>> = {
  default: "p-6 max-md:p-5",
  lg: "p-7 max-md:p-5",
  sm: "p-5",
  none: "",
};

/** The class list of a card: surface, 1 px line (accent when selected), r16, shadow-xs. */
export function cardClassName(padding: CardPadding = "default", className?: string, selected = false): string {
  return cx(
    "rounded-card border bg-surface",
    selected ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent),var(--shadow-xs)]" : "border-line shadow-xs",
    PADDING[padding],
    className,
  );
}

export type CardProps = HTMLAttributes<HTMLElement> & {
  /** The element (default section). */
  as?: ElementType;
  padding?: CardPadding;
  /** Line-strong border and shadow-md on hover (cards and rows that are links). */
  interactive?: boolean;
  /** A 2 px accent stroke (the key number the drawer shows). */
  selected?: boolean;
  children?: ReactNode;
};

/** Card base. Cards in a row stretch to equal height; put footers on `mt-auto`. */
export function Card({ as: As = "section", padding = "default", interactive, selected, className, children, ...rest }: CardProps) {
  return (
    <As
      data-selected={selected ? "true" : undefined}
      className={cardClassName(
        padding,
        cx(
          interactive && !selected && "transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md active:shadow-xs",
          className,
        ),
        selected === true,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

export interface CardTitleProps {
  /** A 16 px icon before the title. */
  icon?: IconName;
  /** Icon colour classes (default ink). */
  iconClassName?: string;
  /** The heading level (default h2). */
  as?: "h2" | "h3" | "h4";
  /** Small text after the title, e.g. " · 4 reasons". */
  after?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A card's title row: 16 px icon and 20/600 title, gap 8; 16 px to the body (mb-4). */
export function CardTitle({ icon, iconClassName, as: As = "h2", after, id, className, children }: CardTitleProps) {
  return (
    <div className={cx("mb-4 flex items-center gap-2", className)}>
      {icon ? <Icon name={icon} size={16} className={cx("shrink-0", iconClassName ?? "text-ink")} /> : null}
      <As id={id} className="type-title text-ink max-md:type-title-sm">
        {children}
      </As>
      {after ? <span className="type-label text-ink-2">{after}</span> : null}
    </div>
  );
}
