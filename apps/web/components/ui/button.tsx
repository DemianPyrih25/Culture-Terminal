import Link from "next/link";
import { isValidElement, type ButtonHTMLAttributes, type ComponentProps, type ReactElement, type ReactNode, type Ref } from "react";
import { cx } from "./cx";
import { Icon, isIconName, Spinner, type IconName } from "./icons";

/**
 * primary: the ledger-blue action, one per view, with a trailing arrow. secondary: white with a hairline,
 * for alternatives and toolbars. quiet: text only until hovered ("Edit question", "Stop"). link: accent
 * text with a trailing arrow. destructive: the danger fill, for actions that delete.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "link" | "destructive";
/**
 * Ledger sizes (03 Buttons): sm 32 (tables, rails, "Copy id"), md 36 (default everywhere), lg 44 (the
 * question box's Ask, full-width phone buttons). All r4.
 */
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-[color,background-color,border-color,box-shadow] select-none disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "gap-2 rounded-sm bg-accent text-white hover:bg-accent-hover active:bg-accent-ink disabled:bg-sunken disabled:text-ink-3 disabled:shadow-[inset_0_0_0_1px_var(--color-line)] aria-disabled:bg-sunken aria-disabled:text-ink-3",
  secondary:
    "gap-2 rounded-sm border border-line-strong bg-surface text-ink hover:border-ink-3 hover:bg-canvas active:bg-sunken disabled:border-line disabled:bg-surface disabled:text-ink-3 aria-disabled:text-ink-3",
  quiet:
    "gap-2 rounded-sm text-ink-2 hover:bg-sunken hover:text-ink active:bg-line disabled:bg-transparent disabled:text-ink-3 aria-disabled:text-ink-3",
  link: "gap-1.5 rounded-xs text-accent hover:underline hover:underline-offset-4 active:text-accent-ink disabled:text-ink-3 disabled:no-underline",
  destructive:
    "gap-2 rounded-sm bg-danger text-white hover:bg-danger-ink active:bg-danger-ink disabled:bg-sunken disabled:text-ink-3 aria-disabled:bg-sunken aria-disabled:text-ink-3",
};

// Height, padding and text size per variant and size, kept apart from VARIANT so no two classes of one
// button set the same property.
const FILLED: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] leading-[18px]",
  md: "h-9 px-3.5 text-[14px] leading-5",
  lg: "h-11 px-[18px] text-[15px] leading-5",
};
const HEIGHT: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: FILLED,
  secondary: FILLED,
  destructive: FILLED,
  quiet: { sm: "h-8 px-2 text-[13px] leading-[18px]", md: "h-9 px-2.5 text-[14px] leading-5", lg: "h-11 px-3 text-[15px] leading-5" },
  link: { sm: "text-[13px] leading-[18px]", md: "text-[14px] leading-5", lg: "text-[15px] leading-5" },
};

/** Icon sizes: 16 in buttons, 14 in the small ones and on links, 18 in the large ones. */
function iconSize(variant: ButtonVariant, size: ButtonSize): number {
  if (variant === "link" || size === "sm") return 14;
  return size === "lg" ? 18 : 16;
}

/** The class list of a button, for links and other elements styled as one. */
export function buttonClassName(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cx(BASE, VARIANT[variant], HEIGHT[variant][size], className);
}

interface ButtonContent {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon: a name of the set, or an element. */
  icon?: IconName | ReactElement;
  /**
   * Trailing icon. Primary and link default to arrow-right; pass null to drop it. A name of the set or
   * any node.
   */
  trailing?: IconName | ReactNode | null;
  /** Shows the spinner and `loadingLabel` in place of the content (primary "Reading…"). */
  loading?: boolean;
  loadingLabel?: string;
  /** Stretches to the container's width (phone buttons). */
  fullWidth?: boolean;
  children: ReactNode;
}

function renderIcon(icon: IconName | ReactNode, size: number): ReactNode {
  if (isIconName(icon)) return <Icon name={icon} size={size} />;
  return icon;
}

function Content({
  variant = "secondary",
  size = "md",
  icon,
  trailing,
  loading,
  loadingLabel = "Reading…",
  disabled,
  children,
}: Omit<ButtonContent, "fullWidth"> & { disabled?: boolean }) {
  const px = iconSize(variant, size);
  if (loading) {
    return (
      <>
        <Spinner size={px} />
        <span>{loadingLabel}</span>
      </>
    );
  }
  const trail =
    trailing !== undefined ? trailing : variant === "primary" || variant === "link" ? ("arrow-right" as IconName) : null;
  // A disabled filled button shows the label alone (03 Buttons · Disabled).
  const filled = variant === "primary" || variant === "destructive";
  const showTrail = trail !== null && !(disabled && filled);
  return (
    <>
      {icon !== undefined && !(disabled && filled) ? (
        <span aria-hidden="true" className="inline-flex">
          {isValidElement(icon) ? icon : renderIcon(icon, px)}
        </span>
      ) : null}
      <span>{children}</span>
      {showTrail ? (
        <span aria-hidden="true" className="inline-flex">
          {renderIcon(trail, px)}
        </span>
      ) : null}
    </>
  );
}

export type ButtonProps = ButtonContent &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { ref?: Ref<HTMLButtonElement> };

/** C/Button: primary, secondary, quiet, link and destructive in three sizes. `type` defaults to "button". */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  trailing,
  loading,
  loadingLabel,
  fullWidth,
  children,
  className,
  type,
  disabled,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-busy={loading ? true : undefined}
      className={buttonClassName(variant, size, cx(fullWidth && "w-full", className))}
      {...rest}
    >
      <Content
        variant={variant}
        size={size}
        icon={icon}
        trailing={trailing}
        loading={loading}
        loadingLabel={loadingLabel}
        disabled={disabled}
      >
        {children}
      </Content>
    </button>
  );
}

export type ButtonLinkProps = ButtonContent & Omit<ComponentProps<typeof Link>, "children">;

/** A next/link styled as a button. Defaults to the link variant ("Your answers →"). */
export function ButtonLink({
  variant = "link",
  size = "md",
  icon,
  trailing,
  fullWidth,
  children,
  className,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={buttonClassName(variant, size, cx(fullWidth && "w-full", className))} {...rest}>
      <Content variant={variant} size={size} icon={icon} trailing={trailing}>
        {children}
      </Content>
    </Link>
  );
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  /** Accessible name, also the tooltip. */
  label: string;
  /** The icon, by name (drawn at 18). */
  icon?: IconName;
  /** Or any icon node, in place of `icon`. */
  children?: ReactNode;
  /** md is 36 square (r4); lg is 44 (phone headers and sheets). */
  size?: "md" | "lg";
  ref?: Ref<HTMLButtonElement>;
};

const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink active:bg-line disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent";

/** The class list of an icon button, for links styled as one. */
export function iconButtonClassName(size: "md" | "lg" = "md", className?: string): string {
  return cx(ICON_BUTTON, size === "lg" ? "size-11" : "size-9", className);
}

/** C/IconButton: a 36 px square (r4; 44 on phones) with an 18 px ink-2 icon; sunken on hover. Its label is its tooltip. */
export function IconButton({ label, icon, children, size = "md", className, type, title, ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      className={iconButtonClassName(size, className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={18} /> : children}
    </button>
  );
}
