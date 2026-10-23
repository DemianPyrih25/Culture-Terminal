// Keyboard focus of the popover: a non-modal dialog portalled to the end of the body that behaves as if
// the panel sat right after its trigger in the tab order. Pure, so the rules are tested without a DOM.

/** Why the panel closes. */
export type PopoverCloseReason =
  /** Escape pressed. */
  | "escape"
  /** The `close` callback given to the panel's content, e.g. its Close button. */
  | "close"
  /** Shift+Tab on the panel's first stop, or on the panel itself. */
  | "tab-back"
  /** Tab on the panel's last stop, or on a panel without stops. */
  | "tab-forward"
  /** A pointer press outside the panel and the trigger. */
  | "outside"
  /** Focus moved elsewhere without a key or press the popover handled. */
  | "focus-lost"
  /** The trigger pressed again. */
  | "toggle";

/** Where focus goes as the panel closes: its trigger, the stop after the trigger, or nowhere. */
export type PopoverFocusTarget = "trigger" | "after-trigger" | "none";

/**
 * Where focus goes when the panel closes for `reason`. Escape and Shift+Tab return to the trigger, Tab
 * moves on to the stop after it, and `close` returns to the trigger when focus was in the panel (a Close
 * button), so keyboard focus is never dropped on the body. A press outside, a focus move elsewhere and the
 * trigger itself leave focus where the reader put it.
 */
export function focusOnClose(reason: PopoverCloseReason, focusInPanel: boolean): PopoverFocusTarget {
  switch (reason) {
    case "escape":
    case "tab-back":
      return "trigger";
    case "tab-forward":
      return "after-trigger";
    case "close":
      return focusInPanel ? "trigger" : "none";
    default:
      return "none";
  }
}

/**
 * What a Tab press in the panel does. `index` is the focused stop among the panel's `count` tabbable
 * elements, -1 when the panel itself (or an element outside the tab order) has focus. "inside" leaves the
 * move to the browser; "back" and "forward" leave the panel, as if it followed its trigger.
 */
export function panelTabMove(index: number, count: number, shift: boolean): "inside" | "back" | "forward" {
  if (shift) return index <= 0 ? "back" : "inside";
  if (count === 0 || index >= count - 1) return "forward";
  return "inside";
}

/** The first item after `anchor` in `order` (document tab order) that `skip` does not exclude, or null. */
export function nextAfter<T>(order: readonly T[], anchor: T, skip: (item: T) => boolean = () => false): T | null {
  const at = order.indexOf(anchor);
  if (at === -1) return null;
  for (let i = at + 1; i < order.length; i++) {
    const item = order[i]!;
    if (!skip(item)) return item;
  }
  return null;
}
