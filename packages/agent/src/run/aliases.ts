import { entityTypeUrn, EntityType, type Mention, type QlooSearchEntity } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { z } from "zod";
import raw from "../../../../config/brand_aliases.json";

/**
 * Known short names (Part 9 open issue 5, the D20 alias exception): "KFC" stops at the picker because
 * Qloo names the brand "Kentucky Fried Chicken". config/brand_aliases.json lists such names; the gate
 * applies an entry only when its live check verified it (tools/dev/brand-aliases.ts check), and only to
 * a result the mention's own /search returned, so an alias never invents an entity: it accepts a
 * candidate the picker would have offered first, and the resolve event says so ("Read 'KFC' as …").
 */

const AliasEntry = z.object({
  alias: z.string().min(1),
  names: z.array(z.string().min(1)).min(1),
  type: EntityType,
  status: z.enum(["verified", "unverified"]),
  verified_by: z.string().min(1).nullable(),
});
export const BrandAliasConfig = z.object({ aliases: z.array(AliasEntry) });
export type BrandAliasConfig = z.infer<typeof BrandAliasConfig>;

export interface BrandAlias {
  alias: string;
  /** The official names the alias may resolve to, as Qloo writes them. */
  names: readonly string[];
  type: EntityType;
}

/** The verified entries of a config, in file order; an unverified entry never applies. */
export function verifiedAliases(config: unknown): BrandAlias[] {
  return BrandAliasConfig.parse(config).aliases.flatMap((a) => (a.status === "verified" ? [{ alias: a.alias, names: a.names, type: a.type }] : []));
}

/** config/brand_aliases.json is ours, so a malformed file fails loudly at start-up. */
export const BRAND_ALIASES: readonly BrandAlias[] = verifiedAliases(raw);

/**
 * The search result an alias lets the gate apply for a mention that has no exact match: the mention's
 * normalised text equals a verified alias of the same entity type, and a result's normalised name equals
 * one of that alias's names (the first such result, in search order). Null otherwise.
 */
export function aliasMatch(
  mention: Pick<Mention, "text" | "entity_type">,
  results: readonly QlooSearchEntity[],
  aliases: readonly BrandAlias[] = BRAND_ALIASES,
): QlooSearchEntity | null {
  const key = normaliseName(mention.text);
  if (key === "") return null;
  const entry = aliases.find((a) => a.type === mention.entity_type && normaliseName(a.alias) === key);
  if (entry === undefined) return null;
  const names = new Set(entry.names.map(normaliseName));
  return results.find((r) => names.has(normaliseName(r.name))) ?? null;
}

/** Words a search result may add after an expected name ("Health-Ade" → "Health-Ade Kombucha"). */
export const LEADING_NAME_MAX_EXTRA_WORDS = 2;

/**
 * An expected (obvious) candidate CLERK named loosely: the search's top result of the right type when its
 * name is the expected name followed by at most two more words, and no other result of that type starts the
 * same way. Only for obvious candidates, never for a name the question gave (those stay exact or pick), and
 * the resolve event reads "Read 'Health-Ade' as 'Health-Ade Kombucha'" so the reader sees the reading.
 */
export function leadingNameMatch(
  mention: Pick<Mention, "text" | "entity_type">,
  results: readonly QlooSearchEntity[],
  typeUrn: string,
): QlooSearchEntity | null {
  const key = normaliseName(mention.text);
  if (key === "") return null;
  const ofType = results.filter((r) => r.types.includes(typeUrn));
  const leading = ofType.filter((r) => {
    const name = normaliseName(r.name);
    if (!name.startsWith(`${key} `)) return false;
    return name.slice(key.length + 1).split(" ").filter(Boolean).length <= LEADING_NAME_MAX_EXTRA_WORDS;
  });
  const top = ofType[0];
  return top !== undefined && leading.length === 1 && leading[0] === top ? top : null;
}

/**
 * The one reading of a name with no exact match, shared by the gate and meant for the ANALYST's own
 * resolve_entities: a verified known alias of the mention's type (aliasMatch) for any name, else, only when
 * `leading` (a name the run expected, never one the question gave) and the search matched nothing (never an
 * ambiguous name), the unique top result that adds a word or two (leadingNameMatch). Null keeps the miss.
 * Either way the result is one the mention's own /search returned, and the caller shows the reading.
 */
export function knownNameReading(
  mention: Pick<Mention, "text" | "entity_type">,
  results: readonly QlooSearchEntity[],
  match: "ambiguous" | "not_found",
  leading: boolean,
  aliases: readonly BrandAlias[] = BRAND_ALIASES,
): QlooSearchEntity | null {
  const aliased = aliasMatch(mention, results, aliases);
  if (aliased !== null) return aliased;
  return leading && match === "not_found" ? leadingNameMatch(mention, results, entityTypeUrn(mention.entity_type)) : null;
}
