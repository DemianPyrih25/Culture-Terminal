// The synthetic ANALYST scenario: an invented brand question, an invented registry, and scripted
// tool results built from the real contracts. Every entity, tag and number is invented and
// deterministic (D29), so two runs of one config send byte-identical prefixes and cache.
import type { Anthropic } from "./deps";
import {
  AGE_BUCKET_LABEL,
  compileMnemonic,
  dataNoticeFor,
  DEFAULT_RUN_LIMITS,
  isId,
  isToolName,
  makeId,
  MetroId,
  parseToolInput,
  SkillId,
  wrapQlooData,
  wrapToolData,
  type AgeBucket,
  type Badge,
  type DatasetId,
  type DigestRow,
  type EntityRef,
  type EntityType,
  type EvidenceId,
  type FindingId,
  type FindingKind,
  type Flag,
  type Intent,
  type MetricId,
  type ModelDigest,
  type SponsorCategory,
  type StepId,
  type SubmitPlanInputShape,
  type TagRef,
  type ToolInput,
  type ToolName,
} from "./deps";

// Deterministic numbers ------------------------------------------------------------------------------

/** FNV-1a: a stable hash so every scripted value depends only on its key. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable value in [0, 1) for a key. */
export function unit(key: string): number {
  return fnv1a(key) / 0x100000000;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
/** An integer percentile between 5 and 97. */
const pct = (key: string): number => 5 + Math.floor(unit(key) * 93);
const signed = (x: number): string => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));
const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

// Invented entities ------------------------------------------------------------------------------------

export const PRIMARY_BRAND = "Juniper Cola";
export const NAMED_PEER = "Marlowe Ridge Sparkling";
const CATEGORY_PEERS = [
  "Fennwick Soda Works",
  "Halcyon Tonic Co.",
  "Bright Basin Kombucha",
  "Northpine Seltzer",
  "Velvet Orchard Cider",
  "Kestrel Energy",
];
const CROSS_CATEGORY_NEIGHBOUR = "Aurora Footwear";
const CROSS_CATEGORY_POOL = [
  CROSS_CATEGORY_NEIGHBOUR,
  "Saltgrass Supply",
  "Lumen Trail Outfitters",
  "Copper Lantern Coffee",
  "Brindle & Oak Market",
  "Tidewater Lager",
];

/** Facet tags in the shape audience digests use: namespace plus a short label. */
const FACET_TAGS = [
  "lifestyle: trail running",
  "food: cold brew",
  "music: indie folk",
  "leisure: zine fairs",
  "food: natural wine",
  "lifestyle: thrift shopping",
  "media: true-crime podcasts",
  "leisure: board-game cafes",
  "music: synth pop",
  "lifestyle: home fermentation",
  "leisure: climbing gyms",
  "media: cooking competitions",
];

const DOMAIN_POOL: Readonly<Record<"artist" | "podcast" | "tv_show" | "brand" | "movie", readonly string[]>> = {
  artist: ["Pelican Static", "The Lowland Hours", "Mira Calloway", "Glass Harbor", "Dune Choir", "Velma Sato"],
  podcast: ["Small Batch Hour", "The Long Commute", "Field Notes Weekly", "Second Pour"],
  tv_show: ["Harbor Lights", "Ninth Street Kitchen", "The Quiet Season", "Gravel Roads"],
  brand: ["Copper Lantern Coffee", "Saltgrass Supply", "Lumen Trail Outfitters", "Brindle & Oak Market", "Tidewater Lager"],
  movie: ["Paper Kites", "Low Tide", "Northern Static", "The Orchard Year"],
};

const DESTINATIONS = [
  "Ashby Falls",
  "Port Lindell",
  "Greywater Springs",
  "Halden Mesa",
  "Corwin Key",
  "Sable Point",
  "Mossbank",
  "Tern Island",
  "Larkspur Pass",
  "Oriel Bay",
  "Whitfield Hollow",
  "Cask Harbor",
];
const BELTS = ["Mountain West", "Gulf Coast", "Great Lakes", "Pacific Northwest", "Southeast"];
const SEASONS = ["spring", "summer", "autumn", "winter"];

const NEIGHBOURHOODS = [
  "Riverside Flats",
  "Old Mill",
  "Foundry Square",
  "Elm Terrace",
  "Kiln District",
  "Mercer Heights",
  "Lantern Yard",
  "Slate Hill",
  "Cobbler's Bend",
  "Willow Commons",
  "Tanner Row",
  "Quarry Park",
];

const BLOCK_TAGS: ReadonlyArray<readonly [string, "WHO" | "VIBE" | "WHAT" | "SOUND"]> = [
  ["natural wine", "WHAT"],
  ["listening bar", "VIBE"],
  ["vintage clothing", "WHAT"],
  ["taqueria", "WHAT"],
  ["climbing gym", "WHO"],
  ["indie bookstore", "VIBE"],
  ["record store", "SOUND"],
  ["craft brewery", "WHAT"],
  ["plant shop", "WHO"],
  ["late-night diner", "VIBE"],
  ["jazz club", "SOUND"],
  ["bike shop", "WHO"],
];
const LOCAL_BRANDS = ["Kiln & Crumb Bakery", "Slate Hill Supply", "Lantern Yard Roasters"];

const SPONSOR_BRANDS: Readonly<Record<SponsorCategory, readonly [string, string]>> = {
  beer: ["Tidewater Lager", "Bramblecrest Ale"],
  spirits: ["Ember Lane Spirits", "Ninefold Gin"],
  rtd_seltzer: ["Northpine Seltzer", "Clearwake Hard Seltzer"],
  outdoor_sporting_retail: ["Lumen Trail Outfitters", "Ridgeback Gear"],
  apparel_footwear: ["Aurora Footwear", "Saltgrass Supply"],
  qsr: ["Quillmore Kitchen", "Bun & Basil"],
  energy_drinks: ["Kestrel Energy", "Voltwing"],
  auto: ["Calder Motors", "Ferrow Auto"],
  telecom: ["Cobalt Mile Telecom", "Relay Mobile"],
  fintech: ["Tallyleaf", "Harborline Pay"],
  beauty: ["Petalforge Skin", "Lumiere Lane Beauty"],
  gaming: ["Stormkettle Games", "Pixelbarrow Studios"],
  travel: ["Wayfern Air", "Driftmoor Hotels"],
  food_delivery: ["Platehop", "Courierleaf Eats"],
  consumer_tech: ["Quillwave Devices", "Brightknot Audio"],
};

/** Market ids the tools may use (MarketId); all but portland are also gazetteer metros (map cities). */
export const MARKETS = ["nashville", "austin", "denver", "portland", "chicago", "atlanta"] as const;
/** City and state per market, as config/metros.json labels them and the agent's run context lists them. */
const MARKET_LABEL: Readonly<Record<(typeof MARKETS)[number], string>> = {
  nashville: "Nashville, TN",
  austin: "Austin, TX",
  denver: "Denver, CO",
  portland: "Portland, OR",
  chicago: "Chicago, IL",
  atlanta: "Atlanta, GA",
};
const GAZETTEER_METROS: readonly string[] = MARKETS.filter((m) => MetroId.safeParse(m).success);
/** Invented audience leaves in the allowlisted URN shape. */
export const AUDIENCES = [
  "urn:audience:leisure:fixture_trail_runners",
  "urn:audience:leisure:fixture_home_baristas",
  "urn:audience:lifestyle:fixture_vinyl_collectors",
  "urn:audience:lifestyle:fixture_weekend_bakers",
] as const;
const audienceLabel = (key: string): string => key.split(":").pop()?.replace(/^fixture_/, "") ?? key;

// Registry and ledger ------------------------------------------------------------------------------------

export interface RegistryEntity {
  ref: EntityRef;
  name: string;
  type: EntityType;
}

export interface RegistryTag {
  ref: TagRef;
  name: string;
}

/** Refs the model may use. Skills add what they discover, as the real registry does. */
export class Registry {
  readonly #entities = new Map<EntityRef, RegistryEntity>();
  readonly #byName = new Map<string, RegistryEntity>();
  readonly #tags = new Map<TagRef, RegistryTag>();
  readonly #tagsByName = new Map<string, RegistryTag>();

  entity(ref: EntityRef): RegistryEntity | undefined {
    return this.#entities.get(ref);
  }

  has(ref: string): boolean {
    return isId("R", ref) ? this.#entities.has(ref) : isId("T", ref) ? this.#tags.has(ref) : false;
  }

  entities(): RegistryEntity[] {
    return [...this.#entities.values()];
  }

  findByName(name: string): RegistryEntity | undefined {
    return this.#byName.get(name.trim().toLowerCase());
  }

  add(name: string, type: EntityType): { entity: RegistryEntity; isNew: boolean } {
    const known = this.findByName(name);
    if (known) return { entity: known, isNew: false };
    const entity: RegistryEntity = { ref: makeId("R", this.#entities.size + 1), name, type };
    this.#entities.set(entity.ref, entity);
    this.#byName.set(name.toLowerCase(), entity);
    return { entity, isNew: true };
  }

  addTag(name: string): { tag: RegistryTag; isNew: boolean } {
    const known = this.#tagsByName.get(name.toLowerCase());
    if (known) return { tag: known, isNew: false };
    const tag: RegistryTag = { ref: makeId("T", this.#tags.size + 1), name };
    this.#tags.set(tag.ref, tag);
    this.#tagsByName.set(name.toLowerCase(), tag);
    return { tag, isNew: true };
  }
}

/** Run-scoped id allocation (E#, M#, D#, F#) and the set of ids a report may cite. */
export class Ledger {
  readonly evidence: EvidenceId[] = [];
  readonly metrics: MetricId[] = [];
  readonly datasets: DatasetId[] = [];
  readonly findings = new Map<FindingId, FindingKind>();

  evidenceId(): EvidenceId {
    const id = makeId("E", this.evidence.length + 1);
    this.evidence.push(id);
    return id;
  }

  metricId(): MetricId {
    const id = makeId("M", this.metrics.length + 1);
    this.metrics.push(id);
    return id;
  }

  datasetId(): DatasetId {
    const id = makeId("D", this.datasets.length + 1);
    this.datasets.push(id);
    return id;
  }

  findingId(kind: FindingKind): FindingId {
    const id = makeId("F", this.findings.size + 1);
    this.findings.set(id, kind);
    return id;
  }
}

export interface DigestContext {
  ledger: Ledger;
  registry: Registry;
}

/**
 * The accepted plan's steps and the step ids already carried out. In turn 2 a call without a trigger
 * is a planned step only if its step_id names a step that has not run and it calls that step's tool.
 */
export interface PlanSteps {
  steps: readonly { id: string; tool: string }[];
  run: Set<string>;
}

// Digest builder ---------------------------------------------------------------------------------------

class DigestBuilder {
  readonly #ctx: DigestContext;
  readonly #evidence: EvidenceId;
  readonly #dataset: DatasetId;
  readonly metrics: ModelDigest["metrics"] = [];
  readonly rows: DigestRow[] = [];
  readonly findings: ModelDigest["findings"] = [];
  readonly flags: Flag[] = [];
  readonly registered: ModelDigest["registered"] = [];
  readonly notices: string[] = [];

  constructor(ctx: DigestContext) {
    this.#ctx = ctx;
    this.#evidence = ctx.ledger.evidenceId();
    this.#dataset = ctx.ledger.datasetId();
  }

  metric(label: string, display: string, badge: Badge = "MEASURED"): MetricId {
    const id = this.#ctx.ledger.metricId();
    this.metrics.push({ id, label, display, badge });
    return id;
  }

  finding(kind: FindingKind, text: string, suggestion: { tool: SkillId; reason: string } | null): FindingId {
    const id = this.#ctx.ledger.findingId(kind);
    this.findings.push({ id, kind, text, suggestion });
    return id;
  }

  flag(flag: Flag): void {
    if (!this.flags.includes(flag)) this.flags.push(flag);
  }

  entity(name: string, type: EntityType): RegistryEntity {
    const { entity, isNew } = this.#ctx.registry.add(name, type);
    if (isNew) this.registered.push({ ref: entity.ref, name, type });
    return entity;
  }

  tag(name: string): RegistryTag {
    const { tag, isNew } = this.#ctx.registry.addTag(name);
    if (isNew) this.registered.push({ ref: tag.ref, name, type: "tag" });
    return tag;
  }

  row(ref: DigestRow["ref"], name: string, values: DigestRow["values"]): void {
    this.rows.push({ ref, name, values });
  }

  build(status: ModelDigest["status"] = "ok", tool: SkillId | null = null): ModelDigest {
    return {
      _data_notice: dataNoticeFor(tool ?? "block_dna"),
      status,
      evidence_ids: [this.#evidence],
      dataset_ids: [this.#dataset],
      metrics: this.metrics,
      top_rows: this.rows.slice(0, 12),
      findings: this.findings,
      flags: this.flags,
      registered: this.registered,
      notices: this.notices,
    };
  }
}

function named(ctx: DigestContext, refs: readonly EntityRef[]): RegistryEntity[] {
  return refs.flatMap((ref) => {
    const e = ctx.registry.entity(ref);
    return e ? [e] : [];
  });
}

const similarity = (a: string, b: string): number => round2(0.25 + 0.65 * unit(`sim:${[a, b].sort().join("|")}`));
const popularity = (name: string): number => pct(`pop:${name}`);
/** The fit-against-popularity quadrant the Quadrant exhibits use. */
const quadrant = (fit: number, pop: number): string => (fit >= 50 ? (pop >= 50 ? "HEARTLAND" : "HIDDEN_POCKET") : pop >= 50 ? "MASS" : "COLD");
/** Two facet labels a pair shares, as explainability edges show them. */
function sharedTags(a: string, b: string): string {
  const key = [a, b].sort().join("|");
  const ranked = [...FACET_TAGS].sort((x, y) => unit(`shared:${key}:${y}`) - unit(`shared:${key}:${x}`));
  return ranked
    .slice(0, 2)
    .map((t) => t.split(": ")[1] ?? t)
    .join("; ");
}
const medianOf = (values: readonly number[]): number => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;

// Scripted skills ----------------------------------------------------------------------------------------

/** A short column label for a matrix row: the first word of the name. */
const short = (name: string): string => name.split(/\s+/)[0]?.toLowerCase() ?? name;

const facetIndex = (subject: string, tag: string): number => round2(1 + 1.4 * unit(`facet-ix:${subject}:${tag}`));

/** Over-indexed facet tags for an entity, as the audience digests show them, with the category baseline beside each. */
function facetRows(b: DigestBuilder, subject: string, slots: number): void {
  const ranked = [...FACET_TAGS].sort((x, y) => unit(`facet:${subject}:${y}`) - unit(`facet:${subject}:${x}`));
  for (const tag of ranked.slice(0, Math.max(0, slots))) {
    const [namespace, label] = tag.split(": ") as [string, string];
    const index = facetIndex(subject, tag);
    const categoryIndex = round2(0.8 + 0.6 * unit(`facet-cat:${tag}`));
    const example = (pool: readonly string[]): string => pool[fnv1a(`ex:${tag}`) % pool.length] ?? "";
    b.row(null, label, {
      namespace,
      index,
      category_index: categoryIndex,
      lift_vs_category: signed(round2(index - categoryIndex)),
      affinity_pct_in_call: pct(`facet-pct:${subject}:${tag}`),
      subject,
      rank_in_facet: 1 + (fnv1a(tag) % 9),
      examples: `${example(DOMAIN_POOL.brand)}; ${example(DOMAIN_POOL.artist)}`,
    });
  }
}

type Scripts = { [K in SkillId]: (input: ToolInput<K>, ctx: DigestContext) => ModelDigest };

const SCRIPTS: Scripts = {
  resolve_entities(input, ctx) {
    const b = new DigestBuilder(ctx);
    let exactCount = 0;
    for (const m of input.mentions) {
      const pool = m.type in DOMAIN_POOL ? DOMAIN_POOL[m.type as keyof typeof DOMAIN_POOL] : DOMAIN_POOL.brand;
      const wanted = m.text.trim().toLowerCase();
      const known = ctx.registry.findByName(m.text);
      const exact = known ?? (pool.some((n) => n.toLowerCase() === wanted) ? b.entity(m.text.trim(), m.type) : undefined);
      const alternatives = pool
        .filter((n) => n.toLowerCase() !== wanted)
        .slice(0, 3)
        .map((n) => `${n} (pop ${popularity(n)})`)
        .join("; ");
      if (exact) {
        exactCount++;
        b.row(exact.ref, m.text, { match: "exact", type: exact.type, popularity_pct: popularity(exact.name), alternatives });
      } else {
        b.row(null, m.text, { match: "not_found", type: m.type, popularity_pct: null, alternatives });
      }
    }
    b.metric("Mentions resolved exactly", `${exactCount} of ${input.mentions.length}`, "DERIVED");
    return b.build(exactCount === input.mentions.length ? "ok" : "partial");
  },

  find_tags(input, ctx) {
    const b = new DigestBuilder(ctx);
    for (const c of input.concepts) {
      const slug = c.text.toLowerCase().replace(/\s+/g, "_");
      for (const kind of ["genre", "category"] as const) {
        const t = b.tag(`${kind}:${c.scope}:${slug}`);
        b.row(t.ref, t.name, { concept: c.text, kind: "taxonomy", parent: `urn:entity:${c.scope === "media" ? "artist" : c.scope}`, entities_tagged: 40 + (fnv1a(t.name) % 900), signal: "yes" });
      }
      b.row(null, `${c.text} (descriptive)`, { concept: c.text, kind: "descriptive", parent: null, entities_tagged: null, signal: "no: flat results" });
    }
    b.metric("Taxonomy tags found", `${input.concepts.length * 2}`, "DERIVED");
    return b.build();
  },

  rank_candidates(input, ctx) {
    const b = new DigestBuilder(ctx);
    const contexts = input.contexts.map((c) => {
      switch (c.kind) {
        case "none":
          return "signal";
        case "site":
          return `site ${c.area.ref}`;
        case "city":
          return `city ${c.metro}`;
        case "metro":
          return `market ${c.market}`;
        case "audience":
          return audienceLabel(c.audience);
        case "age":
          return AGE_BUCKET_LABEL[c.age];
      }
    });
    const candidates = named(ctx, input.candidates);
    const dropped = candidates.length > 10 ? candidates[candidates.length - 1] : undefined;
    const scores = candidates.map((e) => ({
      e,
      byContext: contexts.map((c) => (e === dropped && c === contexts[contexts.length - 1] ? null : pct(`rank:${c}:${e.name}`))),
    }));
    const first = contexts[0] as string;
    scores.sort((x, y) => (y.byContext[0] ?? -1) - (x.byContext[0] ?? -1));
    const rankIn = (i: number, e: RegistryEntity): number =>
      [...scores].sort((x, y) => (y.byContext[i] ?? -1) - (x.byContext[i] ?? -1)).findIndex((s) => s.e === e) + 1;
    for (const s of scores) {
      const values: DigestRow["values"] = {};
      contexts.forEach((c, i) => (values[`fit_pct ${c}`] = s.byContext[i] ?? null));
      values.rank_first_context = rankIn(0, s.e);
      if (contexts.length > 1) values.rank_shift = rankIn(0, s.e) - rankIn(contexts.length - 1, s.e);
      values.popularity_pct = popularity(s.e.name);
      values.fit_minus_popularity = (s.byContext[0] ?? 0) - popularity(s.e.name);
      b.row(s.e.ref, s.e.name, values);
    }
    const top = scores[0];
    const last = scores[scores.length - 1];
    if (top) b.metric(`FIT of ${top.e.name} (${first})`, `${ordinal(top.byContext[0] ?? 0)} pct`);
    if (top && last && top !== last) b.metric(`FIT spread, first to last (${first})`, `${(top.byContext[0] ?? 0) - (last.byContext[0] ?? 0)} pct points`, "DERIVED");
    if (contexts.length > 1) {
      const mover = [...scores].sort((x, y) => Math.abs(rankIn(0, y.e) - rankIn(contexts.length - 1, y.e)) - Math.abs(rankIn(0, x.e) - rankIn(contexts.length - 1, x.e)))[0];
      if (mover) b.metric(`Largest rank shift: ${mover.e.name}`, `${rankIn(0, mover.e) - rankIn(contexts.length - 1, mover.e)} places`, "DERIVED");
    }
    if (dropped) {
      b.flag("DROPPED_CANDIDATES");
      b.finding("DROPPED_CANDIDATES", `${dropped.name} was not scored in the last context.`, {
        tool: "rank_candidates",
        reason: "Substitute a candidate from the discovery pool.",
      });
    }
    return b.build(dropped ? "partial" : "ok");
  },

  peer_landscape(input, ctx) {
    const b = new DigestBuilder(ctx);
    const target = ctx.registry.entity(input.target);
    if (!target) return b.build("error");
    const members: RegistryEntity[] = [target, ...named(ctx, input.peers)];
    if (input.discover) {
      for (const name of CATEGORY_PEERS) {
        if (members.length >= input.k - 1) break;
        if (!members.some((m) => m.name === name)) members.push(b.entity(name, "brand"));
      }
      if (!members.some((m) => m.name === CROSS_CATEGORY_NEIGHBOUR)) members.push(b.entity(CROSS_CATEGORY_NEIGHBOUR, "brand"));
    }
    const set = members.slice(0, input.k);
    const others = set.filter((m) => m !== target);
    const rankInRow = (row: RegistryEntity, of: RegistryEntity): number =>
      set
        .filter((m) => m !== row)
        .sort((x, y) => similarity(row.name, y.name) - similarity(row.name, x.name))
        .indexOf(of) + 1;
    const hub = (m: RegistryEntity): number =>
      round2(set.filter((o) => o !== m).reduce((acc, o) => acc + similarity(m.name, o.name), 0) / Math.max(1, set.length - 1));
    const nearestOf = (row: RegistryEntity): RegistryEntity | undefined =>
      set.filter((o) => o !== row).sort((x, y) => similarity(row.name, y.name) - similarity(row.name, x.name))[0];
    const mutual = (m: RegistryEntity): boolean => {
      const near = nearestOf(m);
      return near !== undefined && nearestOf(near) === m;
    };
    // Every pair's similarity, for within-call percentiles (affinity compares only inside one call).
    const pairs = set.flatMap((x, i) => set.slice(i + 1).map((y) => similarity(x.name, y.name))).sort((x, y) => x - y);
    const pctInCall = (s: number): number => Math.round((100 * pairs.filter((p) => p <= s).length) / Math.max(1, pairs.length));
    let targetLast = 0;
    for (const m of set) {
      const targetRank = m === target ? null : rankInRow(m, target);
      if (targetRank === set.length - 1) targetLast++;
      const near = nearestOf(m);
      const values: DigestRow["values"] = {};
      for (const o of set) values[`sim ${short(o.name)}`] = o === m ? null : similarity(m.name, o.name);
      values.rank_in_target_row = m === target ? null : rankInRow(target, m);
      values.target_rank_in_this_row = targetRank;
      values.nearest = near?.name ?? null;
      values.nearest_sim = near ? similarity(m.name, near.name) : null;
      values.mutual_nearest = mutual(m) ? "yes" : "no";
      values.target_sim_pct_in_call = m === target ? null : pctInCall(similarity(m.name, target.name));
      values.shared_tags_with_target = m === target ? null : sharedTags(m.name, target.name);
      values.hub_score = hub(m);
      values.popularity_pct = popularity(m.name);
      values.category = CROSS_CATEGORY_POOL.includes(m.name) ? "cross-category" : "same category";
      b.row(m.ref, m.name, values);
    }
    const nearest = [...others].sort((x, y) => similarity(target.name, y.name) - similarity(target.name, x.name))[0];
    const distinct = round2(1 - others.reduce((acc, o) => acc + similarity(target.name, o.name), 0) / Math.max(1, others.length));
    b.metric(`Distinctiveness of ${target.name}`, distinct.toFixed(2), "DERIVED");
    b.metric(`Rows where ${target.name} ranks last`, `${targetLast} of ${others.length}`, "DERIVED");
    b.metric(`Hub score of ${target.name}`, hub(target).toFixed(2), "DERIVED");
    const hubLeader = [...set].sort((x, y) => hub(y) - hub(x))[0];
    if (hubLeader) b.metric(`Highest hub score: ${hubLeader.name}`, hub(hubLeader).toFixed(2), "DERIVED");
    b.metric("Median pairwise similarity in the set", medianOf(pairs).toFixed(2), "DERIVED");
    const p90 = pairs[Math.floor(pairs.length * 0.9)] ?? 1;
    b.metric("Pairs at or above the set's 90th percentile", `${pairs.filter((p) => p >= p90).length} of ${pairs.length}`, "DERIVED");
    b.metric("Mutual nearest-neighbour pairs", `${set.filter(mutual).length / 2}`, "DERIVED");
    if (nearest) {
      b.metric(`Similarity ${target.name}–${nearest.name}`, similarity(target.name, nearest.name).toFixed(2));
      b.finding("NEAR_SUBSTITUTES", `${target.name} and ${nearest.name} are each other's closest taste neighbours.`, {
        tool: "share_of_taste",
        reason: "Check where the pair splits by age and market.",
      });
      if (nearest.name === CROSS_CATEGORY_NEIGHBOUR) {
        b.finding("OUTSIDE_CATEGORY_NEIGHBOUR", `The closest neighbour, ${nearest.name}, sits outside the beverage category.`, {
          tool: "cross_domain",
          reason: "Map the audience's cultural home beyond beverages.",
        });
      }
    }
    if (others.length > 0 && targetLast / others.length >= 0.75) {
      b.finding("TASTE_ISLAND", `${target.name} ranks last in ${targetLast} of ${others.length} peer rows.`, {
        tool: "cross_domain",
        reason: "Find where this audience's taste does cluster.",
      });
    }
    return b.build();
  },

  share_of_taste(input, ctx) {
    const b = new DigestBuilder(ctx);
    const set = named(ctx, input.set);
    const contexts = [
      ...input.ages.map((a: AgeBucket) => ({ key: a as string, label: AGE_BUCKET_LABEL[a], kind: "age" })),
      ...input.audiences.map((a) => ({ key: a, label: audienceLabel(a), kind: "audience" })),
      ...input.metros.map((m) => ({ key: m, label: m, kind: "market" })),
    ].slice(0, 12);
    const score = (c: string, e: RegistryEntity): number => pct(`share:${c}:${e.name}`);
    const young = input.ages.filter((a) => a === "24_and_younger" || a === "25_to_29");
    const old = input.ages.filter((a) => a === "45_to_54" || a === "55_and_older");
    const tilt = (e: RegistryEntity): number | null =>
      young.length && old.length
        ? round2((young.reduce((s, a) => s + score(a, e), 0) / young.length - old.reduce((s, a) => s + score(a, e), 0) / old.length) / 100)
        : null;
    const byScore = (e: RegistryEntity) => [...contexts].sort((x, y) => score(y.key, e) - score(x.key, e));
    for (const e of set) {
      const values: DigestRow["values"] = {};
      for (const c of contexts) values[c.label] = score(c.key, e);
      values.youth_tilt = tilt(e);
      values.contexts_won = contexts.filter((c) => set.every((o) => score(c.key, e) >= score(c.key, o))).length;
      values.best_context = byScore(e)[0]?.label ?? null;
      values.worst_context = byScore(e).at(-1)?.label ?? null;
      b.row(e.ref, e.name, values);
    }
    const target = set[0];
    if (!target) return b.build("empty");
    // Per-context leaders fill the remaining rows, as the Matrix digest does.
    let widest: { leader: string; label: string; lead: number } | null = null;
    for (const c of contexts.slice(0, Math.max(0, 12 - set.length))) {
      const ranked = [...set].sort((x, y) => score(c.key, y) - score(c.key, x));
      const [leader, runnerUp] = ranked;
      const lead = leader && runnerUp ? score(c.key, leader) - score(c.key, runnerUp) : null;
      if (leader && lead !== null && (!widest || lead > widest.lead)) widest = { leader: leader.name, label: c.label, lead };
      b.row(null, `context ${c.label}`, {
        kind: c.kind,
        leader: leader?.name ?? null,
        leader_pct: leader ? score(c.key, leader) : null,
        runner_up: runnerUp?.name ?? null,
        runner_up_pct: runnerUp ? score(c.key, runnerUp) : null,
        lead_pct_points: lead,
        set_median_pct: medianOf(set.map((e) => score(c.key, e))),
        target_pct: score(c.key, target),
        target_rank: ranked.indexOf(target) + 1,
        target_gap_to_leader: leader ? score(c.key, leader) - score(c.key, target) : null,
      });
    }
    const best = byScore(target)[0];
    if (best) b.metric(`Best context for ${target.name}: ${best.label}`, `${ordinal(score(best.key, target))} pct`);
    const worst = byScore(target).at(-1);
    if (best && worst) b.metric(`Context spread of ${target.name}`, `${score(best.key, target) - score(worst.key, target)} pct points`, "DERIVED");
    const led = contexts.filter((c) => set.every((o) => score(c.key, target) >= score(c.key, o))).length;
    b.metric(`Contexts led by ${target.name}`, `${led} of ${contexts.length}`, "DERIVED");
    if (widest) b.metric(`Widest lead: ${widest.leader} in ${widest.label}`, `${widest.lead} pct points`, "DERIVED");
    const t = tilt(target);
    if (t !== null) {
      b.metric(`Youth tilt of ${target.name}`, signed(t), "DERIVED");
      const others = set
        .slice(1)
        .map(tilt)
        .filter((x): x is number => x !== null)
        .sort((x, y) => x - y);
      const median = others[Math.floor(others.length / 2)] ?? 0;
      b.metric("Median youth tilt of the rest of the set", signed(median), "DERIVED");
      if (Math.abs(t - median) >= 0.15) {
        b.finding("GENERATIONAL_SPLIT", `${target.name}'s youth tilt differs from the set's median.`, {
          tool: "audience_dna",
          reason: "Profile the youngest-skewing members of the set.",
        });
      }
    }
    if (input.metros.length > 0) {
      const won = input.metros.filter((m) => set.every((o) => score(m, target) >= score(m, o))).length;
      b.metric(`Markets won by ${target.name}`, `${won} of ${input.metros.length}`, "DERIVED");
      const outlier = input.metros.find((m) => GAZETTEER_METROS.includes(m) && score(m, target) < 30);
      if (outlier) {
        b.finding("METRO_OUTLIER", `${target.name} ranks unusually low in ${outlier}.`, {
          tool: "block_dna",
          reason: `Look at the neighbourhood taste behind the gap in ${outlier}.`,
        });
      }
    }
    return b.build();
  },

  audience_dna(input, ctx) {
    const b = new DigestBuilder(ctx);
    b.flag("DEMOGRAPHICS_ARE_INDICES");
    const set = named(ctx, input.compare_with ? [...input.set, input.compare_with] : input.set);
    b.notices.push("Indices compare each audience with the US adult baseline (1.00 is the baseline); they are not shares.");
    const index = (k: string, e: RegistryEntity): number => round2(0.6 + 0.9 * unit(`dna:${k}:${e.name}`));
    const strongest = (e: RegistryEntity): [string, string] =>
      Object.entries(AGE_BUCKET_LABEL).sort(([x], [y]) => index(y, e) - index(x, e))[0] ?? ["", ""];
    const lean = (e: RegistryEntity): string => {
      const gap = index("female", e) - index("male", e);
      return gap >= 0.15 ? "female-leaning" : gap <= -0.15 ? "male-leaning" : "balanced";
    };
    for (const e of set) {
      const values: DigestRow["values"] = {};
      for (const [bucket, label] of Object.entries(AGE_BUCKET_LABEL)) values[`age ${label}`] = index(bucket, e);
      values.female = index("female", e);
      values.male = index("male", e);
      values.strongest_age = strongest(e)[1];
      values.gender_lean = lean(e);
      b.row(e.ref, e.name, values);
    }
    const first = set[0];
    if (!first) return b.build("empty");
    for (const e of set.slice(0, 3)) b.metric(`Age ≤24 index of ${e.name}`, index("24_and_younger", e).toFixed(2));
    b.metric(`Age 55+ index of ${first.name}`, index("55_and_older", first).toFixed(2));
    b.metric(`Female index of ${first.name}`, index("female", first).toFixed(2));
    const [topBucket, topLabel] = strongest(first);
    b.metric(`Strongest age bucket of ${first.name}: ${topLabel}`, index(topBucket, first).toFixed(2));
    b.metric(`Gender lean of ${first.name}`, lean(first), "DERIVED");
    const youngest = index("24_and_younger", first);
    const oldest = index("55_and_older", first);
    b.metric(`Age ≤24 to 55+ index ratio for ${first.name}`, round2(youngest / oldest).toFixed(2), "DERIVED");
    if (Math.abs(youngest - oldest) >= 0.3) {
      b.finding("GENERATIONAL_SPLIT", `${first.name}'s audience over-indexes at the ${youngest > oldest ? "youngest" : "oldest"} ages against the baseline.`, {
        tool: "share_of_taste",
        reason: "Check whether its peers split the same way by age.",
      });
    }
    b.metric(`Facet tags at index 1.5 or above for ${first.name}`, `${FACET_TAGS.filter((t) => facetIndex(first.name, t) >= 1.5).length} of ${FACET_TAGS.length}`, "DERIVED");
    if (input.compare_with) {
      const other = ctx.registry.entity(input.compare_with);
      b.row(null, `${first.name} only`, { tags: "trail running; cold brew; zine fairs; synth pop" });
      b.row(null, `${other?.name ?? "comparison"} only`, { tags: "golf; steakhouses; country radio; cruise travel" });
      b.row(null, "shared", { tags: "indie folk; natural wine; board-game cafes" });
    }
    facetRows(b, first.name, 12 - b.rows.length);
    return b.build();
  },

  momentum(input, ctx) {
    const b = new DigestBuilder(ctx);
    b.flag("TRENDING_HISTORICAL_WINDOW");
    b.notices.push("Momentum is historical: cite every momentum metric with {{WINDOW}}.");
    const set = named(ctx, input.entities);
    set.forEach((e, i) => {
      if (set.length > 1 && i === set.length - 1) {
        b.row(e.ref, e.name, { delta_26w_pct: null, tau: null, p: null, label: "NO SIGNAL", weeks_with_data: 3, start_index: null, end_index: null, peak_week: null });
        b.flag("NO_TREND_SIGNAL");
        b.finding("NO_TREND_SIGNAL", `${e.name} has no valid series in the window.`, null);
        return;
      }
      const delta = Math.round(-20 + 50 * unit(`mom:${e.name}`));
      const tau = round2(-0.5 + 1.1 * unit(`tau:${e.name}`));
      const label = tau > 0.2 ? "rising" : tau < -0.2 ? "declining" : "flat";
      const start = Math.round(60 + 40 * unit(`start:${e.name}`));
      const end = Math.round(start * (1 + delta / 100));
      // The series the Momentum chart draws, every second week, as the digest abbreviates it.
      const series = Array.from({ length: 13 }, (_, w) => Math.round(start + ((end - start) * w) / 12 + 8 * (unit(`noise:${e.name}:${w}`) - 0.5)));
      const peak = series.indexOf(Math.max(...series));
      b.row(e.ref, e.name, {
        delta_26w_pct: delta,
        tau,
        p: round2(0.01 + 0.3 * unit(`p:${e.name}`)),
        label,
        weeks_with_data: 26,
        start_index: start,
        end_index: end,
        peak_week: 1 + peak * 2,
        biweekly_index: series.join(" "),
      });
      b.metric(`26-week change of ${e.name}`, `${delta >= 0 ? "+" : ""}${delta}%`, "STALE");
      b.metric(`Trend label of ${e.name} (tau ${tau.toFixed(2)})`, label, "STALE");
      b.metric(`Peak week of ${e.name}`, `week ${1 + peak * 2} of 26`, "STALE");
    });
    return b.build(set.length > 1 ? "partial" : "ok");
  },

  destination_affinity(input, ctx) {
    const b = new DigestBuilder(ctx);
    const seed = named(ctx, input.seeds)
      .map((e) => e.name)
      .join("+");
    const rows = DESTINATIONS.map((d) => {
      const fit = pct(`trvl:fit:${seed}:${d}`);
      const pop = popularity(d);
      return { d, fit, pop, quadrant: quadrant(fit, pop), belt: BELTS[fnv1a(d) % BELTS.length] ?? "" };
    }).sort((x, y) => y.fit - x.fit);
    const count = (q: string): number => rows.filter((r) => r.quadrant === q).length;
    for (const r of rows) {
      const inBelt = rows.filter((o) => o.belt === r.belt);
      b.row(null, r.d, {
        fit_pct: r.fit,
        popularity_pct: r.pop,
        fit_minus_popularity: r.fit - r.pop,
        quadrant: r.quadrant,
        hidden_pocket_score: r.quadrant === "HIDDEN_POCKET" ? round2((r.fit - r.pop) / 25) : null,
        belt: r.belt || null,
        rank_in_belt: `${inBelt.indexOf(r) + 1} of ${inBelt.length}`,
        peak_season: SEASONS[fnv1a(`season:${r.d}`) % SEASONS.length] ?? null,
        shared_tags: sharedTags(seed, r.d),
      });
    }
    const top = rows[0];
    if (top) b.metric(`Travel-taste FIT of ${top.d}`, `${ordinal(top.fit)} pct`);
    b.metric("Hidden-pocket destinations", `${count("HIDDEN_POCKET")} of ${rows.length}`, "DERIVED");
    b.metric("Heartland destinations", `${count("HEARTLAND")} of ${rows.length}`, "DERIVED");
    b.metric("Mass-market destinations with low fit", `${count("MASS")} of ${rows.length}`, "DERIVED");
    const median = rows[Math.floor(rows.length / 2)];
    if (median) b.metric("Median destination FIT", `${ordinal(median.fit)} pct`, "DERIVED");
    const beltFit = (belt: string): number => medianOf(rows.filter((r) => r.belt === belt).map((r) => r.fit));
    const bestBelt = [...new Set(rows.map((r) => r.belt))].sort((x, y) => beltFit(y) - beltFit(x))[0];
    if (bestBelt) b.metric(`Belt with the highest median FIT: ${bestBelt}`, `${ordinal(beltFit(bestBelt))} pct`, "DERIVED");
    const pocket = rows.find((r) => r.quadrant === "HIDDEN_POCKET");
    if (pocket) {
      b.metric(`Hidden-pocket score of ${pocket.d}`, round2((pocket.fit - pocket.pop) / 25).toFixed(2), "DERIVED");
      b.finding("HIDDEN_POCKET", `${pocket.d} fits well above its popularity.`, null);
    }
    return b.build();
  },

  geo_lift(input, ctx) {
    const b = new DigestBuilder(ctx);
    if (input.supply) b.flag("SUPPLY_SAMPLE_ONLY");
    const key = input.concept_tags.join("+");
    const rows = NEIGHBOURHOODS.map((n) => ({
      n,
      lift: round2(0.5 + 1.7 * unit(`lift:${input.metro}:${key}:${n}`)),
      demand: pct(`demand:${input.metro}:${key}:${n}`),
      supply: input.supply ? pct(`supply:${input.metro}:${n}`) : null,
      cells: 3 + (fnv1a(`cells:${n}`) % 14),
    })).sort((x, y) => y.lift - x.lift);
    const metroLift = medianOf(rows.map((r) => r.lift));
    const confidence = (r: (typeof rows)[number]): string => (r.lift > 1.5 && r.cells >= 6 ? "high" : r.lift > 1 ? "medium" : "low");
    rows.forEach((r, i) => {
      b.row(null, r.n, {
        rank_in_metro: i + 1,
        lift: r.lift,
        lift_vs_metro_median: signed(round2(r.lift - metroLift)),
        demand_pct: r.demand,
        supply_pct: r.supply,
        demand_minus_supply: r.supply === null ? null : r.demand - r.supply,
        cells: r.cells,
        confidence: confidence(r),
        white_space: r.supply !== null && r.demand >= 70 && r.supply <= 30 ? "yes" : "no",
        top_tag: BLOCK_TAGS[fnv1a(`top:${input.metro}:${r.n}`) % BLOCK_TAGS.length]?.[0] ?? null,
      });
    });
    const top = rows[0];
    if (top) b.metric(`Concept lift in ${top.n}`, `${top.lift.toFixed(2)}x`, "DERIVED");
    b.metric(`Median neighbourhood lift in ${input.metro}`, `${metroLift.toFixed(2)}x`, "DERIVED");
    b.metric("High-confidence neighbourhoods", `${rows.filter((r) => confidence(r) === "high").length} of ${rows.length}`, "DERIVED");
    b.metric(`Neighbourhoods with lift above 1 in ${input.metro}`, `${rows.filter((r) => r.lift > 1).length} of ${rows.length}`, "DERIVED");
    const latent = rows.find((r) => r.supply !== null && r.demand >= 70 && r.supply <= 30);
    if (input.supply) b.metric("White-space neighbourhoods", `${rows.filter((r) => r.supply !== null && r.demand >= 70 && r.supply <= 30).length}`, "DERIVED");
    if (latent) {
      b.finding("LATENT_DEMAND", `${latent.n} shows high demand and thin supply.`, {
        tool: "block_dna",
        reason: `Profile ${latent.n} before shortlisting it.`,
      });
    }
    return b.build();
  },

  block_dna(input, ctx) {
    const b = new DigestBuilder(ctx);
    // A city fingerprint (kind "city") is read against the other map cities; an area against its city.
    const areaKey = input.area.kind === "city" ? input.area.market : input.area.ref;
    const against = input.area.kind === "city" ? "the other map cities" : input.area.metro;
    let fresh = 0;
    const tagRows = BLOCK_TAGS.map(([name, family]) => {
      const delta = Math.round(-12 + 40 * unit(`block:${areaKey}:${name}`));
      return { name, family, delta, isNew: delta > 20 && family === "WHAT" };
    }).sort((x, y) => y.delta - x.delta);
    for (const r of tagRows.slice(0, input.include_brands ? 9 : 12)) {
      const t = b.tag(`genre:place:${r.name.replace(/\s+/g, "_")}`);
      if (r.isNew) fresh++;
      const cityRank = 10 + (fnv1a(`city:${r.name}`) % 60);
      b.row(t.ref, r.name, {
        family: r.family,
        rank_delta: r.delta,
        area_rank: Math.max(1, cityRank - r.delta),
        city_rank: cityRank,
        area_index: round2(0.7 + 1.1 * unit(`block-ix:${areaKey}:${r.name}`)),
        venues_sampled: 4 + (fnv1a(`venues:${areaKey}:${r.name}`) % 30),
        new_vs_city: r.isNew ? "NEW" : "",
      });
    }
    const top = tagRows[0];
    if (top) b.metric(`Most over-indexed tag in the area: ${top.name}`, `+${top.delta} places`, "DERIVED");
    b.metric(`Tags new against ${against}`, `${fresh}`, "DERIVED");
    b.metric("Under-indexed tags", `${tagRows.filter((r) => r.delta < 0).length} of ${tagRows.length}`, "DERIVED");
    b.metric("Median rank delta against the city", `${medianOf(tagRows.map((r) => r.delta))} places`, "DERIVED");
    b.metric("Over-indexed WHAT tags", `${tagRows.filter((r) => r.family === "WHAT" && r.delta > 0).length}`, "DERIVED");
    if (input.include_brands) {
      for (const name of LOCAL_BRANDS) {
        const e = b.entity(name, "brand");
        b.row(e.ref, name, { family: "local brand", rank_delta: Math.round(10 + 20 * unit(`lb:${name}`)), popularity_pct: popularity(name) });
      }
    }
    if (fresh >= 1 && input.area.kind !== "city") {
      b.finding("BLOCK_NEW_TAGS", "The area carries WHAT tags that are absent city-wide.", {
        tool: "rank_candidates",
        reason: "Rank tenant brands that carry those genres.",
      });
    }
    return b.build();
  },

  cross_domain(input, ctx) {
    const b = new DigestBuilder(ctx);
    const seeds = named(ctx, input.seeds);
    const seed = seeds.map((e) => e.name).join("+");
    const perDomain = Math.max(2, Math.floor(12 / input.domains.length));
    let underRadar = 0;
    const fits: number[] = [];
    let strongest: { name: string; because: string; strength: number } | null = null;
    for (const domain of input.domains) {
      let best: { name: string; fit: number } | null = null;
      const names = DOMAIN_POOL[domain].slice(0, perDomain);
      const fitOf = (name: string): number => pct(`xdom:${seed}:${name}`);
      for (const name of names) {
        const e = b.entity(name, domain);
        const fit = fitOf(name);
        const pop = Math.min(popularity(name), Math.round(input.popularity_max * 100));
        const utr = fit - pop >= 25;
        if (utr) underRadar++;
        fits.push(fit);
        if (!best || fit > best.fit) best = { name, fit };
        const because = FACET_TAGS[fnv1a(`edge:${seed}:${name}`) % FACET_TAGS.length]?.split(": ")[1] ?? "";
        const strength = round2(0.3 + 0.65 * unit(`edge-w:${seed}:${name}`));
        if (!strongest || strength > strongest.strength) strongest = { name, because, strength };
        b.row(e.ref, name, {
          domain,
          rank_in_domain: [...names].sort((x, y) => fitOf(y) - fitOf(x)).indexOf(name) + 1,
          fit_pct: fit,
          popularity_pct: pop,
          fit_minus_popularity: fit - pop,
          under_the_radar: utr ? "yes" : "no",
          because: because || null,
          edge_strength: strength,
          shared_tags: sharedTags(seed, name),
        });
      }
      if (best) b.metric(`Top ${domain} fit: ${best.name}`, `${ordinal(best.fit)} pct`);
    }
    b.metric("UNDER-THE-RADAR picks", `${underRadar}`, "DERIVED");
    b.metric("Domains covered", `${input.domains.length}`, "DERIVED");
    b.metric("Median FIT across domains", `${ordinal(medianOf(fits))} pct`, "DERIVED");
    if (strongest) b.metric(`Strongest edge: ${strongest.name} via ${strongest.because}`, strongest.strength.toFixed(2));
    if (input.popularity_max >= 0.95) {
      b.finding("POPULARITY_DOMINANCE", "Most results are very widely known.", {
        tool: "cross_domain",
        reason: "Re-run with a lower popularity_max.",
      });
    }
    return b.build();
  },

  sponsor_slate(input, ctx) {
    const b = new DigestBuilder(ctx);
    const seed = ctx.registry.entity(input.seed)?.name ?? input.seed;
    let underRadar = 0;
    for (const category of input.categories) {
      const [bestName, runnerName] = SPONSOR_BRANDS[category];
      const best = b.entity(bestName, "brand");
      b.entity(runnerName, "brand");
      const fit = pct(`slate:${seed}:${bestName}`);
      const pop = popularity(bestName);
      if (fit - pop >= 25) underRadar++;
      const markets = [...MARKETS].sort((x, y) => unit(`mkt:${bestName}:${y}`) - unit(`mkt:${bestName}:${x}`)).slice(0, 2);
      b.row(best.ref, bestName, {
        category,
        fit_pct: fit,
        popularity_pct: pop,
        fit_minus_popularity: fit - pop,
        quadrant: quadrant(fit, pop),
        under_the_radar: fit - pop >= 25 ? "yes" : "no",
        runner_up: runnerName,
        runner_up_fit_pct: pct(`slate:${seed}:${runnerName}`),
        runner_up_popularity_pct: popularity(runnerName),
        top_markets: markets.join(", "),
        shared_tags: sharedTags(seed, bestName),
      });
    }
    for (const category of input.categories) {
      b.metric(`Best-fit ${category} sponsor FIT`, `${ordinal(pct(`slate:${seed}:${SPONSOR_BRANDS[category][0]}`))} pct`);
    }
    b.metric("UNDER-THE-RADAR sponsors", `${underRadar} of ${input.categories.length}`, "DERIVED");
    b.metric("Median best-fit sponsor FIT", `${ordinal(medianOf(input.categories.map((c) => pct(`slate:${seed}:${SPONSOR_BRANDS[c][0]}`))))} pct`, "DERIVED");
    return b.build();
  },

  taste_twins(input, ctx) {
    const b = new DigestBuilder(ctx);
    const checked = input.target_areas.length > 0 ? input.target_areas.map((a) => a.replace(/_/g, " ")) : NEIGHBOURHOODS.slice(0, 8);
    const rows = checked
      .map((n) => ({ n, rho: round2(-0.2 + 1.0 * unit(`twin:${input.source.ref}:${input.target_metro}:${n}`)) }))
      .sort((x, y) => y.rho - x.rho);
    rows.forEach((r, i) => {
      b.row(null, r.n, {
        rank_among_checked: i + 1,
        rho: r.rho,
        shared_new_tags: 1 + (fnv1a(`twin-new:${input.source.ref}:${r.n}`) % 4),
        areas_checked: rows.length,
      });
    });
    const top = rows[0];
    if (top) b.metric(`Closest-taste area in ${input.target_metro} (of the ${rows.length} checked)`, `${top.rho.toFixed(2)}`, "DERIVED");
    b.metric("Areas checked", `${rows.length}`, "DERIVED");
    b.notices.push(`Say "of the ${rows.length} areas checked": not every area of ${input.target_metro} was read.`);
    const p75 = [...rows].map((r) => r.rho).sort((x, y) => x - y)[Math.floor(rows.length * 0.75)] ?? 1;
    if (top && rows.length >= 3 && top.rho >= Math.max(p75, 0.3)) {
      b.finding("TWIN_FOUND", `${top.n} has the closest taste mix among the areas checked.`, {
        tool: "block_dna",
        reason: `Profile ${top.n} against its city.`,
      });
    }
    return b.build();
  },

  concept_vector(input, ctx) {
    const b = new DigestBuilder(ctx);
    const concept = input.concept_tags.join("+");
    const anchor = 40 + Math.floor(20 * unit(`cnpt-anchor:${concept}`));
    let kept = 0;
    let vetoed = 0;
    for (const e of named(ctx, input.analogs)) {
      const score = Math.floor(100 * unit(`cnpt:${concept}:${e.name}`));
      const verdict = score >= anchor ? "KEEP" : "VETO";
      if (verdict === "KEEP") kept++;
      else vetoed++;
      b.row(e.ref, e.name, { verdict, margin_vs_anchor_in_call: score - anchor });
    }
    const adds = DOMAIN_POOL[input.type === "tv_show" || input.type === "movie" || input.type === "artist" || input.type === "podcast" ? input.type : "brand"]
      .filter((n) => !named(ctx, input.analogs).some((e) => e.name === n))
      .slice(0, 5);
    for (const name of adds) {
      const e = b.entity(name, input.type);
      b.row(e.ref, name, { verdict: "ADD", rank_in_open_call: 1 + (fnv1a(`cnpt-add:${concept}:${name}`) % 20) });
    }
    if (kept + vetoed > 0) b.metric("AI guesses the data keeps", `${kept} of ${kept + vetoed}`, "DERIVED");
    b.metric("Found in the data (not among the guesses)", `${adds.length}`, "DERIVED");
    if (vetoed >= 1) {
      b.finding("ANALOG_VETOED", "An expected analog sits below the concept's 50th result.", {
        tool: "rank_candidates",
        reason: "Score the names the data found instead.",
      });
    }
    return b.build();
  },

  company_financials(input, ctx) {
    const b = new DigestBuilder(ctx);
    const brand = ctx.registry.entity(input.brand)?.name ?? input.brand;
    // Every brand in this scenario is invented, so none is a listed company: the honest answer is UNAVAILABLE.
    b.flag("NOT_A_LISTED_COMPANY");
    b.metric(`${brand} revenue`, "not a listed company", "UNAVAILABLE");
    b.notices.push(`${brand} is private or not mapped to an SEC filer; no figures are guessed.`);
    return b.build("empty", "company_financials");
  },

  area_economics(input, ctx) {
    const b = new DigestBuilder(ctx);
    for (const area of input.areas) {
      const name = area.replace(/_/g, " ");
      const population = 4_000 + Math.floor(30_000 * unit(`econ-pop:${input.metro}:${area}`));
      const income = 45_000 + Math.floor(60_000 * unit(`econ-inc:${input.metro}:${area}`));
      b.row(null, name, { population, median_household_income_usd: income, median_age: round2(28 + 14 * unit(`econ-age:${area}`)) });
      b.metric(`Median household income in ${name}`, `$${income.toLocaleString("en-US")} (approx.)`, "ESTIMATED");
    }
    b.flag("CENSUS_RESIDENTS_ONLY");
    b.notices.push("ACS 5-year estimates describe residents, not customers or visitors.");
    return b.build("ok", "area_economics");
  },
};

export function scriptedDigest<K extends SkillId>(tool: K, input: ToolInput<K>, ctx: DigestContext): ModelDigest {
  const script = SCRIPTS[tool] as (input: ToolInput<K>, ctx: DigestContext) => ModelDigest;
  return script(input, ctx);
}

// The run --------------------------------------------------------------------------------------------------

export const QUESTION =
  "Is Juniper Cola's audience a durable moat or a niche, and is Marlowe Ridge Sparkling really its closest rival?";

const BENCH_INTENT_BASE: Omit<Intent, "mnemonic"> = {
  pillar: "investment",
  job: "brand_health",
  mentions: [
    { text: PRIMARY_BRAND, entity_type: "brand", role: "primary", public_figure: false },
    { text: NAMED_PEER, entity_type: "brand", role: "peer", public_figure: false },
  ],
  geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
  safety: { allowed: true, category: null, reframe: null },
  read_as: { nearest: false, not_covered: [] },
  assumptions: ["US geography"],
};
export const BENCH_INTENT: Intent = { ...BENCH_INTENT_BASE, mnemonic: compileMnemonic(BENCH_INTENT_BASE) };

export interface Scenario extends DigestContext {
  /** The first user message of the run (dynamic context lives here, never in the system prompt). */
  runContext: string;
  /** Opening-scan digests, already wrapped, delivered with the wave-1 results. */
  scan: string[];
}

/** A fresh scenario per run: same inputs, same ids, same bytes. */
export function buildScenario(): Scenario {
  const ctx: DigestContext = { ledger: new Ledger(), registry: new Registry() };
  const primary = ctx.registry.add(PRIMARY_BRAND, "brand").entity;
  ctx.registry.add(NAMED_PEER, "brand");
  // The first message lists only what the resolution gate resolved; the scan's discoveries arrive with its digests.
  const runContext = runContextText(ctx.registry);
  const scan = [
    wrapQlooData(scanPeerDiscovery(primary, ctx), { tool: "peer_landscape", step: null }),
    wrapQlooData(scriptedDigest("audience_dna", { set: [primary.ref], compare_with: null, trigger_finding_id: null, step_id: null }, ctx), {
      tool: "audience_dna",
      step: null,
    }),
    wrapQlooData(scriptedDigest("destination_affinity", { seeds: [primary.ref], trigger_finding_id: null, step_id: null }, ctx), {
      tool: "destination_affinity",
      step: null,
    }),
  ];
  return { ...ctx, runContext, scan };
}

/** The brand_health scan's two discovery calls: who sits near the primary, in and out of category. */
function scanPeerDiscovery(primary: RegistryEntity, ctx: DigestContext): ModelDigest {
  const b = new DigestBuilder(ctx);
  const found = [...CATEGORY_PEERS, ...CROSS_CATEGORY_POOL];
  const fit = (name: string): number => (name === CROSS_CATEGORY_NEIGHBOUR ? 96 : pct(`disc:${primary.name}:${name}`));
  for (const call of ["same category", "cross-category"] as const) {
    const pool = call === "same category" ? CATEGORY_PEERS : CROSS_CATEGORY_POOL;
    [...pool]
      .sort((x, y) => fit(y) - fit(x))
      .forEach((name, i) => {
        const e = b.entity(name, "brand");
        b.row(e.ref, name, {
          discovery: call,
          rank_in_call: i + 1,
          fit_pct: fit(name),
          popularity_pct: popularity(name),
          fit_minus_popularity: fit(name) - popularity(name),
          quadrant: quadrant(fit(name), popularity(name)),
          shared_tags: sharedTags(primary.name, name),
        });
      });
  }
  b.metric(`Peers discovered for ${primary.name}`, `${found.length}`, "DERIVED");
  b.metric("Median FIT of same-category peers", `${ordinal(medianOf(CATEGORY_PEERS.map(fit)))} pct`, "DERIVED");
  b.metric("Median FIT of cross-category peers", `${ordinal(medianOf(CROSS_CATEGORY_POOL.map(fit)))} pct`, "DERIVED");
  b.metric(`FIT of top cross-category neighbour ${CROSS_CATEGORY_NEIGHBOUR}`, `${ordinal(fit(CROSS_CATEGORY_NEIGHBOUR))} pct`);
  const topSame = [...CATEGORY_PEERS].sort((x, y) => fit(y) - fit(x))[0] ?? CATEGORY_PEERS[0];
  b.metric(`FIT of top same-category peer ${topSame}`, `${ordinal(fit(topSame as string))} pct`);
  b.metric("Discovered peers less known than their fit", `${found.filter((n) => fit(n) - popularity(n) >= 25).length} of ${found.length}`, "DERIVED");
  b.finding("OUTSIDE_CATEGORY_NEIGHBOUR", `${CROSS_CATEGORY_NEIGHBOUR} is the closest cross-category neighbour.`, {
    tool: "peer_landscape",
    reason: `Score it inside the peer matrix for ${primary.name}.`,
  });
  return b.build();
}

function runContextText(registry: Registry): string {
  const limits = DEFAULT_RUN_LIMITS;
  const rows = registry.entities().map((e) => `| ${e.ref} | ${e.name} | ${e.type} | exact |`);
  return [
    "RUN CONTEXT",
    "MODE: live",
    `DESK: INVESTMENT. JOB: brand_health (HLTH). COMPILED: ${BENCH_INTENT.mnemonic}`,
    `BUDGET: ${limits.qlooCalls} Qloo calls per run; the opening scan uses 4. Turn 2 follow-ups: up to ${limits.followupCalls} calls. Model responses: up to ${limits.modelResponses}.`,
    `CLERK: ${JSON.stringify(BENCH_INTENT)}`,
    "REGISTRY (entity refs):",
    "| ref | name | type | match |",
    ...rows,
    `MARKETS: ${MARKETS.map((m) => `${m} (${MARKET_LABEL[m]})`).join(", ")}`,
    `AUDIENCES: ${AUDIENCES.join(", ")}`,
    "AREAS: none (the question names no gazetteer metro, so no area tool applies)",
    "OPENING SCAN (running now; its digests arrive with your wave-1 results): peer_landscape discovery for R1 (2 calls), audience_dna for R1 (1 call), destination_affinity for R1 (1 call).",
    "",
    `<user_question>${QUESTION}</user_question>`,
    "",
    "This is turn 1.",
  ].join("\n");
}

// Tool results -----------------------------------------------------------------------------------------------

/** SPEC §4.2 wording. */
export const NUDGE_PLAN = "Call submit_plan first, together with any wave-1 tools.";
export const NUDGE_REPORT = "Your turn ended without submit_report. Call submit_report now; no further tool calls are available.";
export const TURN2_GUIDE =
  "TURN 2: run planned steps that needed wave-1 results (their own tool and step_id, no trigger); every other call cites the finding behind it as trigger_finding_id (up to 8 Qloo calls in all), or call submit_report if the hypotheses are resolved.";
export const TURN3_NOTICE = "TURN 3: follow-ups are complete. Call submit_report now; it is the only call left.";

export type Phase = "wave1" | "followup" | "final";

export function planAck(plan: SubmitPlanInputShape): string {
  const h = plan.hypotheses.map((x) => x.id).join(", ");
  const s = plan.steps.map((x) => x.id).join(", ");
  return `PLAN_ACCEPTED: hypotheses ${h}; steps ${s}. Opening-scan and wave-1 digests follow.`;
}

function errorResult(use: Anthropic.Beta.BetaToolUseBlock, content: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: use.id, is_error: true, content };
}

/** Every R# and T# string anywhere in a tool input. */
export function collectRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (isId("R", value) || isId("T", value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
  return out;
}

/**
 * The tool_result for one skill call, validated the way the agent will validate it: known tool,
 * zod input (eager streaming means the server did not validate), known refs, and a cited finding
 * for every follow-up that is not a planned step. Submit tools are handled by the run loop, never here.
 * `plan` records the step ids each accepted call carries out.
 */
export function answerSkillCall(
  use: Anthropic.Beta.BetaToolUseBlock,
  phase: Phase,
  ctx: DigestContext,
  plan: PlanSteps | null = null,
): { result: Anthropic.Beta.BetaToolResultBlockParam; ok: boolean } {
  const fail = (content: string) => ({ result: errorResult(use, content), ok: false });
  if (!isToolName(use.name)) return fail(`UNKNOWN_TOOL: ${use.name} is not an available tool.`);
  const name: ToolName = use.name;
  if (phase === "final") return fail("INVESTIGATION_BUDGET_EXHAUSTED: turn 3 allows only submit_report.");
  const skill = SkillId.safeParse(name);
  if (!skill.success) return fail(`WRONG_TURN: ${name} is not a skill call.`);
  const parsed = parseToolInput(skill.data, use.input);
  if (!parsed.ok) return fail(parsed.error);
  const unknown = [...new Set(collectRefs(use.input))].filter((r) => !ctx.registry.has(r));
  if (unknown.length > 0) return fail(`UNKNOWN_REF: ${unknown.join(", ")} not in the registry.`);
  const meta = parsed.input as { trigger_finding_id: FindingId | null; step_id: StepId | null };
  if (phase === "followup") {
    if (meta.trigger_finding_id === null) {
      const refusal = notPlannedStep(name, meta.step_id, plan);
      if (refusal !== null) return fail(`TRIGGER_REQUIRED: ${refusal}`);
    } else if (!ctx.ledger.findings.has(meta.trigger_finding_id)) {
      return fail(`UNKNOWN_FINDING: ${meta.trigger_finding_id} was not issued in this run.`);
    }
  }
  if (meta.step_id !== null) plan?.run.add(meta.step_id);
  const digest = scriptedDigest(skill.data, parsed.input, ctx);
  return { result: { type: "tool_result", tool_use_id: use.id, content: wrapToolData(digest, { tool: name, step: meta.step_id }) }, ok: true };
}

/** Mirrors the agent loop: why an untriggered turn-2 call is not a planned step, or null when it is one. */
function notPlannedStep(tool: ToolName, step: StepId | null, plan: PlanSteps | null): string | null {
  const cite = "cites the finding (F#) that motivates it as trigger_finding_id";
  if (step === null) return `every turn-2 call ${cite}, except a plan step that has not run yet, named by its step_id.`;
  const planned = plan?.steps.find((s) => s.id === step);
  if (planned === undefined) return `${step} is not a step of the plan; a follow-up ${cite}.`;
  if (plan?.run.has(step)) return `${step} has already run; running it again is a follow-up that ${cite}.`;
  if (planned.tool !== tool) return `${step} plans ${planned.tool}, not ${tool}; a follow-up ${cite}.`;
  return null;
}

/** For the dry run and the tests: one representative input per skill, using the scenario's refs. */
export function sampleInputs(): { [K in SkillId]: ToolInput<K> } {
  const meta = { trigger_finding_id: null, step_id: "S1" as StepId };
  return {
    resolve_entities: { mentions: [{ text: "Copper Lantern Coffee", type: "brand", metro: null }], ...meta },
    find_tags: { concepts: [{ text: "listening bar", scope: "place" }], ...meta },
    rank_candidates: {
      type: "brand",
      candidates: ["R1", "R2"],
      signal_entities: ["R1"],
      signal_tags: [],
      contexts: [{ kind: "none" }, { kind: "age", age: "24_and_younger" }],
      ...meta,
    },
    peer_landscape: { target: "R1", peers: ["R2"], discover: true, k: 7, ...meta },
    share_of_taste: {
      type: "brand",
      set: ["R1", "R2"],
      ages: ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"],
      audiences: [...AUDIENCES],
      genders: ["female", "male"],
      metros: [...MARKETS],
      ...meta,
    },
    audience_dna: { set: ["R1", "R2"], compare_with: null, ...meta },
    momentum: { entities: ["R1", "R2"], type: "brand", ...meta },
    destination_affinity: { seeds: ["R1"], ...meta },
    geo_lift: { metro: "nashville", concept_tags: ["T1"], concept_entities: [], supply: true, ...meta },
    block_dna: { area: { kind: "nbhd", ref: "riverside_flats", metro: "nashville" }, include_brands: true, ...meta },
    cross_domain: { seeds: ["R1"], seed_tags: [], domains: ["artist", "podcast", "tv_show", "brand", "movie"], popularity_max: 0.95, ...meta },
    sponsor_slate: {
      seed: "R1",
      categories: ["beer", "spirits", "rtd_seltzer", "apparel_footwear", "qsr", "telecom"],
      shortlist: [],
      markets: [],
      ...meta,
    },
    taste_twins: {
      source: { kind: "nbhd", ref: "riverside_flats", metro: "nashville" },
      target_metro: "austin",
      target_areas: [],
      concept_tags: ["T1"],
      ...meta,
    },
    concept_vector: { concept_tags: ["T1"], type: "brand", analogs: ["R1", "R2"], ...meta },
    company_financials: { brand: "R1", ...meta },
    area_economics: { metro: "nashville", areas: ["riverside_flats", "old_mill"], ...meta },
  };
}
