import {
  isId,
  stripTokens,
  type DatasetEnvelope,
  type EntityRegistry,
  type Metric,
  type MetricId,
  type ReportDraftShape,
  type SubmitPlanInputShape,
  type ValidationIssue,
} from "@ct/contracts";
import type { LedgerLookup, LedgerSnapshot } from "../ledger";
import { citedIds, draftProse, metricTokenOccurrences } from "../tokens";

/**
 * CHECKER V12 and V13 (Part 11, R2, R7, D48, D50) and the V9 disclosure rule: answers stay as strong as
 * their data and no stronger.
 * - V12 (a) a metric read through a look-alike tag (conceptRead proxy) is never cited; (b) a category-level
 *   metric never carries a winner, keep or veto in the headline, verdict tag or thesis; (c) a hidden pocket
 *   is never "the best" in the headline; (d) a hypothesis that was never really tested is never confirmed
 *   or refuted (code forces it inconclusive).
 * - V13: an about-level difference (Metric.level) never leads the headline or the thesis's first sentence.
 * - V9: the thesis never restates the disclosure code already prints at the top of the answer.
 * - V12 (e): expected candidates are never called named: when the question named no peers (or no areas), the
 *   prose never speaks of "named peers" or "the areas you named" (R3: You named and Expected are apart).
 */

type Blocking = "reject" | "warn";

const issue = (rule: ValidationIssue["rule"], action: ValidationIssue["action"], message: string, path: string | null, subjects: string[] = []): ValidationIssue => ({
  rule,
  action,
  message,
  path,
  subjects,
});

/** What the honesty rules read besides the draft and the ledger. */
export interface HonestyInput {
  /** The question's concept parts (questionConcepts); messages name the first. */
  concepts: readonly string[];
  /** Tags carry their concept match (find_tags, R2). */
  registry?: Pick<EntityRegistry, "tags">;
}

/** Winner, keep and veto words: a category-level read names none of them (V12b). */
export const WINNER_WORDS = /\b(best|winners?|wins?|beats?|leads?|strongest|top pick|clear (?:lead|winner)|keep|kept|veto(?:es|ed)?)\b/i;
/** Superlatives a hidden pocket never takes in the headline (V12c). */
export const HIDDEN_BEST_WORDS = /\b(best|top|ideal|strongest|leading)\b/i;

const quote = (s: string): string =>
  s
    .replace(/[\p{Cc}\p{Cf}'"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();

/** The name of the first tag among a metric's subjects whose concept match is `match`, or null. */
function tagNameOf(metric: Pick<Metric, "subjectRefs">, match: "proxy" | "category", input: HonestyInput): string | null {
  const tags = input.registry?.tags() ?? [];
  for (const ref of metric.subjectRefs) {
    if (!isId("T", ref)) continue;
    const tag = tags.find((t) => t.ref === ref);
    if (tag?.conceptMatch === match) return tag.name;
  }
  // A metric read through the tag without naming it (a lift map's areas): any tag of that match in the run.
  return tags.find((t) => t.conceptMatch === match)?.name ?? null;
}

const conceptOf = (input: HonestyInput): string => quote(input.concepts[0] ?? "") || "the concept";

/** Every metric id the draft cites, with the first path citing it (id lists name their array). */
function citations(draft: ReportDraftShape): Map<MetricId, string> {
  const out = new Map<MetricId, string>();
  const add = (id: string, path: string) => {
    if (isId("M", id) && !out.has(id)) out.set(id, path);
  };
  for (const f of draftProse(draft)) for (const id of metricTokenOccurrences(f.text)) add(id, f.path);
  draft.hypothesis_verdicts.forEach((v, i) => v.metric_ids.forEach((id) => add(id, `hypothesis_verdicts[${i}].metric_ids`)));
  draft.arguments.forEach((a, i) => a.metric_ids.forEach((id) => add(id, `arguments[${i}].metric_ids`)));
  draft.bear_case.forEach((b, i) => b.metric_ids.forEach((id) => add(id, `bear_case[${i}].metric_ids`)));
  return out;
}

/** V12 (a): a cited metric that rests on a look-alike tag. */
export function proxyIssues(draft: ReportDraftShape, ledger: LedgerLookup, input: HonestyInput, blocking: Blocking): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const [id, path] of citations(draft)) {
    const m = ledger.metric(id);
    if (m?.conceptRead !== "proxy") continue;
    const tag = quote(tagNameOf(m, "proxy", input) ?? "") || "a look-alike tag";
    const message =
      `${path}: ${id} rests on '${tag}', a look-alike tag standing in for '${conceptOf(input)}'. The data has no tag for it: ` +
      "use the category-level read or say the concept is not in the data.";
    out.push(issue("V12", blocking, message, path, [id]));
  }
  return out;
}

/** The metrics a field cites by token that exist in the ledger. */
const tokensIn = (text: string, ledger: LedgerLookup): Metric[] => [...new Set(metricTokenOccurrences(text))].flatMap((id) => ledger.metric(id) ?? []);

/**
 * V12 (b): a category-level metric cited in the headline or thesis beside a winner, keep or veto word; the
 * verdict tag is judged with the headline's metrics.
 */
export function categoryWinnerIssues(draft: ReportDraftShape, ledger: LedgerLookup, input: HonestyInput, blocking: Blocking, judgeTag: boolean): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const judge = (path: string, text: string, metrics: readonly Metric[]) => {
    const category = metrics.find((m) => m.conceptRead === "category");
    if (category === undefined) return;
    const hit = WINNER_WORDS.exec(stripTokens(text));
    if (hit === null) return;
    const name = quote(tagNameOf(category, "category", input) ?? "") || "its category";
    const message =
      `${path}: "${hit[0]}" beside ${category.id}. This is a category-level read of '${name}', not '${conceptOf(input)}': ` +
      "describe it as the category's fit, with no winner, keep or veto.";
    out.push(issue("V12", blocking, message, path, [category.id, hit[0]]));
  };
  const headline = tokensIn(draft.headline, ledger);
  judge("headline", draft.headline, headline);
  judge("thesis", draft.thesis, tokensIn(draft.thesis, ledger));
  if (judgeTag && draft.verdict_tag.trim() !== "") judge("verdict_tag", draft.verdict_tag, headline);
  return out;
}

/** The hidden pockets of the run's lift maps, by area name (R7 standing). */
function hiddenAreas(datasets: readonly DatasetEnvelope[]): string[] {
  return datasets.flatMap((d) => (d.kind === "GeoLift" ? d.payload.neighbourhoods.filter((n) => n.standing === "hidden").map((n) => n.name) : []));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesArea = (text: string, name: string): boolean =>
  name.trim() !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** V12 (c): a headline that calls a hidden pocket the best, top, ideal, strongest or leading area. */
export function hiddenPocketIssues(draft: ReportDraftShape, ledger: Pick<LedgerSnapshot, "datasets">, blocking: Blocking): ValidationIssue[] {
  const text = stripTokens(draft.headline);
  const hit = HIDDEN_BEST_WORDS.exec(text);
  if (hit === null) return [];
  const area = hiddenAreas(ledger.datasets).find((name) => namesArea(text, name));
  if (area === undefined) return [];
  const message =
    `headline: ${area} is a hidden pocket (it stands out for its size, not where the crowd is). ` +
    "Say so, or name the popular areas beside it.";
  return [issue("V12", blocking, message, "headline", [area, hit[0]])];
}

/** Room for a verdict note (ReportDraft note limit). */
const NOTE_MAX = 300;
export const NOT_TESTED_PREFIX = "Not tested: ";

/** A note with the prefix, cut at a sentence or word end (never mid-word) to keep the note limit. */
function prefixed(note: string): string {
  const text = `${NOT_TESTED_PREFIX}${note.trim()}`;
  if (text.length <= NOTE_MAX) return text;
  const head = text.slice(0, NOTE_MAX);
  const sentence = head.lastIndexOf(". ");
  if (sentence > NOT_TESTED_PREFIX.length) return head.slice(0, sentence + 1);
  return head.slice(0, head.lastIndexOf(" ")).trim();
}

/**
 * V12 (d): a confirmed or refuted hypothesis whose cited metrics are all category or proxy reads, or all
 * thin, or whose test tool never returned an ok bundle while none of its cited metrics came from that
 * tool, was never really tested: code forces it inconclusive, the note kept and prefixed "Not tested: ".
 */
export function forceUntestedVerdicts(
  draft: ReportDraftShape,
  plan: SubmitPlanInputShape | null,
  ledger: LedgerLookup,
  evidence: LedgerSnapshot["evidence"],
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  draft.hypothesis_verdicts.forEach((v, i) => {
    if (v.verdict !== "confirmed" && v.verdict !== "refuted") return;
    const metrics = citedIds("M", v.metric_ids, [v.note]).flatMap((id) => ledger.metric(id) ?? []);
    const tool = plan?.hypotheses.find((h) => h.id === v.hypothesis_id)?.test_tool ?? null;
    const skillsOf = (m: Metric) => m.evidenceIds.flatMap((e) => ledger.evidence(e)?.skill ?? []);
    let why: string | null = null;
    if (metrics.length > 0 && metrics.every((m) => m.conceptRead === "category" || m.conceptRead === "proxy")) {
      why = "every metric it cites reads the concept's category or a look-alike tag, not the concept";
    } else if (metrics.length > 0 && metrics.every((m) => m.thin === true)) {
      why = "every metric it cites rests on a thin sample";
    } else if (tool !== null && !evidence.some((e) => e.skill === tool && e.status === "ok") && !metrics.some((m) => skillsOf(m).includes(tool))) {
      why = `its test tool ${tool} never returned data in this run and no metric it cites comes from it`;
    }
    if (why === null) return;
    const from = v.verdict;
    v.verdict = "inconclusive";
    if (!v.note.startsWith(NOT_TESTED_PREFIX)) v.note = prefixed(v.note);
    const path = `hypothesis_verdicts[${i}].verdict`;
    out.push(issue("V12", "forced", `${path}: ${v.hypothesis_id} changed from ${from} to inconclusive: ${why}.`, path, [v.hypothesis_id]));
  });
  return out;
}

/** The first sentence of a text. */
const firstSentence = (text: string): string => text.split(/(?<=[.!?])\s+/u)[0] ?? text;

/** V13: an about-level metric cited in the headline or the thesis's first sentence. */
export function aboutLevelIssues(draft: ReportDraftShape, ledger: LedgerLookup, blocking: Blocking): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const judge = (path: string, text: string) => {
    for (const m of tokensIn(text, ledger)) {
      if (m.level !== "about_level") continue;
      out.push(issue("V13", blocking, `${path}: ${m.id} is about level (a small difference): it cannot lead the answer.`, path, [m.id]));
    }
  };
  judge("headline", draft.headline);
  judge("thesis", firstSentence(draft.thesis));
  return out;
}

/** What the top of the answer already discloses (code writes it): a concept not in the data, a nearest-job read. */
export interface Disclosure {
  concept: boolean;
  readAs: boolean;
}

/** A thesis sentence that says again that the concept is not in the data or was tested on its category. */
const CONCEPT_RESTATED =
  /\b(?:not in (?:the )?(?:Qloo(?:'s)? )?(?:data|dataset)|(?:has|have|had) no (?:exact |own )?tag|no tag (?:of its own|for (?:it|this|the))|(?:its|the) (?:broader|nearest|closest) category|category[- ]level|tested (?:on|at|against) (?:the |its )?(?:nearest |broader )?category|(?:read|tested) (?:as|through) (?:the |its )?(?:nearest |broader )?category)\b/i;
/** A thesis sentence that says again that the question was read as its nearest job. */
const READ_AS_RESTATED = /\b(?:read as (?:the |its )?nearest|nearest (?:job|question)|answers? the nearest)\b/i;

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/u).filter((s) => s.trim() !== "");

/**
 * V9 (Part 9 open issue 3): a thesis sentence that restates the top-of-answer disclosure is rejected once;
 * on the last attempt code drops it (forced), unless it is the thesis's only sentence.
 */
export function disclosureIssues(draft: ReportDraftShape, disclosure: Disclosure | undefined, blocking: Blocking): ValidationIssue[] {
  if (disclosure === undefined || (!disclosure.concept && !disclosure.readAs)) return [];
  const sentences = sentencesOf(draft.thesis);
  const restated = sentences.filter((s) => {
    const plain = stripTokens(s);
    return (disclosure.concept && CONCEPT_RESTATED.test(plain)) || (disclosure.readAs && READ_AS_RESTATED.test(plain));
  });
  if (restated.length === 0) return [];
  if (blocking === "warn" && restated.length < sentences.length) {
    draft.thesis = sentences.filter((s) => !restated.includes(s)).join(" ");
    const listed = restated.map((s) => `"${s.trim()}"`).join(" ");
    return [issue("V9", "forced", `thesis: dropped ${listed}: the page already says this at the top.`, "thesis", restated)];
  }
  return restated.map((s) =>
    issue("V9", blocking, `thesis: "${s.trim()}" restates what the page already says at the top; use the thesis for the finding.`, "thesis", [s.trim()]),
  );
}

/** What the question itself named besides its subject (R3 user_named candidates): peers or brands, and areas. */
export interface QuestionNamed {
  entities: boolean;
  areas: boolean;
}

const NAMED_ENTITY_WORDS = /\bnamed\b (?:[a-z-]+ )?(?:peers?|brands?|competitors?|rivals?|partners?|entities)\b|\b(?:peers?|brands?|competitors?|rivals?|partners?) (?:you|the question) (?:named|gave|listed)\b/i;
const NAMED_AREA_WORDS =
  /\bnamed\b (?:[a-z-]+ )?(?:areas?|neighbou?rhoods?|ZIPs?)\b|\b(?:areas?|neighbou?rhoods?) (?:you|the question) (?:named|names|gave|listed)\b|\bthe question'?s (?:own )?(?:areas?|neighbou?rhoods?)\b|\bareas? the question names\b/i;

/**
 * V12 (e): "named" for a candidate the question never named. CLERK's expected names (Expected) sit in the
 * same sets as the question's own (You named); prose that calls them named tells the reader they asked about
 * something they did not.
 */
export function namedAttributionIssues(draft: ReportDraftShape, named: QuestionNamed | undefined, blocking: Blocking): ValidationIssue[] {
  if (named === undefined) return [];
  const out: ValidationIssue[] = [];
  for (const f of draftProse(draft)) {
    const plain = stripTokens(f.text);
    const entity = named.entities ? null : NAMED_ENTITY_WORDS.exec(plain);
    const area = named.areas ? null : NAMED_AREA_WORDS.exec(plain);
    for (const [hit, what] of [
      [entity, "peers or brands"],
      [area, "areas"],
    ] as const) {
      if (hit === null) continue;
      out.push(
        issue(
          "V12",
          blocking,
          `${f.path}: "${hit[0]}": the question named no ${what}; these are expected candidates (marked Expected), so call them expected, never named.`,
          f.path,
          [hit[0]],
        ),
      );
    }
  }
  return out;
}
