import { AgeBucket, Gender, stripTokens, type DatasetEnvelope, type Metric } from "@ct/contracts";
import type { FormulaId } from "@ct/quant";
import { AGE_LABEL_RE } from "./numerals";

/**
 * CHECKER V10 (SPEC §6.2): audience demographics (age, gender, generation) are claimed only where the
 * same part cites a metric that measures them: an audience_dna index, the share_of_taste youth tilt
 * (the metric behind GENERATIONAL_SPLIT), or a share_of_taste or rank_candidates percentile in an age
 * or gender context (C4); an exhibit
 * caption may rest on its dataset instead. A sentence that states a limitation ("age was not
 * measured") claims nothing and passes. Registered entity and tag names are masked first, so a name
 * such as "Young Adult Fiction" is never read as a claim.
 */

/** Formulas whose metrics always measure an audience's age or gender (S3 audience_dna, S2 youth tilt). */
export const DEMOGRAPHIC_FORMULAS = [
  "dna.age_index",
  "dna.gender_index",
  "dna.youth_index",
  "share.youth_tilt",
] as const satisfies readonly FormulaId[];

/**
 * A within-call percentile (share_of_taste SHARE, rank_candidates FIT) measures age or gender only in
 * an age or gender context. Both skills name the context in the metric's subject refs (S2 also in
 * older keys), so an age context is one where either carries an AgeBucket id, and a gender context
 * one whose subject refs hold a Gender value ("female") exactly.
 */
const CONTEXT_PCT: ReadonlySet<string> = new Set<FormulaId>(["share.pct", "pct.within_call"]);

/** True when the metric has a value and measures audience age or gender. */
export function measuresDemographics(m: Pick<Metric, "formulaId" | "key" | "subjectRefs" | "value">): boolean {
  if (m.value === null) return false;
  if ((DEMOGRAPHIC_FORMULAS as readonly string[]).includes(m.formulaId)) return true;
  if (!CONTEXT_PCT.has(m.formulaId)) return false;
  return (
    [m.key, ...m.subjectRefs].some((s) => AgeBucket.options.some((b) => s.includes(b))) ||
    m.subjectRefs.some((s) => (Gender.options as readonly string[]).includes(s))
  );
}

/** The evidence bundles behind the metrics that measure audience age or gender: the calls that measured it. */
export function demographicEvidence(
  metrics: Iterable<Pick<Metric, "formulaId" | "key" | "subjectRefs" | "value" | "evidenceIds">>,
): Set<string> {
  const out = new Set<string>();
  for (const m of metrics) if (measuresDemographics(m)) for (const e of m.evidenceIds) out.add(e);
  return out;
}

/**
 * True when the dataset shows audience age or gender (an exhibit caption cites its dataset): it was
 * computed with a demographic formula, or drawn from a call that measured it (`calls`, from
 * demographicEvidence), as a pair's who-wins-where split over age contexts is.
 */
export function datasetMeasuresDemographics(
  d: Pick<DatasetEnvelope, "formulaIds" | "evidenceIds">,
  calls: ReadonlySet<string> = new Set(),
): boolean {
  return d.formulaIds.some((f) => (DEMOGRAPHIC_FORMULAS as readonly string[]).includes(f)) || d.evidenceIds.some((e) => calls.has(e));
}

/** Nouns that make "young", "older" and the like describe a brand or the data, not an audience. */
const NOT_AUDIENCE = String.raw`brands?|compan(?:y|ies)|categor(?:y|ies)|labels?|startups?|business(?:es)?|markets?`;
const DATA_NOUNS = String.raw`data|windows?|snapshots?|cop(?:y|ies)|cache[ds]?|entr(?:y|ies)|responses?|series|calls?|results?|figures?|versions?|runs?|notes?`;
const AUDIENCE_NOUNS = String.raw`audiences?|fans?|crowds?|consumers?|customers?|shoppers?|buyers?|users?|listeners?|viewers?|people|adults|following|followers|base|demographics?`;

const TERMS = [
  // Gender. A possessive ("women's apparel") names a product category, not an audience.
  String.raw`(?:fe)?males?`,
  String.raw`(?:wo)?men(?!['’]s\b)`,
  String.raw`genders?|gendered`,
  String.raw`boys|girls`,
  // Age.
  String.raw`young(?:er|est)?(?![\s-]+(?:${NOT_AUDIENCE})\b)`,
  String.raw`youths?`,
  String.raw`youthful(?=\s+(?:${AUDIENCE_NOUNS})\b)`,
  String.raw`old(?:er|est)(?![\s-]+(?:${NOT_AUDIENCE}|${DATA_NOUNS})\b)`,
  String.raw`(?:skews?|skewed|skewing|tilts?|tilted|tilting|leans?|leaned|leaning)\s+old`,
  String.raw`teens?|teenagers?|teenage|tweens?|adolescents?`,
  String.raw`kids|children(?!['’]s\b)`,
  String.raw`seniors|elderly|retirees|middle[\s-]aged`,
  String.raw`\d{1,2}[\s-]?(?:year|yr)[\s-]?olds`,
  String.raw`\d{1,2}[\s-]?(?:year|yr)s?[\s-]?old\s+(?:${AUDIENCE_NOUNS})`,
  String.raw`age\s+(?:skews?|tilts?|brackets?|groups?|cohorts?|bands?|profiles?|mix|splits?|ranges?)`,
  String.raw`aged\s+(?:\d+|under|over)`,
  // Generation.
  String.raw`gen(?:eration)?[\s-]?(?:z|x|y|alpha)`,
  String.raw`zoomers?|millennials?|boomers?`,
  String.raw`generational(?:ly)?`,
];

const TERM_RE = new RegExp(String.raw`\b(?:${TERMS.join("|")})\b`, "giu");
/** Qloo's age-bucket labels as prose writes them ("≤24", "25–29", "55+", "25_to_29"), as V3 allows them. */
const AGE_LABEL = new RegExp(AGE_LABEL_RE.source, "giu");
/** Any other two-digit age range, e.g. "18-24" or "18 to 34"; a date or a time never matches. */
const AGE_RANGE_RE = /(?<![\p{N}.,:/–—-])(1[3-9]|[2-6]\d)\s?(?:–|—|-|to)\s?([1-9]\d)(?![\p{N}.,:/%–—-])/gu;

/** A sentence that states what was not measured claims nothing (SPEC §6.2: "age was not measured" passes). */
const LIMITATION_RE = new RegExp(
  [
    String.raw`\bnot\s+(?:yet\s+)?(?:be(?:en)?\s+)?(?:measured|tested|available|covered|known|checked|run)\b`,
    String.raw`\bun(?:measured|available|tested|known)\b`,
    String.raw`\bno\s+(?:demographics?|ages?|genders?|generational)\b`,
    String.raw`\bwithout\s+(?:demographics?|ages?|genders?|generational)\b`,
    String.raw`\bcan(?:not|['’]t)\s+(?:tell|say|show|confirm)\b`,
    String.raw`\bdid\s+not\s+(?:measure|return|run)\b`,
  ].join("|"),
  "iu",
);

const SENTENCE_END = /(?<=[.!?;])\s+/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name made of demographic words only ("Gen Z", "Millennials") is a claim when prose uses it, so it is never masked. */
const onlyDemographic = (name: string): boolean => name.replace(TERM_RE, " ").replace(/[\s\p{P}]+/gu, "") === "";

/** What separates the words of a name as prose writes it: "Young Professionals", "young-professional". */
const NAME_GAP = String.raw`[\s\p{Pd}_]+`;

/** A name's last word in either number: "Professionals" also matches "professional", and the reverse. */
function eitherNumber(word: string): string {
  const stem = word.length > 3 && /[^s]s$/iu.test(word) ? word.slice(0, -1) : word;
  return /\p{L}$/u.test(stem) ? `${escapeRegExp(stem)}(?:e?s)?` : escapeRegExp(word);
}

/**
 * One registered name as prose writes it: any case, words joined by spaces, hyphens or underscores,
 * the last word singular or plural, and never inside a longer word. Prose that names a tag such as
 * "Young Professionals" as "the young-professional tag" still names it.
 */
function namePattern(name: string): RegExp | null {
  const words = name.split(new RegExp(NAME_GAP, "u")).filter((w) => w !== "");
  if (words.length === 0) return null;
  const parts = words.map((w, i) => (i === words.length - 1 ? eitherNumber(w) : escapeRegExp(w)));
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${parts.join(NAME_GAP)}(?![\p{L}\p{N}])`, "giu");
}

/**
 * Registered names, longest first, as patterns that blank them out of prose before the scan: a brand
 * such as "Young Ones Cola" or a tag such as "Young Adult" names something, it claims nothing.
 */
export function namePatterns(names: Iterable<string>): RegExp[] {
  const unique = [...new Set([...names].map((n) => n.trim()).filter((n) => n !== "" && !onlyDemographic(n)))];
  return unique.sort((a, b) => b.length - a.length).flatMap((n) => namePattern(n) ?? []);
}

/**
 * The demographic terms `text` claims, as written and without duplicates: tokens and registered
 * names are blanked out first, and sentences that state a limitation are skipped.
 */
export function demographicTerms(text: string, names: readonly RegExp[] = []): string[] {
  let s = stripTokens(text);
  for (const name of names) s = s.replace(name, " ");
  const out = new Set<string>();
  for (const sentence of s.split(SENTENCE_END)) {
    if (LIMITATION_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(TERM_RE)) out.add(m[0]);
    for (const m of sentence.matchAll(AGE_LABEL)) out.add(m[0].trim());
    for (const m of sentence.matchAll(AGE_RANGE_RE)) if (Number(m[1]) < Number(m[2])) out.add(m[0]);
  }
  return [...out];
}
