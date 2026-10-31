"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui";

/**
 * Stop: one press (a click or Esc) posts the cancel, and the button spins until the run ends. Nothing
 * posts it twice. A failed post lets the reader press again.
 */

export type StopPhase = "idle" | "sending" | "sent" | "failed";

type KeyPress = Pick<KeyboardEvent, "key" | "defaultPrevented" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/**
 * Esc stops the run, unless it is typed into a field, held with a modifier, taken by another handler (a
 * popover closing), or pressed while a dialog is open.
 */
export function isStopKey(event: KeyPress, focused: Pick<HTMLElement, "tagName" | "isContentEditable"> | null, dialogOpen: boolean): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.tagName === "SELECT" || focused.isContentEditable)) return false;
  return !dialogOpen;
}

/** POST /api/runs/[id]/cancel; true when the server took it. */
export async function postCancel(runId: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/** The next phase after a press, and whether to send the cancel. Pure. */
export function stopPress(phase: StopPhase): { phase: StopPhase; send: boolean } {
  return phase === "idle" || phase === "failed" ? { phase: "sending", send: true } : { phase, send: false };
}

/** Stop for one run. `enabled` false unbinds Esc (a finished run, a replay). */
export function useStopRun(runId: string, enabled: boolean, cancel: (runId: string) => Promise<boolean> = postCancel): { phase: StopPhase; press: () => void } {
  const [phase, setPhase] = useState<StopPhase>("idle");
  // The phase as of the latest press, so a second press in the same frame cannot post twice.
  const current = useRef<StopPhase>("idle");
  const press = useCallback(() => {
    const step = stopPress(current.current);
    current.current = step.phase;
    setPhase(step.phase);
    if (!step.send) return;
    void cancel(runId).then((ok) => {
      current.current = ok ? "sent" : "failed";
      setPhase(current.current);
    });
  }, [runId, cancel]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      if (!isStopKey(event, focused, document.querySelector('[role="dialog"]') !== null)) return;
      event.preventDefault();
      press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, press]);

  return { phase, press };
}

/** "Stop" (square), a secondary button with its Esc hint. It spins from the press until the run ends. */
export function StopButton({ phase, press, className }: { phase: StopPhase; press: () => void; className?: string }) {
  const busy = phase === "sending" || phase === "sent";
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon="square"
        onClick={press}
        loading={busy}
        loadingLabel="Stopping…"
        disabled={busy}
        aria-keyshortcuts="Escape"
        data-stop={phase}
        className={className}
      >
        {phase === "failed" ? "Stop again" : "Stop"}
        {busy ? null : (
          <kbd aria-hidden className="ml-1 rounded-xs border border-line px-1 font-mono text-[10px] leading-4 text-ink-3 max-md:hidden">
            Esc
          </kbd>
        )}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {phase === "sent" ? "Stopping the answer." : phase === "failed" ? "The stop didn't go through. Try again." : ""}
      </span>
    </>
  );
}
