import {
  findMalformedTokens,
  isId,
  metricToken,
  tokenizeProse,
  type Evidence,
  type EvidenceId,
  type Metric,
  type MetricId,
  type ReportDraftShape,
  type TrendWindow,
} from "@ct/contracts";
import type { LedgerLookup } from "./ledger";

/**
 * Number binding in prose (D6). The ANALYST cites numbers only as `{{M12}}` metric tokens and
 * evidence as `[E4]`; these helpers resolve the tokens against the ledger, list the prose fields of
 * a draft for the CHECKER, and render tokens as plain text for code-written summaries. The web UI
 * renders the same tokens as live bindings.
 */

/**
 * What a prose field says, which decides the CHECKER rules it gets:
 * - claim: states a finding (headline, thesis, verdict notes, argument parts, captions, bear case,
 *   recommendations); V8 puts the trending window beside a STALE metric in it.
 * - label: note text that states no finding (exhibit titles, open questions).
 * - followup: a next move's label or question, the prefilled text of a child run (SPEC §7.3). The
 *   parent's tokens mean nothing in the child's ledger, so none are allowed (V2), and a number in it
 *   is a parameter of the question, not a claim (no V3).
 */
export type ProseRole = "claim" | "label" | "followup";

/** One model-written string of a draft. */
export interface ProseField {
  /** Draft path, e.g. "arguments[2].our_read". */
  path: string;
  text: string;
  role: ProseRole;
  /** The claim the field belongs to (V6, V8): `arguments[i]` for both parts of an argument, else its own path. */
  unit: string;
  /** Writes the field in the draft it was read from (`text` keeps the value read); the CHECKER patches its copy. */
  set(text: string): void;
}

/** The claim unit of argument `i`: its two parts and its metric_ids are judged together. */
export const argumentUnit = (i: number): string => `arguments[${i}]`;

/** Every prose field of a draft, in reading order. */
export function draftProse(draft: ReportDraftShape): ProseField[] {
  const out: ProseField[] = [];
  const add = (path: string, role: ProseRole, text: string, set: (t: string) => void, unit = path): void => {
    out.push({ path, text, role, unit, set });
  };

  add("headline", "claim", draft.headline, (t) => (draft.headline = t));
  add("thesis", "claim", draft.thesis, (t) => (draft.thesis = t));
  draft.hypothesis_verdicts.forEach((v, i) => add(`hypothesis_verdicts[${i}].note`, "claim", v.note, (t) => (v.note = t)));
  draft.arguments.forEach((a, i) => {
    add(`arguments[${i}].qloo_fact`, "claim", a.qloo_fact, (t) => (a.qloo_fact = t), argumentUnit(i));
    add(`arguments[${i}].our_read`, "claim", a.our_read, (t) => (a.our_read = t), argumentUnit(i));
  });
  draft.exhibits.forEach((e, i) => {
    add(`exhibits[${i}].title`, "label", e.title, (t) => (e.title = t));
    add(`exhibits[${i}].caption`, "claim", e.caption, (t) => (e.caption = t));
  });
  draft.bear_case.forEach((b, i) => add(`bear_case[${i}].text`, "claim", b.text, (t) => (b.text = t)));
  draft.recommendations.forEach((r, i) => add(`recommendations[${i}].action`, "claim", r.action, (t) => (r.action = t)));
  draft.next_moves.forEach((m, i) => {
    add(`next_moves[${i}].label`, "followup", m.label, (t) => (m.label = t));
    add(`next_moves[${i}].question`, "followup", m.question, (t) => (m.question = t));
  });
  draft.open_questions.forEach((q, i) => add(`open_questions[${i}]`, "label", q, (t) => (draft.open_questions[i] = t)));
  return out;
}

export type ResolvedSegment =
  | { kind: "text"; text: string }
  | { kind: "metric"; id: MetricId; metric: Metric | null }
  | { kind: "evidence"; id: EvidenceId; evidence: Evidence | null }
  | { kind: "window" };

/** Prose split into text and tokens, each token paired with its ledger record (null when unknown). */
export function resolveProse(text: string, ledger: LedgerLookup): ResolvedSegment[] {
  return tokenizeProse(text).map((s) => {
    if (s.kind === "metric") return { kind: "metric", id: s.id, metric: ledger.metric(s.id) ?? null };
    if (s.kind === "evidence") return { kind: "evidence", id: s.id, evidence: ledger.evidence(s.id) ?? null };
    return s;
  });
}

export interface TokenProblems {
  /** `{{M#}}` tokens with no metric in the ledger, without duplicates. */
  metrics: MetricId[];
  /** `[E#]` tokens with no evidence bundle in the ledger, without duplicates. */
  evidence: EvidenceId[];
  /** Token-like text that is not a well-formed token, e.g. `{{ M3 }}` or `[E4, E5]`. */
  malformed: string[];
}

/** What CHECKER V2 reports for one prose field. */
export function tokenProblems(text: string, ledger: LedgerLookup): TokenProblems {
  const metrics = new Set<MetricId>();
  const evidence = new Set<EvidenceId>();
  for (const s of resolveProse(text, ledger)) {
    if (s.kind === "metric" && s.metric === null) metrics.add(s.id);
    if (s.kind === "evidence" && s.evidence === null) evidence.add(s.id);
  }
  return { metrics: [...metrics], evidence: [...evidence], malformed: findMalformedTokens(text) };
}

/** Metric ids cited by `{{M#}}` tokens, one entry per occurrence. */
export function metricTokenOccurrences(text: string): MetricId[] {
  return tokenizeProse(text).flatMap((s) => (s.kind === "metric" ? [s.id] : []));
}

/**
 * The union of explicit id lists and the ids cited by tokens in the given texts, in first-seen
 * order. Ill-formed ids are dropped: they can never resolve.
 */
export function citedIds<P extends "M" | "E">(
  prefix: P,
  ids: readonly string[],
  texts: readonly string[],
): `${P}${number}`[] {
  const out = new Set<`${P}${number}`>();
  for (const id of ids) if (isId(prefix, id)) out.add(id);
  for (const text of texts) {
    for (const s of tokenizeProse(text)) {
      if (prefix === "M" && s.kind === "metric") out.add(s.id as `${P}${number}`);
      if (prefix === "E" && s.kind === "evidence") out.add(s.id as `${P}${number}`);
    }
  }
  return [...out];
}

/** Inserts `insert` right after the first `{{id}}` token in `text`; unchanged when the token is absent. */
export function insertAfterMetricToken(text: string, id: MetricId, insert: string): string {
  const token = metricToken(id);
  const at = text.indexOf(token);
  if (at === -1) return text;
  const end = at + token.length;
  return text.slice(0, end) + insert + text.slice(end);
}

/** A metric as plain text: its display value with its badge, e.g. "2 of 7 (MEASURED)". */
export function metricText(metric: Metric): string {
  return `${metric.display} (${metric.badge})`;
}

/** The trending window as plain text. */
export function windowText(window: TrendWindow | null): string {
  return window ? `${window.start}..${window.end}` : "the trending window";
}

/**
 * Prose rendered as plain text: metric tokens become their display value and badge, the window
 * token becomes the window, evidence tokens stay as `[E#]` citations. An unknown metric renders as
 * "n/a" so no unbound number can appear.
 */
export function renderProse(text: string, ledger: LedgerLookup, window: TrendWindow | null): string {
  return resolveProse(text, ledger)
    .map((s) => {
      switch (s.kind) {
        case "text":
          return s.text;
        case "metric":
          return s.metric ? metricText(s.metric) : "n/a";
        case "evidence":
          return `[${s.id}]`;
        case "window":
          return windowText(window);
      }
    })
    .join("");
}

const EVIDENCE_TOKENS = /\s?\[E[1-9]\d*\]/g;

/**
 * Prose as text that carries no tokens at all, for text that leaves this run (a case summary, a
 * next-move question): rendered like renderProse, with evidence citations dropped.
 */
export function plainProse(text: string, ledger: LedgerLookup, window: TrendWindow | null): string {
  return renderProse(text, ledger, window).replace(EVIDENCE_TOKENS, "").replace(/\s+/g, " ").trim();
}
