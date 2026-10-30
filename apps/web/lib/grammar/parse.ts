import type { EntityType, Job, Pillar } from "@ct/contracts";
import { ENTITY_TYPE_VALUES, JOB_MNEMONIC, JOB_PILLAR } from "@ct/contracts/values";

/**
 * The command grammar (PLAN §8.2): mnemonics are accelerators for natural language, compiled here in
 * the browser so the Ask page shows "Compiled to …" the moment they are typed. The preview (CLERK)
 * still reads the question and confirms the job and the names; nothing here is sent to the server.
 *
 *   <NAME> HLTH            brand health          <ARTIST> SPON          sponsor fit
 *   <A> VS <B>             two brands            <NAME> MKTS            launch and tour cities
 *   <AREA>, <CITY> DNA     a neighbourhood       <NAME> AUD             who the audience is
 *   <AREA>, <CITY> TEN     tenants for a block   <CONCEPT> SITE <CITY>  where to open
 *   <NAME> COLLAB          collaboration partners <NAME> CRTR          creators who fit
 *   <CONCEPT> LNCH         test a new product    <AREA>, <CITY> TWIN <CITY>  an area's twin elsewhere
 *   <A> VS <B> [VS <C> [VS <D>]] CITY [<CONCEPT>]  compare two to four cities
 *
 * The keywords are typed in capitals, VS included, so a sentence that merely ends in "site" or "ten",
 * or compares two things in passing ("How is Juniper Cola doing vs its peers"), is never read as a
 * command. A name may carry its type as in the compiled form ("JUNIPER COLA <BRAND> HLTH"). The whole
 * input must be the command: a question with other words or punctuation is left to CLERK.
 */

export interface CommandName {
  /** As typed, spaces collapsed. */
  text: string;
  /** The type typed after it, or the job's usual type; null when the job takes any type. */
  type: EntityType | null;
}

export interface CompiledCommand {
  job: Job;
  pillar: Pillar;
  /** The compiled command as code prints it (compileMnemonic), e.g. "JUNIPER COLA <BRAND> HLTH". */
  mnemonic: string;
  /** The named entities, primary first; empty for the place jobs. */
  names: CommandName[];
  /** The neighbourhood of DNA, TEN and TWIN (its source). */
  area: string | null;
  /** The city of DNA, TEN and SITE; TWIN's source city. */
  city: string | null;
  /** The concept of SITE and LNCH, or the optional one of CITY. */
  concept: string | null;
  /** TWIN: the city to find the twin in. */
  targetCity?: string | null;
  /** CITY: the two to four cities as typed, in order. */
  cities?: string[];
}

/** Longest name, area, city or concept a command takes. */
const PART_MAX = 80;

/** A name: letters and digits, with the punctuation brand names use; no commas, no question marks. */
const PART = /^[\p{L}\p{N}][\p{L}\p{N} '’&.!+\-]*$/u;

/** The type marker, as the compiled form prints it: "<BRAND>". */
const TYPE_MARKER = /\s*<([A-Za-z_]+)>$/;

/** The usual type of a job's subject, printed when none is typed. */
const DEFAULT_TYPE: Partial<Record<Job, EntityType>> = { brand_health: "brand", sponsorship: "artist", brand_collab: "brand", creator_fit: "brand" };

/** Jobs written as "<NAME> KEYWORD". */
const NAMED_JOBS: ReadonlyArray<{ keyword: string; job: Job }> = [
  { keyword: JOB_MNEMONIC.brand_health, job: "brand_health" },
  { keyword: JOB_MNEMONIC.sponsorship, job: "sponsorship" },
  { keyword: JOB_MNEMONIC.market_selection, job: "market_selection" },
  { keyword: JOB_MNEMONIC.audience_discovery, job: "audience_discovery" },
  { keyword: JOB_MNEMONIC.brand_collab, job: "brand_collab" },
  { keyword: JOB_MNEMONIC.creator_fit, job: "creator_fit" },
];

/** How many cities CITY compares. */
const CITIES_MIN = 2;
const CITIES_MAX = 4;

/** A typed city as code compiles a market id: "Kansas City" → "KANSAS_CITY" (compileMnemonic upper-cases the id). */
const cityId = (city: string) => city.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");

const up = (s: string) => s.toUpperCase();

/** A part of a command, trimmed and with spaces collapsed, or null when it is not a plain name. */
function part(raw: string | undefined): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text !== "" && text.length <= PART_MAX && PART.test(text) ? text : null;
}

/** "Juniper Cola <BRAND>" → name and type; an unknown marker is not a name. */
function nameWithType(raw: string, job: Job): CommandName | null {
  const marker = TYPE_MARKER.exec(raw);
  let type: EntityType | null = DEFAULT_TYPE[job] ?? null;
  let rest = raw;
  if (marker) {
    const named = (marker[1] ?? "").toLowerCase();
    if (!(ENTITY_TYPE_VALUES as readonly string[]).includes(named)) return null;
    type = named as EntityType;
    rest = raw.slice(0, marker.index);
  }
  const text = part(rest);
  return text === null ? null : { text, type };
}

function compiled(job: Job, fields: Omit<CompiledCommand, "job" | "pillar">): CompiledCommand {
  return { job, pillar: JOB_PILLAR[job], ...fields };
}

/** The command the input spells, or null when it is not one (natural language, or a malformed command). */
export function parseCommand(input: string): CompiledCommand | null {
  const text = input.replace(/\s+/g, " ").trim();
  if (text === "" || text.length > 5 * PART_MAX) return null;

  // <A> VS <B> [VS <C> [VS <D>]] CITY [<CONCEPT>]: read before the two-name form, which it contains.
  const cityCompare = parseCityCompare(text);
  if (cityCompare !== undefined) return cityCompare;
  if (text.length > 3 * PART_MAX) return null;

  // <A> VS <B>: exactly two names.
  const sides = text.split(/ VS\.? /);
  if (sides.length === 2) {
    const a = part(sides[0]);
    const b = part(sides[1]);
    if (a === null || b === null) return null;
    return compiled("head_to_head", {
      mnemonic: `${up(a)} VS ${up(b)}`,
      names: [
        { text: a, type: "brand" },
        { text: b, type: "brand" },
      ],
      area: null,
      city: null,
      concept: null,
    });
  }
  if (sides.length > 2) return null;

  // <AREA>, <CITY> TWIN <CITY>
  const twin = /^([^,]+),(.+) TWIN (.+)$/.exec(text);
  if (twin) {
    const area = part(twin[1]);
    const city = part(twin[2]);
    const target = part(twin[3]);
    if (area === null || city === null || target === null) return null;
    return compiled("taste_twins", {
      mnemonic: `${up(area)}, ${up(city)} ${JOB_MNEMONIC.taste_twins} ${up(target)}`,
      names: [],
      area,
      city,
      concept: null,
      targetCity: target,
    });
  }

  // <AREA>, <CITY> DNA | TEN
  const place = /^([^,]+),([^,]+) (DNA|TEN)$/.exec(text);
  if (place) {
    const area = part(place[1]);
    const city = part(place[2]);
    if (area === null || city === null) return null;
    const job: Job = place[3] === JOB_MNEMONIC.area_profile ? "area_profile" : "tenant_mix";
    return compiled(job, {
      mnemonic: `${up(area)}, ${up(city)} ${JOB_MNEMONIC[job]}`,
      names: [],
      area,
      city,
      concept: null,
    });
  }

  // <CONCEPT> SITE <CITY>
  const site = /^(.+) SITE (.+)$/.exec(text);
  if (site) {
    const concept = part(site[1]);
    const city = part(site[2]);
    if (concept === null || city === null) return null;
    return compiled("site_selection", {
      mnemonic: `${up(concept)} SITE ${up(city)}`,
      names: [],
      area: null,
      city,
      concept,
    });
  }

  // <CONCEPT> LNCH
  const launch = new RegExp(`^(.+) ${JOB_MNEMONIC.launch_test}$`).exec(text);
  if (launch) {
    const concept = part(launch[1]);
    if (concept === null) return null;
    return compiled("launch_test", { mnemonic: `${up(concept)} ${JOB_MNEMONIC.launch_test}`, names: [], area: null, city: null, concept });
  }

  // <NAME> HLTH | SPON | MKTS | AUD | COLLAB | CRTR
  for (const { keyword, job } of NAMED_JOBS) {
    if (!text.endsWith(` ${keyword}`)) continue;
    const name = nameWithType(text.slice(0, -keyword.length - 1), job);
    if (name === null) return null;
    const typed = name.type === null ? "" : ` <${up(name.type)}>`;
    return compiled(job, { mnemonic: `${up(name.text)}${typed} ${keyword}`, names: [name], area: null, city: null, concept: null });
  }
  return null;
}

/**
 * The CITY form, or undefined when the input is not one. The keyword is the last " CITY" whose left
 * side splits into two to four cities on VS, so a city typed "KANSAS CITY" stays a city; what follows
 * the keyword is the concept. A CITY form with a malformed part is null (a broken command).
 */
function parseCityCompare(text: string): CompiledCommand | null | undefined {
  const keyword = JOB_MNEMONIC.city_compare;
  const at: number[] = [];
  for (let i = text.indexOf(` ${keyword}`); i >= 0; i = text.indexOf(` ${keyword}`, i + 1)) {
    const after = text.charAt(i + keyword.length + 1);
    if (after === "" || after === " ") at.push(i);
  }
  for (const i of at.reverse()) {
    const sides = text.slice(0, i).split(/ VS\.? /);
    if (sides.length < CITIES_MIN) continue;
    if (sides.length > CITIES_MAX) return null;
    const cities = sides.map(part);
    const rest = text.slice(i + keyword.length + 1).trim();
    const concept = rest === "" ? null : part(rest);
    if (cities.some((c) => c === null) || (rest !== "" && concept === null)) return null;
    const named = cities as string[];
    return compiled("city_compare", {
      mnemonic: `${named.map((c) => up(cityId(c))).join(" VS ")} ${keyword}${concept ? ` ${up(concept)}` : ""}`,
      names: [],
      area: null,
      city: named[0] ?? null,
      concept,
      cities: named,
    });
  }
  return undefined;
}
