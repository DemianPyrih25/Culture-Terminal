import { Button, cx, Input, Select } from "../ui";
import { DEFAULT_DES_TYPE, DES_NAME_MAX, DES_TYPE_LABEL, DES_TYPES, type DesType } from "./des-href";

/**
 * The tearsheet's search box: a name and a type, sent as GET /d?q=…&type=…, which opens /d/<name>.
 * A plain form, so it works before (and without) any script; "<NAME> DES" and a type marker
 * ("<ARTIST>") are understood too (des-href parseDesInput).
 */

export interface DesSearchProps {
  /** The name to start from, e.g. the one this page describes. */
  name?: string;
  type?: DesType;
  /** Why the last name could not be looked up. */
  error?: string | null;
  /** Leaves out the help line, under a tearsheet that already shows what the box does. */
  compact?: boolean;
  className?: string;
}

export function DesSearch({ name = "", type = DEFAULT_DES_TYPE, error = null, compact = false, className }: DesSearchProps) {
  return (
    <form
      action="/d"
      method="get"
      role="search"
      aria-label="Open a tearsheet"
      className={cx("flex w-full flex-col gap-3 sm:flex-row sm:items-start", className)}
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
        placeholder="A brand, artist, show or public figure"
        error={error ?? undefined}
        help={error || compact ? undefined : "Exact name; “<NAME> DES” works too."}
        className="sm:flex-1"
      />
      {/* On a phone the type and the button share a row under the name. */}
      <div className="flex items-start gap-3">
        <Select label="Type" name="type" defaultValue={type} className="flex-1 sm:w-[150px] sm:flex-none">
          {DES_TYPES.map((t) => (
            <option key={t} value={t}>
              {DES_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        {/* Level with the fields: the 10 px label and its 6 px gap sit above them. */}
        <Button type="submit" variant="primary" aria-label="DES: open the tearsheet" className="mt-[16px]">
          DES
        </Button>
      </div>
    </form>
  );
}
