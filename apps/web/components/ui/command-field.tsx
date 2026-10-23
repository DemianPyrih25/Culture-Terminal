"use client";

import { useId, useImperativeHandle, useRef, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { cx } from "./cx";
import { SearchIcon } from "./icons";
import { Keycap } from "./keycap";
import { keycapForPlatform, useApplePlatform } from "./mod-key";
import { ariaKeyShortcuts, shortcutKeycap, shortcutKeys, type ShortcutKey } from "./shortcut";
import { useFocusShortcut } from "./use-shortcut";

/** Imperative handle: pages focus the field after a run ends or a starter is picked. */
export interface CommandFieldHandle {
  focus(): void;
  blur(): void;
  /** Focuses the field and selects its text. */
  select(): void;
}

export interface CommandFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter with the trimmed value; empty values are not submitted. */
  onSubmit?: (value: string) => void;
  /** Default "Ask a question"; on a brief, "Ask a follow-up on this brief". */
  placeholder?: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  /**
   * The global keys that focus the field: true (default) binds ⌘K / Ctrl+K and /, a list binds those keys
   * (["mod-k"] on a page whose own <Search shortcut> takes /), false none. Bind each key once per page.
   */
  shortcut?: boolean | readonly ShortcutKey[];
  /** The keycap text; by default the bound key ("⌘K", else "/", else none). null hides it. */
  keycap?: string | null;
  /** Draws the focused border without focus, for stills and the gallery. */
  showFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  id?: string;
  name?: string;
  className?: string;
  ref?: Ref<CommandFieldHandle>;
}

/**
 * A/Command field: 34 px search field with a magnifier, a placeholder and the ⌘K keycap; the border turns
 * accent while focused. Controlled: the page owns the value and decides what Enter does.
 */
export function CommandField({
  value,
  onChange,
  onSubmit,
  placeholder = "Ask a question",
  label,
  shortcut = true,
  keycap,
  showFocus = false,
  disabled = false,
  maxLength,
  id,
  name,
  className,
  ref,
}: CommandFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const inputId = id ?? `command-${fallbackId}`;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      select: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }),
    [],
  );

  const keys = shortcutKeys(shortcut);
  const apple = useApplePlatform();
  const defaultKeycap = shortcutKeycap(keys);
  const shownKeycap = keycap === undefined ? (defaultKeycap === null ? null : keycapForPlatform(defaultKeycap, apple)) : keycap;
  useFocusShortcut(
    keys,
    () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    !disabled,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = value.trim();
    if (text === "" || disabled) return;
    onSubmit?.(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") inputRef.current?.blur();
  }

  return (
    <form
      role="search"
      onSubmit={submit}
      className={cx(
        "flex h-[34px] w-full min-w-0 items-center gap-[10px] rounded-brief border bg-paper pr-2 pl-3 transition-colors",
        showFocus ? "border-accent" : "border-line-strong focus-within:border-accent",
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
        name={name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-keyshortcuts={disabled ? undefined : ariaKeyShortcuts(keys)}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-dim focus-visible:outline-none disabled:cursor-not-allowed"
      />
      {shownKeycap ? <Keycap>{shownKeycap}</Keycap> : null}
    </form>
  );
}
