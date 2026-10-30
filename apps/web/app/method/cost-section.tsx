import type { CostRange } from "@ct/contracts";
import { ANSWER_ADDON_COSTS, ANSWER_ADDONS, ANSWER_ADDONS_HEADING, FEATURE_COST_NOTE, NOTE_LLM_USD } from "@ct/contracts/values";
import { cx } from "../../components/ui/cx";
import { BODY, LABEL, RefNote, RefSection, ROW, SUBHEAD } from "../../components/method/reference";
import { JOB_LABEL } from "../../lib/brief/format";
import type { CostFacts, MeasuredCosts, MeasuredFeatureCost, MeasuredJobCost } from "./costs";

/**
 * The cost-per-use card on /method (PLAN Part 10): every feature's Qloo calls, cold and warm, and its
 * model cost, as planned; then each job's Qloo plan beside what this server's live answers measured.
 * Plan figures are labelled as plans; a measured figure is shown only where live runs exist to count.
 */

export const COSTS_SECTION_ID = "costs";

/** "5–10", "0"; a range of one value prints once. */
export function rangeText(r: CostRange): string {
  return r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
}

/** "$0", "$0.10–0.30"; amounts under a cent keep three decimals ("$0.005–0.02"). */
export function usdRangeText(r: CostRange): string {
  if (r.max === 0) return "$0";
  const money = (v: number) => (v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2));
  return r.min === r.max ? `$${money(r.min)}` : `$${money(r.min)}–${money(r.max)}`;
}

/** A measured model cost: "$0.18", or "under $0.01" for an economy-sized one. */
export function usdText(v: number): string {
  if (v === 0) return "$0";
  return v < 0.01 ? "under $0.01" : `$${v.toFixed(2)}`;
}

export const COSTS_COPY = {
  title: "Cost per use",
  aside: "Plan figures · measured where live runs exist",
  intro: `${FEATURE_COST_NOTE} Cold: nothing cached yet; warm: the same request again inside the cache window. SEC EDGAR, US Census and OpenStreetMap calls are free and not counted. Screens and profiles draw from the same daily Qloo cap as answers.`,
  addonsHeading: ANSWER_ADDONS_HEADING,
  addonsCaption: "What each answer adds besides its job: the two context blocks and the OpenStreetMap places, with their Qloo calls and model cost",
  addonsIntro: "Every answer also runs these beside its analysis. None of them changes the measured answer, and none uses a Qloo call.",
  qloo: "Qloo",
  featureMeasured: (m: MeasuredFeatureCost) => `Measured: ${Math.round(m.qlooNetwork)} + ${Math.round(m.qlooCached)} Qloo · ${usdText(m.llmUsd)}, median of ${m.uses} ${m.uses === 1 ? "use" : "uses"}`,
  featurePlanOnly: "plan: no recorded use yet",
  featuresHeading: "Features · plan figures, measured where uses are recorded",
  featuresCaption: "Each feature's Qloo calls, cold and warm, and its model cost per use, as planned",
  feature: "Feature",
  cold: "Qloo, cold",
  warm: "Qloo, warm",
  model: "Model",
  noWarm: "—",
  perJob: "Spans the jobs below: one run of the followed note's job.",
  jobsHeading: "Answers, per job",
  jobsCaption: "Each job's planned Qloo calls per answer, and what this server's live answers measured",
  job: "Job",
  measured: "Measured",
  jobsIntro: (limits: CostFacts["limits"]) =>
    `Planned Qloo calls of each job's answer. Turn-2 follow-ups may add up to ${limits.followupCalls} more; an answer is capped at ${limits.qlooCalls}. ` +
    `A live (Sonnet) note's model cost is planned at ${usdRangeText(NOTE_LLM_USD)}; an economy (Haiku) note costs under a cent.`,
  measuredState: (m: MeasuredCosts): string =>
    m.state === "ok"
      ? `Measured: the median of this server's finished live answers of each job in the last ${m.windowDays} days, as fresh + cached Qloo calls and model cost.`
      : m.state === "mock"
        ? "This server runs on synthetic Qloo data, so its runs measure nothing: plan figures only."
        : "Measured figures could not be read just now: plan figures only.",
  noRuns: "No live runs yet",
  runs: (n: number) => `median of ${n} ${n === 1 ? "run" : "runs"}`,
  note: "A measured figure counts this server's own answers; the plan stays beside it, so a drift between the two shows.",
  trace: "packages/contracts/src/feature-costs.ts · runs table",
} as const;

const TABLE = "w-full border-collapse";
const NUM = "w-[76px] py-2 pl-2 text-right type-body text-ink tabular-nums whitespace-nowrap max-sm:w-[60px]";
const HEAD = cx(LABEL, "pl-2 text-right font-semibold");

function Measured({ m }: { m: MeasuredJobCost | null }) {
  if (!m) return <span className="text-ink-2">{COSTS_COPY.noRuns}</span>;
  return (
    <>
      <span className="text-ink tabular-nums">
        {Math.round(m.qlooNetwork)} + {Math.round(m.qlooCached)} · {usdText(m.llmUsd)}
      </span>
      <span className={cx(LABEL, "block")}>{COSTS_COPY.runs(m.runs)}</span>
    </>
  );
}

export function CostSection({ facts }: { facts: CostFacts }) {
  return (
    <RefSection
      id={COSTS_SECTION_ID}
      title={COSTS_COPY.title}
      aside={COSTS_COPY.aside}
      note={<RefNote trace={COSTS_COPY.trace}>{COSTS_COPY.note}</RefNote>}
    >
      <p className={BODY}>{COSTS_COPY.intro}</p>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COSTS_COPY.featuresHeading}</h3>
        <table className={TABLE} data-costs="features">
          <caption className="sr-only">{COSTS_COPY.featuresCaption}</caption>
          <thead>
            <tr className="h-8">
              <th scope="col" className="text-left">
                <span className="sr-only">{COSTS_COPY.feature}</span>
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.cold}
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.warm}
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.model}
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.features.map((f) => (
              <tr key={f.feature} className={ROW} data-feature-cost={f.feature}>
                <th scope="row" className="py-2 pr-2 text-left font-normal">
                  <span className="type-body-strong text-ink">{f.label}</span> <span className={LABEL}>{f.per}</span>
                  <span className={cx(BODY, "block pt-0.5")}>{f.plan}</span>
                  {f.perJob ? <span className={cx(LABEL, "block pt-0.5")}>{COSTS_COPY.perJob}</span> : null}
                  {f.measured ? (
                    <span className={cx(LABEL, "block pt-0.5 text-ink")} data-feature-measured="true">
                      {COSTS_COPY.featureMeasured(f.measured)}
                    </span>
                  ) : f.perJob ? null : (
                    <span className={cx(LABEL, "block pt-0.5")} data-feature-measured="false">
                      {COSTS_COPY.featurePlanOnly}
                    </span>
                  )}
                </th>
                <td className={NUM}>{rangeText(f.qlooCold)}</td>
                <td className={NUM}>{f.qlooWarm ? rangeText(f.qlooWarm) : COSTS_COPY.noWarm}</td>
                <td className={NUM}>{usdRangeText(f.llmUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COSTS_COPY.addonsHeading}</h3>
        <p className={BODY}>{COSTS_COPY.addonsIntro}</p>
        <table className={TABLE} data-costs="addons">
          <caption className="sr-only">{COSTS_COPY.addonsCaption}</caption>
          <thead>
            <tr className="h-8">
              <th scope="col" className="text-left">
                <span className="sr-only">{COSTS_COPY.feature}</span>
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.qloo}
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.model}
              </th>
            </tr>
          </thead>
          <tbody>
            {ANSWER_ADDONS.map((a) => {
              const cost = ANSWER_ADDON_COSTS[a];
              return (
                <tr key={a} className={ROW} data-addon-cost={a}>
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    <span className="type-body-strong text-ink">{cost.label}</span> <span className={LABEL}>{cost.per}</span>
                    <span className={cx(BODY, "block pt-0.5")}>{cost.plan}</span>
                  </th>
                  <td className={NUM}>{rangeText(cost.qloo)}</td>
                  <td className={NUM}>{usdRangeText(cost.llmUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COSTS_COPY.jobsHeading}</h3>
        <p className={BODY}>{COSTS_COPY.jobsIntro(facts.limits)}</p>
        <p className={LABEL} data-measured-state={facts.measured.state}>
          {COSTS_COPY.measuredState(facts.measured)}
        </p>
        <table className={TABLE} data-costs="jobs">
          <caption className="sr-only">{COSTS_COPY.jobsCaption}</caption>
          <thead>
            <tr className="h-8">
              <th scope="col" className="text-left">
                <span className="sr-only">{COSTS_COPY.job}</span>
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.cold}
              </th>
              <th scope="col" className={HEAD}>
                {COSTS_COPY.warm}
              </th>
              <th scope="col" className={cx(HEAD, "w-[34%]")}>
                {COSTS_COPY.measured}
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.jobs.map((j) => (
              <tr key={j.job} className={ROW} data-job-cost={j.job}>
                <th scope="row" className="py-2 pr-2 text-left type-body font-normal text-ink">
                  {JOB_LABEL[j.job]}
                </th>
                <td className={NUM}>{rangeText(j.qlooCold)}</td>
                <td className={NUM}>{j.qlooWarm ? rangeText(j.qlooWarm) : COSTS_COPY.noWarm}</td>
                <td className="py-2 pl-2 text-right type-body" data-measured={j.measured ? "true" : "false"}>
                  <Measured m={j.measured} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </RefSection>
  );
}
