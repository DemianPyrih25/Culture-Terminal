// Popover placement: under the trigger by default, flipped when there is no room, kept on screen.
import { describe, expect, it } from "vitest";
import { placePopover } from "../../components/ui/popover-position";

const VIEWPORT = { width: 1440, height: 900 };
const PANEL = { width: 320, height: 200 };

describe("placePopover", () => {
  it("opens under the trigger, aligned to its start", () => {
    const anchor = { top: 100, left: 400, width: 40, height: 20 };
    expect(placePopover(anchor, PANEL, VIEWPORT)).toEqual({ top: 126, left: 400, placement: "bottom-start" });
  });

  it("aligns the end edges for -end placements", () => {
    const anchor = { top: 100, left: 400, width: 40, height: 20 };
    expect(placePopover(anchor, PANEL, VIEWPORT, "bottom-end").left).toBe(120);
  });

  it("flips above when the bottom has no room, and back when the top has none", () => {
    const low = { top: 800, left: 400, width: 40, height: 20 };
    expect(placePopover(low, PANEL, VIEWPORT)).toEqual({ top: 594, left: 400, placement: "top-start" });
    const high = { top: 40, left: 400, width: 40, height: 20 };
    expect(placePopover(high, PANEL, VIEWPORT, "top-start").placement).toBe("bottom-start");
  });

  it("stays inside the viewport margins", () => {
    const right = { top: 100, left: 1400, width: 30, height: 20 };
    expect(placePopover(right, PANEL, VIEWPORT).left).toBe(1440 - 8 - 320);
    const left = { top: 100, left: 2, width: 30, height: 20 };
    expect(placePopover(left, PANEL, VIEWPORT, "bottom-end").left).toBe(8);
  });

  it("pins a panel taller than the viewport to the top margin", () => {
    const anchor = { top: 300, left: 400, width: 40, height: 20 };
    expect(placePopover(anchor, { width: 320, height: 2000 }, VIEWPORT).top).toBe(8);
  });
});
