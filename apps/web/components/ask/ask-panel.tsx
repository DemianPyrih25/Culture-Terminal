import Link from "next/link";
import type { ReactNode } from "react";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { ArrowRightIcon } from "../ui/icons";
import { Keycap } from "../ui/keycap";
import { keycapForPlatform, useApplePlatform } from "../ui/mod-key";
import { MiniMeter } from "../ui/mini-meter";
import { JOB_LABEL, SAFETY_LABEL, SIGNAL_LABEL } from "../../lib/brief/format";
import type { CompiledCommand } from "../../lib/grammar/parse";
// Types only: the server's follow-up rule (RunManager.parentContext), read where the page renders.
import type { FollowUpBlock } from "../../server/run-list";
import { briefLabel } from "../library/format";
import {
  ageText,
  alreadyHaveOfPhase,
  cacheLine,
  canRun,
  compiledMnemonic,
  estimateLine,
  matchProblems,
  messageParts,
  quotaText,
  readingGap,
  subjectsText,
  waitText,
  type AlreadyHave,
  type AskState,
  type PreviewResponse,
  type ReadingGap,
} from "./ask-machine";

/** The brief a follow-up hangs from (PLAN §7.3), as the Ask page read it from the database. */
export interface AskParent {
  runId: string;
  /** The parent's question; null when the run could not be read. */
  question: string | null;
  /**
   * Why POST /api/runs would refuse it as the parent ("unreadable" when it could not be read): the
   * question then runs on its own. Null when the new brief follows up on it.
   */
  blocked: FollowUpBlock | "unreadable" | null;
}

/** Whether a run started here names the parent: only when the server will take it. */
export function followsUp(parent: AskParent | null): boolean {
  return parent !== null && parent.blocked === null;
}

export interface AskPanelProps {
  state: AskState;
  /** The question in the field, trimmed: when it is not the one previewed, the panel waits for Enter. */
  draft: string;
  /** The command the draft spells, compiled in the browser (lib/grammar). */
  compiled: CompiledCommand | null;
  parent?: AskParent | null;
  /** Edit: back to the field. */
  onEdit?: () => void;
  onRun?: () => void;
  onRetry?: () => void;
  /** Asks another question: a refusal's reframe. */
  onAsk?: (question: string) => void;
  /** Drops the follow-up: the question is asked on its own. */
  onDropParent?: () => void;
  /** The reading waits for the human check under the composer, which needs the visitor. */
  waitingForCheck?: boolean;
  className?: string;
}

/** The field holds a question that has not been read yet: Enter reads it. */
function isPending(state: AskState, draft: string): boolean {
  return draft !== "" && draft !== (state.phase.kind === "idle" ? null : state.phase.question);
}

/** Whether the panel hangs under the field: a question in hand, or a follow-up's parent. */
export function askPanelShown(state: AskState, draft: string, parent: AskParent | null): boolean {
  return isPending(state, draft) || state.phase.kind !== "idle" || parent !== null;
}

/** Marks the panel's controls for ↑ ↓ (the Ask page moves focus among them and the field). */
export const ASK_NAV = { "data-ask-nav": "" } as const;

const LABEL = "text-[10px] leading-3 font-semibold tracking-[1.1px] text-dim uppercase";
const DETAIL = "text-[12px] leading-[17px] text-dim";
const LINK = "font-medium text-accent hover:underline hover:underline-offset-4";

function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

/** One row of the panel: a 120 px label cell, the content, and an optional right cell. */
function PanelRow({ label, children, aside, tone }: { label: string; children: ReactNode; aside?: ReactNode; tone?: "negative" }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2 border-t border-line px-5 py-4 first:border-t-0 sm:flex-row sm:items-start sm:gap-4"
    >
      <h2 className={cx("w-[120px] shrink-0 pt-[3px]", LABEL, tone === "negative" && "text-negative")}>{label}</h2>
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">{children}</div>
      {aside ? <div className="flex shrink-0 flex-col items-start gap-[2px] sm:items-end">{aside}</div> : null}
    </section>
  );
}

function Skeleton({ className }: { className: string }) {
  return <span aria-hidden="true" className={cx("block rounded-brief bg-canvas motion-safe:animate-pulse", className)} />;
}

/** "Real competitors · Juniper Cola": what a compiled command asks, before the preview confirms it. */
export function compiledReading(command: CompiledCommand): string {
  const subject =
    command.names.map((n) => n.text).join(", ") ||
    (command.concept && command.city ? `${command.concept} in ${command.city}` : [command.area, command.city].filter(Boolean).join(", "));
  return subject ? `${JOB_LABEL[command.job]} · ${subject}` : JOB_LABEL[command.job];
}

/**
 * What the live region says for the panel: announced politely as the reading arrives, and while it
 * waits for the human check, whose checkbox sits in Cloudflare's frame below the question.
 */
export function askStatusText(state: AskState, draft: string, waitingForCheck = false): string {
  const { phase, run } = state;
  if (run.kind === "starting") return run.message ?? "Starting the brief…";
  if (run.kind === "failed") return run.message;
  if (phase.kind === "idle" || isPending(state, draft)) return "";
  switch (phase.kind) {
    case "loading":
      return waitingForCheck ? "Waiting for the human check below the question." : "Reading the question…";
    case "ready": {
      const { refusal, understood, estimate } = phase.preview;
      if (refusal) return "This question cannot be answered as asked.";
      const gap = understood ? readingGap(understood) : null;
      const then = gap ? `Still needed: ${gap.need.charAt(0).toLowerCase()}${gap.need.slice(1)}.` : `${estimateLine(estimate)}.`;
      return `Understood as ${understood?.jobLabel ?? "a brief"}. ${then}`;
    }
    case "paused":
    case "limited":
    case "error":
      return phase.message;
  }
}

function CompiledLine({ mnemonic, pending }: { mnemonic: string; pending: boolean }) {
  return (
    <p className="font-mono text-[10.5px] leading-[15px] text-dim">
      Compiled to <span className="text-text-2">{mnemonic}</span>
      {pending ? " · confirming" : null}
    </p>
  );
}

function Understood({ preview, onEdit }: { preview: PreviewResponse; onEdit?: () => void }) {
  const understood = preview.understood;
  if (understood === null) return null;
  const subjects = subjectsText(understood);
  const problems = matchProblems(understood);
  // Never a placeholder such as "VS <B>": a reading that lacks a part compiles to nothing yet.
  const mnemonic = compiledMnemonic(understood);
  // The metros the question names, unless the scope already says them ("Austin neighbourhoods").
  const metros = understood.metros.filter((m) => !understood.scope.includes(m)).join(", ");
  return (
    <PanelRow
      label="Understood as"
      aside={
        onEdit ? (
          <button type="button" onClick={onEdit} {...ASK_NAV} className={cx("h-5 text-[13px]", LINK)}>
            Edit
          </button>
        ) : null
      }
    >
      <p className="flex flex-wrap items-center gap-x-2 text-[15px] leading-[18px] text-ink">
        <span className="font-medium">{understood.jobLabel}</span>
        {subjects !== "" ? (
          <>
            <Dot />
            <span>{subjects}</span>
          </>
        ) : null}
        <Dot />
        <span>{understood.scope}</span>
        {metros !== "" ? (
          <>
            <Dot />
            <span>{metros}</span>
          </>
        ) : null}
      </p>
      <p className={DETAIL}>{understood.lens}</p>
      {problems.length > 0 ? (
        <ul className="flex flex-col text-[12px] leading-[17px] text-negative">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {mnemonic !== null ? <CompiledLine mnemonic={mnemonic} pending={false} /> : null}
    </PanelRow>
  );
}

/** A reading that lacks a part: what to add, in place of the estimate. */
function GapRow({ gap }: { gap: ReadingGap }) {
  return (
    <PanelRow label="Still needed">
      <p className="text-[15px] leading-[18px] font-medium text-ink">{gap.need}</p>
      <p className={DETAIL}>{gap.hint}</p>
    </PanelRow>
  );
}

function AlreadyHaveRow({ have, at }: { have: AlreadyHave; at: number }) {
  const label = briefLabel(have.runId);
  const age = ageText(have.createdAt, at);
  return (
    <PanelRow
      label="You already have"
      aside={
        <>
          <Link href={`/run/${have.runId}`} {...ASK_NAV} className={cx("inline-flex h-5 items-center gap-[6px] text-[13px]", LINK)}>
            Open {label}
            <ArrowRightIcon />
          </Link>
          <span className="text-[11px] text-dim">Same snapshot · instant · $0</span>
        </>
      }
    >
      <p className="font-serif text-[16px] leading-[21px] text-ink sm:truncate">{have.question}</p>
      <p className="flex flex-wrap items-center gap-x-2 text-[12px] leading-[14px] text-dim">
        <span>{label}</span>
        {age ? (
          <>
            <Dot />
            <span>{age}</span>
          </>
        ) : null}
        {have.signal !== null ? (
          <>
            <Dot />
            <span className="font-medium text-ink">{SIGNAL_LABEL[have.signal]}</span>
          </>
        ) : null}
        {have.confidence !== null ? (
          <span className="inline-flex items-center gap-2">
            <MiniMeter value={have.confidence.score} label="Conviction" width={36} markerHeight={0} />
            <span aria-hidden="true" className="font-medium text-ink">
              {have.confidence.score}
            </span>
          </span>
        ) : null}
      </p>
    </PanelRow>
  );
}

function EstimateRow({ estimate }: { estimate: PreviewResponse["estimate"] }) {
  return (
    <PanelRow label="Estimated" aside={<span className="text-[12px] text-dim">{quotaText(estimate.quotaShare)}</span>}>
      <p className="text-[15px] leading-[18px] font-medium text-ink">{estimateLine(estimate)}</p>
      <p className={DETAIL}>{cacheLine(estimate)}</p>
    </PanelRow>
  );
}

/** The economy step of the mode machine: the brief runs on the economy ANALYST, and says why. */
function AnalystRow({ note }: { note: string | null }) {
  return (
    <PanelRow label="Analyst">
      <p className="text-[15px] leading-[18px] font-medium text-ink">Economy analyst · Claude Haiku</p>
      <p className={DETAIL}>{economyDetail(note)}</p>
    </PanelRow>
  );
}

/** What a parent the server would refuse says, after its brief label. */
const BLOCKED_TEXT: Record<NonNullable<AskParent["blocked"]>, string> = {
  running: "is still being written",
  test_run: "is a test run",
  no_note: "has no finished note",
  unreadable: "could not be read",
};

function ParentRow({ parent, onDropParent }: { parent: AskParent; onDropParent?: () => void }) {
  const label = briefLabel(parent.runId);
  const heading = parent.blocked === null ? "Following up on" : "Asked from";
  return (
    <PanelRow
      label={heading}
      aside={
        parent.blocked === null && onDropParent ? (
          <button type="button" onClick={onDropParent} {...ASK_NAV} className={cx("h-5 text-[13px]", LINK)}>
            Ask on its own
          </button>
        ) : null
      }
    >
      <p className="font-serif text-[16px] leading-[21px] text-ink">
        <span className="sr-only">{heading}: </span>
        {parent.question ?? label}
      </p>
      <p className={DETAIL}>
        <Link href={`/run/${parent.runId}`} className="hover:text-ink hover:underline hover:underline-offset-4">
          {label}
        </Link>
        {parent.blocked === null ? " · the new brief can reuse its data" : ` ${BLOCKED_TEXT[parent.blocked]}: this question runs on its own.`}
      </p>
    </PanelRow>
  );
}

/** "Showcases and replays still work.", unless the server's message says so already. */
export function pausedExtra(message: string): string | null {
  return /replays/i.test(message) ? null : "Showcases and replays still work.";
}

/** The economy row's detail: why (the breaker's message), then what does not change. */
export function economyDetail(note: string | null): string {
  const why = note?.trim() || "Today's live budget is nearly used.";
  return `${why} Every number is still traced to its request; showcases and replays are unchanged.`;
}

/** A service message as one heading and one detail line, never the same words twice. */
function ServiceMessage({ message, extra = null }: { message: string; extra?: string | null }) {
  const { head, rest } = messageParts(message);
  const detail = [rest, extra].filter((part): part is string => Boolean(part)).join(" ");
  return (
    <>
      <p className="text-[15px] leading-[18px] font-medium text-ink">{head}</p>
      {detail !== "" ? <p className={DETAIL}>{detail}</p> : null}
    </>
  );
}

function Hint({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-dim">
      {keys.map((k) => (
        <Keycap key={k}>{k}</Keycap>
      ))}
      <span>{children}</span>
    </span>
  );
}

/**
 * The composing panel of A02, hung under the question field: UNDERSTOOD AS, YOU ALREADY HAVE and
 * ESTIMATED from the preview (and ANALYST when the economy breaker has tripped), then the footer with
 * the keys and "Run brief". It also shows the
 * loading skeleton, a reading that lacks a part (STILL NEEDED, no Run button), a refusal with its
 * reframe (no Run button), a paused or capped service, an error with Try again, and a follow-up's
 * parent. Presentational: AskView owns the state and the requests.
 */
export function AskPanel({
  state,
  draft,
  compiled,
  parent = null,
  onEdit,
  onRun,
  onRetry,
  onAsk,
  onDropParent,
  waitingForCheck = false,
  className,
}: AskPanelProps) {
  const apple = useApplePlatform();
  const { phase, run } = state;
  const pending = isPending(state, draft);
  if (!askPanelShown(state, draft, parent)) return null;

  const rows: ReactNode[] = [];
  // Controls marked ASK_NAV: ↑ ↓ is offered only when there is somewhere to move to from the field.
  let nav = 0;
  let footer: ReactNode = null;
  const have = pending ? null : alreadyHaveOfPhase(phase);
  const haveAt = phase.kind === "ready" || phase.kind === "paused" || phase.kind === "limited" ? phase.at : 0;
  const runnable = !pending && canRun(state);

  if (pending) {
    rows.push(
      <PanelRow key="pending" label="New question">
        <p className={cx("text-[15px] leading-[18px] text-ink", compiled && "font-medium")}>
          {compiled ? compiledReading(compiled) : "Press ↵ to see how it is understood"}
        </p>
        {compiled ? <CompiledLine mnemonic={compiled.mnemonic} pending={false} /> : null}
        <p className={DETAIL}>Nothing runs until you choose Run brief.</p>
      </PanelRow>,
    );
  } else if (phase.kind === "loading") {
    rows.push(
      <PanelRow key="understood" label="Understood as">
        {compiled ? (
          <p className="text-[15px] leading-[18px] font-medium text-ink">{compiledReading(compiled)}</p>
        ) : (
          <Skeleton className="mt-[3px] h-[14px] w-[320px] max-w-full" />
        )}
        <p className={DETAIL}>{waitingForCheck ? "Waiting for the human check below…" : "Reading the question and matching its names…"}</p>
        {compiled ? <CompiledLine mnemonic={compiled.mnemonic} pending /> : null}
      </PanelRow>,
      <PanelRow key="estimate" label="Estimated">
        <Skeleton className="mt-[3px] h-[14px] w-[180px]" />
        <Skeleton className="mt-[6px] h-[10px] w-[260px] max-w-full" />
      </PanelRow>,
    );
  } else if (phase.kind === "ready") {
    const { preview } = phase;
    if (preview.understood !== null && onEdit) nav++;
    rows.push(<Understood key="understood" preview={preview} onEdit={onEdit} />);
    if (preview.refusal) {
      const { refusal } = preview;
      if (refusal.reframe) nav++;
      rows.push(
        <PanelRow key="refusal" label="Can't answer" tone="negative">
          <p className="text-[15px] leading-[18px] font-medium text-ink">
            {refusal.category ? SAFETY_LABEL[refusal.category] : "Declined"}
          </p>
          <p className={DETAIL}>{refusal.reason}</p>
          {refusal.reframe ? (
            <p className="text-[13px] leading-5 text-text-2">
              Try instead:{" "}
              <button type="button" onClick={() => onAsk?.(refusal.reframe ?? "")} {...ASK_NAV} className={cx("text-left", LINK)}>
                {refusal.reframe}
              </button>
            </p>
          ) : (
            <p className={DETAIL}>Edit the question and press ↵ to read it again.</p>
          )}
        </PanelRow>,
      );
    } else {
      if (preview.alreadyHave) {
        nav++;
        rows.push(<AlreadyHaveRow key="have" have={preview.alreadyHave} at={phase.at} />);
      }
      const gap = preview.understood !== null ? readingGap(preview.understood) : null;
      rows.push(gap ? <GapRow key="gap" gap={gap} /> : <EstimateRow key="estimate" estimate={preview.estimate} />);
      if (!gap && preview.mode === "economy") rows.push(<AnalystRow key="analyst" note={preview.modeNote} />);
    }
  } else if (phase.kind === "paused") {
    // 503: nothing runs; the footer opens the brief it already has, or the stored briefs.
    rows.push(
      <PanelRow key="service" label="Live analysis">
        <ServiceMessage message={phase.message} extra={pausedExtra(phase.message)} />
        {compiled ? <CompiledLine mnemonic={compiled.mnemonic} pending={false} /> : null}
      </PanelRow>,
    );
    if (have) {
      nav++;
      rows.push(<AlreadyHaveRow key="have" have={have} at={haveAt} />);
    }
  } else if (phase.kind === "limited") {
    // 429: previews wait, a run still goes ahead.
    nav++;
    const wait = phase.retryAfterS !== null ? `Previews resume in ${waitText(phase.retryAfterS)}.` : null;
    rows.push(
      <PanelRow key="service" label="Preview">
        <ServiceMessage message={phase.message} extra={wait} />
        {compiled ? <CompiledLine mnemonic={compiled.mnemonic} pending={false} /> : null}
        <p className={DETAIL}>
          Showcases and replays still work:{" "}
          <Link href="/briefs" {...ASK_NAV} className={LINK}>
            browse the briefs
          </Link>
          .
        </p>
      </PanelRow>,
    );
    if (have) {
      nav++;
      rows.push(<AlreadyHaveRow key="have" have={have} at={haveAt} />);
    }
  } else if (phase.kind === "error") {
    const retry = phase.retry && onRetry;
    if (retry) nav++;
    rows.push(
      <PanelRow
        key="error"
        label="Not read"
        tone="negative"
        aside={
          retry ? (
            <Button size="sm" onClick={onRetry} {...ASK_NAV}>
              Try again
            </Button>
          ) : null
        }
      >
        <ServiceMessage message={phase.message} />
        {compiled ? <CompiledLine mnemonic={compiled.mnemonic} pending={false} /> : null}
      </PanelRow>,
    );
  }

  if (parent !== null) {
    if (parent.blocked === null && onDropParent) nav++;
    // After the reading (A02 puts it first), so ⇥ from the field reaches the reading's Edit first.
    rows.splice(Math.min(1, rows.length), 0, <ParentRow key="parent" parent={parent} onDropParent={onDropParent} />);
  }

  if (pending) {
    footer = <Hint keys={["↵"]}>read the question</Hint>;
  } else if (runnable || run.kind === "starting") {
    nav++;
    footer = (
      <Button
        variant="primary"
        size="sm"
        onClick={onRun}
        disabled={run.kind === "starting"}
        aria-busy={run.kind === "starting"}
        {...ASK_NAV}
      >
        {run.kind === "starting" ? "Starting…" : "Run brief"}
      </Button>
    );
  } else if (phase.kind === "paused") {
    nav++;
    footer = have ? (
      <ButtonLink variant="primary" size="sm" href={`/run/${have.runId}`} hint={keycapForPlatform("⌘↵", apple)} {...ASK_NAV}>
        Open {briefLabel(have.runId)}
      </ButtonLink>
    ) : (
      <ButtonLink variant="secondary" size="sm" href="/briefs" hint={null} {...ASK_NAV}>
        Browse the briefs
      </ButtonLink>
    );
  }

  const hints: ReactNode[] = [];
  if (nav > 0) {
    hints.push(
      <Hint key="move" keys={["↑", "↓"]}>
        move
      </Hint>,
    );
  }
  // ⇥ from the field reaches the reading's Edit, when there is a reading.
  if (!pending && phase.kind === "ready" && phase.preview.understood !== null && onEdit) {
    hints.push(
      <Hint key="edit" keys={["⇥"]}>
        edit reading
      </Hint>,
    );
  }
  if (have) {
    hints.push(
      <Hint key="open" keys={[keycapForPlatform("⌘↵", apple)]}>
        open {briefLabel(have.runId)}
      </Hint>,
    );
  }

  // Why the run did not start, or the server's word while the start waits and tries again by itself.
  const runNote =
    run.kind === "failed" ? (
      <p role="alert" className="text-[12px] leading-4 text-negative">
        {run.message}
      </p>
    ) : run.kind === "starting" && run.message !== null ? (
      <p className="text-[12px] leading-4 text-dim">{run.message}</p>
    ) : null;

  return (
    <div
      className={cx("rounded-b-brief border border-t-0 border-line-strong bg-paper", className)}
      aria-busy={phase.kind === "loading" && !pending}
    >
      {rows}
      {rows.length > 0 ? (
        <div
          className={cx(
            "flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-canvas py-[10px] pr-3 pl-5",
            // Phones hide the key hints: a footer with nothing else in it is not drawn there.
            footer === null && runNote === null && "max-sm:hidden",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 max-sm:hidden">{hints}</div>
          <div className="ml-auto flex items-center gap-3">
            {runNote}
            {footer}
          </div>
        </div>
      ) : null}
    </div>
  );
}
