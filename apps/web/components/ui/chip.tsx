import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

/**
 * fill: a suggestion that fills or asks. go: the same with a trailing arrow (it goes somewhere). filter:
 * a toggle whose "on" state is accent-soft with an accent line. Quiet: hairline, r4, 13/500.
 */
export type ChipVariant = "fill" | "go" | "filter";

const BASE =
  "inline-flex h-8 max-w-full shrink-0 items-center gap-1.5 rounded-sm border px-3 text-[13px] leading-[18px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:text-ink-3";
const OFF = "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink active:bg-sunken";
const ON = "border-accent bg-accent-soft text-accent-ink";

/** The class list of a chip. */
export function chipClassName(on = false, className?: string): string {
  return cx(BASE, on ? ON : OFF, className);
}

/** A chip whose words wrap onto more lines instead of being cut (long next moves; ANSWER_QUALITY §11). */
const WRAP = "h-auto min-h-8 py-1.5 whitespace-normal text-left";

function ChipContent({ variant, wrap = false, children }: { variant: ChipVariant; wrap?: boolean; children: ReactNode }) {
  return (
    <>
      <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"}>{children}</span>
      {variant === "go" ? <Icon name="arrow-right" size={14} className="shrink-0 text-ink-3" /> : null}
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

/** C/Chip: 32 tall, r4, 13/500 ink-2 on surface with a hairline; line-strong on hover. */
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
