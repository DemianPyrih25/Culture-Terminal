// Invisible characters in committed text: a BOM, C0/C1 controls (other than tab, LF and CR), the soft
// hyphen, zero-width and bidi format characters, and Unicode tag characters. They hide content from
// review (Trojan Source) and break tools, so source files write an escape sequence instead.
import type { TextRule } from "./finding";

/** Inclusive code point ranges. */
export const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

// Built from code points so this file itself holds none of the characters it forbids.
const CLASS = INVISIBLE_RANGES.map(([lo, hi]) =>
  lo === hi ? String.fromCodePoint(lo) : `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`,
).join("");

export const INVISIBLE_CHAR: TextRule = {
  id: "invisible-char",
  pattern: new RegExp(`[${CLASS}]`, "gu"),
  message: "invisible or control character (BOM, zero-width, bidi, tag or C0/C1 control); write an escape sequence instead",
};
