import type { BriefSource } from "../../lib/brief";

/**
 * The words of a lookup in the How we know drawer: what it fetched, its endpoint line, how fresh it is,
 * and its request pairs. A lookup is a Qloo request, or a public one (Part 9: SEC EDGAR or US Census; R6:
 * OpenStreetMap via the Overpass API), which names its host and reference instead of a filter and a
 * request id. Qloo parameters carry names where entity ids were (R8): the ids stay on the server. Pure.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "R1 Juniper Cola" → "Juniper Cola"; a ref the run could not name stays out. */
export function refName(ref: string): string | null {
  const name = ref.replace(/^[RT]\d+\s*/, "").trim();
  return name === "" ? null : name;
}

/** "Juniper Cola", "Juniper Cola and Kestrel Tonic", "Juniper Cola and 5 more". */
export function namesText(refs: readonly string[]): string | null {
  const names = [...new Set(refs.map(refName).filter((n): n is string => n !== null))];
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/** "urn:entity:brand" → "brand", "urn:entity:tv_show" → "TV show". */
function typeWord(urn: string | null | undefined): string | null {
  if (!urn) return null;
  const word = urn.replace(/^urn:(?:entity:)?/, "").replace(/_/g, " ");
  return word === "tv show" ? "TV show" : word;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a lookup fetched, in plain words: "Audience data for Juniper Cola and 5 more", "Reported financials for Juniper Cola's company (SEC EDGAR filings)". */
export function sourceDescription(source: Pick<BriefSource, "endpoint" | "filterType" | "refs" | "params">): string {
  const names = namesText(source.refs);
  const param = (name: string) => source.params.find(([k]) => k === name)?.[1] ?? null;
  const forNames = names ? ` for ${names}` : "";
  switch (source.endpoint) {
    case "/files/company_tickers.json":
      return "Listed company lookup in SEC EDGAR";
    case "/api/xbrl/companyfacts":
      return `Reported financials${names ? ` for ${names}'s company` : ""} (SEC EDGAR filings)`;
    case "/data/acs/acs5":
      return `Resident estimates${forNames} (US Census ACS 5-year)`;
    case "/api/interpreter":
      return "Places counted in OpenStreetMap (Overpass API)";
    case "/search": {
      const type = typeWord(param("types")?.split(",")[0] ?? null);
      return type ? `${sentence(type)} names matched in Qloo` : "Names matched in Qloo";
    }
    case "/entities":
      return `Details${forNames}`;
    case "/v2/tags":
      return `Taste tags${forNames}`;
    case "/v2/audiences":
      return "Audience groups in Qloo";
    case "/v2/trending":
      return `Interest over time${forNames}`;
    case "/v2/insights": {
      if (source.filterType === "urn:demographics") return `Age and gender data${forNames}`;
      if (source.filterType === "urn:tag") return `Taste tags${forNames}`;
      if (source.filterType === "urn:heatmap") return `Interest by area${forNames}`;
      return `Audience data${forNames}`;
    }
  }
}

const PUBLIC_NAME = { sec: "SEC EDGAR", census: "US Census Bureau", osm: "OpenStreetMap" } as const;

/** A public lookup: SEC EDGAR, US Census or OpenStreetMap. */
export const isPublicLookup = (source: BriefSource["source"]): source is keyof typeof PUBLIC_NAME =>
  source === "sec" || source === "census" || source === "osm";

/**
 * "/v2/insights · brand · 46 rows"; a public lookup "data.sec.gov/api/xbrl/companyfacts · SEC EDGAR",
 * "overpass-api.de/api/interpreter · OpenStreetMap".
 */
export function sourceLine(source: Pick<BriefSource, "endpoint" | "filterLabel" | "rows" | "source" | "host">): string {
  if (isPublicLookup(source.source)) return [`${source.host ?? ""}${source.endpoint}`, PUBLIC_NAME[source.source]].join(" · ");
  return [source.endpoint, source.filterLabel, source.rows === null ? null : `${source.rows} ${source.rows === 1 ? "row" : "rows"}`].filter(Boolean).join(" · ");
}

/** "9 h", "15 min", "2 days": how old a saved copy is. */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** "23 Oct 12:13" (UTC). */
function fetchedAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Saved copy, 9 h old" (a cache hit, a shared or reused call) or "Fetched live, 23 Oct 12:13". */
export function freshnessText(source: Pick<BriefSource, "cache" | "cacheAgeMs" | "at">): string {
  if (source.cache === "miss") {
    const at = fetchedAt(source.at);
    return at ? `Fetched live, ${at}` : "Fetched live";
  }
  return source.cacheAgeMs !== null ? `Saved copy, ${ageText(source.cacheAgeMs)} old` : "Saved copy";
}

/** Names for the refs a run named, read from its lookups' "R1 Juniper Cola" refs: R1 → "Juniper Cola". */
export function refNames(lookups: Iterable<Pick<BriefSource, "refs">>): Map<string, string> {
  const names = new Map<string, string>();
  for (const lookup of lookups) {
    for (const ref of lookup.refs) {
      const id = /^[RT]\d+\b/.exec(ref)?.[0];
      const name = refName(ref);
      if (id && name && !names.has(id)) names.set(id, name);
    }
  }
  return names;
}

/**
 * A parameter value as the request block shows it: "urn:entity:brand" reads "brand", a ref the run named
 * reads as its name ("R1" reads "Juniper Cola"), and a list gets a space after each comma.
 */
export function paramValue(value: string, names: ReadonlyMap<string, string> = new Map()): string {
  return value
    .replace(/\burn:entity:([a-z_]+)/g, "$1")
    .replace(/\b[RT]\d+\b/g, (ref) => names.get(ref) ?? ref)
    .replace(/,(?=\S)/g, ", ");
}

/**
 * The request block's pairs: the redacted parameters (refs named, entity ids already names), then the
 * short request id, or for a public lookup its reference (a CIK, the Census dataset, vintage and
 * geography, or "osm-<data date>"). Never a key.
 */
export function requestPairs(
  source: Pick<BriefSource, "params" | "shortRequestId" | "requestId" | "source">,
  names?: ReadonlyMap<string, string>,
): [string, string][] {
  const pairs: [string, string][] = source.params.filter(([k]) => !/api[-_]?key|authorization|secret|token|password|^key$/i.test(k)).map(([k, v]) => [k, paramValue(v, names)]);
  const publicSource = isPublicLookup(source.source);
  if (source.requestId) pairs.push([publicSource ? "reference" : "request id", publicSource ? source.requestId : source.shortRequestId]);
  return pairs;
}

/** Counts for the Summary tab: saved copies and live fetches. */
export function freshnessCounts(sources: readonly Pick<BriefSource, "cache">[]): { saved: number; live: number } {
  const live = sources.filter((s) => s.cache === "miss").length;
  return { saved: sources.length - live, live };
}
