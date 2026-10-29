import { z } from "zod";
import {
  AgeBucket,
  Domain,
  EntityType,
  Job,
  JOB_MNEMONIC,
  JOB_PILLAR,
  MarketId,
  MentionRole,
  MetroId,
  Pillar,
  SafetyCategory,
  SponsorCategory,
} from "./enums";

/**
 * The CLERK's reading of a question (PLAN §4.1 step A), returned as a structured output. The schema
 * stays inside the structured-output subset: strict objects, every field required, absent values as
 * null, no length or count limits, no records. Use `structuredOutputSchema(Intent)` for the format:
 * the SDK's zodOutputFormat turns enums into description text, so job and pillar would not be constrained.
 */

export const Mention = z.strictObject({
  text: z.string().describe("The name exactly as written in the question, e.g. a brand, artist or show."),
  entity_type: EntityType.describe("The Qloo entity type this name most likely refers to for this job."),
  role: MentionRole.describe(
    "primary: the subject of the question; peer: a named competitor or comparison; secondary: any other named entity.",
  ),
  public_figure: z
    .boolean()
    .describe("For entity_type person: true only for a public figure (artist, comedian, athlete). False otherwise."),
});
export type Mention = z.infer<typeof Mention>;

export const IntentGeo = z.strictObject({
  metro: MetroId.nullable().describe("A supported metro named or implied by the question, or null."),
  area: z
    .string()
    .nullable()
    .describe("A neighbourhood or block as written, e.g. 'East Nashville', or null."),
  unsupported_place: z
    .string()
    .nullable()
    .describe(
      "For site_selection, area_profile or tenant_mix: a US city or region that is not a supported metro, as written; null otherwise. Candidate markets for market_selection or sponsorship go in constraints.notes.",
    ),
  /**
   * The market a named venue is searched in when the question puts it in a city that is not a map
   * city (D44): place search needs a centre, and every market has one. A plain string here, since the
   * structured-output subset takes no patterns: code reads it as a market id and ignores an unknown one.
   */
  market: z
    .string()
    .nullable()
    .describe(
      "When a place mention (one venue) is in a US city that is not the metro: that city's market id in snake case, e.g. portland, kansas_city, washington_dc or st_louis; null otherwise.",
    ),
  /** taste_twins: the map city to look for twins in; `metro` and `area` are the source. */
  target_metro: MetroId.nullable().describe(
    "For taste_twins only: the supported metro to find the source area's twins in (metro and area are the source); null otherwise.",
  ),
  /**
   * city_compare: the 2-4 cities to compare as market ids, primary first. A plain string list (the
   * subset takes no patterns or counts): code parses each with MarketId, checks it against
   * config/metros.json, dedupes it and requires 2-4, else asks for the cities instead of guessing.
   */
  cities: z
    .array(z.string())
    .describe(
      "For city_compare only: the two to four US cities to compare as market ids in snake case, primary first, e.g. austin, nashville, denver; empty otherwise.",
    ),
});
export type IntentGeo = z.infer<typeof IntentGeo>;

/**
 * The map city or market a place mention is searched in (D44): a well-formed market id first, since
 * CLERK sets it only for a venue in another city than the metro ("a bar like Portland's ..." in a
 * Nashville question), else the metro, else null. An unknown market id is ignored.
 */
export function placeSearchMarket(geo: IntentGeo): MarketId | null {
  const market = MarketId.safeParse(geo.market);
  return market.success ? market.data : geo.metro;
}

export const IntentConstraints = z.strictObject({
  concepts: z
    .array(z.string())
    .describe("Business concepts to map to taste tags, e.g. 'natural-wine bar' or 'listening room'. Empty if none."),
  sponsor_categories: z.array(SponsorCategory).describe("Sponsor categories the question asks about. Empty if none."),
  domains: z.array(Domain).describe("Cultural domains the question asks about (music = artist). Empty if none."),
  ages: z.array(AgeBucket).describe("Age groups the question focuses on. Empty if none."),
  notes: z
    .array(z.string())
    .describe("Other constraints in a few words each, e.g. 'eight secondary-market dates'. Empty if none."),
  concept_description: z
    .string()
    .nullable()
    .describe(
      "For launch_test only: the product concept in one sentence as the question words it, e.g. 'a small premium hot-sauce brand'; null otherwise.",
    ),
});
export type IntentConstraints = z.infer<typeof IntentConstraints>;

export const IntentSafety = z.strictObject({
  allowed: z
    .boolean()
    .describe("False refuses the run (no Qloo calls). financial_advice questions stay allowed and are reframed."),
  category: SafetyCategory.nullable().describe("The refusal or reframe category, or null when nothing applies."),
  reframe: z
    .string()
    .nullable()
    .describe("A group-level reframe of the question we can answer, e.g. 'Crocs taste-signal health'; or null."),
});
export type IntentSafety = z.infer<typeof IntentSafety>;

/**
 * The nearest-job rule (D41): every business question is read as the nearest of the jobs, and what the
 * data does not cover is said plainly (a READ_AS_NEAREST_JOB limitation and the "Read as" chip).
 */
export const IntentReadAs = z.strictObject({
  nearest: z
    .boolean()
    .describe("True when the question asks for more than the job covers and is read as the nearest job; false when the job fits. Always false for financial_advice: the not-advice reframe already says what is not covered."),
  not_covered: z
    .array(z.string())
    .describe("What the question asks that the data does not cover, a few words each, e.g. 'sales', 'rents', 'foot traffic'. Empty when nearest is false."),
});
export type IntentReadAs = z.infer<typeof IntentReadAs>;

export const Intent = z.strictObject({
  pillar: Pillar.describe("The desk. Must match the job: JOB_PILLAR in code is authoritative."),
  job: Job,
  mentions: z.array(Mention).describe("Every named entity, primary first."),
  geo: IntentGeo,
  constraints: IntentConstraints,
  safety: IntentSafety,
  read_as: IntentReadAs,
  assumptions: z.array(z.string()).describe("Defaults applied, e.g. 'US geography'. Empty if none."),
  mnemonic: z
    .string()
    .describe("The compiled command, e.g. 'LIQUID DEATH <BRAND> HLTH' or 'OLIPOP VS POPPI'."),
});
export type Intent = z.infer<typeof Intent>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An Intent as run events store it. Fields added after a run was recorded read as their empty values,
 * so stored runs and pinned showcases still replay: `geo.market` (D44) as null; and from Part 9
 * `geo.target_metro` as null, `geo.cities` as empty, `constraints.concept_description` as null and
 * `read_as` as not read as a nearest job.
 */
export const StoredIntent = z.preprocess((raw) => {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (isRecord(raw.geo)) out.geo = { market: null, target_metro: null, cities: [], ...raw.geo };
  if (isRecord(raw.constraints)) out.constraints = { concept_description: null, ...raw.constraints };
  if (!("read_as" in raw)) out.read_as = { nearest: false, not_covered: [] };
  return out;
}, Intent);

/**
 * The terminal mnemonic for an intent (§8.2), used for the "Compiled to:" chip. Code recomputes it
 * rather than trusting the model's string.
 */
export function compileMnemonic(intent: Pick<Intent, "job" | "mentions" | "geo" | "constraints">): string {
  const up = (s: string) => s.trim().toUpperCase();
  const primary = intent.mentions.find((m) => m.role === "primary") ?? intent.mentions[0];
  const named = primary ? `${up(primary.text)} <${primary.entity_type.toUpperCase()}>` : "<NAME>";
  const city = intent.geo.metro ? up(intent.geo.metro) : intent.geo.unsupported_place ? up(intent.geo.unsupported_place) : "<CITY>";
  const area = intent.geo.area ? up(intent.geo.area) : "<AREA>";
  const mn = JOB_MNEMONIC[intent.job];
  const concept = intent.constraints.concepts[0];
  switch (intent.job) {
    case "head_to_head": {
      const peer = intent.mentions.find((m) => m !== primary && m.role === "peer");
      return `${primary ? up(primary.text) : "<A>"} VS ${peer ? up(peer.text) : "<B>"}`;
    }
    case "area_profile":
    case "tenant_mix":
      return `${area}, ${city} ${mn}`;
    case "site_selection":
      return `${concept ? up(concept) : "<CONCEPT>"} SITE ${city}`;
    case "taste_twins": {
      const target = intent.geo.target_metro ? up(intent.geo.target_metro) : "<CITY>";
      return `${area}, ${city} ${mn} ${target}`;
    }
    case "city_compare": {
      const cities = intent.geo.cities.map(up).filter((c) => c !== "");
      const list = cities.length >= 2 ? cities.join(" VS ") : "<CITY> VS <CITY>";
      return `${list} ${mn}${concept ? ` ${up(concept)}` : ""}`;
    }
    case "launch_test":
      return `${concept ? up(concept) : "<CONCEPT>"} ${mn}`;
    default:
      return `${named} ${mn}`;
  }
}

/**
 * Code-side normalisation after CLERK: the pillar follows the job and the mnemonic is recompiled. A
 * financial_advice question (buy or sell a stock) is never read as the nearest job (D9 of the Part 9
 * close-out): its fixed not-advice reframe already states what is not covered, so read_as is cleared and
 * no read_as_nearest_job penalty applies.
 */
export function normalizeIntent(intent: Intent): Intent {
  const readAs = intent.safety.category === "financial_advice" ? { nearest: false, not_covered: [] } : intent.read_as;
  return { ...intent, pillar: JOB_PILLAR[intent.job], read_as: readAs, mnemonic: compileMnemonic(intent) };
}
