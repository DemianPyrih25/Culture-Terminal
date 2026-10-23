// The outline's scrollspy: which section is active for a scroll position.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activeSection,
  isScrolledToBottom,
  resolveActiveItem,
  spyRootMargin,
  type OutlineItem,
} from "../../components/layout/scrollspy";

const OFFSET = 124;

function at(...tops: number[]) {
  const ids = ["answer", "conviction", "evidence", "risks", "method", "sources"];
  return tops.map((top, i) => ({ id: ids[i]!, top }));
}

describe("activeSection", () => {
  it("is null without sections", () => {
    expect(activeSection([], OFFSET)).toBeNull();
  });

  it("is the first section before any reaches the activation line", () => {
    expect(activeSection(at(300, 900, 1500), OFFSET)).toBe("answer");
  });

  it("is the last section whose top has reached the line", () => {
    expect(activeSection(at(-400, 100, 700), OFFSET)).toBe("conviction");
    expect(activeSection(at(-1400, -800, -20, 600), OFFSET)).toBe("evidence");
  });

  it("switches exactly at the line, within a pixel of rounding", () => {
    expect(activeSection(at(-200, OFFSET + 1), OFFSET)).toBe("conviction");
    expect(activeSection(at(-200, OFFSET + 2), OFFSET)).toBe("answer");
  });

  it("is the last section at the bottom of the page, even when it never reaches the line", () => {
    expect(activeSection(at(-1400, -800, -200, 300, 500, 700), OFFSET, true)).toBe("sources");
  });
});

describe("isScrolledToBottom", () => {
  it("is true within the slack of the end", () => {
    expect(isScrolledToBottom(1100, 900, 2000)).toBe(true);
    expect(isScrolledToBottom(1099, 900, 2000)).toBe(true);
    expect(isScrolledToBottom(1000, 900, 2000)).toBe(false);
  });

  it("is false for a page that does not scroll", () => {
    expect(isScrolledToBottom(0, 900, 900)).toBe(false);
  });
});

describe("resolveActiveItem", () => {
  const items: OutlineItem[] = [
    { id: "answer", label: "Answer" },
    { id: "conviction", label: "Conviction" },
    { id: "risks", label: "Risks", pending: true },
  ];

  it("prefers a forced id, then the spied one, then the first ready item", () => {
    expect(resolveActiveItem(items, "conviction", "answer")).toBe("conviction");
    expect(resolveActiveItem(items, undefined, "conviction")).toBe("conviction");
    expect(resolveActiveItem(items, undefined, null)).toBe("answer");
  });

  it("never activates a pending section from the scroll position", () => {
    expect(resolveActiveItem(items, undefined, "risks")).toBe("answer");
  });

  it("lives in a module without \"use client\", so server components can call it", () => {
    const source = readFileSync(new URL("../../components/layout/scrollspy.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });
});

describe("spyRootMargin", () => {
  it("ends one pixel under the activation line", () => {
    // 900 px viewport, line at 124: the band's bottom edge is 900 - 124 - 1 = 775 px up from the bottom.
    expect(spyRootMargin(OFFSET, 900, 5000)).toMatch(/ 0px -775px 0px$/);
  });

  it("reaches above the top of the document, so a section carried past the line in one frame still counts", () => {
    const top = Number.parseInt(spyRootMargin(OFFSET, 900, 5000), 10);
    // A section at the very top of a 5000 px document, scrolled to the end, sits 4100 px above the viewport.
    expect(top).toBeGreaterThanOrEqual(5000 - 900 + OFFSET);
    expect(top).toBe(4 * 5000 + OFFSET);
    // A page shorter than the viewport still reaches past its top.
    expect(Number.parseInt(spyRootMargin(OFFSET, 900, 400), 10)).toBe(4 * 900 + OFFSET);
  });

  it("never asks for a negative band", () => {
    expect(spyRootMargin(2000, 900, 900)).toMatch(/ 0px 0px 0px$/);
  });
});
