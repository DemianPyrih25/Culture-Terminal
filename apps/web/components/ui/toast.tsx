"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

export interface ToastProps {
  /** "Link copied", "Copied". */
  children: ReactNode;
  className?: string;
}

/** C/Toast: ink, r4, 40 tall, a soft-green check and a 13/500 white label. Static; useToast shows it for a moment. */
export function Toast({ children, className }: ToastProps) {
  return (
    <div
      className={cx(
        "inline-flex h-10 items-center gap-2.5 rounded-sm bg-ink px-3.5 text-[13px] leading-[18px] font-medium whitespace-nowrap text-white shadow-md",
        className,
      )}
    >
      <Icon name="check" size={16} className="text-good-soft" />
      <span>{children}</span>
    </div>
  );
}

/** How long a toast stays, in ms. */
export const TOAST_MS = 2000;

/**
 * A toast for one component: `show("Link copied")` puts it at the bottom centre of the viewport for two
 * seconds. Render `toast` anywhere in the component; it is a polite status region, present (empty) from
 * the first render so screen readers hear each message.
 */
export function useToast(): { show: (message: string) => void; toast: ReactNode } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);
  const toast = (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
    >
      {message ? <Toast className="motion-safe:animate-rise">{message}</Toast> : null}
    </div>
  );
  return { show, toast };
}
