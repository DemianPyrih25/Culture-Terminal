import "server-only";
import { EntityType } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { z } from "zod";
import config from "../../../../config/showcases.json";
import { isDesType, type DesType } from "../../components/des/des-href";
import { log } from "../log";

/**
 * The curated entities (D31 for tearsheets): the names the showcases of config/showcases.json are
 * about, their expected mentions and extra pins. Only these tearsheets are indexed; every other one
 * is a reader's own lookup and carries noindex. Names only (D29): the config holds no Qloo value.
 *
 * A curated person was vetted as a public figure when the showcase was written, so the tearsheet
 * looks them up without any other check (service.ts).
 *
 * The config is read on first use, not on import, and a config that does not parse leaves nothing
 * curated: a slip there costs the tearsheets their index entries, never a route that imports this.
 */

const ShowcaseNames = z.object({
  showcases: z.array(
    z.object({
      expected: z.object({ mentions: z.array(z.object({ text: z.string().min(1), entity_type: EntityType })) }),
      extra_pins: z.array(z.object({ text: z.string().min(1), entity_type: EntityType })).default([]),
    }),
  ),
});

/** A curated entity: its name as the config spells it and its type. */
export interface CuratedEntity {
  name: string;
  type: DesType;
}

const keyOf = (name: string, type: DesType): string => `${type}|${normaliseName(name)}`;

/** The DES-typed names of a showcases config, each once, as first spelt. */
export function curatedEntitiesOf(raw: unknown): CuratedEntity[] {
  const seen = new Set<string>();
  const out: CuratedEntity[] = [];
  for (const showcase of ShowcaseNames.parse(raw).showcases) {
    for (const m of [...showcase.expected.mentions, ...showcase.extra_pins]) {
      if (!isDesType(m.entity_type)) continue;
      const key = keyOf(m.text, m.entity_type);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m.text, type: m.entity_type });
    }
  }
  return out;
}

let byKey: ReadonlyMap<string, CuratedEntity> | null = null;

/** The curated entities by name key, in config order; empty when the config cannot be read. */
function curatedIndex(): ReadonlyMap<string, CuratedEntity> {
  if (byKey === null) {
    try {
      byKey = new Map(curatedEntitiesOf(config).map((e) => [keyOf(e.name, e.type), e]));
    } catch (err) {
      log.error({ err }, "des: config/showcases.json could not be read; no tearsheet is curated");
      byKey = new Map();
    }
  }
  return byKey;
}

/** Every curated entity, in config order. */
export function curatedEntities(): readonly CuratedEntity[] {
  return [...curatedIndex().values()];
}

/** The curated entity a name of this type is, compared as the resolution gate compares names; null when none. */
export function curatedEntity(name: string, type: DesType): CuratedEntity | null {
  return curatedIndex().get(keyOf(name, type)) ?? null;
}

/** Whether a name of this type is curated. */
export function isCurated(name: string, type: DesType): boolean {
  return curatedEntity(name, type) !== null;
}
