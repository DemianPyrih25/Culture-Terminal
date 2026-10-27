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
  methodSteps,
  SCAN_COPY,
  type StepCopy,
  TURNS_HEADING,
  VERDICT_MEANING,
  VERDICT_WORD,
} from "../../content/method";
import { BADGE_LABEL, CONVICTION_BAND_LABEL, formatUtcDate, JOB_LABEL, TOOL_LABEL } from "../../lib/brief/format";
import { topicForPillar } from "../ui/topic";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
import { Hatch } from "../ui/skeleton";
import { Tag } from "../ui/tag";
import { formatEvalValue, type EvalState, type EvalSummary } from "./eval-summary";
import { bandRanges, modelLabel, penaltyText } from "./facts";
import { BODY, Colophon, LABEL, LIST, REFERENCE_ANCHOR, ReferenceLayout, RefNote, RefSection, ROW, SUBHEAD } from "./reference";
import { RULES_INDEX, RulesSections, type RulesFacts } from "./rules-sections";
import { TexFormula } from "./tex";

/**
 * /method, the analysts' reference: how an answer is made, the marks, the checker rules, confidence,
 * every formula in @ct/quant FORMULAS (each at /method#<formula id>), the evaluation, and the rules
 * (safe use, refusals, the audience allowlist, data handling, models and caps). Generated from the
 * code; the copy lives in content/method.ts and content/trust.ts.
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
  /** The rules moved from /trust, read from the code and the server's configuration. */
  rules: RulesFacts;
}

const TABLE = "w-full border-collapse";

function Section({ id, note, children }: { id: (typeof METHOD_SECTION_ORDER)[number]; note?: ReactNode; children: ReactNode }) {
  const s = METHOD_SECTIONS[id];
  return (
    <RefSection id={id} title={s.title} aside={s.aside} note={note}>
      {children}
    </RefSection>
  );
}

// Steps --------------------------------------------------------------------------------------------------

/** The jobs whose opening scan runs each skill, in desk order. */
function scanJobs(scan: MethodViewProps["scan"]): Map<SkillId, Job[]> {
  const out = new Map<SkillId, Job[]>();
  for (const jobs of Object.values(JOBS_BY_PILLAR)) {
    for (const job of jobs) for (const skill of scan[job] ?? []) out.set(skill, [...(out.get(skill) ?? []), job]);
  }
  return out;
}

function Steps({ facts, scan, steps }: Pick<MethodViewProps, "facts" | "scan"> & { steps: readonly StepCopy[] }) {
  return (
    <div className="flex flex-col gap-6">
      <ol className={LIST} data-steps={steps.length}>
        {steps.map((step, i) => (
          <li key={step.name} className={cx(ROW, "grid grid-cols-[28px_minmax(0,1fr)] gap-x-2 gap-y-0.5 py-3 sm:grid-cols-[28px_112px_minmax(0,1fr)_140px]")}>
            <span className="type-label text-ink-2 tabular-nums">{i + 1}</span>
            <span className="type-body-strong text-ink">{step.name}</span>
            <span className={cx(BODY, "col-start-2 sm:col-start-auto")}>
              {step.text}
              {step.note ? <span className="block pt-1 type-label">{step.note.text}</span> : null}
            </span>
            <span className={cx(LABEL, "col-start-2 sm:col-start-auto sm:text-right")}>{step.who}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{SCAN_COPY.heading}</h3>
        <p className={BODY}>{SCAN_COPY.text}</p>
        <table className={TABLE} data-scan="true">
          <caption className="sr-only">{SCAN_COPY.caption}</caption>
          <tbody>
            {(Object.keys(JOBS_BY_PILLAR) as Pillar[]).flatMap((pillar) =>
              JOBS_BY_PILLAR[pillar].map((job) => (
                <tr key={job} className={ROW} data-job={job}>
                  <td className="w-[140px] py-2 pr-3 type-label text-ink-2 max-sm:hidden">{topicForPillar(pillar).label}</td>
                  <th scope="row" className="w-[200px] py-2 pr-3 text-left type-body font-normal text-ink max-sm:w-[46%]">
                    <span className="block type-label text-ink-2 sm:hidden">{topicForPillar(pillar).label}</span>
                    {JOB_LABEL[job]}
                  </th>
                  <td className={cx(BODY, "py-2")}>{(scan[job] ?? []).map((skill) => TOOL_LABEL[skill]).join(" · ")}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{TURNS_HEADING}</h3>
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-4 gap-y-3">
          {analystTurns(facts).map((turn) => (
            <div key={turn.label} className="contents">
              <dt className="type-body-strong text-ink">{turn.label}</dt>
              <dd className={BODY}>{turn.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// Marks --------------------------------------------------------------------------------------------------

function MarkRow({ mark, meaning }: { mark: ReactNode; meaning: string }) {
  return (
    <li className="grid grid-cols-[148px_minmax(0,1fr)] items-center gap-3 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5">{mark}</span>
      <span className={BODY}>{meaning}</span>
    </li>
  );
}

const VERDICT_MARK: Readonly<Record<ScorecardVerdict, { icon: IconName; tone: string }>> = {
  CONFIRMED: { icon: "check", tone: "text-good-ink" },
  REFUTED: { icon: "zap", tone: "text-second-ink" },
  INCONCLUSIVE: { icon: "minus", tone: "text-ink-2" },
};

function Marks() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <h3 className={SUBHEAD}>{MARKS_COPY.claimsHeading}</h3>
          <ul className={LIST}>
            <MarkRow
              mark={
                <span className="inline-flex items-center gap-1.5 type-label text-ink-2">
                  <Icon name="receipt" size={14} />
                  Source
                </span>
              }
              meaning={MARKS_COPY.source}
            />
            <MarkRow mark={<Tag preset="draft" />} meaning={MARKS_COPY.draft} />
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className={SUBHEAD}>{MARKS_COPY.dataHeading}</h3>
          <ul className={LIST}>
            <MarkRow mark={<span className="type-label text-ink-2">{MARKS_COPY.samples.cached}</span>} meaning={MARKS_COPY.cached} />
            <MarkRow mark={<Hatch className="h-8 min-h-0 w-[132px]" />} meaning={MARKS_COPY.noSignal} />
          </ul>
        </div>
        <div className="flex flex-col gap-1 lg:col-span-2">
          <h3 className={SUBHEAD}>{MARKS_COPY.guessesHeading}</h3>
          <ul className={LIST}>
            {ScorecardVerdict.options.map((v) => (
              <MarkRow
                key={v}
                mark={
                  <span className={cx("inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold", VERDICT_MARK[v].tone)}>
                    <Icon name={VERDICT_MARK[v].icon} size={16} />
                    {VERDICT_WORD[v]}
                  </span>
                }
                meaning={VERDICT_MEANING[v]}
              />
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{MARKS_COPY.badgesHeading}</h3>
        <p className={BODY}>{MARKS_COPY.badgesIntro}</p>
        <table className={TABLE} data-badges="true">
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
              <tr key={badge} className={ROW} data-badge={badge}>
                <th scope="row" className="w-[148px] py-2 pr-3 text-left type-body-strong text-ink">
                  {BADGE_LABEL[badge]}
                </th>
                <td className={cx(BODY, "py-2 pr-3")}>{BADGE_MEANING[badge]}</td>
                <td className="w-[112px] py-2 text-right type-label whitespace-nowrap text-ink-2 tabular-nums">
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

// Checker ------------------------------------------------------------------------------------------------

function Checker({ facts }: { facts: MethodFacts }) {
  const rules = checkerRules(facts);
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>{CHECKER_INTRO}</p>
      <ol className={LIST}>
        {ValidationRule.options.map((rule) => (
          <li
            key={rule}
            id={`rule-${rule}`}
            className={cx(ROW, REFERENCE_ANCHOR, "grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-0.5 py-3 sm:grid-cols-[44px_minmax(0,1fr)_168px]")}
            data-rule={rule}
          >
            <span className="font-mono text-[12px] leading-6 text-ink-2">{rule}</span>
            <span className="flex flex-col">
              <span className="type-body-strong text-ink">{rules[rule].title}</span>
              <span className={BODY}>{rules[rule].text}</span>
            </span>
            <span className={cx(LABEL, "col-start-2 sm:col-start-auto sm:pt-0.5 sm:text-right")}>{rules[rule].action}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Confidence ---------------------------------------------------------------------------------------------

function Conviction() {
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>{CONVICTION_COPY.intro}</p>
      <table className={TABLE} data-conviction="true">
        <caption className="sr-only">{CONVICTION_COPY.caption}</caption>
        <tbody>
          <tr className="border-t border-line-strong">
            <th scope="row" className="py-2 text-left type-body-strong text-ink">
              {CONVICTION_COPY.start}
            </th>
            <td className="py-2 text-right type-body-strong text-ink tabular-nums">{CONFIDENCE_START}</td>
          </tr>
          {ConfidenceRule.options.map((rule) => (
            <tr key={rule} className={ROW} data-penalty={rule}>
              <th scope="row" className={cx(BODY, "py-2 pr-3 text-left font-normal")}>
                {CONFIDENCE_RULE_LABEL[rule]}
              </th>
              <td className="w-[120px] py-2 text-right whitespace-nowrap tabular-nums">
                <span className="type-body text-ink">{penaltyText(rule)}</span>{" "}
                <span className={LABEL}>{CONFIDENCE_ONCE.has(rule) ? CONVICTION_COPY.once : CONVICTION_COPY.each}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex flex-wrap items-center gap-x-5 gap-y-1" data-bands="true">
        <span className={SUBHEAD}>{CONVICTION_COPY.bandsHeading}</span>
        {bandRanges().map((r) => (
          <span key={r.band} className="type-body">
            <span className="font-medium text-ink">{CONVICTION_BAND_LABEL[r.band]}</span>{" "}
            <span className="text-ink-2 tabular-nums">
              {r.min}–{r.max}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
}

// Formulas -----------------------------------------------------------------------------------------------

function FormulaEntry({ id }: { id: FormulaId }) {
  const f = FORMULAS[id];
  const meta = FORMULA_META[id];
  return (
    <article id={id} className={cx("flex flex-col gap-3 border-b border-line py-5 last:border-b-0", REFERENCE_ANCHOR)} data-formula={id}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h4 className="type-body-strong text-ink">{f.name}</h4>
        <a href={`#${id}`} className="font-mono text-[12px] leading-4 text-ink-2 hover:text-accent" title={FORMULAS_COPY.anchor}>
          {id}
        </a>
      </header>
      <div className="overflow-x-auto rounded-sm bg-sunken px-4 py-2">
        <TexFormula tex={f.formula_tex} />
      </div>
      <p className={BODY}>{f.plain_english}</p>
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className={cx(LABEL, "pt-0.5")}>{FORMULAS_COPY.inputs}</dt>
        <dd>
          <ul className={cx(LIST, "gap-0.5 type-body text-ink")}>
            {meta.inputs.map((input) => (
              <li key={input}>{input}</li>
            ))}
          </ul>
        </dd>
        <dt className={cx(LABEL, "pt-0.5")}>{FORMULAS_COPY.caveats}</dt>
        <dd>
          <ul className={cx(LIST, "gap-0.5", BODY)}>
            {f.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </dd>
        <dt className={cx(LABEL, "pt-0.5")}>{FORMULAS_COPY.badge}</dt>
        <dd className="type-body" data-badge={meta.badge ?? "none"}>
          {meta.badge ? (
            <span className="font-medium text-ink">{BADGE_LABEL[meta.badge]}</span>
          ) : (
            <span className="text-ink-2">
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
  // A group's own line first: name matching runs at the gate on every answer, not from the scan table.
  const scanLine = opens.length > 0 ? `${FORMULAS_COPY.opens}: ${opens.map((job) => JOB_LABEL[job]).join(" · ")}` : SCAN_COPY.analystOnly;
  const where = group.where ?? (group.skill ? scanLine : (group.owner ?? null));
  return (
    <div className="flex flex-col pt-4" data-formula-group={group.id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-strong pb-2">
        <h3 className="text-[17px] leading-6 font-semibold text-ink">{group.title}</h3>
        {group.skill ? (
          <span className="font-mono text-[12px] text-ink-2">
            {TOOL_MNEMONIC[group.skill]} · {group.skill}
          </span>
        ) : null}
        {where ? <span className={cx(LABEL, "sm:ml-auto")}>{where}</span> : null}
      </div>
      {group.formulas.map((id) => (
        <FormulaEntry key={id} id={id} />
      ))}
    </div>
  );
}

function Formulas({ scan }: { scan: MethodViewProps["scan"] }) {
  const jobs = scanJobs(scan);
  return (
    <div className="flex flex-col">
      <p className={BODY}>{FORMULAS_COPY.intro}</p>
      {FORMULA_GROUPS.map((group) => (
        <FormulaGroupView key={group.id} group={group} opens={group.skill ? (jobs.get(group.skill) ?? []) : []} />
      ))}
    </div>
  );
}

// Evaluation ---------------------------------------------------------------------------------------------

function EvalResults({ summary }: { summary: EvalSummary }) {
  const rc = summary.realityCheck;
  return (
    <div className="flex flex-col gap-4" data-eval="ok">
      <p className={LABEL}>
        {EVAL_COPY.ranAt} {formatUtcDate(summary.ranAt)} · {modelLabel(summary.model)} · {EVAL_COPY.questions(summary.questions.total, summary.questions.adversarial)}
      </p>
      <table className={cx(TABLE, "tabular-nums")}>
        <caption className="sr-only">{EVAL_COPY.caption}</caption>
        <thead>
          <tr className="h-8 border-b border-line">
            <th scope="col" className="text-left">
              <span className="sr-only">{EVAL_COPY.measure}</span>
            </th>
            <th scope="col" className="w-[132px] text-right text-[12px] leading-4 font-semibold text-ink-2">
              {EVAL_COPY.grounded}
            </th>
            <th scope="col" className="w-[112px] text-right text-[12px] leading-4 font-semibold text-ink-2">
              {EVAL_COPY.ghost}
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.metrics.map((m) => (
            <tr key={m.id} className="border-b border-line align-baseline" data-eval-metric={m.id}>
              <th scope="row" className={cx(BODY, "py-2 pr-3 text-left font-normal")}>
                {m.label}
                {m.note ? <span className={cx(LABEL, "block")}>{m.note}</span> : null}
              </th>
              <td className="py-2 text-right type-body-strong text-ink">{formatEvalValue(m.grounded, m.unit)}</td>
              <td className="py-2 text-right type-body text-ink-2">{formatEvalValue(m.ghost, m.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rc ? (
        <div className="flex flex-col gap-1.5" data-reality="true">
          <h3 className={SUBHEAD}>
            {EVAL_COPY.realityHeading} · {EVAL_COPY.realityCases(rc.cases)}
          </h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 type-body">
            <dt className="text-ink-2">{EVAL_COPY.realityMedian}</dt>
            <dd className="text-right font-medium text-ink tabular-nums">{formatEvalValue(rc.medianPercentile, "rate")}</dd>
            <dt className="text-ink-2">{EVAL_COPY.realityHit}</dt>
            <dd className="text-right font-medium text-ink tabular-nums">{formatEvalValue(rc.ghostHitRate, "rate")}</dd>
          </dl>
          {rc.note ? <p className={LABEL}>{rc.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Evaluation({ evaluation }: { evaluation: EvalState }) {
  return (
    <div className="flex flex-col gap-3">
      {evaluation.state === "ok" ? (
        <EvalResults summary={evaluation.summary} />
      ) : (
        <div className="flex flex-col gap-3" data-eval={evaluation.state}>
          <p className="type-body-strong text-ink">{evaluation.state === "missing" ? EVAL_COPY.notRun : EVAL_COPY.unreadable}</p>
          <p className={BODY}>{EVAL_COPY.design}</p>
          <div className="flex flex-col gap-1">
            <h3 className={SUBHEAD}>{EVAL_COPY.measuresHeading}</h3>
            <ul className={cx(LIST, "gap-0.5", BODY)}>
              {EVAL_COPY.measures.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p className={LABEL}>{GHOST_HONESTY_LINE}</p>
    </div>
  );
}

// The page -----------------------------------------------------------------------------------------------

export function MethodView({ facts, scan, endpoints, trendWindow, evaluation, rules }: MethodViewProps) {
  const steps = methodSteps(facts);
  const index = [
    { id: "sources", label: METHOD_SOURCES.heading },
    ...METHOD_SECTION_ORDER.map((id) => ({ id, label: METHOD_SECTIONS[id].title })),
    ...RULES_INDEX,
  ];
  const head = (
    <header className="flex flex-col gap-3 pb-2">
      <h1 className="type-display-m text-ink max-md:type-display-m-sm">{METHOD_PAGE.title}</h1>
      <p className="max-w-[744px] type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">{METHOD_PAGE.lede}</p>
    </header>
  );
  return (
    <ReferenceLayout items={index} head={head}>
      <RefSection id="sources" title={METHOD_SOURCES.heading} aside={METHOD_SOURCES.aside(FORMULA_IDS.length, ValidationRule.options.length)}>
        <Colophon rows={METHOD_SOURCES.rows({ endpoints, trendWindow, clerkModel: facts.clerkModel, analystModel: facts.analystModel })} />
      </RefSection>
      <Section id="steps">
        <Steps facts={facts} scan={scan} steps={steps} />
      </Section>
      <Section id="marks">
        <Marks />
      </Section>
      <Section id="checker" note={<RefNote trace={CHECKER_NOTE.trace}>{CHECKER_NOTE.text(CONFIDENCE_PENALTY.checker_warning)}</RefNote>}>
        <Checker facts={facts} />
      </Section>
      <Section id="conviction" note={<RefNote trace={CONVICTION_COPY.noteTrace}>{CONVICTION_COPY.note}</RefNote>}>
        <Conviction />
      </Section>
      <Section id="formulas" note={<RefNote trace={FORMULAS_COPY.noteTrace}>{FORMULAS_COPY.note}</RefNote>}>
        <Formulas scan={scan} />
      </Section>
      <Section id="eval" note={<RefNote trace={EVAL_COPY.noteTrace}>{EVAL_COPY.note}</RefNote>}>
        <Evaluation evaluation={evaluation} />
      </Section>
      <RulesSections {...rules} />
    </ReferenceLayout>
  );
}
