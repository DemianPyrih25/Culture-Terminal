// The focus shortcut rule (PLAN §8.2): ⌘K, Ctrl+K or / focuses a field unless a text field has focus; a
// page binds ⌘K to its command field and / to its search field.
import { isApplePlatform, keycapForPlatform } from "../../components/ui/mod-key";
import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcuts,
  isCommandShortcut,
  isTextField,
  matchShortcut,
  shortcutKeycap,
  shortcutKeys,
  type ShortcutFocusTarget,
  type ShortcutKeyEvent,
} from "../../components/ui/shortcut";

function key(k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

const BODY: ShortcutFocusTarget = { tagName: "BODY" };
const BUTTON: ShortcutFocusTarget = { tagName: "BUTTON", type: "submit" };
const LINK: ShortcutFocusTarget = { tagName: "A" };
const TEXT_INPUT: ShortcutFocusTarget = { tagName: "INPUT", type: "text" };
const TEXTAREA: ShortcutFocusTarget = { tagName: "TEXTAREA" };
const EDITABLE: ShortcutFocusTarget = { tagName: "DIV", isContentEditable: true };

describe("isTextField", () => {
  it("counts editable text inputs, textareas and contenteditable", () => {
    for (const type of ["text", "search", "email", "url", "tel", "password", "number"]) {
      expect(isTextField({ tagName: "INPUT", type }), type).toBe(true);
    }
    expect(isTextField({ tagName: "input" })).toBe(true);
    expect(isTextField(TEXTAREA)).toBe(true);
    expect(isTextField(EDITABLE)).toBe(true);
  });

  it("does not count controls that take no typed text", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "range", "color", "file"]) {
      expect(isTextField({ tagName: "INPUT", type }), type).toBe(false);
    }
    expect(isTextField(BUTTON)).toBe(false);
    expect(isTextField(LINK)).toBe(false);
    expect(isTextField({ tagName: "SELECT" })).toBe(false);
    expect(isTextField(BODY)).toBe(false);
    expect(isTextField(null)).toBe(false);
  });

  it("does not count read-only or disabled fields", () => {
    expect(isTextField({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isTextField({ tagName: "TEXTAREA", disabled: true })).toBe(false);
  });
});

describe("isCommandShortcut", () => {
  it("focuses on ⌘K, Ctrl+K and / when nothing is being typed", () => {
    for (const focused of [BODY, BUTTON, LINK, null]) {
      expect(isCommandShortcut(key("k", { metaKey: true }), focused)).toBe(true);
      expect(isCommandShortcut(key("K", { ctrlKey: true }), focused)).toBe(true);
      expect(isCommandShortcut(key("/"), focused)).toBe(true);
    }
  });

  it("leaves every shortcut alone while a text field has focus", () => {
    for (const focused of [TEXT_INPUT, TEXTAREA, EDITABLE]) {
      expect(isCommandShortcut(key("/"), focused)).toBe(false);
      expect(isCommandShortcut(key("k", { metaKey: true }), focused)).toBe(false);
      expect(isCommandShortcut(key("k", { ctrlKey: true }), focused)).toBe(false);
      expect(isCommandShortcut(key("л", { code: "KeyK", ctrlKey: true }), focused)).toBe(false);
    }
  });

  it("accepts / typed with Shift (layouts where / is shifted)", () => {
    expect(isCommandShortcut(key("/", { code: "Digit7", shiftKey: true }), BODY)).toBe(true);
  });

  it("ignores other keys and other modifier mixes", () => {
    expect(isCommandShortcut(key("k"), BODY)).toBe(false);
    expect(isCommandShortcut(key("k", { metaKey: true, shiftKey: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("k", { ctrlKey: true, altKey: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("/", { ctrlKey: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("/", { metaKey: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("/", { altKey: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("Enter"), BODY)).toBe(false);
  });

  it("ignores repeats, IME composition and presses already handled", () => {
    expect(isCommandShortcut(key("/", { repeat: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("/", { isComposing: true }), BODY)).toBe(false);
    expect(isCommandShortcut(key("k", { metaKey: true, defaultPrevented: true }), BODY)).toBe(false);
  });

  it("checks only the keys a field binds", () => {
    expect(isCommandShortcut(key("/"), BODY, ["mod-k"])).toBe(false);
    expect(isCommandShortcut(key("k", { ctrlKey: true }), BODY, ["mod-k"])).toBe(true);
    expect(isCommandShortcut(key("k", { ctrlKey: true }), BODY, ["slash"])).toBe(false);
    expect(isCommandShortcut(key("/"), BODY, ["slash"])).toBe(true);
    expect(isCommandShortcut(key("/"), BODY, [])).toBe(false);
  });
});

describe("matchShortcut", () => {
  it("names the key that matched", () => {
    expect(matchShortcut(key("k", { metaKey: true }), BODY)).toBe("mod-k");
    expect(matchShortcut(key("/"), BODY)).toBe("slash");
    expect(matchShortcut(key("j", { ctrlKey: true }), BODY)).toBeNull();
  });

  it("matches the physical keys on a Cyrillic layout", () => {
    // Ctrl+K on a Ukrainian layout reports "л"; the / key reports ".".
    expect(matchShortcut(key("л", { code: "KeyK", ctrlKey: true }), BODY)).toBe("mod-k");
    expect(matchShortcut(key("Л", { code: "KeyK", metaKey: true }), BODY)).toBe("mod-k");
    expect(matchShortcut(key(".", { code: "Slash" }), BODY)).toBe("slash");
  });

  it("does not take the physical key where it types another Latin letter, a letter or a digit", () => {
    // Dvorak: the KeyK key types "t", the Slash key types "z".
    expect(matchShortcut(key("t", { code: "KeyK", ctrlKey: true }), BODY)).toBeNull();
    expect(matchShortcut(key("z", { code: "Slash" }), BODY)).toBeNull();
    expect(matchShortcut(key("ж", { code: "Slash" }), BODY)).toBeNull();
  });

  it("leaves ? (Shift on the Slash key) alone", () => {
    expect(matchShortcut(key("?", { code: "Slash", shiftKey: true }), BODY)).toBeNull();
    expect(matchShortcut(key(",", { code: "Slash", shiftKey: true }), BODY)).toBeNull();
  });
});

describe("shortcutKeys, shortcutKeycap and ariaKeyShortcuts", () => {
  it("reads a field's shortcut prop", () => {
    expect(shortcutKeys(true)).toEqual(["mod-k", "slash"]);
    expect(shortcutKeys(false)).toEqual([]);
    expect(shortcutKeys(["slash"])).toEqual(["slash"]);
  });

  it("advertises only a bound key", () => {
    expect(shortcutKeycap(["mod-k", "slash"])).toBe("⌘K");
    expect(shortcutKeycap(["mod-k"])).toBe("⌘K");
    expect(shortcutKeycap(["slash"])).toBe("/");
    expect(shortcutKeycap([])).toBeNull();
  });

  it("spells aria-keyshortcuts for the bound keys", () => {
    expect(ariaKeyShortcuts(["mod-k", "slash"])).toBe("Meta+K Control+K /");
    expect(ariaKeyShortcuts(["slash"])).toBe("/");
    expect(ariaKeyShortcuts([])).toBeUndefined();
  });
});

describe("keycapForPlatform", () => {
  it("keeps ⌘ on Apple platforms and writes Ctrl elsewhere", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("iPhone")).toBe(true);
    expect(isApplePlatform("Win32")).toBe(false);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(keycapForPlatform("⌘K", true)).toBe("⌘K");
    expect(keycapForPlatform("⌘K", false)).toBe("Ctrl K");
    expect(keycapForPlatform("⌘↵", false)).toBe("Ctrl ↵");
    expect(keycapForPlatform("/", false)).toBe("/");
  });
});
