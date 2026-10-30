import type { DatasetEnvelope, RankedRow } from "@ct/contracts";
import { formatUtcDate, formatUtcShortDateTime } from "../../lib/brief/format";
import { withoutNoiseTags } from "../../lib/tag-noise";
import type { IconName } from "../ui/icons";
import { DES_TYPE_LABEL, desHref, isDesType, type DesType } from "./des-href";
import type { DesFigure, DesReceipt, DesSection, Tearsheet } from "./model";
import { stateAbbr } from "./us-states";

/**
 * The audience profile (N14) as plain words and numbers, built from a tearsheet. Pure: the page passes
 * the result to the client view, so nothing but what the reader sees reaches the browser (no request
 * parameters, no Qloo ids). Missing data reads "No data", never zero.
 */

export const NO_DATA = "No data";
/** An index within this distance of 0 reads as even. */
export const LEAN_THRESHOLD = 0.05;
/** Rows each "What else their fans love" column shows. */
export const NEIGHBOUR_ROWS = 5;
/** Rows of "Places their fans travel to". */
export const TRAVEL_ROWS = 5;

/** The key figures the tearsheet names, by their label (server/des/tearsheet.ts keyFiguresOf). */
const FIGURE_LABEL = { reach: "Popularity", age: "Youth index", gender: "Women" } as const;

export const TYPE_NOUN: Readonly<Record<DesType, { one: string; many: string }>> = {
  brand: { one: "brand", many: "brands" },
  artist: { one: "artist", many: "artists" },
  person: { one: "public figure", many: "public figures" },
  podcast: { one: "podcast", many: "podcasts" },
  tv_show: { one: "TV show", many: "TV shows" },
  movie: { one: "film", many: "films" },
};

// Numbers and words -------------------------------------------------------------------------------------

/** A signed index with a true minus: "+0.21", "−0.12", "0.00". */
export function signed(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(2)}`;
}

/** A key figure's display ("0.78", "+0.59", "−0.12") as a number; null when it is not a number. */
export function parseIndex(display: string): number | null {
  const text = display.replace(/−/g, "-").trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** "Top 22%": the share of entities more widely known than this one, at least 1%. */
export function reachWord(popularity: number): string {
  const p = Math.min(1, Math.max(0, popularity));
  return `Top ${Math.max(1, Math.round((1 - p) * 100))}%`;
}

export function ageLean(youth: number): string {
  if (youth > LEAN_THRESHOLD) return "Leans younger";
  if (youth < -LEAN_THRESHOLD) return "Leans older";
  return "Even age mix";
}

/** From the index for women: above 0 the audience leans female. */
export function genderLean(women: number): string {
  if (women > LEAN_THRESHOLD) return "Leans female";
  if (women < -LEAN_THRESHOLD) return "Leans male";
  return "Even gender mix";
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Health Conscious" → "health conscious"; acronyms and mixed-case names keep their capitals. */
export function softCase(tag: string): string {
  return tag
    .split(" ")
    .map((word) => (/^[A-Z][a-z'’-]*$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/** One age label as a phrase: "≤24" → "under 25"; others as they are. */
function ageWord(label: string): string {
  const under = /^[≤<]\s*(\d+)$/.exec(label.trim());
  return under ? `under ${Number(under[1]) + (label.includes("≤") ? 1 : 0)}` : label;
}

/** Adjacent age groups merged: "30–34" + "35–44" → "30–44", "45–54" + "55+" → "45+". */
export function ageSpan(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return ageWord(labels[0]!);
  const first = labels[0]!.trim();
  const last = labels[labels.length - 1]!.trim();
  const low = /^(\d+)/.exec(first)?.[1] ?? null;
  const under = /^[≤<]\s*\d+$/.test(first);
  const open = /^(\d+)\+$/.exec(last);
  const high = /(\d+)$/.exec(last)?.[1] ?? null;
  if (open) return low !== null && !under ? `${low}+` : "all ages";
  if (high === null) return `${first}–${last}`;
  if (under) return `under ${Number(high) + 1}`;
  return low !== null ? `${low}–${high}` : `${first}–${last}`;
}

// Fans ---------------------------------------------------------------------------------------------------

export interface FanRow {
  key: string;
  /** "Men", "Women", "18–24". */
  label: string;
  /** The index against the average audience; null when not measured. */
  value: number | null;
}

/** The strongest above-average age group, widened over its above-average neighbours. */
function positiveSpan(ages: readonly FanRow[]): string | null {
  let best = -1;
  ages.forEach((row, i) => {
    if (row.value !== null && row.value > 0 && (best < 0 || row.value > (ages[best]!.value ?? 0))) best = i;
  });
  if (best < 0) return null;
  let from = best;
  let to = best;
  while (from > 0 && (ages[from - 1]!.value ?? 0) > 0) from -= 1;
  while (to < ages.length - 1 && (ages[to + 1]!.value ?? 0) > 0) to += 1;
  return ageSpan(ages.slice(from, to + 1).map((row) => row.label));
}

/** "Fans lean male and 35–54.": the gender lean and the strongest above-average age span. */
export function fansTitle(gender: readonly FanRow[], ages: readonly FanRow[]): string {
  const women = gender.find((row) => /^women$/i.test(row.label))?.value ?? null;
  const men = gender.find((row) => /^men$/i.test(row.label))?.value ?? null;
  const lean = women !== null ? women : men !== null ? -men : null;
  const sex = lean === null || Math.abs(lean) <= LEAN_THRESHOLD ? null : lean > 0 ? "female" : "male";
  const span = positiveSpan(ages);
  if (sex && span) return `Fans lean ${sex} and ${span}.`;
  if (sex) return `Fans lean ${sex}.`;
  if (span) return `Fans skew ${span}.`;
  return "Fans look like the average audience.";
}

// The model ----------------------------------------------------------------------------------------------

export interface ProfileKeyNumber {
  id: "reach" | "age" | "gender";
  value: string;
  label: string;
  context: string;
  /** The request in How we know; null when there is none. */
  receipt: number | null;
}

interface Card {
  title: string;
  /** The request behind it in How we know. */
  receipt: number | null;
  /** Why nothing, or not everything, shows; null when everything does. */
  gap: string | null;
}

export interface FansCard extends Card {
  rows: FanRow[];
}

export interface TagFamily {
  label: string;
  tags: string[];
}

export interface TagsCard extends Card {
  families: TagFamily[];
  caption: string;
}

export interface NeighbourRow {
  rank: number;
  name: string;
  /** This name's own profile; null when its type has none. */
  href: string | null;
  /** Under the radar: strong fit, less known. */
  gem: boolean;
  fit: number | null;
}

export interface NeighbourColumn {
  key: string;
  label: string;
  icon: IconName;
  rows: NeighbourRow[];
}

export interface NeighboursCard extends Card {
  columns: NeighbourColumn[];
}

export interface TravelRow {
  label: string;
  /** Fit within this set of destinations, 0 to 1. */
  fit: number;
  rank: number;
  gem: boolean;
}

export interface TravelCard extends Card {
  rows: TravelRow[];
}

export interface ProfileSource {
  n: number;
  /** What the request was for, in words: "What their fans like in music". */
  title: string;
  endpoint: string;
  filter: string | null;
  rows: number | null;
  /** "Saved copy, 2h old" or "Fetched live, 23 Oct, 09:00 UTC". */
  fresh: string;
  live: boolean;
  ms: number;
  requestId: string | null;
  error: string | null;
}

export interface ProfileHow {
  traced: number;
  total: number;
  requests: number;
  saved: number;
  live: number;
  /** How the name was matched. */
  matched: string;
  /** What this view cost: Qloo requests from today's allowance and $0 of AI (FEATURE_COSTS.des_profile). */
  cost: string;
  /** The fixed limits of each part and the flags it raised. */
  notes: string[];
  sources: ProfileSource[];
}

export interface ProfileModel {
  name: string;
  type: DesType;
  /** "Brand · Audience profile · Data as of 23 Oct 2026". */
  labelLine: string;
  /** The name as typed, when Qloo spells it differently. */
  lookedUpAs: string | null;
  askHref: string;
  keyNumbers: ProfileKeyNumber[];
  fans: FansCard;
  tags: TagsCard;
  neighbours: NeighboursCard;
  travel: TravelCard;
  how: ProfileHow;
}

const EMPTY_TITLE = "No data for this audience.";

function figureOf<K extends DatasetEnvelope["kind"]>(section: DesSection, kind: K, display?: DesFigure["display"]) {
  const figure = section.figures.find((f) => f.dataset.kind === kind && (display === undefined || f.display === display));
  // Tag lists go through the shared noise filter at display time, stored lookups included (ANSWER_QUALITY §10).
  return (figure ? { ...figure, dataset: withoutNoiseTags(figure.dataset) } : undefined) as
    | (DesFigure & { dataset: Extract<DatasetEnvelope, { kind: K }> })
    | undefined;
}

function keyNumbers(sheet: Tearsheet): ProfileKeyNumber[] {
  const figure = (label: string) => sheet.keyFigures.find((f) => f.label === label) ?? null;
  const number = (label: string) => {
    const f = figure(label);
    return { value: f ? parseIndex(f.value) : null, receipt: f?.receipt ?? null };
  };
  const noun = TYPE_NOUN[sheet.entity.type];
  const reach = number(FIGURE_LABEL.reach);
  const age = number(FIGURE_LABEL.age);
  const gender = number(FIGURE_LABEL.gender);
  return [
    {
      id: "reach",
      value: reach.value === null ? NO_DATA : reachWord(reach.value),
      label: "How widely known",
      context: reach.value === null ? `Qloo gave no reach for this ${noun.one}` : `among all ${noun.many} in Qloo`,
      receipt: reach.receipt,
    },
    {
      id: "age",
      value: age.value === null ? NO_DATA : ageLean(age.value),
      label: "Age lean",
      context: age.value === null ? "Not measured for this audience" : `${signed(age.value)} vs the average audience`,
      receipt: age.receipt,
    },
    {
      id: "gender",
      value: gender.value === null ? NO_DATA : genderLean(gender.value),
      label: "Gender lean",
      context: gender.value === null ? "Not measured for this audience" : `${signed(gender.value)} for women vs the average audience`,
      receipt: gender.receipt,
    },
  ];
}

function fansCard(sheet: Tearsheet): FansCard {
  const section = sheet.sections.dna;
  const figure = figureOf(section, "Bars", "exhibit");
  if (!figure) return { title: EMPTY_TITLE, rows: [], receipt: null, gap: section.gap ?? "Qloo holds no age or gender data for this audience." };
  const rowsOf = (key: string): FanRow[] =>
    (figure.dataset.payload.groups.find((g) => g.key === key)?.bars ?? []).map((bar) => ({
      key: bar.key,
      label: bar.label,
      value: bar.values[0]?.value ?? null,
    }));
  // Men first, then women, as the design reads them.
  const gender = rowsOf("gender").sort((a, b) => (/^men$/i.test(a.label) ? -1 : /^men$/i.test(b.label) ? 1 : 0));
  const ages = rowsOf("age");
  return { title: fansTitle(gender, ages), rows: [...gender, ...ages], receipt: figure.source.receipt, gap: section.gap };
}

/** Qloo's tag families as the design names them, in this order; others fill in when one is missing. */
const FAMILY_NAMES: readonly { match: RegExp; label: string }[] = [
  { match: /^aesthetic/i, label: "Look" },
  { match: /^emotional[ _]tone/i, label: "Tone" },
  { match: /^lifestyle$/i, label: "Lifestyle" },
];
const MAX_FAMILIES = 3;
const MAX_TAGS = 3;

function tagsCard(sheet: Tearsheet): TagsCard {
  const section = sheet.sections.dna;
  const caption = `Qloo's taste tags for the ${TYPE_NOUN[sheet.entity.type].one}, grouped by theme.`;
  const figure = figureOf(section, "Ranked", "tags");
  const groups = figure ? figure.dataset.payload.groups.filter((g) => g.rows.length > 0) : [];
  const named = FAMILY_NAMES.flatMap((family) => {
    const group = groups.find((g) => family.match.test(g.key) || family.match.test(g.label));
    return group ? [{ group, label: family.label }] : [];
  });
  const others = groups.filter((g) => !named.some((n) => n.group === g)).map((group) => ({ group, label: group.label }));
  const families = [...named, ...others].slice(0, MAX_FAMILIES).map(({ group, label }) => ({
    label,
    tags: group.rows.slice(0, MAX_TAGS).map((row) => softCase(row.label)),
  }));
  if (!figure || families.length === 0) {
    return { title: EMPTY_TITLE, families: [], caption, receipt: null, gap: "Qloo holds no taste tags for this name." };
  }
  const firsts = families.flatMap((f) => (f.tags[0] ? [f.tags[0]] : []));
  return { title: `${capitalise(joinNames(firsts))}.`, families, caption, receipt: figure.source.receipt, gap: null };
}

/** The domains of "What else their fans love": heading, icon and the profile type of their names. */
const DOMAINS: readonly { key: string; label: string; icon: IconName; type: DesType }[] = [
  { key: "artist", label: "Music", icon: "music", type: "artist" },
  { key: "podcast", label: "Podcasts", icon: "mic", type: "podcast" },
  { key: "tv_show", label: "TV", icon: "tv", type: "tv_show" },
  { key: "brand", label: "Brands", icon: "shopping-bag", type: "brand" },
];
const EXTRA_DOMAIN: Readonly<Record<string, { label: string; icon: IconName; type: DesType }>> = {
  movie: { label: "Films", icon: "circle-play", type: "movie" },
};

function neighbourRow(row: RankedRow, i: number, fitAt: number, fallback: DesType | null): NeighbourRow {
  const type = row.type !== null && isDesType(row.type) ? row.type : fallback;
  return {
    rank: row.rank ?? i + 1,
    name: row.label,
    href: type ? desHref({ name: row.label, type }) : null,
    gem: row.flags.includes("UTR"),
    fit: fitAt >= 0 ? (row.cells[fitAt]?.value ?? null) : null,
  };
}

function neighboursCard(sheet: Tearsheet): NeighboursCard {
  const section = sheet.sections.neighbours;
  const lists = section.figures.flatMap((figure) => {
    if (figure.dataset.kind !== "Ranked") return [];
    const { columns, groups } = figure.dataset.payload;
    const fitAt = columns.findIndex((c) => c.key === "fit");
    return groups.map((group) => ({ group, fitAt, receipt: figure.source.receipt }));
  });
  if (lists.length === 0) return { title: EMPTY_TITLE, columns: [], receipt: null, gap: section.gap ?? "Qloo returned nothing else these fans love." };
  const extra = lists.filter((l) => !DOMAINS.some((d) => d.key === l.group.key));
  const columns: NeighbourColumn[] = [
    ...DOMAINS.map((d) => ({ ...d, list: lists.find((l) => l.group.key === d.key) })),
    ...extra.map((l) => ({
      key: l.group.key,
      label: EXTRA_DOMAIN[l.group.key]?.label ?? l.group.label,
      icon: EXTRA_DOMAIN[l.group.key]?.icon ?? ("circle" as IconName),
      type: EXTRA_DOMAIN[l.group.key]?.type ?? null,
      list: l,
    })),
  ].map(({ key, label, icon, type, list }) => ({
    key,
    label,
    icon,
    rows: list ? list.group.rows.slice(0, NEIGHBOUR_ROWS).map((row, i) => neighbourRow(row, i, list.fitAt, type)) : [],
  }));
  // The #1 of each domain, best fits first (a stable sort keeps the domain order on ties).
  const tops = columns
    .flatMap((c) => (c.rows[0] ? [c.rows[0]] : []))
    .sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1))
    .slice(0, 3)
    .map((r) => r.name);
  return { title: `Fans also love ${joinNames(tops)}.`, columns, receipt: lists[0]?.receipt ?? null, gap: section.gap };
}

function travelCard(sheet: Tearsheet): TravelCard {
  const section = sheet.sections.travel;
  const figure = figureOf(section, "Quadrant");
  const points = figure ? [...figure.dataset.payload.points].sort((a, b) => b.y - a.y).slice(0, TRAVEL_ROWS) : [];
  if (!figure || points.length === 0) {
    return { title: EMPTY_TITLE, rows: [], receipt: null, gap: section.gap ?? "Qloo returned no places for this audience." };
  }
  const rows = points.map((p, i) => {
    const abbr = stateAbbr(p.group ?? p.geo?.region ?? null);
    return { label: abbr ? `${p.label}, ${abbr}` : p.label, fit: Math.min(1, Math.max(0, p.y)), rank: i + 1, gem: p.quadrant === "HIDDEN_POCKET" };
  });
  return { title: `Their taste travels furthest to ${points[0]!.label}.`, rows, receipt: figure.source.receipt, gap: section.gap };
}

/** A request in words, from its endpoint and filter: what it was for. */
export function sourceTitle(receipt: Pick<DesReceipt, "endpoint" | "filterLabel" | "purpose">): string {
  const filter = receipt.filterLabel?.toLowerCase() ?? "";
  if (receipt.endpoint === "/search") return "Name matched in Qloo";
  if (receipt.endpoint === "/entities") return "How Qloo describes it";
  if (filter.includes("demographics")) return "Age and gender of the fans";
  if (filter.includes("destination")) return "Places their fans travel to";
  if (filter.includes("artist")) return "What their fans like in music";
  if (filter.includes("podcast")) return "What their fans like in podcasts";
  if (filter.includes("tv")) return "What their fans like on TV";
  if (filter.includes("movie")) return "What their fans like in film";
  if (filter.includes("brand")) return "Brands their fans like";
  return receipt.purpose ?? `Qloo ${receipt.endpoint}`;
}

/** "Saved copy, 2h old" for a cached answer; "Fetched live, 23 Oct, 09:00 UTC" for a fresh one. */
export function freshText(receipt: Pick<DesReceipt, "cache" | "cacheLabel">, fetchedAt: string): string {
  if (receipt.cache === "miss") return `Fetched live, ${formatUtcShortDateTime(fetchedAt)} UTC`;
  const age = receipt.cacheLabel.replace(/^(cached|stale cache|live) ?/, "").trim();
  return age ? `Saved copy, ${age} old` : "Saved copy";
}

/**
 * What opening this profile cost. A profile served again from the answer cache made no request; a new
 * one spent its live requests from today's Qloo allowance, its saved copies nothing. No AI model runs.
 */
export function costText(live: number, cachedAt: string | null): string {
  if (cachedAt !== null) return "No Qloo request for this view: a profile read earlier. AI cost $0.";
  if (live === 0) return "No live Qloo request: every answer was a saved copy. AI cost $0.";
  return `${live} live Qloo ${live === 1 ? "request" : "requests"} from today's allowance. AI cost $0.`;
}

function howOf(sheet: Tearsheet, cachedAt: string | null): ProfileHow {
  const notes = [...new Set([...sheet.sections.dna.notes, ...sheet.sections.neighbours.notes, ...sheet.sections.travel.notes])];
  const live = sheet.receipts.filter((r) => r.cache === "miss").length;
  return {
    traced: sheet.traced.traced,
    total: sheet.traced.total,
    requests: sheet.requests.total,
    saved: sheet.requests.total - live,
    live,
    cost: costText(live, cachedAt),
    matched: sheet.picked
      ? "You picked this one from Qloo's matches; nothing was picked for you."
      : "The name was matched exactly, name and type, before any data was read.",
    notes,
    sources: sheet.receipts.map((r) => ({
      n: r.n,
      title: sourceTitle(r),
      endpoint: r.endpoint,
      filter: r.filterLabel,
      rows: r.rows,
      fresh: freshText(r, sheet.computedAt),
      live: r.cache === "miss",
      ms: r.ms,
      requestId: r.requestId,
      error: r.error,
    })),
  };
}

/** The profile page's model, from a tearsheet and, when it came from the answer cache, when it was made. */
export function buildProfile(sheet: Tearsheet, cachedAt: string | null): ProfileModel {
  const name = sheet.entity.name;
  return {
    name,
    type: sheet.entity.type,
    labelLine: `${DES_TYPE_LABEL[sheet.entity.type]} · Audience profile · Data as of ${formatUtcDate(cachedAt ?? sheet.computedAt)}`,
    lookedUpAs: sheet.query.name.toLowerCase() === name.toLowerCase() ? null : sheet.query.name,
    askHref: askAboutHref(name),
    keyNumbers: keyNumbers(sheet),
    fans: fansCard(sheet),
    tags: tagsCard(sheet),
    neighbours: neighboursCard(sheet),
    travel: travelCard(sheet),
    how: howOf(sheet, cachedAt),
  };
}

/** "Ask about {name}": a question about its audience. */
export function askAboutHref(name: string): string {
  return `/ask?q=${encodeURIComponent(`Who is the ${name} audience?`)}`;
}
