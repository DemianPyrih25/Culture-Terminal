/**
 * The share card's colours: the redesign palette of app/globals.css's @theme (design/redesign.pen), which
 * next/og cannot read. The keys are the card's roles: paper the card, canvas its strips, text2 and dim
 * the secondary inks, faint the placeholder ink, data the subject series and data2 the others.
 */
export const OG_COLOR = {
  paper: "#ffffff",
  canvas: "#f5f6f8",
  ink: "#0e1116",
  text2: "#4a5261",
  dim: "#4a5261",
  faint: "#8a93a3",
  line: "#e6e8ec",
  lineStrong: "#cdd2da",
  accent: "#5b3df5",
  accentSoft: "#eeebfe",
  negative: "#a11f16",
  data: "#5b3df5",
  data2: "#c9ced6",
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
