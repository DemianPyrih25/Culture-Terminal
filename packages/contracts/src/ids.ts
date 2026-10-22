import { z } from "zod";

/**
 * Run-scoped identifiers (PLAN §6 "IDs"). Every id is a one-letter prefix plus a positive integer
 * without leading zeros, allocated in order within one run: E1, E2, … They are never Qloo ids.
 */
export const ID_PREFIXES = {
  E: "evidence bundle",
  M: "metric",
  D: "dataset",
  F: "finding",
  R: "entity ref",
  T: "tag ref",
  H: "hypothesis",
  A: "argument",
  S: "plan step",
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;
export type Id<P extends IdPrefix> = `${P}${number}`;

export type EvidenceId = Id<"E">;
export type MetricId = Id<"M">;
export type DatasetId = Id<"D">;
export type FindingId = Id<"F">;
export type EntityRef = Id<"R">;
export type TagRef = Id<"T">;
export type HypothesisId = Id<"H">;
export type ArgumentId = Id<"A">;
export type StepId = Id<"S">;

function patternFor(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}[1-9]\\d*$`);
}

export const ID_PATTERNS: Readonly<Record<IdPrefix, RegExp>> = {
  E: patternFor("E"),
  M: patternFor("M"),
  D: patternFor("D"),
  F: patternFor("F"),
  R: patternFor("R"),
  T: patternFor("T"),
  H: patternFor("H"),
  A: patternFor("A"),
  S: patternFor("S"),
};

/**
 * A string schema that only accepts ids with this prefix. The cast narrows the inferred type to the
 * template literal, so an M# can never be passed where an E# is expected.
 */
export function idSchema<P extends IdPrefix>(prefix: P): z.ZodType<Id<P>, Id<P>> {
  return z
    .string()
    .regex(ID_PATTERNS[prefix], { message: `expected a ${ID_PREFIXES[prefix]} id like ${prefix}1` })
    .describe(`${ID_PREFIXES[prefix]} id, e.g. ${prefix}1`) as unknown as z.ZodType<Id<P>, Id<P>>;
}

export const EvidenceIdSchema = idSchema("E");
export const MetricIdSchema = idSchema("M");
export const DatasetIdSchema = idSchema("D");
export const FindingIdSchema = idSchema("F");
export const EntityRefSchema = idSchema("R");
export const TagRefSchema = idSchema("T");
export const HypothesisIdSchema = idSchema("H");
export const ArgumentIdSchema = idSchema("A");
export const StepIdSchema = idSchema("S");

export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  return typeof value === "string" && ID_PATTERNS[prefix].test(value);
}

export function makeId<P extends IdPrefix>(prefix: P, n: number): Id<P> {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`id number must be a positive integer, got ${n}`);
  return `${prefix}${n}` as Id<P>;
}

/** The numeric part of a well-formed id of any prefix, or null. */
export function idNumber(id: string): number | null {
  const prefix = id.charAt(0);
  if (!(prefix in ID_PREFIXES) || !ID_PATTERNS[prefix as IdPrefix].test(id)) return null;
  return Number(id.slice(1));
}

/** The id after the highest one already used with this prefix (E1 when none). Pure, so state can be rebuilt. */
export function nextId<P extends IdPrefix>(prefix: P, existing: Iterable<string>): Id<P> {
  let max = 0;
  for (const id of existing) {
    if (isId(prefix, id)) max = Math.max(max, Number(id.slice(1)));
  }
  return makeId(prefix, max + 1);
}

/** Sort comparator: by prefix, then numerically (M2 before M10). */
export function compareIds(a: string, b: string): number {
  if (a.charAt(0) !== b.charAt(0)) return a.charAt(0) < b.charAt(0) ? -1 : 1;
  return (idNumber(a) ?? 0) - (idNumber(b) ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Prose tokens (D6). The ANALYST cites numbers only through these; the CHECKER and the web
// bindings both read prose with the helpers below. The exported regexes are non-global, so
// `.test()` carries no lastIndex state between calls.
// ---------------------------------------------------------------------------------------------

/** `{{M12}}`: renders the metric's display value with its badge. */
export const METRIC_TOKEN_RE = /\{\{(M[1-9]\d*)\}\}/;
/** `[E4]`: renders a receipt link to the evidence bundle. */
export const EVIDENCE_TOKEN_RE = /\[(E[1-9]\d*)\]/;
/** `{{WINDOW}}`: renders the trending window; a STALE metric must sit beside it (CHECKER V8). */
export const WINDOW_TOKEN = "{{WINDOW}}";
export const WINDOW_TOKEN_RE = /\{\{WINDOW\}\}/;

/** Any well-formed token. Group 1 is a metric id or WINDOW; group 2 is an evidence id. */
export const TOKEN_RE = /\{\{(M[1-9]\d*|WINDOW)\}\}|\[(E[1-9]\d*)\]/;

export const metricToken = (id: MetricId): string => `{{${id}}}`;
export const evidenceToken = (id: EvidenceId): string => `[${id}]`;

export type ProseSegment =
  | { kind: "text"; text: string }
  | { kind: "metric"; id: MetricId }
  | { kind: "evidence"; id: EvidenceId }
  | { kind: "window" };

/** Splits prose into text and token segments, in order. Text segments are never empty. */
export function tokenizeProse(text: string): ProseSegment[] {
  const out: ProseSegment[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    const [whole, metricOrWindow, evidence] = m;
    if (evidence !== undefined) out.push({ kind: "evidence", id: evidence as EvidenceId });
    else if (metricOrWindow === "WINDOW") out.push({ kind: "window" });
    else out.push({ kind: "metric", id: metricOrWindow as MetricId });
    last = start + whole.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Metric ids cited as `{{M#}}`, in order of first appearance, without duplicates. */
export function extractMetricIds(text: string): MetricId[] {
  return unique(tokenizeProse(text).flatMap((s) => (s.kind === "metric" ? [s.id] : [])));
}

/** Evidence ids cited as `[E#]`, in order of first appearance, without duplicates. */
export function extractEvidenceIds(text: string): EvidenceId[] {
  return unique(tokenizeProse(text).flatMap((s) => (s.kind === "evidence" ? [s.id] : [])));
}

/** Prose with every well-formed token removed: what CHECKER V3/V4 scan for bare numbers and phrases. */
export function stripTokens(text: string): string {
  return text.replace(new RegExp(TOKEN_RE.source, "g"), " ");
}

/**
 * Token-like text that is not a well-formed token, e.g. `{{ M12 }}`, `{{m3}}`, `{M3}`, `[M4]`, `[E04]`,
 * and bracketed lists or ranges such as `[E4, E5]` or `[E4-E6]` (one token per bracket is the only form).
 * The CHECKER reports these under V2 instead of letting their digits fall through to V3.
 */
export function findMalformedTokens(text: string): string[] {
  const candidates =
    /\{\{[^{}]*\}\}|\{[A-Za-z]\s*\d+\s*\}|\[\s*[A-Za-z]\s*\d+(?:\s*(?:[,;/&–-]|and|to)\s*[A-Za-z]?\s*\d+)*\s*\]/g;
  const valid = new RegExp(`^(?:${TOKEN_RE.source})$`);
  return [...text.matchAll(candidates)].map((m) => m[0]).filter((s) => !valid.test(s));
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
