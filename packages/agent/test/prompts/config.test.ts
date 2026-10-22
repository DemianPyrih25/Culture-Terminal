import { readFileSync } from "node:fs";
import {
  EntityType,
  isTaxonomyTag,
  Job,
  JOB_PILLAR,
  MarketId,
  MentionRole,
  MetroId,
  Pillar,
  QUESTION_MAX_CHARS,
  RESERVED_METRO_IDS,
  SafetyCategory,
  SponsorCategory,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Schema checks for the curated configs (D29: names, query strings and public taxonomy URNs only).
 * The configs are read as text so the raw bytes are checked too, exactly as `pnpm guard` sees them.
 */

const CONFIG_FILES = ["categories.json", "metros.json", "showcases.json", "sponsor_categories.json"] as const;
type ConfigFile = (typeof CONFIG_FILES)[number];

function readConfig(file: ConfigFile): { raw: string; json: unknown } {
  const raw = readFileSync(new URL(`../../../../config/${file}`, import.meta.url), "utf8");
  return { raw, json: JSON.parse(raw) };
}

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The pnpm guard's decimal rule for config/ (D29). */
const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;

const comment = z.string().min(40);
const text = z.string().min(1);
const State = z.string().regex(/^[A-Z]{2}$/);
const Lat = z.number().min(-90).max(90);
const Lon = z.number().min(-180).max(180);

const TagStatus = z.enum(["verified", "research", "unverified"]);
/** What a probe gate exercised the tag as: a gate verifies one use, not every use (PROBE_FINDINGS, Not covered). */
const VerifiedAs = z.enum(["heatmap_signal", "place_filter"]);
const Tag = z
  .strictObject({
    urn: z.string().regex(/^urn:tag:[a-z_]+:[a-z_]+:[a-z0-9_:]+$/),
    status: TagStatus,
    verified_by: z.string().regex(/^G\d{1,2}$/).nullable(),
    verified_as: VerifiedAs.optional(),
  })
  .refine((t) => (t.status === "verified") === (t.verified_by !== null), {
    message: "exactly the verified tags name their probe gate",
  })
  .refine((t) => (t.status === "verified") === (t.verified_as !== undefined), {
    message: "exactly the verified tags say what the gate verified them as",
  });

const Categories = z.strictObject({
  $comment: comment,
  baseline: z.strictObject({
    urn: z.literal("urn:tag:genre:place:restaurant"),
    status: z.literal("verified"),
    verified_by: z.literal("G6"),
    verified_as: z.literal("heatmap_signal"),
    use: text,
  }),
  categories: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_]*$/),
        label: text,
        aliases: z.array(text).min(1),
        semantic_query: text,
        tags: z.array(Tag).min(1),
      }),
    )
    .min(4),
});

const Gazetteer = z.strictObject({
  tier: z.enum(["P0", "P1", "P2"]),
  status: z.enum(["planned", "built", "reserved"]),
  source: z.string().nullable(),
});
/** A name the probe sweep found ambiguous: its locality is chosen by hand, never auto-picked. */
const Pin = z.literal("deliberate").optional();
const MetroEntry = z
  .strictObject({
    id: MarketId,
    label: text,
    state: State,
    state_name: text,
    query: text,
    pin: Pin,
    center: z.strictObject({ lat: Lat, lon: Lon }),
    bbox: z.strictObject({ min_lon: Lon, min_lat: Lat, max_lon: Lon, max_lat: Lat }),
    gazetteer: Gazetteer,
  })
  .refine((m) => m.bbox.min_lon < m.center.lon && m.center.lon < m.bbox.max_lon, { message: "centre outside bbox (lon)" })
  .refine((m) => m.bbox.min_lat < m.center.lat && m.center.lat < m.bbox.max_lat, { message: "centre outside bbox (lat)" });
const Metros = z.strictObject({
  $comment: comment,
  gazetteer: z.array(MetroEntry),
  reserved: z.array(MetroEntry),
  markets: z
    .array(
      z.strictObject({
        id: MarketId,
        label: text,
        state: State,
        state_name: text,
        query: text,
        pin: Pin,
        tier: z.enum(["major", "secondary"]),
      }),
    )
    .min(16),
});

const SponsorCategories = z.strictObject({
  $comment: comment,
  categories: z.record(
    SponsorCategory,
    z.strictObject({
      label: text,
      semantic_query: text,
      probe: z.literal("G14").nullable(),
      aliases: z.array(text).min(1),
      tags: z.array(Tag),
      tag_status: TagStatus,
      note: text.optional(),
    }),
  ),
});

const ExpectedGeo = z.strictObject({ metro: MetroId.nullable(), area: text.nullable() });
const Showcase = z.strictObject({
  code: z.string().regex(/^S[1-7]$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  desk: Pillar,
  judge: text,
  question: text.max(QUESTION_MAX_CHARS),
  expected: z.strictObject({
    job: Job,
    mentions: z.array(
      z.strictObject({ text, entity_type: EntityType, role: MentionRole, public_figure: z.boolean() }),
    ),
    geo: ExpectedGeo,
    concepts: z.array(text),
    safety: z.strictObject({ allowed: z.literal(true), category: z.null() }),
  }),
  extra_pins: z.array(z.strictObject({ text, entity_type: EntityType })),
  why: text,
});
const Showcases = z.strictObject({
  $comment: comment,
  showcases: z.array(Showcase).length(7),
  chain: z.strictObject({
    slug: text,
    title: text,
    desk: z.literal("all"),
    judge: text,
    steps: z
      .array(
        z.strictObject({
          step: z.int().positive(),
          from: z.string().regex(/^S[1-7]$/).nullable(),
          question: text.max(QUESTION_MAX_CHARS),
          expected: z.strictObject({ job: Job, geo: ExpectedGeo }),
          why: text,
        }),
      )
      .min(2),
  }),
  trust: z.strictObject({
    slug: text,
    desk: z.null(),
    judge: text,
    question: text.max(QUESTION_MAX_CHARS),
    // Safety only: CLERK still picks a job for a refused question, but which one is not the showcase.
    expected: z.strictObject({
      safety: z.strictObject({ allowed: z.literal(false), category: SafetyCategory }),
    }),
    why: text,
  }),
});

describe("config/*.json", () => {
  it.each(CONFIG_FILES)("%s holds no UUID-shaped strings and no long decimals (D29)", (file) => {
    const { raw } = readConfig(file);
    expect(raw).not.toMatch(UUID_SHAPE);
    expect(raw).not.toMatch(LONG_DECIMAL);
  });
});

describe("config/categories.json", () => {
  const categories = Categories.parse(readConfig("categories.json").json);

  it("maps concepts to taxonomy tags only, with the probe-verified ones marked", () => {
    const tags = categories.categories.flatMap((c) => c.tags);
    for (const t of tags) expect(isTaxonomyTag(t.urn), t.urn).toBe(true);
    const verified = tags.filter((t) => t.status === "verified").map((t) => `${t.urn} ${t.verified_by} ${t.verified_as}`);
    expect(verified.sort()).toEqual([
      "urn:tag:category:place:cafe G10 place_filter",
      "urn:tag:genre:place:restaurant G6 heatmap_signal",
    ]);
    expect(isTaxonomyTag(categories.baseline.urn)).toBe(true);
  });

  it("has unique keys and unambiguous aliases", () => {
    const keys = categories.categories.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const aliases = categories.categories.flatMap((c) => c.aliases.map((a) => a.toLowerCase()));
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe("config/metros.json", () => {
  const metros = Metros.parse(readConfig("metros.json").json);

  it("lists exactly the contracts gazetteer metros, plus the reserved ones", () => {
    expect(metros.gazetteer.map((m) => m.id).sort()).toEqual([...MetroId.options].sort());
    expect(metros.reserved.map((m) => m.id)).toEqual([...RESERVED_METRO_IDS]);
    for (const m of metros.reserved) expect(m.gazetteer.status).toBe("reserved");
  });

  it("makes every gazetteer and reserved metro a market, with unique ids and matching names", () => {
    const ids = metros.markets.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metro of [...metros.gazetteer, ...metros.reserved]) {
      const market = metros.markets.find((m) => m.id === metro.id);
      expect(market, metro.id).toBeDefined();
      expect(market).toMatchObject({ label: metro.label, state: metro.state, query: metro.query });
      expect(market?.pin, metro.id).toBe(metro.pin);
    }
  });

  it("pins the Austin locality deliberately, since the probe sweep found its name ambiguous", () => {
    const austin = [...metros.gazetteer, ...metros.markets].filter((m) => m.id === "austin");
    expect(austin.map((m) => m.pin)).toEqual(["deliberate", "deliberate"]);
  });

  it("offers at least eight secondary markets for secondary-market questions", () => {
    expect(metros.markets.filter((m) => m.tier === "secondary").length).toBeGreaterThanOrEqual(8);
  });
});

describe("config/sponsor_categories.json", () => {
  const sponsors = SponsorCategories.parse(readConfig("sponsor_categories.json").json);

  it("covers the ten contracts sponsor categories with a semantic query each", () => {
    expect(Object.keys(sponsors.categories).sort()).toEqual([...SponsorCategory.options].sort());
  });

  it("claims no verified tag the probe did not verify", () => {
    for (const [key, c] of Object.entries(sponsors.categories)) {
      expect(c.tags.every((t) => t.status !== "verified"), key).toBe(true);
      if (c.tags.length === 0) expect(c.tag_status, key).toBe("unverified");
    }
  });
});

describe("config/showcases.json", () => {
  const showcases = Showcases.parse(readConfig("showcases.json").json);

  it("holds S1 to S7 in order with unique slugs, each on its job's desk", () => {
    expect(showcases.showcases.map((s) => s.code)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
    const slugs = [...showcases.showcases.map((s) => s.slug), showcases.chain.slug, showcases.trust.slug];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of showcases.showcases) expect(s.desk, s.code).toBe(JOB_PILLAR[s.expected.job]);
  });

  it("covers every desk", () => {
    expect(new Set(showcases.showcases.map((s) => s.desk))).toEqual(new Set(Pillar.options));
  });

  it("puts the primary mention first and marks public figures only on persons", () => {
    for (const s of showcases.showcases) {
      const [first] = s.expected.mentions;
      if (first) expect(first.role, s.code).toBe("primary");
      for (const m of s.expected.mentions) {
        if (m.public_figure) expect(m.entity_type, s.code).toBe("person");
      }
    }
  });

  it("starts the chain from its showcase question and refuses the trust example", () => {
    const [first] = showcases.chain.steps;
    const source = showcases.showcases.find((s) => s.code === first?.from);
    expect(first?.question).toBe(source?.question);
    expect(showcases.chain.steps.map((s) => s.step)).toEqual(showcases.chain.steps.map((_, i) => i + 1));
    expect(showcases.trust.expected.safety.allowed).toBe(false);
  });
});
