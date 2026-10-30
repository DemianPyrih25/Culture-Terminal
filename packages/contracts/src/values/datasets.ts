/** Zod-free dataset values (PLAN §5.3, §8.4); ../datasets.ts holds the payload schemas. */

export const DATASET_KIND_VALUES = [
  "Matrix",
  "Quadrant",
  "Bars",
  "Slope",
  "GeoLift",
  "Ranked",
  "Slate",
  "Momentum",
  "Scorecard",
  "Position",
  "TasteMap",
  "Supply",
] as const;

/**
 * Row flags. KEEP, VETO and ADD are the concept-vector verdicts (S12): an analog the concept's taste
 * keeps, one it vetoes (never a recommendation), and an open-call result the analogs missed. CATEGORY
 * (R2, D48) marks an analog measured against the concept's broader category only, because the data has no
 * tag for the concept itself: it never carries KEEP or VETO.
 */
export const ROW_FLAG_VALUES = ["UTR", "NEW", "LOCAL", "TARGET", "GHOST_PICK", "KEEP", "VETO", "ADD", "CATEGORY"] as const;

/**
 * The absolute popularity ceiling of every "under the radar" or "hidden pocket" label (D3 of the Part 9
 * close-out): at or above it a name is mass-market and never flagged, however low the set's median
 * popularity falls. It applies to the UNDER-THE-RADAR flag and pick (S9 cross_domain, S10 sponsor_slate,
 * creator_fit) and to the HIDDEN_POCKET finding (S3 destination_affinity). The quadrant geometry itself
 * stays split at the within-set medians (D17).
 */
export const UNDER_THE_RADAR_MAX_POPULARITY = 0.85;

/** Most entities one taste map places (SPEC §5.3 S1 P1 extension: triangular calls ≤ 13). */
export const TASTE_MAP_MAX_K = 14;
/** Fewest entities a 2D map is drawn for. */
export const TASTE_MAP_MIN_K = 3;

/** Named places one Supply exhibit lists at most (R6). */
export const SUPPLY_PLACES_MAX = 60;
/** The source line of every Supply exhibit; `osmBase` is the data's date (YYYY-MM-DD) or null when unknown. */
export function supplySourceLine(osmBase: string | null): string {
  const asOf = osmBase === null ? "date unknown" : `data as of ${osmBase.slice(0, 10)}`;
  return `Source: OpenStreetMap via Overpass API · ${asOf} · © OpenStreetMap contributors (ODbL) · Culture Terminal analysis`;
}
