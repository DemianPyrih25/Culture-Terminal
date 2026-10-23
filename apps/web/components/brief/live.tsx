"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BriefLive, Meter, StageView } from "../../lib/brief";
import { cx, Keycap } from "../ui";

/**
 * The live parts of a brief being written (A03): the progress line with the stage strip and timer,
 * the "This run" meters, and Stop run.
 */

const STAGE_TONE: Readonly<Record<StageView["state"], string>> = {
  done: "font-medium text-ink",
  active: "font-medium text-accent",
  idle: "text-text-2",
  queued: "text-dim",
  failed: "text-negative",
};

/** Clerk ✓ · Analyst writing · Quant computing · Checker queued. */
export function StageStrip({ stages }: { stages: readonly StageView[] }) {
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[12px] leading-4" aria-label="Who is working">
      {stages.map((s, i) => (
        <li key={s.role} className="flex items-center gap-2" data-stage={s.role} data-state={s.state}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          ) : null}
          <span className={STAGE_TONE[s.state]}>{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A/Progress line: ■ Gathering evidence · 7 of ~12 sources ······ 00:21, the bar, then the stages.
 * `label` overrides the headline (it only moves forward, see ./progress).
 */
export function ProgressLine({ live, note, label }: { live: BriefLive; note?: string | null; label?: string }) {
  const { progress } = live;
  const headline = label ?? progress.label;
  return (
    <div className="flex w-full flex-col gap-2.5" data-progress={headline}>
      <div className="flex w-full items-center gap-2.5">
        <span aria-hidden="true" className="size-1.5 shrink-0 bg-accent" />
        <p className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="font-serif text-[20px] leading-[26px] text-ink">{headline}</span>
          <span className="text-[14px] text-dim">{progress.count}</span>
        </p>
        {note ? <span className="text-[11px] text-dim">{note}</span> : null}
        <span className="font-mono text-[12px] text-dim tabular-nums" aria-label={`Elapsed ${progress.clock}`}>
          {progress.clock}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Sources in"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
        className="h-0.5 w-full bg-line"
      >
        <div className="h-0.5 bg-accent transition-[width] duration-[240ms]" style={{ width: `${progress.fraction * 100}%` }} />
      </div>
      <StageStrip stages={live.stages} />
    </div>
  );
}

function MeterRow({ meter, label = meter.label }: { meter: Meter; label?: string }) {
  return (
    <div className="flex flex-col gap-[7px]" data-meter={label}>
      <p className="m-0 flex items-center justify-between text-[12px] leading-4">
        <span className="text-dim">{label}</span>
        <span className={cx("tabular-nums", meter.warn ? "font-medium text-negative" : "text-text-2")}>{meter.text}</span>
      </p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit ?? undefined}
        aria-valuenow={Math.round(meter.used * 100) / 100}
        aria-valuetext={meter.text}
        className="h-0.5 w-full bg-line"
      >
        <div className={cx("h-0.5", meter.warn ? "bg-negative" : "bg-ink")} style={{ width: `${meter.fraction * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * "This run": live calls n/40 (the network calls the run's cap counts; cached ones are free and show in
 * the status line's total), model cost $/0.60, time s/180, then Stop run.
 */
export function RunMeters({ live, stop }: { live: BriefLive; stop?: ReactNode }) {
  return (
    <section aria-label="This run" className="flex flex-col gap-4 pl-[14px]">
      <p aria-hidden="true" className="m-0 text-[10px] leading-none font-semibold tracking-[1.2px] text-dim uppercase">
        This run
      </p>
      <MeterRow meter={live.meters.requests} label="Live calls" />
      <MeterRow meter={live.meters.cost} />
      <MeterRow meter={live.meters.time} />
      {stop}
    </section>
  );
}

export type StopPhase = "idle" | "confirm" | "sending" | "sent" | "failed";

/** How long "Stop this run?" waits for the second press. */
export const STOP_CONFIRM_MS = 5000;

/**
 * Stop run's steps: the first press asks, the second sends the cancel (`send`), and nothing presses it
 * again while it is on its way. Reset withdraws the question. Pure.
 */
export function stopStep(phase: StopPhase, action: "press" | "reset"): { phase: StopPhase; send: boolean } {
  if (action === "reset") return { phase: phase === "confirm" ? "idle" : phase, send: false };
  if (phase === "idle" || phase === "failed") return { phase: "confirm", send: false };
  if (phase === "confirm") return { phase: "sending", send: true };
  return { phase, send: false };
}

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

/**
 * Stop run with one confirmation: the first press (click or Esc) asks, the second posts the cancel. The
 * question lapses after five seconds. `enabled` false unbinds Esc (a finished run, a replay).
 */
export function useStopRun(runId: string, enabled: boolean): { phase: StopPhase; press: () => void; reset: () => void } {
  const [phase, setPhase] = useState<StopPhase>("idle");
  // The phase as of the latest press, so a second press in the same frame cannot post twice.
  const current = useRef<StopPhase>("idle");
  const apply = useCallback(
    (action: "press" | "reset") => {
      const step = stopStep(current.current, action);
      current.current = step.phase;
      setPhase(step.phase);
      if (!step.send) return;
      void postCancel(runId).then((ok) => {
        current.current = ok ? "sent" : "failed";
        setPhase(current.current);
      });
    },
    [runId],
  );
  const press = useCallback(() => apply("press"), [apply]);
  const reset = useCallback(() => apply("reset"), [apply]);

  useEffect(() => {
    if (phase !== "confirm") return;
    const timer = setTimeout(reset, STOP_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [phase, reset]);

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

  return { phase, press, reset };
}

const STOP_LABEL: Readonly<Record<StopPhase, string>> = {
  idle: "Stop run",
  confirm: "Stop this run?",
  sending: "Stopping…",
  sent: "Stopping…",
  failed: "Stop failed · try again",
};

/** Stop run [Esc]; asks once before it posts the cancel. */
export function StopRunButton({ phase, press, reset }: { phase: StopPhase; press: () => void; reset: () => void }) {
  const busy = phase === "sending" || phase === "sent";
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button
        type="button"
        onClick={press}
        disabled={busy}
        aria-keyshortcuts="Escape"
        className={cx(
          "inline-flex h-9 items-center rounded-brief text-[13px] font-medium disabled:cursor-default",
          phase === "confirm" || phase === "failed" ? "text-negative" : "text-accent",
          busy && "text-dim",
        )}
      >
        {phase === "confirm" ? "Yes, stop this run" : STOP_LABEL[phase]}
      </button>
      {phase === "confirm" ? (
        <button type="button" onClick={reset} className="text-[12px] text-dim hover:text-ink">
          Keep going
        </button>
      ) : busy ? null : (
        <Keycap>Esc</Keycap>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {phase === "confirm" ? "Press Stop or Escape again to stop the run." : phase === "sent" ? "Stop requested." : phase === "failed" ? "The stop request failed." : ""}
      </span>
    </div>
  );
}
