import { pick } from "./hash";

/** Invented names for synthetic entities. Any likeness to a real brand, title or person is coincidence. */

const STRIPPED_WORDS = new Set(["inc", "co", "company", "llc", "ltd", "the"]);

/**
 * The resolution gate's normal form (SPEC §5.3 S0): NFKD, lowercase, punctuation stripped,
 * whitespace collapsed, a leading "the" and trailing company suffixes dropped. Entity ids derive
 * from it, so a name searched twice in different spellings resolves to one id.
 */
export function normalizeName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  while (words.length > 1 && words[0] === "the") words.shift();
  while (words.length > 1 && STRIPPED_WORDS.has(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}

export function slug(name: string): string {
  return normalizeName(name).replace(/\s+/g, "_");
}

/** Title-cases an all-lowercase query ("brand alpha" → "Brand Alpha"); other casing is kept as typed. */
export function displayName(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed.replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toUpperCase());
}

const BRAND_STEMS = [
  "Alder", "Brightwater", "Cinder", "Driftwood", "Ember", "Foxglove", "Granite", "Harbor",
  "Ironleaf", "Juniper", "Kettle", "Lantern", "Meadow", "Northstar", "Oakline", "Pinecone",
  "Quarry", "Redtail", "Saltmarsh", "Timber", "Upland", "Valley", "Wildroot", "Yellowfin",
];
/** Stems only `nameForId` uses, so an invented name never repeats a universe brand's. */
const SPARE_BRAND_STEMS = ["Ashgrove", "Bramblecrest", "Cobbleford", "Dewhollow", "Elmbrook", "Fallowmere", "Glenmarsh", "Hazelton"];

/** Brand families: the invented genre:brand leaves (`urn:tag:genre:brand:mock_<family>`). */
export const BRAND_FAMILIES = ["beverages", "apparel", "snacks", "outdoor", "beauty"] as const;
export type BrandFamily = (typeof BRAND_FAMILIES)[number];

const BRAND_ENDINGS: Readonly<Record<BrandFamily, readonly string[]>> = {
  beverages: ["Cola", "Seltzer", "Cold Brew", "Cider"],
  apparel: ["Outfitters", "Denim", "Threads", "Wear"],
  snacks: ["Crisps", "Bakery", "Bites", "Pretzels"],
  outdoor: ["Gear", "Trailworks", "Expedition", "Packs"],
  beauty: ["Botanics", "Skin", "Apothecary", "Glow"],
};

/** Brand i of the universe: every (stem, family, ending) triple is distinct for i < 480. */
export function brandName(i: number): { name: string; family: BrandFamily } {
  const stem = BRAND_STEMS[i % BRAND_STEMS.length] ?? "Alder";
  const family = BRAND_FAMILIES[Math.floor(i / BRAND_STEMS.length) % BRAND_FAMILIES.length] ?? "beverages";
  const endings = BRAND_ENDINGS[family];
  const ending = endings[Math.floor(i / (BRAND_STEMS.length * BRAND_FAMILIES.length)) % endings.length] ?? "";
  return { name: `${stem} ${ending}`, family };
}

/**
 * Two word lists whose product names one entity type. `spare` first words never appear in the
 * universe, so a name invented for an unknown id cannot repeat a universe entity's name.
 */
interface NamePlan {
  first: readonly string[];
  spare: readonly string[];
  second: readonly string[];
  join: (a: string, b: string) => string;
}

const PLANS: Readonly<Record<string, NamePlan>> = {
  "urn:entity:artist": {
    first: ["Nova", "Juno", "Atlas", "Wren", "Sable", "Indigo", "Lyric", "Echo", "Velvet", "Cobalt", "Marigold", "Neon", "Paper", "Static", "Golden", "Hollow"],
    spare: ["Amber", "Delta", "Fable", "Garnet", "Halcyon", "Kestrel"],
    second: ["Vale", "Rivers", "and the Tides", "Parade", "Lights", "Hearts", "Choir", "Machine", "Coast", "Season"],
    join: (a, b) => `${a} ${b}`,
  },
  "urn:entity:podcast": {
    first: ["Curious", "Midnight", "Weekly", "Honest", "Backyard", "Big Picture", "Slow", "Signal", "Open Road", "Kitchen Table", "Deep Cut", "Side Quest", "Long Game", "Fresh Take", "Quiet"],
    spare: ["Restless", "Sunday", "Uncharted", "Plainspoken", "Front Porch", "Daily Draft"],
    second: ["Hour", "Report", "Podcast", "Show", "Dispatch", "Sessions", "Roundtable", "Conversations"],
    join: (a, b) => `The ${a} ${b}`,
  },
  "urn:entity:tv_show": {
    first: ["Harbor", "Cinder", "Lone Pine", "Copper", "Sunset", "Granite", "Bayou", "Northern", "Silver", "Prairie", "Neon", "Ridge", "Coastal", "Desert", "Glass"],
    spare: ["Juniper", "Timberline", "Redwood", "Saltwater", "Ironwood", "Highland"],
    second: ["Heights", "County", "Division", "Files", "Ranch", "Kitchen", "Station", "Lane"],
    join: (a, b) => `${a} ${b}`,
  },
  "urn:entity:movie": {
    first: ["Midnight", "Paper", "Silver", "Last", "Hidden", "Electric", "Broken", "Golden", "Distant", "Burning", "Quiet", "Wild", "Iron", "Crimson", "Glass"],
    spare: ["Scarlet", "Fading", "Restless", "Velvet", "Northern", "Hollow"],
    second: ["Run", "Horizon", "Letters", "Season", "Signal", "Harbor", "Summer", "Garden"],
    join: (a, b) => `${a} ${b}`,
  },
  "urn:entity:person": {
    first: ["Avery", "Blake", "Casey", "Dana", "Emery", "Finley", "Harper", "Jules", "Kendall", "Logan", "Morgan", "Quinn", "Reese", "Rowan", "Sawyer"],
    spare: ["Ellis", "Hayden", "Marlowe", "Peyton", "Sutton", "Tatum"],
    second: ["Ashford", "Bellamy", "Calloway", "Delacroix", "Ellison", "Fairbanks", "Hargrove", "Kingsley"],
    join: (a, b) => `${a} ${b}`,
  },
  "urn:entity:destination": {
    first: ["Alder", "Bramble", "Cedar", "Copper", "Elk", "Fern", "Glen", "Heron", "Iron", "Lark", "Maple", "Moss", "Otter", "Pine", "Quail", "Raven", "Sage", "Silver", "Stone", "Thistle", "Willow", "Wolf"],
    spare: ["Ashby", "Birch", "Clover", "Dove", "Falcon", "Hazel"],
    second: [" Springs", " Bay", "port", " Falls", " Ridge", "ton", " Harbor", " Hollow", " Lake", "field", " Mesa", " Point", " Valley", "wood"],
    join: (a, b) => `${a}${b}`,
  },
  "urn:entity:place": {
    first: ["Alder", "Bluebird", "Copperline", "Dovetail", "Elm Street", "Firefly", "Greenhouse", "Hightide", "Ivy", "Jackrabbit", "Kingfisher", "Lucky", "Moonlight", "Nightjar", "Orchard", "Porchlight", "Railyard", "Starling", "Tumbleweed", "Wren"],
    spare: ["Amberline", "Cottonwood", "Dandelion", "Goldleaf", "Hummingbird", "Lamplighter"],
    // Kind-neutral words, so a name never contradicts the venue's category tag.
    second: ["Social", "Hall", "Room", "House", "Collective", "Corner", "Commons", "Yard", "Exchange", "Depot"],
    join: (a, b) => `${a} ${b}`,
  },
};

/** How many distinct names `universeName` yields for a type. */
export function nameCapacity(type: string): number {
  const plan = PLANS[type];
  return plan ? plan.first.length * plan.second.length : 0;
}

/** Name i of a type's universe; distinct for i below nameCapacity(type). */
export function universeName(type: string, i: number): string {
  const plan = PLANS[type];
  if (!plan) return `Mock Entity ${i + 1}`;
  const a = plan.first[i % plan.first.length] ?? "";
  const b = plan.second[Math.floor(i / plan.first.length) % plan.second.length] ?? "";
  return plan.join(a, b);
}

/**
 * A plausible invented name for an id outside the universes: a fixture id, or a mock id whose
 * searched name this process never saw. It is drawn from spare words, so it never repeats a
 * universe entity's name.
 */
export function nameForId(type: string, id: string): string {
  if (type === "urn:entity:brand") {
    const family = pick(BRAND_FAMILIES, "family", id);
    return `${pick(SPARE_BRAND_STEMS, "stem", id)} ${pick(BRAND_ENDINGS[family], "ending", id)}`;
  }
  const plan = PLANS[type];
  if (!plan) return `Mock Entity ${id.slice(-4)}`;
  return plan.join(pick(plan.spare, "first", id), pick(plan.second, "second", id));
}

export const STREETS = ["Alder", "Birch", "Chestnut", "Dogwood", "Elmwood", "Foxtail", "Hawthorn", "Larkspur", "Magnolia", "Sycamore", "Tupelo", "Willowbrook"];
export const STREET_KINDS = ["St", "Ave", "Blvd", "Pike", "Rd"];
