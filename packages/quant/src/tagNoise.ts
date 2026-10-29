/**
 * The shared tag-noise filter (ANSWER_QUALITY §10). Some Qloo tags carry no taste: a country, state
 * or city name ("Usa", "austin"), and, among music genre tags, a nationality or a generic word
 * ("american", "seen live", "funny"). Every tag list the skills rank goes through `isNoiseTag`
 * before ranking, so a noise tag never takes a rank, a bar, a NEW count or a finding.
 *
 * Exact names only: "New York Style Pizza" or "Nashville Hot Chicken" stay. Nationalities and
 * generic words are dropped from music tags alone, because the same words are real tags elsewhere
 * ("American" is a cuisine, "Fun" is a Qloo ambience tag).
 */

/** Countries and their common short forms. */
const COUNTRIES = [
  "usa", "us", "u s", "u s a", "united states", "united states of america", "america", "uk", "u k", "united kingdom",
  "great britain", "britain", "england", "scotland", "wales", "ireland", "canada", "mexico", "australia", "new zealand",
  "germany", "france", "spain", "italy", "portugal", "netherlands", "belgium", "sweden", "norway", "denmark", "finland",
  "iceland", "japan", "korea", "south korea", "china", "india", "brazil", "argentina", "colombia", "chile", "jamaica",
  "cuba", "nigeria", "south africa", "russia", "poland", "greece", "turkey", "israel", "philippines",
];

/** US states and DC. */
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "district of columbia", "washington dc", "dc",
];

/** US cities with a market in Culture Terminal or a large music scene, and a few world cities. */
const CITIES = [
  "new york city", "nyc", "los angeles", "la", "chicago", "houston", "phoenix", "philadelphia", "philly", "san antonio",
  "san diego", "dallas", "austin", "san jose", "jacksonville", "fort worth", "columbus", "charlotte", "indianapolis",
  "san francisco", "seattle", "denver", "nashville", "oklahoma city", "el paso", "boston", "portland", "las vegas",
  "detroit", "memphis", "louisville", "baltimore", "milwaukee", "albuquerque", "tucson", "fresno", "sacramento",
  "kansas city", "atlanta", "miami", "raleigh", "omaha", "minneapolis", "tulsa", "cleveland", "new orleans", "nola",
  "tampa", "orlando", "pittsburgh", "st louis", "saint louis", "cincinnati", "salt lake city", "honolulu", "brooklyn",
  "queens", "bronx", "manhattan", "harlem", "hollywood", "bay area", "london", "paris", "berlin", "tokyo", "toronto",
  "montreal", "vancouver", "mexico city", "sydney", "melbourne", "dublin", "glasgow", "manchester", "liverpool",
  "stockholm", "amsterdam",
];

/** Nationalities: noise as a music genre tag, a real tag elsewhere (a cuisine). */
const MUSIC_NATIONALITIES = [
  "american", "british", "english", "scottish", "welsh", "irish", "canadian", "australian", "german", "french",
  "swedish", "norwegian", "danish", "finnish", "dutch", "icelandic", "japanese", "us american", "texan", "californian",
];

/** Root words that name no kind of place or taste in any family ("Place" is the root place genre). */
const GENERIC = ["place", "places", "venue", "venues"];

/** User-library words that name no style of music. */
const MUSIC_GENERIC = [
  "seen live", "favorites", "favourites", "favorite", "favourite", "my favorite", "love", "loved", "love it", "awesome",
  "amazing", "beautiful", "cool", "good", "great", "best", "fun", "funny", "nice", "epic", "classic", "music", "songs",
  "albums", "all", "misc", "other", "others", "various", "various artists", "unknown", "spotify", "youtube", "radio",
  "male vocalists", "female vocalists", "male vocalist", "female vocalist", "check out", "to listen",
];

const PLACES: ReadonlySet<string> = new Set([...COUNTRIES, ...US_STATES, ...CITIES, ...GENERIC]);
const MUSIC_ONLY: ReadonlySet<string> = new Set([...MUSIC_NATIONALITIES, ...MUSIC_GENERIC]);

/** The music genre tag type; matches blockDna MUSIC_TAG_TYPE. */
const MUSIC_TYPE = "urn:tag:genre:music";

/** Lower case, separators and punctuation as single spaces: "Seen-Live", "seen_live" → "seen live". */
export function normaliseTagName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/** The leaf of a tag id ("urn:tag:genre:music:usa" → "usa"), or the id itself. */
function leafOf(tagId: string): string {
  const cut = tagId.lastIndexOf(":");
  return cut >= 0 ? tagId.slice(cut + 1) : tagId;
}

/**
 * True when the tag carries no taste: a place name or a root word ("Place"), or for a music genre tag a nationality or a
 * generic word. Reads the display name and the id's leaf, so either spelling is caught.
 */
export function isNoiseTag(tag: { name: string; tagId?: string | null; type?: string | null }): boolean {
  const names = [normaliseTagName(tag.name)];
  if (tag.tagId) names.push(normaliseTagName(leafOf(tag.tagId)));
  const music = [tag.type ?? "", tag.tagId ?? ""].some((t) => t === MUSIC_TYPE || t.startsWith(`${MUSIC_TYPE}:`));
  return names.some((n) => n === "" || PLACES.has(n) || (music && MUSIC_ONLY.has(n)));
}
