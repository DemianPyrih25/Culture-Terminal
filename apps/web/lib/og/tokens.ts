/**
 * The share card's colours: the Ledger palette of app/globals.css's @theme (design/redesign-v3.pen, direction
 * A), which next/og cannot read. The keys are the card's roles: paper the card, canvas its strips, text2 and
 * dim the secondary inks, faint the placeholder ink, data the subject series (ledger blue) and data2 the others.
 */
export const OG_COLOR = {
  paper: "#ffffff",
  canvas: "#f6f3ee",
  ink: "#16181d",
  text2: "#4f535c",
  dim: "#4f535c",
  faint: "#8c909a",
  line: "#e2ddd3",
  lineStrong: "#cbc3b4",
  accent: "#1d3e9e",
  accentSoft: "#e8ecf7",
  negative: "#b4322c",
  data: "#1d3e9e",
  data2: "#cbc3b4",
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
