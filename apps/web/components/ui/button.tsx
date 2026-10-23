import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { ArrowRightIcon } from "./icons";

/** primary: filled ink, one per screen. secondary: bordered, with an icon. quiet: an accent link with an arrow. */
export type ButtonVariant = "primary" | "secondary" | "quiet";
/** md is 36 px (masters); sm is 32 px (the follow-up bar's action row). */
export type ButtonSize = "md" | "sm";

const BASE =
  "inline-flex shrink-0 items-center rounded-brief text-[13px] leading-none font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "justify-center gap-[10px] bg-ink px-4 text-on-ink hover:bg-text-2",
  secondary: "gap-2 border border-line-strong bg-paper px-[14px] text-ink hover:bg-canvas [&_svg]:text-text-2",
  quiet: "gap-[6px] text-accent hover:underline hover:underline-offset-4",
};

const SIZE: Record<ButtonSize, string> = { md: "h-9", sm: "h-8" };

/** The class list of a button, for links and other elements styled as one. */
export function buttonClassName(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cx(BASE, VARIANT[variant], SIZE[size], className);
}

interface ButtonContent {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (secondary). */
  icon?: ReactNode;
  /**
   * Trailing hint. Primary defaults to the ↵ keycap and quiet to the arrow; pass null to drop it.
   */
  hint?: ReactNode | null;
  children: ReactNode;
}

function Content({ variant = "secondary", icon, hint, children }: ButtonContent) {
  const trailing =
    hint !== undefined
      ? hint
      : variant === "primary"
        ? "↵"
        : variant === "quiet"
          ? <ArrowRightIcon />
          : null;
  return (
    <>
      {icon}
      <span>{children}</span>
      {trailing === null ? null : variant === "primary" ? (
        <span aria-hidden="true" className="font-mono text-[11px] font-normal text-on-ink/55">
          {trailing}
        </span>
      ) : (
        <span aria-hidden="true" className="inline-flex">
          {trailing}
        </span>
      )}
    </>
  );
}

export type ButtonProps = ButtonContent &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { ref?: Ref<HTMLButtonElement> };

/** A/Button · primary, secondary and quiet. `type` defaults to "button". */
export function Button({ variant = "secondary", size = "md", icon, hint, children, className, type, ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type ?? "button"} className={buttonClassName(variant, size, className)} {...rest}>
      <Content variant={variant} icon={icon} hint={hint}>
        {children}
      </Content>
    </button>
  );
}

export type ButtonLinkProps = ButtonContent & Omit<ComponentProps<typeof Link>, "children">;

/** A next/link styled as a button; the quiet variant is the usual "Follow this subject →" link. */
export function ButtonLink({ variant = "quiet", size = "md", icon, hint, children, className, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClassName(variant, size, className)} {...rest}>
      <Content variant={variant} icon={icon} hint={hint}>
        {children}
      </Content>
    </Link>
  );
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  /** Accessible name, also the tooltip. */
  label: string;
  /** A 16 px icon. */
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

/** A 28 px square icon button (the running head's Export PDF and Copy link). */
export function IconButton({ label, children, className, type, title, ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-brief text-dim transition-colors hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
