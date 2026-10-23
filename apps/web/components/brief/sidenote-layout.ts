"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Sidenotes level with their paragraph (Tufte's margin, A05). From 1280 px the notes of a row take no
 * room of their own (the row is as tall as its paragraph); this pass moves each row's notes down to the
 * paragraph that cites the first of them (the thesis under the answer's head, a prior's "Measured" line,
 * a figure's caption), then just enough further to clear the notes above, so a paragraph that cites
 * seven numbers lets its notes run on beside the next ones instead of opening a gap in the text. Below
 * 1280 px the notes fold under their paragraphs and nothing moves.
 */

/** Space between one row's notes and the next. */
export const SIDENOTE_GAP = 16;

const WIDE = "(min-width: 1280px)";

const INLINE = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "contents"]);

/** The block a citation sits in (a paragraph, a figure's caption line, a key figure), inside `row`; else the citation. */
function blockOf(cite: HTMLElement, row: HTMLElement): HTMLElement {
  for (let el = cite.parentElement; el && el !== row && row.contains(el); el = el.parentElement) {
    if (!INLINE.has(getComputedStyle(el).display)) return el;
  }
  return cite;
}

/**
 * Where each note list goes: `shift` px below its natural top. A list moves down to its `anchor` (the
 * citing paragraph), never above its natural top, and below the list before it. Pure, so the rule is
 * tested without a DOM.
 */
export function stackNotes(
  lists: readonly { top: number; height: number; anchor?: number | null }[],
  gap = SIDENOTE_GAP,
): { shifts: number[]; bottom: number } {
  let bottom = Number.NEGATIVE_INFINITY;
  const shifts = lists.map((list) => {
    const want = Math.max(list.top, list.anchor ?? list.top, bottom + gap);
    const shift = Math.max(0, Math.ceil(want - list.top));
    bottom = list.top + shift + list.height;
    return shift;
  });
  return { shifts, bottom };
}

const shown = (el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
};

/**
 * The page top of the paragraph that cites a list's first note, when the list opens with a numbered note
 * and that paragraph is in the list's own row (the nearest ancestor holding a citation, short of `root`);
 * else null and the list keeps its row's top (the priors' lock note, incoming requests).
 */
function citingTop(list: HTMLElement, root: HTMLElement): number | null {
  const n = (list.firstElementChild as HTMLElement | null)?.dataset.sidenote;
  if (!n) return null;
  for (let el = list.parentElement; el && el !== root; el = el.parentElement) {
    const cite = Array.from(el.querySelectorAll<HTMLElement>(`[data-footnote="${n}"]`)).find((c) => !c.closest("[data-note-list]") && shown(c));
    if (!cite) continue;
    return blockOf(cite, el).getBoundingClientRect().top + window.scrollY;
  }
  return null;
}

/**
 * Lays out the note lists ([data-note-list]) under `root`; `grid` is what they must not run past. A list
 * shows from 1280 px only once placed (data-placed), so the first paint never prints notes over each other.
 */
export function layoutSidenotes(root: HTMLElement, grid: HTMLElement | null): void {
  const lists = Array.from(root.querySelectorAll<HTMLElement>("[data-note-list]"));
  const wide = window.matchMedia(WIDE).matches;
  const measured: { el: HTMLElement; top: number; height: number; anchor: number | null }[] = [];
  for (const el of lists) {
    const shift = Number(el.dataset.shift ?? "0");
    const rect = el.getBoundingClientRect();
    if (!wide || (rect.width === 0 && rect.height === 0)) {
      if (shift !== 0) {
        el.style.transform = "";
        el.dataset.shift = "0";
      }
      continue;
    }
    measured.push({ el, top: rect.top + window.scrollY - shift, height: rect.height, anchor: citingTop(el, root) });
  }
  const { shifts, bottom } = stackNotes(measured);
  measured.forEach(({ el }, i) => {
    const shift = shifts[i] ?? 0;
    if (Number(el.dataset.shift ?? "0") === shift) return;
    el.style.transform = shift > 0 ? `translateY(${shift}px)` : "";
    el.dataset.shift = String(shift);
  });
  for (const el of lists) if (el.dataset.placed === undefined) el.dataset.placed = "true";
  // Room under the grid for notes that run past its last row.
  if (grid) {
    const end = grid.getBoundingClientRect().bottom + window.scrollY - Number(grid.dataset.overflow ?? "0");
    const overflow = wide && measured.length > 0 ? Math.max(0, Math.ceil(bottom - end)) : 0;
    grid.style.paddingBottom = overflow > 0 ? `${overflow}px` : "";
    grid.dataset.overflow = String(overflow);
  }
}

/** Runs the layout after every render that changes `version`, and on resizes, reflows and font loads. */
export function useSidenoteLayout(root: RefObject<HTMLElement | null>, grid: RefObject<HTMLElement | null>, version: unknown): void {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const run = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutSidenotes(el, grid.current));
    };
    layoutSidenotes(el, grid.current);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
    observer?.observe(el);
    window.addEventListener("resize", run);
    void document.fonts?.ready.then(run);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", run);
    };
  }, [root, grid, version]);
}
