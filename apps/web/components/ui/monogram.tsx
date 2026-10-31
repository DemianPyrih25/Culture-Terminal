import { cx } from "./cx";

/** subject: the run's subject (accent). second: the comparison (orange). mono-1..4: neutrals by name. */
export type MonogramPalette = "subject" | "second" | "mono-1" | "mono-2" | "mono-3" | "mono-4";
export type MonogramSize = 20 | 24 | 32 | 36 | 48 | 56;

const NEUTRALS = ["mono-1", "mono-2", "mono-3", "mono-4"] as const;

const PALETTE: Readonly<Record<MonogramPalette, string>> = {
  subject: "bg-accent-soft text-accent-ink",
  second: "bg-second-soft text-second-ink",
  "mono-1": "bg-mono-1 text-mono-1-ink",
  "mono-2": "bg-mono-2 text-mono-2-ink",
  "mono-3": "bg-mono-3 text-mono-3-ink",
  "mono-4": "bg-mono-4 text-mono-4-ink",
};

// Box, radius and initials size: initials are 600 at about 0.42 of the box.
const SIZE: Readonly<Record<MonogramSize, string>> = {
  20: "size-5 rounded-xs text-[8.5px]",
  24: "size-6 rounded-xs text-[10px]",
  32: "size-8 rounded-sm text-[13.5px]",
  36: "size-9 rounded-sm text-[15px]",
  48: "size-12 rounded-md text-[20px]",
  56: "size-14 rounded-md text-[23.5px]",
};

const LEADING = new Set(["the", "a"]);

/**
 * The initials of a name: a leading "The" or "A" and any token without letters are dropped; two or more
 * words give the first letter of the first two, one word its first two letters. Uppercase.
 */
export function monogramInitials(name: string): string {
  const words = name
    .split(/[\s\-–—/&+·,.:]+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => /\p{L}/u.test(w));
  const kept = words.length > 1 && LEADING.has(words[0]!.toLowerCase()) ? words.slice(1) : words;
  if (kept.length === 0) return "";
  const letters = (w: string) => Array.from(w.replace(/[^\p{L}]/gu, ""));
  const initials = kept.length >= 2 ? `${letters(kept[0]!)[0] ?? ""}${letters(kept[1]!)[0] ?? ""}` : letters(kept[0]!).slice(0, 2).join("");
  return initials.toLocaleUpperCase("en-US");
}

/** A stable neutral palette for a name: the same name gets the same colour everywhere. */
export function monogramPalette(name: string): (typeof NEUTRALS)[number] {
  // FNV-1a over the trimmed, lowercased name.
  let hash = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return NEUTRALS[hash % NEUTRALS.length]!;
}

export interface MonogramProps {
  name: string;
  size?: MonogramSize;
  /** Default: a neutral picked by the name's hash. */
  palette?: MonogramPalette;
  className?: string;
}

/** C/Monogram: initials on a soft square. Decorative: the name always sits beside it. */
export function Monogram({ name, size = 24, palette, className }: MonogramProps) {
  const tone = palette ?? monogramPalette(name);
  return (
    <span
      aria-hidden="true"
      data-palette={tone}
      className={cx("inline-flex shrink-0 items-center justify-center leading-none font-semibold select-none", SIZE[size], PALETTE[tone], className)}
    >
      {monogramInitials(name)}
    </span>
  );
}
