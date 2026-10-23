// The global focus shortcuts (PLAN §8.2): ⌘K or Ctrl+K focuses the command field, a bare / focuses the
// page's search field (the command field when the page has none), unless the reader is typing in a text
// field. Pure, so the rule is tested without a DOM.

/** The parts of a KeyboardEvent the rule reads. */
export interface ShortcutKeyEvent {
  key: string;
  /** The physical key, e.g. "KeyK"; matches ⌘K when a non-Latin layout reports another character. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** The parts of the focused element the rule reads (document.activeElement). */
export interface ShortcutFocusTarget {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}

/** The two focus shortcuts: ⌘K / Ctrl+K, and a bare /. */
export type ShortcutKey = "mod-k" | "slash";

/** Both shortcuts, the default of a page's single command field. */
export const ALL_SHORTCUT_KEYS: readonly ShortcutKey[] = ["mod-k", "slash"];

/** The keycap that advertises a shortcut. */
export const SHORTCUT_KEYCAP: Readonly<Record<ShortcutKey, string>> = { "mod-k": "⌘K", slash: "/" };

/** aria-keyshortcuts values per shortcut. */
const ARIA_KEYS: Readonly<Record<ShortcutKey, string>> = { "mod-k": "Meta+K Control+K", slash: "/" };

// Inputs that take no typed text: a "/" pressed on them is not a character.
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

const LATIN_LETTER = /^[a-z]$/;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/**
 * Which focus shortcut the key press is, or null: ⌘K or Ctrl+K ("mod-k"), or a bare "/" ("slash"), while
 * no text field has focus. Both also match by physical key (KeyK, Slash) when the layout puts another
 * character there: ⌘K on a Cyrillic layout reports "л", the / key reports ".". The physical match is
 * skipped when that key types another Latin letter (Dvorak's KeyK is "t") or, for /, any letter or digit.
 * "/" typed with Shift (German, Nordic layouts) counts; Shift on the Slash key ("?") does not. IME
 * composition, auto-repeat and presses another handler already took are ignored.
 */
export function matchShortcut(event: ShortcutKeyEvent, focused: ShortcutFocusTarget | null | undefined): ShortcutKey | null {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (isTextField(focused)) return null;
  const key = event.key.toLowerCase();
  const shift = event.shiftKey ?? false;
  if (event.metaKey || event.ctrlKey) {
    const isK = key === "k" || (event.code === "KeyK" && !LATIN_LETTER.test(key));
    return isK && !event.altKey && !shift ? "mod-k" : null;
  }
  if (event.altKey) return null;
  if (key === "/") return "slash";
  if (event.code === "Slash" && !shift && !LETTER_OR_DIGIT.test(key)) return "slash";
  return null;
}

/** True when the key press is one of `keys` (default both): the rule a field's global listener applies. */
export function isCommandShortcut(
  event: ShortcutKeyEvent,
  focused: ShortcutFocusTarget | null | undefined,
  keys: readonly ShortcutKey[] = ALL_SHORTCUT_KEYS,
): boolean {
  const match = matchShortcut(event, focused);
  return match !== null && keys.includes(match);
}

/** A field's `shortcut` prop as a key list: true is both keys, false none. */
export function shortcutKeys(shortcut: boolean | readonly ShortcutKey[]): readonly ShortcutKey[] {
  if (shortcut === true) return ALL_SHORTCUT_KEYS;
  if (shortcut === false) return [];
  return shortcut;
}

/** The keycap for the bound keys: ⌘K when bound, else "/" when bound, else null (no hint for an unbound key). */
export function shortcutKeycap(keys: readonly ShortcutKey[]): string | null {
  if (keys.includes("mod-k")) return SHORTCUT_KEYCAP["mod-k"];
  if (keys.includes("slash")) return SHORTCUT_KEYCAP.slash;
  return null;
}

/** The aria-keyshortcuts value for the bound keys, or undefined when none are. */
export function ariaKeyShortcuts(keys: readonly ShortcutKey[]): string | undefined {
  return keys.length === 0 ? undefined : keys.map((k) => ARIA_KEYS[k]).join(" ");
}
