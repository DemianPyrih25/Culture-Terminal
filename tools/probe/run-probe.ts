/**
 * Culture Terminal gating probe (docs/PLAN.md §11.2), the first step of Foundation.
 *
 *   node tools/probe/run-probe.ts --dry-run          print the call plan; no network, no key needed
 *   node --env-file=.env tools/probe/run-probe.ts    run live against the hackathon host
 *
 * Run it from the repository root. Budget: at most 50 gate calls plus 25 resolution-sweep calls at
 * 2 rps. The caps are cumulative across reruns (.probe/ledger.json) and a call is counted before it
 * is sent. Every response is kept in .probe/raw/, so a rerun replays it and never sends an identical
 * request twice. Development stops at 38,000 calls remaining (D24), and that halt persists.
 *
 * Everything under .probe/ is gitignored. Only shapes and booleans may be copied from it into
 * docs/PROBE_FINDINGS.md: no Qloo values, UUIDs or request ids in git (D29).
 *
 * Gate budget versus the §11.2 table: G1 adds a no-signal control row and G3 adds a second metro, so
 * that an ignored signal is detectable. G11 runs one entity per type (4 instead of 6) to pay for them.
 *
 * Runs on Node 24 type stripping with no dependencies, so it keeps to erasable TypeScript syntax.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Kind = "gate" | "sweep";
type Params = Record<string, string | number | boolean>;
type Res = { id: string; status: number; ok: boolean; body: any; ms: number; bytes: number; reused: boolean; note?: string };
type SweepItem = { key: string; name: string; type: string; hint?: RegExp };
type Category = { key: string; q: string; parent: string; must: RegExp[]; prefer?: RegExp; reject?: RegExp };
type LedgerCall = { id: string; kind: Kind; status: number | "pending" | "not_sent"; ts: string };
type Ledger = { gate: number; sweep: number; halted: string | null; month_remaining: number | null; calls: LedgerCall[] };

const HOST = "https://hackathon.api.qloo.com";
const OUT = ".probe";
const RAW = join(OUT, "raw");
const LEDGER_FILE = join(OUT, "ledger.json");
const CAPS: Record<Kind, number> = { gate: 50, sweep: 25 };
const MIN_GAP_MS = 500; // 2 rps
const DEV_FLOOR = 38_000; // D24: development stops at 38,000 remaining (judging reserve)
const TIMEOUT_MS = 30_000; // above the runtime client's 20 s, so a slow call is measured rather than lost
const TREND_WINDOW = { start: "2025-04-01", end: "2025-09-30" }; // G11
// Errors raised before a request leaves the machine: nothing reached Qloo, so nothing is counted.
const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

// Public coordinates, not Qloo data. WKT is lon-first; rings are closed and counter-clockwise.
const NASHVILLE_POINT = "POINT(-86.7816 36.1627)"; // downtown
const NASHVILLE_POLYGON = "POLYGON((-86.9 36.05,-86.65 36.05,-86.65 36.27,-86.9 36.27,-86.9 36.05))";
const EAST_NASHVILLE_POINT = "POINT(-86.7484 36.1766)"; // Five Points
const EAST_NASHVILLE_POLYGON =
  "POLYGON((-86.765 36.168,-86.737 36.165,-86.733 36.18,-86.745 36.192,-86.762 36.188,-86.765 36.168))";
const AUSTIN_BBOX = { minLat: 30.0, maxLat: 30.6, minLon: -98.1, maxLon: -97.5 };
const BASELINE_TAG = "urn:tag:genre:place:restaurant"; // S6 pinned baseline
const CAFE_TAG = "urn:tag:category:place:cafe"; // research: "coffee" returns 0 places, "cafe" works
const FALLBACK_CONCEPT_TAGS = ["urn:tag:genre:place:restaurant:bar", "urn:tag:genre:place:lounge"]; // named working in research
const AGE_YOUNG = "24_and_younger";

// Resolution sweep: every showcase, chain and gate-dependency entity. Exact normalised name and the
// correct type only (D20); localities and destinations must also match their hint (case-sensitive).
const SWEEP: SweepItem[] = [
  { key: "liquid_death", name: "Liquid Death", type: "urn:entity:brand" },
  { key: "olipop", name: "Olipop", type: "urn:entity:brand" },
  { key: "poppi", name: "Poppi", type: "urn:entity:brand" },
  { key: "celsius", name: "Celsius", type: "urn:entity:brand" },
  { key: "red_bull", name: "Red Bull", type: "urn:entity:brand" },
  { key: "crocs", name: "Crocs", type: "urn:entity:brand" },
  { key: "birkenstock", name: "Birkenstock", type: "urn:entity:brand" },
  { key: "ugg", name: "UGG", type: "urn:entity:brand" },
  { key: "trader_joes", name: "Trader Joe's", type: "urn:entity:brand" },
  { key: "zach_bryan", name: "Zach Bryan", type: "urn:entity:artist" },
  { key: "taylor_swift", name: "Taylor Swift", type: "urn:entity:artist" },
  { key: "yellowstone", name: "Yellowstone", type: "urn:entity:tv_show" },
  { key: "nate_bargatze", name: "Nate Bargatze", type: "urn:entity:person" },
  { key: "jim_gaffigan", name: "Jim Gaffigan", type: "urn:entity:person" },
  { key: "john_mulaney", name: "John Mulaney", type: "urn:entity:person" },
  { key: "sebastian_maniscalco", name: "Sebastian Maniscalco", type: "urn:entity:person" },
  { key: "taylor_tomlinson", name: "Taylor Tomlinson", type: "urn:entity:person" },
  { key: "nashville", name: "Nashville", type: "urn:entity:locality", hint: /Tennessee|\bTN\b/ },
  { key: "austin", name: "Austin", type: "urn:entity:locality", hint: /Texas|\bTX\b/ },
  { key: "east_nashville", name: "East Nashville", type: "urn:entity:locality", hint: /Nashville/ },
  { key: "nashville_destination", name: "Nashville", type: "urn:entity:destination", hint: /Tennessee|\bTN\b/ },
  { key: "austin_destination", name: "Austin", type: "urn:entity:destination", hint: /Texas|\bTX\b/ },
];
const NOT_PROFILED = new Set(["urn:entity:locality", "urn:entity:destination"]); // kept out of the G12 pool

// G14: 8 sponsor categories (brand parents) and 4 place categories (S4's three candidate concepts).
// A tag is accepted only if every `must` pattern matches its name or id and its parent type fits.
const CATEGORIES: Category[] = [
  { key: "beer", q: "beer", parent: "urn:entity:brand", must: [/beer|brew/] },
  { key: "spirits", q: "whiskey", parent: "urn:entity:brand", must: [/whiske?y|bourbon|spirit|liquor/] },
  { key: "seltzer", q: "hard seltzer", parent: "urn:entity:brand", must: [/seltzer/] },
  { key: "energy", q: "energy drink", parent: "urn:entity:brand", must: [/energy/, /drink/] },
  { key: "outdoor", q: "outdoor gear", parent: "urn:entity:brand", must: [/outdoor|camping|sporting/] },
  { key: "footwear", q: "boots and footwear", parent: "urn:entity:brand", must: [/boot|footwear|shoe/] },
  { key: "qsr", q: "fast food", parent: "urn:entity:brand", must: [/fast.?food|quick.?service/] },
  { key: "auto", q: "pickup trucks", parent: "urn:entity:brand", must: [/\btrucks?\b|automotive|\bauto\b|\bcars?\b/] },
  { key: "natural_wine", q: "natural wine bar", parent: "urn:entity:place", must: [/wine/], prefer: /wine.?bar/ },
  { key: "vinyl", q: "vinyl record store", parent: "urn:entity:place", must: [/(record|vinyl|music).?(store|shop)/] },
  { key: "ramen", q: "ramen", parent: "urn:entity:place", must: [/ramen/] },
  { key: "coffee", q: "coffee shop", parent: "urn:entity:place", must: [/coffee|caf[eé]/], reject: /internet|\bcat\b/ },
];

// ---------------------------------------------------------------------------------------------
// Guards on how the probe is started.

const ARGS = process.argv.slice(2);
for (const a of ARGS) if (a !== "--dry-run") fail(`unknown argument "${a}"; the only flag is --dry-run`);
const DRY = ARGS.includes("--dry-run");
if (!existsSync(join("tools", "probe", "run-probe.ts"))) {
  fail("run from the repository root, so the shared ledger and raw store are used");
}
const apiKey = process.env.QLOO_API_KEY ?? "";
const baseUrl = (process.env.QLOO_BASE_URL ?? "").replace(/\/+$/, "");
if (!DRY) {
  if (baseUrl !== HOST) fail(`QLOO_BASE_URL must be ${HOST}; refusing to send the key anywhere else.`);
  if (!apiKey) fail("QLOO_API_KEY is not set. Run with: node --env-file=.env tools/probe/run-probe.ts");
  mkdirSync(RAW, { recursive: true });
}

// ---------------------------------------------------------------------------------------------
// Transport: pacing, caps, ledger, disk reuse, retries, breakers and halts.

const ledger: Ledger = !DRY && existsSync(LEDGER_FILE)
  ? JSON.parse(readFileSync(LEDGER_FILE, "utf8"))
  : { gate: 0, sweep: 0, halted: null, month_remaining: null, calls: [] };
const plan: string[] = [];
const fresh: Record<Kind, number> = { gate: 0, sweep: 0 };
const denied = new Set<string>(); // path|type pairs that answered 403 once the key was proven
let lastStart = 0;
let halted: string | null = ledger.halted === "DEV_FLOOR" ||
  (ledger.month_remaining !== null && ledger.month_remaining < DEV_FLOOR) ? "DEV_FLOOR" : null;
let keyProven = false;
let consecDown = 0;
let firstMonthRemaining: number | null = null;

async function call(id: string, kind: Kind, gate: string, path: string, params: Params): Promise<Res> {
  const query = Object.keys(params).sort().map((k) => `${k}=${enc(String(params[k]))}`).join("&");
  const url = `${path}?${query}`;
  const hash = sha256(`v1|GET|${url}`);
  const denyKey = `${path}|${String(params["filter.type"] ?? params.types ?? "")}`;
  if (DRY) {
    plan.push(`${kind.padEnd(5)} ${gate.padEnd(6)} ${id.padEnd(28)} GET ${url}`);
    return { id, status: 0, ok: true, body: null, ms: 0, bytes: 0, reused: false, note: "dry" };
  }
  const file = join(RAW, `${id}.json`);
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    if (prev.hash === hash && reusable(prev)) {
      if (prev.status === 200) keyProven = true;
      if (prev.status === 403) denied.add(denyKey);
      consecDown = 0;
      report(kind, gate, id, prev.status, prev.ms, prev.body, "reused");
      return { id, status: prev.status, ok: prev.status === 200 && !prev.rate_limited, body: prev.body, ms: prev.ms, bytes: prev.bytes, reused: true };
    }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (halted) return skip(kind, gate, id, halted);
    if (denied.has(denyKey)) return skip(kind, gate, id, "DENIED_403_SAME_TYPE");
    if (ledger[kind] >= CAPS[kind]) return skip(kind, gate, id, `CAP_${kind.toUpperCase()}_${CAPS[kind]}`);
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    // Counted before it is sent, so a crash mid-flight can never under-count the cap.
    ledger[kind]++;
    fresh[kind]++;
    const entry: LedgerCall = { id, kind, status: "pending", ts: new Date().toISOString() };
    ledger.calls.push(entry);
    saveLedger();
    let status = 0;
    let text = "";
    let headers: Record<string, string | null> = {};
    let error: string | null = null;
    let code = "";
    const t0 = performance.now();
    try {
      const r = await fetch(`${HOST}${url}`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
        redirect: "error", // never let the key follow a redirect
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = r.status;
      headers = pickHeaders(r.headers);
      text = await r.text();
    } catch (e) {
      // Only the error class and code: a message could echo request details.
      const err = e as { name?: string; cause?: { code?: string } };
      code = err.cause?.code ?? "";
      error = [err.name, code].filter(Boolean).join(":") || "FetchError";
    }
    const ms = Math.round(performance.now() - t0);
    const notSent = NOT_SENT.has(code);
    if (notSent) {
      ledger[kind]--;
      fresh[kind]--;
      entry.status = "not_sent";
    } else {
      entry.status = status;
    }
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { _non_json: text.slice(0, 500) };
    }
    const rateLimited = status === 429 || (status === 200 && isObj(body) && "error_msg" in body);
    const month = Number(headers["x-month-ratelimit-remaining"]);
    if (headers["x-month-ratelimit-remaining"] != null && Number.isFinite(month)) {
      firstMonthRemaining ??= month;
      ledger.month_remaining = month;
      if (month < DEV_FLOOR) {
        halted = "DEV_FLOOR";
        ledger.halted = "DEV_FLOOR"; // persists: reruns send nothing new
      }
    }
    if (status === 200 && !rateLimited) keyProven = true;
    if (status === 401) halted = "AUTH_401";
    else if (status === 403) {
      // Once a call has succeeded, a 403 means "type not permitted here": that is the gate's answer.
      denied.add(denyKey);
      if (!keyProven) halted = "AUTH_403_BEFORE_ANY_SUCCESS";
    }
    const down = error !== null || status === 502 || status === 503 || status === 504;
    consecDown = down ? consecDown + 1 : 0;
    if (notSent && attempt === 2 && !halted) halted = "NETWORK";
    else if (consecDown >= 3 && !halted) halted = "UPSTREAM_DOWN";
    saveLedger();
    const bytes = Buffer.byteLength(text);
    if (!notSent) {
      writeFileSync(file, JSON.stringify({
        id, kind, gate, hash, path, query, status, rate_limited: rateLimited, error, ms, bytes,
        headers, fetched_at: new Date().toISOString(), body,
      }, null, 1));
    }
    report(kind, gate, id, status, ms, body, error ?? (rateLimited ? "rate-limited" : ""));
    // A gate's 5xx is its answer and is not resent; rate limits and network errors get one retry.
    const retryable = rateLimited || error !== null || (status >= 500 && kind === "sweep");
    if (retryable && attempt === 1 && !halted) {
      const reset = Number(headers["x-second-ratelimit-reset"]);
      await sleep(Math.max(Number.isFinite(reset) ? reset * 1000 : 0, 1500));
      continue;
    }
    return { id, status, ok: status === 200 && !rateLimited, body, ms, bytes, reused: false, note: error ?? undefined };
  }
  return skip(kind, gate, id, "RETRY_EXHAUSTED");
}

function reusable(prev: any): boolean {
  if (prev.rate_limited || prev.status === 401) return false; // a 401 was the key, not the request
  if (prev.status >= 200 && prev.status < 500) return true;
  return prev.status === 500 && prev.kind === "gate"; // a gate's 500 is its answer; never resend it
}

function skip(kind: Kind, gate: string, id: string, why: string): Res {
  console.log(`[${kind} skip ] ${gate.padEnd(6)} ${id.padEnd(28)} ${why}`);
  return { id, status: 0, ok: false, body: null, ms: 0, bytes: 0, reused: false, note: why };
}

function report(kind: Kind, gate: string, id: string, status: number, ms: number, body: any, note: string): void {
  const n = rows(body);
  const used = `${ledger[kind]}/${CAPS[kind]}`.padStart(5);
  console.log(`[${kind} ${used}] ${gate.padEnd(6)} ${id.padEnd(28)} ${String(status).padEnd(3)} ${String(ms).padStart(5)}ms rows=${n ?? "-"} ${note}`);
}

function saveLedger(): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));
}

function pickHeaders(h: Headers): Record<string, string | null> {
  const keep = [
    "x-qloo-request-id", "x-month-ratelimit-limit", "x-month-ratelimit-remaining", "x-month-ratelimit-reset",
    "x-second-ratelimit-limit", "x-second-ratelimit-remaining", "x-second-ratelimit-reset", "content-type",
  ];
  return Object.fromEntries(keep.map((k) => [k, h.get(k)]));
}

// ---------------------------------------------------------------------------------------------
// Probe steps in dependency order. Calls whose result matters least (page-2 checks) run last, so a
// retry that uses up the cap costs one of them rather than a whole gate.

const ids: Record<string, string | null> = {};
const pins: Record<string, unknown> = {};
const results: Record<string, Res> = {};
const sent: Record<string, Params> = {};
const derived: Record<string, unknown> = {};

async function main(): Promise<void> {
  // Sweep: entity resolution (22) + the leisure audience catalogue (1).
  for (const item of SWEEP) ids[item.key] = await resolve(item);
  const audiences = await run("s_audiences_leisure", "sweep", "SWEEP", "/v2/audiences", {
    "filter.parents.types": "urn:audience:leisure",
    take: 50,
  });
  const audienceUrns = DRY ? ["<urn:audience:leisure:*>"] : uniq(deepStrings(audiences.body, /^urn:audience:leisure:/));
  const audience = audienceUrns.find((u) => /festival|concert|music/.test(u)) ?? audienceUrns[0] ?? null;
  derived.audiences = { status: audiences.status, urn_count: audienceUrns.length, picked: audience };

  // G14 first: its tags feed the G1 tag row and the G6/G7 concept heatmaps.
  const tagPick: Record<string, string | null> = {};
  const g14: Record<string, unknown> = {};
  for (const c of CATEGORIES) {
    const r = await run(`g14_${c.key}`, "gate", "G14", "/v2/tags", {
      "filter.query": c.q,
      "feature.semantic_search": true,
      "filter.parents.types": c.parent,
      take: 10,
    });
    const pick = DRY ? { tag: `<tag:${c.key}>`, name: null, parent_checked: false, candidates: 0 } : pickTag(r.body, c);
    tagPick[c.key] = pick.tag;
    g14[c.key] = { status: r.status, matched: pick.tag !== null, ...pick };
  }
  derived.g14 = g14;

  const C = ["liquid_death", "olipop", "poppi", "celsius", "red_bull", "crocs", "birkenstock", "ugg"].filter((k) => ids[k]);
  const haveC = C.length >= 3;
  if (!haveC) console.log(`candidate set C has ${C.length} resolved brands; skipping the rows that score it`);
  const idsOf = (keys: string[]) => keys.map((k) => ids[k]).filter(Boolean).join(",");
  const brandRank = (extra: Params, candidates: string[]): Params => ({
    "filter.type": "urn:entity:brand",
    "filter.results.entities": idsOf(candidates),
    take: 10,
    ...extra,
  });
  const without = (k: string) => C.filter((x) => x !== k);

  // G1: a no-signal control over C (the reference vector for spotting ignored signals), pair symmetry
  // (3 full rows), candidate-set invariance (a subset row for the same seed), a tag row, an audience row.
  if (haveC) {
    await run("g1_control_no_signal", "gate", "G1", "/v2/insights", brandRank({}, C));
    for (const seed of ["liquid_death", "olipop", "poppi"]) {
      if (ids[seed]) await run(`g1_row_${seed}`, "gate", "G1", "/v2/insights", brandRank({ "signal.interests.entities": ids[seed]! }, without(seed)));
    }
    const subset = ["olipop", "poppi", "celsius"].filter((k) => ids[k]);
    if (ids.liquid_death && subset.length >= 2) {
      await run("g1_invariance_liquid_death", "gate", "G1", "/v2/insights", brandRank({ "signal.interests.entities": ids.liquid_death }, subset));
    }
    const g1Tag = tagPick.energy ?? tagPick.beer;
    derived.g1_tag_source = tagPick.energy ? "energy" : tagPick.beer ? "beer" : "none";
    if (g1Tag) await run("g1_tag_row", "gate", "G1", "/v2/insights", brandRank({ "signal.interests.tags": g1Tag }, C));
    if (audience) await run("g1_audience_row", "gate", "G1", "/v2/insights", brandRank({ "signal.demographics.audiences": audience }, C));
  }

  // G2: brand rank with a location-only signal, four forms for Nashville. The .query form runs first:
  // its locality echo is the fallback when /search cannot resolve the locality.
  if (haveC) {
    const g2q = await run("g2_query", "gate", "G2", "/v2/insights", brandRank({ "signal.location.query": "Nashville, TN" }, C));
    if (!ids.nashville && !DRY) ids.nashville = echoedLocality(g2q.body, "signal");
    if (ids.nashville) await run("g2_uuid", "gate", "G2", "/v2/insights", brandRank({ "signal.location": ids.nashville }, C));
    await run("g2_polygon", "gate", "G2", "/v2/insights", brandRank({ "signal.location": NASHVILLE_POLYGON }, C));
    await run("g2_point", "gate", "G2", "/v2/insights", brandRank({ "signal.location": NASHVILLE_POINT }, C));
  }
  derived.nashville_source = DRY ? "dry" : pins.nashville ? "search" : ids.nashville ? "g2_query_echo" : "unresolved";

  // G4: brand rank with an age-only signal.
  if (haveC) await run("g4_age_only", "gate", "G4", "/v2/insights", brandRank({ "signal.demographics.age": AGE_YOUNG }, C));

  // G6: concept vs baseline heatmaps, Nashville and Austin, no dimensions. Austin's locality comes
  // from the sweep, else from the heatmap echo of a filter.location.query call.
  const wine = tagPick.natural_wine;
  const vinyl = tagPick.vinyl;
  const conceptTags = wine && vinyl ? `${wine},${vinyl}` : FALLBACK_CONCEPT_TAGS.join(",");
  derived.concept_tags_source = DRY ? "dry" : wine && vinyl ? "g14" : "fallback";
  const heat = (where: Params, tags: string, extra: Params = {}): Params => ({
    "filter.type": "urn:heatmap",
    ...where,
    "signal.interests.tags": tags,
    ...(tags.includes(",") ? { "operator.signal.interests.tags": "union" } : {}),
    ...extra,
  });
  if (ids.nashville) {
    await run("g6_nashville_concept", "gate", "G6", "/v2/insights", heat({ "filter.location": ids.nashville }, conceptTags));
    await run("g6_nashville_baseline", "gate", "G6", "/v2/insights", heat({ "filter.location": ids.nashville }, BASELINE_TAG));
  }
  const austinWhere = (): Params => (ids.austin ? { "filter.location": ids.austin } : { "filter.location.query": "Austin, TX" });
  const g6ac = await run("g6_austin_concept", "gate", "G6", "/v2/insights", heat(austinWhere(), conceptTags));
  if (!ids.austin && !DRY) ids.austin = echoedLocality(g6ac.body, "filter");
  derived.austin_source = DRY ? "dry" : pins.austin ? "search" : ids.austin ? "g6_heatmap_echo" : "unresolved";
  await run("g6_austin_baseline", "gate", "G6", "/v2/insights", heat(austinWhere(), BASELINE_TAG));

  // G3: person rank (5 comedians) with a location-only signal, in two metros, so an ignored location
  // shows up as identical rows. Gates S6 or its swap.
  const comedians = ["nate_bargatze", "jim_gaffigan", "john_mulaney", "sebastian_maniscalco", "taylor_tomlinson"].filter((k) => ids[k]);
  const person = (loc: Params): Params => ({ "filter.type": "urn:entity:person", ...loc, "filter.results.entities": idsOf(comedians), take: 10 });
  if (comedians.length >= 3) {
    if (ids.nashville) await run("g3_person_nashville", "gate", "G3", "/v2/insights", person({ "signal.location": ids.nashville }));
    await run("g3_person_austin", "gate", "G3", "/v2/insights", person(ids.austin ? { "signal.location": ids.austin } : { "signal.location.query": "Austin, TX" }));
  }

  // G7: heatmap.dimensions=price_level, with the concept tags vs with the baseline tag (Austin).
  await run("g7_concept_price_level", "gate", "G7", "/v2/insights", heat(austinWhere(), conceptTags, { "heatmap.dimensions": "price_level" }));
  await run("g7_baseline_price_level", "gate", "G7", "/v2/insights", heat(austinWhere(), BASELINE_TAG, { "heatmap.dimensions": "price_level" }));

  // G8: Block DNA ladder for East Nashville: POINT, POINT + radius, POLYGON, POLYGON + tag type.
  const tagsAt = (extra: Params): Params => ({ "filter.type": "urn:tag", take: 50, ...extra });
  await run("g8_point", "gate", "G8", "/v2/insights", tagsAt({ "signal.location": EAST_NASHVILLE_POINT }));
  await run("g8_point_radius_600", "gate", "G8", "/v2/insights", tagsAt({ "signal.location": EAST_NASHVILLE_POINT, "signal.location.radius": 600 }));
  await run("g8_polygon", "gate", "G8", "/v2/insights", tagsAt({ "signal.location": EAST_NASHVILLE_POLYGON }));
  await run("g8_polygon_who", "gate", "G8", "/v2/insights", tagsAt({
    "signal.location": EAST_NASHVILLE_POLYGON,
    "filter.tag.types": "urn:tag:customer_identity:qloo",
  }));

  // G9: local brand discovery at a POINT with a popularity cap.
  const g9 = await run("g9_local_brands", "gate", "G9", "/v2/insights", {
    "filter.type": "urn:entity:brand",
    "signal.location": EAST_NASHVILLE_POINT,
    "filter.popularity.max": 0.9,
    take: 30,
  });

  // G11: trending over the historical window, take=50, one entity per type we use.
  const trend: [string, string][] = [
    ["liquid_death", "urn:entity:brand"], ["zach_bryan", "urn:entity:artist"],
    ["yellowstone", "urn:entity:tv_show"], ["nate_bargatze", "urn:entity:person"],
  ];
  for (const [key, type] of trend) {
    if (!ids[key]) continue;
    await run(`g11_${key}`, "gate", "G11", "/v2/trending", {
      "filter.type": type,
      "signal.interests.entities": ids[key]!,
      "filter.start_date": TREND_WINDOW.start,
      "filter.end_date": TREND_WINDOW.end,
      take: 50,
    });
  }

  // G13: compare (two brands); its tags are checked against the /search tags of the same brands.
  if (ids.olipop && ids.poppi) {
    await run("g13_compare", "gate", "G13", "/v2/analysis/compare", {
      "a.signal.interests.entities": ids.olipop,
      "b.signal.interests.entities": ids.poppi,
      take: 30,
    });
  }

  // G15: explainability with two seeds on the artist domain.
  let g15: Res | null = null;
  if (ids.trader_joes && ids.liquid_death) {
    g15 = await run("g15_explainability", "gate", "G15", "/v2/insights", {
      "filter.type": "urn:entity:artist",
      "signal.interests.entities": `${ids.trader_joes},${ids.liquid_death}`,
      "feature.explainability": true,
      take: 15,
    });
  }

  // G12: urn:demographics with 20 IDs in the form other teams used live (no take: the control) and
  // 30 IDs with take=50, so a default page of 20 cannot pass for a batch limit.
  const pool = DRY
    ? Array.from({ length: 30 }, (_, i) => `<id${i + 1}>`)
    : uniq([
        ...SWEEP.filter((s) => !NOT_PROFILED.has(s.type)).map((s) => ids[s.key]),
        ...entities(g9.body).map((e) => e?.entity_id),
        ...entities(g15?.body).map((e) => e?.entity_id),
      ].filter((x): x is string => typeof x === "string"));
  derived.g12_pool = pool.length;
  for (const n of [20, 30]) {
    if (pool.length < n) continue;
    await run(`g12_demographics_${n}`, "gate", "G12", "/v2/insights", {
      "filter.type": "urn:demographics",
      "signal.interests.entities": pool.slice(0, n).join(","),
      ...(n === 30 ? { take: 50 } : {}),
    });
  }

  // G5: destinations with country_code=US, take=50, seeded by an audience with global taste so an
  // ignored filter would show non-US rows; then filter.results.entities over named metro destinations.
  const destSeed = ids.taylor_swift ?? ids.zach_bryan;
  derived.g5_seed = DRY ? "dry" : ids.taylor_swift ? "taylor_swift" : ids.zach_bryan ? "zach_bryan" : "none";
  const dest = (extra: Params): Params => ({
    "filter.type": "urn:entity:destination",
    "signal.interests.entities": destSeed!,
    ...extra,
  });
  let g5p1: Res | null = null;
  if (destSeed) {
    g5p1 = await run("g5_dest_us_p1", "gate", "G5", "/v2/insights", dest({ "filter.geocode.country_code": "US", take: 50 }));
    const picks = DRY ? ["<nashville_destination>", "<austin_destination>", "<dest3>", "<dest4>", "<dest5>"] : pickDestinations(entities(g5p1.body));
    if (picks.length >= 2) await run("g5_dest_rank", "gate", "G5", "/v2/insights", dest({ "filter.results.entities": picks.join(","), take: 10 }));
  }

  // G10: places in Austin with the category tag research verified, take=50. A rejected filter-only
  // call is retried once with the locality as the signal.
  let g10p1: Res | null = null;
  const places = (extra: Params): Params => ({
    "filter.type": "urn:entity:place",
    "filter.location": ids.austin!,
    "filter.tags": CAFE_TAG,
    take: 50,
    ...extra,
  });
  if (ids.austin) {
    g10p1 = await run("g10_places_p1", "gate", "G10", "/v2/insights", places({ page: 1 }));
    if (!DRY && g10p1.status === 400) {
      await run("g10_places_p1_signal", "gate", "G10", "/v2/insights", places({ page: 1, "signal.location": ids.austin }));
    }
  }

  // Tail: page-2 checks, only when page 1 came back full (otherwise page 2 is known to be empty).
  const full = (r: Res | null) => r !== null && (DRY || (r.ok && entities(r.body).length === 50));
  if (destSeed && full(g5p1)) {
    await run("g5_dest_us_p2", "gate", "G5", "/v2/insights", dest({ "filter.geocode.country_code": "US", take: 50, page: 2 }));
  }
  if (ids.austin && full(g10p1)) await run("g10_places_p2", "gate", "G10", "/v2/insights", places({ page: 2 }));
}

async function run(id: string, kind: Kind, gate: string, path: string, params: Params): Promise<Res> {
  sent[id] = params;
  const r = await call(id, kind, gate, path, params);
  results[id] = r;
  return r;
}

async function resolve(item: SweepItem): Promise<string | null> {
  const r = await run(`s_${item.key}`, "sweep", "SWEEP", "/search", { query: item.name, types: item.type, take: 5 });
  if (DRY) return `<${item.key}>`;
  const list: any[] = Array.isArray(r.body?.results) ? r.body.results : [];
  const place = (e: any) => `${e?.disambiguation ?? ""} ${JSON.stringify(e?.properties?.geocode ?? {})} ${e?.properties?.address ?? ""}`;
  const exact = list.filter((e) =>
    norm(String(e?.name ?? "")) === norm(item.name) && hasType(e, item.type) && (!item.hint || item.hint.test(place(e))));
  const pick = exact[0];
  pins[item.key] = pick
    ? { entity_id: pick.entity_id, name: pick.name, type: item.type, exact_count: exact.length, returned: list.length }
    : null;
  derived[`sweep_${item.key}`] = { status: r.status, returned: list.length, exact: exact.length };
  return typeof pick?.entity_id === "string" ? pick.entity_id : null;
}

// ---------------------------------------------------------------------------------------------
// Analysis: derived checks per gate. Values stay in .probe/; PROBE_FINDINGS.md gets booleans only.

function analyse(): Record<string, unknown> {
  const body = (id: string) => results[id]?.body ?? null;
  const status = (id: string) => results[id]?.status ?? null; // null: not run
  const affs = (id: string) => affinityMap(body(id));
  const requested = (id: string) => listParam(sent[id], "filter.results.entities").length;
  const out: Record<string, unknown> = {};

  const rowStats = (id: string) => {
    const a = [...affs(id).values()];
    return {
      status: status(id), requested: sent[id] ? requested(id) : null, scored: a.length,
      min: a.length ? round(Math.min(...a)) : null, max: a.length ? round(Math.max(...a)) : null,
      distinct: new Set(a).size, signal_echoed: echoedLocality(body(id), "signal") !== null,
      // Candidates with no relationship to the signal share one floor value; ties at the minimum show it.
      ties_at_min: a.length > 1 ? a.filter((x) => x === Math.min(...a)).length : null,
    };
  };
  const identical = (a: Map<string, number>, b: Map<string, number>) => {
    const common = [...a.keys()].filter((k) => b.has(k));
    return common.length >= 3 ? common.every((k) => a.get(k) === b.get(k)) : null;
  };
  const rho = (a: Map<string, number>, b: Map<string, number>) => {
    const common = [...a.keys()].filter((k) => b.has(k));
    return spearman(common.map((k) => a.get(k)!), common.map((k) => b.get(k)!));
  };
  const verdict = (ds: (number | null)[], tol: number) => {
    const m = ds.filter((d): d is number => d !== null);
    return m.length ? m.every((d) => d < tol) : null; // null: nothing measured
  };

  // G1
  const control = affs("g1_control_no_signal");
  const row = (k: string) => affs(`g1_row_${k}`);
  const symPairs: [string, string][] = [["liquid_death", "olipop"], ["liquid_death", "poppi"], ["olipop", "poppi"]];
  const symDiffs = symPairs.map(([a, b]) => {
    const ab = row(a).get(ids[b] ?? "");
    const ba = row(b).get(ids[a] ?? "");
    return ab === undefined || ba === undefined ? null : Math.abs(ab - ba);
  });
  const inv = affs("g1_invariance_liquid_death");
  const invDiffs = ["olipop", "poppi", "celsius"].map((k) => {
    const full = row("liquid_death").get(ids[k] ?? "");
    const sub = inv.get(ids[k] ?? "");
    return full === undefined || sub === undefined ? null : Math.abs(full - sub);
  });
  out.G1 = {
    rows: Object.fromEntries(["g1_control_no_signal", "g1_row_liquid_death", "g1_row_olipop", "g1_row_poppi",
      "g1_invariance_liquid_death", "g1_tag_row", "g1_audience_row"].map((id) => [id, rowStats(id)])),
    symmetry_abs_diffs: symDiffs.map((d) => (d === null ? null : round(d, 9))),
    pairs_measured: symDiffs.filter((d) => d !== null).length,
    pair_symmetric_exact: verdict(symDiffs, 1e-9),
    pair_symmetric_1e3: verdict(symDiffs, 1e-3),
    invariance_abs_diffs: invDiffs.map((d) => (d === null ? null : round(d, 9))),
    invariance_measured: invDiffs.filter((d) => d !== null).length,
    candidate_set_invariant_exact: verdict(invDiffs, 1e-9),
    candidate_set_invariant_1e3: verdict(invDiffs, 1e-3),
  };

  // Every context row over C against the no-signal control, and against each other. g2_query and
  // g2_uuid name the same locality, so their agreement is reported separately, not as an ignored signal.
  const ctx = ["g1_tag_row", "g1_audience_row", "g2_query", "g2_uuid", "g2_polygon", "g2_point", "g4_age_only"];
  const pairs: Record<string, { identical: boolean | null; spearman: number | null }> = {};
  ctx.forEach((a, i) => {
    for (const b of ctx.slice(i + 1)) {
      if (a === "g2_query" && b === "g2_uuid") continue;
      pairs[`${a}~${b}`] = { identical: identical(affs(a), affs(b)), spearman: rho(affs(a), affs(b)) };
    }
  });
  out.context_rows = {
    control_status: status("g1_control_no_signal"),
    vs_control: Object.fromEntries(ctx.map((id) => [id, { identical: identical(affs(id), control), spearman: rho(affs(id), control) }])),
    pairs,
  };

  // G2, G3, G4
  const qEcho = echoedLocality(body("g2_query"), "signal");
  out.G2 = {
    rows: Object.fromEntries(["g2_query", "g2_uuid", "g2_polygon", "g2_point"].map((id) => [id, { ...rowStats(id), echo: localityEcho(body(id)) }])),
    query_vs_uuid: {
      same_locality: qEcho && ids.nashville ? qEcho === ids.nashville : null,
      vectors_identical: identical(affs("g2_query"), affs("g2_uuid")),
      nashville_source: derived.nashville_source,
    },
  };
  out.G3 = {
    nashville: rowStats("g3_person_nashville"), austin: rowStats("g3_person_austin"),
    metros_identical: identical(affs("g3_person_nashville"), affs("g3_person_austin")),
    metros_spearman: rho(affs("g3_person_nashville"), affs("g3_person_austin")),
  };
  out.G4 = rowStats("g4_age_only");

  // G5
  const d1 = entities(body("g5_dest_us_p1"));
  const d2 = entities(body("g5_dest_us_p2"));
  const ids1 = new Set(d1.map((e) => e?.entity_id));
  const both = [...d1, ...d2];
  const rankAff = affs("g5_dest_rank");
  out.G5 = {
    seed: derived.g5_seed,
    statuses: { p1: status("g5_dest_us_p1"), rank: status("g5_dest_rank"), p2: status("g5_dest_us_p2") },
    p1: d1.length, p2: d2.length, page_overlap: d2.filter((e) => ids1.has(e?.entity_id)).length,
    country_codes: histogram(both.map((e) => String(e?.properties?.geocode?.country_code ?? "none"))),
    all_us: both.length ? both.every((e) => e?.properties?.geocode?.country_code === "US") : null,
    rank_requested: sent.g5_dest_rank ? requested("g5_dest_rank") : null, rank_scored: rankAff.size,
    named_metros_requested: ["nashville_destination", "austin_destination"].filter((k) => ids[k] && listParam(sent.g5_dest_rank, "filter.results.entities").includes(ids[k]!)).length,
    named_metros_scored: ["nashville_destination", "austin_destination"].filter((k) => ids[k] && rankAff.has(ids[k]!)).length,
    has_geocode: d1.some((e) => isObj(e?.properties?.geocode)), has_location: d1.some((e) => isObj(e?.location)),
  };

  // G6
  const heat = (id: string) => (Array.isArray(body(id)?.results?.heatmap) ? body(id).results.heatmap : []) as any[];
  const gh = (c: any) => String(c?.location?.geohash ?? "");
  const heatStats = (id: string) => {
    const cells = heat(id);
    const pairsAP = cells
      .map((c): [number, number] => [Number(c?.query?.affinity), Number(c?.query?.popularity)])
      .filter(([a, p]) => Number.isFinite(a) && Number.isFinite(p));
    return {
      status: status(id), cells: cells.length, bytes: results[id]?.bytes ?? 0, ms: results[id]?.ms ?? 0,
      geohash_lengths: histogram(cells.map((c) => gh(c).length)),
      zero_affinity_share: cells.length ? round(cells.filter((c) => Number(c?.query?.affinity) === 0).length / cells.length) : null,
      spearman_affinity_popularity: spearman(pairsAP.map((x) => x[0]), pairsAP.map((x) => x[1])),
      cell_keys: uniq(cells.flatMap((c) => Object.keys(c ?? {}))), cell_query_keys: uniq(cells.flatMap((c) => Object.keys(c?.query ?? {}))),
      echo: localityEcho(body(id)),
    };
  };
  // The join S6 actually performs: both maps re-keyed to the shortest common geohash prefix (D18),
  // zero-affinity cells excluded. The exact-string share is kept for comparison.
  const join = (a: string, b: string) => {
    const A = heat(a);
    const B = heat(b);
    if (!A.length || !B.length) return null;
    const nz = (cells: any[]) => cells.filter((c) => gh(c).length > 0 && Number(c?.query?.affinity) > 0);
    const lens = [...A, ...B].map((c) => gh(c).length).filter((n) => n > 0);
    const L = Math.min(...lens);
    const bExact = new Set(B.map(gh));
    const aPre = new Set(nz(A).map((c) => gh(c).slice(0, L)));
    const bPre = new Set(nz(B).map((c) => gh(c).slice(0, L)));
    const joined = [...aPre].filter((p) => bPre.has(p)).length;
    return {
      exact_share: round(A.filter((c) => bExact.has(gh(c))).length / A.length),
      prefix_length: L, share_cells_at_prefix_length: round(lens.filter((n) => n === L).length / lens.length),
      nonzero_concept_cells: nz(A).length, concept_prefixes: aPre.size, joined_prefixes: joined,
      prefix_coverage: aPre.size ? round(joined / aPre.size) : null,
    };
  };
  out.G6 = {
    nashville_concept: heatStats("g6_nashville_concept"), nashville_baseline: heatStats("g6_nashville_baseline"),
    austin_concept: heatStats("g6_austin_concept"), austin_baseline: heatStats("g6_austin_baseline"),
    nashville_join: join("g6_nashville_concept", "g6_nashville_baseline"),
    austin_join: join("g6_austin_concept", "g6_austin_baseline"),
    concept_tags_source: derived.concept_tags_source, austin_source: derived.austin_source,
  };

  // G7: compare each price field between the concept and baseline maps on shared cells. A count that
  // is identical under both signals is a venue count independent of the concept (a supply measure).
  const fields = (c: any): Record<string, any> => ({ ...(isObj(c) ? c : {}), ...(isObj(c?.query) ? c.query : {}) });
  const priceKeys = (id: string) => uniq(heat(id).flatMap((c) => Object.keys(fields(c)).filter((k) => /price/i.test(k))));
  const baseByGh = new Map(heat("g7_baseline_price_level").filter((c) => gh(c)).map((c) => [gh(c), fields(c)]));
  const shared = heat("g7_concept_price_level").filter((c) => gh(c) && baseByGh.has(gh(c)));
  const keys = uniq([...priceKeys("g7_concept_price_level"), ...priceKeys("g7_baseline_price_level")]);
  const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  out.G7 = {
    statuses: [status("g7_concept_price_level"), status("g7_baseline_price_level")],
    cells: [heat("g7_concept_price_level").length, heat("g7_baseline_price_level").length],
    price_keys_concept: priceKeys("g7_concept_price_level"), price_keys_baseline: priceKeys("g7_baseline_price_level"),
    shared_cells: shared.length,
    per_key: Object.fromEntries(keys.map((k) => {
      const pairsK = shared.map((c) => [fields(c)[k], baseByGh.get(gh(c))?.[k]]).filter(([a, b]) => a != null && b != null);
      const num = pairsK.filter(([a, b]) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)));
      return [k, {
        compared_cells: pairsK.length,
        identical_share: pairsK.length ? round(pairsK.filter(([a, b]) => same(a, b)).length / pairsK.length) : null,
        nonzero_share: num.length ? round(num.filter(([a, b]) => Number(a) > 0 || Number(b) > 0).length / num.length) : null,
        value_type: pairsK[0] ? typeof pairsK[0][0] : null,
      }];
    })),
  };

  // G8: namespaces kept to 4 segments so genre:place and genre:music stay apart, plus BLOCK families.
  const tagRows = (id: string) => (Array.isArray(body(id)?.results?.tags) ? body(id).results.tags : []) as any[];
  const tagId = (t: any) => String(t?.tag_id ?? t?.id ?? "");
  const tagType = (t: any) => String(t?.subtype ?? t?.type ?? (Array.isArray(t?.types) ? t.types[0] : "") ?? "");
  const ns = (t: any) => (tagId(t) || tagType(t)).split(":").slice(0, 4).join(":");
  const family = (t: any) => {
    const n = `${ns(t)}:`;
    if (/:customer_identity:/.test(n)) return "WHO";
    if (/:ambience:/.test(n)) return "VIBE";
    if (/:genre:place:|:category:place:|:specialty_dish:/.test(n)) return "WHAT";
    if (/:genre:(music|qloo):/.test(n) || (Array.isArray(t?.types) && t.types.includes("urn:entity:artist"))) return "SOUND";
    return "other";
  };
  const order = (id: string) => tagRows(id).map(tagId);
  const g8 = (id: string) => {
    const fam = histogram(tagRows(id).map(family));
    return {
      status: status(id), tags: tagRows(id).length,
      namespaces: histogram(tagRows(id).map(ns)), families: fam,
      families_present: { WHO: !!fam.WHO, VIBE: !!fam.VIBE, WHAT: !!fam.WHAT, SOUND: !!fam.SOUND },
      tag_keys: uniq(tagRows(id).flatMap((t) => Object.keys(t ?? {}))), echo: localityEcho(body(id)),
    };
  };
  const pointOrder = order("g8_point");
  const radiusOrder = order("g8_point_radius_600");
  const who = tagRows("g8_polygon_who");
  out.G8 = {
    point: g8("g8_point"), point_radius_600: g8("g8_point_radius_600"), polygon: g8("g8_polygon"), polygon_who: g8("g8_polygon_who"),
    radius_changes_result: pointOrder.length && radiusOrder.length ? pointOrder.join("|") !== radiusOrder.join("|") : null,
    point_radius_jaccard: jaccard(pointOrder, radiusOrder),
    point_polygon_jaccard: jaccard(pointOrder, order("g8_polygon")),
    who_filter_share: who.length ? round(who.filter((t) => family(t) === "WHO").length / who.length) : null,
  };

  // G9
  const g9 = entities(body("g9_local_brands"));
  out.G9 = {
    status: status("g9_local_brands"), brands: g9.length,
    all_popularity_le_cap: g9.length ? g9.every((e) => Number(e?.popularity) <= 0.9) : null,
  };

  // G10: did filter.tags and filter.location take effect?
  const pl1 = entities(body("g10_places_p1")).length ? entities(body("g10_places_p1")) : entities(body("g10_places_p1_signal"));
  const pl2 = entities(body("g10_places_p2"));
  const pl1ids = new Set(pl1.map((e) => e?.entity_id));
  const inAustin = (e: any) => {
    const lat = Number(e?.location?.lat ?? e?.location?.latitude);
    const lon = Number(e?.location?.lon ?? e?.location?.longitude);
    return lat >= AUSTIN_BBOX.minLat && lat <= AUSTIN_BBOX.maxLat && lon >= AUSTIN_BBOX.minLon && lon <= AUSTIN_BBOX.maxLon;
  };
  out.G10 = {
    statuses: { p1: status("g10_places_p1"), p1_signal: status("g10_places_p1_signal"), p2: status("g10_places_p2") },
    filter_only_rejected: status("g10_places_p1") === 400,
    p1: pl1.length, p2: pl2.length, page_overlap: pl2.filter((e) => pl1ids.has(e?.entity_id)).length,
    tag_honoured_share: pl1.length ? round(pl1.filter((e) => JSON.stringify(e?.tags ?? []).includes(CAFE_TAG)).length / pl1.length) : null,
    in_austin_share: pl1.length ? round(pl1.filter(inAustin).length / pl1.length) : null,
    property_keys: uniq(pl1.flatMap((e) => Object.keys(e?.properties ?? {}))).slice(0, 40),
  };

  // G11
  out.G11 = Object.fromEntries(Object.keys(results).filter((k) => k.startsWith("g11_")).map((id) => {
    const b = body(id);
    const pts = (Array.isArray(b?.results?.trending) ? b.results.trending : findArray(b, (x) => isObj(x) && "date" in x) ?? []) as any[];
    const dates = pts.map((p) => String(p?.date)).sort();
    const pct = pts.map((p) => Number(p?.population_percentile)).filter(Number.isFinite);
    return [id, {
      status: status(id), points: pts.length, truncated_at_take: pts.length === 50,
      first: dates[0] ?? null, last: dates[dates.length - 1] ?? null,
      newest_first: pts.length > 1 ? String(pts[0]?.date) > String(pts[pts.length - 1]?.date) : null,
      // Series are step-shaped (values carried forward between updates), so a run of equal points is
      // not a placeholder by itself; a placeholder has (almost) no distinct values across the window.
      longest_flat_run: longestFlatRun(pts), distinct_percentiles: new Set(pct).size,
      percentile_max_le_1: pct.length ? Math.max(...pct) <= 1 : null,
      percentile_stdev: pct.length > 1 ? round(stdev(pct)) : null,
      rank_is_string: pts.some((p) => typeof p?.population_rank === "string"),
      point_keys: uniq(pts.flatMap((p) => Object.keys(p ?? {}))),
    }];
  }));

  // G12: requested vs returned blocks, and where the missing ones sit (positions only, never IDs).
  out.G12 = Object.fromEntries(["g12_demographics_20", "g12_demographics_30"].map((id) => {
    const b = body(id);
    const blocks = (Array.isArray(b?.results?.demographics) ? b.results.demographics
      : findArray(b, (x) => isObj(x) && "entity_id" in x && isObj(x.query)) ?? []) as any[];
    const req = listParam(sent[id], "signal.interests.entities").map((s) => s.toLowerCase());
    const got = new Set(blocks.map((x) => String(x?.entity_id ?? "").toLowerCase()));
    const missing = req.map((x, i) => (got.has(x) ? -1 : i)).filter((i) => i >= 0);
    return [id, {
      status: status(id), requested: req.length, take_sent: sent[id] ? "take" in sent[id] : null, blocks: blocks.length,
      missing: missing.length, missing_idx: missing,
      tail_truncated: missing.length > 0 && missing.every((i, k) => i === req.length - missing.length + k),
      age_keys: uniq(blocks.flatMap((x) => Object.keys(x?.query?.age ?? {}))),
      gender_keys: uniq(blocks.flatMap((x) => Object.keys(x?.query?.gender ?? {}))),
      error: status(id) !== null && status(id) !== 200 ? errorText(b) : null,
    }];
  }));

  // G13: tag ids only (not type/subtype strings) from compare, against the /search tags of both brands.
  const cmp = body("g13_compare");
  const searchTags = (k: string) => {
    const hit = (body(`s_${k}`)?.results ?? []).find((e: any) => e?.entity_id === ids[k]);
    return (hit?.tags ?? []).map((t: any) => tagId(t)).filter((t: string) => t.startsWith("urn:tag:"));
  };
  const cmpTags = uniq(tagIdsDeep(cmp));
  const srch = uniq([...searchTags("olipop"), ...searchTags("poppi")]);
  const len = (x: any) => (Array.isArray(x) ? x.length : isObj(x) ? Object.keys(x).length : null);
  out.G13 = {
    status: status("g13_compare"), top_keys: Object.keys(cmp ?? {}), results_keys: Object.keys(cmp?.results ?? {}),
    sizes: { tags: len(cmp?.results?.tags), a: len(cmp?.results?.a), b: len(cmp?.results?.b) },
    compare_tags: cmpTags.length, search_tags: srch.length,
    search_tags_in_compare: srch.filter((t: string) => cmpTags.includes(t)).length,
    compare_namespaces: histogram(cmpTags.map((t) => t.split(":").slice(0, 4).join(":"))),
    search_namespaces: histogram(srch.map((t: string) => t.split(":").slice(0, 4).join(":"))),
  };

  // G15: explainability shares, including results attributed to one seed only (entries ≥0.1 are listed).
  const xd = entities(body("g15_explainability"));
  const shares = xd.map((e) => {
    const list = e?.query?.explainability?.["signal.interests.entities"];
    return Array.isArray(list) ? list.map((s: any) => Number(s?.score)).filter(Number.isFinite) : [];
  });
  const listed = shares.filter((s) => s.length > 0);
  const twoSeed = shares.filter((s) => s.length === 2);
  out.G15 = {
    status: status("g15_explainability"), results: xd.length, with_explainability: listed.length,
    entries: histogram(shares.map((s) => s.length)),
    mean_max_share: listed.length ? round(mean(listed.map((s) => Math.max(...s)))) : null,
    dominated_share: listed.length ? round(listed.filter((s) => Math.max(...s) >= 0.6).length / listed.length) : null,
    near_uniform_share: twoSeed.length ? round(twoSeed.filter(([x = 0, y = 0]) => Math.abs(x - y) < 0.1).length / twoSeed.length) : null,
    top_level_explainability: isObj(body("g15_explainability")?.query?.explainability),
  };

  return out;
}

// ---------------------------------------------------------------------------------------------
// Helpers.

function pickTag(body: any, c: Category): { tag: string | null; name: string | null; parent_checked: boolean; candidates: number } {
  const tags = (Array.isArray(body?.results?.tags) ? body.results.tags : []) as any[];
  const parentTypes = (t: any): string[] => (Array.isArray(t?.parents) ? t.parents : [])
    .map((p: any) => (typeof p === "string" ? p : p?.type)).filter((x: unknown): x is string => typeof x === "string");
  const ok = tags.filter((t) => {
    const id = String(t?.id ?? t?.tag_id ?? "");
    const hay = `${String(t?.name ?? "").toLowerCase()} ${id}`;
    const parents = parentTypes(t);
    return id.startsWith("urn:tag:") && (parents.length === 0 || parents.includes(c.parent)) &&
      c.must.every((re) => re.test(hay)) && !(c.reject && c.reject.test(hay));
  });
  const preferred = c.prefer ? ok.find((t) => c.prefer!.test(`${String(t?.name ?? "").toLowerCase()} ${String(t?.id ?? t?.tag_id ?? "")}`)) : undefined;
  const hit = preferred ?? ok[0];
  return {
    tag: hit ? String(hit.id ?? hit.tag_id) : null,
    name: hit ? String(hit.name ?? "") : null,
    parent_checked: hit ? parentTypes(hit).length > 0 : false,
    candidates: tags.length,
  };
}

function pickDestinations(list: any[]): string[] {
  const picked: string[] = [];
  for (const k of ["nashville_destination", "austin_destination"]) if (ids[k]) picked.push(ids[k]!);
  const wanted = [/^nashville\b/i, /^austin\b/i, /^new york\b/i, /^los angeles\b/i, /^chicago\b/i];
  for (const re of wanted) {
    const hit = list.find((e) => re.test(String(e?.name ?? "")) && typeof e?.entity_id === "string");
    if (hit && !picked.includes(hit.entity_id) && picked.length < 5) picked.push(hit.entity_id);
  }
  for (const e of list) {
    if (picked.length >= 5) break;
    if (typeof e?.entity_id === "string" && !picked.includes(e.entity_id)) picked.push(e.entity_id);
  }
  return picked;
}

function echoedLocality(body: any, side: "signal" | "filter"): string | null {
  const loc = body?.query?.localities?.[side];
  const first = Array.isArray(loc) ? loc[0] : loc;
  return typeof first?.entity_id === "string" ? first.entity_id : null;
}

function localityEcho(body: any): Record<string, string[]> | null {
  const loc = body?.query?.localities;
  if (!isObj(loc)) return null;
  return Object.fromEntries(Object.entries(loc).map(([k, v]) => [k, Object.keys((Array.isArray(v) ? v[0] : v) ?? {})]));
}

function entities(body: any): any[] {
  return Array.isArray(body?.results?.entities) ? body.results.entities : [];
}

function affinityMap(body: any): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entities(body)) {
    const a = Number(e?.query?.affinity);
    if (typeof e?.entity_id === "string" && Number.isFinite(a)) m.set(e.entity_id, a);
  }
  return m;
}

function listParam(p: Params | undefined, key: string): string[] {
  const v = p?.[key];
  return typeof v === "string" && v ? v.split(",") : [];
}

function hasType(e: any, type: string): boolean {
  return (Array.isArray(e?.types) && e.types.includes(type)) || e?.subtype === type || e?.type === type;
}

function rows(body: any): number | null {
  const arr = findArray(body?.results ?? body, () => true);
  return arr ? arr.length : null;
}

// First non-empty array whose first item satisfies pred; an empty array only if nothing else matches.
function findArray(node: any, pred: (x: any) => boolean): any[] | null {
  let firstEmpty: any[] | null = null;
  const walk = (n: any, depth: number): any[] | null => {
    if (depth > 4 || n == null) return null;
    if (Array.isArray(n)) {
      if (n.length === 0) {
        firstEmpty = firstEmpty ?? n;
        return null;
      }
      return pred(n[0]) ? n : null;
    }
    if (!isObj(n)) return null;
    for (const v of Object.values(n)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node, 0) ?? firstEmpty;
}

function deepStrings(node: any, re: RegExp, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || node == null) return acc;
  if (typeof node === "string") {
    if (re.test(node)) acc.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) deepStrings(v, re, acc, depth + 1);
  } else if (isObj(node)) {
    for (const v of Object.values(node)) deepStrings(v, re, acc, depth + 1);
  }
  return acc;
}

// Tag ids only: values of tag_id / id that are tag URNs, never type or subtype strings.
function tagIdsDeep(node: any, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || node == null) return acc;
  if (Array.isArray(node)) {
    for (const v of node) tagIdsDeep(v, acc, depth + 1);
  } else if (isObj(node)) {
    const id = node.tag_id ?? node.id;
    if (typeof id === "string" && id.startsWith("urn:tag:")) acc.push(id);
    for (const v of Object.values(node)) tagIdsDeep(v, acc, depth + 1);
  }
  return acc;
}

// Shape of a response with no values: key names and types, arrays as [length, shape of item 0].
function shapeOf(node: any, depth = 0): any {
  if (node === null) return "null";
  if (Array.isArray(node)) return node.length ? [`len ${node.length}`, depth > 6 ? "…" : shapeOf(node[0], depth + 1)] : ["len 0"];
  if (isObj(node)) {
    if (depth > 6) return "{…}";
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [UUID_RE.test(k) ? "<uuid>" : k, shapeOf(v, depth + 1)]));
  }
  return typeof node;
}

function longestFlatRun(pts: any[]): number {
  let longest = pts.length ? 1 : 0;
  let streak = 1;
  for (let i = 1; i < pts.length; i++) {
    const same = pts[i]?.population_percentile === pts[i - 1]?.population_percentile &&
      String(pts[i]?.population_rank) === String(pts[i - 1]?.population_rank);
    streak = same ? streak + 1 : 1;
    longest = Math.max(longest, streak);
  }
  return longest;
}

function errorText(body: any): string | null {
  if (!isObj(body)) return null;
  const e = body.error ?? body.message ?? body.errors ?? body.error_msg ?? null;
  const s = typeof e === "string" ? e : e ? JSON.stringify(e) : null;
  return s ? s.replace(UUID_RE_G, "<uuid>").slice(0, 300) : null;
}

function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim()
    .replace(/^the /, "").replace(/ (inc|co|company|llc|ltd|the)$/, "");
}

function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length).fill(0);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    for (let k = i; k <= j; k++) r[order[k]!.i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3 || ![...a, ...b].every(Number.isFinite)) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  ra.forEach((x, i) => {
    const y = rb[i]!;
    num += (x - ma) * (y - mb);
    da += (x - ma) ** 2;
    db += (y - mb) ** 2;
  });
  return da && db ? round(num / Math.sqrt(da * db)) : null;
}

function jaccard(a: string[], b: string[]): number | null {
  if (!a.length || !b.length) return null;
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return round(inter / (sa.size + sb.size - inter));
}

function histogram(xs: (string | number)[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) h[String(x)] = (h[String(x)] ?? 0) + 1;
  return h;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const enc = (v: string) => encodeURIComponent(v).replace(/%2C/gi, ",").replace(/%3A/gi, ":");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function fail(msg: string): never {
  console.error(`probe: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------

await main();

if (DRY) {
  console.log(plan.join("\n"));
  const count = (k: Kind) => plan.filter((p) => p.startsWith(k)).length;
  console.log(`\nplanned: ${count("gate")} gate calls (cap ${CAPS.gate}), ${count("sweep")} sweep calls (cap ${CAPS.sweep})`);
  process.exit(0);
}

let gates: Record<string, unknown> = {};
let analysisError: string | null = null;
try {
  gates = analyse();
} catch (e) {
  analysisError = (e as Error).stack ?? String(e); // raw data is safe in .probe/raw; rerun replays it
}
const summary = {
  probe: "culture-terminal gating probe", ran_at: new Date().toISOString(),
  calls: { fresh, cumulative: { gate: ledger.gate, sweep: ledger.sweep }, caps: CAPS },
  month_remaining: { first_seen: firstMonthRemaining, last_seen: ledger.month_remaining },
  halted, denied_types: [...denied], analysis_error: analysisError,
  resolution: Object.fromEntries(SWEEP.map((s) => [s.key, derived[`sweep_${s.key}`] ?? null])),
  derived, gates,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
writeFileSync(join(OUT, "pins.json"), JSON.stringify({ entities: pins, localities: { nashville: ids.nashville, austin: ids.austin } }, null, 1));
writeFileSync(join(OUT, "shapes.json"), JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { status: r.status, shape: shapeOf(r.body) }])), null, 1));
console.log(`\nfresh calls this run: gate ${fresh.gate}, sweep ${fresh.sweep}; cumulative gate ${ledger.gate}/${CAPS.gate}, sweep ${ledger.sweep}/${CAPS.sweep}; halted: ${halted ?? "no"}`);
if (analysisError) console.log(`analysis failed (raw responses are intact; fix and rerun at zero quota): ${analysisError.split("\n")[0]}`);
console.log(`wrote ${OUT}/summary.json, ${OUT}/pins.json, ${OUT}/shapes.json (all gitignored)`);
