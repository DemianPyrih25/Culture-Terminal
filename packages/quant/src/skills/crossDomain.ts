import {
  ANALYST_TOOLS,
  entityTypeUrn,
  type CacheProbe,
  type DigestRow,
  type Domain,
  type EntityRegistry,
  type EvidenceId,
  type QlooEntityInsightsResponse,
  type QlooResult,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { computeNeighbourhoods, type DomainNeighbourhood } from "./crossDomain/neighbourhood";
import {
  addDomainMetrics,
  addEdgeMetric,
  addEmptyFinding,
  addNeighbourhoodDataset,
  addPartnersCategoryFinding,
  addPopularityFindings,
  joinNames,
  recordDomainEvidence,
  registerShown,
  selectShown,
  xdomDigestRows,
  type DomainMetrics,
  type DomainOutcome,
  type XdomRun,
} from "./crossDomain/outputs";
import { DOMAIN_ITEM, DOMAIN_NOUN, domainParams, planCrossDomain, probeParams, type CrossDomainInput } from "./crossDomain/requests";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeName } from "./format";

/**
 * S9 cross_domain, the Cultural neighbourhood (SPEC §5.3 S9; PLAN §5.3): one open insights call per
 * domain (artist means music; podcast, tv_show, movie, brand) with the seeds, the seed tags as taste
 * context, explainability and a popularity cap, take 15; the brand call excludes the seeds' own
 * genre:brand category. QUANT reads FIT as the within-call percentile, UNDER-THE-RADAR as FIT minus
 * popularity (a pick needs FIT at or above the domain median and popularity below it) and keeps
 * explainability edges by the G15 rule share·K ≥ 1.1.
 */

/** Client errors that are bugs in the request, never a gap to explain: they fail the skill. */
const REQUEST_BUGS: ReadonlySet<string> = new Set(["qloo_param", "qloo_no_signal"]);

/**
 * Network calls a cross_domain input would cost now: one per requested domain whose exact request
 * is not cached, as the run would send it (cached requests are free). 0 when no seed resolves.
 */
export async function estimateCrossDomainCalls(input: CrossDomainInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const plan = planCrossDomain(input, registry);
  if (plan.seeds.length === 0) return 0;
  return countUncached(probe, "/v2/insights", plan.domains.map((d) => probeParams(plan, d)));
}

type InsightsAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;

/** The domain calls, concurrently; a refused or failed call becomes a gap the result explains. */
async function callDomains(ctx: SkillCtx, run: XdomRun): Promise<{ domain: Domain; attempt: InsightsAttempt }[]> {
  const { plan } = run;
  const attempts = await attemptAllKeepingFailures(
    plan.domains.map((d) => () => ctx.qloo.insights(entityTypeUrn(d), domainParams(plan, d))),
    ctx.signal,
  );
  const bug = attempts.find((a) => a.kind === "failed" && REQUEST_BUGS.has(a.code));
  if (bug?.kind === "failed") throw bug.error;
  return plan.domains.map((domain, i) => ({ domain, attempt: attempts[i] ?? { kind: "truncated" } }));
}

function gapNotice(outcome: Extract<DomainOutcome, { kind: "gap" }>): string {
  const noun = DOMAIN_NOUN[outcome.domain];
  return outcome.reason === "budget_truncated"
    ? `The ${noun} call was not made (run budget), so the ${noun} neighbourhood is not measured.`
    : `The ${noun} call failed (${outcome.code ?? "error"}), so the ${noun} neighbourhood is not measured.`;
}

function finish(run: XdomRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: run.registered,
      notices: run.notices,
    },
    target,
  );
}

async function runCrossDomain(input: CrossDomainInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "cross_domain", step: input.step_id };
  const plan = planCrossDomain(input, ctx.registry);
  if (plan.seeds.length === 0) {
    return skillErrorResult(out, [...plan.notices, "cross_domain needs at least one registered seed; resolve it first."].join(" "));
  }

  const run: XdomRun = {
    ctx,
    plan,
    seedLabel: joinNames(plan.seeds.map((s) => safeName(s.name))),
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    datasetIds: [],
    registered: [],
    notices: [...plan.notices],
  };

  // The calls, then QUANT over every answered domain at once (one pooled floor).
  const called = await callDomains(ctx, run);
  const answered = called.flatMap(({ domain, attempt }) => (attempt.kind === "ok" ? [{ domain, value: attempt.value }] : []));
  const firstFailure = called.find((c) => c.attempt.kind === "failed");
  // With nothing answered there is no evidence to keep: a failure goes to the caller as it is.
  if (answered.length === 0 && firstFailure?.attempt.kind === "failed" && !called.some((c) => c.attempt.kind === "truncated")) {
    throw firstFailure.attempt.error;
  }
  const hoods = computeNeighbourhoods(
    answered.map((a) => ({ domain: a.domain, entities: a.value.data.results.entities })),
    plan.seeds.map((s) => s.entityId),
  );
  const hoodOf = new Map<Domain, DomainNeighbourhood>(hoods.map((h) => [h.domain, h]));
  const outcomes: DomainOutcome[] = called.map(({ domain, attempt }) => {
    const hood = hoodOf.get(domain);
    if (attempt.kind === "ok" && hood !== undefined) return { kind: "answered", domain, meta: attempt.value.meta, hood };
    return attempt.kind === "failed"
      ? { kind: "gap", domain, reason: "error", code: attempt.code }
      : { kind: "gap", domain, reason: "budget_truncated", code: null };
  });

  // The shown entities first (metrics cite their refs), then evidence, metrics and findings, domain by domain.
  const shown = selectShown(outcomes);
  registerShown(run, shown);
  const metrics = new Map<Domain, DomainMetrics>();
  const domainEvidence: EvidenceId[] = [];
  for (const o of outcomes) {
    if (o.kind === "gap") {
      if (o.reason === "budget_truncated") run.flags.add("BUDGET_TRUNCATED");
      run.notices.push(gapNotice(o));
      continue;
    }
    const evidenceId = recordDomainEvidence(run, o.meta, o.hood);
    if (evidenceId === null) continue;
    domainEvidence.push(evidenceId);
    metrics.set(o.domain, addDomainMetrics(run, o.hood, evidenceId));
    addEmptyFinding(run, o.hood);
    if (o.hood.missingPopularity > 0) {
      const n = o.hood.missingPopularity;
      run.notices.push(
        `${n} ${DOMAIN_ITEM[o.domain]} result${n === 1 ? "" : "s"} came without a popularity, so ${n === 1 ? "its" : "their"} under-the-radar score is not measured.`,
      );
    }
  }
  const answeredHoods = outcomes.flatMap((o) => (o.kind === "answered" && metrics.has(o.domain) ? [o.hood] : []));
  addPopularityFindings(run, answeredHoods, metrics);
  addPartnersCategoryFinding(run, answeredHoods, metrics);
  addEdgeMetric(run, answeredHoods, domainEvidence);
  if (plan.seeds.length === 1 && answered.length > 0) {
    run.notices.push("With one seed every result is explained by it alone; explainability edges need two or more seeds.");
  }
  if (domainEvidence.length > 0) addNeighbourhoodDataset(run, outcomes);

  const scoredDomains = hoods.filter((h) => h.scored > 0).length;
  const gaps = outcomes.some((o) => o.kind === "gap");
  const status: SkillStatus =
    scoredDomains === 0 ? (gaps ? "partial" : "empty") : gaps || scoredDomains < plan.domains.length ? "partial" : "ok";
  return finish(run, out, status, xdomDigestRows(run, shown, metrics));
}

export const crossDomainSkill: SkillFor<"cross_domain"> = {
  id: "cross_domain",
  mnemonic: "XDOM",
  kitWorkflows: ANALYST_TOOLS.cross_domain.kitWorkflows,
  input: ANALYST_TOOLS.cross_domain.input,
  estimateCalls: (input, probe, registry) => estimateCrossDomainCalls(input, probe, registry),
  run: runCrossDomain,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.cross_domain],
};
