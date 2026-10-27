import Link from "next/link";
import { isValidElement, type ButtonHTMLAttributes, type ComponentProps, type ReactElement, type ReactNode, type Ref } from "react";
import { cx } from "./cx";
import { Icon, isIconName, Spinner, type IconName } from "./icons";

/**
 * primary: the accent action, one per view, with a trailing arrow. secondary: bordered, with a leading
 * icon. quiet: no fill until hovered ("Edit question", "Stop"). link: accent text with a trailing arrow.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "link";
/**
 * md is the default of each variant (primary 44, secondary 40, quiet 36). lg is primary-L (52: the
 * question box, full-width phone buttons). sm is secondary-sm (32: "Copy id"), and 32 for the others too.
 */
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[color,background-color,border-color,box-shadow] select-none disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "gap-2 rounded-control bg-accent leading-5 font-semibold text-white hover:bg-accent-hover active:bg-accent-hover active:shadow-pressed disabled:bg-sunken disabled:text-ink-3 disabled:shadow-none aria-disabled:bg-sunken aria-disabled:text-ink-3",
  secondary:
    "gap-2 rounded-control border border-line-strong bg-surface leading-5 font-medium text-ink hover:border-ink-3 active:bg-sunken disabled:border-line-strong disabled:bg-surface disabled:text-ink-3 aria-disabled:text-ink-3",
  quiet:
    "gap-2 rounded-control leading-5 font-medium text-ink-2 hover:bg-sunken hover:text-ink active:bg-sunken active:text-ink disabled:bg-transparent disabled:text-ink-3 aria-disabled:text-ink-3",
  link: "gap-1.5 rounded-sm leading-5 font-medium text-accent hover:underline hover:underline-offset-4 active:text-accent-hover disabled:text-ink-3 disabled:no-underline",
};

// Height, padding and text size per variant and size, kept apart from VARIANT so no two classes of one
// button set the same property.
const HEIGHT: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: { sm: "h-9 px-4 text-[15px]", md: "h-11 px-[18px] text-[15px]", lg: "h-[52px] px-[18px] text-[15px]" },
  secondary: { sm: "h-8 px-3 text-[14px]", md: "h-10 px-4 text-[15px]", lg: "h-11 px-4 text-[15px]" },
  quiet: { sm: "h-8 px-2 text-[14px]", md: "h-9 px-3 text-[14px]", lg: "h-11 px-3 text-[14px]" },
  link: { sm: "text-[14px]", md: "text-[15px]", lg: "text-[15px]" },
};

/** Icon sizes: 18 in buttons, 16 in the small ones, 14 on links. */
function iconSize(variant: ButtonVariant, size: ButtonSize): number {
  if (variant === "link") return 14;
  return size === "sm" ? 16 : 18;
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
  // A disabled primary shows the label alone (N·C Buttons · Disabled).
  const showTrail = trail !== null && !(disabled && variant === "primary");
  return (
    <>
      {icon !== undefined && !(disabled && variant === "primary") ? (
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

/** C/Button: primary, primary-L, secondary, secondary-sm, quiet and link. `type` defaults to "button". */
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
  /** The icon, by name (drawn at 20). */
  icon?: IconName;
  /** Or any icon node, in place of `icon`. */
  children?: ReactNode;
  /** md is 40 round; lg is 44 (phone headers and sheets). */
  size?: "md" | "lg";
  ref?: Ref<HTMLButtonElement>;
};

const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-chip text-ink-2 transition-colors hover:bg-sunken hover:text-ink active:bg-sunken disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent";

/** The class list of an icon button, for links styled as one. */
export function iconButtonClassName(size: "md" | "lg" = "md", className?: string): string {
  return cx(ICON_BUTTON, size === "lg" ? "size-11" : "size-10", className);
}

/** C/IconButton: a 40 px round button (44 on phones) with a 20 px ink-2 icon; sunken on hover. */
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
      {icon ? <Icon name={icon} size={20} /> : children}
    </button>
  );
}
