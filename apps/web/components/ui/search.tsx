"use client";

import { useId, useImperativeHandle, useRef, type InputHTMLAttributes, type Ref } from "react";
import { cx } from "./cx";
import { SearchIcon } from "./icons";
import { Keycap } from "./keycap";
import { ariaKeyShortcuts, shortcutKeycap, shortcutKeys, type ShortcutKey } from "./shortcut";
import { useFocusShortcut } from "./use-shortcut";

export type SearchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  /**
   * The global keys that focus the field (default none): true binds /, a list binds those keys. On a page
   * with both, the top bar's CommandField keeps ⌘K (shortcut={["mod-k"]}) and the list's Search takes /.
   */
  shortcut?: boolean | readonly ShortcutKey[];
  /** Keycap text; by default the bound key, and none when no key is bound. null hides it. */
  keycap?: string | null;
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/** A/Search: a 32 px filter field with a magnifier and a keycap, for lists such as the briefs library. */
export function Search({
  label,
  shortcut = false,
  keycap,
  placeholder = "Search",
  className,
  id,
  disabled,
  ref,
  ...rest
}: SearchProps) {
  const autoId = useId();
  const inputId = id ?? `search-${autoId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

  // A bare true binds only "/": ⌘K belongs to the command field.
  const keys = shortcut === true ? (["slash"] as const) : shortcutKeys(shortcut);
  const shownKeycap = keycap === undefined ? shortcutKeycap(keys) : keycap;
  useFocusShortcut(
    keys,
    () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    !disabled,
  );

  return (
    <div
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-brief border border-line-strong bg-paper pr-2 pl-[10px] transition-colors focus-within:border-accent",
        disabled && "opacity-60",
        className,
      )}
    >
      <SearchIcon className="shrink-0 text-faint" />
      <label htmlFor={inputId} className="sr-only">
        {label ?? placeholder}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        aria-keyshortcuts={disabled ? undefined : ariaKeyShortcuts(keys)}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-dim disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:appearance-none"
        {...rest}
      />
      {shownKeycap ? <Keycap>{shownKeycap}</Keycap> : null}
    </div>
  );
}
