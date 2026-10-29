import { CONFIDENCE_PENALTY, ConfidenceRule, confidenceBand, type Confidence } from "@ct/contracts";

/**
 * Run confidence (SPEC §6.4, D9): 100 minus fixed penalties per issue, floored at 0. Code computes it
 * from counts the assembler collects; the model never chooses it. The breakdown feeds the hover.
 */

export const CONFIDENCE_START = 100;

/** Hover labels, one per rule; the count and the points sit next to them. */
export const CONFIDENCE_RULE_LABEL: Readonly<Record<ConfidenceRule, string>> = {
  dropped_entity: "A name was dropped or could not be matched",
  code_fallback: "A step fell back to a simpler method (for example a point instead of an area outline)",
  coarse_geohash: "Some area lift rests on a coarse heatmap grid",
  stale_momentum: "Momentum comes from a historical window only",
  thin_result: "A data call returned fewer than five rows",
  quality_gate_drop: "Very low-popularity results were dropped",
  checker_warning: "The answer was accepted with a checker warning",
  insufficient_evidence: "Too little evidence to read a signal",
  read_as_nearest_job: "The question was read as the nearest job, so part of it is not covered",
  concept_partly_tagged: "Part of the concept was not tested (a tag search came back empty or a part was never used)",
};

/** What the run went through. Omitted counts are 0 and omitted booleans false. */
export interface ConfidenceInput {
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
 * The contracts Confidence object. Breakdown lines follow the ConfidenceRule order and list only
 * rules that fired, each with its full points; the score alone is floored at 0.
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
  };
  const breakdown = ConfidenceRule.options
    .filter((rule) => counts[rule] > 0)
    .map((rule) => ({
      rule,
      label: CONFIDENCE_RULE_LABEL[rule],
      count: counts[rule],
      points: -CONFIDENCE_PENALTY[rule] * counts[rule],
    }));
  const score = Math.max(0, breakdown.reduce((total, line) => total + line.points, CONFIDENCE_START));
  return { score, band: confidenceBand(score), breakdown };
}
