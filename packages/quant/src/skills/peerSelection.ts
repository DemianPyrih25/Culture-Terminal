import type { QlooEntity } from "@ct/contracts";
import { QUALITY_GATE_MIN_POPULARITY } from "../stats";
import { insightTags, type EntityDraft, type EntityTagRef } from "./common";

/**
 * The deterministic S1 peer rule (SPEC §5.3): named peers first, then same-category discovery (D1)
 * up to k−1 peers, topped up from same-category D2 results when D1 runs out, with the last slot kept
 * for the top cross-category result (D2) when it lies outside the target's category. Pure, so the
 * same discovery responses always give the same map.
 */

const BRAND_CATEGORY_PREFIX = "urn:tag:genre:brand:";

/**
 * The brand's category: its genre:brand leaf (SPEC §5.3 S1), the one D1 filters on. Qloo lists every
 * level of the path (beverage, …:beverage:water, …:beverage:water:sparkling), so the leaf is the
 * deepest tag; the first of equally deep tags wins.
 */
export function categoryTagOf(entity: { tags: readonly EntityTagRef[] }): EntityTagRef | null {
  let leaf: EntityTagRef | null = null;
  for (const tag of entity.tags) {
    if (!tag.tagId.startsWith(BRAND_CATEGORY_PREFIX)) continue;
    if (leaf === null || tagDepth(tag.tagId) > tagDepth(leaf.tagId)) leaf = tag;
  }
  return leaf;
}

function tagDepth(tagId: string): number {
  return tagId.split(":").length;
}

/**
 * True only when the entity's tags are known and lack the category tag. Unknown tags never count
 * as outside, so a missing tag list cannot fire OUTSIDE_CATEGORY_NEIGHBOUR.
 */
export function isOutsideCategory(entity: { tags: readonly EntityTagRef[] }, categoryTagId: string | null): boolean {
  return categoryTagId !== null && entity.tags.length > 0 && !entity.tags.some((t) => t.tagId === categoryTagId);
}

/** The §5.2 quality gate; a result without a popularity (missing or null) is kept (a missing field is not an artifact). */
export function passesQualityGate(r: QlooEntity): boolean {
  return r.popularity === undefined || r.popularity === null || r.popularity >= QUALITY_GATE_MIN_POPULARITY;
}

export function draftFromInsight(r: QlooEntity): EntityDraft {
  return {
    entityId: r.entity_id,
    name: r.name,
    type: "brand",
    popularity: r.popularity ?? null,
    disambiguation: r.disambiguation ?? null,
    tags: insightTags(r.tags),
  };
}

export type PeerSource = "named" | "discovered" | "outside_category";

export interface SelectedPeer {
  entity: EntityDraft;
  source: PeerSource;
}

export interface PeerSelectionInput {
  target: EntityDraft;
  /** The target's category tag; null when it has none, in which case D2 fills the peers. */
  categoryTagId: string | null;
  /** Named brand peers, already registered. */
  named: readonly EntityDraft[];
  /** Peer slots: k − 1. */
  slots: number;
  /** D1 results in Qloo order; empty when D1 was not made. */
  sameCategory: readonly QlooEntity[];
  /** D2 results in Qloo order; empty when D2 was not made. */
  crossCategory: readonly QlooEntity[];
}

export interface PeerSelection {
  peers: SelectedPeer[];
  /** The top cross-category result when it lies outside the category, whether or not it got a slot. */
  outsideNeighbour: EntityDraft | null;
  /** Results skipped by the quality gate on the way to a pick (each is a QUALITY_GATE_DROPPED). */
  gateDropped: string[];
  /** Distinct discovery results that pass the gate and are not the target. */
  usable: number;
}

/**
 * Where discovered peers come from, in order. With a category: D1, then the D2 results that carry the
 * category tag, since filter.tags on brand insights is not yet probe-verified and D1 may come back
 * thin or empty while D2 holds same-category brands. Without a category: D2.
 */
function discoveryPool(input: PeerSelectionInput): readonly QlooEntity[] {
  const category = input.categoryTagId;
  if (category === null) return input.crossCategory;
  return [...input.sameCategory, ...input.crossCategory.filter((r) => (r.tags ?? []).some((t) => t.id === category))];
}

export function selectPeers(input: PeerSelectionInput): PeerSelection {
  const targetId = input.target.entityId;
  const taken = new Set<string>([targetId]);
  const gateDropped = new Map<string, string>();
  const peers: SelectedPeer[] = [];

  for (const e of input.named) {
    if (peers.length >= input.slots) break;
    if (taken.has(e.entityId)) continue;
    taken.add(e.entityId);
    peers.push({ entity: e, source: "named" });
  }

  // The top D2 result is the first one that is not the target and passes the gate.
  let topCross: QlooEntity | undefined;
  for (const r of input.crossCategory) {
    if (r.entity_id === targetId) continue;
    if (passesQualityGate(r)) {
      topCross = r;
      break;
    }
    gateDropped.set(r.entity_id, r.name);
  }
  const topDraft = topCross === undefined ? null : draftFromInsight(topCross);
  const outsideNeighbour = topDraft !== null && isOutsideCategory(topDraft, input.categoryTagId) ? topDraft : null;
  const reserve = outsideNeighbour !== null && !taken.has(outsideNeighbour.entityId) && peers.length < input.slots;
  if (reserve) taken.add(outsideNeighbour.entityId);

  for (const r of discoveryPool(input)) {
    if (peers.length >= input.slots - (reserve ? 1 : 0)) break;
    if (taken.has(r.entity_id)) continue;
    if (!passesQualityGate(r)) {
      gateDropped.set(r.entity_id, r.name);
      continue;
    }
    taken.add(r.entity_id);
    peers.push({ entity: draftFromInsight(r), source: "discovered" });
  }
  if (reserve) peers.push({ entity: outsideNeighbour, source: "outside_category" });

  const usable = new Set(
    [...input.sameCategory, ...input.crossCategory]
      .filter((r) => r.entity_id !== targetId && passesQualityGate(r))
      .map((r) => r.entity_id),
  ).size;
  return { peers, outsideNeighbour, gateDropped: [...gateDropped.values()], usable };
}
