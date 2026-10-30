// pnpm exec tsx tools/dev/osm-tags.ts check [--write]
// pnpm exec tsx tools/dev/osm-tags.ts warm [--metro <id>] [--yes]
//
// Checks config/osm_tags.json live against OpenStreetMap's own statistics (Part 11 design §3.2). Free,
// no Qloo call, no key:
//   place types and activity: every tag (key=value, or a key for an exists filter) must have an OSM
//     wiki page and at least 10,000 uses on taginfo (https://taginfo.openstreetmap.org/api/4/...).
//     Regex filters are read in the two shapes the config uses, `^(a|b)$` and the list form
//     `(^|;) *(a|b) *(;|$)`, and each alternative is checked; any other regex fails.
//   metros: each county Wikidata id must resolve, through one Overpass request, to exactly one
//     administrative boundary area at admin_level 6 whose FIPS code (when tagged) is the county's.
// Prints one line per entry. With --write, a passing entry gets status "verified" and a dated
// verified_by line; a failing place type or metro is removed (never marked); an activity value that
// fails is dropped from its alternation. Exit 3 when anything fails. Sends OSM_USER_AGENT from the
// process environment as its User-Agent when set (it never reads .env files), else a generic one.
//
// warm: reads every map city's city reference (its counties, in the fixed type sets runs ask for:
// osmCitySets) through the public-data client into the shared Postgres cache (DATABASE_URL), with
// Overpass's 180 s limit, so runs find them cached (a large county takes minutes to count, longer than
// a run waits). Answers stay 30 days, and stale copies serve up to 120 days when Overpass fails; run it
// after a deploy and then monthly. Needs OSM_USER_AGENT in the process environment; each request
// counts toward OSM_DAILY_MAX. Prints the plan and sends only with --yes; cached sets cost nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, getDb, pingDb } from "@ct/db";
import { resolveQlooEnv } from "@ct/qloo";
import {
  createPgPublicStore,
  createPublicDataClient,
  createPublicHttpTransport,
  osmCitySets,
  osmDailyMaxFromEnv,
  osmMetroShape,
  osmTags,
  OsmTagsConfig,
  type OsmTagsConfig as OsmTagsConfigT,
} from "@ct/publicdata";
import { consoleIo, type CliIo } from "./cli/io";

const CONFIG = fileURLToPath(new URL("../../config/osm_tags.json", import.meta.url));
const TAGINFO = "https://taginfo.openstreetmap.org/api/4";
const OVERPASS = process.env.OSM_OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter";
export const MIN_USES = 10_000;
const PAUSE_MS = 250;

type Filter = { key: string; value: string | null; op: "eq" | "regex" | "exists" };
export interface TagRef {
  key: string;
  /** null: the key itself (an exists filter). */
  value: string | null;
}
export interface TagStat {
  uses: number;
  wiki: boolean;
}

const ALTERNATION = /^\^\(([a-z0-9_]+(?:\|[a-z0-9_]+)*)\)\$$/;
const LIST_FORM = /^\(\^\|;\) \*\(([a-z0-9_]+(?:\|[a-z0-9_]+)*)\) \*\(;\|\$\)$/;

/** The tag values a config regex matches, or null when it is not one of the two readable shapes. */
export function regexValues(pattern: string): { values: string[]; form: "alternation" | "list" } | null {
  const a = ALTERNATION.exec(pattern);
  if (a) return { values: (a[1] as string).split("|"), form: "alternation" };
  const l = LIST_FORM.exec(pattern);
  if (l) return { values: (l[1] as string).split("|"), form: "list" };
  return null;
}

/** Rebuilds a regex of the same shape from the values kept. */
export function regexFrom(values: readonly string[], form: "alternation" | "list"): string {
  return form === "alternation" ? `^(${values.join("|")})$` : `(^|;) *(${values.join("|")}) *(;|$)`;
}

/** Every tag a group list depends on, or null when a regex cannot be read. */
export function tagsOf(groups: readonly (readonly Filter[])[]): TagRef[] | null {
  const out = new Map<string, TagRef>();
  for (const group of groups) {
    for (const f of group) {
      if (f.op === "exists") out.set(`${f.key}`, { key: f.key, value: null });
      else if (f.op === "eq") out.set(`${f.key}=${f.value}`, { key: f.key, value: f.value });
      else {
        const parsed = regexValues(f.value ?? "");
        if (parsed === null) return null;
        for (const v of parsed.values) out.set(`${f.key}=${v}`, { key: f.key, value: v });
      }
    }
  }
  return [...out.values()];
}

export const tagText = (t: TagRef): string => (t.value === null ? `${t.key}=*` : `${t.key}=${t.value}`);
const passes = (s: TagStat | undefined): boolean => s !== undefined && s.uses >= MIN_USES && s.wiki;

export interface EntryVerdict {
  name: string;
  ok: boolean;
  line: string;
}

/** A dated verified_by line, or the reason an entry fails. */
export function judgeTags(tags: readonly TagRef[] | null, stats: ReadonlyMap<string, TagStat>, date: string): { ok: boolean; line: string } {
  if (tags === null) return { ok: false, line: "a regex filter is not in a readable shape" };
  const parts = tags.map((t) => {
    const s = stats.get(tagText(t));
    if (s === undefined) return { ok: false, text: `${tagText(t)} not checked` };
    const uses = `${s.uses.toLocaleString("en-US")} uses`;
    return { ok: passes(s), text: `${tagText(t)} ${uses}${s.wiki ? "" : ", no wiki page"}` };
  });
  const ok = parts.every((p) => p.ok);
  return { ok, line: ok ? `taginfo ${date}: ${parts.map((p) => p.text).join("; ")}; wiki pages present` : parts.filter((p) => !p.ok).map((p) => p.text).join("; ") };
}

/** Activity: alternation values that fail are dropped; null when nothing usable is left. */
export function pruneGroups(groups: Filter[][], stats: ReadonlyMap<string, TagStat>): Filter[][] | null {
  const kept: Filter[][] = [];
  for (const group of groups) {
    const filters: Filter[] = [];
    let usable = true;
    for (const f of group) {
      if (f.op !== "regex") {
        const ref: TagRef = { key: f.key, value: f.op === "exists" ? null : f.value };
        if (!passes(stats.get(tagText(ref)))) usable = false;
        filters.push(f);
        continue;
      }
      const parsed = regexValues(f.value ?? "");
      if (parsed === null) {
        usable = false;
        continue;
      }
      const values = parsed.values.filter((v) => passes(stats.get(tagText({ key: f.key, value: v }))));
      if (values.length === 0) usable = false;
      else filters.push({ ...f, value: regexFrom(values, parsed.form) });
    }
    if (usable) kept.push(filters);
  }
  return kept.length > 0 ? kept : null;
}

export interface AdminArea {
  wikidata: string;
  relationId: number;
  adminLevel: string | null;
  fips: string | null;
  name: string | null;
}

/** A metro passes when each county id resolves to exactly one admin_level 6 area with the county's FIPS code. */
export function judgeMetro(
  counties: readonly { name: string; fips: string; wikidata: string }[],
  areas: readonly AdminArea[],
  date: string,
): { ok: boolean; line: string } {
  const notes: string[] = [];
  const problems: string[] = [];
  for (const c of counties) {
    const found = areas.filter((a) => a.wikidata === c.wikidata);
    if (found.length !== 1) {
      problems.push(`${c.wikidata} (${c.name}) resolves to ${found.length} boundary areas`);
      continue;
    }
    const a = found[0] as AdminArea;
    if (a.adminLevel !== "6") problems.push(`${c.wikidata} is admin_level ${a.adminLevel ?? "unset"}, not 6`);
    else if (a.fips !== null && Number(a.fips) !== Number(c.fips)) problems.push(`${c.wikidata} carries FIPS ${a.fips}, not ${c.fips}`);
    else notes.push(`${c.wikidata} relation ${a.relationId} "${a.name ?? "?"}"`);
  }
  return problems.length > 0
    ? { ok: false, line: problems.join("; ") }
    : { ok: true, line: `overpass ${date}: admin_level=6 boundary, one area each: ${notes.join("; ")}` };
}

/** The checked config: verified where passing, failing entries removed. */
export function applyVerdicts(
  config: OsmTagsConfigT,
  stats: ReadonlyMap<string, TagStat>,
  areas: readonly AdminArea[],
  date: string,
): { config: OsmTagsConfigT; verdicts: EntryVerdict[] } {
  const verdicts: EntryVerdict[] = [];
  const out: OsmTagsConfigT = structuredClone(config);

  const activityGroups = pruneGroups(out.activity.groups as Filter[][], stats);
  if (activityGroups === null) {
    out.activity.status = "candidate";
    out.activity.verified_by = "";
    verdicts.push({ name: "activity", ok: false, line: "no usable filter left" });
  } else {
    out.activity.groups = activityGroups as typeof out.activity.groups;
    const j = judgeTags(tagsOf(activityGroups), stats, date);
    out.activity.status = j.ok ? "verified" : "candidate";
    out.activity.verified_by = j.ok ? j.line : "";
    verdicts.push({ name: "activity", ok: j.ok, line: j.line });
  }

  out.place_types = out.place_types.filter((t) => {
    const j = judgeTags(tagsOf(t.groups as Filter[][]), stats, date);
    verdicts.push({ name: `type ${t.key}`, ok: j.ok, line: j.line });
    if (!j.ok) return false;
    t.status = "verified";
    t.verified_by = j.line;
    return true;
  });

  for (const [id, m] of Object.entries(out.metros)) {
    const j = judgeMetro(m.counties, areas, date);
    verdicts.push({ name: `metro ${id}`, ok: j.ok, line: j.line });
    if (!j.ok) {
      delete out.metros[id];
      continue;
    }
    m.status = "verified";
    m.verified_by = j.line;
  }
  return { config: out, verdicts };
}

// Network -----------------------------------------------------------------------------------------------------

const userAgent = (): string => process.env.OSM_USER_AGENT?.trim() || "Culture Terminal osm-tags checker";

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": userAgent(), Accept: "application/json", ...(init.headers as Record<string, string>) } });
    if (res.ok) return res.json() as Promise<unknown>;
    if (attempt >= 4 || ![429, 502, 503, 504].includes(res.status)) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    await delay(5_000 * attempt);
  }
}

async function taginfoStat(t: TagRef): Promise<TagStat> {
  const q = t.value === null ? `key=${encodeURIComponent(t.key)}` : `key=${encodeURIComponent(t.key)}&value=${encodeURIComponent(t.value)}`;
  const kind = t.value === null ? "key" : "tag";
  const stats = (await getJson(`${TAGINFO}/${kind}/stats?${q}`)) as { data?: { type: string; count: number }[] };
  await delay(PAUSE_MS);
  const wiki = (await getJson(`${TAGINFO}/${kind}/wiki_pages?${q}`)) as { data?: unknown[] };
  await delay(PAUSE_MS);
  return { uses: stats.data?.find((d) => d.type === "all")?.count ?? 0, wiki: (wiki.data?.length ?? 0) > 0 };
}

async function adminAreas(qids: readonly string[]): Promise<AdminArea[]> {
  const ql = `[out:json][timeout:60];(area["wikidata"~"^(${qids.join("|")})$"]["boundary"="administrative"];);out tags;`;
  const body = (await getJson(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: `data=${encodeURIComponent(ql)}`,
  })) as { elements?: { id: number; tags?: Record<string, string> }[] };
  return (body.elements ?? []).map((e) => ({
    wikidata: e.tags?.wikidata ?? "",
    relationId: e.id - 3_600_000_000,
    adminLevel: e.tags?.admin_level ?? null,
    fips: e.tags?.["nist:fips_code"] ?? null,
    name: e.tags?.name ?? null,
  }));
}

/** How long the warm-up waits for one county-union answer (Overpass gets 180 s of work plus its queue). */
const WARM_TIMEOUT_MS = 240_000;
const WARM_ROUNDS = 3;
const WARM_PAUSE_MS = 60_000;

async function warm(argv: readonly string[], io: CliIo): Promise<number> {
  const userAgentValue = process.env.OSM_USER_AGENT?.trim();
  if (!userAgentValue) {
    io.err("OSM_USER_AGENT is not set in the environment: the Overpass usage policy asks for a User-Agent naming the product and a contact.");
    return 2;
  }
  const env = resolveQlooEnv(process.env);
  if (env === "mock") {
    io.err("QLOO_MOCK is set: the warm-up reads live OpenStreetMap data into the live cache namespace; unset it.");
    return 2;
  }
  const metroAt = argv.indexOf("--metro");
  const only = metroAt >= 0 ? (argv[metroAt + 1] ?? "") : null;
  const metros = [...osmTags().metros.keys()].filter((id) => only === null || id === only);
  if (metros.length === 0) {
    io.err(only === null ? "no verified metro in config/osm_tags.json" : `no verified metro "${only}"`);
    return 2;
  }
  const sets = osmCitySets();
  io.out(`${metros.length} metro(s) × ${sets.length} type set(s) (${sets.map((s) => `${s.id}: ${s.types.length}`).join(", ")}): up to ${metros.length * sets.length} Overpass requests`);
  if (!argv.includes("--yes")) {
    io.out("Pass --yes to read them.");
    return 0;
  }
  const db = getDb();
  if (!(await pingDb(db))) {
    await closeDb();
    io.err("Postgres is not reachable (DATABASE_URL); the warm-up writes to the shared cache.");
    return 2;
  }
  const overpassUrl = process.env.OSM_OVERPASS_URL?.trim() || undefined;
  const client = createPublicDataClient({
    env,
    tag: process.env.QLOO_TAG?.trim() || "osm-warm",
    secUserAgent: null,
    osmUserAgent: userAgentValue,
    osmOverpassUrl: overpassUrl,
    osmDailyMax: osmDailyMaxFromEnv(process.env),
    osmLongQueries: true,
    transport: createPublicHttpTransport({ secUserAgent: null, censusApiKey: null, osmUserAgent: userAgentValue, osmOverpassUrl: overpassUrl, osmTimeoutMs: WARM_TIMEOUT_MS }),
    store: createPgPublicStore(db),
  });
  let pending = metros.flatMap((metro) => sets.map((set) => ({ metro, set })));
  try {
    const api = client.standalone().forTool(null);
    // A busy public instance answers 502 for minutes at a time: failed sets get two more rounds, a pause apart.
    for (let round = 1; round <= WARM_ROUNDS && pending.length > 0; round++) {
      if (round > 1) {
        io.out(`${pending.length} set(s) failed; trying again in ${WARM_PAUSE_MS / 1000} s`);
        await delay(WARM_PAUSE_MS);
      }
      const failed: typeof pending = [];
      for (const job of pending) {
        const shape = osmMetroShape(job.metro);
        if (shape === null) continue;
        try {
          const res = await api.osmCounts({ shapes: [shape], types: job.set.types });
          io.out(`ok    ${job.metro} ${job.set.id}: ${res.meta.cache}, ${res.meta.reference}`);
        } catch (err) {
          failed.push(job);
          io.out(`FAIL  ${job.metro} ${job.set.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      pending = failed;
    }
    await client.flush();
  } finally {
    await closeDb();
  }
  io.out(pending.length === 0 ? "all cached" : `${pending.length} set(s) still failed: ${pending.map((j) => `${j.metro} ${j.set.id}`).join(", ")}`);
  return pending.length === 0 ? 0 : 3;
}

export async function main(argv: readonly string[], io: CliIo = consoleIo): Promise<number> {
  if (argv[0] === "warm") return warm(argv.slice(1), io);
  if (argv[0] !== "check") {
    io.err("usage: pnpm exec tsx tools/dev/osm-tags.ts check [--write] | warm [--metro <id>] [--yes]");
    return 2;
  }
  const write = argv.includes("--write");
  const config = OsmTagsConfig.parse(JSON.parse(readFileSync(CONFIG, "utf8")));
  const date = new Date().toISOString().slice(0, 10);

  const refs = new Map<string, TagRef>();
  for (const groups of [config.activity.groups, ...config.place_types.map((t) => t.groups)]) {
    for (const t of tagsOf(groups as Filter[][]) ?? []) refs.set(tagText(t), t);
  }
  io.out(`${refs.size} tags to check on taginfo, ${Object.keys(config.metros).length} metros on Overpass`);
  const stats = new Map<string, TagStat>();
  for (const [text, ref] of refs) {
    stats.set(text, await taginfoStat(ref));
  }
  const qids = [...new Set(Object.values(config.metros).flatMap((m) => m.counties.map((c) => c.wikidata)))];
  const areas = qids.length > 0 ? await adminAreas(qids) : [];

  const { config: checked, verdicts } = applyVerdicts(config, stats, areas, date);
  for (const v of verdicts) io.out(`${v.ok ? "ok    " : "FAIL  "}${v.name}: ${v.line}`);
  const failed = verdicts.filter((v) => !v.ok).length;
  io.out(`${verdicts.length} entries: ${verdicts.length - failed} ok, ${failed} failed`);
  if (write) {
    writeFileSync(CONFIG, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
    io.out(`wrote ${CONFIG}`);
  }
  return failed === 0 ? 0 : 3;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      consoleIo.err(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    },
  );
}
