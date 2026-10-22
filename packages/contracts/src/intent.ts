import { z } from "zod";
import {
  AgeBucket,
  Domain,
  EntityType,
  Job,
  JOB_MNEMONIC,
  JOB_PILLAR,
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
    .describe("A US city or region in the question that is not a supported metro, as written; null otherwise."),
});
export type IntentGeo = z.infer<typeof IntentGeo>;

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

export const Intent = z.strictObject({
  pillar: Pillar.describe("The desk. Must match the job: JOB_PILLAR in code is authoritative."),
  job: Job,
  mentions: z.array(Mention).describe("Every named entity, primary first."),
  geo: IntentGeo,
  constraints: IntentConstraints,
  safety: IntentSafety,
  assumptions: z.array(z.string()).describe("Defaults applied, e.g. 'US geography'. Empty if none."),
  mnemonic: z
    .string()
    .describe("The compiled command, e.g. 'LIQUID DEATH <BRAND> HLTH' or 'OLIPOP VS POPPI'."),
});
export type Intent = z.infer<typeof Intent>;

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
  switch (intent.job) {
    case "head_to_head": {
      const peer = intent.mentions.find((m) => m !== primary && m.role === "peer");
      return `${primary ? up(primary.text) : "<A>"} VS ${peer ? up(peer.text) : "<B>"}`;
    }
    case "area_profile":
    case "tenant_mix":
      return `${area}, ${city} ${mn}`;
    case "site_selection": {
      const concept = intent.constraints.concepts[0];
      return `${concept ? up(concept) : "<CONCEPT>"} SITE ${city}`;
    }
    default:
      return `${named} ${mn}`;
  }
}

/** Code-side normalisation after CLERK: the pillar follows the job and the mnemonic is recompiled. */
export function normalizeIntent(intent: Intent): Intent {
  return { ...intent, pillar: JOB_PILLAR[intent.job], mnemonic: compileMnemonic(intent) };
}
