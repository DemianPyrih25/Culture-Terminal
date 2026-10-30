import { curatedConcept } from "@ct/quant";
import { z } from "zod";
import raw from "../../../../config/osm_tags.json";

/**
 * The OpenStreetMap place types a run can count (R6, D46, PLAN §5.2): config/osm_tags.json, verified tags
 * only. The run context lists their keys and labels as LOCAL SUPPLY TYPES when OpenStreetMap is configured,
 * and the opening scan maps the question's concept to them: through its curated category
 * (config/categories.json key in a type's `concepts`), else when the concept names a type by its key,
 * label or an alias as whole words ("ramen counter" names ramen). A concept no type matches is counted by
 * street activity only, and the note says there is no OpenStreetMap tag for it.
 */

const PlaceType = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  group: z.string().optional(),
  status: z.string(),
});
const OsmTagsConfig = z.object({ place_types: z.array(PlaceType) });

export interface LocalSupplyType {
  key: string;
  label: string;
  aliases: readonly string[];
  /** config/categories.json keys this type counts for. */
  concepts: readonly string[];
}

export function localSupplyTypesFrom(config: unknown): LocalSupplyType[] {
  return OsmTagsConfig.parse(config).place_types.flatMap((t) =>
    t.status === "verified" ? [{ key: t.key, label: t.label, aliases: t.aliases, concepts: t.concepts }] : [],
  );
}

/** The verified place types, in file order. */
export const LOCAL_SUPPLY_TYPES: readonly LocalSupplyType[] = localSupplyTypesFrom(raw);

/** local_supply's place_types maximum. */
export const SUPPLY_TYPES_MAX = 4;

/** Words of a name as whole-word matching reads them: lower case, letters and digits, single spaces. */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[_\s]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** The place type keys one concept maps to: its curated category first, else the types it names. */
function typesOf(concept: string, types: readonly LocalSupplyType[]): string[] {
  const curated = curatedConcept(concept)?.key ?? null;
  if (curated !== null) {
    const byCategory = types.filter((t) => t.concepts.includes(curated)).map((t) => t.key);
    if (byCategory.length > 0) return byCategory;
  }
  const text = words(concept);
  return types.filter((t) => [t.key, t.label, ...t.aliases].some((n) => words(n).trim() !== "" && text.includes(words(n)))).map((t) => t.key);
}

/**
 * The place type keys the question's concept parts map to, in concept order, at most SUPPLY_TYPES_MAX, and
 * the parts no type matched (each gets the "No OpenStreetMap tag" limitation).
 */
export function supplyTypesForConcepts(
  concepts: readonly string[],
  types: readonly LocalSupplyType[] = LOCAL_SUPPLY_TYPES,
): { keys: string[]; unmapped: string[] } {
  const keys: string[] = [];
  const unmapped: string[] = [];
  for (const concept of concepts) {
    const found = typesOf(concept, types);
    if (found.length === 0) unmapped.push(concept);
    for (const k of found) if (!keys.includes(k)) keys.push(k);
  }
  return { keys: keys.slice(0, SUPPLY_TYPES_MAX), unmapped };
}

/** The "No OpenStreetMap tag" limitation for a concept no place type counts. */
export function noOsmTagText(concept: string): string {
  const name = concept.replace(/[\p{Cc}\p{Cf}"]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return `No OpenStreetMap tag for '${name}': only overall street activity (shops, food and drink places) was counted for it.`;
}
