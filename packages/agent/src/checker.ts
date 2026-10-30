import {
  extractPeriodMetricIds,
  findMalformedTokens,
  isId,
  metricToken,
  periodToken,
  ReportDraft,
  stripTokens,
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
import { MIN_BUSY_AREA_VENUES } from "@ct/quant";
import type { z } from "zod";
import { indexSnapshot, type LedgerLookup, type LedgerSnapshot } from "./ledger";
import { competitionClaimsOf, countsSupply, mapCountsSupply, measuresSupply } from "./report/competition";
import {
  datasetMeasuresDemographics,
  demographicEvidence,
  demographicTerms,
  measuresDemographics,
  namePatterns,
} from "./report/demographics";
import { wordList } from "./report/format";
import {
  AGE_BUCKET_LABELS,
  areaAliases,
  looseAgeNumbers,
  mergedAgeBuckets,
  numberWords,
  numeralNames,
  numeralValues,
  numeralViolations,
} from "./report/numerals";
import {
  aboutLevelIssues,
  categoryWinnerIssues,
  disclosureIssues,
  forceUntestedVerdicts,
  hiddenPocketIssues,
  namedAttributionIssues,
  proxyIssues,
  type Disclosure,
  type QuestionNamed,
} from "./report/honesty";
import { phraseHits, type PhraseHit } from "./report/phrases";
import { isQlooEvidence, metricPublicSource } from "./report/publicData";
import { misattributedTokens, type SubjectEntity } from "./report/subjects";
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
 * CHECKER (SPEC §6.2, D23): code-only validation of a submit_report draft, rules V1–V13. It takes
 * the draft as the strict tool guarantees it (structure only) and enforces what strict mode strips:
 * id formats (V1) and lengths and counts (V9). V7, V8 and V11's period tokens are fixed by code, never rejected. A
 * rejection buys one repair turn; on the second attempt every rejection is downgraded to a warning
 * and the report is accepted (each warning costs confidence, §6.4). The verdict tag names the finding
 * in a few words and is judged with the headline (V4, V9, V10); on the second attempt code cuts or
 * drops it instead (forced), since the brief prints the signal label in its place, and it costs nothing.
 * Part 11 (R2, R7, D48, D50): V12 keeps concept and area reads honest (report/honesty.ts), V13 keeps an
 * about-level difference from leading the answer, V9 drops a thesis sentence that restates the disclosure,
 * and V7 also forces insufficient_evidence when every call on the question's subject came back empty.
 */

/** Below this many ok Qloo evidence bundles the signal is forced to insufficient_evidence (V7); SEC and Census bundles do not count. */
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
  /**
   * True when the question is about opening a venue (site_selection): a competitor claim then needs a
   * counted supply metric even when no geo_lift call ran, since nothing else counts competitors (V10).
   */
  competitionAsked?: boolean;
  /** 2 for the draft submitted in the repair turn: rejections become warnings. Defaults to 1. */
  attempt?: 1 | 2;
  /** The question's concept parts (questionConcepts): V12's messages name them. Defaults to none. */
  concepts?: readonly string[];
  /** What the top of the answer already discloses (V9 restated-disclosure rule). Absent: nothing. */
  disclosure?: Disclosure;
  /**
   * The primary's name when it resolved but every call that used it came back empty or failed (V7
   * extension, SUBJECT_NO_DATA): the signal is forced to insufficient_evidence. Absent or null: no such case.
   */
  subjectNoData?: string | null;
  /** What the question named besides its subject (R3): V12 (e) rejects "named" for expected candidates. Absent: not judged. */
  named?: QuestionNamed;
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
  /** True when the draft cites a metric read through a look-alike tag (V12a): the report gets category_level. */
  proxyCited: boolean;
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
  const entities = (input.registry?.entities() ?? []).map((e) => ({ ref: e.ref, name: e.name }));
  // Follow-up questions are parameters of a new run, not claims: their numbers are not V3's concern.
  const numerals = fields
    .filter((field) => field.role !== "followup")
    .map((field) => ({ field, bare: numeralViolations(field.text, names) }));
  const bareCount = numerals.reduce((n, x) => n + x.bare.length, 0);

  const patched = structuredClone(draft) as ReportDraftShape;
  const forced = forceSignal(patched, ledger, qlooEnabled, input.subjectNoData ?? null);
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
  // Competition is judged in the claims, the exhibit titles (a title states what its map shows) and the tag.
  const uncounted = uncountedCompetition(draft, ledger, lookup, input.competitionAsked === true);
  const competitionFields = fields.filter((f) => f.role === "claim" || EXHIBIT_TITLE.test(f.path));
  const honest = { concepts: input.concepts ?? [], ...(input.registry ? { registry: input.registry } : {}) };
  const proxies = proxyIssues(draft, lookup, honest, blocking);
  const honesty = [
    ...proxies,
    ...categoryWinnerIssues(draft, lookup, honest, blocking, !tagSettled),
    ...hiddenPocketIssues(draft, ledger, blocking),
    ...namedAttributionIssues(draft, input.named, blocking),
  ];

  const issues: ValidationIssue[] = [
    ...schemaIssues(draft, blocking).filter((i) => !tagSettled || i.path !== TAG_PATH),
    ...(tagSettled ? [] : tagNumberIssues(draft.verdict_tag, blocking)),
    ...referenceIssues(draft, plan, lookup, blocking),
    ...fields.flatMap((f) => tokenIssues(f, lookup, blocking)),
    ...fields.flatMap((f) => seamIssues(f, lookup, blocking)),
    ...fields.flatMap((f) => repeatedDisplayIssues(f, lookup, blocking)),
    ...fields.flatMap((f) => subjectIssues(f, lookup, entities, blocking)),
    ...numeralIssues(numerals, lookup, bareCount > V3_REJECT_ABOVE ? blocking : "warn"),
    ...phrases.flatMap(({ path, hits }) => phraseIssues(path, hits, blocking)),
    ...citationIssues(draft, plan, blocking),
    ...claimUnits(draft, fields).flatMap((u) => affinityIssues(u, lookup, blocking)),
    ...demographicIssues(tagSettled ? fields : [...fields, tag], unmeasured, blocking),
    ...competitionIssues(tagSettled ? competitionFields : [...competitionFields, tag], uncounted, gapOf(ledger), blocking),
    ...claimUnits(draft, fields).flatMap((u) => publicCausalIssues(u, lookup, blocking)),
    ...honesty,
    ...aboutLevelIssues(draft, lookup, blocking),
    ...disclosureIssues(patched, input.disclosure, blocking),
    ...forceUntestedVerdicts(patched, plan, lookup, ledger.evidence),
  ];

  if (forced) issues.push(forced);
  else if (tagSettled) issues.push(...settleVerdictTag(patched, unmeasured(tag), uncounted(tag)));
  issues.push(...injectWindows(claimUnits(patched, draftProse(patched)), ledger));
  issues.push(...strayPeriods(draftProse(patched), lookup));
  issues.push(...injectPeriods(claimUnits(patched, draftProse(patched)), lookup));
  collapseSamePeriods(draftProse(patched), lookup);
  issues.sort((a, b) => a.rule.localeCompare(b.rule, "en", { numeric: true }));

  return {
    issues,
    numbersTraced: traceNumbers(draftProse(patched), lookup, bareCount),
    ...(forced ? { forcedSignal: patched.signal } : {}),
    patchedDraft: patched as D,
    reject: issues.some((i) => i.action === "reject"),
    adviceTerms: phrases.reduce((n, x) => n + x.hits.filter((h) => h.rule.advice).length, 0),
    proxyCited: proxies.length > 0,
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

/** Punctuation that ends the clause a token sits in; a bracket does not ("not measured ({{M6}})" still prints twice). */
const CLAUSE_BREAK = /[.;:,!?]/u;

/** Words of a text as the seam check compares them: lower case, letters and digits only, a plural "s" dropped. */
function seamWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** The longest run (up to 4 words, at least 3 letters besides digits) that ends `before` and starts `after`, as words; [] when none. */
function seamOverlap(before: readonly string[], after: readonly string[]): string[] {
  for (let k = Math.min(4, before.length, after.length); k >= 1; k--) {
    const tail = before.slice(before.length - k);
    // Repeated digits are V3's (a typed copy of what the token prints); this judges words.
    if (tail.every((w, i) => w === after[i]) && tail.join("").replace(/\p{N}/gu, "").length >= 3) return tail;
  }
  return [];
}

/**
 * The longest run (up to 4 words, at least 3 letters besides digits) that `words` and a display's
 * words both end with (atEnd) or both start with, short of the whole display; [] when none. It
 * catches a label repeated across the display's number: "solid {{M9}}" when M9 prints "1.00 · solid".
 */
function sharedEdge(words: readonly string[], shown: readonly string[], atEnd: boolean): string[] {
  for (let k = Math.min(4, words.length, shown.length - 1); k >= 1; k--) {
    const a = atEnd ? words.slice(words.length - k) : words.slice(0, k);
    const b = atEnd ? shown.slice(shown.length - k) : shown.slice(0, k);
    if (a.every((w, i) => w === b[i]) && a.join("").replace(/\p{N}/gu, "").length >= 3) return a;
  }
  return [];
}

/** Text between two tokens that names nothing: commas, brackets, slashes and at most one "and" or "or". */
const BARE_JOIN = /^[\s,;/()&]*(?:\b(?:and|or)\b)?[\s,;/()&]*$/iu;

/**
 * Tokens side by side that print the same display ("({{M51}}, {{M71}}, {{M91}})" reading "not measured,
 * not measured, not measured"): the reader sees one figure repeated and cannot tell what each covers
 * (§1 repeated metric displays). One issue per run of such tokens.
 */
function repeatedDisplayIssues(field: ProseField, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  if (field.role === "followup") return [];
  const segments = tokenizeProse(field.text);
  const out: ValidationIssue[] = [];
  let run: string[] = [];
  let display = "";
  const flush = () => {
    if (run.length > 1) {
      const listed = run.map((id) => `{{${id}}}`);
      const message =
        `${field.path}: ${wordList(listed)} print the same "${display}" side by side, so the reader sees one figure repeated; ` +
        "name what each measures beside it (the city, area or brand), or say it once in words.";
      out.push(issue("V2", blocking, message, field.path, [...run]));
    }
    run = [];
    display = "";
  };
  segments.forEach((segment) => {
    if (segment.kind === "text") {
      if (!BARE_JOIN.test(segment.text)) flush();
      return;
    }
    if (segment.kind !== "metric") return flush();
    const shown = ledger.metric(segment.id)?.display ?? "";
    // A run survives only bare joins (any other text or token flushed it), so the token sits beside it.
    if (run.length > 0 && shown === display && shown !== "") run.push(segment.id);
    else {
      flush();
      run = [segment.id];
      display = shown;
    }
  });
  flush();
  return out;
}

/**
 * A token whose display repeats the words around it (§11 display bugs): "ranks last in {{M34}}" when
 * {{M34}} prints "last in 0 of 5 rows" reads "ranks last in last in 0 of 5 rows". The words beside the
 * token are judged against the start and the end of what it prints, and against the label on the
 * far side of its number ("solid {{M9}}" when M9 prints "1.00 · solid").
 */
function seamIssues(field: ProseField, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  if (field.role === "followup") return [];
  const segments = tokenizeProse(field.text);
  const out: ValidationIssue[] = [];
  segments.forEach((segment, i) => {
    if (segment.kind !== "metric") return;
    const display = ledger.metric(segment.id)?.display ?? "";
    const shown = seamWords(display);
    if (shown.length === 0) return;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    // Only the words in the token's own clause count: "{{M14}}. New tags…" starts another sentence.
    const beforeWords = prev?.kind === "text" ? seamWords(prev.text.split(CLAUSE_BREAK).at(-1) ?? "") : [];
    const afterWords = next?.kind === "text" ? seamWords(next.text.split(CLAUSE_BREAK)[0] ?? "") : [];
    const pick = (a: string[], b: string[]) => (a.length >= b.length ? a : b);
    const before = pick(seamOverlap(beforeWords, shown), sharedEdge(beforeWords, shown, true));
    const after = pick(seamOverlap(shown, afterWords), sharedEdge(afterWords, shown, false));
    const repeated = [before, after].filter((w) => w.length > 0).map((w) => `"${w.join(" ")}"`);
    if (repeated.length === 0) return;
    const message =
      `${field.path}: {{${segment.id}}} already prints "${display}", so the words ${repeated.join(" and ")} beside it ` +
      "print twice; delete them from the sentence, or rewrite it so it reads once.";
    out.push(issue("V2", blocking, message, field.path, [segment.id]));
  });
  return out;
}

/**
 * A token set beside the wrong entity: its sentence names registered entities but none the metric
 * measures (report/subjects). Next moves carry no tokens; V2 above already rejects any there.
 */
function subjectIssues(field: ProseField, ledger: LedgerLookup, entities: readonly SubjectEntity[], blocking: Blocking): ValidationIssue[] {
  if (field.role === "followup") return [];
  return misattributedTokens(field.text, (id) => ledger.metric(id), entities).map((t) => {
    const message =
      `${field.path}: {{${t.id}}} measures ${wordList(t.subjects)}, but its sentence names ${wordList(t.named)} instead; ` +
      `set each token beside the entity it measures, or name ${wordList(t.subjects)} in that sentence.`;
    return issue("V2", blocking, message, field.path, [t.id]);
  });
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
  if (segment.kind === "period") return periodToken(segment.id);
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
  const ages = looseAgeNumbers(text, rest);
  if (ages.length > 0) {
    const plural = new Set(ages).size > 1;
    clauses.push(
      `${listed(ages)} ${plural ? "read" : "reads"} as ${plural ? "ages" : "an age"}: write each age as one of Qloo's bucket labels ` +
        `(${AGE_BUCKET_LABELS.join(", ")}) next to the {{M#}} token of the metric that measures that bucket, never "the 30s" or "up to 44"`,
    );
    rest = rest.filter((b) => !ages.includes(b));
  }
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

function forceSignal(draft: ReportDraftShape, ledger: LedgerSnapshot, qlooEnabled: boolean, subjectNoData: string | null): ValidationIssue | null {
  const ok = ledger.evidence.filter((e) => e.status === "ok" && isQlooEvidence(e)).length;
  const noSubject = qlooEnabled && subjectNoData !== null;
  if ((qlooEnabled && ok >= MIN_OK_EVIDENCE && !noSubject) || draft.signal === "insufficient_evidence") return null;
  const why = !qlooEnabled
    ? "Qloo is disabled for this run"
    : noSubject && ok >= MIN_OK_EVIDENCE
      ? `Qloo returned no data for ${subjectNoData}, the question's subject, and no look-alike stands in for it`
      : `only ${ok} Qloo evidence bundles are ok and ${MIN_OK_EVIDENCE} are needed`;
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
 * The last attempt's verdict tag, settled by code: dropped when it uses a banned phrase (V4), claims
 * a demographic the headline does not measure (V10, `unmeasured` the terms) or states a competitor
 * count nobody counted (V10, `uncounted` the claims), else cut to its rule (V9). The brief prints the
 * signal label in its place, so the fix is `forced` and costs no confidence.
 */
function settleVerdictTag(draft: ReportDraftShape, unmeasured: readonly string[], uncounted: readonly string[] = []): ValidationIssue[] {
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
  if (uncounted.length > 0) {
    draft.verdict_tag = "";
    const listed = uncounted.map((t) => `"${t}"`).join(", ");
    const message =
      `${TAG_PATH} "${from}" dropped: ${listed} ${uncounted.length === 1 ? "states" : "state"} a competitor count or supply ` +
      "level that no counted supply metric the headline cites backs; the brief prints the signal instead.";
    return [issue("V10", "forced", message, TAG_PATH, [...uncounted])];
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

// V11: SEC and Census figures carry their period, and never explain a taste signal (or the reverse) ------------

/**
 * Every claim or label that cites an SEC or Census metric with a value and does not show that
 * metric's `{{PERIOD:M#}}` gets it, like V8's window: right after the metric's first token, or
 * appended when the metric is cited only in an argument's metric_ids. One period token anywhere in an
 * argument covers the argument. A filing period or ACS vintage is part of the figure, so code adds it
 * rather than spend a repair turn on it (PLAN §6).
 */
function injectPeriods(units: readonly ClaimUnit[], ledger: LedgerLookup): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const unit of units) {
    const ids = citedIds("M", unit.metricIds, unit.fields.map((f) => f.text)).filter((id) => {
      const m = ledger.metric(id);
      return m !== undefined && m.value !== null && typeof m.period === "string" && metricPublicSource(m, ledger) !== null;
    });
    const shown = new Set(unit.fields.flatMap((f) => extractPeriodMetricIds(f.text)));
    // A shown period prints the same text for every figure of that filing or ACS release: it covers them.
    const shownText = new Set([...shown].map((id) => ledger.metric(id)?.period).filter((p): p is string => typeof p === "string"));
    const missing = ids.filter((id) => !shown.has(id) && !shownText.has(ledger.metric(id)?.period as string));
    if (missing.length === 0) continue;
    // A field may take several periods: each insertion reads the text the last one wrote.
    const now = new Map<ProseField, string>();
    const textOf = (f: ProseField): string => now.get(f) ?? f.text;
    for (const id of missing) {
      const host = unit.fields.find((f) => metricTokenOccurrences(textOf(f)).includes(id)) ?? unit.fields[0];
      if (host === undefined) continue;
      const text = textOf(host);
      const next = metricTokenOccurrences(text).includes(id)
        ? insertAfterMetricToken(text, id, ` (${periodToken(id)})`)
        : `${text.trimEnd()} (${periodToken(id)})`;
      host.set(next);
      now.set(host, next);
    }
    const listed = missing.map((id) => `{{${id}}}`).join(", ");
    out.push(issue("V11", "injected", `${unit.path}: added the reporting period beside SEC or Census ${listed}.`, unit.path, missing));
  }
  return out;
}

/** "({{PERIOD:M1}}, {{PERIOD:M2}})": a parenthesis that lists only period tokens. */
const PERIOD_GROUP_RE = /\(\{\{PERIOD:M[1-9]\d*\}\}(?:\s*(?:,|;|and)\s*\{\{PERIOD:M[1-9]\d*\}\})+\)/g;

/**
 * A parenthesis listing period tokens that render the same text ("ACS 2020-2024 5-year, ACS 2020-2024
 * 5-year") prints it twice: code keeps the first of each text. Display only, so no issue is raised.
 */
function collapseSamePeriods(fields: readonly ProseField[], ledger: LedgerLookup): void {
  for (const field of fields) {
    const next = field.text.replace(PERIOD_GROUP_RE, (group) => {
      const ids = extractPeriodMetricIds(group);
      const seen = new Set<string>();
      const kept = ids.filter((id) => {
        const period = ledger.metric(id)?.period;
        const key = typeof period === "string" ? period : id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return kept.length === ids.length ? group : `(${kept.map(periodToken).join(", ")})`;
    });
    if (next !== field.text) field.set(next);
  }
}

/**
 * A `{{PERIOD:M#}}` on a metric that has no period (a Qloo metric) would print "the reporting period"
 * about a taste figure: code removes it (V2 already reports one whose metric does not exist).
 */
function strayPeriods(fields: readonly ProseField[], ledger: LedgerLookup): ValidationIssue[] {
  return fields.flatMap((field) => {
    const stray = extractPeriodMetricIds(field.text).filter((id) => {
      const m = ledger.metric(id);
      return m !== undefined && (typeof m.period !== "string" || metricPublicSource(m, ledger) === null);
    });
    if (stray.length === 0) return [];
    let text = field.text;
    for (const id of stray) text = text.split(` (${periodToken(id)})`).join("").split(periodToken(id)).join("");
    field.set(text.replace(/\s{2,}/g, " ").trim());
    const listed = stray.map((id) => periodToken(id)).join(", ");
    return [issue("V11", "forced", `${field.path}: removed ${listed}: only SEC and Census figures have a reporting period.`, field.path, stray)];
  });
}

/** Words that tie one thing to another as its cause or effect. */
const CAUSAL_LINK =
  /\b(?:because(?:\s+of)?|due\s+to|driven\s+by|drives?|drove|driving|fuel(?:s|ed|ing)?|leads?\s+to|led\s+to|results?\s+(?:in|from)|resulted\s+(?:in|from)|explains?|explained\s+by|thanks\s+to|translates?\s+into|translated\s+into|boost(?:s|ed|ing)?)\b/i;
/** A negation just before the link ("does not explain", "neither explains") states that there is no causal tie. */
const NEGATED = /\b(?:not|never|no|nor|neither)\s+(?:\w+\s+)?$|n't\s+(?:\w+\s+)?$/i;
/** A financial or resident figure named in words. */
const PUBLIC_WORDS = /\b(?:revenues?|sales|margins?|profits?|earnings|income|incomes|filings?|population|households?|commut\w*|residents?)\b/i;
/** A taste signal named in words. */
const TASTE_WORDS = /\b(?:taste|affinit(?:y|ies)|fans?|audiences?|momentum|popularity|signals?|lift|twins?|fingerprints?)\b/i;

/**
 * V11's second half: in a claim that cites an SEC or Census figure, no sentence may tie a financial or
 * resident figure and a taste signal together as cause and effect ("revenue grew because fans …",
 * "higher incomes drive the lift"). Public figures and taste signals are reported side by side.
 */
function publicCausalIssues(unit: ClaimUnit, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  if (unit.role !== "claim") return [];
  const cited = citedIds("M", unit.metricIds, unit.fields.map((f) => f.text)).flatMap((id) => ledger.metric(id) ?? []);
  const isPublic = (id: string) => {
    const m = ledger.metric(id as MetricId);
    return m !== undefined && metricPublicSource(m, ledger) !== null;
  };
  if (!cited.some((m) => metricPublicSource(m, ledger) !== null)) return [];
  const out: ValidationIssue[] = [];
  for (const field of unit.fields) {
    for (const sentence of field.text.split(/(?<=[.!?])\s+/)) {
      const link = CAUSAL_LINK.exec(sentence);
      if (link === null || NEGATED.test(sentence.slice(0, link.index))) continue;
      const tokens = metricTokenOccurrences(sentence);
      const publicSide = tokens.some(isPublic) || PUBLIC_WORDS.test(stripTokens(sentence));
      const tasteSide = tokens.some((id) => !isPublic(id)) || TASTE_WORDS.test(stripTokens(sentence));
      if (!publicSide || !tasteSide) continue;
      const message =
        `${field.path}: "${link[0]}" ties an SEC or Census figure and a taste signal together as cause and effect; ` +
        "report them side by side (financials and resident figures describe the company or the area, taste signals what its audience likes) and never as one explaining the other.";
      out.push(issue("V11", blocking, message, field.path, [link[0]]));
    }
  }
  return out;
}

// V10: claims need a metric that measures them: audience demographics, and competitor counts (competitionIssues) ---

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
 * the same part that measures it (SPEC §6.2): an audience_dna index or an age or gender context metric
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
          "it; name the finding without it, or cite a metric that measures it (audience_dna, or a share_of_taste age or " +
          "gender context) in the headline."
        : `${field.path}: ${claims} an audience's age, gender or generation, but no metric this part cites measures ` +
          "it; remove the claim or write that it was not measured, or cite a metric that measures it (audience_dna, or a " +
          "share_of_taste age or gender context) in the same part. A tag named for a group may stay, written exactly as REGISTRY " +
          "prints it.";
    return [issue("V10", blocking, message, field.path, terms)];
  });
}

/** An exhibit's title: a label, but one that states what its figure shows, so competition judges it. */
const EXHIBIT_TITLE = /^exhibits\[(\d+)\]\.title$/;

/**
 * Why a competition claim lacks a count, for V10's messages: the UNAVAILABLE lift.supply metric that says
 * why similar venues were not counted, else that no venue sample counted them, else (venues were counted)
 * what a citable count needs.
 */
function gapOf(ledger: LedgerSnapshot): string {
  const gap = ledger.metrics.find((m) => m.key === "lift.supply" && m.value === null);
  if (gap !== undefined) return `similar venues were not counted (${gap.id}: ${gap.label})`;
  if (!ledger.metrics.some((m) => countsSupply(m))) return "similar venues were not counted (no venue sample in this run counted them)";
  return (
    "only a cited supply or white-space metric counts similar venues (a capped sample's 0 counts none, and crowded or saturated " +
    `needs at least ${MIN_BUSY_AREA_VENUES} venues in the area)`
  );
}

/**
 * V10's judge for competition: the competitor-count claims a field makes that its part does not back,
 * empty when it passes. On in every run that measured supply (any geo_lift supply or white-space metric,
 * with a value or not) or whose question asks about competition (`asked`). A claim is backed when its
 * part cites a supply or white-space metric that counts similar venues (report/competition countsSupply:
 * never a capped sample's 0, and a crowded reading from a venue count needs several venues), or, for an
 * exhibit caption or title, shows a lift map that counted venues; the tag is judged with the headline's part.
 */
function uncountedCompetition(
  draft: ReportDraftShape,
  ledger: LedgerSnapshot,
  lookup: LedgerLookup,
  asked: boolean,
): (field: DemographicField) => string[] {
  if (!asked && !ledger.metrics.some(measuresSupply)) return () => [];
  const parts = citingParts(draft);
  const counted = (part: CitingPart, busy: boolean): boolean =>
    citedIds("M", part.metricIds, part.texts).some((id) => {
      const m = lookup.metric(id);
      return m !== undefined && countsSupply(m, busy);
    }) ||
    part.datasetIds.some((id) => {
      const d = isId("D", id) ? lookup.dataset(id) : undefined;
      return d !== undefined && d.kind === "GeoLift" && mapCountsSupply(d.payload);
    });
  return (field) => {
    const title = EXHIBIT_TITLE.test(field.path);
    if (field.role !== "claim" && !title) return [];
    const claims = competitionClaimsOf(field.text);
    if (claims.length === 0) return [];
    const unit = title ? field.path.replace(/\.title$/, ".caption") : field.unit;
    const part = parts.get(unit) ?? { metricIds: [], texts: [field.text], datasetIds: [] };
    return claims.filter((c) => !counted(part, c.busy)).map((c) => c.text);
  };
}

/**
 * V10 for competition: a claim, exhibit title or verdict tag that states a competitor count or supply
 * level ("no competitors", "the only bookstore", "white space", "crowded") claims what no metric measures,
 * unless its part cites a counted one. A clause that says the count is unknown, or only a sample, passes.
 */
function competitionIssues(
  fields: readonly DemographicField[],
  uncounted: (field: DemographicField) => string[],
  why: string,
  blocking: Blocking,
): ValidationIssue[] {
  return fields.flatMap((field) => {
    const claims = uncounted(field);
    if (claims.length === 0) return [];
    const listed = `${claims.map((c) => `"${c}"`).join(", ")} ${claims.length === 1 ? "states" : "state"} a competitor count or supply level`;
    const message =
      field.path === TAG_PATH
        ? `${field.path}: ${listed}, but ${why}; name the finding without it.`
        : `${field.path}: ${listed}, but ${why} and this part cites no counted supply metric that backs it. ` +
          "Write plainly that the number of competitors is unknown and why, or remove the claim; never read an unknown count or a thin sample as none, few or crowded.";
    return [issue("V10", blocking, message, field.path, claims)];
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
