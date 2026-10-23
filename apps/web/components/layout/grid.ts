// The brief grid (A00 · 02 Grid): at 1440, margin 70 · outline 200 · gutter 60 · reading 680 · gutter 60 ·
// sidenotes 300 · margin 70. Between 1280 and 1440 the gutters and the reading column give way first; wider
// screens centre the grid. Every page column (top bar aside) aligns to these tracks, so they live here once.
// The class strings are literal so Tailwind's scanner sees them.

/** ≥1280: margin · outline · gutter · reading · gutter · sidenotes · margin. */
export const GRID_COLUMNS_XL =
  "xl:grid-cols-[minmax(24px,1fr)_200px_minmax(32px,60px)_minmax(0,680px)_minmax(32px,60px)_300px_minmax(24px,1fr)]";

/** 768–1279: margin · outline · gutter · reading · margin; sidenotes fold under their paragraphs. */
export const GRID_COLUMNS_MD = "md:grid-cols-[minmax(24px,1fr)_200px_minmax(32px,60px)_minmax(0,680px)_minmax(24px,1fr)]";

/**
 * Side padding equal to the grid's outer margin at every width, so full-bleed bars (top bar, status line)
 * start where the outline column starts: 16 px on phones, then half of what the 940 px (md) or 1300 px (xl)
 * of fixed tracks leave, never under 24 px. 70 px at 1440.
 */
export const PAGE_GUTTER = "px-4 md:px-[max(24px,calc((100%-940px)/2))] xl:px-[max(24px,calc((100%-1300px)/2))]";

/** Top bar (56) plus running head (44): where sticky content below the chrome rests. */
export const CHROME_HEIGHT = 100;

/** Gives an anchor target room under the sticky chrome when the outline jumps to it. */
export const SCROLL_ANCHOR_CLASS = "scroll-mt-[124px] max-md:scroll-mt-[104px]";

/** Page breakpoints in px, as Tailwind's md and xl. */
export const BREAKPOINT = { md: 768, xl: 1280 } as const;
