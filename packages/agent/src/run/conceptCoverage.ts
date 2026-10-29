import { isId, type DigestRow, type Finding, type Intent, type SkillId, type ToolInput } from "@ct/contracts";
import { NEAREST_SEPARATOR } from "@ct/quant";
import type { ConceptSubstitute } from "../report/concept";

/**
 * D2 of the Part 9 close-out: whether part of the question's concept was never tested, the
 * concept_partly_tagged confidence rule (−30, counted once, so alone it caps a note at MED). It fires
 * when either holds:
 * - a find_tags search came back EMPTY_RESULT and no later find_tags call citing that finding found a
 *   tag that another call then used;
 * - a concept part of the question has no tag that another call used: its search found none, failed,
 *   or never ran (find_tags reads at most four concepts), or its tags were found and never used.
 * The part rule applies only to a run that tested concepts by tag at all (a find_tags call ran), so a
 * job that reads no concept tags is not marked down for the words CLERK noted. A part whose rows did
 * not reach the digest (cut for size) is not judged: there is no evidence either way.
 */

export interface ConceptCall {
  tool: SkillId;
  input: unknown;
  findingIds: readonly string[];
  /** The digest rows the call returned; null or absent when it failed or was refused. */
  rows?: readonly DigestRow[] | null;
}

/** How find_tags rows and question concepts are compared: case, spacing and a cut ellipsis do not count. */
function conceptKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/…$/, "").trim().slice(0, 59);
}

/** Every string anywhere in a tool input: the tag refs it sends, among other values. */
function stringsIn(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

const conceptsOf = (call: ConceptCall): string[] =>
  ((call.input as Partial<ToolInput<"find_tags">> | null)?.concepts ?? []).map((c) => c.text);

const triggerOf = (call: ConceptCall): string | null =>
  (call.input as { trigger_finding_id?: string | null } | null)?.trigger_finding_id ?? null;

/** The tag refs of a find_tags call's rows for one concept (or for every concept with `key` null). */
function tagsFor(call: ConceptCall, key: string | null): string[] {
  return (call.rows ?? []).flatMap((row) => {
    const concept = row.values.concept;
    if (key !== null && (typeof concept !== "string" || conceptKey(concept) !== key)) return [];
    return row.ref !== null && isId("T", row.ref) ? [row.ref] : [];
  });
}

/** The question's concept parts: CLERK's concepts, else its concept description (as launch_test's scan searches it). */
export function questionConcepts(intent: Pick<Intent, "constraints">): string[] {
  const described = intent.constraints.concept_description?.trim() ?? "";
  return intent.constraints.concepts.length > 0 ? [...intent.constraints.concepts] : described === "" ? [] : [described];
}

export function conceptPartlyTagged(args: {
  /** The question's concept parts (intent constraints.concepts, else its concept description). */
  concepts: readonly string[];
  /** Every skill call of the run, scan and ANALYST, in the order they were made. */
  calls: readonly ConceptCall[];
  findings: readonly Pick<Finding, "id" | "kind">[];
}): boolean {
  const searches = args.calls.filter((c) => c.tool === "find_tags");
  if (searches.length === 0) return false;
  const used = new Set<string>();
  for (const c of args.calls) if (c.tool !== "find_tags") stringsIn(c.input, used);
  const anyUsed = (refs: readonly string[]) => refs.some((r) => used.has(r));
  const empties = new Set<string>(args.findings.filter((f) => f.kind === "EMPTY_RESULT").map((f) => f.id));
  /** A retry that cites one of this search's EMPTY_RESULT findings and found a tag another call used. */
  const retried = (search: ConceptCall) =>
    searches.some((r) => {
      const trigger = triggerOf(r);
      return trigger !== null && search.findingIds.includes(trigger) && empties.has(trigger) && anyUsed(tagsFor(r, null));
    });

  // An empty tag search that nothing made good.
  if (searches.some((s) => s.findingIds.some((id) => empties.has(id)) && !retried(s))) return true;

  // A concept part with no tag any call used.
  const parts = [...new Set(args.concepts.map(conceptKey).filter((k) => k !== ""))];
  return parts.some((part) => {
    const searched = searches.filter((s) => conceptsOf(s).some((text) => conceptKey(text) === part));
    if (searched.length === 0) return true;
    let judged = false;
    for (const s of searched) {
      if (s.rows === null || s.rows === undefined) {
        judged = true;
        continue;
      }
      const rows = s.rows.filter((row) => typeof row.values.concept === "string" && conceptKey(row.values.concept) === part);
      if (rows.length === 0) continue;
      judged = true;
      if (anyUsed(tagsFor(s, part)) || retried(s)) return false;
    }
    return judged;
  });
}

/** A find_tags row that names a usable tag: a T# ref whose use is not label_only. */
const usableRow = (row: DigestRow): boolean => row.ref !== null && isId("T", row.ref) && row.values.use !== "label_only";

const rowsOfConcept = (call: ConceptCall, key: string): DigestRow[] =>
  (call.rows ?? []).filter((row) => typeof row.values.concept === "string" && conceptKey(row.values.concept) === key);

/** The nearest category names a no-match row lists (find_tags' `nearest`), as concept keys. */
function nearestOf(rows: readonly DigestRow[]): string[] {
  return rows.flatMap((row) =>
    typeof row.values.nearest === "string" ? row.values.nearest.split(NEAREST_SEPARATOR).map(conceptKey).filter((k) => k !== "") : [],
  );
}

/**
 * The question's concept parts that are not in the data, with the categories tested in their place
 * (the owner's o03 decision). A part is not in the data when a tag search for it answered and kept no
 * usable tag (its rows say match none, or name only label tags) and no search found one. Its category
 * searches are the later find_tags calls that searched one of the nearest categories its rows list
 * (the opening scan's category retry, or the ANALYST searching a listed name), or that cite the empty
 * search's finding as their trigger; their usable tags that another call used are the categories it was
 * tested on, by name. A part none of them tested has no categories: it was not tested at all. A failed
 * or cut-off search says nothing about the data and is left to conceptPartlyTagged.
 */
export function conceptSubstitutes(args: {
  concepts: readonly string[];
  calls: readonly ConceptCall[];
}): ConceptSubstitute[] {
  const used = new Set<string>();
  for (const c of args.calls) if (c.tool !== "find_tags") stringsIn(c.input, used);
  const searches = args.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.tool === "find_tags");
  const out: ConceptSubstitute[] = [];
  const parts = new Map<string, string>();
  for (const text of args.concepts) {
    const key = conceptKey(text);
    if (key !== "" && !parts.has(key)) parts.set(key, text.replace(/\s+/g, " ").trim());
  }
  for (const [key, text] of parts) {
    const own = searches.map((s) => ({ ...s, rows: rowsOfConcept(s.call, key) })).filter((s) => s.rows.length > 0);
    if (own.length === 0 || own.some((s) => s.rows.some(usableRow))) continue;
    const empty = own.filter((s) => s.rows.some((row) => row.values.match === "none" || row.values.use === "label_only"));
    if (empty.length === 0) continue;
    const first = Math.min(...empty.map((s) => s.index));
    const nearest = new Set(empty.flatMap((s) => nearestOf(s.rows)));
    const findingIds = new Set(empty.flatMap((s) => s.call.findingIds));
    const scope = String(empty[0]!.rows[0]!.values.scope ?? "");
    const categories: string[] = [];
    for (const { call, index } of searches) {
      if (index <= first) continue;
      const trigger = triggerOf(call);
      const cited = trigger !== null && findingIds.has(trigger);
      const rows = (call.rows ?? []).filter(
        (row) => usableRow(row) && (cited || (typeof row.values.concept === "string" && nearest.has(conceptKey(row.values.concept)))),
      );
      for (const row of rows) if (row.ref !== null && used.has(row.ref) && !categories.includes(row.name)) categories.push(row.name);
    }
    out.push({ concept: text, scope, categories, whole: parts.size === 1 });
  }
  return out;
}

/** Tools that only look refs up for another call to use (the loop's LOOKUP_TOOLS). */
const LOOKUPS: ReadonlySet<SkillId> = new Set<SkillId>(["find_tags", "resolve_entities"]);

/** The refs among `refs` that no call other than a lookup names in its input, in order, once each. */
export function unusedRefs(refs: readonly string[], calls: readonly Pick<ConceptCall, "tool" | "input">[]): string[] {
  const used = new Set<string>();
  for (const c of calls) if (!LOOKUPS.has(c.tool)) stringsIn(c.input, used);
  return [...new Set(refs)].filter((r) => (isId("T", r) || isId("R", r)) && !used.has(r));
}
