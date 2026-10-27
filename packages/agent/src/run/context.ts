import {
  AgeBucket,
  JOB_MNEMONIC,
  type Evidence,
  type Finding,
  type FindingKind,
  PILLAR_LABEL,
  type GeoApi,
  type Intent,
  isId,
  type Metric,
  type MetroId,
  type RunLimits,
  SEVERITY_RANK,
  type SkillId,
} from "@ct/contracts";
import { sanitizeQlooName, sanitizeQlooText, type AudienceSegment } from "@ct/qloo";
import type { FollowupLead } from "../analyst";
import type { AnalystMode } from "../anthropic";
import { MIN_OK_EVIDENCE } from "../checker";
import { wrapQuestion } from "../clerk";
import type { RunRegistry } from "../registry";
import { isSkillAvailable, toolLabel } from "./catalogue";
import { listedAreas } from "./areas";
import { audienceSegmentsFor, audiencesBlock } from "./audiences";
import { describeMarket, isGazetteerMetro, MARKET_CATALOGUE, MARKET_TIERS, marketTier, type RunMarket } from "./markets";
import { describeChainedStep, describeDeferredStep, describeScanStep, type ScanPlan } from "./scan";

/**
 * The ANALYST's first user message (director.md §1 "The first user message"): labelled blocks
 * written by code, in this order: TODAY, MODE, DESK, JOB, BUDGET, CLERK, REGISTRY, MARKETS,
 * AUDIENCES, AREAS, OPENING SCAN, UNAVAILABLE TOOLS, CASE SUMMARY, then the wrapped question.
 * Everything per run lives here, never in the system prompt, so the cached prefix stays frozen.
 * Text that came from the user or from Qloo is escaped so it can never open or close a tag.
 */

export const RUN_CONTEXT_LABELS = [
  "TODAY",
  "MODE",
  "DESK",
  "JOB",
  "BUDGET",
  "CLERK",
  "REGISTRY",
  "MARKETS",
  "AUDIENCES",
  "AREAS",
  "OPENING SCAN",
  "UNAVAILABLE TOOLS",
  "CASE SUMMARY",
] as const;

export interface ScanSummary {
  plan: ScanPlan;
  /** Estimated network calls per scan step (toolCallId), null when unknown. */
  estimates: ReadonlyMap<string, number | null>;
}

export interface RunContextInput {
  /** YYYY-MM-DD. */
  today: string;
  mode: AnalystMode;
  intent: Intent;
  limits: RunLimits;
  registry: RunRegistry;
  geo: GeoApi;
  scan: ScanSummary;
  /** The run's MARKETS (runMarkets); defaults to the gazetteer metros. */
  markets?: readonly RunMarket[];
  /** The pinned audience catalogue read at run start (loadRunAudiences); filtered by the desk again here. Defaults to none. */
  audiences?: readonly AudienceSegment[];
  unavailable: readonly SkillId[];
  qlooEnabled: boolean;
  caseSummary: string | null;
  /** The raw question; wrapQuestion sanitises, caps and wraps it. */
  question: string;
}

const NONE = "none in this build";
const NAME_MAX = 80;

/** Untrusted text (the user's, CLERK's, Qloo's) with its angle brackets escaped, so it can never open or close a tag. */
export const escapeAngles = (s: string): string => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON whose angle brackets are escaped, the way wrapQlooData escapes digests. */
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The line that closes turn 1 while fewer than MIN_OK_EVIDENCE bundles are ok, so the ANALYST knows
 * that reporting now ends in insufficient_evidence (V7) before it chooses between follow-ups and
 * submit_report. When turn 3 comes next (`followups` false: a wrap-up notice went out or one
 * response is left), it only states the V7 outcome, since submit_report is the only call left. Null
 * at or above the minimum, and with Qloo disabled, where V7 forces the signal whatever the ANALYST does.
 */
export function evidenceStatus(
  evidence: readonly Pick<Evidence, "id" | "status">[],
  qlooEnabled: boolean,
  followups: boolean,
): string | null {
  if (!qlooEnabled) return null;
  const ok = evidence.filter((e) => e.status === "ok").map((e) => e.id);
  if (ok.length >= MIN_OK_EVIDENCE) return null;
  const held = ok.length === 0 ? "no evidence bundle is ok" : `${ok.length} evidence bundle${ok.length === 1 ? " is" : "s are"} ok (${ok.join(", ")})`;
  if (!followups) {
    return (
      `EVIDENCE: ${held}. With fewer than ${MIN_OK_EVIDENCE} ok bundles the signal is forced to insufficient_evidence (V7); ` +
      "say in the report what the missing evidence leaves open."
    );
  }
  return (
    `EVIDENCE: ${held}. A report submitted with fewer than ${MIN_OK_EVIDENCE} ok bundles is forced to insufficient_evidence (V7), ` +
    "even when the priors look resolved. Before submit_report, follow up on the finding most likely to change the signal " +
    "with an available tool; submit now only if none can add an ok bundle."
  );
}

/** A code-written id a metric is about (R#, T#, a market, metro or area id); anything else is left out. */
const SUBJECT_ID = /^[\w:.,-]{1,48}$/;
const SUBJECTS_MAX = 3;

/**
 * Tools whose result is only refs for a later call. Turn 2 is one response and turn 3 allows only
 * submit_report, so nothing could use those refs before the report: such a lead cannot change it.
 */
const REF_ONLY_TOOLS: ReadonlySet<SkillId> = new Set(["resolve_entities", "find_tags"]);

/**
 * Tools a follow-up can run again on subjects an earlier call already read, by changing the input
 * fields named here (a NEAR_SUBSTITUTES pair the scan's share_of_taste covered, in other metros). A
 * call of any other tool on the same subjects can only repeat it.
 */
const CONTEXT_FIELDS: Partial<Readonly<Record<SkillId, string>>> = {
  share_of_taste: "ages or metros",
  rank_candidates: "contexts",
  sponsor_slate: "categories or markets",
  cross_domain: "domains or popularity_max",
};

/**
 * Findings whose metrics are about what the follow-up replaces, not what it runs on: WEAK_CATEGORY_FIT
 * cites the weak best fit and DROPPED_CANDIDATES the brands no score came back for, while their
 * suggestion asks for other brands added to the shortlist (named only in its reason). Their leads name
 * no subjects, so the line reads "suggests sponsor_slate" and the model reads the finding's reason.
 */
const REASON_LED_KINDS: ReadonlySet<FindingKind> = new Set(["WEAK_CATEGORY_FIT", "DROPPED_CANDIDATES"]);

/** Age buckets a metric is about are contexts of the follow-up, never its subjects. */
const AGE_BUCKETS: ReadonlySet<string> = new Set(AgeBucket.options);

/**
 * What a follow-up of a CONTEXT_FIELDS tool is about: entity and tag refs (the set, the candidates,
 * the signal tags). The markets, metros and areas its metrics name are contexts it reads them in, so
 * as subjects they would crowd out the tags a BLOCK_NEW_TAGS ranking takes as its signal.
 */
const isEntityOrTag = (id: string): boolean => isId("R", id) || isId("T", id);

/** A skill call that already ran (opening scan, wave 1), with the findings it issued. */
export interface RanCall {
  tool: SkillId;
  input: unknown;
  findingIds: readonly string[];
}

export interface FindingLeadsInput {
  findings: readonly Pick<Finding, "id" | "kind" | "severity" | "metricIds" | "suggestion">[];
  metrics: readonly Pick<Metric, "id" | "subjectRefs">[];
  qlooEnabled: boolean;
  /** The question's primary entity ref, left out of a lead's subjects when they name anything else. */
  primary: string | null;
  /** The calls that ran so far, so a lead never repeats one. */
  ran?: readonly RanCall[];
  available?: (tool: SkillId) => boolean;
}

/** Every string anywhere in a tool input: the refs and ids it names, among other values. */
function stringsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** 1 for EMPTY_RESULT, ranked after every other kind. */
const emptyRank = (finding: Pick<Finding, "kind">): number => (finding.kind === "EMPTY_RESULT" ? 1 : 0);
/** 1 for a lead that only changes the contexts of a call that ran, ranked after leads on new subjects. */
const varyRank = (lead: FollowupLead): number => (lead.vary === undefined ? 0 : 1);

/**
 * The run's findings worth an ANALYST PIVOT, for the loop's followupLeads: each suggests a tool this
 * build answers whose result a turn-2 call can use (not a ref-only tool), one per tool and subjects.
 * EMPTY_RESULT, a retry of a call that returned nothing, comes after the kinds director.md names as
 * pivots, and a lead that only changes contexts after one on new subjects; then the most severe
 * first, then the order they were issued. A lead's subjects are the ids its metrics are about, less
 * its contexts: age buckets always, and for a tool whose contexts can change (CONTEXT_FIELDS) every
 * id that is not an entity or tag ref. When a call of its tool already ran on all of those ids (its
 * contexts included), other than the call that
 * issued the finding (whose suggestion asks for that tool run differently), the lead is kept only
 * for a tool whose contexts can change (CONTEXT_FIELDS), saying what to change (`vary`), and only
 * when it names ids; otherwise it would repeat that call and is left out. A REASON_LED_KINDS lead
 * names no subjects and counts as no repeat, since the brands it runs on are in its reason, one per
 * finding. None with Qloo disabled, where every tool answers with no data.
 */
export function findingLeads(input: FindingLeadsInput): FollowupLead[] {
  if (!input.qlooEnabled) return [];
  const available = input.available ?? isSkillAvailable;
  const metrics = new Map(input.metrics.map((m) => [m.id, m]));
  const ran = (input.ran ?? []).map((call) => ({ ...call, named: stringsIn(call.input) }));
  const leads: FollowupLead[] = [];
  const seen = new Set<string>();
  const ranked = input.findings
    .map((finding, order) => ({ finding, order }))
    .sort(
      (a, b) =>
        emptyRank(a.finding) - emptyRank(b.finding) ||
        SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity] ||
        a.order - b.order,
    );
  for (const { finding } of ranked) {
    const tool = finding.suggestion?.tool;
    if (tool === undefined || REF_ONLY_TOOLS.has(tool) || !available(tool)) continue;
    if (REASON_LED_KINDS.has(finding.kind)) {
      leads.push({ findingId: finding.id, kind: finding.kind, tool, subjects: [] });
      continue;
    }
    const refs = [...new Set(finding.metricIds.flatMap((id) => metrics.get(id)?.subjectRefs ?? []))].filter((r) => SUBJECT_ID.test(r));
    const covered = ran.some((c) => c.tool === tool && !c.findingIds.includes(finding.id) && refs.every((r) => c.named.has(r)));
    const vary = covered && refs.length > 0 ? CONTEXT_FIELDS[tool] : undefined;
    if (covered && vary === undefined) continue;
    const named = refs.filter((r) => (CONTEXT_FIELDS[tool] === undefined ? !AGE_BUCKETS.has(r) : isEntityOrTag(r)));
    const others = named.filter((r) => r !== input.primary);
    const subjects = (others.length > 0 ? others : named).slice(0, SUBJECTS_MAX);
    const key = `${tool} ${subjects.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push({ findingId: finding.id, kind: finding.kind, tool, subjects, ...(vary === undefined ? {} : { vary }) });
  }
  // A stable sort: severity and issue order hold within each rank.
  return leads.sort((a, b) => emptyRank(a) - emptyRank(b) || varyRank(a) - varyRank(b));
}

function budgetBlock(input: RunContextInput): string {
  const { limits } = input;
  const s = (ms: number) => `${Math.round(ms / 1000)} s`;
  if (!input.qlooEnabled) {
    return [
      "BUDGET:",
      "- Qloo: disabled for this run. Every tool answers with no data, so the note can only be insufficient_evidence.",
      `- Time: wrap-up notice at ${s(limits.softMs)}, hard stop at ${s(limits.hardMs)}.`,
      `- Model responses: at most ${limits.modelResponses}, nudges and the CHECKER repair included.`,
    ].join("\n");
  }
  const scanCalls = [...input.scan.estimates.values()].reduce<number>((n, c) => n + (c ?? 0), 0);
  // A chained or deferred step is estimated once its inputs exist; until then its typical cost stands in.
  const { chained, deferred } = input.scan.plan;
  const chainedCalls = [...chained, ...deferred].reduce((n, c) => n + c.estimate, 0);
  return [
    "BUDGET:",
    `- Qloo network calls: ${limits.qlooCalls} for the run (warning at ${limits.qlooWarnAt}); cached requests are free.`,
    `- Opening scan: about ${scanCalls + chainedCalls} network calls of that budget.`,
    `- Turn 2: up to ${limits.followupCalls} network calls and about ${s(limits.followupMs)}.`,
    `- Time: wrap-up notice at ${s(limits.softMs)}, hard stop at ${s(limits.hardMs)}.`,
    `- Model responses: at most ${limits.modelResponses}, nudges and the CHECKER repair included.`,
  ].join("\n");
}

function registryBlock(registry: RunRegistry): string {
  const rows = registry.registryTable().map((r) => ({
    ref: r.ref,
    name: sanitizeQlooName(r.name, NAME_MAX),
    type: r.type,
    disambiguation: r.disambiguation === null ? null : sanitizeQlooText(r.disambiguation, NAME_MAX),
    popularity: r.popularity,
  }));
  return rows.length === 0 ? "REGISTRY: empty (no entity resolved)" : `REGISTRY:\n${rows.map((r) => safeJson(r)).join("\n")}`;
}

/**
 * The question's metro's neighbourhoods, or none: a metro's full list runs to hundreds of tokens
 * (Austin's planning areas), so it is sent only to a run whose question names a gazetteer metro. A
 * metro with more than AREAS_MAX areas lists the area the question names first, then the areas nearest
 * it (nearest the city centre when it names none), up to AREAS_MAX; the LIFT digest names its top areas
 * by id, and every area id of the metro stays valid in a tool call.
 */
function areasBlock(geo: GeoApi, metro: MetroId | null, areaText: string | null): string {
  if (metro === null) return "AREAS: none (the question names no gazetteer metro, so no area tool applies)";
  const all = geo.neighbourhoods(metro);
  const named = areaText === null ? null : geo.matchNeighbourhood(metro, areaText);
  const listed = listedAreas(geo, metro, named);
  const areas = listed.map((n) => `${n.id} (${escapeAngles(n.name)})`);
  const more =
    all.length > listed.length
      ? ` (${listed.length} of ${all.length}, ${named === null ? "nearest the city centre" : "the question's area and those nearest it"}; the LIFT digest names its top areas by id, and any area id of ${metro} is valid)`
      : "";
  const asked = areaText?.trim() ?? "";
  // A name the gazetteer cannot match gets no number of its own: the note must say so, never answer another area for it.
  const unmatched =
    asked !== "" && named === null && all.length > 0
      ? `\nAREA NOT ON THE MAP: the question names "${escapeAngles(asked)}", which matches no ${metro} area id, so it has no lift, rank ` +
        "or competitor count of its own. Say so plainly near the top of the note, then answer with the areas you can measure; never present another area as the one the question names."
      : "";
  return `AREAS (${metro})${more}: ${areas.length === 0 ? NONE : areas.join("; ")}${unmatched}`;
}

/**
 * MARKETS with their labels, so a city CLERK listed maps to its id, grouped by tier, so a question
 * that asks for secondary markets can be answered in them ("major: nashville (Nashville, TN), …;
 * secondary: …"). The location desk reads metro and city contexts only in the gazetteer metros, so it
 * gets those alone.
 */
function marketsBlock(input: RunContextInput): string {
  const metros: readonly string[] = input.geo.metros();
  const all = input.markets ?? MARKET_CATALOGUE.filter((m) => metros.includes(m.id));
  const listed = input.intent.pillar === "location" ? all.filter((m) => isGazetteerMetro(m.id)) : all;
  if (listed.length === 0) return `MARKETS: ${NONE}`;
  const groups = [...MARKET_TIERS, null].flatMap((tier) => {
    const of = listed.filter((m) => marketTier(m.id) === tier);
    return of.length === 0 ? [] : [`${tier ?? "other"}: ${of.map(describeMarket).join(", ")}`];
  });
  return `MARKETS: ${groups.join("; ")}`;
}

function scanBlock(input: RunContextInput): string {
  if (!input.qlooEnabled) return "OPENING SCAN: none (Qloo is disabled for this run).";
  const { plan, estimates } = input.scan;
  const lines = plan.steps.map((step) => {
    const calls = estimates.get(step.toolCallId);
    const cost = calls === null || calls === undefined ? "cost unknown" : `about ${calls} network calls`;
    return `- ${describeScanStep(step)}: running now, ${cost}.`;
  });
  for (const c of plan.chained) lines.push(`- ${describeChainedStep(c)}: runs once ${toolLabel(c.after)} returns, about ${c.estimate} network calls.`);
  for (const d of plan.deferred) {
    lines.push(`- ${describeDeferredStep(d)}: runs once your wave-1 calls return, about ${d.estimate} network calls; with no such peer from them it reads the scan's own neighbours of that type, and is skipped without either.`);
  }
  for (const s of plan.skipped) lines.push(`- ${toolLabel(s.tool)}: skipped, ${s.reason}.`);
  if (plan.unavailable.length > 0) lines.push(`- Not available in this build: ${plan.unavailable.map(toolLabel).join(", ")}.`);
  const head =
    plan.steps.length + plan.chained.length + plan.deferred.length > 0
      ? "OPENING SCAN (its digests arrive with your wave-1 results; do not repeat these calls):"
      : "OPENING SCAN: nothing runs for this question.";
  return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
}

export function buildRunContext(input: RunContextInput): string {
  const { intent } = input;
  const unavailable = input.unavailable.length === 0 ? "none" : input.unavailable.map(toolLabel).join(", ");
  const blocks = [
    `TODAY: ${input.today}`,
    `MODE: ${input.mode}`,
    `DESK: ${PILLAR_LABEL[intent.pillar]}`,
    `JOB: ${intent.job} (${JOB_MNEMONIC[intent.job]}), compiled to ${escapeAngles(intent.mnemonic)}`,
    budgetBlock(input),
    `CLERK:\n${safeJson(intent)}`,
    registryBlock(input.registry),
    marketsBlock(input),
    audiencesBlock(audienceSegmentsFor(intent.pillar, input.audiences ?? []), NONE),
    areasBlock(input.geo, intent.geo.metro, intent.geo.area),
    scanBlock(input),
    `UNAVAILABLE TOOLS: ${unavailable}`,
    `CASE SUMMARY: ${input.caseSummary === null ? "none" : escapeAngles(input.caseSummary)}`,
    wrapQuestion(input.question),
  ];
  return blocks.join("\n\n");
}
