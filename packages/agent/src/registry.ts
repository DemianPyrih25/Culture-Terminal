import {
  CANDIDATE_SOURCE_LABEL,
  makeId,
  strongerCandidate,
  strongerConceptMatch,
  type EntityRef,
  type EntityRegistry,
  type RegisteredEntity,
  type RegisteredTag,
  type TagRef,
} from "@ct/contracts";

/**
 * The run registry (PLAN §4.3 "refs only"): run-local R# and T# refs for Qloo entities and tags.
 * Qloo ids stay server-side; the model only ever sees the refs and the table below.
 */

/** One row of the registry table the model reads: names and refs, never Qloo ids or tag URNs. */
export interface RegistryTableRow {
  ref: EntityRef | TagRef;
  name: string;
  /** The entity type (brand, artist, …) or the tag's type. */
  type: string;
  disambiguation: string | null;
  /** Qloo popularity rounded to two decimals; null for tags and unscored entities. */
  popularity: number | null;
  /**
   * "You named" or "Expected" for an entity the question named or CLERK listed as an obvious candidate
   * (R3, CANDIDATE_SOURCE_LABEL); absent for one the data found.
   */
  candidate?: string;
}

export interface RunRegistry extends EntityRegistry {
  /** Entities then tags, in registration order. */
  registryTable(): RegistryTableRow[];
}

/** Shown to the model beside a descriptive tag: such tags rank nothing (probe G1, G6). */
export const DESCRIPTIVE_TAG_NOTE = "descriptive tag, not usable as a signal";

/** The table's candidate marker of an entity: present only for a user-named or obvious candidate. */
function candidateLabel(e: RegisteredEntity): { candidate?: string } {
  const label = e.candidate === undefined ? null : CANDIDATE_SOURCE_LABEL[e.candidate];
  return label === null ? {} : { candidate: label };
}

export function createEntityRegistry(): RunRegistry {
  const entities = new Map<string, RegisteredEntity>();
  const entityRefs = new Map<EntityRef, RegisteredEntity>();
  const tags = new Map<string, RegisteredTag>();
  const tagRefs = new Map<TagRef, RegisteredTag>();

  return {
    registerEntity(entity) {
      if (entity.entityId.trim() === "") throw new TypeError("registerEntity: entityId is empty");
      const known = entities.get(entity.entityId);
      if (known) {
        // Kept in place, so every holder of the record sees it: a name the question gave stays user_named
        // when a later call finds it again (R3).
        const source = strongerCandidate(known.candidate, entity.candidate);
        if (source !== "data") known.candidate = source;
        return known;
      }
      const { candidate, ...rest } = entity;
      const registered: RegisteredEntity = {
        ...rest,
        tags: [...entity.tags],
        ref: makeId("R", entities.size + 1),
        ...(candidate !== undefined && candidate !== "data" ? { candidate } : {}),
      };
      entities.set(registered.entityId, registered);
      entityRefs.set(registered.ref, registered);
      return registered;
    },

    registerTag(tag) {
      if (tag.tagId.trim() === "") throw new TypeError("registerTag: tagId is empty");
      const known = tags.get(tag.tagId);
      if (known) {
        // A tag that is the exact tag of one concept part stays exact when another part reads it as a category (R2).
        const match = strongerConceptMatch(known.conceptMatch, tag.conceptMatch);
        if (match !== undefined) known.conceptMatch = match;
        return known;
      }
      const registered: RegisteredTag = { ...tag, ref: makeId("T", tags.size + 1) };
      tags.set(registered.tagId, registered);
      tagRefs.set(registered.ref, registered);
      return registered;
    },

    entity: (ref) => entityRefs.get(ref) ?? null,
    tag: (ref) => tagRefs.get(ref) ?? null,
    byEntityId: (entityId) => entities.get(entityId) ?? null,
    byTagId: (tagId) => tags.get(tagId) ?? null,
    entities: () => [...entities.values()],
    tags: () => [...tags.values()],

    registryTable: () => [
      ...[...entities.values()].map((e) => ({
        ref: e.ref,
        name: e.name,
        type: e.type,
        disambiguation: e.disambiguation,
        popularity: e.popularity === null ? null : Math.round(e.popularity * 100) / 100,
        ...candidateLabel(e),
      })),
      ...[...tags.values()].map((t) => ({
        ref: t.ref,
        name: t.name,
        type: t.type,
        disambiguation: t.signalCapable ? null : DESCRIPTIVE_TAG_NOTE,
        popularity: null,
      })),
    ],
  };
}
