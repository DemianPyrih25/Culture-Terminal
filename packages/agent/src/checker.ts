import {
  findMalformedTokens,
  isId,
  metricToken,
  ReportDraft,
  tokenizeProse,
  VERDICT_TAG_LIMITS,
  verdictTagProblems,
  verdictTagWords,
  WINDOW_TOKEN,
  WINDOW_TOKEN_RE,
  type EntityRegistry,
  type MetricId,
  type NumbersTraced,
  type ProseSegment,
  type ReportDraftShape,
  type Signal,
  type SubmitPlanInputShape,
  type ValidationIssue,
  type ValidationRule,
} from "@ct/contracts";
import type { z } from "zod";
import { indexSnapshot, type LedgerLookup, type LedgerSnapshot } from "./ledger";
import {
  datasetMeasuresDemographics,
  demographicEvidence,
  demographicTerms,
  measuresDemographics,
  namePatterns,
} from "./report/demographics";
import { wordList } from "./report/format";
import { areaAliases, mergedAgeBuckets, numberWords, numeralNames, numeralValues, numeralViolations } from "./report/numerals";
import { phraseHits, type PhraseHit } from "./report/phrases";
import {
  argumentUnit,
  citedIds,
  draftProse,
  insertAfterMetricToken,
  metricTokenOccurrences,
  tokenProblems,
  type ProseField,
  type ProseRole,
} from "./tokens";

/**
 * CHECKER (SPEC §6.2, D23): code-only validation of a submit_report draft, rules V1–V10. It takes
 * the draft as the strict tool guarantees it (structure only) and enforces what strict mode strips:
 * id formats (V1) and lengths and counts (V9). V7 and V8 are fixed by code, never rejected. A
 * rejection buys one repair turn; on the second attempt every rejection is downgraded to a warning
 * and the report is accepted (each warning costs confidence, §6.4). The verdict tag names the finding
 * in a few words and is judged with the headline (V4, V9, V10); on the second attempt code cuts or
 * drops it instead (forced), since the brief prints the signal label in its place, and it costs nothing.
 */

/** Below this many ok evidence bundles the signal is forced to insufficient_evidence (V7). */
export const MIN_OK_EVIDENCE = 3;
/**
 * V3 rejects when a report has more bare numbers than this; fewer are warnings. Zero: any bare number
 * buys the repair turn, so none reaches the note on the first attempt. A typed number is never proven
 * to be the code's own constant: "top 20" names a list size, but "13 of 20" in the same metric is Qloo's
 * count, and a phrase such as "not in the city top 30" is itself a claim about the data.
 */
export const V3_REJECT_ABOVE = 0;
/** The draft path of the verdict tag, a label the CHECKER judges apart from the prose fields. */
const TAG_PATH = "verdict_tag";

export interface CheckReportInput<D extends ReportDraftShape = ReportDraftShape> {
  draft: D;
  plan: SubmitPlanInputShape | null;
  ledger: LedgerSnapshot;
  qlooEnabled: boolean;
  /**
   * The run registry: digits inside registered names are allowed outside tokens (V3), and words
   * inside them are never read as demographic claims (V10).
   */
  registry?: Pick<EntityRegistry, "entities" | "tags">;
  /** The gazetteer area names of the question's metro: digits inside them are allowed outside tokens (V3). */
  areas?: readonly string[];
  /** 2 for the draft submitted in the repair turn: rejections become warnings. Defaults to 1. */
  attempt?: 1 | 2;
}

export interface CheckResult<D extends ReportDraftShape = ReportDraftShape> {
  /** Ordered by rule, then by position in the draft. */
  issues: ValidationIssue[];
  numbersTraced: NumbersTraced;
  /** Set when V7 changed the signal. */
  forcedSignal?: Signal;
  /** The draft with V7, V8 and the last attempt's verdict-tag trim applied: what the report is assembled from. */
  patchedDraft: D;
  /** True when a repair turn is required. Always false on attempt 2. */
  reject: boolean;
  /** Investment-advice phrases found by V4, for the `validation` event. */
  adviceTerms: number;
}

type Blocking = "reject" | "warn";

function issue(
  rule: ValidationRule,
  action: ValidationIssue["action"],
  message: string,
  path: string | null,
  subjects: string[] = [],
): ValidationIssue {
  return { rule, action, message, path, subjects };
}

export function checkReport<D extends ReportDraftShape>(input: CheckReportInput<D>): CheckResult<D> {
  const { draft, plan, ledger, qlooEnabled } = input;
  const blocking: Blocking = (input.attempt ?? 1) === 1 ? "reject" : "warn";
  const lookup = indexSnapshot(ledger);
  const fields = draftProse(draft);
  const registered = [
    ...(input.registry?.entities() ?? []).map((e) => e.name),
    ...(input.registry?.tags() ?? []).map((t) => t.name),
  ];
  const names = numeralNames([...registered, ...areaAliases(input.areas ?? [])]);
  // Follow-up questions are parameters of a new run, not claims: their numbers are not V3's concern.
  const numerals = fields
    .filter((field) => field.role !== "followup")
    .map((field) => ({ field, bare: numeralViolations(field.text, names) }));
  const bareCount = numerals.reduce((n, x) => n + x.bare.length, 0);

  const patched = structuredClone(draft) as ReportDraftShape;
  const forced = forceSignal(patched, ledger, qlooEnabled);
  // The verdict tag is judged (V4, V9, V10) while a repair can still rewrite it. On the last attempt
  // code cuts or drops it instead, and once V7 has dropped it there is nothing left to judge.
  const tagSettled = blocking === "warn" || forced !== null;
  const phrases = [
    ...fields.map((field) => ({ path: field.path, hits: phraseHits(field.text) })),
    ...(tagSettled ? [] : [{ path: TAG_PATH, hits: phraseHits(draft.verdict_tag) }]),
  ];
  const unmeasured = unmeasuredDemographics(draft, lookup, demographicEvidence(ledger.metrics), namePatterns(registered));
  // The tag names the finding the headline states, so V10 judges it with the headline's part.
  const tag: DemographicField = { path: TAG_PATH, role: "claim", unit: "headline", text: draft.verdict_tag };

  const issues: ValidationIssue[] = [
    ...schemaIssues(draft, blocking).filter((i) => !tagSettled || i.path !== TAG_PATH),
    ...(tagSettled ? [] : tagNumberIssues(draft.verdict_tag, blocking)),
    ...referenceIssues(draft, plan, lookup, blocking),
    ...fields.flatMap((f) => tokenIssues(f, lookup, blocking)),
    ...numeralIssues(numerals, lookup, bareCount > V3_REJECT_ABOVE ? blocking : "warn"),
    ...phrases.flatMap(({ path, hits }) => phraseIssues(path, hits, blocking)),
    ...citationIssues(draft, plan, blocking),
    ...claimUnits(draft, fields).flatMap((u) => affinityIssues(u, lookup, blocking)),
    ...demographicIssues(tagSettled ? fields : [...fields, tag], unmeasured, blocking),
  ];

  if (forced) issues.push(forced);
  else if (tagSettled) issues.push(...settleVerdictTag(patched, unmeasured(tag)));
  issues.push(...injectWindows(claimUnits(patched, draftProse(patched)), ledger));
  issues.sort((a, b) => a.rule.localeCompare(b.rule, "en", { numeric: true }));

  return {
    issues,
    numbersTraced: traceNumbers(draftProse(patched), lookup, bareCount),
    ...(forced ? { forcedSignal: patched.signal } : {}),
    patchedDraft: patched as D,
    reject: issues.some((i) => i.action === "reject"),
    adviceTerms: phrases.reduce((n, x) => n + x.hits.filter((h) => h.rule.advice).length, 0),
  };
}

// V1 (formats) and V9 (lengths and counts): the limits strict mode strips --------------------------

function schemaIssues(draft: ReportDraftShape, blocking: Blocking): ValidationIssue[] {
  const parsed = ReportDraft.safeParse(draft);
  if (parsed.success) return [];
  return parsed.error.issues.map((zi) => {
    const path = formatPath(zi.path);
    const value = valueAt(draft, zi.path);
    if (zi.code === "invalid_format") {
      const id = String(value);
      return issue("V1", blocking, `${path}: "${id}" is not a well-formed id (${zi.message}).`, path, [id]);
    }
    return issue("V9", blocking, limitMessage(path, zi, value), path);
  });
}

function limitMessage(path: string, zi: z.core.$ZodIssue, value: unknown): string {
  // The verdict tag's rule speaks for itself ("verdict_tag has 7 words, not 2 to 5."), except digits.
  if (zi.code === "custom" && path === TAG_PATH && zi.message === "contains digits") return tagDigitsMessage(String(value));
  if (zi.code === "custom") return `${path} ${zi.message}.`;
  const size =
    typeof value === "string" ? `${value.length} characters` : Array.isArray(value) ? `${value.length} items` : null;
  if (zi.code === "too_big" && size) return `${path} has ${size}; at most ${String(zi.maximum)} are allowed.`;
  if (zi.code === "too_small" && value === "") return `${path} is empty.`;
  if (zi.code === "too_small" && size) return `${path} has ${size}; at least ${String(zi.minimum)} are required.`;
  return `${path}: ${zi.message}`;
}

/** What a verdict tag holds instead of a number, for V9's message on one. */
const TAG_IN_WORDS =
  'a tag names the finding in words ("Clear lead", "Taste island"); the headline carries ranks, counts and ages with their {{M#}} tokens.';

/**
 * V9 on digits in the verdict tag names the words that carry them: a tag is a label printed without
 * its tokens, so a rank, count or age range in it can never be traced (code drops it on the last attempt).
 */
function tagDigitsMessage(tag: string): string {
  const words = verdictTagWords(tag).filter((w) => /\d/.test(w));
  const listed = words.map((w) => `"${w.replace(/[,;:.!?]+$/u, "")}"`).join(", ");
  return `${TAG_PATH} contains digits (${listed}): ${TAG_IN_WORDS}`;
}

/**
 * V9 on a number above ten spelled out in the verdict tag ("Last of twelve"): as untraceable as its
 * digits. The contracts' tag rule (verdictTagProblems) reads digits only, so the CHECKER adds it.
 */
function tagNumberIssues(tag: string, blocking: Blocking): ValidationIssue[] {
  const words = numberWords(tag);
  if (words.length === 0) return [];
  const listed = words.map((w) => `"${w}"`).join(", ");
  return [issue("V9", blocking, `${TAG_PATH} contains a number (${listed}): ${TAG_IN_WORDS}`, TAG_PATH, words)];
}

/** The verdict tag's rule as the CHECKER reads it: the contracts' (verdictTagProblems), and no number spelled out. */
function tagProblems(tag: string): string[] {
  return [...verdictTagProblems(tag), ...(numberWords(tag).length > 0 ? ["contains a number"] : [])];
}

// V1: every referenced id exists in this run ---------------------------------------------------------

function referenceIssues(
  draft: ReportDraftShape,
  plan: SubmitPlanInputShape | null,
  ledger: LedgerLookup,
  blocking: Blocking,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const unknown = (path: string, ids: readonly string[], what: string) => {
    if (ids.length === 0) return;
    const message = `${path} cites ${what} that do not exist in this run: ${ids.join(", ")}.`;
    out.push(issue("V1", blocking, message, path, [...ids]));
  };
  // Ill-formed ids are reported once, as formats; only well-formed ids are looked up.
  const missingMetrics = (ids: readonly string[]) => ids.filter((id) => isId("M", id) && !ledger.metric(id));
  const missingEvidence = (ids: readonly string[]) => ids.filter((id) => isId("E", id) && !ledger.evidence(id));

  const planned = new Set(plan?.hypotheses.map((h) => h.id) ?? []);
  const judged = new Set<string>();
  draft.hypothesis_verdicts.forEach((v, i) => {
    const path = `hypothesis_verdicts[${i}].hypothesis_id`;
    if (isId("H", v.hypothesis_id) && !planned.has(v.hypothesis_id)) {
      out.push(issue("V1", blocking, `${path} ${v.hypothesis_id} is not a planned hypothesis.`, path, [v.hypothesis_id]));
    }
    if (judged.has(v.hypothesis_id)) {
      out.push(issue("V1", blocking, `${path}: ${v.hypothesis_id} has more than one verdict.`, path, [v.hypothesis_id]));
    }
    judged.add(v.hypothesis_id);
    unknown(`hypothesis_verdicts[${i}].metric_ids`, missingMetrics(v.metric_ids), "metrics");
  });

  const argumentIds = new Set<string>();
  draft.arguments.forEach((a, i) => {
    if (argumentIds.has(a.id)) {
      const path = `arguments[${i}].id`;
      out.push(issue("V1", blocking, `${path} ${a.id} is used by another argument.`, path, [a.id]));
    }
    argumentIds.add(a.id);
    unknown(`arguments[${i}].metric_ids`, missingMetrics(a.metric_ids), "metrics");
    unknown(`arguments[${i}].evidence_ids`, missingEvidence(a.evidence_ids), "evidence bundles");
  });

  draft.exhibits.forEach((e, i) => {
    if (isId("D", e.dataset_id) && !ledger.dataset(e.dataset_id)) {
      unknown(`exhibits[${i}].dataset_id`, [e.dataset_id], "datasets");
    }
  });
  draft.bear_case.forEach((b, i) => unknown(`bear_case[${i}].metric_ids`, missingMetrics(b.metric_ids), "metrics"));
  draft.recommendations.forEach((r, i) => {
    const missing = r.argument_ids.filter((id) => isId("A", id) && !argumentIds.has(id));
    unknown(`recommendations[${i}].argument_ids`, missing, "arguments");
  });
  return out;
}

// V2: every token resolves -------------------------------------------------------------------------------

function tokenIssues(field: ProseField, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  if (field.role === "followup") return followupTokenIssues(field, blocking);
  const p = tokenProblems(field.text, ledger);
  const out: ValidationIssue[] = [];
  const unresolved = [...p.metrics.map((id) => `{{${id}}}`), ...p.evidence.map((id) => `[${id}]`)];
  if (unresolved.length > 0) {
    const message = `${field.path}: tokens that do not resolve in this run: ${unresolved.join(", ")}.`;
    out.push(issue("V2", blocking, message, field.path, [...p.metrics, ...p.evidence]));
  }
  if (p.malformed.length > 0) {
    const listed = p.malformed.map((m) => `"${m}"`).join(", ");
    const message = `${field.path}: malformed tokens ${listed}; write {{M12}} and one [E4] per bracket.`;
    out.push(issue("V2", blocking, message, field.path, p.malformed));
  }
  return out;
}

/** A next move launches a child run whose ledger has other ids, so any token in it is an issue. */
function followupTokenIssues(field: ProseField, blocking: Blocking): ValidationIssue[] {
  const tokens = [
    ...tokenizeProse(field.text).flatMap((s) => (s.kind === "text" ? [] : [tokenText(s)])),
    ...findMalformedTokens(field.text),
  ];
  if (tokens.length === 0) return [];
  const message =
    `${field.path}: a next move starts a new run, where ${tokens.join(", ")} mean nothing; ` +
    "write it in plain words without tokens.";
  return [issue("V2", blocking, message, field.path, tokens)];
}

function tokenText(segment: Exclude<ProseSegment, { kind: "text" }>): string {
  if (segment.kind === "metric") return metricToken(segment.id);
  if (segment.kind === "evidence") return `[${segment.id}]`;
  return WINDOW_TOKEN;
}

// V3: numbers outside tokens ----------------------------------------------------------------------------

function numeralIssues(
  numerals: readonly { field: ProseField; bare: string[] }[],
  ledger: LedgerLookup,
  action: Blocking,
): ValidationIssue[] {
  return numerals
    .filter((x) => x.bare.length > 0)
    .map(({ field, bare }) => issue("V3", action, `${field.path}: ${numeralAdvice(field.text, bare, ledger)}.`, field.path, bare));
}

/**
 * What V3 tells the repair about one field's bare numbers: an age range that merges Qloo buckets names
 * the buckets it spans, and a number one of the field's own tokens already prints is a copy to delete
 * ("13 of 20 new tags {{M29}}" when the token shows "13 of 20 in the area top 20").
 */
function numeralAdvice(text: string, bare: readonly string[], ledger: LedgerLookup): string {
  const listed = (xs: readonly string[]) => [...new Set(xs)].map((x) => `"${x}"`).join(", ");
  const clauses = [`numbers typed outside tokens: ${listed(bare)}`];
  for (const range of new Set(bare)) {
    const buckets = mergedAgeBuckets(range);
    if (buckets === null) continue;
    clauses.push(
      `"${range}" is not a Qloo age bucket: name the ${buckets.length === 1 ? "bucket" : "buckets"} it spans ` +
        `(${wordList(buckets)}), or cite the {{M#}} token of the metric that measures ${buckets.length === 1 ? "it" : "them"}`,
    );
  }
  let rest = bare.filter((b) => mergedAgeBuckets(b) === null);
  for (const id of new Set(metricTokenOccurrences(text))) {
    const display = ledger.metric(id)?.display ?? "";
    const shown = new Set(numeralValues(display));
    const copies = rest.filter((b) => {
      const values = numeralValues(b);
      return values.length > 0 && values.every((v) => shown.has(v));
    });
    if (copies.length === 0) continue;
    const verb = new Set(copies).size === 1 ? "repeats" : "repeat";
    clauses.push(`${listed(copies)} ${verb} what {{${id}}} already prints ("${display}"): delete the typed copy`);
    rest = rest.filter((b) => !copies.includes(b));
  }
  if (rest.length > 0) clauses.push(`cite every ${clauses.length > 1 ? "other " : ""}number as a {{M#}} token`);
  return clauses.join("; ");
}

// V4: phrase linter ------------------------------------------------------------------------------------------

function phraseIssues(path: string, hits: readonly PhraseHit[], blocking: Blocking): ValidationIssue[] {
  return hits.map((h) => issue("V4", blocking, `${path}: "${h.phrase}" is not allowed (${h.rule.hint}).`, path, [h.phrase]));
}

// V5: citation chains -------------------------------------------------------------------------------------

function citationIssues(
  draft: ReportDraftShape,
  plan: SubmitPlanInputShape | null,
  blocking: Blocking,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const add = (path: string, message: string, subjects: string[] = []) =>
    out.push(issue("V5", blocking, message, path, subjects));

  draft.arguments.forEach((a, i) => {
    if (citedIds("M", a.metric_ids, [a.qloo_fact, a.our_read]).length > 0) return;
    add(`arguments[${i}].metric_ids`, `arguments[${i}] (${a.id}) cites no metric; add at least one to metric_ids.`);
  });
  draft.recommendations.forEach((r, i) => {
    if (r.argument_ids.length > 0) return;
    const message = `recommendations[${i}] cites no argument; add at least one to argument_ids.`;
    add(`recommendations[${i}].argument_ids`, message);
  });
  draft.hypothesis_verdicts.forEach((v, i) => {
    if (citedIds("M", v.metric_ids, [v.note]).length > 0) return;
    const message = `hypothesis_verdicts[${i}] (${v.hypothesis_id}) cites no metric; add at least one to metric_ids.`;
    add(`hypothesis_verdicts[${i}].metric_ids`, message);
  });
  const judged = new Set(draft.hypothesis_verdicts.map((v) => v.hypothesis_id));
  const unjudged = (plan?.hypotheses ?? []).map((h) => h.id).filter((id) => !judged.has(id));
  if (unjudged.length > 0) {
    const message = `planned hypotheses without a verdict: ${unjudged.join(", ")}; give each one a verdict.`;
    add("hypothesis_verdicts", message, unjudged);
  }
  return out;
}

// V6 and V8 judge whole claims -----------------------------------------------------------------------

/** One claim: an argument (both parts and its metric_ids) or one other field that is not a next move. */
interface ClaimUnit {
  path: string;
  role: ProseRole;
  fields: ProseField[];
  /** Ids cited outside the prose: an argument's metric_ids (V8 counts them for "the same argument"). */
  metricIds: readonly string[];
}

function claimUnits(draft: ReportDraftShape, fields: readonly ProseField[]): ClaimUnit[] {
  const units = new Map<string, ClaimUnit>();
  for (const field of fields) {
    if (field.role === "followup") continue;
    const unit = units.get(field.unit);
    if (unit) unit.fields.push(field);
    else units.set(field.unit, { path: field.unit, role: field.role, fields: [field], metricIds: [] });
  }
  draft.arguments.forEach((a, i) => {
    const unit = units.get(argumentUnit(i));
    if (unit) unit.metricIds = a.metric_ids;
  });
  return [...units.values()];
}

// V6: no cross-call comparison of raw affinities -------------------------------------------------------

/**
 * A claim that cites two raw-affinity metrics whose evidence shares no Qloo call compares
 * per-query scores across calls, however its sentences are split. Metrics whose bundles share a
 * call may come from one response, so they are not flagged.
 */
function affinityIssues(unit: ClaimUnit, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  const callsOf = (id: MetricId): Set<string> =>
    new Set((ledger.metric(id)?.evidenceIds ?? []).flatMap((e) => ledger.evidence(e)?.qlooCallIds ?? []));
  const isRawAffinity = (id: MetricId) => {
    const m = ledger.metric(id);
    return m !== undefined && m.unit === "affinity" && m.value !== null;
  };
  const affinities = citedIds("M", unit.metricIds, unit.fields.map((f) => f.text)).filter(isRawAffinity);
  const out: ValidationIssue[] = [];
  affinities.forEach((a, i) => {
    for (const b of affinities.slice(i + 1)) {
      const callsA = callsOf(a);
      const callsB = callsOf(b);
      if (callsA.size === 0 || callsB.size === 0 || [...callsA].some((c) => callsB.has(c))) continue;
      const message =
        `${unit.path}: compares raw affinities {{${a}}} and {{${b}}} from different Qloo calls; raw affinity is ` +
        "a per-query score, so compare ranks or within-call percentiles instead.";
      out.push(issue("V6", blocking, message, unit.path, [a, b]));
    }
  });
  return out;
}

// V7: forced signal ------------------------------------------------------------------------------------------

function forceSignal(draft: ReportDraftShape, ledger: LedgerSnapshot, qlooEnabled: boolean): ValidationIssue | null {
  const ok = ledger.evidence.filter((e) => e.status === "ok").length;
  if ((qlooEnabled && ok >= MIN_OK_EVIDENCE) || draft.signal === "insufficient_evidence") return null;
  const why = qlooEnabled
    ? `only ${ok} evidence bundles are ok and ${MIN_OK_EVIDENCE} are needed`
    : "Qloo is disabled for this run";
  const from = draft.signal;
  draft.signal = "insufficient_evidence";
  // The tag named a finding the evidence does not carry; the brief prints the forced signal instead.
  const tag = draft.verdict_tag.trim();
  draft.verdict_tag = "";
  const dropped = tag === "" ? "" : `; verdict_tag "${tag}" dropped with it`;
  return issue("V7", "forced", `signal changed from ${from} to insufficient_evidence: ${why}${dropped}.`, "signal", [from]);
}

// The verdict tag on the last attempt: code cuts or drops it ------------------------------------------

/** Where a tag's first clause ends: a comma, colon, dash or bracket opens a qualifier; a stop ends it. */
const CLAUSE_END = /[,;:.!?(–—]|\s-\s/u;

/** Words a clause that says something does not end on ("Close to, but behind" is no tag). */
const DANGLING_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "but", "by", "for", "from", "in", "into", "is", "of", "on", "or", "than", "the", "to", "vs", "with",
]);

/**
 * A verdict tag cut to its rule, never spliced: its first clause, when that keeps the rule (V9, a number
 * spelled out included), uses no banned phrase (V4) and does not end on a dangling word; "" otherwise,
 * and the brief prints the signal label. Words are never taken out of a clause or cut off its end: "No
 * 1 choice" without its number, or "Clear lead over rivals is unlikely" cut at five words, says the opposite.
 */
export function trimVerdictTag(tag: string): string {
  const clause = verdictTagWords(tag.split(CLAUSE_END)[0] ?? "").join(" ");
  const last = clause.slice(clause.lastIndexOf(" ") + 1).toLowerCase();
  if (DANGLING_WORDS.has(last)) return "";
  return tagProblems(clause).length === 0 && phraseHits(clause).length === 0 ? clause : "";
}

/**
 * The last attempt's verdict tag, settled by code: dropped when it uses a banned phrase (V4) or claims
 * a demographic the headline does not measure (V10, `unmeasured` the terms), else cut to its rule
 * (V9). The brief prints the signal label in its place, so the fix is `forced` and costs no confidence.
 */
function settleVerdictTag(draft: ReportDraftShape, unmeasured: readonly string[]): ValidationIssue[] {
  const from = draft.verdict_tag;
  const hits = phraseHits(from);
  if (hits.length > 0) {
    draft.verdict_tag = "";
    const phrase = hits.map((h) => `"${h.phrase}"`).join(", ");
    const hint = hits[0]?.rule.hint ?? "";
    const message = `${TAG_PATH} "${from}" dropped: ${phrase} is not allowed (${hint}); the brief prints the signal instead.`;
    return [issue("V4", "forced", message, TAG_PATH, hits.map((h) => h.phrase))];
  }
  if (unmeasured.length > 0) {
    draft.verdict_tag = "";
    const listed = unmeasured.map((t) => `"${t}"`).join(", ");
    const message =
      `${TAG_PATH} "${from}" dropped: ${listed} ${unmeasured.length === 1 ? "claims" : "claim"} an audience's age, ` +
      "gender or generation that no metric the headline cites measures; the brief prints the signal instead.";
    return [issue("V10", "forced", message, TAG_PATH, [...unmeasured])];
  }
  const problems = tagProblems(from);
  if (problems.length === 0) return [];
  const to = trimVerdictTag(from);
  draft.verdict_tag = to;
  const outcome = to === "" ? "dropped; the brief prints the signal instead" : `trimmed to "${to}"`;
  return [issue("V9", "forced", `${TAG_PATH} "${from}" ${problems.join(" and ")}: ${outcome}.`, TAG_PATH, [from])];
}

// V8: a STALE metric travels with its window ---------------------------------------------------------------

/**
 * Every claim that cites a STALE metric and shows no window gets one: right after its first STALE
 * token, or appended when the metric is cited only in an argument's metric_ids. One window anywhere
 * in an argument covers the whole argument (SPEC §6.2).
 */
function injectWindows(units: readonly ClaimUnit[], ledger: LedgerSnapshot): ValidationIssue[] {
  const stale = new Set<string>(ledger.metrics.filter((m) => m.badge === "STALE").map((m) => m.id));
  if (stale.size === 0) return [];
  const firstStale = (f: ProseField) => metricTokenOccurrences(f.text).find((id) => stale.has(id));
  const out: ValidationIssue[] = [];
  for (const unit of units) {
    if (unit.role !== "claim") continue;
    const ids = citedIds("M", unit.metricIds, unit.fields.map((f) => f.text)).filter((id) => stale.has(id));
    if (ids.length === 0 || unit.fields.some((f) => WINDOW_TOKEN_RE.test(f.text))) continue;
    const host = unit.fields.find((f) => firstStale(f) !== undefined) ?? unit.fields[0];
    if (host === undefined) continue;
    const token = firstStale(host);
    host.set(
      token === undefined
        ? `${host.text.trimEnd()} (trending window ${WINDOW_TOKEN})`
        : insertAfterMetricToken(host.text, token, ` (${WINDOW_TOKEN})`),
    );
    const listed = ids.map((id) => `{{${id}}}`).join(", ");
    out.push(issue("V8", "injected", `${host.path}: added the trending window beside STALE ${listed}.`, host.path, ids));
  }
  return out;
}

// V10: audience demographics need a metric that measures them -------------------------------------------

/** What one part of the note cites, beyond the tokens of the field being judged. */
interface CitingPart {
  metricIds: readonly string[];
  /** Every text of the part: tokens anywhere in it count as citations. */
  texts: readonly string[];
  datasetIds: readonly string[];
}

/**
 * The part each claim field belongs to, keyed by its ProseField unit (the paths draftProse writes): an
 * argument is both its parts with its metric_ids; a verdict note or bear-case item comes with its
 * metric_ids; a recommendation with what its arguments cite; an exhibit caption with its dataset.
 */
function citingParts(draft: ReportDraftShape): Map<string, CitingPart> {
  const parts = new Map<string, CitingPart>();
  const set = (unit: string, metricIds: readonly string[], texts: readonly string[], datasetIds: readonly string[] = []) =>
    parts.set(unit, { metricIds, texts, datasetIds });
  set("headline", [], [draft.headline]);
  set("thesis", [], [draft.thesis]);
  draft.hypothesis_verdicts.forEach((v, i) => set(`hypothesis_verdicts[${i}].note`, v.metric_ids, [v.note]));
  draft.arguments.forEach((a, i) => set(argumentUnit(i), a.metric_ids, [a.qloo_fact, a.our_read]));
  draft.exhibits.forEach((e, i) => set(`exhibits[${i}].caption`, [], [e.caption], [e.dataset_id]));
  draft.bear_case.forEach((b, i) => set(`bear_case[${i}].text`, b.metric_ids, [b.text]));
  draft.recommendations.forEach((r, i) => {
    const backing = draft.arguments.filter((a) => r.argument_ids.includes(a.id));
    const texts = [r.action, ...backing.flatMap((a) => [a.qloo_fact, a.our_read])];
    set(`recommendations[${i}].action`, backing.flatMap((a) => a.metric_ids), texts);
  });
  return parts;
}

/** A field V10 judges: a prose field of the note, or the verdict tag in the headline's part. */
type DemographicField = Pick<ProseField, "path" | "role" | "unit" | "text">;

/**
 * V10's judge for one draft: the demographic terms a field claims that no metric of its part measures,
 * empty when it passes. A claim that names an audience's age, gender or generation needs a metric in
 * the same part that measures it (SPEC §6.2): an audience_dna index or a share_of_taste age metric
 * with a value; a caption's dataset counts when it shows one (`calls`: the evidence behind them).
 * Limitation sentences and registered names are not claims (report/demographics). Next moves and
 * other labels are not judged, they state no finding; the verdict tag names the headline's.
 */
function unmeasuredDemographics(
  draft: ReportDraftShape,
  ledger: LedgerLookup,
  calls: ReadonlySet<string>,
  names: readonly RegExp[],
): (field: DemographicField) => string[] {
  const parts = citingParts(draft);
  const measures = (part: CitingPart): boolean =>
    citedIds("M", part.metricIds, part.texts).some((id) => {
      const m = ledger.metric(id);
      return m !== undefined && measuresDemographics(m);
    }) ||
    part.datasetIds.some((id) => {
      const d = isId("D", id) ? ledger.dataset(id) : undefined;
      return d !== undefined && datasetMeasuresDemographics(d, calls);
    });
  return (field) => {
    if (field.role !== "claim") return [];
    const terms = demographicTerms(field.text, names);
    const part = parts.get(field.unit) ?? { metricIds: [], texts: [field.text], datasetIds: [] };
    return terms.length === 0 || measures(part) ? [] : terms;
  };
}

function demographicIssues(
  fields: readonly DemographicField[],
  unmeasured: (field: DemographicField) => string[],
  blocking: Blocking,
): ValidationIssue[] {
  return fields.flatMap((field) => {
    const terms = unmeasured(field);
    if (terms.length === 0) return [];
    const claims = `${terms.map((t) => `"${t}"`).join(", ")} ${terms.length === 1 ? "claims" : "claim"}`;
    const message =
      field.path === TAG_PATH
        ? `${field.path}: ${claims} an audience's age, gender or generation, but no metric the headline cites measures ` +
          "it; name the finding without it, or cite a metric that measures it (audience_dna, or a share_of_taste age " +
          "context) in the headline."
        : `${field.path}: ${claims} an audience's age, gender or generation, but no metric this part cites measures ` +
          "it; remove the claim or write that it was not measured, or cite a metric that measures it (audience_dna, or a " +
          "share_of_taste age context) in the same part.";
    return [issue("V10", blocking, message, field.path, terms)];
  });
}

// Numbers traced (receipt) ------------------------------------------------------------------------------------

/**
 * Every number the note shows: each `{{M#}}` occurrence of a metric with a value, each unresolved
 * metric token, and each bare number V3 found. Traced numbers are tokens whose metric reaches
 * evidence with request ids (M# → E# → request id).
 */
function traceNumbers(fields: readonly ProseField[], ledger: LedgerLookup, bare: number): NumbersTraced {
  let traced = 0;
  let total = bare;
  for (const field of fields) {
    for (const id of metricTokenOccurrences(field.text)) {
      const m = ledger.metric(id);
      if (m && m.value === null) continue;
      total += 1;
      if (m && m.evidenceIds.length > 0 && m.evidenceIds.every((e) => ledger.evidence(e) !== undefined)) traced += 1;
    }
  }
  return { traced, total };
}

// Repair turn ---------------------------------------------------------------------------------------------------

/**
 * The single repair-turn instruction for the ANALYST (SPEC §6.2: at most one repair turn). With the
 * rejected `draft` it also restates the limits of the fields to rewrite (rewriteLimits).
 */
export function repairMessage(issues: readonly ValidationIssue[], draft?: ReportDraftShape): string {
  const toFix = issues.filter((i) => i.action === "reject" || i.action === "warn");
  const fixed = issues.filter((i) => i.action === "forced" || i.action === "injected");
  const lines = [
    "CHECKER rejected the report. Call submit_report once more with the complete corrected report: every field, " +
      "not only the changes.",
    "This is the only repair turn. Anything left unfixed is accepted as a warning and lowers the confidence score.",
    "",
    "Fix these issues:",
    ...toFix.map((i) => `- ${i.rule} ${i.message}`),
  ];
  const limits = draft === undefined ? [] : rewriteLimits(toFix, draft);
  if (limits.length > 0) {
    lines.push("", "Limits that still hold for what you rewrite (every {{M#}} and [E#] token counts its characters):", ...limits);
  }
  if (fixed.length > 0) {
    lines.push("", "Code already applied these; keep them consistent:", ...fixed.map((i) => `- ${i.rule} ${i.message}`));
  }
  lines.push(
    "",
    "Reminders: cite every number as a {{M#}} token and evidence as [E#], with ids from this run only. Keep QLOO DATA " +
      "(qloo_fact) apart from OUR READ (our_read). Write next_moves in plain words without tokens. No buy or sell " +
      "advice, price targets, causal claims or statements about individuals.",
  );
  return lines.join("\n");
}

/** Longer than any limited field of the draft: what charLimit writes to find a field's limit. */
const OVERLONG = "x".repeat(10_000);
/**
 * A text field to rewrite is listed once it uses this share of its character limit: a fix that swaps
 * a typed number for its token, or a word for a measured claim, adds a few characters, and a field
 * with more room left takes them.
 */
export const REWRITE_TIGHT_SHARE = 0.75;

/**
 * The limits of the fields the repair must rewrite, one line each: the verdict tag's rule, and each
 * text field near its character limit with its size now. The repaired draft is final, so a rewrite
 * that fixes one rule must not break another: live repairs put {{M#}} tokens into a headline and ran
 * it past its 120 characters, and swapped a demographic verdict tag for one hyphenated word. A field
 * whose own V9 issue is listed already has its limit stated.
 */
function rewriteLimits(toFix: readonly ValidationIssue[], draft: ReportDraftShape): string[] {
  const paths = [...new Set(toFix.flatMap((i) => (i.path === null ? [] : [i.path])))];
  return paths.flatMap((path) => {
    if (path === TAG_PATH) {
      const L = VERDICT_TAG_LIMITS;
      return [
        `- ${TAG_PATH}: ${L.wordsMin} to ${L.wordsMax} words, at most ${L.chars} characters, no digits or tokens; words are ` +
          "split at spaces, so a hyphenated compound is one word.",
      ];
    }
    const keys = pathKeys(path);
    const text = keys === null ? undefined : valueAt(draft, keys);
    if (keys === null || typeof text !== "string" || toFix.some((i) => i.rule === "V9" && i.path === path)) return [];
    const limit = charLimit(draft, keys);
    if (limit === null || text.length < limit * REWRITE_TIGHT_SHARE) return [];
    return [`- ${path}: at most ${limit} characters; it has ${text.length} now.`];
  });
}

/**
 * The character limit of the draft's text at `keys`, read from the contracts schema (strict mode
 * strips it) by checking a copy that holds an overlong text there; null when the field has none.
 */
function charLimit(draft: ReportDraftShape, keys: readonly PropertyKey[]): number | null {
  const probe: unknown = structuredClone(draft);
  const parent = valueAt(probe, keys.slice(0, -1));
  const key = keys.at(-1);
  if (parent === null || typeof parent !== "object" || key === undefined) return null;
  (parent as Record<PropertyKey, unknown>)[key] = OVERLONG;
  const parsed = ReportDraft.safeParse(probe);
  const at = formatPath(keys);
  const hit = parsed.success ? undefined : parsed.error.issues.find((zi) => zi.code === "too_big" && formatPath(zi.path) === at);
  return hit?.code === "too_big" && typeof hit.maximum === "number" ? hit.maximum : null;
}

/** "arguments[3].our_read" as keys (["arguments", 3, "our_read"]), the inverse of formatPath; null for "(draft)". */
function pathKeys(path: string): PropertyKey[] | null {
  const keys: PropertyKey[] = [];
  for (const part of path.split(".")) {
    const m = /^([a-z_]+)((?:\[\d+\])*)$/.exec(part);
    if (m === null) return null;
    keys.push(m[1]!, ...[...m[2]!.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1])));
  }
  return keys;
}

// Helpers -----------------------------------------------------------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  const joined = path.reduce<string>(
    (s, k) => (typeof k === "number" ? `${s}[${k}]` : s === "" ? String(k) : `${s}.${String(k)}`),
    "",
  );
  return joined || "(draft)";
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = root;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}
