import { competitionRanks } from "../stats";

/**
 * Text and number formatting shared by the skills. Strings that came from Qloo are untrusted (§4.6):
 * they reach the model only through safeText, inside the escaped <qloo_data> wrapper.
 */

/**
 * C0 and C1 controls plus the invisible format characters that can hide or reorder text for a
 * reader: zero-width marks, bidirectional overrides and isolates, line and paragraph separators,
 * the BOM and tag characters. A superset of the set @ct/qloo's own trimmers remove.
 */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u2060-\u206f]+/gu;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const HIGH_SURROGATE_AT_END = /[\ud800-\udbff]$/;

/** Hidden characters and URLs removed, whitespace collapsed, cut to `max` characters. */
export function safeText(s: string, max = 80): string {
  const clean = s.replace(HIDDEN_CHARS, " ").replace(URL_LIKE, "[link]").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // A cut through a surrogate pair would leave half a character, which JSON and Postgres reject.
  const cut = clean.slice(0, max - 1);
  return `${cut.replace(HIGH_SURROGATE_AT_END, "")}…`;
}

/**
 * Entity names in labels, findings and digests: long enough to tell brands apart, short enough that a
 * full map's rows fit the digest. The ref identifies the entity; the full name stays in the registry.
 */
export const NAME_MAX = 40;

export function safeName(s: string): string {
  return safeText(s, NAME_MAX);
}

/** Names in datasets the reader sees: cleaned like safeName but kept whole, up to @ct/qloo's own name cap. */
export const FULL_NAME_MAX = 120;

export function safeFullName(s: string): string {
  return safeText(s, FULL_NAME_MAX);
}

/** Two decimals for metric displays: the full-precision value stays in the ledger and the dataset. */
export function fixed2(x: number): string {
  return x.toFixed(2);
}

/** "2 of 7". An average-rank tie (2.5) keeps one decimal rather than pretending to be a whole rank. */
export function rankText(rank: number, of: number): string {
  return `${Number.isInteger(rank) ? rank : rank.toFixed(1)} of ${of}`;
}

/**
 * Whole display ranks, descending (1 = highest; ties share the better rank, "1224"), over the
 * non-null values; null values stay unranked.
 */
export function displayRanks(values: readonly (number | null)[]): (number | null)[] {
  const scored = values.filter((v): v is number => v !== null);
  const ranks = competitionRanks(scored, "desc");
  let n = 0;
  return values.map((v) => (v === null ? null : (ranks[n++] ?? null)));
}
