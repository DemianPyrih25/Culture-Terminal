/**
 * Culture Terminal coverage probe (docs/PLAN.md §11.2, Part 8): gates C1 to C6.
 *
 *   pnpm exec tsx tools/probe/coverage.ts            print the plan (no Qloo calls)
 *   pnpm exec tsx tools/probe/coverage.ts --yes      run it live, through @ct/qloo and the shared cache
 *   pnpm exec tsx tools/probe/coverage.ts --mock --yes   run it on synthetic data (no key, no network)
 *
 * Run it from the repository root with QLOO_TAG=coverage, QLOO_TAG_CAP=120 and QLOO_RPS=1.5. Every call
 * goes through the Qloo client: allowlist, cache, rate limit, tag cap and call log. A request already
 * in the shared Postgres cache is free; --budget (default 90) caps the network calls of one run, and
 * the steps whose result matters least (the place filter checks) run last.
 *
 *   C1  /v2/tags + one heatmap per unverified or new place type (genre tag = heatmap_signal), then one
 *       places call per category tag (place_filter)
 *   C2  the runtime tag lookup + one brand discovery with filter.tags per unverified or new sponsor category
 *   C3  filter.results.entities on podcast, tv_show and movie (candidate-set invariance, then an age context)
 *   C4  signal.demographics.gender on brand, person and artist ranks (male vs female; no signal gives no affinity, G1)
 *   C5  /v2/audiences per allowed family (D21) + one audience-conditioned rank per desk
 *   C6  the restaurant baseline heatmap for New York (geohash length, cells, bytes)
 *
 * Parameters a gate exists to test (filter.results.entities on media types, the gender signal, audiences on
 * types other than brand) are not on the allowlist yet. They are added to this process's copy of the
 * allowlist only (PROBE_EXTENSIONS, printed with the plan), so the client still validates, caches and
 * counts every call; the committed allowlist changes only after a gate verifies a parameter.
 *
 * Raw answers go to .probe/raw/coverage/ (gitignored). The terminal and summary.json carry labels, counts,
 * booleans and public taxonomy URNs only; entity and locality ids stay in the raw files (D29).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AudienceKey,
  type InsightsFilterType,
  type Pillar,
  type QlooEntity,
  type QlooHeatmapCell,
  type QlooParams,
  type QlooTagSearchItem,
} from "@ct/contracts";
import { getDb } from "@ct/db";
import { offCategoryBranch } from "@ct/quant";
import { ALLOW, audienceDenial, BudgetError, QlooAuthError, type QlooPath, type QlooTool } from "@ct/qloo";
import { LOCALITIES_KV_KEY, pgKv, pinOf, readPins } from "../dev/cli/localities";
import { openCliQloo, stderrLogger, type CliQloo } from "../dev/cli/qloo-setup";

// ---------------------------------------------------------------------------------------------
// What the gates probe. Names, query strings and public taxonomy URNs only (D29).

export const PROBE_TAG = "coverage";
export const DEFAULT_BUDGET = 90;
const RAW_DIR = join(".probe", "raw", "coverage");
/** Synthetic runs (--mock) write beside the live answers, never over them. */
let rawDir = RAW_DIR;
const BASELINE_TAG = "urn:tag:genre:place:restaurant";
const GENRE_PLACE = "urn:tag:genre:place:";
const CATEGORY_PLACE = "urn:tag:category:place:";
const GENRE_BRAND = "urn:tag:genre:brand:";
const AGE_CONTEXT = "24_and_younger";

export interface PlaceTypeSpec {
  key: string;
  /** The config semantic_query, so the lookup shares find_tags' cached request. */
  query: string;
  /** A tag fits when this matches its id leaf or name (lower case). */
  match: RegExp;
  /** Taken first among the fitting tags when present. */
  prefer?: RegExp;
  /** The category candidate config/categories.json names today, checked as a filter when the search finds none. */
  configCategory?: string;
  origin: "research" | "unverified" | "new";
}

export const PLACE_TYPES: readonly PlaceTypeSpec[] = [
  { key: "lounge", query: "lounge", match: /lounge/, origin: "research" },
  { key: "wine_bar", query: "natural wine bar", match: /wine/, prefer: /wine.?bar/, configCategory: "urn:tag:category:place:wine_bar", origin: "unverified" },
  {
    key: "record_store",
    query: "vinyl record store",
    match: /record|vinyl|music.?store/,
    configCategory: "urn:tag:category:place:record_store",
    origin: "unverified",
  },
  { key: "ramen", query: "ramen", match: /ramen/, configCategory: "urn:tag:category:place:ramen_restaurant", origin: "unverified" },
  {
    key: "live_music_venue",
    query: "live music venue",
    match: /live.?music|music.?venue|concert/,
    configCategory: "urn:tag:category:place:live_music_venue",
    origin: "unverified",
  },
  { key: "bakery", query: "bakery", match: /bakery|bakeries|pastry/, configCategory: "urn:tag:category:place:bakery", origin: "unverified" },
  { key: "brewery", query: "brewery taproom", match: /brew|taproom/, configCategory: "urn:tag:category:place:brewery", origin: "unverified" },
  { key: "bookstore", query: "independent bookstore", match: /book/, configCategory: "urn:tag:category:place:book_store", origin: "unverified" },
  {
    key: "clothing_store",
    query: "clothing boutique",
    match: /cloth|apparel|boutique|fashion/,
    configCategory: "urn:tag:category:place:clothing_store",
    origin: "unverified",
  },
  { key: "gym", query: "gym", match: /\bgyms?\b|_gyms?\b|fitness.?cent|health.?club/, origin: "new" },
  { key: "beauty_salon", query: "beauty salon", match: /salon|beauty/, prefer: /beauty.?salon/, origin: "new" },
  { key: "pizza", query: "pizza", match: /pizz/, origin: "new" },
  { key: "fitness_studio", query: "fitness studio", match: /fitness|yoga|pilates|barre|cycling/, prefer: /fitness.?studio|yoga/, origin: "new" },
  { key: "burger", query: "burger", match: /burger/, origin: "new" },
  { key: "sushi", query: "sushi", match: /sushi/, origin: "new" },
];

export interface SponsorSpec {
  key: string;
  /** The config semantic_query, so the lookup shares sponsor_slate's cached request. */
  query: string;
  match: RegExp;
  origin: "unverified" | "new";
}

export const SPONSOR_SPECS: readonly SponsorSpec[] = [
  { key: "spirits", query: "whiskey", match: /whiske?y|bourbon|spirit|liquor/, origin: "unverified" },
  { key: "rtd_seltzer", query: "hard seltzer", match: /seltzer|ready.?to.?drink|canned.?cocktail|alcopop/, origin: "unverified" },
  { key: "outdoor_sporting_retail", query: "outdoor gear", match: /outdoor|camping|sporting|hunting|fishing/, origin: "unverified" },
  { key: "apparel_footwear", query: "boots and footwear", match: /boot|footwear|shoe|apparel|clothing/, origin: "unverified" },
  // A dining leaf stands for restaurant chains: the lookup has no fast-food leaf (first run).
  { key: "qsr", query: "fast food", match: /fast.?food|quick.?service|^dining($|[: ])/, origin: "unverified" },
  { key: "auto", query: "pickup trucks", match: /truck|automotive|automobile|vehicle|(^|[:_ ])cars?($|[:_ ])/, origin: "unverified" },
  { key: "telecom", query: "wireless carrier", match: /telecom|wireless|carrier|cellular|mobile.?network|phone.?service/, origin: "unverified" },
  { key: "fintech", query: "mobile payments app", match: /fintech|payment|banking|financ/, origin: "unverified" },
  { key: "beauty", query: "beauty and cosmetics", match: /beauty|cosmetic|makeup|skin.?care/, origin: "new" },
  { key: "gaming", query: "video games", match: /video.?game|gaming/, origin: "new" },
  { key: "travel", query: "travel booking", match: /travel|airline|hotel|cruise|vacation/, origin: "new" },
  { key: "food_delivery", query: "food delivery app", match: /delivery|mobile.app.food/, origin: "new" },
  { key: "consumer_tech", query: "consumer electronics", match: /electronic|consumer.?tech|computer|smartphone|gadget/, origin: "new" },
];

/** D21 families, each read once from /v2/audiences. */
export const AUDIENCE_FAMILIES = [
  "hobbies_and_interests",
  "leisure",
  "spending_habits",
  "professional_area",
  "life_stage",
  "investing_interests",
] as const;
export type AudienceFamily = (typeof AUDIENCE_FAMILIES)[number];

/** One audience-conditioned rank per desk: the family it draws from and the type it ranks. */
export const DESK_AUDIENCE_RANKS: readonly { pillar: Pillar; family: AudienceFamily; type: "brand" | "person" | "tv_show" }[] = [
  { pillar: "investment", family: "investing_interests", type: "brand" },
  { pillar: "marketing", family: "spending_habits", type: "brand" },
  { pillar: "audience", family: "life_stage", type: "tv_show" },
  { pillar: "location", family: "hobbies_and_interests", type: "person" },
];

export const MEDIA_TYPES = ["podcast", "tv_show", "movie"] as const;

/** Parameters a gate tests before the allowlist lists them: this process only, never committed. */
export const PROBE_EXTENSIONS: readonly { filterType: string; param: string; gate: string }[] = [
  ...MEDIA_TYPES.map((t) => ({ filterType: `urn:entity:${t}`, param: "filter.results.entities", gate: "C3" })),
  ...MEDIA_TYPES.map((t) => ({ filterType: `urn:entity:${t}`, param: "signal.demographics.age", gate: "C3" })),
  ...["brand", "person", "artist"].map((t) => ({ filterType: `urn:entity:${t}`, param: "signal.demographics.gender", gate: "C4" })),
  { filterType: "urn:entity:tv_show", param: "signal.demographics.audiences", gate: "C5" },
  { filterType: "urn:entity:person", param: "signal.demographics.audiences", gate: "C5" },
];

// ---------------------------------------------------------------------------------------------
// Pure parts (unit tested with invented data).

/** The leaf of a tag URN after its type prefix plus its name, lower case, for the fit patterns. */
export function tagText(tag: Pick<QlooTagSearchItem, "id" | "name">, prefix: string): string {
  const leaf = tag.id.startsWith(prefix) ? tag.id.slice(prefix.length) : tag.id;
  return `${leaf} ${tag.name}`.toLowerCase();
}

/** The first fitting tag under `prefix`, a preferred one first; Qloo's order otherwise. */
export function pickTag(tags: readonly QlooTagSearchItem[], prefix: string, match: RegExp, prefer?: RegExp): string | null {
  const fitting = tags.filter((t) => t.id.startsWith(prefix) && match.test(tagText(t, prefix)));
  const preferred = prefer ? fitting.find((t) => prefer.test(tagText(t, prefix))) : undefined;
  return (preferred ?? fitting[0])?.id ?? null;
}

export interface PlaceTagPick {
  genre: string | null;
  category: string | null;
  /** Taxonomy tags in the answer, fitting or not (a shape count). */
  genreSeen: number;
  categorySeen: number;
}

export function pickPlaceTags(tags: readonly QlooTagSearchItem[], spec: Pick<PlaceTypeSpec, "match" | "prefer">): PlaceTagPick {
  return {
    genre: pickTag(tags, GENRE_PLACE, spec.match, spec.prefer),
    category: pickTag(tags, CATEGORY_PLACE, spec.match, spec.prefer),
    genreSeen: tags.filter((t) => t.id.startsWith(GENRE_PLACE)).length,
    categorySeen: tags.filter((t) => t.id.startsWith(CATEGORY_PLACE)).length,
  };
}

export interface BrandTagPick {
  /** What sponsor_slate takes at run time: the first genre:brand tag of the lookup. */
  runtime: string | null;
  /** The first genre:brand tag that fits the category, or null. */
  fitting: string | null;
  runtimeFits: boolean;
}

export function pickBrandTag(tags: readonly QlooTagSearchItem[], match: RegExp): BrandTagPick {
  const runtime = tags.find((t) => t.id.startsWith(GENRE_BRAND))?.id ?? null;
  const fitting = pickTag(tags, GENRE_BRAND, match);
  return { runtime, fitting, runtimeFits: runtime !== null && runtime === fitting };
}

export interface HeatmapStats {
  cells: number;
  withTagAffinity: number;
  /** Cell count per geohash length. */
  geohashLengths: Record<string, number>;
  /** The most common geohash length, or null for an empty map. */
  geohashLength: number | null;
}

export function heatmapStats(cells: readonly QlooHeatmapCell[]): HeatmapStats {
  const lengths: Record<string, number> = {};
  for (const c of cells) lengths[String(c.location.geohash.length)] = (lengths[String(c.location.geohash.length)] ?? 0) + 1;
  const top = Object.entries(lengths).sort((a, b) => b[1] - a[1])[0];
  return {
    cells: cells.length,
    withTagAffinity: cells.filter((c) => typeof c.query.tag_affinity === "number").length,
    geohashLengths: lengths,
    geohashLength: top === undefined ? null : Number(top[0]),
  };
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i] as number;
    my += y[i] as number;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** A concept map against the baseline: Pearson of affinity on shared cells and the top-50 overlap. */
export function compareHeatmaps(concept: readonly QlooHeatmapCell[], baseline: readonly QlooHeatmapCell[]): { shared: number; pearson: number | null; top50: number } {
  const base = new Map(baseline.map((c) => [c.location.geohash, c.query.affinity]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of concept) {
    const b = base.get(c.location.geohash);
    if (b === undefined) continue;
    xs.push(c.query.affinity);
    ys.push(b);
  }
  const top = (cells: readonly QlooHeatmapCell[]) =>
    new Set([...cells].sort((a, b) => b.query.affinity - a.query.affinity).slice(0, 50).map((c) => c.location.geohash));
  const a = top(concept);
  const b = top(baseline);
  return { shared: xs.length, pearson: pearson(xs, ys), top50: [...a].filter((g) => b.has(g)).length };
}

/** How many rows carry a tag (insights entity tags use `id`). */
export function carrying(rows: readonly QlooEntity[], tagId: string): number {
  return rows.filter((r) => (r.tags ?? []).some((t) => t.id === tagId)).length;
}

const affinityOf = (row: QlooEntity): number | null => {
  const a = (row.query as { affinity?: unknown } | undefined)?.affinity;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
};

export interface ScoredStats {
  rows: number;
  withAffinity: number;
  distinct: number;
  /** Rows tied at the row minimum when two or more share it ("not scored in this context", G1). */
  floorTies: number;
}

export function scoredStats(rows: readonly QlooEntity[]): ScoredStats {
  const values = rows.map(affinityOf).filter((a): a is number => a !== null);
  const min = values.length > 0 ? Math.min(...values) : null;
  const atMin = min === null ? 0 : values.filter((v) => v === min).length;
  return {
    rows: rows.length,
    withAffinity: values.length,
    distinct: new Set(values).size,
    floorTies: atMin >= 2 ? atMin : 0,
  };
}

export interface Invariance {
  candidates: number;
  returned: number;
  /** Returned rows that are not candidates. */
  outside: number;
  /** Largest affinity difference against the open call, over the candidates both carry. */
  maxAbsDiff: number | null;
  compared: number;
}

/** Candidate-set invariance (G1): a rank over candidates scores each as the open call did. */
export function invariance(open: readonly QlooEntity[], ranked: readonly QlooEntity[], candidates: readonly string[]): Invariance {
  const reference = new Map(open.map((r) => [r.entity_id, affinityOf(r)]));
  const wanted = new Set(candidates);
  let maxAbsDiff: number | null = null;
  let compared = 0;
  for (const r of ranked) {
    const a = affinityOf(r);
    const b = reference.get(r.entity_id);
    if (a === null || b === null || b === undefined) continue;
    compared++;
    maxAbsDiff = Math.max(maxAbsDiff ?? 0, Math.abs(a - b));
  }
  return {
    candidates: candidates.length,
    returned: ranked.length,
    outside: ranked.filter((r) => !wanted.has(r.entity_id)).length,
    maxAbsDiff,
    compared,
  };
}

/** Two context rows over one candidate set: shared scored candidates and whether any affinity differs. */
export function contextsDiffer(a: readonly QlooEntity[], b: readonly QlooEntity[]): { shared: number; differ: boolean; listOverlap: number } {
  const bm = new Map(b.map((r) => [r.entity_id, affinityOf(r)]));
  let shared = 0;
  let differ = false;
  for (const r of a) {
    const x = affinityOf(r);
    const y = bm.get(r.entity_id);
    if (x === null || y === null || y === undefined) continue;
    shared++;
    if (Math.abs(x - y) > 1e-9) differ = true;
  }
  const overlap = a.filter((r) => bm.has(r.entity_id)).length;
  // Open rows with different members also count as a difference.
  return { shared, differ: differ || overlap < Math.min(a.length, b.length), listOverlap: overlap };
}

export interface AudienceCatalogueFamily {
  family: string;
  count: number;
  /** Ids that parse as an audience key (urn:audience:<family>:<leaf>). */
  keyed: number;
  /** Ids under the requested family. */
  inFamily: number;
  /** Ids the D21 rules deny on every desk (dropped from the catalogue). */
  denied: number;
  /** The catalogue entries: public audience URNs and names only. */
  entries: { urn: string; name: string }[];
}

export function audienceCatalogue(family: string, audiences: readonly { id: string; name: string }[]): AudienceCatalogueFamily {
  const keyed = audiences.filter((a) => AudienceKey.safeParse(a.id).success);
  const inFamily = keyed.filter((a) => a.id.startsWith(`urn:audience:${family}:`));
  const allowed = inFamily.filter((a) => audienceDenial(a.id, null) === null);
  return {
    family,
    count: audiences.length,
    keyed: keyed.length,
    inFamily: inFamily.length,
    denied: inFamily.length - allowed.length,
    entries: allowed.map((a) => ({ urn: a.id, name: a.name })),
  };
}

/** Verdicts, so the config edits read off one rule per gate. */
export const verdicts = {
  /** C1 heatmap_signal: a non-empty map whose cells carry tag_affinity. */
  heatmap: (s: HeatmapStats): boolean => s.cells > 0 && s.withTagAffinity >= Math.ceil(s.cells * 0.9),
  /** C1 place_filter / C2 brand_filter: every returned row carries the tag. */
  filter: (rows: number, carried: number, min: number): boolean => rows >= min && carried === rows,
  /**
   * C2 category fit: the filter guarantees only that rows carry the tag, so a brand_filter is verified
   * only when at least 80% of the rows also belong to the category (S10 offCategoryBranch: no main line
   * in another genre:brand branch).
   */
  members: (rows: number, members: number): boolean => rows > 0 && members >= Math.ceil(rows * 0.8),
  /** C3: every candidate returned, none outside, same affinities as the open call. */
  invariant: (i: Invariance): boolean => i.returned === i.candidates && i.outside === 0 && i.compared === i.candidates && (i.maxAbsDiff ?? 1) < 1e-6,
  /** A context row applied: at least half the candidates carry an affinity and they discriminate. */
  applied: (s: ScoredStats): boolean => s.rows > 0 && s.withAffinity >= Math.ceil(s.rows / 2) && s.distinct >= 2,
};

// ---------------------------------------------------------------------------------------------
// The live run.

interface Subjects {
  brands: string[];
  comedians: string[];
  artistSeed: string;
  sponsorSeed: string;
  nashville: string;
  nyc: string;
}

type Step = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

interface Ctx {
  q: CliQloo;
  api: QlooTool;
  budget: number;
  fresh: number;
  stopped: string | null;
  mock: boolean;
}

interface CallOutcome<T> {
  data: T | null;
  cache: string;
  error: string | null;
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function saveRaw(label: string, value: unknown): void {
  mkdirSync(join(rawDir, "calls"), { recursive: true });
  writeFileSync(join(rawDir, "calls", `${label}.json`), JSON.stringify(value, null, 1));
}

async function call<T>(ctx: Ctx, step: Step, label: string, path: QlooPath, params: QlooParams, api: QlooTool = ctx.api): Promise<CallOutcome<T>> {
  if (ctx.stopped) {
    out(`[${step} skip ] ${label}: ${ctx.stopped}`);
    return { data: null, cache: "skipped", error: ctx.stopped };
  }
  const cached = await api.has(path, params);
  if (!cached && ctx.fresh >= ctx.budget) {
    out(`[${step} skip ] ${label}: run budget of ${ctx.budget} network calls reached`);
    return { data: null, cache: "skipped", error: "BUDGET" };
  }
  try {
    let result: { data: unknown; meta: { cache: string } };
    if (path === "/v2/insights") {
      const { "filter.type": ft, ...rest } = params as Record<string, QlooParams[string]>;
      result = await api.insights(String(ft) as InsightsFilterType, rest);
    } else if (path === "/v2/tags") result = await api.tags(params);
    else if (path === "/v2/audiences") result = await api.audiences(params);
    else if (path === "/search") result = await api.search(params);
    else throw new Error(`coverage probe does not call ${path}`);
    if (result.meta.cache === "miss") ctx.fresh++;
    saveRaw(label, { step, path, params, cache: result.meta.cache, data: result.data });
    out(`[${step} ${String(ctx.fresh).padStart(3)}/${ctx.budget}] ${label.padEnd(36)} ${result.meta.cache}`);
    return { data: result.data as T, cache: result.meta.cache, error: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BudgetError || err instanceof QlooAuthError) ctx.stopped = `${name}: ${message}`;
    // A request that reached Qloo and failed still counts against the tag; the call log has it.
    saveRaw(label, { step, path, params, error: `${name}: ${message}` });
    out(`[${step} error] ${label.padEnd(36)} ${name}: ${message}`);
    return { data: null, cache: "error", error: `${name}: ${message}` };
  }
}

const insightsRows = (data: { results?: { entities?: QlooEntity[] } } | null): QlooEntity[] => data?.results?.entities ?? [];
const heatCells = (data: { results?: { heatmap?: QlooHeatmapCell[] } } | null): QlooHeatmapCell[] => data?.results?.heatmap ?? [];
const tagItems = (data: { results?: { tags?: QlooTagSearchItem[] } } | null): QlooTagSearchItem[] => data?.results?.tags ?? [];

function placeLookup(query: string): QlooParams {
  // tagSearchParams(query, "place") in packages/quant/src/skills/findTags.ts.
  return {
    "filter.query": query,
    "feature.semantic_search": true,
    "filter.parents.types": ["urn:entity:place"],
    "filter.tag.types": ["urn:tag:genre:place", "urn:tag:category:place"],
    take: 20,
  };
}

function brandLookup(query: string, take: number): QlooParams {
  // tagLookupParams in packages/quant/src/skills/sponsorSlate/categories.ts (take 5 at run time).
  return {
    "filter.query": query,
    "feature.semantic_search": true,
    "filter.parents.types": ["urn:entity:brand"],
    "filter.tag.types": ["urn:tag:genre:brand"],
    take,
  };
}

const heatmap = (location: string, tag: string): QlooParams => ({
  "filter.type": "urn:heatmap",
  "filter.location": location,
  "signal.interests.tags": [tag],
});

async function loadSubjects(mock: boolean): Promise<Subjects> {
  if (mock) {
    // Invented ids: the synthetic transport scores any string.
    return {
      brands: ["mock-brand-a", "mock-brand-b", "mock-brand-c", "mock-brand-d", "mock-brand-e"],
      comedians: ["mock-person-a", "mock-person-b", "mock-person-c"],
      artistSeed: "mock-artist-a",
      sponsorSeed: "mock-artist-b",
      nashville: "mock-locality-nashville",
      nyc: "mock-locality-nyc",
    };
  }
  const pinsFile = join(".probe", "pins.json");
  if (!existsSync(pinsFile)) throw new Error("no .probe/pins.json: run the gating probe sweep first");
  const pins = JSON.parse(readFileSync(pinsFile, "utf8")) as { entities: Record<string, { entity_id?: string }> };
  const id = (key: string): string => {
    const value = pins.entities[key]?.entity_id;
    if (!value) throw new Error(`.probe/pins.json has no entity "${key}"`);
    return value;
  };
  const kvPins = await readPins(pgKv(getDb()), LOCALITIES_KV_KEY);
  const locality = (market: string): string => {
    const pin = pinOf(kvPins, market);
    if (!pin) throw new Error(`kv ${LOCALITIES_KV_KEY} has no pin for "${market}": run tools/dev/localities.ts pin ${market}`);
    return pin.entityId;
  };
  return {
    brands: ["liquid_death", "olipop", "poppi", "celsius", "red_bull", "crocs", "birkenstock", "ugg"].map(id),
    comedians: ["nate_bargatze", "jim_gaffigan", "john_mulaney", "sebastian_maniscalco", "taylor_tomlinson"].map(id),
    artistSeed: id("taylor_swift"),
    sponsorSeed: id("zach_bryan"),
    nashville: locality("nashville"),
    nyc: locality("nyc"),
  };
}

function applyProbeExtensions(): void {
  const insights = ALLOW["/v2/insights"] as Record<string, Record<string, string>>;
  for (const e of PROBE_EXTENSIONS) {
    const table = insights[e.filterType];
    if (!table) throw new Error(`no allowlist table for ${e.filterType}`);
    if (!Object.hasOwn(table, e.param)) table[e.param] = `coverage probe ${e.gate}, this process only`;
  }
}

function printPlan(budget: number): void {
  out("Coverage probe (PLAN §11.2), QLOO_TAG=coverage. Cached requests are free; network calls stop at the run budget.");
  out(`Run budget: ${budget} network calls. Order: C6, C5 catalogue, C3, C4, C2, C1 tags and heatmaps, C5 desk ranks, C1 place filters.`);
  out(`C6  1 heatmap: restaurant baseline, New York locality from kv ${LOCALITIES_KV_KEY}`);
  out(`C5  ${AUDIENCE_FAMILIES.length} /v2/audiences (${AUDIENCE_FAMILIES.join(", ")}); then ${DESK_AUDIENCE_RANKS.length} desk ranks (${DESK_AUDIENCE_RANKS.map((d) => `${d.pillar}: ${d.type} + ${d.family}`).join("; ")})`);
  out(`C3  ${MEDIA_TYPES.length} x 3: open seed rank, the same seed over 5 of its results (invariance), the 5 under an age context`);
  out("C4  4 x 2: male and female gender signal on brands (8), comedians (5), an open artist rank and a seeded artist rank");
  out(`C2  ${SPONSOR_SPECS.length} runtime tag lookups (take 5; take 20 once when none fits) + one discovery per fitting tag`);
  out(`C1  ${PLACE_TYPES.length} place tag lookups + one Nashville heatmap per genre tag (+ the pinned baseline) + one places filter call per category tag`);
  out("Probe-only allowlist additions (this process only):");
  for (const e of PROBE_EXTENSIONS) out(`  ${e.gate}  ${e.filterType}  ${e.param}`);
  out("Nothing is sent without --yes.");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { yes: { type: "boolean" }, mock: { type: "boolean" }, budget: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });
  const budget = values.budget === undefined ? DEFAULT_BUDGET : Number(values.budget);
  if (!Number.isInteger(budget) || budget < 0) throw new Error("--budget takes a non-negative integer");
  if (!existsSync(join("tools", "probe", "coverage.ts"))) throw new Error("run from the repository root");
  printPlan(budget);
  if (values.help || !values.yes) return values.help ? 0 : 3;

  const mock = values.mock === true;
  if (mock) rawDir = `${RAW_DIR}-mock`;
  const q = await openCliQloo({
    env: process.env,
    mock,
    tag: PROBE_TAG,
    store: mock ? "memory" : "pg",
    logger: stderrLogger((line) => process.stderr.write(`${line}\n`)),
  });
  try {
    if (q.tag !== PROBE_TAG) throw new Error(`QLOO_TAG must be ${PROBE_TAG}`);
    const before = mock ? 0 : await q.store.countNetworkCalls({ env: q.client.env, tag: PROBE_TAG });
    out(`Store ${q.storeLabel}; tag ${q.tag}, cap ${q.tagCap ?? "none"}; network calls logged for the tag before this run: ${before}`);
    applyProbeExtensions();
    const ctx: Ctx = { q, api: q.client.standalone().forTool(null), budget, fresh: 0, stopped: null, mock };
    const subjects = await loadSubjects(mock);
    const summary = await runGates(ctx, subjects);
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "summary.json"), JSON.stringify({ ...summary, network_calls_this_run: ctx.fresh, stopped: ctx.stopped }, null, 1));
    out(`\nNetwork calls this run: ${ctx.fresh}. Summary: ${join(rawDir, "summary.json")}`);
    return 0;
  } finally {
    await q.close();
  }
}

async function runGates(ctx: Ctx, s: Subjects): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};

  // C6: New York baseline (geohash length decides districts vs NTAs, D39).
  const nyc = await call<{ results?: { heatmap?: QlooHeatmapCell[] } }>(ctx, "C6", "c6_nyc_baseline", "/v2/insights", heatmap(s.nyc, BASELINE_TAG));
  const nycCells = heatCells(nyc.data);
  summary.c6 = { ...heatmapStats(nycCells), bytes: nyc.data ? Buffer.byteLength(JSON.stringify(nyc.data)) : null, cache: nyc.cache, error: nyc.error };

  // C5 catalogue: one /v2/audiences per allowed family (leisure keeps the cached take 50).
  const catalogue: Record<string, AudienceCatalogueFamily & { cache: string; error: string | null }> = {};
  for (const family of AUDIENCE_FAMILIES) {
    const r = await call<{ results?: { audiences?: { id: string; name: string }[] } }>(ctx, "C5", `c5_audiences_${family}`, "/v2/audiences", {
      "filter.parents.types": [`urn:audience:${family}`],
      take: family === "leisure" ? 50 : 100,
    });
    catalogue[family] = { ...audienceCatalogue(family, r.data?.results?.audiences ?? []), cache: r.cache, error: r.error };
  }

  // C3: named lists on media types.
  const c3: Record<string, unknown> = {};
  const mediaPicks: Record<string, string[]> = {};
  for (const t of MEDIA_TYPES) {
    const ft = `urn:entity:${t}`;
    const open = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C3", `c3_${t}_open`, "/v2/insights", {
      "filter.type": ft,
      "signal.interests.entities": [s.artistSeed],
      take: 10,
    });
    const openRows = insightsRows(open.data);
    const picks = openRows.filter((_, i) => i % 2 === 1).map((r) => r.entity_id).slice(0, 5);
    mediaPicks[t] = picks;
    if (picks.length < 3) {
      c3[t] = { open: scoredStats(openRows), error: open.error ?? "too few results to pick candidates" };
      continue;
    }
    const ranked = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C3", `c3_${t}_rank`, "/v2/insights", {
      "filter.type": ft,
      "signal.interests.entities": [s.artistSeed],
      "filter.results.entities": picks,
      take: picks.length,
    });
    const aged = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C3", `c3_${t}_age`, "/v2/insights", {
      "filter.type": ft,
      "signal.demographics.age": [AGE_CONTEXT],
      "filter.results.entities": picks,
      take: picks.length,
    });
    const inv = invariance(openRows, insightsRows(ranked.data), picks);
    const age = scoredStats(insightsRows(aged.data));
    const ageOutside = insightsRows(aged.data).filter((r) => !picks.includes(r.entity_id)).length;
    c3[t] = {
      open: scoredStats(openRows),
      invariance: inv,
      rankable: ranked.error === null && verdicts.invariant(inv),
      age_context: { ...age, outside: ageOutside },
      age_applied: aged.error === null && ageOutside === 0 && verdicts.applied(age),
      errors: [ranked.error, aged.error].filter(Boolean),
    };
  }
  summary.c3 = c3;

  // C4: gender signal, male vs female.
  const c4: Record<string, unknown> = {};
  const genderPair = async (label: string, ft: string, extra: QlooParams) => {
    const m = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C4", `c4_${label}_male`, "/v2/insights", { "filter.type": ft, "signal.demographics.gender": "male", ...extra });
    const f = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C4", `c4_${label}_female`, "/v2/insights", { "filter.type": ft, "signal.demographics.gender": "female", ...extra });
    const mr = insightsRows(m.data);
    const fr = insightsRows(f.data);
    const male = scoredStats(mr);
    const female = scoredStats(fr);
    const diff = contextsDiffer(mr, fr);
    c4[label] = {
      male,
      female,
      ...diff,
      verified: m.error === null && f.error === null && verdicts.applied(male) && verdicts.applied(female) && diff.differ,
      errors: [m.error, f.error].filter(Boolean),
    };
  };
  await genderPair("brand", "urn:entity:brand", { "filter.results.entities": s.brands, take: s.brands.length });
  await genderPair("person", "urn:entity:person", { "filter.results.entities": s.comedians, take: s.comedians.length });
  await genderPair("artist", "urn:entity:artist", { take: 15 });
  // The first run answered the open artist rank with HTTP 400; artists rank from seeds (rank_candidates), so the
  // seeded form decides whether gender applies there.
  await genderPair("artist_seeded", "urn:entity:artist", { "signal.interests.entities": [s.artistSeed], take: 15 });
  summary.c4 = c4;

  // C2: sponsor categories.
  const c2: Record<string, unknown> = {};
  for (const spec of SPONSOR_SPECS) {
    let lookup = await call<{ results?: { tags?: QlooTagSearchItem[] } }>(ctx, "C2", `c2_${spec.key}_tags`, "/v2/tags", brandLookup(spec.query, 5));
    let pick = pickBrandTag(tagItems(lookup.data), spec.match);
    const runtime = pick;
    let widened = false;
    if (pick.fitting === null && lookup.error === null) {
      lookup = await call<{ results?: { tags?: QlooTagSearchItem[] } }>(ctx, "C2", `c2_${spec.key}_tags20`, "/v2/tags", brandLookup(spec.query, 20));
      pick = pickBrandTag(tagItems(lookup.data), spec.match);
      widened = true;
    }
    const entry: Record<string, unknown> = {
      origin: spec.origin,
      runtime_tag: runtime.runtime,
      runtime_fits: runtime.runtimeFits,
      widened,
      tag: pick.fitting,
    };
    if (pick.fitting !== null) {
      const d = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C2", `c2_${spec.key}_discovery`, "/v2/insights", {
        "filter.type": "urn:entity:brand",
        "signal.interests.entities": [s.sponsorSeed],
        "filter.tags": [pick.fitting],
        take: 10,
      });
      const rows = insightsRows(d.data);
      const carried = carrying(rows, pick.fitting);
      const fitting = pick.fitting;
      const members = rows.filter((r) => offCategoryBranch(r, fitting) === null).length;
      Object.assign(entry, {
        rows: rows.length,
        carrying: carried,
        members,
        verified: d.error === null && verdicts.filter(rows.length, carried, 5) && verdicts.members(rows.length, members),
        error: d.error,
      });
    } else {
      Object.assign(entry, { verified: false, error: lookup.error ?? "no fitting genre:brand tag" });
    }
    c2[spec.key] = entry;
  }
  summary.c2 = c2;

  // C1: place types, tags and heatmaps (Nashville, against the pinned baseline).
  const baseline = await call<{ results?: { heatmap?: QlooHeatmapCell[] } }>(ctx, "C1", "c1_nashville_baseline", "/v2/insights", heatmap(s.nashville, BASELINE_TAG));
  const baseCells = heatCells(baseline.data);
  const c1: Record<string, Record<string, unknown>> = {};
  for (const spec of PLACE_TYPES) {
    const lookup = await call<{ results?: { tags?: QlooTagSearchItem[] } }>(ctx, "C1", `c1_${spec.key}_tags`, "/v2/tags", placeLookup(spec.query));
    const pick = pickPlaceTags(tagItems(lookup.data), spec);
    const entry: Record<string, unknown> = { origin: spec.origin, ...pick, lookup_error: lookup.error };
    if (pick.genre !== null) {
      const h = await call<{ results?: { heatmap?: QlooHeatmapCell[] } }>(ctx, "C1", `c1_${spec.key}_heatmap`, "/v2/insights", heatmap(s.nashville, pick.genre));
      const stats = heatmapStats(heatCells(h.data));
      Object.assign(entry, {
        heatmap: stats,
        vs_baseline: baseCells.length > 0 ? compareHeatmaps(heatCells(h.data), baseCells) : null,
        heatmap_verified: h.error === null && verdicts.heatmap(stats),
        heatmap_error: h.error,
      });
    } else {
      entry.heatmap_verified = false;
    }
    c1[spec.key] = entry;
  }

  // C5: one audience-conditioned rank per desk, on that desk's allowlist.
  const c5ranks: Record<string, unknown> = {};
  for (const d of DESK_AUDIENCE_RANKS) {
    const entries = catalogue[d.family]?.entries ?? [];
    const audience = entries.find((e) => audienceDenial(e.urn, d.pillar) === null)?.urn ?? null;
    const candidates = d.type === "brand" ? s.brands : d.type === "person" ? s.comedians : (mediaPicks.tv_show ?? []);
    if (audience === null || candidates.length < 3) {
      c5ranks[d.pillar] = { type: d.type, family: d.family, error: audience === null ? "no audience in the family" : "too few candidates" };
      continue;
    }
    const api = ctx.q.client.standalone({ pillar: d.pillar }).forTool(null);
    const r = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C5", `c5_rank_${d.pillar}`, "/v2/insights", {
      "filter.type": `urn:entity:${d.type}`,
      "signal.demographics.audiences": [audience],
      "filter.results.entities": candidates,
      take: candidates.length,
    }, api);
    const stats = scoredStats(insightsRows(r.data));
    c5ranks[d.pillar] = { type: d.type, family: d.family, audience, ...stats, applied: r.error === null && verdicts.applied(stats), error: r.error };
  }
  summary.c5 = {
    families: Object.fromEntries(Object.entries(catalogue).map(([k, v]) => [k, { count: v.count, keyed: v.keyed, inFamily: v.inFamily, denied: v.denied, cache: v.cache, error: v.error }])),
    ranks: c5ranks,
  };
  // The catalogue itself (public audience URNs and names) for the kv pin plan.
  writeFileSync(join(rawDir, "audience-catalogue.json"), JSON.stringify(Object.fromEntries(Object.entries(catalogue).map(([k, v]) => [k, v.entries])), null, 1));

  // C1 last: the category tags as place filters (Nashville, filter-only, G10 form).
  for (const spec of PLACE_TYPES) {
    const entry = c1[spec.key] as Record<string, unknown>;
    const tag = (entry.category as string | null) ?? spec.configCategory ?? null;
    if (tag === null) {
      entry.filter_verified = false;
      continue;
    }
    const r = await call<{ results?: { entities?: QlooEntity[] } }>(ctx, "C1", `c1_${spec.key}_places`, "/v2/insights", {
      "filter.type": "urn:entity:place",
      "filter.location": s.nashville,
      "filter.tags": [tag],
      take: 10,
    });
    const rows = insightsRows(r.data);
    const carried = carrying(rows, tag);
    Object.assign(entry, { filter_tag: tag, filter_rows: rows.length, filter_carrying: carried, filter_verified: r.error === null && verdicts.filter(rows.length, carried, 1), filter_error: r.error });
  }
  summary.c1 = c1;
  return summary;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Started with plain `pnpm exec tsx`, so the root .env loads here; variables set in the shell win.
  const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
