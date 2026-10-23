// Where an anchored popover goes: under or over its trigger, flipped when the preferred side has no room,
// and kept inside the viewport. Pure, so placement is tested without a layout engine.

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  /** The placement used after flipping. */
  placement: PopoverPlacement;
}

/**
 * Viewport coordinates (for position: fixed) of a panel anchored to `anchor`. `gap` separates the panel
 * from the trigger and `margin` from the viewport edges.
 */
export function placePopover(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: PanelSize,
  placement: PopoverPlacement = "bottom-start",
  gap = 6,
  margin = 8,
): PopoverPosition {
  const [side, align] = placement.split("-") as ["bottom" | "top", "start" | "end"];
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - panel.height;
  const roomBelow = viewport.height - margin - below >= panel.height;
  const roomAbove = above >= margin;
  const useSide = side === "bottom" ? (roomBelow || !roomAbove ? "bottom" : "top") : roomAbove || !roomBelow ? "top" : "bottom";
  let top = useSide === "bottom" ? below : above;
  top = Math.max(margin, Math.min(top, viewport.height - margin - panel.height));
  let left = align === "start" ? anchor.left : anchor.left + anchor.width - panel.width;
  left = Math.max(margin, Math.min(left, viewport.width - margin - panel.width));
  return { top: Math.round(top), left: Math.round(left), placement: `${useSide}-${align}` };
}
