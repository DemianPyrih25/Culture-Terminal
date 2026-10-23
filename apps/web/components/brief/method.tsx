"use client";

import { useId, useState } from "react";
import type { BriefMethod, CheckerLine, Interpretation, MethodStep, StepStatus } from "../../lib/brief";
import { CheckIcon, ChevronIcon, CrossIcon, cx, DashIcon } from "../ui";

/**
 * 05 Method, mechanics last (A/Method line): the line, the ANALYST PIVOT and CODE FALLBACK lines and the
 * CHECKER line; "Show the N steps" opens CLERK's reading, the steps with estimated vs actual calls, and
 * who did what.
 */

const LABEL = "text-[10px] leading-4 font-semibold tracking-[1.1px] uppercase";

const STATUS_WORD: Readonly<Record<StepStatus, string>> = {
  planned: "planned",
  running: "running",
  not_run: "not run",
  stopped: "stopped",
  ok: "done",
  partial: "partial",
  empty: "no data",
  error: "failed",
};

const STATUS_TONE: Readonly<Record<StepStatus, string>> = {
  planned: "text-dim",
  running: "text-accent",
  not_run: "text-dim",
  stopped: "text-negative",
  ok: "text-text-2",
  partial: "text-text-2",
  empty: "text-dim",
  error: "text-negative",
};

function origin(step: MethodStep): string {
  if (step.pivot) return "Pivot";
  if (step.origin === "scan") return "Scan";
  if (step.origin === "plan") return step.stepId ? `Plan ${step.stepId}` : "Plan";
  return "Follow-up";
}

function checkerText(checker: CheckerLine): string {
  switch (checker.state) {
    case "passed":
    case "rejected":
      return checker.line ?? (checker.state === "passed" ? "passed" : "sent the draft back");
    case "queued":
      return "queued: reads the draft once it is written";
    case "checking":
      return "checking every number in the draft";
    case "skipped":
      return "not run: an evidence digest has no prose to check";
    case "stopped":
      return "did not run: the run stopped first";
  }
}

export function CheckerLineView({ checker }: { checker: CheckerLine }) {
  const icon =
    checker.state === "passed" ? (
      <CheckIcon className="shrink-0 text-accent" />
    ) : checker.state === "rejected" ? (
      <CrossIcon className="shrink-0 text-negative" />
    ) : (
      <DashIcon className="shrink-0 text-faint" />
    );
  return (
    <p className="m-0 flex items-center gap-2 text-[13px] leading-5 text-text-2" data-checker={checker.state}>
      {icon}
      <span className={cx(LABEL, "text-ink")}>Checker</span>
      <span>
        {checkerText(checker)}
        {checker.warnings > 0 ? ` · ${checker.warnings} ${checker.warnings === 1 ? "warning" : "warnings"}` : ""}
      </span>
    </p>
  );
}

/** A faint separator, only drawn: a screen reader hears the words and the spaces around it. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

function ClerkReading({ reading }: { reading: Interpretation }) {
  return (
    <div className="flex flex-col gap-1.5" data-clerk-reading="true">
      <p className={cx(LABEL, "m-0 text-dim")}>Understood as · Clerk</p>
      <p className="m-0 text-[13px] leading-5 text-ink">
        <span className="font-semibold tracking-[1.3px] text-accent uppercase">{reading.deskLabel}</span> <Dot /> {reading.jobLabel} <Dot />{" "}
        <span className="font-mono text-[11px] text-text-2">{reading.mnemonic}</span>
      </p>
      <p className="m-0 text-[13px] leading-5 text-text-2">
        {reading.subjects.join(", ")}
        {reading.scope ? ` · ${reading.scope}` : ""} · {reading.detail}
      </p>
      {reading.resolves.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-dim">
          {reading.resolves.map((r, i) => (
            <li key={i} className="flex items-center gap-1">
              {r.applied ? <CheckIcon size={12} className="text-accent" /> : <DashIcon size={12} className="text-faint" />}
              {r.mention} · {r.matchLabel}
            </li>
          ))}
        </ul>
      ) : null}
      {reading.assumptions.length > 0 ? (
        <p className="m-0 text-[12px] leading-[17px] text-dim">Assumed: {reading.assumptions.join("; ")}.</p>
      ) : null}
      {reading.reframe ? <p className="m-0 text-[12px] leading-[17px] text-dim">Read as a group-level question: {reading.reframe}.</p> : null}
    </div>
  );
}

function StepsTable({ steps }: { steps: readonly MethodStep[] }) {
  return (
    <table className="w-full border-collapse text-[13px] leading-5">
      <caption className="sr-only">The steps, with estimated and actual Qloo calls</caption>
      <thead>
        <tr className={cx(LABEL, "text-dim")}>
          <th scope="col" className="w-8 pb-1 text-left font-semibold">#</th>
          <th scope="col" className="pb-1 text-left font-semibold">Step</th>
          <th scope="col" className="w-12 pb-1 text-right font-semibold">Est.</th>
          <th scope="col" className="w-12 pb-1 text-right font-semibold">Calls</th>
          <th scope="col" className="w-20 pb-1 text-right font-semibold">Status</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.n} className="border-t border-line align-top" data-step={s.n} data-status={s.status}>
            <td className="py-2 font-mono text-[11px] text-dim">{s.n}</td>
            <td className="py-2 pr-3">
              <span className="font-medium text-ink">{s.toolLabel}</span>
              <span className={cx(LABEL, "ml-2", s.pivot ? "text-accent" : "text-dim")}>{origin(s)}</span>
              {s.purpose ? <span className="block text-[12px] leading-[17px] text-dim">{s.purpose}</span> : null}
            </td>
            <td className="py-2 text-right text-dim tabular-nums">{s.estimate ?? "–"}</td>
            <td className={cx("py-2 text-right tabular-nums", s.estimate !== null && s.actual > s.estimate ? "font-medium text-ink" : "text-text-2")}>
              {s.actual}
            </td>
            <td className={cx("py-2 text-right text-[12px]", STATUS_TONE[s.status])}>{STATUS_WORD[s.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MethodBlock({ method }: { method: BriefMethod }) {
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  const n = method.steps.length;
  return (
    <div className="flex w-full flex-col gap-3">
      {/* Narrow windows: METHOD and the steps toggle share the first line, the line itself the next. */}
      <div className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line py-[11px]">
        <span className="text-[11px] leading-none font-semibold tracking-[1.3px] text-dim uppercase">Method</span>
        <span className="min-w-0 flex-1 text-[13px] leading-5 text-text-2 max-sm:order-last max-sm:basis-full">{method.line}</span>
        {n > 0 || method.interpretation ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={stepsId}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-brief text-[13px] font-medium text-accent hover:underline hover:underline-offset-4 max-sm:ml-auto print:hidden"
          >
            {open ? "Hide the steps" : `Show the ${n === 1 ? "step" : `${n} steps`}`}
            <ChevronIcon direction={open ? "up" : "down"} />
          </button>
        ) : null}
      </div>
      {method.pivots.map((p) => (
        <p key={p.toolCallId} className="m-0 flex flex-wrap items-baseline gap-x-2 text-[13px] leading-5 text-text-2" data-pivot={p.triggerFindingId}>
          <span className={cx(LABEL, "text-accent")}>Analyst pivot</span>
          <span className="font-mono text-[11px] text-ink">
            {p.triggerFindingId} → {p.toolLabel}
          </span>
          {p.finding ? <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{p.finding}</span> : null}
        </p>
      ))}
      {method.fallbacks.map((f, i) => (
        <p key={i} className="m-0 flex flex-wrap items-baseline gap-x-2 text-[13px] leading-5 text-text-2" data-fallback="true">
          <span className={cx(LABEL, "text-dim")}>Code fallback</span>
          <span className="font-mono text-[11px] text-ink">
            {f.from} → {f.to}
          </span>
          <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{f.reason}</span>
        </p>
      ))}
      <CheckerLineView checker={method.checker} />
      <div id={stepsId} className={cx("flex flex-col gap-4 pt-1", !open && "hidden print:flex")} data-open={open}>
        {method.interpretation ? <ClerkReading reading={method.interpretation} /> : null}
        {n > 0 ? <StepsTable steps={method.steps} /> : null}
        <p className="m-0 text-[12px] leading-[17px] text-dim">
          Clerk {method.models.clerk ?? "model"} · Analyst {method.models.analyst ?? "model"} · Quant: code, not an LLM · Checker: code
        </p>
      </div>
    </div>
  );
}
