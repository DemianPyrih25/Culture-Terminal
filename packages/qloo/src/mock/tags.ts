import { BRAND_FAMILIES, slug } from "./names";

/**
 * The synthetic tag world. Invented leaves carry a `mock_` prefix; the few public taxonomy URNs the
 * app pins (the heatmap baseline, the G10 cafe filter, venue categories) are used as they are so
 * pinned requests behave offline exactly as they do live.
 */

export interface MockTag {
  id: string;
  name: string;
  type: string;
}

export function mockTag(type: string, name: string): MockTag {
  return { id: `${type}:mock_${slug(name)}`, name, type };
}

function publicTag(type: string, leaf: string, name: string): MockTag {
  return { id: `${type}:${leaf}`, name, type };
}

const titleOf = (leaf: string): string => leaf.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export type TagFamily = "WHO" | "VIBE" | "WHAT" | "SOUND";

const WHO = "urn:tag:customer_identity:qloo";
const VIBE = "urn:tag:ambience:qloo";
const GENRE_PLACE = "urn:tag:genre:place";
const CATEGORY_PLACE = "urn:tag:category:place";
const GENRE_MUSIC = "urn:tag:genre:music";

const WHO_NAMES = [
  "Night Owls", "Brunch Regulars", "Vinyl Collectors", "Craft Beer Fans", "Coffee Purists", "Young Professionals",
  "Families with Kids", "Students", "Remote Workers", "Foodies", "Wine Lovers", "Cocktail Enthusiasts",
  "Live Music Fans", "Tourists", "Locals", "Couples", "Solo Diners", "Dog Owners", "Fitness Fans", "Cyclists",
  "Gamers", "Bookworms", "Art Lovers", "Vintage Shoppers", "Sneakerheads", "Plant Parents", "Health Seekers",
  "Vegans", "Late Night Snackers", "Sports Fans", "Trivia Teams", "Karaoke Crowd", "Date Night Couples",
  "Retirees", "Creatives", "Tech Workers", "Musicians", "Skaters", "Hikers", "Festival Goers", "Comedy Fans",
  "Film Buffs", "Podcast Listeners", "Bargain Hunters", "Luxury Seekers", "Early Risers", "Parents Night Out",
  "Group Celebrations", "Business Travelers", "Hipsters", "Brewery Hoppers", "Taco Lovers", "Barbecue Fans",
  "Dessert Lovers", "Neighborhood Regulars",
];

const VIBE_NAMES = [
  "Cozy", "Lively", "Trendy", "Casual", "Upscale", "Romantic", "Laid Back", "Rustic", "Industrial", "Quirky",
  "Intimate", "Noisy", "Family Friendly", "Hip", "Classic", "Retro", "Minimalist", "Bohemian", "Sunny Patio", "Dimly Lit",
];

const WHAT_GENRES = [
  "Taqueria", "Barbecue", "Ramen", "Pizzeria", "Bakery", "Brewery", "Cocktail Lounge", "Wine Bar", "Food Truck",
  "Vegan", "Brunch", "Dive Bar", "Hot Chicken", "Tex Mex", "Sushi", "Deli", "Ice Cream", "Distillery",
];
const WHAT_CATEGORIES = ["Record Store", "Bookstore", "Vintage Store", "Gallery", "Yoga Studio", "Climbing Gym", "Comedy Club", "Arcade"];

const SOUND_NAMES = [
  "Indie Rock", "Americana", "Country", "Hip Hop", "Jazz", "Blues", "Electronic", "Folk", "Punk", "Soul",
  "R and B", "Bluegrass", "Pop", "Metal", "Latin", "Reggae", "Ambient", "Gospel", "Funk", "Singer Songwriter",
];

/** Place tags with public taxonomy URNs that requests pin (PROBE_FACTS baseline, G10, SPEC S10). */
export const PUBLIC_PLACE_TAGS: readonly MockTag[] = [
  publicTag(GENRE_PLACE, "restaurant", "Restaurant"),
  publicTag(CATEGORY_PLACE, "cafe", "Cafe"),
  publicTag(CATEGORY_PLACE, "bar", "Bar"),
  publicTag(CATEGORY_PLACE, "live_music_venue", "Live Music Venue"),
];

export const WHAT_TAGS: readonly MockTag[] = [
  ...PUBLIC_PLACE_TAGS,
  ...WHAT_GENRES.map((n) => mockTag(GENRE_PLACE, n)),
  ...WHAT_CATEGORIES.map((n) => mockTag(CATEGORY_PLACE, n)),
];

export const SOUND_TAGS: readonly MockTag[] = SOUND_NAMES.map((n) => mockTag(GENRE_MUSIC, n));

/** The `urn:tag` fingerprint catalogue (BLOCK families, SPEC S7). WHO alone holds ≥50 tags (G8). */
export const FINGERPRINT_TAGS: ReadonlyArray<MockTag & { family: TagFamily }> = [
  ...WHO_NAMES.map((n) => ({ ...mockTag(WHO, n), family: "WHO" as const })),
  ...VIBE_NAMES.map((n) => ({ ...mockTag(VIBE, n), family: "VIBE" as const })),
  ...WHAT_TAGS.map((t) => ({ ...t, family: "WHAT" as const })),
  ...SOUND_TAGS.map((t) => ({ ...t, family: "SOUND" as const })),
];

const PODCAST_GENRES = ["comedy", "true_crime", "news", "sports", "business"];
const MEDIA_GENRES = ["drama", "comedy", "reality", "documentary", "thriller"];

/** The taxonomy genre tags an entity of this type draws its own genre from. Empty: no genre tag. */
export function genreOptions(type: string): readonly MockTag[] {
  switch (type) {
    case "urn:entity:brand":
      return BRAND_FAMILIES.map((f) => mockTag("urn:tag:genre:brand", titleOf(f)));
    case "urn:entity:artist":
      return SOUND_TAGS.slice(0, 8);
    case "urn:entity:podcast":
      return PODCAST_GENRES.map((g) => mockTag("urn:tag:genre:podcast", titleOf(g)));
    case "urn:entity:tv_show":
    case "urn:entity:movie":
      return MEDIA_GENRES.map((g) => mockTag("urn:tag:genre:media", titleOf(g)));
    case "urn:entity:place":
      return WHAT_TAGS;
    default:
      return [];
  }
}

/**
 * Descriptive facet namespaces seen on /search tags (G13). They feed Audience DNA facets, so each
 * entity draws `count` names per namespace.
 */
export const SEARCH_FACETS: ReadonlyArray<{ type: string; names: readonly string[]; count: number; brandOnly: boolean }> = [
  { type: "urn:tag:aesthetic_property:qloo", names: ["Minimal", "Bold", "Retro", "Earthy", "Sleek", "Playful", "Rugged", "Elegant"], count: 2, brandOnly: false },
  { type: "urn:tag:emotional_tone:qloo", names: ["Optimistic", "Nostalgic", "Rebellious", "Calm", "Energetic", "Warm", "Witty", "Earnest"], count: 2, brandOnly: false },
  { type: "urn:tag:customer_segment:qloo", names: ["Gen Z", "Millennials", "Families", "Professionals", "Students", "Retirees", "Creatives", "Athletes"], count: 2, brandOnly: false },
  { type: "urn:tag:lifestyle:qloo", names: ["Outdoorsy", "Urban", "Health Conscious", "Homebody", "Adventurous", "Social", "Eco Minded", "Busy Parent"], count: 2, brandOnly: true },
  { type: "urn:tag:personal_style:qloo", names: ["Streetwear", "Preppy", "Athleisure", "Vintage", "Workwear", "Classic"], count: 1, brandOnly: true },
  { type: "urn:tag:product_category:qloo", names: ["Beverages", "Snacks", "Apparel", "Footwear", "Skincare", "Outdoor Gear", "Accessories", "Home Goods"], count: 1, brandOnly: true },
];

/** The taxonomy namespace a semantic tag search returns for a parent entity type. */
export function taxonomyTypesFor(parentType: string): readonly string[] {
  switch (parentType) {
    case "urn:entity:place":
      return [GENRE_PLACE, CATEGORY_PLACE];
    case "urn:entity:artist":
      return [GENRE_MUSIC];
    case "urn:entity:podcast":
      return ["urn:tag:genre:podcast"];
    case "urn:entity:tv_show":
    case "urn:entity:movie":
      return ["urn:tag:genre:media"];
    default:
      return ["urn:tag:genre:brand"];
  }
}

const KNOWN_TAGS: ReadonlyMap<string, MockTag> = new Map(
  [
    ...FINGERPRINT_TAGS.map(({ id, name, type }) => ({ id, name, type })),
    ...["urn:entity:brand", "urn:entity:podcast", "urn:entity:tv_show"].flatMap((t) => genreOptions(t)),
  ].map((t) => [t.id, t]),
);

/** A tag row for any id: the catalogue entry, else a name derived from the URN leaf. */
export function tagById(id: string): MockTag {
  const known = KNOWN_TAGS.get(id);
  if (known) return known;
  const cut = id.lastIndexOf(":");
  return { id, name: titleOf(id.slice(cut + 1).replace(/^mock_/, "")), type: id.slice(0, Math.max(cut, 0)) };
}
