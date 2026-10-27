// Keyboard helpers: whether a key press lands in a text field. The map's mode keys (1, 2, 3) skip presses
// made while the reader is typing. Pure, so the rule is tested without a DOM.

/** The parts of a KeyboardEvent a key handler reads. */
export interface ShortcutKeyEvent {
  key: string;
  /** The physical key, e.g. "Digit1", for layouts that report another character. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** The parts of the focused element a key handler reads (document.activeElement). */
export interface ShortcutFocusTarget {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}

// Inputs that take no typed text: a key pressed on them is not a character.
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** True when the element takes typed text: an editable input or textarea, or contenteditable. */
export function isTextField(target: ShortcutFocusTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
  if (target.readOnly || target.disabled) return false;
  if (tag === "TEXTAREA") return true;
  return !NON_TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}
