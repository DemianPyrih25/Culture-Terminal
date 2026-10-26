import {
  AGE_BUCKET_LABEL,
  AgeBucket,
  OLD_AGE_BUCKETS,
  YOUNG_AGE_BUCKETS,
  type Gender,
  type NoValueReason,
  type QlooDemographicsBlock,
} from "@ct/contracts";
import { mean } from "../../stats";

/**
 * S3 demographic profiles (SPEC §5.3 S3, probe G12): Qloo's age and gender affinity indices, −1..1
 * around the average audience (0), never population shares. An entity without a block is "not
 * measured", never 0.
 */

/** Gender bars in display order, with the labels the DNA figure prints. */
export const GENDER_BARS: readonly (readonly [Gender, string])[] = [
  ["female", "Women"],
  ["male", "Men"],
];

export const AGE_BARS: readonly (readonly [AgeBucket, string])[] = AgeBucket.options.map((b) => [b, AGE_BUCKET_LABEL[b]] as const);

export interface Indices {
  age: Readonly<Record<AgeBucket, number>>;
  gender: Readonly<Record<Gender, number>>;
}

/** A subject's indices, or why it has none (not_measured: no block; budget_truncated: no call). */
export type DnaProfile = ({ measured: true } & Indices) | { measured: false; reason: NoValueReason };

export function profileOf(block: QlooDemographicsBlock): DnaProfile {
  return { measured: true, age: { ...block.query.age }, gender: { female: block.query.gender.female, male: block.query.gender.male } };
}

/** Y = mean(a≤24, a25–29) − mean(a45–54, a55+) (FORMULAS dna.youth_index). */
export function youthIndex(indices: Indices): number {
  return mean(YOUNG_AGE_BUCKETS.map((b) => indices.age[b]))! - mean(OLD_AGE_BUCKETS.map((b) => indices.age[b]))!;
}

/** The per-bucket mean of several profiles: the "peers, average of n" series. Null for none. */
export function averageIndices(profiles: readonly Indices[]): Indices | null {
  if (profiles.length === 0) return null;
  const avg = (values: number[]) => mean(values)!;
  const age = Object.fromEntries(AgeBucket.options.map((b) => [b, avg(profiles.map((p) => p.age[b]))])) as Record<AgeBucket, number>;
  return {
    age,
    gender: { female: avg(profiles.map((p) => p.gender.female)), male: avg(profiles.map((p) => p.gender.male)) },
  };
}

/** The age buckets with the highest and lowest index (the first in bucket order on a tie). */
export function ageExtremes(indices: Indices): { highest: AgeBucket; lowest: AgeBucket } {
  let highest: AgeBucket = "24_and_younger";
  let lowest: AgeBucket = "24_and_younger";
  for (const b of AgeBucket.options) {
    if (indices.age[b] > indices.age[highest]) highest = b;
    if (indices.age[b] < indices.age[lowest]) lowest = b;
  }
  return { highest, lowest };
}
