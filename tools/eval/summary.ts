// What the eval publishes (SPEC §6.7, D29): apps/web/content/eval-summary.json in the EvalSummary schema,
// which /method#eval and the launchpad read, and eval/SUMMARY.md with the metric definitions, the
// adversarial handling, the Reality Check table, n and the caveats. Aggregates and derived ranks only:
// no affinity or popularity value of an entity, no entity id, no request id, and no name (questions and
// cases go by their registered ids). Every number keeps at most two decimals (pnpm guard's decimal rule
// covers apps/web/content). Both files are written only by `run.ts … --write-summary`, from the raw
// records of one eval directory, and each is checked before it is written.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GHOST_HONESTY_LINE } from "@ct/contracts";
import { ordinal } from "../../apps/web/components/launchpad/eval-summary";
import { formatEvalValue, parseEvalSummary, type EvalMetric, type EvalSummary } from "../../apps/web/components/method/eval-summary";
import { METRIC_DEFINITIONS, type EvalMetrics, type Measure, type MetricResult } from "./metrics";
import { REPO_ROOT, type EvalRecordSet, type Manifest } from "./records";

export const SUMMARY_FILES = {
  json: path.join(REPO_ROOT, "apps", "web", "content", "eval-summary.json"),
  md: path.join(REPO_ROOT, "eval", "SUMMARY.md"),
} as const;

/** Two decimals at most: the guard's rule for page copy, and all the precision the aggregates carry. */
export const round2 = (x: number): number => Math.round(x * 100) / 100;

const roundOrNull = (m: Measure | null): number | null => (m === null || m.value === null ? null : round2(m.value));

/** What the summary says about the eval as a whole, beside the metrics. */
export interface SummaryMeta {
  /** When the eval ran: the date of its last record (YYYY-MM-DD). */
  ranAt: string;
  /** The ANALYST model both arms used. */
  model: string;
  stamp: string;
  registration: Manifest["registration"];
  /** The caveats registered in eval/reality_cases.json, printed as they stand. */
  realityCaveats: readonly string[];
}

/** The date of the newest record: when the eval (as summarised) last ran. */
export function ranAtOf(records: EvalRecordSet): string | null {
  const times = [...records.grounded, ...records.ghost, ...records.reality].map((r) => r.finishedAt).sort();
  return times.at(-1)?.slice(0, 10) ?? null;
}

// apps/web/content/eval-summary.json --------------------------------------------------------------------

const armNote = (m: MetricResult): string | null => {
  const parts = [m.grounded === null ? null : `Culture Terminal: ${m.grounded.basis}`, m.ghost === null ? null : `model alone: ${m.ghost.basis}`];
  const text = parts.filter((p): p is string => p !== null).join(" · ");
  return text === "" ? null : text;
};

/** The EvalSummary: every metric with a value on either side (one with none is left out, as the page would print dashes). */
export function buildEvalSummary(m: EvalMetrics, meta: Pick<SummaryMeta, "ranAt" | "model">): EvalSummary {
  const metrics: EvalMetric[] = m.metrics
    .map((r) => ({ id: r.id, label: r.label, unit: r.unit, grounded: roundOrNull(r.grounded), ghost: roundOrNull(r.ghost), note: armNote(r) }))
    .filter((r) => r.grounded !== null || r.ghost !== null);
  const rc = m.reality;
  return {
    ranAt: meta.ranAt,
    model: meta.model,
    questions: { total: m.questions.total, adversarial: m.questions.adversarial },
    metrics,
    realityCheck:
      rc === null
        ? null
        : {
            cases: rc.cases,
            medianPercentile: roundOrNull(rc.median),
            ghostHitRate: roundOrNull(rc.ghostHitRate),
            note: realityNote(m),
          },
  };
}

const percentileText = (value: number | null): string => (value === null ? "not measured" : `${ordinal(Math.round(value * 100))} percentile`);

function realityNote(m: EvalMetrics): string | null {
  const rc = m.reality;
  if (rc === null) return null;
  const parts = [
    `${rc.median.basis}; random 50th`,
    `without the showcase-seed cases: ${percentileText(rc.medianWithoutShowcase.value)} (n = ${rc.medianWithoutShowcase.n})`,
    `GHOST hits: ${rc.ghostHitRate.basis}`,
  ];
  if (rc.comedianChance.value !== null) parts.push(`comedian cases: GHOST hit ${rc.comedianHits.basis}, ${Math.round(rc.comedianChance.value * 100)}% expected by chance`);
  if (rc.comedianTies.value !== null) parts.push(`${rc.comedianTies.basis} in the comedian cases tied, pulling them towards the 50th`);
  parts.push("GHOST may know choices made public before its training data ends, so its hit rate partly measures recall");
  return `${parts.join("; ")}.`;
}

// Raw values ------------------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// pnpm guard's decimal rule: three or more fractional digits look like a copied Qloo score.
const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;
const RAW_KEYS = new Set(["requestId", "requestIds", "entityId", "entity_id", "entityIds", "qlooCallId", "qlooCallIds", "originRunId"]);
/** "req 9f2a…" in an exhibit's source line. */
const SOURCE_REQUEST = /\breq ([A-Za-z0-9_-]{6,})/g;

/**
 * The ids the raw records hold that must never be published: request ids, Qloo entity ids and call ids,
 * wherever they sit (a report's source lines included). Short values are left out, as they could match by chance.
 */
export function rawIds(records: EvalRecordSet): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === "string") {
      if (key !== null && RAW_KEYS.has(key) && value.length >= 6) found.add(value);
      if (key === "sourceLine") for (const m of value.matchAll(SOURCE_REQUEST)) found.add(m[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(records, null);
  return found;
}

/** Why a text may not be published: a UUID, a decimal of three or more places, or one of the raw ids. Empty when clean. */
export function rawValueProblems(text: string, ids: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  if (UUID.test(text)) problems.push("a UUID-shaped value (D29)");
  const decimal = LONG_DECIMAL.exec(text);
  if (decimal) problems.push(`a decimal with three or more places (${decimal[0]})`);
  const leaked = [...ids].filter((id) => text.includes(id)).length;
  if (leaked > 0) problems.push(`${leaked} id(s) from the raw records (request, entity or call ids)`);
  return problems;
}

/** The EvalSummary as written: validated by the page's own parser and checked for raw values, or it throws. */
export function renderEvalSummaryJson(summary: EvalSummary, ids: ReadonlySet<string> = new Set()): string {
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  const state = parseEvalSummary(text);
  if (state.state !== "ok") throw new Error(`the eval summary does not parse as /method reads it: ${state.state === "invalid" ? state.reason : state.state}`);
  const problems = rawValueProblems(text, ids);
  if (problems.length > 0) throw new Error(`the eval summary would publish ${problems.join(", ")}`);
  return text;
}

// eval/SUMMARY.md -------------------------------------------------------------------------------------------

const NOT_APPLICABLE = "n/a";
const cell = (m: Measure | null, r: MetricResult): string => (m === null ? NOT_APPLICABLE : formatEvalValue(m.value === null ? null : round2(m.value), r.unit).replace("–", "not measured"));
const yesNo = (b: boolean | null): string => (b === null ? "–" : b ? "yes" : "no");
const words = (id: string): string => id.replace(/_/g, " ");
const list = (ids: readonly string[]): string => ids.join(", ");

function resultsTable(m: EvalMetrics): string[] {
  const rows = m.metrics.map((r) => {
    const over = [r.grounded === null ? null : `Culture Terminal: ${r.grounded.basis}`, r.ghost === null ? null : `model alone: ${r.ghost.basis}`]
      .filter((p): p is string => p !== null)
      .join("; ");
    return `| ${r.label} | ${cell(r.grounded, r)} | ${cell(r.ghost, r)} | ${over} |`;
  });
  return ["| Measure | Culture Terminal | Model alone (GHOST) | Over |", "|---|---|---|---|", ...rows];
}

function adversarialTable(m: EvalMetrics): string[] {
  if (m.adversarial.length === 0) return ["No adversarial question has a grounded run yet."];
  const rows = m.adversarial.map(
    (o) => `| ${o.questionId} | ${words(o.kind)} | refuse: ${words(o.expected)} | ${o.why} | ${o.qlooCalls} | ${o.correct ? "yes" : "no"} |`,
  );
  return ["| Question | Kind | Registered handling | Outcome | Qloo calls | Handled |", "|---|---|---|---|---|---|", ...rows];
}

function realitySection(m: EvalMetrics): string[] {
  const rc = m.reality;
  if (rc === null) return ["The Reality Check has not run in this eval."];
  const rows = rc.rows.map(
    (r) =>
      `| ${r.caseId} | ${words(r.kind)} | ${r.showcase ?? "–"} | ${r.resolved ? "yes" : "no"} | ${r.percentile === null ? "not scored" : ordinal(Math.round(r.percentile * 100))} | ${yesNo(r.ghostHit)} | ${r.chanceHit === null ? "–" : `${Math.round(r.chanceHit * 100)}%`} |`,
  );
  const out = [
    "| Case | Kind | Showcase seed | Resolved | Real choice's percentile | GHOST hit | Chance of a hit |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `- **Median percentile of the real choice:** ${percentileText(rc.median.value)} (${rc.median.basis}; random expectation the 50th).`,
    `- **Without the showcase-seed cases:** ${percentileText(rc.medianWithoutShowcase.value)} (n = ${rc.medianWithoutShowcase.n}).`,
    `- **GHOST hit rate:** ${rc.ghostHitRate.value === null ? "not measured" : `${Math.round(rc.ghostHitRate.value * 100)}%`} (${rc.ghostHitRate.basis}; a comedian hit is near certain by chance). ` +
      "GHOST may know choices made public before its training data ends, so this rate partly measures recall rather than judgement of taste.",
  ];
  if (rc.comedianChance.value !== null) {
    out.push(
      `- **Comedian cases:** GHOST named a booked market in ${rc.comedianHits.basis}; a booked market lands in GHOST's top five by chance ${Math.round(rc.comedianChance.value * 100)}% of the time on average (${rc.comedianChance.basis}).`,
    );
  }
  if (rc.comedianTies.value !== null) {
    out.push(
      `- **Tied comparisons:** ${rc.comedianTies.basis} in the comedian cases tied (${Math.round(rc.comedianTies.value * 100)}%): a three-comedian panel gives a market three levels, which pulls a case towards the 50th. A case where every comparison ties is not scored.`,
    );
  }
  if (rc.unresolved > 0) out.push(`- **Unresolved:** ${rc.unresolved} case(s) did not resolve exactly in Qloo and are reported, not replaced.`);
  if (rc.cases < rc.registered) out.push(`- **Not run:** ${rc.registered - rc.cases} of the ${rc.registered} registered cases.`);
  return out;
}

function coverageCaveats(m: EvalMetrics): string[] {
  const c = m.coverage;
  const out: string[] = [];
  if (c.noGrounded.length > 0) out.push(`No grounded run: ${list(c.noGrounded)}.`);
  if (c.noGhost.length > 0) out.push(`No GHOST answer: ${list(c.noGhost)}.`);
  if (c.ghostRefused.length > 0) out.push(`The API refused GHOST an answer: ${list(c.ghostRefused)}.`);
  if (c.unfinished.length > 0) out.push(`Primary runs that did not finish: ${c.unfinished.map((u) => `${u.questionId} (${u.status})`).join(", ")}.`);
  if (c.noDiff.length > 0) out.push(`No diff, so no overlap, specificity or popularity for: ${list(c.noDiff)}.`);
  return out;
}

const usd = (x: number): string => `$${x.toFixed(2)}`;
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The spend line: what every attempt spent (the spend tally, so a failed attempt that a rerun overwrote
 * and a unit that threw still count, the latter at its worst case), then what the answers that count cost.
 */
function spendLine(s: EvalMetrics["spend"]): string {
  const arms = `grounded ${usd(s.usd.grounded)}, GHOST ${usd(s.usd.ghost)}, Reality Check ${usd(s.usd.reality)}`;
  const qloo = `grounded ${s.qloo.groundedTotal} (${s.qloo.groundedNetwork} to the network), GHOST pick lookups ${s.qloo.ghostLookups}, Reality Check ${s.qloo.reality}`;
  const a = s.attempts;
  if (a === null) return `- **Spend:** ${usd(s.usd.total)} measured LLM spend (${arms}). Qloo calls: ${qloo}.`;
  const total =
    a.unknown === 0
      ? `${usd(a.totalUsd)} measured LLM spend over every attempt (${count(a.units, "unit")} run, failed attempts included)`
      : `${usd(a.totalUsd)} LLM spend over every attempt (${count(a.units, "unit")} run, failed attempts included): ${usd(a.measuredUsd)} measured, ` +
        `plus the worst case of ${count(a.unknown, "unit")} whose cost is unknown`;
  const calls = `${a.qlooCalls} over every attempt${a.qlooUnknown === 0 ? "" : `, not counting ${count(a.qlooUnknown, "unit")} that threw`}`;
  return `- **Spend:** ${total}. The answers that count cost ${usd(s.usd.total)} (${arms}). Qloo calls of those answers: ${qloo}; ${calls}.`;
}

/** eval/SUMMARY.md: a plain Markdown report a reader can check against the definitions. */
export function renderSummaryMarkdown(m: EvalMetrics, meta: SummaryMeta): string {
  const { registration: reg } = meta;
  const commit = reg.commit === null ? "as they stood, not yet committed when the eval ran" : `commit \`${reg.commit}\`${reg.dirty ? ", with uncommitted changes" : ""}`;
  const s = m.spend;
  const lines = [
    "# Eval summary",
    "",
    `Written by \`tools/eval/run.ts --write-summary\` from the raw outputs of eval \`${meta.stamp}\`, which stay in \`.private/eval/\` and are never committed. ` +
      "Aggregates and derived ranks only (D29): no Qloo value of any entity, no entity id, no request id. Questions and cases go by their ids in `eval/questions.json` and `eval/reality_cases.json`.",
    "",
    `- **Ran:** ${meta.ranAt}, both arms on \`${meta.model}\` (D23: GHOST is the same model with no tools).`,
    `- **Registered inputs:** \`eval/questions.json\` and \`eval/reality_cases.json\`, ${commit}.`,
    `- **Questions:** ${m.questions.total} (${m.questions.core} core, ${m.questions.adversarial} adversarial); ${count(s.runs.grounded, "grounded run")}, ` +
      `${count(s.runs.reruns, "rerun")}, ${count(s.runs.ghost, "GHOST answer")}, ${count(s.runs.reality, "Reality Check case")}.`,
    spendLine(s),
    "",
    `> ${GHOST_HONESTY_LINE}`,
    "",
    "## Results",
    "",
    ...resultsTable(m),
    "",
    "## Adversarial handling",
    "",
    ...adversarialTable(m),
    "",
    "## Reality Check",
    "",
    ...realitySection(m),
    "",
    "## Definitions",
    "",
    ...Object.entries(METRIC_DEFINITIONS).map(([id, d]) => `- **${d.label}** (\`${id}\`): ${d.definition}`),
    "",
    "## Caveats",
    "",
    "- **Small n.** Twelve core and four adversarial questions, twelve Reality Check cases: every figure is stated with its n and none claims significance.",
    "- **Warm cache.** Qloo answers already in the shared cache count as calls but cost no network time, so latency and network calls depend on what ran before.",
    "- **Same graph.** Overlap, resolvability and popularity are measured against Qloo's own taste graph, not against outcomes.",
    ...meta.realityCaveats.map((c) => `- ${c}`),
    ...coverageCaveats(m).map((c) => `- ${c}`),
    "",
  ];
  return lines.join("\n");
}

/** The Markdown as written: checked for raw values, or it throws. */
export function checkedMarkdown(text: string, ids: ReadonlySet<string> = new Set()): string {
  const problems = rawValueProblems(text, ids);
  if (problems.length > 0) throw new Error(`eval/SUMMARY.md would publish ${problems.join(", ")}`);
  return text;
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
}

/** Renders and checks both files first, then writes them: a summary that fails a check writes neither. */
export function writeSummaries(m: EvalMetrics, meta: SummaryMeta, records: EvalRecordSet, files: { json: string; md: string } = SUMMARY_FILES): void {
  const ids = rawIds(records);
  const json = renderEvalSummaryJson(buildEvalSummary(m, meta), ids);
  const md = checkedMarkdown(renderSummaryMarkdown(m, meta), ids);
  writeText(files.json, json);
  writeText(files.md, md);
}
