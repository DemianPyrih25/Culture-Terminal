// Scrollspy for the outline: which section is the reader in? Pure and free of "use client", so the rules
// are tested without a DOM and server components can call them; useScrollSpy feeds them from the page.

/** One entry of the outline. */
export interface OutlineItem {
  /** The id of the section element this item jumps to. */
  id: string;
  label: string;
  /** A count on the right, e.g. briefs per desk in the library. */
  count?: number | string;
  /** Not written yet (live run): drawn faint, announced as a disabled link, and never active. */
  pending?: boolean;
}

/** The item that is active: the forced one, else the spied one, else the first ready item. */
export function resolveActiveItem(
  items: readonly OutlineItem[],
  forced: string | null | undefined,
  spied: string | null,
): string | null {
  if (forced !== undefined) return forced;
  if (spied !== null && items.some((i) => i.id === spied && !i.pending)) return spied;
  return items.find((i) => !i.pending)?.id ?? null;
}

/** A section's top edge, in px from the viewport top (getBoundingClientRect().top). */
export interface SpySection {
  id: string;
  top: number;
}

/**
 * The active section: the last one whose top has reached the activation line `offset` px below the
 * viewport top (sections in document order). Before the first reaches it, the first is active; once the
 * page is scrolled to the bottom, the last is, so a short closing section still lights up. Null when
 * there are no sections.
 */
export function activeSection(sections: readonly SpySection[], offset: number, atBottom = false): string | null {
  if (sections.length === 0) return null;
  if (atBottom) return sections[sections.length - 1]!.id;
  let active = sections[0]!.id;
  for (const section of sections) {
    if (section.top <= offset + 1) active = section.id;
    else break;
  }
  return active;
}

/** True when the document is scrolled to within `slack` px of its end. */
export function isScrolledToBottom(scrollTop: number, viewportHeight: number, scrollHeight: number, slack = 2): boolean {
  return scrollHeight > viewportHeight && scrollTop + viewportHeight >= scrollHeight - slack;
}

/**
 * The IntersectionObserver rootMargin of the scrollspy: everything above the activation line `offset` px
 * below the viewport top, up past the top of the document (four document heights, room for a brief that
 * grows while it is written). A section is "in" once its top has crossed the line, a state that holds
 * between frames, so a section that a fling, PageDown or End carries across the line in a single frame
 * still reports the change; a band the height of the line would miss it.
 */
export function spyRootMargin(offset: number, viewportHeight: number, scrollHeight: number): string {
  const line = Math.max(0, Math.round(offset));
  const above = 4 * Math.max(Math.ceil(scrollHeight), Math.ceil(viewportHeight)) + line;
  const below = Math.max(0, Math.ceil(viewportHeight) - line - 1);
  return `${above}px 0px ${below === 0 ? "0px" : `-${below}px`} 0px`;
}
