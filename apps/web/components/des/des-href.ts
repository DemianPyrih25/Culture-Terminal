import type { EntityType } from "@ct/contracts";

/**
 * The DES tearsheet's address and what a reader may type (P1 #1, SPEC D11 and §8.2 "<NAME> DES"):
 * /d/<name> for a brand, /d/<name>?type=<type> for the other types, with ?pick=<key> once a picker
 * choice was made. The name rides in the path as typed (URL-encoded), never slugged: exact matching
 * (D20) compares the name as written. Pure, so the search form, the pages and the server share it.
 */

/**
 * The types a tearsheet describes: every type with an audience of its own. Places and destinations
 * are left out: a venue is searched inside a metro (the LOCATION desk), and a destination is what
 * travel taste ranks.
 */
export const DES_TYPES = ["brand", "artist", "person", "podcast", "tv_show", "movie"] as const satisfies readonly EntityType[];
export type DesType = (typeof DES_TYPES)[number];

export const DEFAULT_DES_TYPE: DesType = "brand";

/** The type as the search form and the meta line name it. */
export const DES_TYPE_LABEL: Readonly<Record<DesType, string>> = {
  brand: "Brand",
  artist: "Artist",
  person: "Public figure",
  podcast: "Podcast",
  tv_show: "TV show",
  movie: "Film",
};

/** Longest name a tearsheet takes, as the command grammar's parts. */
export const DES_NAME_MAX = 80;

/** A picker key (agent run/picker.ts pickerKey): opaque, never the Qloo entity id. */
const PICK_KEY = /^pk_[0-9a-f]{16}$/;

/** Characters a name never needs: controls, angle brackets (the type marker), braces and the like. */
const FORBIDDEN = /[\p{Cc}\p{Cf}<>{}[\]\\`|;]/u;

/** What a tearsheet was asked for. */
export interface DesQuery {
  /** The name as typed, spaces collapsed. */
  name: string;
  type: DesType;
  /** A picker key the reader chose, or null. */
  pick: string | null;
}

export const isDesType = (value: unknown): value is DesType => typeof value === "string" && (DES_TYPES as readonly string[]).includes(value);

/** A name a tearsheet can look up: trimmed, spaces collapsed, with a letter or digit; null otherwise. */
export function cleanDesName(raw: string): string | null {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name === "" || name.length > DES_NAME_MAX || FORBIDDEN.test(name)) return null;
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/** The first value of a search parameter. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The path segment as Next.js hands it over: decoded once more only when it still holds %XX escapes. */
function decodeSegment(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The tearsheet a URL asks for, or null when the name or the type cannot be looked up. A missing type
 * is a brand; a malformed pick is dropped (the picker shows again rather than the page failing).
 */
export function parseDesQuery(
  entity: string,
  search: { type?: string | string[]; pick?: string | string[] } = {},
): DesQuery | null {
  const name = cleanDesName(decodeSegment(entity));
  const rawType = first(search.type)?.trim().toLowerCase();
  if (name === null || (rawType !== undefined && rawType !== "" && !isDesType(rawType))) return null;
  const type = rawType !== undefined && isDesType(rawType) ? rawType : DEFAULT_DES_TYPE;
  const pick = first(search.pick)?.trim() ?? "";
  return { name, type, pick: PICK_KEY.test(pick) ? pick : null };
}

/** The tearsheet's path: /d/<name>, with ?type= for anything but a brand and ?pick= for a choice. */
export function desHref(query: { name: string; type: DesType; pick?: string | null }): string {
  const params = new URLSearchParams();
  if (query.type !== DEFAULT_DES_TYPE) params.set("type", query.type);
  if (query.pick) params.set("pick", query.pick);
  const search = params.toString();
  return `/d/${encodeURIComponent(query.name)}${search === "" ? "" : `?${search}`}`;
}

/** "<TYPE>" as the compiled form prints it. */
const TYPE_MARKER = /\s*<([A-Za-z_]+)>$/;

/**
 * What the search box was given: a plain name, or the command "<NAME> DES" with an optional type
 * marker ("Artist Nova <ARTIST> DES"), as §8.2 compiles it. A marker overrides the type picked
 * beside the box. Null when no name is left or the marker names a type a tearsheet does not take.
 */
export function parseDesInput(input: string, type: string | null = null): { name: string; type: DesType } | null {
  let text = input.replace(/\s+/g, " ").trim();
  if (/ DES$/.test(text)) text = text.slice(0, -4).trim();
  let picked: DesType = isDesType(type) ? type : DEFAULT_DES_TYPE;
  const marker = TYPE_MARKER.exec(text);
  if (marker) {
    const named = (marker[1] ?? "").toLowerCase();
    if (!isDesType(named)) return null;
    picked = named;
    text = text.slice(0, marker.index);
  }
  const name = cleanDesName(text);
  return name === null ? null : { name, type: picked };
}

/**
 * "<NAME> DES" typed where questions go (the Ask field, the top bar): the tearsheet it names, which is
 * a page rather than a run; null for anything else, which stays a question.
 */
export function parseDesCommand(input: string): { name: string; type: DesType } | null {
  return / DES$/.test(input.replace(/\s+/g, " ").trim()) ? parseDesInput(input) : null;
}

/**
 * Where a question goes when it is the command "<NAME> DES": the tearsheet's path, else null (it stays a
 * question). /ask redirects with it before anything reads the question, so no entry point (the top
 * bar, the hero, a follow-up, a shared link) sends the command to CLERK.
 */
export function desCommandHref(question: string): string | null {
  const des = parseDesCommand(question);
  return des === null ? null : desHref(des);
}

/** The command a tearsheet answers, as the grammar prints it: "JUNIPER COLA <BRAND> DES". */
export function desMnemonic(query: { name: string; type: DesType }): string {
  return `${query.name.toUpperCase()} <${query.type.toUpperCase()}> DES`;
}
