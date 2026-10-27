import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { Input, Select } from "../ui/fields";
import { DEFAULT_DES_TYPE, DES_NAME_MAX, DES_TYPE_LABEL, DES_TYPES, type DesType } from "./des-href";

/**
 * Look up a profile: a name and a type, sent as GET /d?q=…&type=…, which opens /d/<name>. A plain form,
 * so it works before (and without) any script; "<NAME> DES" and a type marker are understood too
 * (des-href parseDesInput).
 */

export interface DesSearchProps {
  /** The name to start from. */
  name?: string;
  type?: DesType;
  /** Why the last name could not be looked up. */
  error?: string | null;
  /** row: name, type and the button on one line from 640 px up. stack: one under the other (the popover). */
  layout?: "row" | "stack";
  /** Focus the name field when it appears (the popover). */
  autoFocus?: boolean;
  className?: string;
}

export function DesSearch({ name = "", type = DEFAULT_DES_TYPE, error = null, layout = "row", autoFocus = false, className }: DesSearchProps) {
  const row = layout === "row";
  return (
    <form
      action="/d"
      method="get"
      role="search"
      aria-label="Look up a profile"
      className={cx("flex w-full flex-col gap-3", row && "sm:flex-row sm:items-start", className)}
      data-des-search="true"
    >
      <Input
        label="Name"
        name="q"
        defaultValue={name}
        required
        maxLength={DES_NAME_MAX + 16}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder="A brand, artist, show or public figure"
        error={error ?? undefined}
        className={row ? "sm:flex-1" : undefined}
      />
      <div className={cx("flex items-start gap-3", !row && "flex-col items-stretch")}>
        <Select label="Type" name="type" defaultValue={type} className={row ? "flex-1 sm:w-[160px] sm:flex-none" : undefined}>
          {DES_TYPES.map((t) => (
            <option key={t} value={t}>
              {DES_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        {/* Level with the fields: their 13 px label and its 6 px gap sit above them. */}
        <Button type="submit" variant="primary" className={row ? "mt-6" : undefined} fullWidth={!row}>
          Look up
        </Button>
      </div>
    </form>
  );
}
