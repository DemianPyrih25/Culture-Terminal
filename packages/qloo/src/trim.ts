import { QLOO_DESCRIPTION_MAX_CHARS, type QlooEntity, type QlooSearchEntity } from "@ct/contracts";

/**
 * Trimmers (PLAN §5.1, §4.6): Qloo text is third-party content that reaches the model, so it is
 * stripped of URLs and control characters and cut short, and entities shrink to the few fields a
 * digest needs.
 */

const NAME_MAX_CHARS = 120;
const TAG_NAME_MAX_CHARS = 60;
const SUBTYPE_MAX_CHARS = 60;
const TOP_TAGS = 5;

/** Scheme URLs (`https://…`), URIs whose scheme needs no slashes (`javascript:…`), and www. hosts. */
const SCHEME_URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|vbscript|data|mailto|tel|sms|file):|www\.)\S+/gi;

/**
 * Bare references: e-mail addresses, host/path forms with a letter TLD (so "4.5/5" survives), and
 * bare hosts on common web TLDs (an optional country suffix covers forms like ".co.uk").
 */
const BARE_URL_RE = new RegExp(
  [
    String.raw`[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|ai|xyz|info|biz|me|tv|ly|gg|link|site|online|shop|store)(?:\.[a-z]{2})?\b`,
  ].join("|"),
  "gi",
);

/**
 * C0 and C1 controls, plus invisible format characters that can hide text from a reader: zero-width
 * marks, line and paragraph separators, bidirectional overrides and isolates, and the BOM.
 */
function isControl(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x61c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/** Strips URLs and control characters, collapses whitespace and cuts to `max` characters (code points). */
export function sanitizeQlooText(s: string, max: number = QLOO_DESCRIPTION_MAX_CHARS): string {
  return tidy(s.replace(SCHEME_URL_RE, " ").replace(BARE_URL_RE, " "), max);
}

/**
 * For entity names: like {@link sanitizeQlooText}, but a bare domain stays, because for brands such
 * as "Shop Alpha.com" it is the name itself. Scheme URLs, www. hosts and controls still go.
 */
export function sanitizeQlooName(s: string, max: number = NAME_MAX_CHARS): string {
  return tidy(s.replace(SCHEME_URL_RE, " "), max);
}

/** Replaces control characters with spaces, collapses whitespace and cuts to `max` code points. */
function tidy(s: string, max: number): string {
  let visible = "";
  for (const ch of s) visible += isControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  const collapsed = visible.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** An entity as the model sees it (PLAN §5.1 trimmers). */
export interface TrimmedEntity {
  ref: string;
  name: string;
  subtype: string | null;
  popularity: number | null;
  affinity: number | null;
  /** Up to five tag names, in Qloo's order. */
  tags: string[];
  /** Short description, at most QLOO_DESCRIPTION_MAX_CHARS characters. */
  desc: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Reduces an insights or search entity to the trimmed shape under a run-local ref. */
export function trimEntity(entity: QlooEntity | QlooSearchEntity, ref: string): TrimmedEntity {
  const e = entity as Record<string, unknown>;
  const types = Array.isArray(e.types) ? (e.types as unknown[]) : [];
  const rawSubtype = text(e.subtype) ?? text(e.type) ?? text(types[0]);
  const properties = record(e.properties);
  const description = text(properties.short_description) ?? text(properties.description);
  const tags: string[] = [];
  for (const tag of Array.isArray(e.tags) ? (e.tags as unknown[]) : []) {
    const name = text(record(tag).name);
    const label = name === null ? "" : sanitizeQlooText(name, TAG_NAME_MAX_CHARS);
    if (label !== "" && !tags.includes(label)) tags.push(label);
    if (tags.length === TOP_TAGS) break;
  }
  return {
    ref,
    name: sanitizeQlooName(entity.name),
    subtype: rawSubtype === null ? null : sanitizeQlooText(rawSubtype, SUBTYPE_MAX_CHARS) || null,
    popularity: finite(e.popularity),
    affinity: finite(record(e.query).affinity),
    tags,
    desc: description === null ? null : sanitizeQlooText(description) || null,
  };
}
