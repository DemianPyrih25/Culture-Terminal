// Form controls: Input, Select and Checkbox, on the Ledger tokens (40 px r4 fields, a 1 px line-strong
// hairline, accent border and a soft accent ring on focus). They are plain elements and hold no state, so server and client components can
// both render them.
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

const FIELD_FRAME = "flex h-9 w-full items-center rounded-sm border bg-surface max-md:h-11 transition-[border-color,box-shadow]";

/** Border colours of a field frame: accent with the soft ring while focused, danger on error. */
function frameTone(error: ReactNode): string {
  return error
    ? "border-danger focus-within:shadow-[0_0_0_3px_var(--color-danger-soft)]"
    : "border-line-strong hover:border-ink-3 focus-within:border-accent focus-within:hover:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]";
}
const FIELD_LABEL = "text-[12px] leading-4 font-medium text-[#33363d]";

interface FieldChrome {
  /** The label above the field (13/500 ink). */
  label: string;
  /** Help text under the field. */
  help?: ReactNode;
  /** Error text; replaces the help and turns the border negative. */
  error?: ReactNode;
  /** Classes for the outer wrapper (width, margins). */
  className?: string;
}

function FieldShell({ id, label, help, error, className, children }: FieldChrome & { id: string; children: ReactNode }) {
  const note = error ?? help;
  return (
    <div className={cx("flex w-full flex-col gap-1.5", className)}>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
      {note ? (
        <p id={`${id}-note`} className={cx("type-caption", error ? "text-danger-ink" : "text-ink-2")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    ref?: Ref<HTMLInputElement>;
  };

/** Input: label, 40 px field, help line. */
export function Input({ label, help, error, className, id, ref, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? `input-${autoId}`;
  return (
    <FieldShell id={inputId} label={label} help={help} error={error} className={className}>
      <div className={cx(FIELD_FRAME, "gap-2 px-3", frameTone(error))}>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? `${inputId}-note` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3 max-md:text-[16px] disabled:cursor-not-allowed disabled:text-ink-3"
          {...rest}
        />
      </div>
    </FieldShell>
  );
}

export type SelectProps = FieldChrome &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
    children: ReactNode;
    ref?: Ref<HTMLSelectElement>;
  };

/** Select: a native select drawn as the 40 px field with a chevron. */
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
          className="h-full w-full min-w-0 cursor-pointer appearance-none bg-transparent pr-9 pl-3 text-[13px] text-ink max-md:text-[16px] outline-none disabled:cursor-not-allowed disabled:text-ink-3"
          {...rest}
        >
          {children}
        </select>
        <Icon name="chevron-down" size={16} className="pointer-events-none absolute right-3 text-ink-2" />
      </div>
    </FieldShell>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "children"> & {
  /** The label beside the box. */
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/** Checkbox: a 16 px r3 box, accent when checked, with a 14 px label. A native checkbox underneath. */
export function Checkbox({ children, className, disabled, ref, ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        "inline-flex items-center gap-2.5 text-[14px] leading-5 text-ink",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex size-4 shrink-0">
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          className="peer size-4 cursor-[inherit] appearance-none rounded-[3px] border border-ink-3 bg-surface transition-colors checked:border-accent checked:bg-accent"
          {...rest}
        />
        <Icon
          name="check"
          size={12}
          strokeWidth={3}
          className="pointer-events-none absolute top-[2px] left-[2px] hidden text-white peer-checked:block"
        />
      </span>
      <span>{children}</span>
    </label>
  );
}
