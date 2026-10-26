/**
 * The share card's tokens (Concept A · Brief, D36): the colours of app/globals.css's @theme, which
 * next/og cannot read, and the card's frame. One accent, two data colours, hairlines, no shadows.
 */
export const OG_COLOR = {
  paper: "#ffffff",
  canvas: "#f7f7f5",
  ink: "#121416",
  text2: "#3d4248",
  dim: "#6b7178",
  faint: "#a3a8ae",
  line: "#e6e7e9",
  lineStrong: "#c9ccd0",
  accent: "#1c3d6e",
  accentSoft: "#e8edf4",
  negative: "#8e2f2f",
  data: "#1c3d6e",
  data2: "#a9b0b8",
} as const;

/** The families the card sets (lib/og/fonts.ts loads them); the instances carry their own names (OFL reserved names). */
export const OG_FONT = {
  serif: "CT Card Serif",
  sans: "CT Card Sans",
  mono: "IBM Plex Mono",
} as const;

/** The Open Graph card size (SPEC §8.6: 1200 × 630). */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/** The card's frame: top bar, receipt strip, side margins, the two body columns and the gap between key figures, in px. */
export const OG_FRAME = {
  bar: 64,
  strip: 60,
  side: 64,
  top: 44,
  bottom: 40,
  gap: 56,
  left: 600,
  right: 416,
  keyGap: 28,
} as const;

/** The letter spacing of a label in capitals at this size, in px. */
export const labelTracking = (size: number): number => (size >= 13 ? 1.6 : 1.3);
