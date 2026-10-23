import type { BriefLimitation, ChangeRow } from "../../lib/brief";
import { cx } from "../ui";
import { BlockKicker } from "./evidence";
import { Prose } from "./prose";

/**
 * 04 Risks (A/Change header, A/Change row): "We would change our view if" from the bear case, each with
 * the number it rests on now, then the limitations code and the run recorded.
 */

const HEAD = "text-[10px] leading-4 font-semibold tracking-[1.1px] text-dim uppercase";

/** The NOW column: A/Change row's 90 px on phones, wider from 640 px for a number with words. */
const NOW_WIDTH = "w-[90px] sm:w-[120px]";

/** The longest number the NOW column sets on one line, even on phones ("0.13 · rank 6" is not). */
export const NOW_COLUMN_MAX = 12;

/**
 * Where a condition's number prints: in the NOW column, or for a number in words ("last in 4 of 5 rows")
 * on its own line under the condition, where it never breaks into a narrow stack.
 */
export function nowPlacement(change: Pick<ChangeRow, "now">): "column" | "below" | null {
  if (!change.now) return null;
  return change.now.metric.text.length > NOW_COLUMN_MAX ? "below" : "column";
}

/** The trigger column shows only once a condition carries a trigger; the contracts carry none yet. */
export const hasTriggers = (changes: readonly ChangeRow[]) => changes.some((c) => c.trigger !== null);

/** A/Change header: the column heads over a strong hairline, the numbers' columns set right. */
export function ChangeHeader({ triggers }: { triggers: boolean }) {
  return (
    <div className="mt-4 flex min-h-[26px] w-full items-center gap-4 border-b border-line-strong py-1 pl-10" aria-hidden="true">
      <span className={cx(HEAD, "flex-1")}>We would change our view if</span>
      <span className={cx(HEAD, NOW_WIDTH, "text-right")}>Now</span>
      {triggers ? <span className={cx(HEAD, "w-[100px] text-right")}>Trigger</span> : null}
    </div>
  );
}

/** A/Change row: the condition, then the number it rests on now (and its trigger), set right. */
export function ChangeItem({ change, triggers }: { change: ChangeRow; triggers: boolean }) {
  const placement = nowPlacement(change);
  const now = change.now ? <Prose inlines={[{ kind: "metric", metric: change.now.metric, footnote: change.now.footnote }]} /> : null;
  return (
    <div className="flex w-full flex-wrap items-start gap-x-4 gap-y-1 border-b border-line py-[11px]" data-change={change.n}>
      <span className="w-6 shrink-0 font-serif text-[16px] leading-[21px] font-semibold text-ink">{change.n}</span>
      <p className="m-0 min-w-0 flex-1 text-[14px] leading-[21px] text-ink">
        <span className="sr-only">We would change our view if </span>
        <Prose inlines={change.condition} />
      </p>
      {placement === "below" ? (
        // Read right after the condition; drawn last, on a line of its own under it, across the NOW column.
        <p className="order-last m-0 basis-full pl-10 text-[14px] leading-[21px] font-semibold text-ink" data-now="below">
          <span className={cx(HEAD, "mr-2")}>
            Now<span className="sr-only">:</span>
          </span>
          {now}
        </p>
      ) : null}
      <p className={cx("m-0 shrink-0 text-right text-[14px] leading-[21px] font-semibold text-ink", NOW_WIDTH)} aria-hidden={placement === "below" || undefined}>
        {placement === "below" ? null : (
          <>
            <span className="sr-only">Now: </span>
            {now ?? <span className="font-normal text-dim">–</span>}
          </>
        )}
      </p>
      {triggers ? (
        <p className="m-0 w-[100px] shrink-0 text-right text-[14px] leading-[21px] font-medium text-text-2">
          <span className="sr-only">Trigger: </span>
          {change.trigger ?? "–"}
        </p>
      ) : null}
    </div>
  );
}

/** The report's open questions travel with its limitations; the brief prints them apart. */
export const isOpenQuestion = (l: BriefLimitation) => l.source === "open_question";

/** Limitations code and the run recorded, then the open questions the brief leaves. */
export function Limitations({ items }: { items: readonly BriefLimitation[] }) {
  const limits = items.filter((l) => !isOpenQuestion(l));
  const open = items.filter(isOpenQuestion);
  if (items.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-7">
      {limits.length > 0 ? (
        <div className="flex w-full flex-col">
          <BlockKicker title="Limitations" note={limits.length === 1 ? "1 recorded" : `${limits.length} recorded`} />
          <ul className="m-0 list-none p-0">
            {limits.map((l, i) => (
              <li key={i} className="flex flex-col gap-0.5 border-b border-line py-2.5 sm:flex-row sm:items-baseline sm:gap-4" data-limitation={l.flag ?? l.source}>
                <span className="min-w-0 flex-1 text-[13px] leading-[19px] text-text-2">{l.text}</span>
                {l.flagLabel ? <span className="shrink-0 font-mono text-[10.5px] text-dim">{l.flagLabel}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {open.length > 0 ? (
        <div className="flex w-full flex-col">
          <BlockKicker title={open.length === 1 ? "Open question" : "Open questions"} note="what this brief cannot settle yet" />
          <ul className="m-0 list-none p-0">
            {open.map((l, i) => (
              <li key={i} className="border-b border-line py-2.5 text-[13px] leading-[19px] text-text-2" data-open-question="true">
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "3 conditions · 8 limitations · 1 open question": the Risks section's aside. */
export function risksAside(changes: number, limitations: readonly BriefLimitation[]): string {
  const open = limitations.filter(isOpenQuestion).length;
  const limits = limitations.length - open;
  return [
    changes > 0 ? `${changes} ${changes === 1 ? "condition" : "conditions"}` : null,
    limits > 0 ? `${limits} ${limits === 1 ? "limitation" : "limitations"}` : null,
    open > 0 ? `${open} open ${open === 1 ? "question" : "questions"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
