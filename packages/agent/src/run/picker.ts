import { createHash } from "node:crypto";
import type { QlooSearchEntity } from "@ct/contracts";

/**
 * Picker keys (D20, contracts PickerCandidate): the browser gets an opaque key per candidate, never
 * the Qloo entity id. A key is a one-way digest of the entity id, so the server maps a choice back by
 * re-running the mention's /search (cached, so free) and matching keys; the answer becomes a pin.
 */

export function pickerKey(entityId: string): string {
  return `pk_${createHash("sha256").update(entityId).digest("hex").slice(0, 16)}`;
}

/** The /search result a picker key names, or null when none of these results carries it. */
export function findPickerChoice(results: readonly QlooSearchEntity[], key: string): QlooSearchEntity | null {
  return results.find((r) => pickerKey(r.entity_id) === key) ?? null;
}
