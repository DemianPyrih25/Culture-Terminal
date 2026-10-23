import Link from "next/link";
import { askHref } from "../ask/ask-href";
import { cx } from "../ui/cx";
import { DESK_LABEL } from "../../lib/brief/format";
import { STARTER_DESKS, type StarterDesk } from "./starters";

export interface StarterColumnsProps {
  desks?: readonly StarterDesk[];
  /** Stored showcase briefs by starter question: such a starter opens its brief (same snapshot, $0). */
  stored?: Readonly<Record<string, string>>;
  className?: string;
}

/**
 * A/Starter: four desk columns under the question field, INVESTMENT · LOCATION · MARKETING · AUDIENCE,
 * each a hairline and a few questions. A starter whose question has a stored showcase brief opens it;
 * any other opens the Ask page with its full question, so it is read and estimated before anything runs.
 */
export function StarterColumns({ desks = STARTER_DESKS, stored = {}, className }: StarterColumnsProps) {
  return (
    <div className={cx("grid w-full grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {desks.map((desk) => {
        const headingId = `starters-${desk.pillar}`;
        return (
          <section key={desk.pillar} aria-labelledby={headingId} className="flex flex-col gap-3 border-t border-line-strong pt-[11px]">
            <h2 id={headingId} className="text-[11px] leading-[13px] font-semibold tracking-[1.3px] text-ink uppercase">
              {DESK_LABEL[desk.pillar]}
            </h2>
            <ul className="flex flex-col gap-[10px] text-[14px] leading-5">
              {desk.starters.map((starter) => {
                const runId = Object.hasOwn(stored, starter.question) ? stored[starter.question] : undefined;
                return (
                  <li key={starter.question}>
                    <Link
                      href={runId ? `/run/${runId}` : askHref(starter.question)}
                      title={starter.question}
                      className="text-text-2 hover:text-ink"
                    >
                      {starter.label}
                      {runId ? <span className="sr-only"> (stored brief)</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
