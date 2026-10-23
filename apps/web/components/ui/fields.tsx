// Form controls of A·C Components: A/Input, A/Select, A/Search and A/Checkbox. Input, Select and Checkbox
// are plain elements styled to the masters; they hold no state, so server and client components can both
// render them. Search, which can bind the global "/" key, is a client component (./search).
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { cx } from "./cx";
import { CheckIcon, ChevronIcon } from "./icons";

const FIELD_FRAME = "flex h-9 w-full items-center rounded-brief border bg-paper transition-colors";

/** Border colours of a field frame: accent while focused, negative on error. */
function frameTone(error: ReactNode): string {
  return error ? "border-negative" : "border-line-strong focus-within:border-accent";
}
const FIELD_LABEL = "text-[10px] leading-none font-semibold tracking-[1.1px] text-dim uppercase";

interface FieldChrome {
  /** The small uppercase label above the field. */
  label: string;
  /** Help text under the field. */
  help?: ReactNode;
  /** Error text; replaces the help and turns the border negative. */
  error?: ReactNode;
  /** Classes for the outer wrapper (width, margins). */
  className?: string;
}

function FieldShell({
  id,
  label,
  help,
  error,
  className,
  children,
}: FieldChrome & { id: string; children: ReactNode }) {
  const note = error ?? help;
  return (
    <div className={cx("flex w-full flex-col gap-[6px]", className)}>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
      {note ? (
        <p id={`${id}-note`} className={cx("text-[11px]", error ? "text-negative" : "text-dim")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & { ref?: Ref<HTMLInputElement> };

/** A/Input: label, 36 px field, help line. */
export function Input({ label, help, error, className, id, ref, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? `input-${autoId}`;
  return (
    <FieldShell id={inputId} label={label} help={help} error={error} className={className}>
      <div className={cx(FIELD_FRAME, "gap-2 pr-[10px] pl-3", frameTone(error))}>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? `${inputId}-note` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:text-faint"
          {...rest}
        />
      </div>
    </FieldShell>
  );
}

export type SelectProps = FieldChrome &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { children: ReactNode; ref?: Ref<HTMLSelectElement> };

/** A/Select: a native select drawn as the 36 px field with a chevron. */
export function Select({ label, help, error, className, id, children, ref, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? `select-${autoId}`;
  return (
    <FieldShell id={selectId} label={label} help={help} error={error} className={className}>
      <div className={cx(FIELD_FRAME, "relative", frameTone(error))}>
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? `${selectId}-note` : undefined}
          className="h-full w-full min-w-0 cursor-pointer appearance-none bg-transparent pr-8 pl-3 text-[13px] text-ink outline-none disabled:cursor-not-allowed disabled:text-faint"
          {...rest}
        >
          {children}
        </select>
        <ChevronIcon className="pointer-events-none absolute right-[10px] text-dim" />
      </div>
    </FieldShell>
  );
}

// A/Search binds a global key, so it is a client component of its own.
export { Search } from "./search";
export type { SearchProps } from "./search";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "children"> & {
  /** The label beside the box. */
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/** A/Checkbox: a 14 px box, ink when checked, with a 13 px label. A native checkbox underneath. */
export function Checkbox({ children, className, disabled, ref, ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        "inline-flex items-center gap-[10px] text-[13px] text-text-2",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex size-[14px] shrink-0">
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          className="peer size-[14px] cursor-[inherit] appearance-none rounded-brief border border-line-strong bg-paper checked:border-ink checked:bg-ink"
          {...rest}
        />
        <CheckIcon
          size={10}
          strokeWidth={3}
          className="pointer-events-none absolute top-[2px] left-[2px] hidden text-on-ink peer-checked:block"
        />
      </span>
      <span>{children}</span>
    </label>
  );
}
