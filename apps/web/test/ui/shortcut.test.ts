// isTextField: a key press while the reader types in a text field is left alone (the map keys skip it).
import { describe, expect, it } from "vitest";
import { isTextField, type ShortcutFocusTarget } from "../../components/ui/shortcut";

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
    expect(isTextField(TEXT_INPUT)).toBe(true);
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
