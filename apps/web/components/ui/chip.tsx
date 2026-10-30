import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

/**
 * fill: a suggestion that fills or asks. go: the same with a trailing arrow (it goes somewhere). filter:
 * a toggle whose "on" state is accent-soft.
 */
export type ChipVariant = "fill" | "go" | "filter";

const BASE =
  "inline-flex h-9 max-w-full shrink-0 items-center gap-1.5 rounded-chip border px-[14px] text-[14px] leading-5 font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:text-ink-3";
const OFF = "border-line bg-surface text-ink hover:border-accent-soft hover:bg-accent-soft hover:text-accent-ink";
const ON = "border-accent-soft bg-accent-soft text-accent-ink";

/** The class list of a chip. */
export function chipClassName(on = false, className?: string): string {
  return cx(BASE, on ? ON : OFF, className);
}

/** A chip whose words wrap onto more lines instead of being cut (long next moves; ANSWER_QUALITY §11). */
const WRAP = "h-auto min-h-9 py-1.5 whitespace-normal text-left";

function ChipContent({ variant, wrap = false, children }: { variant: ChipVariant; wrap?: boolean; children: ReactNode }) {
  return (
    <>
      <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"}>{children}</span>
      {variant === "go" ? <Icon name="arrow-right" size={14} className="shrink-0" /> : null}
    </>
  );
}

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ChipVariant;
  /** Filter chips: the "on" state, announced with aria-pressed. */
  on?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

/** C/Chip: 36 tall, r999, 14/500 on surface with a hairline; accent-soft on hover. */
export function Chip({ variant = "fill", on, children, className, type, ref, ...rest }: ChipProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-pressed={variant === "filter" ? on === true : undefined}
      className={chipClassName(variant === "filter" && on === true, className)}
      {...rest}
    >
      <ChipContent variant={variant}>{children}</ChipContent>
    </button>
  );
}

export type ChipLinkProps = Omit<ComponentProps<typeof Link>, "children"> & {
  variant?: Exclude<ChipVariant, "filter">;
  /** Let long words wrap instead of cutting them with an ellipsis. */
  wrap?: boolean;
  children: ReactNode;
};

/** A chip that is a link (next/link), e.g. a next move that asks a follow-up. Defaults to go. */
export function ChipLink({ variant = "go", wrap = false, children, className, ...rest }: ChipLinkProps) {
  return (
    <Link className={chipClassName(false, cx(wrap && WRAP, className))} {...rest}>
      <ChipContent variant={variant} wrap={wrap}>
        {children}
      </ChipContent>
    </Link>
  );
}
