import {
  Badge,
  CONFIDENCE_PENALTY,
  ConfidenceRule,
  GHOST_HONESTY_LINE,
  type Job,
  JOBS_BY_PILLAR,
  type Pillar,
  ScorecardVerdict,
  type SkillId,
  TOOL_MNEMONIC,
  ValidationRule,
} from "@ct/contracts";
import { BADGE_WEIGHT, CONFIDENCE_RULE_LABEL, CONFIDENCE_START, FORMULA_IDS, FORMULAS, type FormulaId } from "@ct/quant";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  analystTurns,
  BADGE_MEANING,
  CHECKER_INTRO,
  CHECKER_NOTE,
  checkerRules,
  CONFIDENCE_ONCE,
  CONVICTION_COPY,
  EVAL_COPY,
  FORMULA_GROUPS,
  FORMULA_META,
  FORMULAS_COPY,
  type FormulaGroup,
  MARKS_COPY,
  METHOD_PAGE,
  METHOD_SECTION_ORDER,
  METHOD_SECTIONS,
  METHOD_SOURCES,
  type MethodFacts,
  type MethodSectionId,
  methodSteps,
  REFUSE_NOTE,
  refusalSummary,
  SCAN_COPY,
  type StepCopy,
  TURNS_HEADING,
  VERDICT_MEANING,
} from "../../content/method";
import { BADGE_LABEL, CONVICTION_BAND_LABEL, DESK_LABEL, formatUtcDate, JOB_LABEL, TOOL_LABEL } from "../../lib/brief/format";
import { BriefRow } from "../layout/brief-row";
import { Outline } from "../layout/outline";
import { cx } from "../ui/cx";
import { Delta } from "../ui/delta";
import { ArrowRightIcon, CheckIcon, CrossIcon, DashIcon } from "../ui/icons";
import { NoSignal } from "../ui/no-signal";
import { SectionHead } from "../ui/section-head";
import { formatEvalValue, type EvalState, type EvalSummary } from "./eval-summary";
import { bandRanges, modelLabel, penaltyText } from "./facts";
import {
  Colophon,
  NoteRef,
  REFERENCE_ANCHOR,
  REFERENCE_STICKY_TOP,
  ReferenceGrid,
  ReferenceHead,
  SECTION_CLASS,
  SideNote,
  SideNotes,
  SMALL_CAPS,
  TraceNote,
} from "./reference";
import { TexFormula } from "./tex";

/**
 * /method (A11 · Method & sources): how a brief is made, the evidence marks, the checker rules, the
 * conviction penalties, every formula in @ct/quant FORMULAS (each at /method#<formula id>), the
 * evaluation and what is refused. Generated from the code; the copy lives in content/method.ts.
 */

export interface MethodViewProps {
  facts: MethodFacts;
  /** The opening scan per job (SCAN_TABLE in @ct/agent): the skills code runs before the analyst sees data. */
  scan: Readonly<Record<Job, readonly SkillId[]>>;
  /** The Qloo endpoints the client allows, as words: "Search", "Insights". */
  endpoints: readonly string[];
  /** The trending window, e.g. "Apr–Sep 2025". */
  trendWindow: string;
  evaluation: EvalState;
}

const BODY = "m-0 text-[13px] leading-5 text-text-2";
const SUBHEAD = "m-0 text-[11px] leading-[14px] font-semibold tracking-[1.3px] text-dim uppercase";
const LIST = "m-0 flex list-none flex-col p-0";

/** Sidenote numbers in reading order: the steps' notes first, then one per section. */
function noteNumbers(steps: readonly StepCopy[]) {
  const byStep = new Map<number, number>();
  steps.forEach((step, i) => {
    if (step.note) byStep.set(i, byStep.size + 1);
  });
  const n = byStep.size;
  return { byStep, checker: n + 1, conviction: n + 2, formulas: n + 3, eval: n + 4, refuse: n + 5 };
}
type NoteNumbers = ReturnType<typeof noteNumbers>;

function Section({ id, n, children }: { id: MethodSectionId; n: number; children: ReactNode }) {
  const s = METHOD_SECTIONS[id];
  return (
    <section id={id} className={SECTION_CLASS} data-section={id}>
      <SectionHead number={n} title={s.title} aside={s.aside} />
      {children}
    </section>
  );
}

// 01 ------------------------------------------------------------------------------------------------------

/** The jobs whose opening scan runs each skill, in desk order. */
function scanJobs(scan: MethodViewProps["scan"]): Map<SkillId, Job[]> {
  const out = new Map<SkillId, Job[]>();
  for (const jobs of Object.values(JOBS_BY_PILLAR)) {
    for (const job of jobs) for (const skill of scan[job] ?? []) out.set(skill, [...(out.get(skill) ?? []), job]);
  }
  return out;
}

function Steps({ facts, scan, steps, notes }: Pick<MethodViewProps, "facts" | "scan"> & { steps: readonly StepCopy[]; notes: NoteNumbers }) {
  return (
    <div className="flex flex-col gap-6">
      <ol className={LIST} data-steps={steps.length}>
        {steps.map((step, i) => (
          <li
            key={step.name}
            className="grid grid-cols-[28px_minmax(0,1fr)] gap-y-0.5 border-b border-line py-[5px] last:border-b-0 sm:grid-cols-[28px_102px_minmax(0,1fr)_128px] sm:items-baseline sm:border-b-0 sm:py-[2px]"
          >
            <span className="font-serif text-[15px] leading-5 text-faint">{i + 1}</span>
            <span className="text-[13px] leading-5 font-medium text-ink">{step.name}</span>
            <span className={cx(BODY, "col-start-2 sm:col-start-auto")}>
              {step.text}
              {notes.byStep.has(i) ? <NoteRef n={notes.byStep.get(i)!} /> : null}
            </span>
            <span className={cx(SMALL_CAPS, "col-start-2 text-dim sm:col-start-auto sm:text-right")}>{step.who}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{SCAN_COPY.heading}</h3>
        <p className={BODY}>{SCAN_COPY.text}</p>
        <table className="w-full border-collapse text-[13px] leading-5" data-scan="true">
          <caption className="sr-only">{SCAN_COPY.caption}</caption>
          <tbody>
            {(Object.keys(JOBS_BY_PILLAR) as Pillar[]).flatMap((pillar) =>
              JOBS_BY_PILLAR[pillar].map((job) => (
                <tr key={job} className="border-t border-line align-baseline" data-job={job}>
                  <td className="w-[104px] py-1.5 pr-3 text-[11px] font-semibold tracking-[1.3px] text-accent uppercase max-sm:hidden">
                    {DESK_LABEL[pillar]}
                  </td>
                  <th scope="row" className="w-[176px] py-1.5 pr-3 text-left font-normal text-ink max-sm:w-[46%]">
                    <span className="block text-[10px] font-semibold tracking-[1.2px] text-accent uppercase sm:hidden">{DESK_LABEL[pillar]}</span>
                    {JOB_LABEL[job]}
                  </th>
                  <td className="py-1.5 text-text-2">{(scan[job] ?? []).map((skill) => TOOL_LABEL[skill]).join(" · ")}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{TURNS_HEADING}</h3>
        <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2">
          {analystTurns(facts).map((turn) => (
            <div key={turn.label} className="contents">
              <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{turn.label}</dt>
              <dd className={BODY}>{turn.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// 02 ------------------------------------------------------------------------------------------------------

function MarkRow({ mark, meaning }: { mark: ReactNode; meaning: string }) {
  return (
    <li className="grid grid-cols-[124px_minmax(0,1fr)] items-center gap-3 py-[3px]">
      <span className="flex min-w-0 items-center gap-1.5">{mark}</span>
      <span className="text-[13px] leading-5 text-text-2">{meaning}</span>
    </li>
  );
}

const VERDICT_MARK: Readonly<Record<ScorecardVerdict, { icon: ReactNode; tone: string }>> = {
  CONFIRMED: { icon: <CheckIcon size={12} className="shrink-0 text-accent" />, tone: "text-accent" },
  REFUTED: { icon: <CrossIcon size={12} className="shrink-0 text-negative" />, tone: "text-negative" },
  INCONCLUSIVE: { icon: <DashIcon size={12} className="shrink-0 text-faint" />, tone: "text-dim" },
};

function Marks() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <h3 className={SUBHEAD}>{MARKS_COPY.claimsHeading}</h3>
          <ul className={LIST}>
            <MarkRow
              mark={
                <span className="font-serif text-[15px] text-ink tabular-nums">
                  0.40<sup className="ml-px text-[9px] font-semibold text-accent">3</sup>
                </span>
              }
              meaning={MARKS_COPY.traced}
            />
            {ScorecardVerdict.options.map((v) => (
              <MarkRow
                key={v}
                mark={
                  <>
                    {VERDICT_MARK[v].icon}
                    <span className={cx("text-[11px] font-semibold tracking-[1.3px]", VERDICT_MARK[v].tone)}>{v}</span>
                  </>
                }
                meaning={VERDICT_MEANING[v]}
              />
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className={SUBHEAD}>{MARKS_COPY.dataHeading}</h3>
          <ul className={LIST}>
            <MarkRow mark={<Delta value={0.2} comparator={MARKS_COPY.samples.comparator} />} meaning={MARKS_COPY.delta} />
            <MarkRow mark={<span className="type-trace text-dim">{MARKS_COPY.samples.cached}</span>} meaning={MARKS_COPY.cached} />
            <MarkRow mark={<NoSignal />} meaning={MARKS_COPY.noSignal} />
            <MarkRow
              mark={<span className="text-[10px] font-semibold tracking-[1px] text-dim uppercase">{MARKS_COPY.samples.fallback}</span>}
              meaning={MARKS_COPY.fallback(CONFIDENCE_PENALTY.code_fallback)}
            />
          </ul>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{MARKS_COPY.badgesHeading}</h3>
        <p className={BODY}>{MARKS_COPY.badgesIntro}</p>
        <table className="w-full border-collapse text-[13px] leading-5" data-badges="true">
          <caption className="sr-only">{MARKS_COPY.badgesCaption}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">{MARKS_COPY.badgeColumns.badge}</th>
              <th scope="col">{MARKS_COPY.badgeColumns.meaning}</th>
              <th scope="col">{MARKS_COPY.weightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {Badge.options.map((badge) => (
              <tr key={badge} className="border-t border-line align-baseline" data-badge={badge}>
                <th scope="row" className="w-[132px] py-1.5 pr-3 text-left font-normal">
                  <span className="block font-medium text-ink">{BADGE_LABEL[badge]}</span>
                  <span className="block font-mono text-[10.5px] leading-[15px] text-faint">{badge}</span>
                </th>
                <td className="py-1.5 pr-3 text-text-2">{BADGE_MEANING[badge]}</td>
                <td className="w-[96px] py-1.5 text-right whitespace-nowrap text-dim tabular-nums">
                  m = {badge === "STALE" ? MARKS_COPY.staleWeight : BADGE_WEIGHT[badge]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 03 ------------------------------------------------------------------------------------------------------

function Checker({ facts, note }: { facts: MethodFacts; note: number }) {
  const rules = checkerRules(facts);
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>
        {CHECKER_INTRO}
        <NoteRef n={note} />
      </p>
      <ol className={LIST}>
        {ValidationRule.options.map((rule) => (
          <li
            key={rule}
            id={`rule-${rule}`}
            className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-t border-line py-2 sm:grid-cols-[40px_minmax(0,1fr)_148px]"
            data-rule={rule}
          >
            <span className="font-mono text-[11px] leading-5 text-dim">{rule}</span>
            <span className="flex flex-col">
              <span className="text-[13px] leading-5 font-medium text-ink">{rules[rule].title}</span>
              <span className={BODY}>{rules[rule].text}</span>
            </span>
            <span className={cx(SMALL_CAPS, "col-start-2 pt-[3px] text-dim sm:col-start-auto sm:text-right")}>{rules[rule].action}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// 04 ------------------------------------------------------------------------------------------------------

function Conviction({ note }: { note: number }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>
        {CONVICTION_COPY.intro}
        <NoteRef n={note} />
      </p>
      <table className="w-full border-collapse text-[13px] leading-5" data-conviction="true">
        <caption className="sr-only">{CONVICTION_COPY.caption}</caption>
        <tbody>
          <tr className="border-t border-line-strong">
            <th scope="row" className="py-1.5 text-left font-medium text-ink">
              {CONVICTION_COPY.start}
            </th>
            <td className="py-1.5 text-right font-medium text-ink tabular-nums">{CONFIDENCE_START}</td>
          </tr>
          {ConfidenceRule.options.map((rule) => (
            <tr key={rule} className="border-t border-line align-baseline" data-penalty={rule}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-text-2">
                {CONFIDENCE_RULE_LABEL[rule]}
              </th>
              <td className="w-[120px] py-1.5 text-right whitespace-nowrap tabular-nums">
                <span className="text-ink">{penaltyText(rule)}</span>{" "}
                <span className="text-dim">{CONFIDENCE_ONCE.has(rule) ? CONVICTION_COPY.once : CONVICTION_COPY.each}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-5" data-bands="true">
        <span className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{CONVICTION_COPY.bandsHeading}</span>
        {bandRanges().map((r) => (
          <span key={r.band}>
            <span className="font-medium text-ink">{CONVICTION_BAND_LABEL[r.band]}</span>{" "}
            <span className="text-text-2 tabular-nums">
              {r.min}–{r.max}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
}

// 05 ------------------------------------------------------------------------------------------------------

function FormulaEntry({ id }: { id: FormulaId }) {
  const f = FORMULAS[id];
  const meta = FORMULA_META[id];
  return (
    <article id={id} className={cx("flex flex-col gap-3 border-b border-line py-5", REFERENCE_ANCHOR)} data-formula={id}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h4 className="m-0 text-[15px] leading-[22px] font-semibold text-ink">{f.name}</h4>
        <a href={`#${id}`} className="font-mono text-[11px] leading-4 text-dim hover:text-accent hover:underline" title={FORMULAS_COPY.anchor}>
          {id}
        </a>
      </header>
      <div className="overflow-x-auto rounded-brief bg-canvas px-4 py-2">
        <TexFormula tex={f.formula_tex} />
      </div>
      <p className="m-0 text-[14px] leading-[21px] text-text-2">{f.plain_english}</p>
      <dl className="m-0 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px] leading-5">
        <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{FORMULAS_COPY.inputs}</dt>
        <dd className="m-0">
          <ul className={cx(LIST, "gap-0.5 text-text-2")}>
            {meta.inputs.map((input) => (
              <li key={input}>{input}</li>
            ))}
          </ul>
        </dd>
        <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{FORMULAS_COPY.caveats}</dt>
        <dd className="m-0">
          <ul className={cx(LIST, "gap-0.5 text-dim")}>
            {f.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </dd>
        <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{FORMULAS_COPY.badge}</dt>
        <dd className="m-0" data-badge={meta.badge ?? "none"}>
          {meta.badge ? (
            <>
              <span className="font-medium text-ink">{BADGE_LABEL[meta.badge]}</span>{" "}
              <span className="font-mono text-[10.5px] text-faint">{meta.badge}</span>
            </>
          ) : (
            <span className="text-text-2">
              {FORMULAS_COPY.noBadge}
              {meta.noBadge ? `: ${meta.noBadge.charAt(0).toLowerCase()}${meta.noBadge.slice(1)}` : ""}
            </span>
          )}
        </dd>
      </dl>
    </article>
  );
}

function FormulaGroupView({ group, opens }: { group: FormulaGroup; opens: readonly Job[] }) {
  // A group's own line first: name matching runs at the gate on every brief, not from the scan table.
  const scanLine = opens.length > 0 ? `${FORMULAS_COPY.opens}: ${opens.map((job) => JOB_LABEL[job]).join(" · ")}` : SCAN_COPY.analystOnly;
  const where = group.where ?? (group.skill ? scanLine : (group.owner ?? null));
  return (
    <div className="flex flex-col pt-6" data-formula-group={group.id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-strong pb-2">
        <h3 className="m-0 font-serif text-[18px] leading-6 font-semibold text-ink">{group.title}</h3>
        {group.skill ? (
          <span className="font-mono text-[11px] text-dim">
            {TOOL_MNEMONIC[group.skill]} · {group.skill}
          </span>
        ) : null}
        {where ? <span className="text-[12px] leading-4 text-dim sm:ml-auto">{where}</span> : null}
      </div>
      {group.formulas.map((id) => (
        <FormulaEntry key={id} id={id} />
      ))}
    </div>
  );
}

function Formulas({ scan, note }: { scan: MethodViewProps["scan"]; note: number }) {
  const jobs = scanJobs(scan);
  return (
    <div className="flex flex-col">
      <p className={BODY}>
        {FORMULAS_COPY.intro}
        <NoteRef n={note} />
      </p>
      {FORMULA_GROUPS.map((group) => (
        <FormulaGroupView key={group.id} group={group} opens={group.skill ? (jobs.get(group.skill) ?? []) : []} />
      ))}
    </div>
  );
}

// 06 ------------------------------------------------------------------------------------------------------

function EvalResults({ summary }: { summary: EvalSummary }) {
  const rc = summary.realityCheck;
  return (
    <div className="flex flex-col gap-4" data-eval="ok">
      <p className="m-0 text-[12px] leading-[17px] text-dim">
        {EVAL_COPY.ranAt} {formatUtcDate(summary.ranAt)} · {modelLabel(summary.model)} ·{" "}
        {EVAL_COPY.questions(summary.questions.total, summary.questions.adversarial)}
      </p>
      <table className="w-full border-collapse text-[13px] leading-5">
        <caption className="sr-only">{EVAL_COPY.caption}</caption>
        <thead>
          <tr className={cx(SMALL_CAPS, "text-dim")}>
            <th scope="col" className="pb-1 text-left font-semibold">
              <span className="sr-only">{EVAL_COPY.measure}</span>
            </th>
            <th scope="col" className="w-[120px] pb-1 text-right font-semibold">
              {EVAL_COPY.grounded}
            </th>
            <th scope="col" className="w-[100px] pb-1 text-right font-semibold">
              {EVAL_COPY.ghost}
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.metrics.map((m) => (
            <tr key={m.id} className="border-t border-line align-baseline" data-eval-metric={m.id}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-text-2">
                {m.label}
                {m.note ? <span className="block text-[12px] text-dim">{m.note}</span> : null}
              </th>
              <td className="py-1.5 text-right font-medium text-ink tabular-nums">{formatEvalValue(m.grounded, m.unit)}</td>
              <td className="py-1.5 text-right text-text-2 tabular-nums">{formatEvalValue(m.ghost, m.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rc ? (
        <div className="flex flex-col gap-1.5" data-reality="true">
          <h3 className={SUBHEAD}>
            {EVAL_COPY.realityHeading} · {EVAL_COPY.realityCases(rc.cases)}
          </h3>
          <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[13px] leading-6">
            <dt className="text-text-2">{EVAL_COPY.realityMedian}</dt>
            <dd className="m-0 text-right font-medium text-ink tabular-nums">{formatEvalValue(rc.medianPercentile, "rate")}</dd>
            <dt className="text-text-2">{EVAL_COPY.realityHit}</dt>
            <dd className="m-0 text-right font-medium text-ink tabular-nums">{formatEvalValue(rc.ghostHitRate, "rate")}</dd>
          </dl>
          {rc.note ? <p className="m-0 text-[12px] leading-[17px] text-dim">{rc.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Evaluation({ evaluation, note }: { evaluation: EvalState; note: number }) {
  return (
    <div className="flex flex-col gap-3">
      {evaluation.state === "ok" ? (
        <EvalResults summary={evaluation.summary} />
      ) : (
        <div className="flex flex-col gap-3" data-eval={evaluation.state}>
          <p className="m-0 text-[14px] leading-[21px] font-medium text-ink">
            {evaluation.state === "missing" ? EVAL_COPY.notRun : EVAL_COPY.unreadable}
          </p>
          <p className={BODY}>{EVAL_COPY.design}</p>
          <div className="flex flex-col gap-1">
            <h3 className={SUBHEAD}>{EVAL_COPY.measuresHeading}</h3>
            <ul className={cx(LIST, "gap-0.5 text-[13px] leading-5 text-text-2")}>
              {EVAL_COPY.measures.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p className="m-0 text-[12px] leading-[17px] text-dim">
        {GHOST_HONESTY_LINE}
        <NoteRef n={note} />
      </p>
    </div>
  );
}

// 07 ------------------------------------------------------------------------------------------------------

function Refuse({ facts, note }: { facts: MethodFacts; note: number }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[13px] leading-5 sm:grid-cols-[120px_minmax(0,1fr)]">
        {refusalSummary(facts).map((r, i) => (
          <div key={r.term} className="contents">
            <dt className="font-medium text-ink">{r.term}</dt>
            <dd className="m-0 text-text-2">
              {r.text}
              {i === 0 ? <NoteRef n={note} /> : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 flex flex-wrap items-center gap-x-2 text-[13px] leading-5">
        <Link href="/trust" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline hover:underline-offset-4">
          {METHOD_PAGE.trustLink}
          <ArrowRightIcon size={12} />
        </Link>
        <span className="text-dim">{METHOD_PAGE.trustLinkNote}</span>
      </p>
    </div>
  );
}

// The page --------------------------------------------------------------------------------------------------

export function MethodView({ facts, scan, endpoints, trendWindow, evaluation }: MethodViewProps) {
  const steps = methodSteps(facts);
  const notes = noteNumbers(steps);
  const stepNotes = steps.flatMap((step, i) => (step.note ? [{ n: notes.byStep.get(i)!, ...step.note }] : []));
  const outline = (
    <Outline
      heading={METHOD_PAGE.outlineHeading}
      spyOffset={REFERENCE_STICKY_TOP + 24}
      items={METHOD_SECTION_ORDER.map((id) => ({
        id,
        label: METHOD_SECTIONS[id].title,
        ...(id === "formulas" ? { count: FORMULA_IDS.length } : {}),
      }))}
      meta={{
        trace: METHOD_PAGE.outlineTrace,
        text: (
          <Link href="/trust" className="text-accent hover:underline">
            {METHOD_PAGE.trustLink}
          </Link>
        ),
      }}
    />
  );
  return (
    <ReferenceGrid outline={outline}>
      {/* The head and the steps share a row, so the sources and the step notes stack in the margin. */}
      <BriefRow
        notes={
          <div className="flex flex-col gap-6">
            <TraceNote head={METHOD_SOURCES.traceHead(FORMULA_IDS.length, ValidationRule.options.length)} detail={METHOD_SOURCES.traceDetail} />
            <Colophon
              heading={METHOD_SOURCES.heading}
              rows={METHOD_SOURCES.rows({ endpoints, trendWindow, clerkModel: facts.clerkModel, analystModel: facts.analystModel })}
            />
            <SideNotes>
              {stepNotes.map((note) => (
                <SideNote key={note.n} n={note.n} text={note.text} trace={note.trace} />
              ))}
            </SideNotes>
          </div>
        }
      >
        <div className="flex flex-col gap-[22px]">
          <ReferenceHead
            kicker={METHOD_PAGE.kicker}
            section={METHOD_PAGE.section}
            extra={METHOD_PAGE.extra}
            title={METHOD_PAGE.title}
            lede={METHOD_PAGE.lede}
          />
          <Section id="steps" n={1}>
            <Steps facts={facts} scan={scan} steps={steps} notes={notes} />
          </Section>
        </div>
      </BriefRow>
      <BriefRow>
        <Section id="marks" n={2}>
          <Marks />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={notes.checker} text={CHECKER_NOTE.text(CONFIDENCE_PENALTY.checker_warning)} trace={CHECKER_NOTE.trace} />}>
        <Section id="checker" n={3}>
          <Checker facts={facts} note={notes.checker} />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={notes.conviction} text={CONVICTION_COPY.note} trace={CONVICTION_COPY.noteTrace} />}>
        <Section id="conviction" n={4}>
          <Conviction note={notes.conviction} />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={notes.formulas} text={FORMULAS_COPY.note} trace={FORMULAS_COPY.noteTrace} />}>
        <Section id="formulas" n={5}>
          <Formulas scan={scan} note={notes.formulas} />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={notes.eval} text={EVAL_COPY.note} trace={EVAL_COPY.noteTrace} />}>
        <Section id="eval" n={6}>
          <Evaluation evaluation={evaluation} note={notes.eval} />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={notes.refuse} text={REFUSE_NOTE.text} trace={REFUSE_NOTE.trace} />}>
        <Section id="refuse" n={7}>
          <Refuse facts={facts} note={notes.refuse} />
        </Section>
      </BriefRow>
    </ReferenceGrid>
  );
}
