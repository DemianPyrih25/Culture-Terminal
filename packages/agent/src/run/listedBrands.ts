import { z } from "zod";
import raw from "../../../../config/listed_companies.json";

/**
 * How a resolved brand relates to the US-listed company config/listed_companies.json maps it to (Part 9
 * open issue 6). `self`: the company reports the brand as itself (Nike, Starbucks), so its SEC figures are
 * shown with the company-wide note. `parent`: the brand is one of several inside a larger company (Sprite in
 * The Coca-Cola Company), whose filings never break it out: no figures are shown for it, and the note says
 * so plainly (NOT_SEPARATELY_REPORTED) instead of skipping it. A brand with no entry at all is no mapped
 * listed company (NOT_A_LISTED_COMPANY). The company_financials skill reads the same file for its tickers;
 * this module reads only the relation, by the same exact name key.
 */

const Entry = z.object({
  company: z.string().min(1),
  relation: z.enum(["self", "parent"]),
  parent_name: z.string().min(1).optional(),
});
const Config = z.object({ brands: z.record(z.string(), Entry) });

export type ListedRelation =
  | { kind: "self"; company: string }
  | { kind: "parent"; parent: string }
  | { kind: "unlisted" };

/** The key listedCompanyOf matches by: trimmed, spaces collapsed, lower case. */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

export function listedRelationsFrom(config: unknown): ReadonlyMap<string, Exclude<ListedRelation, { kind: "unlisted" }>> {
  const parsed = Config.parse(config);
  return new Map(
    Object.entries(parsed.brands).map(([brand, e]) => [
      nameKey(brand),
      e.relation === "parent" ? { kind: "parent", parent: e.parent_name ?? e.company } : { kind: "self", company: e.company },
    ]),
  );
}

/** config/listed_companies.json is ours: every entry must state its relation, or start-up fails. */
const RELATIONS = listedRelationsFrom(raw);

/** How the brand of this exact resolved name relates to a listed company. */
export function listedRelationOf(
  name: string,
  relations: ReadonlyMap<string, Exclude<ListedRelation, { kind: "unlisted" }>> = RELATIONS,
): ListedRelation {
  return relations.get(nameKey(name)) ?? { kind: "unlisted" };
}

/** Plain-text name for a limitation: no control characters or runs of spaces, at most 60 characters. */
const plain = (s: string): string =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();

/** The NOT_SEPARATELY_REPORTED limitation text for a brand inside a larger listed company. */
export function notSeparatelyReported(brand: string, parent: string): string {
  const b = plain(brand);
  const p = plain(parent);
  // "PepsiCo, Inc." ends its own sentence: no second full stop.
  return `${b} is part of ${p}${p.endsWith(".") ? "" : "."} SEC filings report ${p} as a whole, so no ${b} figures are shown.`;
}
