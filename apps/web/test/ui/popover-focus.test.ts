// Popover focus: closing never drops keyboard focus on the body, and Tab leaves the panel as if it sat
// right after its trigger.
import { describe, expect, it } from "vitest";
import { focusOnClose, nextAfter, panelTabMove } from "../../components/ui/popover-focus";

describe("focusOnClose", () => {
  it("returns to the trigger on Escape and on Shift+Tab out of the panel", () => {
    expect(focusOnClose("escape", true)).toBe("trigger");
    expect(focusOnClose("escape", false)).toBe("trigger");
    expect(focusOnClose("tab-back", true)).toBe("trigger");
  });

  it("returns to the trigger when the content's close runs with focus in the panel", () => {
    // The Close button case: focus would otherwise fall to the body as the panel unmounts.
    expect(focusOnClose("close", true)).toBe("trigger");
    expect(focusOnClose("close", false)).toBe("none");
  });

  it("moves on past the trigger on Tab out of the panel", () => {
    expect(focusOnClose("tab-forward", true)).toBe("after-trigger");
  });

  it("leaves focus where the reader put it on a press outside, a focus move or the trigger", () => {
    expect(focusOnClose("outside", true)).toBe("none");
    expect(focusOnClose("focus-lost", false)).toBe("none");
    expect(focusOnClose("toggle", false)).toBe("none");
  });
});

describe("panelTabMove", () => {
  it("lets the browser move between the panel's stops", () => {
    expect(panelTabMove(0, 3, false)).toBe("inside");
    expect(panelTabMove(1, 3, false)).toBe("inside");
    expect(panelTabMove(2, 3, true)).toBe("inside");
    // From the panel itself, Tab enters its first stop.
    expect(panelTabMove(-1, 3, false)).toBe("inside");
  });

  it("leaves forward from the last stop, or from a panel without stops", () => {
    expect(panelTabMove(2, 3, false)).toBe("forward");
    expect(panelTabMove(0, 1, false)).toBe("forward");
    expect(panelTabMove(-1, 0, false)).toBe("forward");
  });

  it("leaves back from the first stop or the panel itself", () => {
    expect(panelTabMove(0, 3, true)).toBe("back");
    expect(panelTabMove(-1, 3, true)).toBe("back");
    expect(panelTabMove(-1, 0, true)).toBe("back");
  });
});

describe("nextAfter", () => {
  // Document tab order with the portalled panel's stops at the end of the body.
  const order = ["wordmark", "trigger", "next-link", "last-control", "panel-close", "panel-link"];
  const inPanel = (id: string) => id.startsWith("panel-");

  it("is the stop after the trigger, skipping the panel's own stops", () => {
    expect(nextAfter(order, "trigger", inPanel)).toBe("next-link");
    expect(nextAfter(order, "last-control", inPanel)).toBeNull();
  });

  it("is null for an anchor that is not in the order", () => {
    expect(nextAfter(order, "missing", inPanel)).toBeNull();
  });
});
