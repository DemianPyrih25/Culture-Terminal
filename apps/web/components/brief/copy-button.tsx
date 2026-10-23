"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cx } from "../ui";

/** Writes text to the clipboard; false when the browser refuses (no permission, insecure origin). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Remembers a copy outcome for a moment, for the polite "Copied" that follows a press. */
export function useCopied(ms = 2000): [state: "idle" | "copied" | "failed", copy: (text: string) => void] {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), ms);
    return () => clearTimeout(timer);
  }, [state, ms]);
  return [state, (text) => void copyText(text).then((ok) => setState(ok ? "copied" : "failed"))];
}

/** A quiet text button that copies `text`, then says so in a polite live region. */
export function CopyButton({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  const [state, copy] = useCopied();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => copy(text)}
        className={cx("rounded-brief text-[12px] font-medium text-accent hover:underline hover:underline-offset-4", className)}
      >
        {children}
      </button>
      <span role="status" aria-live="polite" className="text-[11px] text-dim">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select the text instead" : ""}
      </span>
    </span>
  );
}
