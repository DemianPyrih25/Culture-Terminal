"use client";

// Interactive specimens for the /dev/ui gallery. Entities, values and request ids are invented (D29).
import { useRef, useState } from "react";
import { CommandField, type CommandFieldHandle } from "../../../components/ui/command-field";
import { Button } from "../../../components/ui/button";
import { Popover } from "../../../components/ui/popover";
import type { ShortcutKey } from "../../../components/ui/shortcut";
import { SortToggle } from "../../../components/ui/sort-toggle";

/**
 * A connected command field: echoes what Enter submits. Specimens bind no key but keep the master's ⌘K
 * keycap, so the sheet reads like A·C Components; the top bar's field binds ⌘K for real.
 */
export function CommandFieldDemo({
  initial = "",
  placeholder,
  shortcut = false,
  keycap = "⌘K",
  showFocus = false,
  disabled = false,
  echo = false,
}: {
  initial?: string;
  placeholder?: string;
  shortcut?: boolean | readonly ShortcutKey[];
  keycap?: string | null;
  showFocus?: boolean;
  disabled?: boolean;
  echo?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [submitted, setSubmitted] = useState<string | null>(null);
  return (
    <div className="flex w-full flex-col gap-1">
      <CommandField
        value={value}
        onChange={setValue}
        onSubmit={setSubmitted}
        placeholder={placeholder}
        shortcut={shortcut}
        keycap={keycap}
        showFocus={showFocus}
        disabled={disabled}
      />
      {echo && submitted ? <p className="font-mono text-[10px] text-faint">submitted: {submitted}</p> : null}
    </div>
  );
}

/** The imperative handle: a button that focuses and selects the field. */
export function CommandFieldFocusDemo() {
  const ref = useRef<CommandFieldHandle>(null);
  const [value, setValue] = useState("Brand Alpha vs Brand Beta");
  return (
    <div className="flex w-full items-center gap-3">
      <CommandField ref={ref} value={value} onChange={setValue} shortcut={false} className="flex-1" />
      <Button size="sm" hint={null} onClick={() => ref.current?.select()}>
        Focus it
      </Button>
    </div>
  );
}

export function SortToggleDemo() {
  const [sort, setSort] = useState<"date" | "conviction">("date");
  return (
    <SortToggle
      value={sort}
      onChange={setSort}
      options={[
        { value: "date", label: "Date" },
        { value: "conviction", label: "Conviction" },
      ]}
    />
  );
}

/**
 * A footnoted number that opens the request behind it, as the request inspector will. Tab from Close
 * leaves the panel for the stop after the number; Shift+Tab from the copy button returns to the number.
 */
export function PopoverDemo() {
  return (
    <p className="type-body text-ink">
      Taste overlap{" "}
      <Popover
        label="Request 1"
        trigger={(props) => (
          <button
            {...props}
            className="group rounded-brief font-serif text-[20px] font-medium text-ink"
          >
            <span className="underline decoration-line-strong underline-offset-4 group-hover:decoration-accent">0.64</span>
            <sup className="ml-px font-ui text-[11px] font-semibold text-accent">1</sup>
          </button>
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] font-semibold tracking-[1.3px] text-dim uppercase">Request 1</p>
            <p className="type-sidenote text-text-2">
              Qloo /v2/insights · tags ← R3 · 12 rows. Affinity by region, Juniper Cola and Brand Beta, from one
              request.
            </p>
            <p className="type-trace text-faint">req 3e7a…b9f0 · cached 5h</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" hint={null} variant="quiet" onClick={() => void navigator.clipboard?.writeText("req 3e7a…b9f0")}>
                Copy request
              </Button>
              <Button size="sm" hint={null} onClick={close}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Popover>{" "}
      between the two brands; the panel opens under the number and flips above near the bottom.
    </p>
  );
}

/** A plain-node trigger, wrapped in the popover's own button, opening above. */
export function PopoverTopDemo() {
  return (
    <Popover
      label="About this figure"
      placement="top-end"
      width={260}
      trigger="Method"
      triggerClassName="text-[13px] font-medium text-accent hover:underline hover:underline-offset-4"
    >
      <p className="type-sidenote text-text-2">
        Computed in code from 6 requests, then traced. Escape or a click outside closes this panel.
      </p>
    </Popover>
  );
}
