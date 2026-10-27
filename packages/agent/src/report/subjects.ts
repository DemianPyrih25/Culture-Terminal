import { isId, type Metric, type MetricId } from "@ct/contracts";

/**
 * CHECKER V2, the subject half (SPEC §6.2: every token resolves, to what its sentence says it is): a
 * metric token measures the entities in its subject refs. The words that lead up to a token (from the
 * previous metric token or the start of its sentence) say whose number it is; when they name
 * registered entities, none of them a subject, and the sentence names no subject either, the number
 * is handed to another entity ("Brand Beta sits at {{M1}}" where M1 is Brand Alpha's rank). Words
 * that name no entity ("the leader", a list's next item), or that point back past the last name ("it",
 * "each"), pass: the check only catches a number set beside the wrong name.
 */

/** A registered entity as the check reads it. */
export interface SubjectEntity {
  ref: string;
  name: string;
}

/** A token whose lead-up names other entities and whose sentence names none of its subjects. */
export interface MisattributedToken {
  id: MetricId;
  /** The token's subject names, as registered. */
  subjects: string[];
  /** The other registered names its lead-up uses, as registered. */
  named: string[];
}

interface EntityMatcher {
  ref: string;
  name: string;
  /** The whole name, any case, words joined by spaces or hyphens. */
  full: RegExp;
  /** The name's distinctive words (capitalised, four letters or more, in no other registered name), or null. */
  words: RegExp | null;
}

/** Words that never single out a name on their own. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(["the", "with", "and", "for", "from", "feat", "featuring"]);
const NAME_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
const NOT_INSIDE = String.raw`(?![\p{L}\p{N}])`;
const NOT_AFTER = String.raw`(?<![\p{L}\p{N}])`;
/**
 * A sentence break: . ! ? or ; after three lowercase letters, two capitals or a closing token or
 * bracket, before a capital, token or bracket. "Dr. Nova" or "Blk. Water" never break a sentence.
 */
const SENTENCE_BREAK = /(?<=(?:\p{Ll}{3}|\p{Lu}{2}|[)\]}%])[.!?;])\s+(?=[\p{Lu}{[])/u;
const METRIC_TOKEN_RE = /\{\{(M[1-9]\d*)\}\}/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const nameWords = (name: string): string[] => [...name.matchAll(NAME_WORD_RE)].map((m) => m[0]);
const distinctive = (word: string): boolean => /^\p{Lu}/u.test(word) && word.length >= 4 && !FUNCTION_WORDS.has(word.toLowerCase());

function matchers(entities: readonly SubjectEntity[]): EntityMatcher[] {
  const counts = new Map<string, number>();
  for (const e of entities) for (const w of new Set(nameWords(e.name).filter(distinctive))) counts.set(w, (counts.get(w) ?? 0) + 1);
  return entities.flatMap((e) => {
    const all = nameWords(e.name);
    if (all.length === 0) return [];
    const own = [...new Set(all.filter((w) => distinctive(w) && counts.get(w) === 1))];
    return [
      {
        ref: e.ref,
        name: e.name,
        full: new RegExp(NOT_AFTER + all.map(escapeRegExp).join(String.raw`[\s\p{Pd}]+`) + NOT_INSIDE, "giu"),
        words: own.length === 0 ? null : new RegExp(NOT_AFTER + `(?:${own.map(escapeRegExp).join("|")})` + NOT_INSIDE, "gu"),
      },
    ];
  });
}

/**
 * Where `text` last names the entity (the end of that mention), or -1: its whole name in any case,
 * or one of its distinctive words written as a name (capitalised). With `skipFirst`, a distinctive
 * word that opens the text does not count, since every sentence capitalises its first word.
 */
function lastMention(text: string, m: EntityMatcher, skipFirst: boolean): number {
  let end = -1;
  for (const hit of text.matchAll(m.full)) end = Math.max(end, hit.index + hit[0].length);
  if (m.words === null) return end;
  const first = skipFirst ? (/^\s*\S+/u.exec(text)?.[0].length ?? 0) : 0;
  for (const hit of text.matchAll(m.words)) if (hit.index >= first) end = Math.max(end, hit.index + hit[0].length);
  return end;
}

/** Tokens blanked to spaces of the same length, so names are found at their places in the sentence. */
const blankTokens = (s: string): string => s.replace(/\{\{[^{}]*\}\}|\[[^[\]]*\]/gu, (t) => " ".repeat(t.length));

/** A word that points back to an entity named earlier: after one, the lead-up names no new owner. */
const BACK_REFERENCE = /(?<![\p{L}\p{N}])(?:it|its|they|their|them|he|his|him|she|her|each|both|either|neither|which|whose)(?![\p{L}\p{N}])/iu;

/**
 * The misattributed metric tokens of one prose field, in order. Only metrics whose subjects are all
 * registered entities are judged. A token passes when its sentence names a subject anywhere, when
 * its lead-up names no entity, or when a word such as "it" or "each" follows the last name there.
 */
export function misattributedTokens(
  text: string,
  metric: (id: MetricId) => Pick<Metric, "subjectRefs"> | undefined,
  entities: readonly SubjectEntity[],
): MisattributedToken[] {
  if (entities.length < 2) return [];
  const all = matchers(entities);
  const byRef = new Map(all.map((m) => [m.ref, m]));
  const out: MisattributedToken[] = [];
  for (const sentence of text.split(SENTENCE_BREAK)) {
    const plain = blankTokens(sentence);
    let from = 0;
    for (const match of sentence.matchAll(METRIC_TOKEN_RE)) {
      const lead = plain.slice(from, match.index);
      const skipFirst = from === 0;
      from = match.index + match[0].length;
      const id = match[1] as MetricId;
      const refs = metric(id)?.subjectRefs.filter((r) => isId("R", r)) ?? [];
      const subjects = refs.map((r) => byRef.get(r));
      if (refs.length === 0 || subjects.some((s) => s === undefined) || out.some((t) => t.id === id)) continue;
      if (subjects.some((s) => s !== undefined && lastMention(plain, s, false) >= 0)) continue;
      const named = all.map((m) => ({ m, end: lastMention(lead, m, skipFirst) })).filter((x) => x.end >= 0);
      if (named.length === 0) continue;
      const last = Math.max(...named.map((x) => x.end));
      if (BACK_REFERENCE.test(lead.slice(last))) continue;
      out.push({
        id,
        subjects: subjects.flatMap((s) => (s === undefined ? [] : [s.name])),
        named: named.map((x) => x.m.name),
      });
    }
  }
  return out;
}
