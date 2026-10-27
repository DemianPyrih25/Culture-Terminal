"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { focusOnClose, nextAfter, panelTabMove, type PopoverCloseReason } from "./popover-focus";
import { placePopover, type PopoverPlacement } from "./popover-position";

/** Props a custom trigger spreads onto its button. */
export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  type: "button";
  onClick: () => void;
  /** Tab on the trigger of an open panel moves into the panel. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

export interface PopoverProps {
  /**
   * The trigger. A node is wrapped in a button (styled with `triggerClassName`); a function receives the
   * trigger props to spread on its own button, e.g. a footnote number.
   */
  trigger: ReactNode | ((props: PopoverTriggerProps) => ReactNode);
  /** Accessible name of the wrapped trigger button, when its content is not text. */
  triggerLabel?: string;
  triggerClassName?: string;
  /** Accessible name of the panel (role="dialog"), e.g. "Request 3". */
  label: string;
  /** Panel content, or a function of `close` (which returns focus to the trigger when it was in the panel). */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Preferred side and alignment; flips when there is no room. Default bottom-start. */
  placement?: PopoverPlacement;
  /** Panel width in px (default 320). */
  width?: number;
  /** Controlled open state; leave undefined to let the popover manage it. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the panel. */
  className?: string;
}

// Elements that can take focus from the keyboard; tabbables() filters out the disabled and hidden ones.
const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';

/** The keyboard stops under `root`, in document order. */
function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(":disabled") &&
      !(el instanceof HTMLInputElement && el.type === "hidden") &&
      el.closest("[inert]") === null &&
      el.getClientRects().length > 0,
  );
}

/**
 * Places the panel under (or over) its anchor and shows it. Written straight to the element's style: no
 * state round trip, so the panel never paints at the wrong place.
 */
function placePanel(panel: HTMLElement, anchor: HTMLElement, placement: PopoverPlacement): void {
  const next = placePopover(
    anchor.getBoundingClientRect(),
    { width: panel.offsetWidth, height: panel.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    placement,
  );
  panel.style.top = `${next.top}px`;
  panel.style.left = `${next.left}px`;
  panel.style.visibility = "visible";
}

/** True when focus rests nowhere: on the body, as after the focused element was removed. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * An anchored, non-modal dialog: opens under its trigger and moves focus into the panel. The panel is
 * portalled to the body with fixed coordinates so scroll containers and figures never clip it, but keeps
 * the tab order of a panel placed right after its trigger: Tab on the trigger enters it, Shift+Tab out of
 * it returns to the trigger, Tab out of it moves on to the stop after the trigger. It closes on Escape and
 * on its content's `close` (focus returns to the trigger), on those Tab moves, on a click outside, and
 * when focus moves elsewhere. C/Popover: 320 wide, r12, surface, shadow-lg (the confidence popover).
 */
export function Popover({
  trigger,
  triggerLabel,
  triggerClassName,
  label,
  children,
  placement = "bottom-start",
  width = 320,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const panelId = useId();
  // Trigger and panel live in state (their setters are the callback refs), so effects and handlers read
  // them without touching a ref during render.
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  // Where focus goes once the panel has closed: set by dismiss, applied after the panel unmounts, so the
  // move never fires a blur on the panel that would close it twice.
  const [restore, setRestore] = useState<{ to: HTMLElement | null }>({ to: null });

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  /** Closes the panel; focus then moves as focusOnClose says. */
  const dismiss = useCallback(
    (reason: PopoverCloseReason) => {
      if (!open) return;
      const focusInPanel = panelEl !== null && panelEl.contains(document.activeElement);
      const target = focusOnClose(reason, focusInPanel);
      let to: HTMLElement | null = null;
      if (target === "trigger") to = triggerEl;
      else if (target === "after-trigger" && triggerEl) {
        to = nextAfter<HTMLElement>(tabbables(document), triggerEl, (el) => panelEl?.contains(el) ?? false) ?? triggerEl;
      }
      setRestore({ to });
      setOpen(false);
    },
    [open, panelEl, setOpen, triggerEl],
  );
  const close = useCallback(() => dismiss("close"), [dismiss]);

  // After a close, focus the element dismiss chose, if the panel took focus with it. A press elsewhere
  // that already put focus somewhere keeps it there.
  useLayoutEffect(() => {
    if (!open && restore.to && focusIsLost()) restore.to.focus();
  }, [open, restore]);

  // Measure and place after every open, then follow scrolling and resizing.
  useLayoutEffect(() => {
    if (!open || !panelEl || !triggerEl) return;
    const place = () => placePanel(panelEl, triggerEl, placement);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement, triggerEl, panelEl]);

  // Focus moves into the panel once per opening, when it mounts.
  useEffect(() => {
    if (open) panelEl?.focus({ preventScroll: true });
  }, [open, panelEl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss("escape");
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelEl?.contains(target) || triggerEl?.contains(target)) return;
      dismiss("outside");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, dismiss, panelEl, triggerEl]);

  // Tab at either end of the panel leaves it as if it followed the trigger; inside, the browser moves.
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || !panelEl) return;
    const stops = tabbables(panelEl);
    const move = panelTabMove(stops.indexOf(document.activeElement as HTMLElement), stops.length, event.shiftKey);
    if (move === "inside") return;
    event.preventDefault();
    dismiss(move === "back" ? "tab-back" : "tab-forward");
  };

  const keepsOpen = (node: Node | null) =>
    node !== null && (panelEl?.contains(node) === true || triggerEl?.contains(node) === true);

  const onPanelBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next) {
      if (!keepsOpen(next)) dismiss("focus-lost");
      return;
    }
    // No related target: focus left the page (another window, the browser's own UI), or fell to the body.
    // Keep the panel while the page itself has lost focus; close it when focus fell to the body.
    requestAnimationFrame(() => {
      if (!panelEl?.isConnected || !document.hasFocus()) return;
      if (!keepsOpen(document.activeElement)) dismiss("focus-lost");
    });
  };

  const triggerProps: PopoverTriggerProps = {
    ref: setTriggerEl,
    type: "button",
    onClick: () => {
      if (open) {
        dismiss("toggle");
        return;
      }
      setRestore({ to: null });
      setOpen(true);
    },
    onKeyDown: (event) => {
      if (!open || !panelEl || event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      event.preventDefault();
      (tabbables(panelEl)[0] ?? panelEl).focus();
    },
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? panelId : undefined,
  };

  // Hidden until the layout effect has placed it.
  const panelStyle: CSSProperties = { width, maxWidth: "calc(100vw - 16px)", top: 0, left: 0, visibility: "hidden" };

  return (
    <>
      {typeof trigger === "function" ? (
        trigger(triggerProps)
      ) : (
        <button {...triggerProps} aria-label={triggerLabel} className={triggerClassName}>
          {trigger}
        </button>
      )}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={setPanelEl}
              id={panelId}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              onBlur={onPanelBlur}
              style={panelStyle}
              className={cx(
                "fixed z-50 max-h-[min(480px,calc(100vh-16px))] overflow-auto rounded-control border border-line bg-surface p-4 text-ink shadow-lg outline-none",
                className,
              )}
            >
              {typeof children === "function" ? children(close) : children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
