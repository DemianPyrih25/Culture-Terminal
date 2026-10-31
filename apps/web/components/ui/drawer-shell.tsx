"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./button";
import { cx } from "./cx";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** The element a Tab press at either end of the panel wraps to, or null to let the browser move. */
export function trapTarget<T>(stops: readonly T[], active: T | null, shift: boolean): T | null {
  if (stops.length === 0) return null;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const at = active === null ? -1 : stops.indexOf(active);
  if (shift && at <= 0) return last;
  if (!shift && (at === -1 || at === stops.length - 1)) return first;
  return null;
}

export interface DrawerShellProps {
  open: boolean;
  /** Esc, a scrim click and the close button. Focus then returns to the element that opened it. */
  onClose: () => void;
  /** The dialog's title (serif 20). */
  title: ReactNode;
  /** The line under the title, 13/500 ink-3. */
  subtitle?: ReactNode;
  /** Desktop width in px (default 520: How we know; 320 for the phone menu sheet). */
  width?: number;
  /** Between the head and the body, e.g. the tabs. */
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The drawer shell: a scrim and a panel fixed to the right (surface, a hairline edge, a soft shadow-lg; a
 * hairline rule between the head and the body). A modal
 * dialog: focus moves in and is trapped, Esc and a scrim click close it, focus returns to the opener. On
 * phones it is a full-screen sheet with a 44 px close button. Page scroll is locked while it is open.
 */
export function DrawerShell({ open, onClose, title, subtitle, width = 520, toolbar, children, className }: DrawerShellProps) {
  const titleId = useId();
  const subtitleId = useId();
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Remember the opener when it opens; give focus back when it closes.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      opener.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (open) panel?.focus({ preventScroll: true });
  }, [open, panel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panel) return;
    const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    const target = trapTarget(stops, document.activeElement as HTMLElement | null, event.shiftKey);
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div aria-hidden="true" data-scrim="true" onClick={onClose} className="absolute inset-0 bg-scrim" />
      <div
        ref={setPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        style={{ ["--drawer-w" as string]: `${width}px` }}
        className={cx(
          "absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-lg outline-none",
          "max-md:top-0 md:w-[min(var(--drawer-w),100vw)] md:border-l md:border-line",
          "motion-safe:animate-rise",
          className,
        )}
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-4 max-md:px-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="type-title text-ink">
              {title}
            </h2>
            {subtitle ? (
              <p id={subtitleId} className="mt-0.5 type-label text-ink-3">
                {subtitle}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" icon="x" onClick={onClose} className="-mt-1 -mr-2 max-md:size-11" />
        </div>
        {toolbar ? <div className="px-6 pb-4 max-md:px-4">{toolbar}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-6 pt-5 pb-6 max-md:px-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
