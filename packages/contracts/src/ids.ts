import { z } from "zod";
import { ID_PATTERNS, ID_PREFIXES, type Id, type IdPrefix } from "./values/ids";

/** Run-scoped ids and prose tokens live in ./values/ids.ts (zod-free); this module adds the id schemas. */
export * from "./values/ids";

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
