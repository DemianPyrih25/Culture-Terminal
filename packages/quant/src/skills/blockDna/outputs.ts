import {
  BlockFamily,
  isTaxonomyTag,
  METRO_LABEL,
  type Bar,
  type BarGroup,
  type DatasetId,
  type DigestRow,
  type MetroId,
  type SkillResult,
  type SkillStatus,
  type EvidenceId,
  type Finding,
  type Flag,
  type LocationMethod,
  type Metric,
  type MetricId,
  type NoValueReason,
  type QlooEntity,
  type RankedRow,
  type RegisteredEntity,
  type RegisteredTag,
  type SkillCtx,
  type TagRef,
  type ValueCell,
} from "@ct/contracts";
import {
  BLOCK_SIGNAL_TAGS_MAX,
  blockNewTagsFinding,
  emptyResultFinding,
  isBlockNewTags,
  locationFallbackFinding,
  type BlockNewTagsFamily,
  type FindingDraft,
} from "../../findings";
import { isAboutLevelRankGain, THIN_SAMPLE } from "../../formulas";
import { addSkillMetric, registerEntity, type MetricSpec } from "../common";
import { skillResult, type DigestTarget } from "../digest";
import { safeFullName, safeName } from "../format";
import { draftFromInsight } from "../peerSelection";
import { BRAND_POPULARITY_MAX, BRAND_TAKE, byGain, familyBars, familyOf, NEW_AREA_TOP, newTagCount, TAG_TAKE, type Compared, type CrossCityRank } from "./fingerprint";
import type { BlockArea } from "./location";

/**
 * What one block_dna run writes: a bounded metric set (the top gains, the largest loss and the NEW
 * count per family, the top local brands), the Block DNA Bars and the local-brand Ranked datasets,
 * findings and the digest rows. WHO is always "venue-goer taste tags": these are the taste signals of people who
 * visit the area's venues, never residents or census data.
 */

/** Everything a run accumulates for its ledger output and digest. */
export interface BlockRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  registered: RegisteredEntity[];
  notices: string[];
}

/** One family compared between the area and the city. */
export interface FamilyResult {
  family: BlockFamily;
  /** The family's tags in either list; empty when its area list was not measured. */
  items: Compared[];
  /** Why the family has no comparison (its area or city list is missing); null when compared. */
  gap: NoValueReason | null;
  /** Ranked tags in the area list the family's ranks come from. */
  areaSize: number;
  evidenceIds: EvidenceId[];
}

/** The local-brand comparison, when include_brands asked for it. */
export interface BrandResult {
  /** Brands of either list, compared; null when either list is missing. */
  items: Compared[] | null;
  gap: NoValueReason | null;
  /** The area answer's rows by entity id, for registering the brands the digest names. */
  raw: ReadonlyMap<string, QlooEntity>;
  areaSize: number;
  evidenceIds: EvidenceId[];
}

/** What a fingerprint describes: a neighbourhood, a point, or a whole city. */
export interface BlockSubject {
  /** The series key of the dataset: the neighbourhood id, "point", or the market id. */
  key: string;
  name: string;
  /** Metric subject: the neighbourhood id, the point as "lon,lat", or the market id. */
  subject: string;
}

/**
 * What the fingerprint is compared against: the area's own city (comparator CITY), or for a whole
 * city the other map cities' lists pooled into one panel list (comparator BASELINE). Every label,
 * caption and comparator that names the comparison comes from here.
 */
export interface BlockBase {
  /** "Nashville", or "the other 12 map cities": reader-facing titles, column heads and captions. */
  label: string;
  /**
   * The same comparison without a count ("Nashville", "the other map cities"), for metric labels,
   * finding texts and notices the model reads: a panel size typed from a label is a number outside
   * the {{M#}} tokens (Q6 of the Part 9 close-out), so the count lives in its own metric.
   */
  short: string;
  comparator: "CITY" | "BASELINE";
  /** Subject refs every metric carries after the subject's own: the area's metro, or none for a city. */
  refs: readonly string[];
  /** Column head for a rank in the base list: "Nashville rank", "Panel rank". */
  rankLabel: string;
  /** The place the subject's ranks come from, in a column head: "here", or "in Austin". */
  here: string;
  /** NEW in words, for a list ("" or "music "): "absent from the Nashville top 50". */
  absentFrom(list: string): string;
  /** The caption sentence that defines the Bars values and NEW. */
  barsCaption: string;
  /** The caption of the brand table. */
  brandsCaption: string;
}

/** The base of a neighbourhood or point: its own map city. */
export function cityBase(metro: MetroId): BlockBase {
  const city = METRO_LABEL[metro];
  return {
    label: city,
    short: city,
    comparator: "CITY",
    refs: [metro],
    rankLabel: `${city} rank`,
    here: "here",
    absentFrom: (list) => `absent from the ${city} ${list}top ${TAG_TAKE}`,
    barsCaption:
      `Rank gain is the ${city} rank minus the area rank in Qloo's top-${TAG_TAKE} tag lists; a tag missing from a list counts as ${TAG_TAKE + 1}. ` +
      "New: absent city-wide, in the area's top 20. Venue-goer taste signals, not residents or census.",
    brandsCaption:
      `Brands with popularity up to ${BRAND_POPULARITY_MAX}, top ${BRAND_TAKE} for the area and for ${city}; a brand missing from a list counts as ${BRAND_TAKE + 1}. ` +
      "Venue-goer taste signals, not sales or residents.",
  };
}

/**
 * The base of a whole city: the other map cities' lists pooled by average rank (FORMULAS
 * block.panel_rank). `cities` is how many lists the panel holds.
 */
export function panelBase(cityName: string, cities: number): BlockBase {
  const panel = `the other ${cities} map cities`;
  return {
    label: panel,
    short: "the other map cities",
    comparator: "BASELINE",
    refs: [],
    rankLabel: "Rank across the other map cities",
    here: `in ${cityName}`,
    absentFrom: (list) => `absent from every ${list}top-${TAG_TAKE} list of the other map cities`,
    barsCaption:
      `Rank gain is the panel rank minus the ${cityName} rank. The panel ranks each tag by its average rank in the top-${TAG_TAKE} lists of ${panel} ` +
      `(a tag missing from a city's list counts as ${TAG_TAKE + 1}), and only its top ${TAG_TAKE} get a rank. ` +
      `New: in the ${cityName} top 20 and in none of the other cities' lists. Venue-goer taste signals, not residents or census.`,
    brandsCaption:
      `Brands with popularity up to ${BRAND_POPULARITY_MAX}: the ${cityName} top ${BRAND_TAKE} against ${panel} pooled the same way; ` +
      `a brand missing from a list counts as ${BRAND_TAKE + 1}. Venue-goer taste signals, not sales or residents.`,
  };
}

export interface BlockFrame {
  area: BlockSubject;
  /** How the area was read; null for a whole city, read from its pinned locality. */
  method: LocationMethod | null;
  base: BlockBase;
}

export const BLOCK_FORMULA_IDS = ["block.rank_delta", "block.new_tag"] as const;

/** Tags per family that get a metric and a digest row (the dataset holds the rest). */
export const DIGEST_TAGS_PER_FAMILY = 2;
/** Local brands that get a metric, a ref and a digest row: tenant-fit candidates for rank_candidates. */
export const DIGEST_BRANDS = 4;
/** Local brands in the Ranked dataset. */
export const DATASET_BRANDS = 10;

/** Group heads in plain words (Q1 of the Part 9 close-out); the family codes stay in `family` for the figure. */
export const FAMILY_GROUP_LABEL: Readonly<Record<BlockFamily, string>> = {
  WHO: "Who the venue-goers are",
  VIBE: "Ambience",
  WHAT: "Venues and dishes",
  SOUND: "Music",
};

/** One tag of a family, in words, for metric labels and finding texts. */
export const TAG_NOUN: Readonly<Record<BlockFamily, string>> = {
  WHO: "venue-goer taste tag",
  VIBE: "ambience tag",
  WHAT: "venue or dish tag",
  SOUND: "music tag",
};

/** The NEW-count label's family words, in the form the brief rewords (see addFamilyMetrics). */
const NEW_COUNT_NOUN: Readonly<Record<BlockFamily, string>> = {
  WHO: "WHO venue-goer taste tag",
  VIBE: "VIBE tag",
  WHAT: "WHAT tag",
  SOUND: "SOUND music tag",
};

/** SOUND compares the two music lists; the other families share the unfiltered lists. */
const listOf = (family: BlockFamily): string => (family === "SOUND" ? "music " : "");

const METHOD_LABEL: Readonly<Record<LocationMethod, string>> = {
  POLYGON: "its gazetteer boundary",
  POINT: "a centre point",
  QUERY: "a place-name search",
};

export function addFindingDraft(run: BlockRun, draft: FindingDraft, metricIds: readonly MetricId[]): Finding {
  const finding = run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] });
  run.findings.push(finding);
  return finding;
}

/** The comparison as the model reads it, with no count (BlockBase.short). */
const cityOf = (frame: BlockFrame): string => frame.base.short;
const areaName = (frame: BlockFrame): string => safeName(frame.area.name);

// Location ladder ----------------------------------------------------------------------------------------

export interface LadderStep {
  from: LocationMethod;
  to: LocationMethod;
  reason: string;
}

/**
 * Each step down the ladder is a CODE FALLBACK: a LOCATION_FALLBACK finding and a `fallback` event
 * carrying its id (SPEC §5.3 S7). No follow-up is suggested; the step costs confidence (§6.4).
 */
export function recordFallbacks(run: BlockRun, area: Pick<BlockArea, "name">, steps: readonly LadderStep[]): void {
  for (const step of steps) {
    const finding = addFindingDraft(run, locationFallbackFinding({ areaName: safeName(area.name), from: step.from, to: step.to }), []);
    run.ctx.emit({
      type: "fallback",
      from: step.from,
      to: step.to,
      reason: step.reason,
      toolCallId: run.ctx.toolCallId,
      findingId: finding.id,
    });
  }
}

export function methodNotice(area: BlockArea, method: LocationMethod, cityPinned: boolean): string {
  const city = cityPinned ? `; city side: Qloo's ${METRO_LABEL[area.metro]} locality` : "";
  return `Area read by ${method} (${METHOD_LABEL[method]})${city}.`;
}

// Metrics ------------------------------------------------------------------------------------------------

/** A tag that holds a metric: the registry ref the model can pass on, and the metric that holds its gain or loss. */
export interface TagMetric {
  compared: Compared;
  family: BlockFamily;
  ref: TagRef;
  metric: Metric;
}

export interface FamilyMetrics {
  family: BlockFamily;
  /** The top gains, most distinctive first. */
  tags: TagMetric[];
  /** The largest loss, so the model can name and cite what under-indexes; null without one. */
  loss: TagMetric | null;
  /** The NEW count; null for a compared family with no tags in the area list. */
  newCount: Metric | null;
  /** NEW tags of the family, most distinctive first. */
  newTags: Compared[];
}

const plus = (n: number): string => `+${n}`;
const minus = (n: number): string => `−${Math.abs(n)}`;

function registerTag(run: BlockRun, c: Compared): TagRef {
  return run.ctx.registry.registerTag({
    tagId: c.item.id,
    name: c.item.name,
    type: c.item.type,
    signalCapable: isTaxonomyTag(c.item.id),
  }).ref;
}

/** One tag's rank gain (positive) or loss (negative) against the city, with its T# ref. */
function addTagMetric(run: BlockRun, frame: BlockFrame, fam: FamilyResult, c: Compared): TagMetric {
  const ref = registerTag(run, c);
  const delta = c.delta as number;
  const gain = delta > 0;
  // V13: a move of a place or two in a top-50 list is about level, never a gain ("+1 of 50").
  const level = !c.isNew && isAboutLevelRankGain(delta, TAG_TAKE);
  const metric = addSkillMetric(run.ctx.ledger, {
    key: "block.rank_delta",
    label: `rank ${level ? "about level" : gain ? "gain" : "loss"} vs ${cityOf(frame)}: ${safeName(c.item.name)} (${TAG_NOUN[fam.family]}, ${areaName(frame)})`,
    subjectRefs: [ref, frame.area.subject, ...frame.base.refs],
    value: delta,
    reason: "not_scored",
    // " · " pieces, as the brief splits a display (apps/web key figures).
    display: level
      ? `${gain ? plus(delta) : minus(delta)} · about level`
      : gain
        ? c.isNew
          ? `${plus(delta)} · new ${frame.base.here}`
          : plus(delta)
        : c.areaRank === null
          ? `${minus(delta)} · outside the top ${TAG_TAKE} ${frame.base.here}`
          : minus(delta),
    unit: "delta",
    badge: "DERIVED",
    formulaId: "block.rank_delta",
    evidenceIds: fam.evidenceIds,
    n: fam.areaSize,
    comparator: frame.base.comparator,
    aboutLevel: level,
    // R1: an area list of fewer than 20 tags is a thin sample.
    thin: fam.areaSize < THIN_SAMPLE.blockTags,
  });
  run.metrics.push(metric);
  return { compared: c, family: fam.family, ref, metric };
}

/**
 * Per family: the gain of its top DIGEST_TAGS_PER_FAMILY over-indexed tags and its largest loss (each
 * registered, so the model holds a T# ref and can cite what rises and what falls), then its NEW count.
 * A family without a comparison gets its NEW count recorded as not measured with the reason, never 0.
 */
export function addFamilyMetrics(run: BlockRun, frame: BlockFrame, fam: FamilyResult): FamilyMetrics {
  const area = areaName(frame);
  const out: FamilyMetrics = { family: fam.family, tags: [], loss: null, newCount: null, newTags: [] };
  const hasAreaTags = fam.items.some((c) => c.areaRank !== null);
  if (fam.gap === null && !hasAreaTags) return out;

  const compared = fam.gap === null;
  const bars = compared ? familyBars(fam.items, true) : { top: [], bottom: [] };
  out.tags = bars.top.slice(0, DIGEST_TAGS_PER_FAMILY).map((c) => addTagMetric(run, frame, fam, c));
  const loss = bars.bottom[0];
  if (loss !== undefined) out.loss = addTagMetric(run, frame, fam, loss);

  const { count, inTop } = newTagCount(fam.items);
  out.newTags = compared ? fam.items.filter((c) => c.isNew).sort(byGain) : [];
  out.newCount = addSkillMetric(run.ctx.ledger, {
    key: "block.new_tag",
    // Kept in the form the brief parses and words for the reader at display time (apps/web plain.ts and
    // key figures read "NEW <family> … tags" and "<n> of <m> in the area top 20"), so stored and new runs read alike.
    label: `NEW ${NEW_COUNT_NOUN[fam.family]}s in ${area} (${area} ${listOf(fam.family)}top ${NEW_AREA_TOP}, ${frame.base.absentFrom(listOf(fam.family))})`,
    subjectRefs: [frame.area.subject, ...frame.base.refs],
    value: compared ? count : null,
    reason: fam.gap ?? "not_measured",
    display: `${count} of ${inTop} in the area top ${NEW_AREA_TOP}`,
    unit: "count",
    badge: "DERIVED",
    formulaId: "block.new_tag",
    evidenceIds: fam.evidenceIds,
    n: inTop,
    comparator: frame.base.comparator,
  });
  run.metrics.push(out.newCount);
  return out;
}

// Concept tags (CR 5 of Part 9) ----------------------------------------------------------------------------

/** A concept tag the caller passed, as the registry holds it, with the family whose list can rank it. */
export interface ConceptTag {
  ref: TagRef;
  tag: RegisteredTag;
  /** Null for a tag type outside the four families block_dna reads: no list here can rank it. */
  family: BlockFamily | null;
}

/** The registered concept tags; a ref the registry does not hold gets a notice instead of a metric. */
export function conceptTagsOf(run: BlockRun, refs: readonly TagRef[] | undefined): ConceptTag[] {
  return [...new Set(refs ?? [])].flatMap((ref) => {
    const tag = run.ctx.registry.tag(ref);
    if (tag === null) {
      run.notices.push(`Concept tag ${ref} is not in this run's registry, so it has no rank here.`);
      return [];
    }
    return [{ ref, tag, family: familyOf({ tag_id: tag.tagId, subtype: tag.type }) }];
  });
}

const rankWords = (rank: number | null): string => (rank === null ? `outside the top ${TAG_TAKE}` : `rank ${rank}`);

/** The families block_dna reads, in words, for a concept tag none of them holds. */
const READ_FAMILIES = "venue-goer, ambience, venue-and-dish and music tags";

type ConceptSpec = Pick<MetricSpec, "label" | "value" | "reason" | "display" | "unit" | "n" | "comparator" | "evidenceIds">;

function addConceptMetric(run: BlockRun, frame: BlockFrame, c: ConceptTag, spec: ConceptSpec): Metric {
  const metric = addSkillMetric(run.ctx.ledger, {
    key: "block.concept_rank",
    subjectRefs: [c.ref, frame.area.subject, ...frame.base.refs],
    badge: "DERIVED",
    formulaId: "block.concept_rank",
    ...spec,
  });
  run.metrics.push(metric);
  return metric;
}

/**
 * A neighbourhood's or point's concept tags: each tag's rank gain against the city (FORMULAS
 * block.concept_rank), its area rank alone when the city side is missing, or an UNAVAILABLE metric
 * that says why (a tag type no list here reads, or a tag in neither top-50 list). No extra call.
 */
export function addAreaConceptMetrics(run: BlockRun, frame: BlockFrame, concepts: readonly ConceptTag[], families: readonly FamilyResult[]): Metric[] {
  const area = areaName(frame);
  const city = cityOf(frame);
  const allEvidence = [...new Set(families.flatMap((f) => f.evidenceIds))];
  return concepts.map((c) => {
    const name = safeName(c.tag.name);
    const fam = c.family === null ? undefined : families.find((f) => f.family === c.family);
    if (fam === undefined) {
      return addConceptMetric(run, frame, c, {
        label: `concept tag ${name} in ${area}: no rank (block_dna reads only ${READ_FAMILIES})`,
        value: null,
        reason: "unavailable",
        display: "",
        unit: "delta",
        n: null,
        comparator: frame.base.comparator,
        evidenceIds: allEvidence,
      });
    }
    const list = listOf(fam.family);
    const item = fam.items.find((i) => i.item.id === c.tag.tagId);
    if (fam.gap !== null) {
      const rank = item?.areaRank ?? null;
      return addConceptMetric(run, frame, c, {
        label: `rank of concept tag ${name} among the ${area} ${list}tags (${city} side not measured)`,
        value: rank,
        reason: rank === null ? fam.gap : "not_measured",
        display: rank === null ? "" : `rank ${rank} of ${fam.areaSize} here`,
        unit: "rank",
        n: fam.areaSize,
        comparator: null,
        evidenceIds: fam.evidenceIds,
      });
    }
    if (item === undefined || item.delta === null || (item.areaRank === null && item.cityRank === null)) {
      return addConceptMetric(run, frame, c, {
        label: `concept tag ${name}: rank gain vs ${city} in ${area} (not among the top-${TAG_TAKE} ${list}tags of either)`,
        value: null,
        reason: "not_measured",
        display: "",
        unit: "delta",
        n: fam.areaSize,
        comparator: frame.base.comparator,
        evidenceIds: fam.evidenceIds,
      });
    }
    const delta = item.delta;
    return addConceptMetric(run, frame, c, {
      label: `concept tag ${name}: rank gain vs ${city} in ${area}`,
      value: delta,
      reason: "not_scored",
      display: `${delta > 0 ? plus(delta) : delta < 0 ? minus(delta) : "0"} (${rankWords(item.areaRank)} here, ${rankWords(item.cityRank)} in ${city})`,
      unit: "delta",
      n: fam.areaSize,
      comparator: frame.base.comparator,
      evidenceIds: fam.evidenceIds,
    });
  });
}

/** One concept tag's reading for a whole city: its place among the cities, or why it has none. */
export type CityConceptReading = { kind: "ranked"; rank: CrossCityRank } | { kind: "absent" } | { kind: "gap"; reason: NoValueReason };

/**
 * A whole city's concept tags: the city's place among itself and the panel cities by each city's own
 * rank of the tag (FORMULAS block.concept_rank, comparator BASELINE), or an UNAVAILABLE metric with
 * the reason. `read` gives the reading for a tag of a family the city lists hold.
 */
export function addCityConceptMetrics(
  run: BlockRun,
  frame: BlockFrame,
  concepts: readonly ConceptTag[],
  read: (family: BlockFamily, tagId: string) => CityConceptReading,
  evidenceIds: readonly EvidenceId[],
): Metric[] {
  const city = areaName(frame);
  return concepts.map((c) => {
    const name = safeName(c.tag.name);
    if (c.family === null) {
      return addConceptMetric(run, frame, c, {
        label: `${city}'s place among the map cities for concept tag ${name}: none (block_dna reads only ${READ_FAMILIES})`,
        value: null,
        reason: "unavailable",
        display: "",
        unit: "rank",
        n: null,
        comparator: frame.base.comparator,
        evidenceIds,
      });
    }
    const list = listOf(c.family);
    const reading = read(c.family, c.tag.tagId);
    if (reading.kind !== "ranked") {
      return addConceptMetric(run, frame, c, {
        label:
          reading.kind === "absent"
            ? `${city}'s place among the map cities for concept tag ${name} (in no city's top-${TAG_TAKE} ${list}tags)`
            : `${city}'s place among the map cities for concept tag ${name}`,
        value: null,
        reason: reading.kind === "absent" ? "not_measured" : reading.reason,
        display: "",
        unit: "rank",
        n: null,
        comparator: frame.base.comparator,
        evidenceIds,
      });
    }
    const { position, cities, ownRank, tied } = reading.rank;
    return addConceptMetric(run, frame, c, {
      label: `${city}'s place among ${cities} cities for concept tag ${name} (by its rank in each city's top-${TAG_TAKE} ${list}tags)`,
      value: position,
      reason: "not_measured",
      display: `${tied ? "tied " : ""}${position} of ${cities} cities${ownRank === null ? ` (not in the ${city} top ${TAG_TAKE})` : ""}`,
      unit: "rank",
      n: cities,
      comparator: frame.base.comparator,
      evidenceIds,
    });
  });
}

/** A local brand with its ref and the metric that holds its gain. */
export interface BrandMetric {
  compared: Compared;
  entity: RegisteredEntity;
  metric: Metric;
}

/** Brands that rank higher here than city-wide, largest gain first. */
export function localBrands(brands: BrandResult): Compared[] {
  return (brands.items ?? []).filter((c) => c.areaRank !== null && (c.delta ?? 0) > 0).sort(byGain);
}

/**
 * The top DIGEST_BRANDS local brands, registered (refs for rank_candidates) with their gain. Without
 * a comparison one metric records the local brands as not measured, with the reason.
 */
export function addBrandMetrics(run: BlockRun, frame: BlockFrame, brands: BrandResult): BrandMetric[] {
  const ledger = run.ctx.ledger;
  const city = cityOf(frame);
  const area = areaName(frame);
  if (brands.items === null) {
    run.metrics.push(
      addSkillMetric(ledger, {
        key: "block.rank_delta",
        label: `brands favoured in ${area} (rank gain vs ${city})`,
        subjectRefs: [frame.area.subject, ...frame.base.refs],
        value: null,
        reason: brands.gap ?? "not_measured",
        display: "",
        unit: "delta",
        badge: "DERIVED",
        formulaId: "block.rank_delta",
        evidenceIds: brands.evidenceIds,
        n: null,
        comparator: frame.base.comparator,
      }),
    );
    return [];
  }
  return localBrands(brands)
    .slice(0, DIGEST_BRANDS)
    .flatMap((c) => {
      const raw = brands.raw.get(c.item.id);
      if (raw === undefined) return [];
      const reg = registerEntity(run.ctx.registry, draftFromInsight(raw));
      if (reg.isNew) run.registered.push(reg.entity);
      const delta = c.delta as number;
      const level = isAboutLevelRankGain(delta, BRAND_TAKE);
      const metric = addSkillMetric(ledger, {
        key: "block.rank_delta",
        label: `rank ${level ? "about level" : "gain"} vs ${city}: ${safeName(c.item.name)} (brand favoured in ${area})`,
        subjectRefs: [reg.entity.ref, frame.area.subject, ...frame.base.refs],
        value: delta,
        reason: "not_scored",
        display:
          c.cityRank === null
            ? `${plus(delta)} · ${frame.base.comparator === "CITY" ? `not in the ${city} top ${BRAND_TAKE}` : `outside the top ${BRAND_TAKE} of ${city}`}`
            : level
              ? `${plus(delta)} · about level`
              : plus(delta),
        unit: "delta",
        badge: "DERIVED",
        formulaId: "block.rank_delta",
        evidenceIds: brands.evidenceIds,
        n: brands.areaSize,
        comparator: frame.base.comparator,
        aboutLevel: c.cityRank !== null && level,
      });
      run.metrics.push(metric);
      return [{ compared: c, entity: reg.entity, metric }];
    });
}

// Findings -----------------------------------------------------------------------------------------------

/** The families BLOCK_NEW_TAGS reads, in the order it tries them. */
const NEW_TAG_FAMILIES: readonly BlockNewTagsFamily[] = ["WHAT", "SOUND"];

/**
 * BLOCK_NEW_TAGS for WHAT when its rule fires (SPEC §4.4), else for SOUND: both lead to the same
 * ranking, so a second finding would only repeat the lead and take digest room from the tag rows. The
 * suggestion names the family's first NEW taxonomy tags, as many as rank_candidates takes, with their
 * T# refs (registering them), since a NEW tag outside the top gains holds no metric or digest row. The finding cites the NEW count, then
 * the gains of the NEW tags, taxonomy tags first, so a follow-up lead reads the area, the city and a
 * signal tag.
 */
/** BLOCK_NEW_TAGS for the first family that meets its rule; `panel` names a city fingerprint's panel (blockNewTagsFinding). */
export function addNewTagsFinding(run: BlockRun, frame: BlockFrame, families: readonly FamilyResult[], metrics: readonly FamilyMetrics[], panel: string | null = null): void {
  for (const family of NEW_TAG_FAMILIES) {
    const fam = metrics.find((m) => m.family === family);
    const result = families.find((f) => f.family === family);
    const newCount = fam?.newCount ?? null;
    if (fam === undefined || result === undefined || newCount === null) continue;
    const familyTags = newTagCount(result.items).inTop;
    if (!isBlockNewTags(family, fam.newTags.length, familyTags)) continue;
    const signal = fam.newTags.filter((c) => isTaxonomyTag(c.item.id)).slice(0, BLOCK_SIGNAL_TAGS_MAX);
    const draft = blockNewTagsFinding({
      areaName: areaName(frame),
      family,
      newTags: fam.newTags.map((c) => safeName(c.item.name)),
      familyTags,
      signalTags: signal.map((c) => ({ name: safeName(c.item.name), ref: registerTag(run, c) })),
      panel,
    });
    if (draft === null) continue;
    const isSignal = (t: TagMetric) => isTaxonomyTag(t.compared.item.id);
    const gains = fam.tags.filter((t) => t.compared.isNew);
    addFindingDraft(run, draft, [newCount.id, ...[...gains.filter(isSignal), ...gains.filter((t) => !isSignal(t))].map((t) => t.metric.id)]);
    return;
  }
}

export function addEmptyAreaFinding(run: BlockRun, frame: BlockFrame): void {
  addFindingDraft(
    run,
    emptyResultFinding({
      what: `the tag fingerprint of ${areaName(frame)}`,
      suggestion: {
        tool: "block_dna",
        reason: `Profile a neighbouring area or a point on a busier street of ${cityOf(frame)}; Qloo has no ranked taste tags for this one.`,
      },
    }),
    [],
  );
}

export function addEmptyBrandsFinding(run: BlockRun, frame: BlockFrame): void {
  addFindingDraft(
    run,
    emptyResultFinding({
      what: `the search for brands favoured in ${areaName(frame)}`,
      suggestion: { tool: "rank_candidates", reason: "Name tenant brands yourself and rank them with the site and city contexts." },
    }),
    [],
  );
}

// Datasets -----------------------------------------------------------------------------------------------

function deltaCell(c: Compared, gap: NoValueReason | null): ValueCell {
  return c.delta === null ? { value: null, reason: gap ?? "not_measured" } : { value: c.delta, reason: null };
}

function bar(c: Compared, gap: NoValueReason | null, refs: ReadonlyMap<string, TagRef>): Bar {
  return {
    key: c.item.id,
    label: safeFullName(c.item.name),
    tagRef: refs.get(c.item.id) ?? null,
    values: [deltaCell(c, gap)],
    isNew: c.isNew,
    ranks: { subject: c.areaRank, comparator: c.cityRank },
  };
}

/**
 * The Block DNA Bars dataset (DivergingBars, diverging mode): per family the top gains then the
 * largest losses, NEW notches, and the location method chip. A family the city side does not
 * measure shows the area's top tags with values recorded as not measured, never as 0.
 */
export function addBlockDnaBars(
  run: BlockRun,
  frame: BlockFrame,
  families: readonly FamilyResult[],
  metrics: readonly FamilyMetrics[],
  evidenceIds: readonly EvidenceId[],
): void {
  const refs = new Map(metrics.flatMap((m) => [...m.tags, ...(m.loss === null ? [] : [m.loss])].map((t) => [t.compared.item.id, t.ref] as const)));
  const groups: BarGroup[] = BlockFamily.options.flatMap((family) => {
    const fam = families.find((f) => f.family === family);
    if (fam === undefined) return [];
    const { top, bottom } = familyBars(fam.items, fam.gap === null);
    const bars = [...top, ...bottom].map((c) => bar(c, fam.gap, refs));
    return bars.length === 0 ? [] : [{ key: family, label: FAMILY_GROUP_LABEL[family], family, bars }];
  });
  if (groups.length === 0) return;
  // Reader-facing: the title and value label keep the panel's size.
  const city = frame.base.label;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Bars",
    title: `Block DNA · ${safeFullName(frame.area.name)} vs ${city}`,
    evidenceIds: [...evidenceIds],
    formulaIds: frame.base.comparator === "BASELINE" ? [...BLOCK_FORMULA_IDS, "block.panel_rank"] : [...BLOCK_FORMULA_IDS],
    payload: {
      mode: "diverging",
      comparator: frame.base.comparator,
      valueLabel: `Tag rank gain vs ${city}`,
      unit: "delta",
      series: [{ key: frame.area.key, label: safeFullName(frame.area.name), ref: null, group: null }],
      groups,
      method: frame.method,
      domain: null,
      caption: frame.base.barsCaption,
    },
  });
  run.datasetIds.push(dataset.id);
}

function rankCell(rank: number | null): ValueCell {
  return rank === null ? { value: null, reason: "not_measured" } : { value: rank, reason: null };
}

/** The local brands Ranked dataset (RankedTable): brands ranked higher here than city-wide. */
export function addLocalBrandsTable(run: BlockRun, frame: BlockFrame, brands: BrandResult, named: readonly BrandMetric[]): void {
  const local = localBrands(brands).slice(0, DATASET_BRANDS);
  if (local.length === 0) return;
  const refs = new Map(named.map((b) => [b.compared.item.id, b.entity.ref] as const));
  const city = frame.base.label;
  const rows: RankedRow[] = local.map((c, i) => ({
    key: `local-${i + 1}`,
    rank: i + 1,
    label: safeFullName(c.item.name),
    sublabel: null,
    ref: refs.get(c.item.id) ?? null,
    tagRef: null,
    type: "brand",
    cells: [
      { value: c.delta, reason: null },
      rankCell(c.areaRank),
      rankCell(c.cityRank),
      c.item.popularity === null ? { value: null, reason: "not_measured" } : { value: c.item.popularity, reason: null },
    ],
    flags: ["LOCAL"],
    explain: [],
  }));
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Brands favoured in ${safeFullName(frame.area.name)} · vs ${city}`,
    evidenceIds: [...brands.evidenceIds],
    formulaIds: frame.base.comparator === "BASELINE" ? ["block.rank_delta", "block.panel_rank", "popularity"] : ["block.rank_delta", "popularity"],
    payload: {
      columns: [
        { key: "delta", label: `Rank gain vs ${city}`, unit: "delta", comparator: frame.base.comparator },
        { key: "area_rank", label: `Rank ${frame.base.here}`, unit: "rank", comparator: null },
        { key: "city_rank", label: frame.base.rankLabel, unit: "rank", comparator: null },
        { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
      ],
      groups: [{ key: "local", label: `Brands that rank higher ${frame.base.here} than across ${city}`, rows }],
      caption: frame.base.brandsCaption,
    },
  });
  run.datasetIds.push(dataset.id);
}

// Digest -------------------------------------------------------------------------------------------------

export function finishBlockRun(run: BlockRun, out: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: run.registered,
      notices: run.notices,
    },
    out,
  );
}

/**
 * Digest rows go family by family, WHAT first: its tags are the ones tenant fit picks (SPEC S8), so
 * a digest trimmed from the end keeps their refs. Local brands come last; their refs are also in
 * `registered`.
 */
const ROW_FAMILIES: readonly BlockFamily[] = ["WHAT", "WHO", "VIBE", "SOUND"];

/**
 * The tags whose gains hold metrics, then the local brands. A row names the metric that holds its
 * gain instead of repeating the value, so the model cites the token.
 */
export function blockDigestRows(metrics: readonly FamilyMetrics[], brands: readonly BrandMetric[]): DigestRow[] {
  const ordered = ROW_FAMILIES.flatMap((family) => metrics.filter((m) => m.family === family));
  const tagRows: DigestRow[] = ordered.flatMap((m) =>
    m.tags.map((t) => ({
      ref: t.ref,
      name: safeName(t.compared.item.name),
      values: { family: t.family, gain_metric: t.metric.id },
    })),
  );
  const brandRows: DigestRow[] = brands.map((b) => ({
    ref: b.entity.ref,
    name: safeName(b.entity.name),
    values: { role: "local_brand", gain_metric: b.metric.id },
  }));
  return [...tagRows, ...brandRows];
}

/** The tenant-fit hand-off (S8): local brand refs as rank_candidates candidates with [site, city]. */
export function tenantNotice(brands: readonly BrandMetric[]): string | null {
  if (brands.length === 0) return null;
  return `Tenant fit: rank_candidates on this area, contexts [site, city], brands favoured here ${brands.map((b) => b.entity.ref).join(", ")} (they rank higher here, not necessarily based here).`;
}
