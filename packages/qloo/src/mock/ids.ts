import { hashHex } from "./hash";

/**
 * Synthetic entity ids: "mock-ent-" + 12 hex digits. They are never UUID-shaped (D29). The first
 * digit encodes the entity type and, for places and localities, the second encodes the metro, so
 * /entities and location parameters can recover both from the id alone without any mock state.
 */

const TYPE_DIGITS: Readonly<Record<string, string>> = {
  "urn:entity:brand": "1",
  "urn:entity:artist": "2",
  "urn:entity:podcast": "3",
  "urn:entity:tv_show": "4",
  "urn:entity:movie": "5",
  "urn:entity:person": "6",
  "urn:entity:destination": "7",
  "urn:entity:place": "8",
  "urn:entity:locality": "9",
};

const ID_PATTERN = /^mock-ent-([0-9a-f])([0-9a-f])[0-9a-f]{10}$/;
const GEO_TYPES = new Set(["urn:entity:place", "urn:entity:locality"]);

/** The id for a type and a normalised name (plus a disambiguation when two entities share a name). */
export function entityId(type: string, normalizedName: string, options: { metroCode?: string; disambiguation?: string } = {}): string {
  const typeDigit = TYPE_DIGITS[type] ?? "0";
  const head = GEO_TYPES.has(type) ? typeDigit + (options.metroCode ?? "0") : typeDigit;
  const hash = hashHex("entity", type, normalizedName, options.disambiguation ?? "");
  return `mock-ent-${head}${hash.slice(0, 12 - head.length)}`;
}

/** The entity type a mock id encodes, or null for ids the mock did not issue. */
export function typeOfId(id: string): string | null {
  const digit = ID_PATTERN.exec(id)?.[1];
  if (digit === undefined) return null;
  return Object.keys(TYPE_DIGITS).find((t) => TYPE_DIGITS[t] === digit) ?? null;
}

/** The metro digit of a mock place or locality id, or null. */
export function metroCodeOfId(id: string): string | null {
  const match = ID_PATTERN.exec(id);
  const type = typeOfId(id);
  if (!match || type === null || !GEO_TYPES.has(type)) return null;
  return match[2] ?? null;
}
