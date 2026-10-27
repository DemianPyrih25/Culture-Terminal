import type {
  BarListRow,
  ColumnPoint,
  DivergingRow,
  MiniBarColumn,
  NameItem,
  NeighbourColumn,
  PairGroup,
  RankTrackRow,
  RankedFitRow,
  SlateRow,
  WinnerRow,
} from "../../../components/plots";
import { NEIGHBOUR_DOMAINS } from "../../../components/plots";

// Invented rows for the plot gallery (D29): every brand, band, show and venue here is made up. Places are
// real US cities and neighbourhoods, used only as labels.

export const SUBJECT = "Brand Alpha";
export const SECOND = "Brand Beta";

export const closestAudiences: BarListRow[] = [
  { label: "Pinecone Soap Co.", sublabel: "personal care", value: 0.84, display: "0.84", tone: "accent", tag: "outside-category" },
  { label: "Hollowpeak Water", sublabel: "bottled water", value: 0.79, display: "0.79" },
  { label: "Bramble Tea", sublabel: "iced tea", value: 0.76, display: "0.76", tone: "accent" },
  { label: "Northspring Water", sublabel: "bottled water", value: 0.74, display: "0.74" },
  { label: "Kelpwise Water", sublabel: "bottled water", value: 0.71, display: "0.71" },
];

export const travel: BarListRow[] = [
  { label: "Moab, UT", value: 0.92, display: "#1", tone: "accent", tag: "hidden-gem" },
  { label: "Bend, OR", value: 0.81, display: "#2" },
  { label: "Asheville, NC", value: 0.74, display: "#3" },
  { label: "Joshua Tree, CA", value: 0.68, display: "#4" },
  { label: "Big Sur, CA", value: null, display: "#5" },
];

export const whoTheFansAre: DivergingRow[] = [
  { label: "Women", value: 0.31 },
  { label: "Men", value: -0.29 },
  { label: "18–24", value: -0.18 },
  { label: "25–34", value: 0.09 },
  { label: "35–44", value: 0.22 },
  { label: "45–54", value: 0.11 },
  { label: "55+", value: -0.08 },
];

export const blockGroups: PairGroup[] = [
  { label: "Who goes", less: { label: "Families with kids", value: 0.6 }, more: { label: "Musicians and creatives", value: 1.8 } },
  { label: "The vibe", less: { label: "Upscale", value: 0.6 }, more: { label: "Late-night", value: 1.9 } },
  { label: "Food and venues", less: { label: "Fine dining", value: 0.5 }, more: { label: "Coffee", value: 2.1 } },
  { label: "Music", less: { label: "Top 40 clubs", value: 0.7 }, more: { label: "Live indie", value: 2.3 } },
];

export const cities: WinnerRow[] = [
  { label: "Los Angeles", winner: "a" },
  { label: "Chicago", winner: "a" },
  { label: "New York", winner: "a" },
  { label: "Austin", winner: "a" },
];

export const ageGroups: WinnerRow[] = [
  { label: "18–24", winner: "a" },
  { label: "25–29", winner: "b" },
  { label: "30–34", winner: "a" },
  { label: "35–44", winner: "a" },
  { label: "45–54", winner: null },
];

export const markets: RankTrackRow[] = [
  { label: "Chattanooga", sublabel: "TN", rank: 1, of: 5 },
  { label: "Tulsa", sublabel: "OK", rank: 1, of: 5 },
  { label: "Little Rock", sublabel: "AR", rank: 1, of: 5 },
  { label: "Omaha", sublabel: "NE", rank: 1, of: 5 },
  { label: "Boise", sublabel: "ID", rank: 2, of: 5, tag: "hidden-gem" },
  { label: "Spokane", sublabel: "WA", rank: 3, of: 5 },
];

export const moreLess: MiniBarColumn[] = [
  {
    label: "More here",
    tone: "accent",
    rows: [
      { label: "Record shops", value: 2.4 },
      { label: "Natural wine", value: 2.1, tag: "new-here" },
      { label: "Live music", value: 1.8 },
      { label: "Food trucks", value: 1.6 },
      { label: "Indie coffee", value: 1.4 },
    ],
  },
  {
    label: "Less here",
    tone: "second",
    rows: [
      { label: "Chain restaurants", value: 0.5 },
      { label: "Sports bars", value: 0.6 },
      { label: "Nightclubs", value: 0.7 },
      { label: "Fine dining", value: 0.7 },
      { label: "Hotels", value: 0.8 },
    ],
  },
];

export const tenantFit: RankedFitRow[] = [
  { label: "Night Owl Noodle Bar", value: 91, climbs: true },
  { label: "Hi-Fi Taco Club", value: 84, climbs: true },
  { label: "Second Spin Records", value: 77, climbs: true },
  { label: "Copper Bell Bakery", value: 69 },
  { label: "Loom & Thread Vintage", value: 58 },
  { label: "Brightside Yoga", value: 44 },
];

export const slate: SlateRow[] = [
  { category: "Beer", name: "Ridgeline Lager", href: "/d/brand/ridgeline-lager", fit: 0.92, display: "#1 of 12" },
  { category: "Spirits", name: "Copper Kettle Whiskey", fit: 0.88, display: "#1 of 10", tag: "hidden-gem" },
  { category: "Outdoor retail", name: "Trailhead Outfitters", fit: 0.85, display: "#1 of 7" },
  { category: "Apparel and boots", name: "Prairie Denim Co.", fit: 0.81, display: "#1 of 9" },
  { category: "Quick-service food", name: "Smokestack BBQ", fit: 0.76, display: "#1 of 11" },
  { category: "Hard seltzer", name: "Highway Seltzer", fit: 0.7, display: "#1 of 8", tag: "hidden-gem" },
  { category: "Pet food", name: null, fit: null, display: "" },
];

export const alsoLove: NameItem[] = [
  { name: "Gravel Road Boots" },
  { name: "Ironwood Knives" },
  { name: "Bluestem Coffee" },
  { name: "Prairie Denim Co." },
  { name: "Trailhead Outfitters" },
  { name: "Low Creek Jerky", tag: "hidden-gem" },
  { name: "Copper Kettle Whiskey" },
  { name: "Hayfield Hats" },
];

export const neighbours: NeighbourColumn[] = [
  {
    ...NEIGHBOUR_DOMAINS.music,
    items: [
      { name: "The Paper Lanterns", href: "/d/artist/paper-lanterns" },
      { name: "Juniper Rail" },
      { name: "Okra Fields", tag: "hidden-gem" },
      { name: "Low Tide Choir" },
      { name: "Maple & Rye" },
    ],
  },
  {
    ...NEIGHBOUR_DOMAINS.podcasts,
    items: [
      { name: "Slow Simmer" },
      { name: "The Pantry Hour" },
      { name: "Field Notes on Food", tag: "hidden-gem" },
      { name: "Kitchen Table Talks" },
      { name: "Small Batch" },
    ],
  },
  {
    ...NEIGHBOUR_DOMAINS.tv,
    items: [
      { name: "Kitchen Detectives" },
      { name: "The Garden Hour" },
      { name: "Market Day" },
      { name: "Pie Society", tag: "hidden-gem" },
      { name: "Coastal Cooks" },
    ],
  },
  { ...NEIGHBOUR_DOMAINS.brands, items: [] },
];

export const interest: ColumnPoint[] = [
  { label: "Apr", value: 0.42 },
  { label: "May", value: 0.5 },
  { label: "Jun", value: 0.55 },
  { label: "Jul", value: 0.6 },
  { label: "Aug", value: 0.68 },
  { label: "Sep", value: 0.75 },
];
