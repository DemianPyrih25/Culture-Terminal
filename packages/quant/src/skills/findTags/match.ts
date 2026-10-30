import type { ConceptMatch, EntityRegistry } from "@ct/contracts";
import { curatedConcept } from "./curated";
import { conceptWords, normaliseConcept } from "./tags";

/**
 * R2 (D48): how a find_tags concept matches the question's concept parts, so every metric that reads a
 * concept tag can say what it measures (Metric.conceptRead) and the CHECKER never lets a look-alike tag
 * stand in for a concept the data does not hold.
 * - exact: the search text is a question part (same words) or names the same curated place type;
 * - category: the search text is one of the nearest categories a no-match search listed for a part, or
 *   its words are a strict subset of a part's words (a broader category: "latte" for "oat milk latte");
 * - proxy: anything else while some part still has no exact tag (a look-alike);
 * - undefined: the question has no concept part, or every part has its exact tag already (no restriction).
 *
 * The run's memory (nearest categories offered, parts found exactly) is kept per run by its registry, which
 * the opening scan and the ANALYST share; nothing outlives the run.
 */

interface RunMemory {
  /** normaliseConcept of every nearest category a no-match search listed. */
  nearest: Set<string>;
  /** normaliseConcept of the question parts a search found an exact, usable tag for. */
  exact: Set<string>;
}

const MEMORY = new WeakMap<EntityRegistry, RunMemory>();

function memoryOf(registry: EntityRegistry): RunMemory {
  let m = MEMORY.get(registry);
  if (m === undefined) {
    m = { nearest: new Set(), exact: new Set() };
    MEMORY.set(registry, m);
  }
  return m;
}

/** Records the nearest categories a no-match search offered (find_tags' notice and rows). */
export function rememberNearest(registry: EntityRegistry, names: readonly string[]): void {
  const m = memoryOf(registry);
  for (const n of names) {
    const key = normaliseConcept(n);
    if (key !== "") m.nearest.add(key);
  }
}

/** The question part a search text is an exact match for, or null. */
export function exactPart(text: string, parts: readonly string[]): string | null {
  const key = normaliseConcept(text);
  const curated = curatedConcept(text)?.key ?? null;
  for (const p of parts) {
    if (normaliseConcept(p) === key && key !== "") return p;
    if (curated !== null && curatedConcept(p)?.key === curated) return p;
  }
  return null;
}

const strictSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size > 0 && a.size < b.size && [...a].every((w) => b.has(w));

/** Marks a part as found exactly (it had a usable tag), so later searches are no longer judged against it. */
export function rememberExact(registry: EntityRegistry, part: string): void {
  memoryOf(registry).exact.add(normaliseConcept(part));
}

/**
 * The match class of one searched concept against the question's parts (see the module comment). `found`
 * says whether this search kept a usable tag: only then can an exact match close its part.
 */
export function conceptMatchOf(text: string, parts: readonly string[], registry: EntityRegistry): ConceptMatch | undefined {
  if (parts.length === 0) return undefined;
  const m = memoryOf(registry);
  if (exactPart(text, parts) !== null) return "exact";
  const open = parts.filter((p) => !m.exact.has(normaliseConcept(p)));
  const key = normaliseConcept(text);
  const words = conceptWords(text);
  if (m.nearest.has(key)) return "category";
  if (parts.some((p) => strictSubset(words, conceptWords(p)))) return "category";
  return open.length > 0 ? "proxy" : undefined;
}

/** Digest words for a match class (find_tags rows). */
export const MATCH_WORD: Readonly<Record<ConceptMatch, string>> = {
  exact: "exact",
  category: "category level: no winner, keep or veto",
  proxy: "look-alike: not evidence for the concept",
};
