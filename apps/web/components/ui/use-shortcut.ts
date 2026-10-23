"use client";

import { useEffect, useRef } from "react";
import { matchShortcut, type ShortcutFocusTarget, type ShortcutKey } from "./shortcut";

/** The focused element as the shortcut rule reads it. */
function focusTarget(): ShortcutFocusTarget | null {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused) return null;
  const field = focused as HTMLInputElement;
  return {
    tagName: focused.tagName,
    type: field.type,
    isContentEditable: focused.isContentEditable,
    readOnly: field.readOnly,
    disabled: field.disabled,
  };
}

/**
 * Calls `onShortcut` when the reader presses one of `keys` outside a text field (see matchShortcut), and
 * takes the press so the browser's own Ctrl+K and quick-find do not run. Bind each key once per page: a
 * second listener sees the press as handled and ignores it.
 */
export function useFocusShortcut(keys: readonly ShortcutKey[], onShortcut: () => void, enabled = true): void {
  // The latest callback, so the listener is not re-registered on every render.
  const callback = useRef(onShortcut);
  useEffect(() => {
    callback.current = onShortcut;
  });
  // A stable dependency for the key list.
  const key = keys.join(" ");

  useEffect(() => {
    if (!enabled || key === "") return;
    const bound = key.split(" ") as ShortcutKey[];
    const onKey = (event: KeyboardEvent) => {
      const match = matchShortcut(event, focusTarget());
      if (match === null || !bound.includes(match)) return;
      event.preventDefault();
      callback.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled]);
}
