import { CONFIDENCE_CAP, CONFIDENCE_PENALTY, ConfidenceRule, confidenceBand, type Confidence, type Signal } from "@ct/contracts";

/**
 * Run confidence (SPEC §6.4, D9, D47): 100 minus fixed penalties per issue, floored at 0, then bounded by
 * the lowest fired cap (CONFIDENCE_CAP), so the band follows the strength of the signal and of the sample
 * behind the headline (R1: never HIGH beside a mixed or weak signal or a thin sample). Code computes it
 * from counts the assembler collects; the model never chooses it. The breakdown feeds the hover.
 */

export const CONFIDENCE_START = 100;

/** Hover labels, one per rule; the count and the points sit next to them. */
export const CONFIDENCE_RULE_LABEL: Readonly<Record<ConfidenceRule, string>> = {
  dropped_entity: "A name was dropped or could not be matched",
  code_fallback: "A step fell back to a simpler method (such as a point instead of an area outline)",
  coarse_geohash: "Some area lift rests on a coarse heatmap grid",
  stale_momentum: "Momentum comes from a historical window only",
  thin_result: "A data call returned fewer than five rows",
  quality_gate_drop: "Very low-popularity results were dropped",
  checker_warning: "The answer was accepted with a checker warning",
  insufficient_evidence: "Too little evidence to read a signal",
  read_as_nearest_job: "The question was read as the nearest job, so part of it is not covered",
  concept_partly_tagged: "Part of the concept was not tested (a tag search came back empty or a part was never used)",
  signal_mixed: "The signal is mixed, so confidence stays at most medium",
  signal_weak: "The signal is weak, so confidence is low",
  thin_sample: "The headline rests on a small sample, so confidence stays at most medium",
  category_level: "The concept is not in the data; only its broader category was read",
};

/** What the run went through. Omitted counts are 0 and omitted booleans false. */
export interface ConfidenceInput {
  /** The note's signal after V7: mixed caps the score at 70 (signal_mixed), weak at 45 (signal_weak). */
  signal?: Signal;
  /** A metric behind the headline, the thesis or a decided hypothesis rests on a thin sample (Metric.thin). Caps at 70. */
  thinSample?: boolean;
  /** The concept was read only at category level (CATEGORY_LEVEL_READ, a cited category metric, V12a). Caps at 60. */
  categoryLevel?: boolean;
  /**
   * Secondary mentions dropped at the resolution gate (D20, SECONDARY_ENTITY_DROPPED) and requested
   * entities that no call scored at all. An entity missing from only some contexts is a limitation
   * (DROPPED_CANDIDATES), not a penalty.
   */
  droppedEntities?: number;
  /** CODE FALLBACK steps taken (`fallback` events), e.g. a BLOCK polygon falling back to a point. */
  codeFallbacks?: number;
  /** Some neighbourhood lift rests on a coarse heatmap grid (gh5 or coarser, COARSE_GEOHASH). Counts once. */
  coarseGeohash?: boolean;
  /** The report cites momentum, which exists only for the frozen historical window (D19). Counts once. */
  staleMomentumCited?: boolean;
  /** Qloo calls that returned fewer than five rows (THIN_RESULT). */
  thinResults?: number;
  /** Results the quality gate dropped (popularity below 0.01, QUALITY_GATE_DROPPED). */
  qualityGateDrops?: number;
  /** CHECKER warnings the report was accepted with. */
  checkerWarnings?: number;
  /** The note's signal is insufficient_evidence: V7 forced it (fewer than three ok bundles, or Qloo disabled), the ANALYST chose it, or the note is an evidence digest. Counts once. */
  insufficientEvidence?: boolean;
  /** CLERK read the question as the nearest job, so part of it is not covered (D41, READ_AS_NEAREST_JOB). Counts once. */
  readAsNearestJob?: boolean;
  /**
   * Part of the question's concept was never tested (D2 of the Part 9 close-out): a find_tags search for a
   * concept part came back EMPTY_RESULT, or a concept part got no tag and no analog that any call used.
   * Counts once; alone it caps the note at MED.
   */
  conceptPartlyTagged?: boolean;
}

function occurrences(value: number | undefined, field: keyof ConfidenceInput): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`computeConfidence: ${field} must be a non-negative integer, got ${n}`);
  return n;
}

/**
 * The contracts Confidence object. Breakdown lines follow the ConfidenceRule order and list only rules that
 * fired. A penalty line carries its full points; a cap line carries its `cap` and, when it is the binding
 * ceiling below the penalty score, the points that ceiling took off (else 0). Score =
 * min(max(0, 100 − penalties), lowest fired cap).
 */
export function computeConfidence(input: ConfidenceInput): Confidence {
  const counts: Record<ConfidenceRule, number> = {
    dropped_entity: occurrences(input.droppedEntities, "droppedEntities"),
    code_fallback: occurrences(input.codeFallbacks, "codeFallbacks"),
    coarse_geohash: input.coarseGeohash ? 1 : 0,
    stale_momentum: input.staleMomentumCited ? 1 : 0,
    thin_result: occurrences(input.thinResults, "thinResults"),
    quality_gate_drop: occurrences(input.qualityGateDrops, "qualityGateDrops"),
    checker_warning: occurrences(input.checkerWarnings, "checkerWarnings"),
    insufficient_evidence: input.insufficientEvidence ? 1 : 0,
    read_as_nearest_job: input.readAsNearestJob ? 1 : 0,
    concept_partly_tagged: input.conceptPartlyTagged ? 1 : 0,
    signal_mixed: input.signal === "mixed" ? 1 : 0,
    signal_weak: input.signal === "weak" ? 1 : 0,
    thin_sample: input.thinSample ? 1 : 0,
    category_level: input.categoryLevel ? 1 : 0,
  };
  const fired = ConfidenceRule.options.filter((rule) => counts[rule] > 0);
  const penalties = fired.reduce((total, rule) => total + CONFIDENCE_PENALTY[rule] * counts[rule], 0);
  const s0 = Math.max(0, CONFIDENCE_START - penalties);
  const capRules = fired.filter((rule) => CONFIDENCE_CAP[rule] !== undefined);
  const c = Math.min(CONFIDENCE_START, ...capRules.map((rule) => CONFIDENCE_CAP[rule] as number));
  const score = Math.min(s0, c);
  // The first cap rule (in rule order) at the lowest ceiling carries the points the ceiling took off.
  const binding = c < s0 ? capRules.find((rule) => CONFIDENCE_CAP[rule] === c) : undefined;
  const breakdown = fired.map((rule) => {
    const cap = CONFIDENCE_CAP[rule];
    const penalty = -CONFIDENCE_PENALTY[rule] * counts[rule];
    const points = cap === undefined ? penalty : penalty + (rule === binding ? c - s0 : 0);
    return {
      rule,
      label: CONFIDENCE_RULE_LABEL[rule],
      count: counts[rule],
      points: points === 0 ? 0 : points,
      ...(cap === undefined ? {} : { cap }),
    };
  });
  return { score, band: confidenceBand(score), breakdown };
}
