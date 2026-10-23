"use client";

import { useId, useState } from "react";
import type { BriefConviction, BriefPrior, BriefPriors, PriorState } from "../../lib/brief";
import { ChevronIcon, cx } from "../ui";
import { Prose } from "./prose";

/**
 * 02 Conviction (A/Conviction strip, A/Prior): the score code computed, never the model, on its
 * LOW · MEDIUM · HIGH scale with "Why NN" opening the penalties; then the priors written before any
 * data, each refuted, confirmed or inconclusive with what was measured, or awaiting while live.
 */

const METER_WIDTH = 360;

/** The scale: a hairline track, ticks at 0, 50, 75 and 100, the fill and marker at the score. */
function ConvictionMeter({ conviction }: { conviction: BriefConviction }) {
  const summary = conviction.summary;
  const position = summary?.position ?? null;
  return (
    <div
      role="meter"
      aria-label="Conviction"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={summary?.score}
      aria-valuetext={summary ? summary.text : "pending"}
      className="relative h-[30px] w-full shrink-0 sm:w-[360px]"
      style={{ maxWidth: METER_WIDTH }}
    >
      {/* The track sits level with the middle of the rule note's first line, as in A/Conviction strip. */}
      <span className="absolute top-[9px] left-0 h-px w-full bg-line-strong" />
      {conviction.ticks.map((t) => (
        <span key={t} className="absolute top-[5px] h-[9px] w-px bg-line-strong" style={{ left: `calc(${t * 100}% - ${t === 1 ? 1 : 0}px)` }} />
      ))}
      {position !== null ? (
        <>
          <span className="absolute top-2 left-0 h-[3px] bg-accent" style={{ width: `${position * 100}%` }} />
          <span className="absolute top-0.5 h-[15px] w-[2px] bg-accent" style={{ left: `calc(${position * 100}% - ${position >= 1 ? 2 : 1}px)` }} />
        </>
      ) : null}
      {conviction.scale.map((band) => (
        <span
          key={band.band}
          aria-hidden="true"
          className="absolute top-[19px] text-[9px] leading-none font-semibold tracking-[0.9px] text-dim"
          style={{ left: `calc(${band.from * 100}% + ${band.from === 0 ? 4 : 0}px)` }}
        >
          {band.label}
        </span>
      ))}
    </div>
  );
}

/** A/Conviction strip. */
export function ConvictionStrip({ conviction }: { conviction: BriefConviction }) {
  const [open, setOpen] = useState(false);
  const whyId = useId();
  const { summary, why } = conviction;
  return (
    <div className="flex w-full flex-col gap-3" data-conviction={conviction.state}>
      {summary ? (
        <div className="flex w-full items-center gap-3">
          <span className="text-[11px] leading-none font-semibold tracking-[1.3px] text-dim uppercase">Conviction</span>
          <span className="font-serif text-[20px] leading-[26px] font-medium text-ink">{summary.text}</span>
          {why ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={whyId}
              onClick={() => setOpen((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded-brief text-[13px] font-medium text-accent hover:underline hover:underline-offset-4 print:hidden"
            >
              {why.label}
              <ChevronIcon direction={open ? "up" : "down"} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:gap-7">
        <ConvictionMeter conviction={conviction} />
        <p className="m-0 flex-1 text-[12px] leading-[17px] text-dim">
          {conviction.ruleNote}
          {conviction.coverage ? ` ${conviction.coverage.text}.` : ""}
        </p>
      </div>
      {why ? (
        <div id={whyId} className={cx("w-full", !open && "hidden print:block")} data-open={open}>
          <ul className="m-0 list-none border-t border-line p-0">
            {why.lines.map((line) => (
              <li key={line.rule} className="flex items-center gap-4 border-b border-line py-[7px] text-[13px]" data-penalty={line.rule}>
                <span className="w-11 shrink-0 font-semibold text-ink tabular-nums">{line.pointsText}</span>
                <span className="min-w-0 flex-1 text-text-2">{line.label}</span>
                <span className="font-mono text-[10px] text-dim">rule {line.rule}</span>
              </li>
            ))}
            <li className="flex items-center gap-4 py-[7px] text-[13px]">
              <span className="w-11 shrink-0 font-semibold text-ink tabular-nums">{why.total.text}</span>
              <span className="min-w-0 flex-1 text-text-2">{why.total.label}</span>
              <span className="font-mono text-[10px] text-dim">computed</span>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** FOUR PRIORS, WRITTEN BEFORE ANY DATA · 09:12:04 ········ 2 refuted · 1 confirmed · 1 inconclusive. */
export function PriorsKicker({ priors }: { priors: BriefPriors }) {
  return (
    <div className="flex w-full flex-wrap items-end justify-between gap-x-4 border-b border-ink pb-0.5">
      <h3 className="m-0 text-[11px] leading-4 font-semibold tracking-[1.2px] text-ink uppercase">{priors.kicker}</h3>
      {priors.tally ? <span className="text-[12px] leading-4 text-dim">{priors.tally}</span> : null}
    </div>
  );
}

// A prior still waiting reads lighter until it is scored (A03), by weight rather than a fainter colour; a
// verdict, or "not scored", reads in full.
const VERDICT_TONE: Readonly<Record<PriorState, string>> = {
  refuted: "text-negative",
  confirmed: "text-accent",
  inconclusive: "text-dim",
  awaiting_data: "text-dim",
  awaiting_check: "text-dim",
  not_scored: "text-dim",
};

const isAwaiting = (state: PriorState) => state === "awaiting_data" || state === "awaiting_check";

/** A/Prior: H1, "We expected: …", "Measured: …" (or how far the data has come), and the verdict. */
export function PriorItem({ prior, hero = false }: { prior: BriefPrior; hero?: boolean }) {
  const waiting = prior.measured === null;
  return (
    <div
      className={cx("flex w-full gap-x-4 border-b border-line max-sm:flex-wrap", hero ? "pt-3 pb-3.5" : "py-2.5")}
      data-prior={prior.id}
      data-state={prior.state}
    >
      <span className="w-6 shrink-0 font-mono text-[11px] leading-[22px] text-dim">{prior.id}</span>
      <div className={cx("flex min-w-0 flex-1 flex-col", hero ? "gap-1.5" : "gap-[3px]")}>
        <p className={cx("m-0 text-ink", hero ? "font-serif text-[19px] leading-[26px] sm:text-[22px] sm:leading-[29px]" : "type-body")}>{prior.expected}</p>
        <p
          className={cx(
            "m-0",
            hero ? "text-[14px] leading-[21px]" : "text-[13px] leading-[19px]",
            hero && !waiting ? "text-text-2" : "text-dim",
          )}
        >
          {prior.measured ? <Prose inlines={prior.measured} /> : prior.progress}
        </p>
      </div>
      <span
        className={cx(
          "flex shrink-0 items-center justify-end gap-1.5 self-start",
          // Narrow windows: the verdict takes its own line above the prior, under the text column.
          "max-sm:order-first max-sm:w-full max-sm:justify-start max-sm:pb-1 max-sm:pl-10",
          // The verdict keeps its whole word: INCONCLUSIVE is wider than the hero's 100 px column.
          hero ? "sm:w-auto sm:min-w-[100px] sm:pt-1.5 sm:pl-3" : "sm:w-[140px] sm:pt-[3px]",
          VERDICT_TONE[prior.state],
        )}
      >
        <span aria-hidden="true" className={cx(isAwaiting(prior.state) ? "font-normal" : "font-semibold", hero ? "text-[16px]" : "text-[14px]")}>
          {prior.mark}
        </span>
        <span className={cx("tracking-[1.3px] uppercase", isAwaiting(prior.state) ? "font-medium" : "font-semibold", hero ? "text-[12px]" : "text-[11px]")}>
          {prior.word}
        </span>
      </span>
    </div>
  );
}
